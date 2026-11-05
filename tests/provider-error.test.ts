import assert from "node:assert/strict";
import { it } from "node:test";
import type { AppEnv } from "../src/env";
import { classifyInputFailure, ProviderError, providerRequest } from "../src/seeapi";

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
