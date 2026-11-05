import assert from "node:assert/strict";
import { it } from "node:test";
import type { AppEnv } from "../src/env";
import { cruiseRetryOptions, prepareCruiseRetry } from "../src/cruise-jobs";
import { classifyInputFailure, providerFailure, ProviderError, providerRequest } from "../src/seeapi";
import { currentCruiseClipPath } from "../src/template-assets";

it("distinguishes video and photo validation without exposing the provider response", async (t) => {
  const detail = "The input video must contain at least 407696 pixels per frame (width multiplied by height).";
  assert.equal(classifyInputFailure("INVALID_INPUT", detail), "template_video_resolution");
  assert.equal(classifyInputFailure("INVALID_INPUT", "The input image must be at least 301 × 301 pixels."), "photo_resolution");
  assert.equal(classifyInputFailure("INVALID_INPUT", "Invalid media https://example.test/private?secret=test"), "invalid_input");
  assert.equal(classifyInputFailure("UNKNOWN", detail), undefined);

  t.mock.method(globalThis, "fetch", async () => Response.json({
    error: { code: "INVALID_INPUT", message: detail + " https://example.test/private?secret=test" },
  }, { status: 422 }));
  await assert.rejects(
    () => providerRequest({ SEEAPI_API_KEY: "test" } as AppEnv, "/v1/generations", { body: "{}" }),
    (error: unknown) => error instanceof ProviderError && !error.uncertain && error.failure === "template_video_resolution"
      && !error.message.includes("secret"),
  );
});

it("recognizes policy failures in generation envelopes, direct tasks and HTTP errors", async (t) => {
  const detail = "The input video was blocked because it may contain a real person. Remove or replace this input, or use a verified authorized portrait asset. Credits have been refunded.";
  const error = { code: "CONTENT_POLICY_VIOLATION", message: detail };
  const task = { id: "task-opening", status: "failed", consumed_credits: 0, error };
  const responses = [Response.json({ generation: task }), Response.json(task), Response.json({ error }, { status: 403 })];
  t.mock.method(globalThis, "fetch", async () => responses.shift()!);
  const env = { SEEAPI_API_KEY: "fixture" } as AppEnv;
  for (let i = 0; i < 2; i++) {
    const result = await providerRequest(env, "/v1/generations/task-opening");
    assert.equal(providerFailure(result), "template_video_policy");
    assert.equal(result.consumed_credits, 0);
  }
  await assert.rejects(() => providerRequest(env, "/v1/generations", { body: "{}" }),
    (cause: unknown) => cause instanceof ProviderError && cause.failure === "template_video_policy");
  assert.equal(classifyInputFailure(error.code, "The input image was blocked because it may contain a real person."), "photo_policy");
  assert.equal(classifyInputFailure(error.code, "The output video was blocked."), "content_policy");
});

it("keeps policy-rejected openings on hold across signed URL changes and isolates legacy footage", async () => {
  const env = {
    BETTER_AUTH_URL: "https://app.example.test", BETTER_AUTH_SECRET: "test-only-signing-secret-with-more-than-32-bytes",
    MEDIA: { head: async () => ({ size: 1 }) },
  } as unknown as AppEnv;
  const partBody = (path: string) => JSON.stringify({input: {reference_video: ["https://app.example.test" + path + "?expires=old&signature=old"]}});
  const opening = { scene: "opening", body: partBody(currentCruiseClipPath("opening", 4)), status: "failed", attempt: 2,
    taskId: "attempt-two", previous: [{ consumed_credits: 0 }], credits: { consumed_credits: 0 }, failure: "template_video_policy" };
  const finale = { scene: "finale", status: "succeeded", result: "saved/finale.mp4", credits: { consumed_credits: 448 }, previous: [], attempt: 1 };
  const plan = { parts: [opening, finale], resolution: "480p", portraits: { photoUrl: "https://assets.example.test/a.jpg",
    partnerPhotoUrl: "https://assets.example.test/b.jpg" }, retries: [] };
  const before = JSON.stringify(plan);
  assert.equal(cruiseRetryOptions(env, before, 4).canRetry, false);
  await assert.rejects(() => prepareCruiseRetry(env, "fixture", before, "retry", 4), { code: "TEMPLATE_PAUSED" });
  // This persisted v3 plan has a saved live-action finale. A cartoon opening must never be issued for it.
  for (const path of ["/api/template-media/fixed/24k-magic/v3/opening", currentCruiseClipPath("opening", 3)]) {
    opening.body = partBody(path);
    const legacy = JSON.stringify(plan);
    assert.equal(cruiseRetryOptions(env, legacy, 3).canRetry, false);
    await assert.rejects(() => prepareCruiseRetry(env, "fixture", legacy, "retry", 3), { code: "TEMPLATE_PAUSED" });
  }
  // A v3 job with its opening saved may still retry its missing v3 finale.
  const missingFinale = JSON.stringify({ ...plan, parts: [
    { ...finale, scene: "opening", result: "saved/opening.mp4" },
    { ...opening, scene: "finale", failure: undefined },
  ] });
  const next = JSON.parse(await prepareCruiseRetry(env, "fixture", missingFinale, "retry", 3));
  const input = JSON.parse(next.parts[1].body).input;
  assert.equal(next.parts[0].result, "saved/opening.mp4");
  assert.equal(new URL(input.reference_video[0]).pathname, currentCruiseClipPath("finale", 3));
  assert.equal(input.aspect_ratio, "4:3");
  assert.equal(input.duration_seconds, 15);
});
