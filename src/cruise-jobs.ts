import type { AppEnv } from "./env";
import { MediaError, resolveMedia } from "./media";
import { ProviderError, providerFailure, providerFailureMessages, providerRequest, publicHttpsUrl, type ProviderFailure, type ProviderTask } from "./seeapi";
import { cruisePauseMessage, cruiseSpec, cruiseTemplateVersion, currentCruiseClipPath, isCruiseClipPaused, resolveCruiseAssets } from "./template-assets";
import { legacyScenePrompts, scenePrompts } from "./templates";
import { assembleCruiseVideo } from "./cruise-video";
import { storeProviderVideo } from "./result-video";

export type Portraits = { photoId: unknown; photoUrl: unknown; partnerPhotoId: unknown; partnerPhotoUrl: unknown };
type Scene = keyof typeof scenePrompts;
type Credits = { estimated_credits?: number; consumed_credits?: number; refunded_credits?: number };
type Part = {
  scene: Scene; attempt: number; body: string; status: string; taskId?: string; result?: string;
  failure?: ProviderFailure; credits: Credits; previous: (Credits & { failure?: ProviderFailure })[];
};
type Plan = { portraits: Portraits; resolution: string; parts: Part[]; retries: string[]; assemblyFailures?: number };
type LeasedJob = { template_version: number; id: string; user_id: string; provider_body: string; lease_id: string | null };
const scenes = ["opening", "finale"] as const;
const failures = new Set(["failed", "canceled", "refunded", "expired"]);
const unsubmitted = (part: Part) => part.status === "queued" && !part.taskId;

async function resolvePortrait(env: AppEnv, user: string, id: unknown, url: unknown, role: string) {
  if (id != null) {
    if (typeof id !== "string" || !id || url != null) throw new Error(`Choose one ${role} photo.`);
    const asset = await resolveMedia(env, user, id);
    if (asset.kind !== "photo") throw new Error(`Choose a photo for the ${role}.`);
    return asset.url;
  }
  if (!url) throw new Error(`Add the ${role} photo.`);
  return publicHttpsUrl(url);
}

async function makeBodies(env: AppEnv, user: string, photos: Portraits, resolution: string, version: number) {
  const [dancer, partner] = await Promise.all([
    resolvePortrait(env, user, photos.photoId, photos.photoUrl, "dancer"),
    resolvePortrait(env, user, photos.partnerPhotoId, photos.partnerPhotoUrl, "partner"),
  ]);
  const references = await resolveCruiseAssets(env, version);
  const { aspectRatio, providerSeconds } = cruiseSpec(version);
  const prompts = version === 3 ? legacyScenePrompts : scenePrompts;
  return scenes.map((scene) => JSON.stringify({
    model: "seedance-2", endpoint: "reference-to-video", provider: "seeapi", input: {
      prompt: prompts[scene], reference_images: [dancer, partner], reference_video: [references[scene]],
      duration_seconds: providerSeconds, resolution, aspect_ratio: aspectRatio, generate_audio: false, nsfw_checker: true,
    },
  }));
}

export async function createCruisePlan(env: AppEnv, user: string, portraits: Portraits, resolution: string): Promise<string> {
  if (scenes.some(scene => isCruiseClipPaused(env, scene))) throw new MediaError(503, "TEMPLATE_PAUSED", cruisePauseMessage);
  const bodies = await makeBodies(env, user, portraits, resolution, cruiseTemplateVersion);
  const plan: Plan = { portraits, resolution, retries: [], parts: scenes.map((scene, index) => ({
    scene, attempt: 1, body: bodies[index], status: "queued", credits: {}, previous: [],
  })) };
  return JSON.stringify(plan);
}

export function hasRetried(body: string, retryId: string): boolean {
  return (JSON.parse(body) as Plan).retries.includes(retryId);
}

function rejectedClipWasReplaced(part: Part, version: number): boolean {
  try {
    const url = new URL(JSON.parse(part.body).input.reference_video[0]);
    return url.pathname !== currentCruiseClipPath(part.scene, version);
  } catch {
    return false;
  }
}

function retryBlock(env: AppEnv, parts: Part[], version: number) {
  const missing = parts.filter(part => !part.result);
  if (missing.some(part => part.failure === "template_video_policy" && !rejectedClipWasReplaced(part, version))) {
    return new MediaError(503, "TEMPLATE_PAUSED", providerFailureMessages.template_video_policy);
  }
  if (missing.some(part => isCruiseClipPaused(env, part.scene, version))) {
    return new MediaError(503, "TEMPLATE_PAUSED", cruisePauseMessage);
  }
  for (const { failure } of missing) {
    if (failure === "photo_policy" || failure === "content_policy") {
      return new MediaError(422, "CONTENT_POLICY_VIOLATION", providerFailureMessages[failure]);
    }
  }
}

export function cruiseRetryOptions(env: AppEnv, body: string, version: number) {
  const { parts } = JSON.parse(body) as Plan;
  const block = retryBlock(env, parts, version);
  if (block) return { canRetry: false, templatePaused: block.code === "TEMPLATE_PAUSED", error: block.message };
  return { canRetry: true, retryUsesCredits: parts.some(part => !part.result) };
}

