import { Hono } from "hono";
import type { AppBindings, AppEnv } from "./env";
import { MediaError } from "./media";
import { ProviderError, providerRequest, type ProviderTask } from "./seeapi";
import { cruisePromptV2, cruisePromptV1, cruiseTemplateVersion } from "./templates";

import { createCruisePlan, advanceCruiseJob, hasRetried, prepareCruiseRetry, retryUsesCredits } from "./cruise-jobs";
import { storeProviderVideo } from "./result-video";

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
  const userId = c.get("userId");
  const existing = await findJob(c.env, userId, body.requestId);
  const resolution = body.resolution ?? "720p";
  const portraits = { photoId: body.photoId ?? null, photoUrl: body.photoUrl ?? null,
    partnerPhotoId: body.partnerPhotoId ?? null, partnerPhotoUrl: body.partnerPhotoUrl ?? null };
  let normalized;
  if (existing && existing.template_version < 3) {
    const prompt = existing.template_version === 1 ? cruisePromptV1 : cruisePromptV2;
    normalized = {
      templateId: body.templateId, photoId: portraits.photoId, photoUrl: portraits.photoUrl,
      partnerPhotoId: body.partnerPhotoId ?? undefined, partnerPhotoUrl: body.partnerPhotoUrl ?? undefined,
      referenceVideoId: body.referenceVideoId ?? null, referenceVideoUrl: body.referenceVideoUrl ?? null,
      referenceAudioId: body.referenceAudioId ?? null, referenceAudioUrl: body.referenceAudioUrl ?? null,
      prompt: typeof body.prompt === "string" ? body.prompt.trim() : prompt, duration: body.duration ?? 10,
      resolution, aspectRatio: body.aspectRatio ?? "9:16", generateAudio: body.generateAudio ?? true,
    };
  } else {
    const allowed = ["templateId", "requestId", "resolution", ...Object.keys(portraits)];
    if (Object.keys(body).some(key => !allowed.includes(key)) || (resolution !== "480p" && resolution !== "720p")) {
      return c.json({ error: { code: "INVALID_INPUT", message: "Use the current template with two portraits and a supported resolution." } }, 400);
    }
    normalized = { templateId: body.templateId, ...portraits, resolution };
  }
  let hash = await requestHash(normalized);
  if (existing?.template_version === 2 && existing.request_hash !== hash) {
    // Both the omitted and explicit-null encodings identify the same unselected portrait source.
    hash = await requestHash({ ...normalized, partnerPhotoId: portraits.partnerPhotoId, partnerPhotoUrl: portraits.partnerPhotoUrl });
  }
  if (existing) {
    if (existing.request_hash !== hash) return c.json({ error: { code: "REQUEST_CONFLICT", message: "This request ID belongs to different inputs. Keep the original inputs when resuming." } }, 409);
    return c.json({ job: publicJob(await refreshJob(c.env, existing)) });
  }
  let providerBody: string;
  try {
    providerBody = await createCruisePlan(c.env, userId, portraits, resolution as string);
  } catch (error) {
    if (error instanceof MediaError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    return c.json({ error: { code: "INVALID_MEDIA", message: error instanceof Error ? error.message : "Check both photos." } }, 400);
  }
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
  return c.json({ job: publicJob(await processClaimedCruiseJob(c.env, job!)) }, 202);
});

