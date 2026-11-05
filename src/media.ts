import { Hono, type Context } from "hono";
import type { AuthEnv } from "./auth";

export type MediaEnv = AuthEnv & Pick<Env, "MEDIA" | "IMAGES"> & {
  MEDIA_PUBLIC_BASE_URL?: string;
};

export type MediaKind = "photo" | "video" | "audio";
type MediaContext = { Bindings: MediaEnv; Variables: { userId: string } };
type MediaRow = {
  id: string;
  user_id: string;
  object_key: string;
  kind: MediaKind;
  content_type: string;
  byte_size: number;
  access_token: string;
  created_at: string;
};

const MIB = 1024 * 1024;
const LIMITS = { photo: 10 * MIB, video: 50 * MIB, audio: 15 * MIB };
const MAX_REQUEST_BYTES = LIMITS.video + 64 * 1024;
const ACCESS_LIFETIME_MS = 24 * 60 * 60 * 1000;
const ROUTE = "/api/template-media";
const PUBLIC_URL_MESSAGE = "Files can be uploaded and previewed locally, but external generation needs a public HTTPS URL. Set MEDIA_PUBLIC_BASE_URL to the public origin served by this Worker.";

export class MediaError extends Error {
  constructor(
    public readonly status: 400 | 404 | 410 | 413 | 415 | 416 | 422 | 500 | 503,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

// The parent authenticates uploads and previews, and exempts only GET/HEAD content.
export const mediaRoutes = new Hono<MediaContext>();

mediaRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

mediaRoutes.post("/", async (c) => {
  const form = await uploadForm(c.req.raw);
  const kind = form.get("kind");
  const file = form.get("file");
  if ((kind !== "photo" && kind !== "video" && kind !== "audio") || !(file instanceof File)
    || form.getAll("kind").length !== 1 || form.getAll("file").length !== 1) {
    throw new MediaError(400, "INVALID_UPLOAD", "Upload one file and a kind: photo, video, or audio.");
  }
  if (!file.size || file.size > LIMITS[kind]) {
    throw new MediaError(413, "MEDIA_SIZE_LIMIT", `${kind} must be nonempty and no larger than ${LIMITS[kind] / MIB} MiB.`);
  }
  const contentType = await validateFormat(file, kind);
  const stored = kind === "photo" ? await normalizePhoto(c.env, file) : file;
  const storedType = kind === "photo" ? "image/webp" : contentType;
  const id = crypto.randomUUID();
  const objectKey = `template-media/${id}`;
  const createdAt = new Date().toISOString();
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("");

  await c.env.MEDIA.put(objectKey, stored, { httpMetadata: { contentType: storedType } });
  try {
    await c.env.DB.prepare(
      "INSERT INTO template_media (id, user_id, object_key, kind, content_type, byte_size, access_token, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, c.get("userId"), objectKey, kind, storedType, stored.size, token, createdAt).run();
  } catch (error) {
    // Compensate a failed metadata write without exposing an orphaned object.
    await c.env.MEDIA.delete(objectKey).catch(() => undefined);
    throw error;
  }

  let warning: string | undefined;
  try {
    publicOrigin(c.env);
  } catch (error) {
    if (!(error instanceof MediaError)) throw error;
    warning = error.message;
  }
  return c.json({
    asset: {
      id, kind, contentType: storedType, byteSize: stored.size,
      url: `${ROUTE}/${id}/preview`, createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ACCESS_LIFETIME_MS).toISOString(),
    },
    externalReady: !warning,
    ...(warning ? { warning } : {}),
  }, 201);
});

mediaRoutes.on(["GET", "HEAD"], "/:id/preview", async (c) => {
  const row = await c.env.DB.prepare("SELECT * FROM template_media WHERE id = ? AND user_id = ?")
    .bind(c.req.param("id"), c.get("userId")).first<MediaRow>();
  if (!row) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media was not found.");
  return serveMedia(c, row);
});

mediaRoutes.on(["GET", "HEAD"], "/:id/content", async (c) => {
  const token = c.req.query("token");
  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    throw new MediaError(404, "MEDIA_NOT_FOUND", "Media was not found.");
  }
  const row = await c.env.DB.prepare("SELECT * FROM template_media WHERE id = ? AND access_token = ?")
    .bind(c.req.param("id"), token).first<MediaRow>();
  if (!row) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media was not found.");
  requireUnexpired(row);
  return serveMedia(c, row);
});

mediaRoutes.onError((error, c) => {
  if (error instanceof MediaError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
  return c.json({ error: { code: "MEDIA_ERROR", message: "Unable to process this media file." } }, 500);
});

export async function resolveMedia(env: MediaEnv, userId: string, id: string): Promise<{ id: string; url: string; kind: MediaKind }> {
  const row = await env.DB.prepare("SELECT * FROM template_media WHERE id = ? AND user_id = ?")
    .bind(id, userId).first<MediaRow>();
  if (!row) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media was not found.");
  requireUnexpired(row);
  const url = new URL(`${ROUTE}/${encodeURIComponent(row.id)}/content`, publicOrigin(env));
  url.searchParams.set("token", row.access_token);
  return { id: row.id, url: url.href, kind: row.kind };
}

export function publicOrigin(env: MediaEnv): string {
  let url: URL;
  const configured = env.MEDIA_PUBLIC_BASE_URL || env.BETTER_AUTH_URL;
  try {
    url = new URL(configured);
  } catch {
    throw new MediaError(503, "MEDIA_PUBLIC_URL_REQUIRED", PUBLIC_URL_MESSAGE);
  }
  const host = url.hostname.toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
    || host === "[::1]" || host === "[::]" || /^(?:127|10|0)\./.test(host)
    || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(host);
  if (url.protocol !== "https:" || local || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new MediaError(503, "MEDIA_PUBLIC_URL_REQUIRED", PUBLIC_URL_MESSAGE);
  }
  return url.origin;
}

function requireUnexpired(row: MediaRow) {
  const expiry = Date.parse(row.created_at) + ACCESS_LIFETIME_MS;
  if (!Number.isFinite(expiry) || Date.now() >= expiry) {
    throw new MediaError(410, "MEDIA_EXPIRED", "This media link has expired. Upload the file again before generating.");
  }
}

async function uploadForm(request: Request): Promise<FormData> {
  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data;") || !request.body) {
    throw new MediaError(400, "INVALID_UPLOAD", "Send the file as multipart/form-data.");
  }
  const tooLarge = () => new MediaError(413, "MEDIA_SIZE_LIMIT", "The upload exceeds the 50 MiB file limit.");
  if (Number(request.headers.get("Content-Length")) > MAX_REQUEST_BYTES) throw tooLarge();
  let byteCount = 0;
  let exceeded = false;
  // Count the stream even if Content-Length is absent or inaccurate. Do not buffer a second full copy.
  const limited = request.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      byteCount += chunk.byteLength;
      if (byteCount > MAX_REQUEST_BYTES) {
        exceeded = true;
        throw tooLarge();
      }
      controller.enqueue(chunk);
    },
  }));
  try {
    return await new Response(limited, { headers: { "Content-Type": contentType } }).formData();
  } catch (error) {
    if (exceeded) throw tooLarge();
    if (error instanceof MediaError) throw error;
    throw new MediaError(400, "INVALID_UPLOAD", "The multipart upload is malformed.");
  }
}