// Only an explicit, authenticated retry allocates a new provider idempotency key.
export async function prepareCruiseRetry(env: AppEnv, user: string, body: string, retryId: string, version: number): Promise<string> {
  const plan: Plan = JSON.parse(body);
  const block = retryBlock(env, plan.parts, version);
  if (block) throw block;
  plan.retries.push(retryId);
  plan.assemblyFailures = 0;
  if (plan.parts.every(part => part.result)) return JSON.stringify(plan);
  const bodies = await makeBodies(env, user, plan.portraits, plan.resolution, version);
  plan.parts = plan.parts.map((part, index) => failures.has(part.status) || unsubmitted(part) ? {
    scene: part.scene, body: bodies[index], attempt: part.attempt + 1, status: "queued", credits: {},
    previous: [...part.previous, { ...part.credits, failure: part.failure }],
  } : part);
  return JSON.stringify(plan);
}

function total(parts: Part[], field: keyof Credits) {
  const values = parts.flatMap(part => [...part.previous, part.credits]).flatMap(credits => credits[field] ?? []);
  return values.length ? values.reduce((a, b) => a + b, 0) : null;
}

function rememberCredits(part: Part, task: ProviderTask) {
  for (const field of ["estimated_credits", "consumed_credits", "refunded_credits"] as const) {
    const value = task[field];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) part.credits[field] = value;
  }
}

export async function advanceCruiseJob(env: AppEnv, job: LeasedJob) {
  const plan: Plan = JSON.parse(job.provider_body);
  const version = job.template_version;
  let error: string | null = null;
  // Commit every provider identifier before any download or additional submission.
  // The lease fences stale workers; (job, scene, attempt) identifies the exact persisted request.
  async function checkpoint(status = "processing", resultKey: string | null = null) {
    const now = new Date().toISOString();
    const written = await env.DB.prepare(`UPDATE template_generation SET provider_body=?,status=?,error=?,result_object_key=?,
      estimated_credits=?,consumed_credits=?,refunded_credits=?,updated_at=?,lease_until=? WHERE id=? AND lease_id=?`)
      .bind(JSON.stringify(plan), status, error, resultKey, total(plan.parts, "estimated_credits"), total(plan.parts, "consumed_credits"),
        total(plan.parts, "refunded_credits"), now, new Date(Date.now()+120_000).toISOString(), job.id, job.lease_id).run();
    return written.meta.changes === 1;
  }
  // Check both queued scenes before submitting either. Already accepted tasks can still be polled and saved.
  for (const part of plan.parts) {
    if (unsubmitted(part) && isCruiseClipPaused(env, part.scene, version)) part.status = "failed";
  }
  for (const part of plan.parts) {
    if (part.result || failures.has(part.status)) continue;
    if (unsubmitted(part) && plan.parts.some(p => failures.has(p.status) ||
      p.status === "submission_unknown" && !p.taskId && isCruiseClipPaused(env, p.scene, version))) continue;
    if (part.status === "submission_unknown" && !part.taskId && isCruiseClipPaused(env, part.scene, version)) {
      error = cruisePauseMessage;
      continue;
    }
    const key = `results/${job.user_id}/${job.id}/${part.scene}-${part.attempt}.mp4`;
    if (part.status === "succeeded" && await env.MEDIA.head(key)) {
      part.result = key;
      if (!await checkpoint()) return;
      continue;
    }
    let task: ProviderTask;
    try {
      task = part.taskId
        ? await providerRequest(env, `/v1/generations/${encodeURIComponent(part.taskId)}`)
        : await providerRequest(env, "/v1/generations", { body: part.body, key: `template-${job.id}-${part.scene}-${part.attempt}` });
    } catch (cause) {
      if (!part.taskId) {
        if (cause instanceof ProviderError && !cause.uncertain) {
          part.status = "failed";
          part.failure = cause.failure;
        } else {
          part.status = "submission_unknown";
        }
      }
      error = "The video service could not finish this step. Check this task for updates.";
      if (!await checkpoint()) return;
      continue;
    }
    part.taskId = task.id;
    part.status = task.status;
    if (failures.has(part.status)) part.failure = providerFailure(task);
    rememberCredits(part, task);
    if (!await checkpoint()) return;
    if (task.status === "succeeded") {
      try {
        const url = task.result?.assets?.find(asset => asset.url && (asset.type === "video" || asset.mime_type?.startsWith("video/")))?.url;
        if (!url) throw new Error("No downloadable video");
        await storeProviderVideo(env, key, url);
        part.result = key;
      } catch {
        error = "Your generated footage is being saved. You can check this task again.";
      }
      if (!await checkpoint()) return;
    }
  }
  if (plan.parts.every(p => p.result)) {
    const key = `results/${job.user_id}/${job.id}/video.mp4`;
    try {
      if (!await env.MEDIA.head(key)) await assembleCruiseVideo(env.MEDIA, plan.parts[0].result!, plan.parts[1].result!, key, version);
    } catch {
      plan.assemblyFailures = (plan.assemblyFailures ?? 0) + 1;
      error = "Your footage is saved. Finishing the final video is still pending.";
      await checkpoint(plan.assemblyFailures >= 3 ? "failed" : "processing");
      return;
    }
    error = null;
    await checkpoint("succeeded", key);
    return;
  }
  // Keep polling any already submitted sibling after a failure so its outcome and charges are preserved.
  const failed = plan.parts.some(p => failures.has(p.status));
  if (failed && plan.parts.every(p => p.result || failures.has(p.status) || unsubmitted(p))) {
    const reasons = plan.parts.flatMap(p => p.failure ? [providerFailureMessages[p.failure]] : []);
    error = retryBlock(env, plan.parts, version)?.message ?? ([...new Set(reasons)].join(" ") || "The video service could not complete the generation. You can retry the unfinished part.");
    await checkpoint("failed");
    return;
  }
  await checkpoint(plan.parts.some(p => p.status === "submission_unknown") ? "submission_unknown" : "processing");
}