generationRoutes.post("/:id/retry", async (c) => {
  if (!c.env.SEEAPI_API_KEY) return c.json({ error: { code: "NOT_CONFIGURED", message: "Video generation is not configured." } }, 503);
  let retryId: unknown;
  try { retryId = (await c.req.json()).retryId; } catch { /* Validated below. */ }
  if (typeof retryId !== "string" || !uuid.test(retryId)) return c.json({ error: { code: "INVALID_INPUT", message: "A valid retry ID is required." } }, 400);
  const job = await findJob(c.env, c.get("userId"), c.req.param("id"));
  if (!job) return c.json({ error: { code: "NOT_FOUND", message: "This task was not found in your account." } }, 404);
  if (job.template_version >= 3 && hasRetried(job.provider_body, retryId)) return c.json({ job: publicJob(job) });
  if (job.template_version !== 3 || job.status !== "failed") {
    return c.json({ error: { code: "CANNOT_RETRY", message: "This generation has no failed part to retry." } }, 409);
  }
  let plan: string;
  try {
    plan = await prepareCruiseRetry(c.env, job.user_id, job.provider_body, retryId);
  } catch (error) {
    if (error instanceof MediaError) return c.json({ error: { code: error.code, message: error.message } }, error.status);
    return c.json({ error: { code: "INVALID_MEDIA", message: "Your photos could not be prepared." } }, 400);
  }
  const lease = crypto.randomUUID();
  const now = new Date().toISOString();
  const changed = await c.env.DB.prepare(`UPDATE template_generation SET status='submitting',provider_body=?,error=NULL,lease_id=?,lease_until=?,updated_at=?
    WHERE id=? AND status='failed' AND provider_body=? AND (lease_until IS NULL OR lease_until<?)
    AND (SELECT COUNT(*) FROM template_generation WHERE user_id=? AND status IN ('submitting','submission_unknown','processing')) < 2`)
    .bind(plan, lease, new Date(Date.now()+120_000).toISOString(), now, job.id, job.provider_body, now, job.user_id).run();
  if (!changed.meta.changes) {
    const current = (await findJob(c.env, job.user_id, job.id))!;
    if (hasRetried(current.provider_body, retryId)) return c.json({ job: publicJob(current) });
    return c.json({ error: { code: "RETRY_BUSY", message: "Check your active tasks and retry when they are ready." } }, 409);
  }
  return c.json({ job: publicJob(await processClaimedCruiseJob(c.env, { ...job, provider_body: plan, lease_id: lease })) }, 202);
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

async function requestHash(input: unknown) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

async function findJob(env: AppEnv, userId: string, id: string) {
  return env.DB.prepare("SELECT * FROM template_generation WHERE user_id=? AND (id=? OR request_id=?)").bind(userId, id, id).first<Job>();
}

function publicJob(job: Job) {
  return {
    id: job.id, requestId: job.request_id, status: job.status, providerTaskId: job.provider_task_id,
    estimatedCredits: job.estimated_credits, consumedCredits: job.consumed_credits, refundedCredits: job.refunded_credits,
    canRetry: job.template_version >= 3 && job.status === "failed",
    ...(job.template_version >= 3 && job.status === "failed" ? { retryUsesCredits: retryUsesCredits(job.provider_body) } : {}),
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
  const minDelay = job.template_version >= 3 || job.provider_task_id ? 8_000 : 45_000;
  if (elapsed < minDelay) return job;
  const now = new Date().toISOString();
  const leaseId = crypto.randomUUID();
  const claimed = await env.DB.prepare(`UPDATE template_generation SET updated_at=?,lease_id=?,lease_until=?
    WHERE id=? AND updated_at=? AND (lease_until IS NULL OR lease_until<?)`)
    .bind(now, leaseId, new Date(Date.now() + 120_000).toISOString(), job.id, job.updated_at, now).run();
  if (!claimed.meta.changes) return (await findJob(env, job.user_id, job.id))!;
  job = { ...job, lease_id: leaseId };
  if (job.template_version >= 3) return processClaimedCruiseJob(env, job);
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

async function processClaimedCruiseJob(env: AppEnv, job: Job): Promise<Job> {
  try {
    await advanceCruiseJob(env, job);
  } finally {
    await releaseLease(env, job);
  }
  return (await findJob(env, job.user_id, job.id))!;
}

export async function reconcileCruiseJobs(env: AppEnv) {
  const now = new Date().toISOString();
  const jobs = await env.DB.prepare(`SELECT * FROM template_generation WHERE template_version=3
    AND status IN ('submitting','submission_unknown','processing') AND (lease_until IS NULL OR lease_until<?)
    AND updated_at<? ORDER BY updated_at LIMIT 5`).bind(now, new Date(Date.now()-8000).toISOString()).all<Job>();
  for (const job of jobs.results) {
    try { await refreshJob(env, job); } catch { console.error("Template reconciliation will retry"); }
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
      await storeProviderVideo(env, key, asset.url);
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