async function validateFormat(file: File, kind: MediaKind): Promise<string> {
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const text = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  let detected = "";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) detected = "image/jpeg";
  else if (text(0, 8) === "\x89PNG\r\n\x1a\n") detected = "image/png";
  else if (text(0, 4) === "RIFF" && text(8, 12) === "WEBP") detected = "image/webp";
  else if (text(0, 4) === "RIFF" && text(8, 12) === "WAVE") detected = "audio/wav";
  else if (text(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0
    && (bytes[1] & 0x06) !== 0 && (bytes[1] & 0x18) !== 0x08 && (bytes[2] & 0xf0) !== 0xf0)) detected = "audio/mpeg";
  else if (text(4, 8) === "ftyp") {
    const brand = text(8, 12);
    if (brand === "qt  ") detected = "video/quicktime";
    else if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand)) detected = "video/mp4";
  }
  const declared = file.type.toLowerCase().replace("audio/x-wav", "audio/wav").replace("audio/wave", "audio/wav").replace("audio/mp3", "audio/mpeg");
  const allowed = {
    photo: ["image/jpeg", "image/png", "image/webp"],
    video: ["video/mp4", "video/quicktime"],
    audio: ["audio/mpeg", "audio/wav"],
  };
  if (!allowed[kind].includes(detected) || (declared && declared !== "application/octet-stream" && declared !== detected)) {
    throw new MediaError(415, "UNSUPPORTED_MEDIA", "The file contents must match JPEG, PNG, WebP (photo), MP4, MOV (video), or MP3, WAV (audio).");
  }
  return detected;
}

