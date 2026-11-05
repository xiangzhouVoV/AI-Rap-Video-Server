import { Hono } from "hono";
import type { AppBindings, AppEnv } from "./env";
import { MediaError, resolveMedia } from "./media";
import { ProviderError, providerRequest, publicHttpsUrl, type ProviderTask } from "./seeapi";
import { cruisePrompt, cruisePromptV1, cruiseTemplateVersion } from "./templates";

type Job = {
  id: string; user_id: string; request_id: string; request_hash: string;
  template_id: string; template_version: number; provider_body: string;
  provider_task_id: string | null; status: string;
  estimated_credits: number | null; consumed_credits: number | null; refunded_credits: number | null;
  result_object_key: string | null; error: string | null; created_at: string; updated_at: string;
  lease_id: string | null; lease_until: string | null;
};
const terminal = new Set(["succeeded", "failed", "canceled", "refunded", "expired"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const generationRoutes = new Hono<AppBindings>();

generationRoutes.post("/", async (c) => {
  if (!c.env.SEEAPI_API_KEY) return c.json({ error: { code: "NOT_CONFIGURED", message: "Video generation is not configured." } }, 503);
  if (Number(c.req.header("Content-Length") || 0) > 32_000) return c.json({ error: { code: "INVALID_INPUT", message: "Request is too large." } }, 413);
  let body: Record<string, unknown>;
  try { body = await c.req.json(); } catch { return c.json({ error: { code: "INVALID_INPUT", message: "Send a JSON request." } }, 400); }
  if (!body || typeof body !== "object" || body.templateId !== "24k-magic" || typeof body.requestId !== "string" || !uuid.test(body.requestId)) {
    return c.json({ error: { code: "INVALID_INPUT", message: "A valid template and request ID are required." } }, 400);
  }
  const duration = body.duration ?? 10;
  const resolution = body.resolution ?? "720p";
  const aspectRatio = body.aspectRatio ?? "9:16";
  const generateAudio = body.generateAudio ?? true;
  const userId = c.get("userId");
  const existing = await findJob(c.env, userId, body.requestId);
  const legacy = existing?.template_version === 1;
  const defaultPrompt = legacy ? cruisePromptV1 : cruisePrompt;
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : defaultPrompt;
  if (![5, 10, 15].includes(duration as number) || !["480p", "720p"].includes(resolution as string)
    || !["9:16", "16:9"].includes(aspectRatio as string) || typeof generateAudio !== "boolean" || !prompt || prompt.length > 6000) {
    return c.json({ error: { code: "INVALID_INPUT", message: "Check duration, resolution, framing and prompt (maximum 6,000 characters)." } }, 400);
  }
  const normalized = {
    templateId: body.templateId, photoId: body.photoId ?? null, photoUrl: body.photoUrl ?? null,
    // Omit absent partner fields from the serialized hash for version 1 retries.
    partnerPhotoId: body.partnerPhotoId ?? undefined, partnerPhotoUrl: body.partnerPhotoUrl ?? undefined,
    referenceVideoId: body.referenceVideoId ?? null, referenceVideoUrl: body.referenceVideoUrl ?? null,
    referenceAudioId: body.referenceAudioId ?? null, referenceAudioUrl: body.referenceAudioUrl ?? null,
    prompt, duration, resolution, aspectRatio, generateAudio,
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(normalized)));
  const hash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  if (existing) {
    if (existing.request_hash !== hash) return c.json({ error: { code: "REQUEST_CONFLICT", message: "This request ID belongs to different inputs. Keep the original inputs when resuming." } }, 409);
    return c.json({ job: publicJob(await refreshJob(c.env, existing)) });
  }
  let dancerPhoto: string, partnerPhoto: string, video: string, audio: string | undefined;
  try {
    dancerPhoto = await resolveInput(c.env, userId, "photo", body.photoId, body.photoUrl, "dancer portrait");
    partnerPhoto = await resolveInput(c.env, userId, "photo", body.partnerPhotoId, body.partnerPhotoUrl, "partner portrait");
    video = await resolveInput(c.env, userId, "video", body.referenceVideoId,
      body.referenceVideoUrl || (!body.referenceVideoId ? c.env.TEMPLATE_REFERENCE_VIDEO_URL : undefined));
    if (body.referenceAudioId || body.referenceAudioUrl) audio = await resolveInput(c.env, userId, "audio", body.referenceAudioId, body.referenceAudioUrl);
  } catch (error) {
    if (error instanceof MediaError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    return c.json({ error: { code: "INVALID_MEDIA", message: error instanceof Error ? error.message : "Check the media inputs." } }, 400);
  }
  const providerBody = JSON.stringify({
    model: "seedance-2", endpoint: "reference-to-video", provider: "seeapi",
    input: {
      prompt, reference_images: [dancerPhoto, partnerPhoto], reference_video: [video],
      ...(audio ? { reference_audio: [audio] } : {}),
      duration_seconds: duration, resolution, aspect_ratio: aspectRatio, generate_audio: generateAudio, nsfw_checker: true,
    },
  });
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const inserted = await c.env.DB.prepare(`INSERT INTO template_generation
    (id,user_id,request_id,request_hash,template_id,template_version,provider_body,status,created_at,updated_at,lease_id,lease_until)
    SELECT ?,?,?,?,?,?,?,'submitting',?,?,?,?
    WHERE (SELECT COUNT(*) FROM template_generation WHERE user_id=? AND status IN ('submitting','submission_unknown','processing')) < 2
    ON CONFLICT(user_id,request_id) DO NOTHING`)
    .bind(id, userId, body.requestId, hash, "24k-magic", cruiseTemplateVersion, providerBody, now, now, id, new Date(Date.now() + 120_000).toISOString(), userId).run();
  if (!inserted.meta.changes) {
    const raced = await findJob(c.env, userId, body.requestId);
    if (raced && raced.request_hash === hash) return c.json({ job: publicJob(raced) });
    if (raced) return c.json({ error: { code: "REQUEST_CONFLICT", message: "This request ID belongs to different inputs." } }, 409);
    return c.json({ error: { code: "TASK_LIMIT", message: "Resume your existing tasks before starting another. Two active tasks are allowed during debugging." } }, 429);
  }
  const job = await findJob(c.env, userId, id);
  return c.json({ job: publicJob(await submitJob(c.env, job!)) }, 202);
});

generationRoutes.get("/:id", async (c) => {
  const job = await findJob(c.env, c.get("userId"), c.req.param("id"));
  if (!job) return c.json({ error: { code: "NOT_FOUND", message: "This task was not found in your account." } }, 404);
  return c.json({ job: publicJob(await refreshJob(c.env, job)) });
});

generationRoutes.on(["GET", "HEAD"], "/:id/video", async (c) => {
  const job = await findJob(c.env, c.get("userId"), c.req.param("id"));
  if (!job || !job.result_object_key) return c.json({ error: { code: "NOT_FOUND", message: "The video is not available yet." } }, 404);
  const headers = new Headers({ "Cache-Control": "private, no-store", "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff" });
  let range: { offset: number; length: number } | undefined;
  const rangeHeader = c.req.header("Range");
  if (rangeHeader) {
    const metadata = await c.env.MEDIA.head(job.result_object_key);
    if (!metadata) return c.json({ error: { code: "NOT_FOUND", message: "The saved video is not available." } }, 404);
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    const start = match?.[1] ? Number(match[1]) : Math.max(0, metadata.size - Number(match?.[2]));
    const end = match?.[1] && match[2] ? Math.min(Number(match[2]), metadata.size - 1) : metadata.size - 1;
    if (!match || (!match[1] && !match[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
      || start < 0 || end < start || start >= metadata.size) {
      headers.set("Content-Range", `bytes */${metadata.size}`);
      return new Response(null, { status: 416, headers });
    }
    range = { offset: start, length: end - start + 1 };
  }
  const object = await c.env.MEDIA.get(job.result_object_key, range ? { range } : undefined);
  if (!object) return c.json({ error: { code: "NOT_FOUND", message: "The saved video is not available." } }, 404);
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "video/mp4");
  if (c.req.query("download") === "1") headers.set("Content-Disposition", 'attachment; filename="24k-magic-dance.mp4"');
  let status = 200;
  if (range) {
    const { offset, length } = range;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length)); status = 206;
  } else headers.set("Content-Length", String(object.size));
  return new Response(c.req.method === "HEAD" ? null : object.body, { status, headers });
});

async function resolveInput(env: AppEnv, userId: string, kind: "photo" | "video" | "audio", id: unknown, url: unknown, label = "reference " + kind) {
  if (id && url) throw new Error(`Choose an uploaded ${kind} or a URL, not both.`);
  if (typeof id === "string") {
    const asset = await resolveMedia(env, userId, id);
    if (asset.kind !== kind) throw new Error(`The selected asset is not a ${kind}.`);
    return asset.url;
  }
  if (!url) throw new Error(`A ${label} is required.`);
  return publicHttpsUrl(url);
}

async function findJob(env: AppEnv, userId: string, id: string) {
  return env.DB.prepare("SELECT * FROM template_generation WHERE user_id=? AND (id=? OR request_id=?)").bind(userId, id, id).first<Job>();
}

function publicJob(job: Job) {
  return {
    id: job.id, requestId: job.request_id, status: job.status, providerTaskId: job.provider_task_id,
    estimatedCredits: job.estimated_credits, consumedCredits: job.consumed_credits, refundedCredits: job.refunded_credits,
    videoUrl: job.result_object_key ? `/api/template-generations/${job.id}/video` : null,
    error: job.error, createdAt: job.created_at, updatedAt: job.updated_at,
  };
}

async function submitJob(env: AppEnv, job: Job): Promise<Job> {
  try {
    const task = await providerRequest(env, "/v1/generations", { body: job.provider_body, key: `template-${job.id}` });
    return await applyProviderTask(env, job, task);
  } catch (error) {
    const uncertain = !(error instanceof ProviderError) || error.uncertain;
    const message = error instanceof ProviderError ? error.message : "Submission was not confirmed. Resume this task to avoid another charge.";
    await env.DB.prepare("UPDATE template_generation SET status=?,error=?,updated_at=? WHERE id=? AND lease_id=?")
      .bind(uncertain ? "submission_unknown" : "failed", message, new Date().toISOString(), job.id, job.lease_id).run();
    return (await findJob(env, job.user_id, job.id))!;
  } finally {
    await releaseLease(env, job);
  }
}

async function refreshJob(env: AppEnv, job: Job): Promise<Job> {
  if (terminal.has(job.status)) return job;
  const elapsed = Date.now() - Date.parse(job.updated_at);
  const minDelay = job.provider_task_id ? 8_000 : 45_000;
  if (elapsed < minDelay) return job;
  const now = new Date().toISOString();
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE template_generation SET updated_at=?,lease_id=?,lease_until=?
    WHERE id=? AND updated_at=? AND (lease_until IS NULL OR lease_until<?)`)
    .bind(now, leaseId, new Date(Date.now() + 120_000).toISOString(), job.id, job.updated_at, now).run();
  if (!claimed.meta.changes) return (await findJob(env, job.user_id, job.id))!;
  job = { ...job, lease_id: leaseId };
  if (!job.provider_task_id) return submitJob(env, job);
  try {
    const task = await providerRequest(env, `/v1/generations/${encodeURIComponent(job.provider_task_id)}`);
    return await applyProviderTask(env, job, task);
  } catch (error) {
    const message = error instanceof ProviderError ? error.message : "Status lookup is temporarily unavailable. The original task is still being tracked.";
    await env.DB.prepare("UPDATE template_generation SET error=? WHERE id=? AND lease_id=?").bind(message, job.id, job.lease_id).run();
    return (await findJob(env, job.user_id, job.id))!;
  } finally {
    await releaseLease(env, job);
  }
}

async function releaseLease(env: AppEnv, job: Job) {
  await env.DB.prepare("UPDATE template_generation SET lease_id=NULL,lease_until=NULL WHERE id=? AND lease_id=?")
    .bind(job.id, job.lease_id).run();
}

async function applyProviderTask(env: AppEnv, job: Job, task: ProviderTask): Promise<Job> {
  // Save the provider ID before downloading a result, so a slow transfer never causes another submission.
  const owned = await env.DB.prepare("UPDATE template_generation SET provider_task_id=? WHERE id=? AND lease_id=?").bind(task.id, job.id, job.lease_id).run();
  if (!owned.meta.changes) return (await findJob(env, job.user_id, job.id))!;
  let status = terminal.has(task.status) ? task.status : "processing";
  let error: string | null = status !== "succeeded" && terminal.has(status) ? "The provider ended this task without a video. Review the reported credit usage before starting another." : null;
  let objectKey = job.result_object_key;
  if (status === "succeeded" && !objectKey) {
    const asset = task.result?.assets?.find((item) => item.url && (item.type === "video" || item.mime_type?.startsWith("video/")));
    try {
      if (!asset?.url) throw new Error("No video asset");
      const key = `results/${job.user_id}/${job.id}/video.mp4`;
      if (!await env.MEDIA.head(key)) {
        const response = await fetch(publicHttpsUrl(asset.url), { redirect: "error", signal: AbortSignal.timeout(60_000) });
        if (!response.ok || !response.body || Number(response.headers.get("content-length") || 0) > 100 * 1024 * 1024) throw new Error("Video retrieval failed");
        const type = response.headers.get("content-type")?.split(";")[0];
        if (type && !["video/mp4", "application/octet-stream"].includes(type)) throw new Error("Unexpected video type");
        await saveVideo(env, key, response.body);
      }
      objectKey = key;
    } catch {
      status = "processing";
      error = "Generation completed. Saving the video is still pending; resume this task instead of generating again.";
    }
  }
  const credit = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  await env.DB.prepare(`UPDATE template_generation SET provider_task_id=?,status=?,
    estimated_credits=COALESCE(?,estimated_credits),consumed_credits=COALESCE(?,consumed_credits),
    refunded_credits=COALESCE(?,refunded_credits),result_object_key=?,error=?,updated_at=? WHERE id=? AND lease_id=?`)
    .bind(task.id, status, credit(task.estimated_credits), credit(task.consumed_credits), credit(task.refunded_credits), objectKey, error, new Date().toISOString(), job.id, job.lease_id).run();
  return (await findJob(env, job.user_id, job.id))!;
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
