import type { AppEnv } from "./env";
import { publicHttpsUrl } from "./seeapi";

export async function storeProviderVideo(env: AppEnv, key: string, url: string) {
  if (await env.MEDIA.head(key)) return;
  const response = await fetch(publicHttpsUrl(url), { redirect: "manual", signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body || Number(response.headers.get("content-length") || 0) > 100 * 1024 * 1024) throw new Error("Video retrieval failed");
  const type = response.headers.get("content-type")?.split(";")[0];
  if (type && !["video/mp4", "application/octet-stream"].includes(type)) throw new Error("Unexpected video type");
  await saveVideo(env, key, response.body);
}

async function saveVideo(env: AppEnv, key: string, stream: ReadableStream<Uint8Array>) {
  // R2 requires known-length parts; keep memory bounded even without Content-Length.
  const upload = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" } });
  const reader = stream.getReader();
  const parts: R2UploadedPart[] = [];
  const buffer = new Uint8Array(5 * 1024 * 1024);
  let used = 0, total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 100 * 1024 * 1024) throw new Error("Video exceeds storage limit");
      let offset = 0;
      while (offset < value.byteLength) {
        const size = Math.min(buffer.length - used, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + size), used);
        used += size;
        offset += size;
        if (used === buffer.length) {
          parts.push(await upload.uploadPart(parts.length + 1, buffer));
          used = 0;
        }
      }
    }
    if (!total) throw new Error("Empty video result");
    if (used) parts.push(await upload.uploadPart(parts.length + 1, buffer.subarray(0, used)));
    await upload.complete(parts);
  } catch (error) {
    await upload.abort();
    throw error;
  } finally {
    await reader.cancel().catch(() => {});
  }
}