async function normalizePhoto(env: MediaEnv, file: File): Promise<Blob> {
  if (!env.IMAGES) throw new MediaError(503, "IMAGES_NOT_CONFIGURED", "Photo processing is temporarily unavailable.");
  try {
    // WebP output discards metadata. Only this decoded/re-encoded image enters R2, never the original.
    // https://developers.cloudflare.com/images/optimization/features/#metadata
    const output = await env.IMAGES.input(file.stream())
      .transform({ width: 2048, height: 2048, fit: "scale-down" })
      .output({ format: "image/webp", quality: 90, anim: false });
    const image = await output.response().blob();
    if (!image.size || image.size > LIMITS.photo) {
      throw new MediaError(422, "PHOTO_PROCESSING_FAILED", "The normalized photo is empty or too large. Try another image.");
    }
    const info = await env.IMAGES.info(image.stream());
    if (!("width" in info) || info.width < 301 || info.height < 301 || info.width > 5999 || info.height > 5999
      || info.width / info.height <= 0.4 || info.width / info.height >= 2.5) {
      throw new MediaError(422, "INVALID_PHOTO_DIMENSIONS", "After resizing, photo width and height must each be 301–5999 pixels, and width/height must be greater than 0.4 and less than 2.5.");
    }
    return image;
  } catch (error) {
    if (error instanceof MediaError) throw error;
    const code = error && typeof error === "object" && "code" in error ? Number(error.code) : undefined;
    if (code === 9412 || code === 9403 || code === 9413) {
      throw new MediaError(422, "INVALID_PHOTO", "The photo could not be decoded. Upload a valid JPEG, PNG, or WebP image.");
    }
    throw new MediaError(503, "PHOTO_PROCESSING_FAILED", "Photo processing is unavailable. Check the Images binding and try again.");
  }
}

export async function serveMedia(c: Context<MediaContext>, row: Pick<MediaRow, "object_key" | "content_type" | "byte_size">): Promise<Response> {
  const headers = new Headers({
    "Content-Type": row.content_type,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Disposition": "inline",
    "Accept-Ranges": "bytes",
  });
  const rangeHeader = c.req.header("Range");
  let range: { offset: number; length: number } | undefined;
  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, row.byte_size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), row.byte_size - 1) : row.byte_size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || start >= row.byte_size) {
      headers.set("Content-Range", `bytes */${row.byte_size}`);
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
    headers.set("Content-Range", `bytes ${start}-${end}/${row.byte_size}`);
  }
  headers.set("Content-Length", String(range?.length ?? row.byte_size));
  if (c.req.method === "HEAD") {
    if (!await c.env.MEDIA.head(row.object_key)) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media was not found.");
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const object = await c.env.MEDIA.get(row.object_key, range ? { range } : undefined);
  if (!object) throw new MediaError(404, "MEDIA_NOT_FOUND", "Media was not found.");
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
