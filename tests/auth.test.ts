import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { getPlatformProxy } from "wrangler";
import { createAuth, type AuthEnv } from "../src/auth";
import { app } from "../src/index";
import { reconcileCruiseJobs } from "../src/generations";
import type { AppEnv } from "../src/env";
import { cruiseSpec, resolveCruiseAssets } from "../src/template-assets";

const origin = "https://auth.example.test";
let env: AuthEnv;
let auth: ReturnType<typeof createAuth>;
let platform: Awaited<ReturnType<typeof getPlatformProxy<AuthEnv>>>;
let storagePath: string;

function request(path: string, init?: RequestInit, bindings = env) {
  const headers = new Headers(init?.headers);
  headers.set("CF-Connecting-IP", "192.0.2.10");
  return app.request(`${origin}${path}`, { ...init, headers }, bindings);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return request(path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function createSession(expired = false) {
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser({
    name: "Test User",
    email: `${crypto.randomUUID()}@example.test`,
    emailVerified: true,
  }, { method: "test-fixture" });
  const session = await context.internalAdapter.createSession(user.id, false);
  if (expired) {
    await context.internalAdapter.updateSession(session.token, {
      expiresAt: new Date(Date.now() - 60_000),
    });
  }
  // The real Better Auth handler verifies this signature and loads the D1 session.
  const signature = createHmac("sha256", env.BETTER_AUTH_SECRET)
    .update(session.token)
    .digest("base64");
  const cookieName = context.authCookies.sessionToken.name;
  const cookie = `${cookieName}=${encodeURIComponent(`${session.token}.${signature}`)}`;
  return { user, session, cookie };
}

describe("authentication against local D1", { concurrency: false }, () => {
  before(async () => {
    storagePath = await mkdtemp(join(tmpdir(), "ai-rap-auth-test-"));
    platform = await getPlatformProxy<AuthEnv>({
      configPath: resolve("wrangler.jsonc"),
      persist: { path: storagePath },
      remoteBindings: false,
    });
    env = {
      ...platform.env,
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: "test-only-auth-secret-with-at-least-32-characters",
      GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "test-only-google-secret",
    };
    const files = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
    assert.ok(files.length > 0, "The generated D1 migrations must exist before running tests.");
    for (const file of files) {
      const sql = await readFile(join("migrations", file), "utf8");
      // These generated schema migrations contain DDL, with no SQL string literals containing semicolons.
      const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
      await env.DB.batch(statements.map((statement) => env.DB.prepare(statement)));
    }
    auth = createAuth(env);
  });

  beforeEach(async () => {
    // Tests are independent requests, not a simulated burst from one visitor.
    await env.DB.prepare('DELETE FROM "rateLimit"').run();
  });

  after(async () => {
    await platform?.dispose();
    if (storagePath) await rm(storagePath, { recursive: true, force: true });
  });

  it("keeps health available without OAuth configuration", async () => {
    const response = await request("/api/health", undefined, {} as AuthEnv);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("returns 503 without exposing secrets when auth configuration is missing", async () => {
    for (const missing of ["BETTER_AUTH_URL", "BETTER_AUTH_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const) {
      const bindings = { ...env, [missing]: "" };
      for (const path of ["/api/me", "/api/auth/get-session"]) {
        const response = await request(path, undefined, bindings);
        assert.equal(response.status, 503, `${path}: missing ${missing}`);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
          error: { code: "AUTH_NOT_CONFIGURED", message: "Sign-in is temporarily unavailable." },
        });
      }
    }
  });

  it("rejects an anonymous request with 401", async () => {
    const response = await request("/api/me");
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      error: { code: "UNAUTHORIZED", message: "Sign in to continue." },
    });
  });

  it("keeps the two scene instructions private and resumes or retries only unfinished work", async (t) => {
    const { user, cookie } = await createSession();
    const bindings = { ...(env as AppEnv), CRUISE_PAUSED_CLIP_KEY: "", TEMPLATE_DEBUG_EMAILS: user.email, SEEAPI_API_KEY: "test-only",
      SEEAPI_API_BASE_URL: "https://provider.example.test", MEDIA_PUBLIC_BASE_URL: origin };
    const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
    const submit = (body: Record<string, unknown>, suffix = "") => request("/api/template-generations" + suffix, {
      method: "POST", headers, body: JSON.stringify(body),
    }, bindings);
    const partnerPhotoId = crypto.randomUUID();
    const token = "a".repeat(64);
    await env.DB.prepare(`INSERT INTO template_media (id,user_id,object_key,kind,content_type,byte_size,access_token,created_at)
      VALUES (?,?,?,'photo','image/webp',100,?,?)`).bind(partnerPhotoId, user.id, "partner", token, new Date().toISOString()).run();
    const body = { requestId: crypto.randomUUID(), templateId: "24k-magic", templateVersion: 4,
      photoUrl: "https://assets.example.test/dancer.jpg", partnerPhotoId };
    const submitted: {body: string; key: string}[] = [];
    let openingPolls = 0;
    const mediaUrl = "https://assets.example.test/result.mp4";
    const providerUrl = "https://provider.example.test/v1/generations";
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === mediaUrl) return new Response(new Uint8Array([1, 2]), { headers: { "Content-Type": "video/mp4" } });
      if (url === providerUrl && init?.method === "POST") {
        const key = new Headers(init.headers).get("Idempotency-Key")!;
        submitted.push({body: String(init.body), key});
        if (key.endsWith("finale-1") && submitted.length === 2) return new Response(null, { status: 502 });
        return Response.json({ generation: { id: key, consumed_credits: 1, ...(key.endsWith("finale-1") ? {
          status: "failed", error_code: "INVALID_INPUT",
          error_message: "The input video must contain at least 407696 pixels per frame (width multiplied by height). " +
            "Use a higher resolution input video and try again. https://private.example.test/video?secret=test-private-error",
        } : { status: "processing" }) } });
      }
      if (url.startsWith(providerUrl + "/")) {
        if (url.endsWith("opening-1") && openingPolls++ === 0) {
          return Response.json({ generation: { id: url.split("/").pop(), status: "queued" } });
        }
        return Response.json({ generation: { id: url.split("/").pop(), status: "succeeded", consumed_credits: 3,
          result: { assets: [{ type: "video", url: mediaUrl }] } } });
      }
      return realFetch(input, init);
    });

    const { clipKeys: cruiseClipKeys, audioKey: cruiseAudioKey } = cruiseSpec(4);
    const config = await (await request("/api/templates/24k-magic?version=4", { headers }, bindings)).json() as { template: object };
    assert.deepEqual(config.template, { id: "24k-magic", name: "24K Magic Cruise Dance", version: 4,
      duration: 605 / 30, aspectRatio: "16:9", resolution: "720p" });
    assert.equal((await submit({ ...body, templateVersion: undefined })).status, 409);
    assert.equal((await submit({ ...body, templateVersion: 3 })).status, 409);
    assert.equal((await submit({ ...body, partnerPhotoId: undefined })).status, 400);
    for (const override of ["prompt", "referenceVideoId", "referenceVideoUrl", "referenceAudioUrl", "duration", "aspectRatio", "generateAudio"]) {
      assert.equal((await submit({ ...body, [override]: "override" })).status, 400);
    }
    assert.equal((await submit(body)).status, 503);
    assert.equal(submitted.length, 0);
    for (const key of [cruiseClipKeys.opening, cruiseClipKeys.finale, cruiseAudioKey]) await bindings.MEDIA.put(key, "fixture");
    bindings.CRUISE_PAUSED_CLIP_KEY = "templates/24k-magic/v3/720p/01-deck-dance.mp4";
    const response = await submit(body);
    assert.equal(response.status, 202);
    type Public = { job: { id: string; status: string; canRetry: boolean; retryUsesCredits?: boolean; error: string | null; consumedCredits: number; videoUrl: string | null } };
    const { job } = await response.json() as Public;
    assert.equal(job.status, "submission_unknown");
    assert.equal(job.videoUrl, null);
    assert.equal((await submit(body)).status, 200);
    assert.equal((await submit({ ...body, partnerPhotoId: undefined, partnerPhotoUrl: "https://assets.example.test/other.jpg" })).status, 409);
    assert.equal(submitted.length, 2);
    for (const [index, entry] of submitted.entries()) {
      const input = JSON.parse(entry.body).input;
      assert.deepEqual(input.reference_images, [body.photoUrl, `${origin}/api/template-media/${partnerPhotoId}/content?token=${token}`]);
      assert.equal(new URL(input.reference_video[0]).pathname.endsWith(index ? "/finale" : "/opening"), true);
      assert.equal(input.generate_audio, false);
      assert.equal(input.aspect_ratio, "16:9");
      assert.equal(input.duration_seconds, 11);
    }
    const lookup = async () => (await (await request("/api/template-generations/" + job.id, { headers }, bindings)).json() as Public).job;
    const advance = async () => {
      await env.DB.prepare("UPDATE template_generation SET updated_at=? WHERE id=?").bind("2001-01-01T00:00:00.000Z", job.id).run();
      await reconcileCruiseJobs(bindings);
      return lookup();
    };
    assert.equal((await advance()).status, "processing", "a provider-queued sibling must keep its task ID and finish");
    const partial = await advance();
    assert.equal(partial.status, "failed");
    assert.equal(partial.canRetry, true);
    assert.equal(partial.error, "The template's video resolution was too low for generation. You can keep both photos.");
    assert.equal(partial.consumedCredits, 4);
    assert.equal(partial.retryUsesCredits, true);
    assert.deepEqual(submitted[1], submitted[2], "uncertain submission must replay identical provider request");
    const retryId = crypto.randomUUID();
    const retry = () => submit({retryId}, "/" + job.id + "/retry");
    bindings.CRUISE_PAUSED_CLIP_KEY = cruiseClipKeys.finale;
    assert.equal((await lookup()).canRetry, false);
    assert.equal((await retry()).status, 503);
    const newRequest = await submit({...body, requestId: crypto.randomUUID()});
    assert.equal(newRequest.status, 503);
    assert.equal((await newRequest.json() as {error: {code: string}}).error.code, "TEMPLATE_PAUSED");
    assert.equal(submitted.length, 3);
    // The held opening is already saved. The missing finale can still be retried.
    bindings.CRUISE_PAUSED_CLIP_KEY = cruiseClipKeys.opening;
    assert.equal((await lookup()).canRetry, true);
    assert.equal((await retry()).status, 202);
    assert.equal((await retry()).status, 200);
    assert.equal(submitted.length, 4);
    assert.ok(submitted[3].key.endsWith("finale-2"));
    const stored = await env.DB.prepare("SELECT provider_body FROM template_generation WHERE id=?").bind(job.id).first<string>("provider_body");
    assert.ok(stored && !stored.includes("test-private-error"));
    assert.deepEqual(JSON.parse(stored).parts[1].previous, [{ consumed_credits: 1, failure: "template_video_resolution" }]);
    // These dummy media bytes cannot be assembled. Saving both parts alone must not publish the job.
    assert.equal((await advance()).status, "processing");
    assert.equal((await lookup()).videoUrl, null);
    await advance();
    const waiting = await advance();
    assert.equal(waiting.status, "failed");
    assert.equal(waiting.retryUsesCredits, false);
    // Simulate a worker that completed the R2 write and lost its lease before the final database update.
    await bindings.MEDIA.put(`results/${user.id}/${job.id}/video.mp4`, "already assembled");
    const finishing = await submit({retryId: crypto.randomUUID()}, "/" + job.id + "/retry");
    assert.equal(finishing.status, 202);
    const complete = (await finishing.json() as Public).job;
    assert.equal(complete.status, "succeeded");
    assert.ok(complete.videoUrl);
    assert.equal(complete.consumedCredits, 7);
    assert.equal(submitted.length, 4);

    const now = new Date().toISOString();
    const legacyRequest = { requestId: crypto.randomUUID(), templateId: "24k-magic",
      photoUrl: body.photoUrl, referenceVideoUrl: "https://assets.example.test/reference.mp4" };
    await env.DB.prepare(`INSERT INTO template_generation
      (id,user_id,request_id,request_hash,template_id,template_version,provider_body,status,created_at,updated_at)
      VALUES (?,?,?,?,'24k-magic',1,'{}','canceled',?,?)`)
      .bind(crypto.randomUUID(), user.id, legacyRequest.requestId, "14e4005f88800713ef71761d6c799b854e18b09e9038e955a9d86961543247c3", now, now).run();
    assert.equal((await submit(legacyRequest)).status, 200);
    assert.equal((await submit({ ...legacyRequest, partnerPhotoId })).status, 409);
    for (const hash of ["dfa80a9b171d53e6e3d7310d1c7a38b66f1b3ed78369c0c5b16ad99ef40f1379", "75e2ebfa3e1fdb7e6d4ef5627fd7a51e7d45cd8d6b4e68a0c6399090f2b57128"]) {
      const v2Request = { ...legacyRequest, requestId: crypto.randomUUID(), partnerPhotoUrl: "https://assets.example.test/partner.jpg" };
      await env.DB.prepare(`INSERT INTO template_generation
        (id,user_id,request_id,request_hash,template_id,template_version,provider_body,status,created_at,updated_at)
        VALUES (?,?,?,?,'24k-magic',2,'{}','canceled',?,?)`)
        .bind(crypto.randomUUID(), user.id, v2Request.requestId, hash, now, now).run();
      assert.equal((await submit(v2Request)).status, 200);
      assert.equal((await submit({...v2Request, partnerPhotoUrl: "https://assets.example.test/changed.jpg"})).status, 409);
    }
  });

  it("pins the full-length trial and submits its finale only after saving the opening", async (t) => {
    const { user, cookie } = await createSession();
    const bindings = { ...(env as AppEnv), CRUISE_PAUSED_CLIP_KEY: "", CRUISE_TRIAL_ENABLED: "", TEMPLATE_DEBUG_EMAILS: user.email,
      SEEAPI_API_KEY: "test-only", SEEAPI_API_BASE_URL: "https://provider.example.test", MEDIA_PUBLIC_BASE_URL: origin };
    const headers = { Origin: origin, Cookie: cookie, "Content-Type": "application/json" };
    const submit = (body: object, suffix = "") => request("/api/template-generations" + suffix, {
      method: "POST", headers, body: JSON.stringify(body),
    }, bindings);
    const { clipKeys, audioKey } = cruiseSpec(5);
    for (const key of [clipKeys.opening, clipKeys.finale, audioKey]) await bindings.MEDIA.put(key, "trial asset");
    const config = await request("/api/templates/24k-magic", { headers }, bindings);
    const configBody = await config.json() as {template: object; capabilities: {generationEnabled: boolean; pauseReason: string}};
    assert.deepEqual(await (await request("/api/templates/24k-magic?version=5", { headers }, bindings)).json(), configBody);
    assert.equal(configBody.capabilities.generationEnabled, false);
    assert.equal(configBody.capabilities.pauseReason, "portrait_replacement");
    assert.deepEqual(configBody.template, {
      id: "24k-magic", name: "24K Magic Cruise Dance", version: 5, duration: 713 / 24, aspectRatio: "16:9", resolution: "720p",
    });
    const signed = new URL((await resolveCruiseAssets(bindings, 5)).opening);
    assert.equal(await (await request(signed.pathname + signed.search)).text(), "trial asset");
    assert.equal((await request(signed.pathname.replace("/v5/", "/v4/") + signed.search)).status, 404);
    const photos = { templateId: "24k-magic", templateVersion: 5, photoUrl: "https://assets.example.test/a.png",
      partnerPhotoUrl: "https://assets.example.test/b.png" };
    const providerUrl = "https://provider.example.test/v1/generations";
    const videoUrl = "https://assets.example.test/trial.mp4";
    const submitted: string[] = [];
    let blocked = true;
    let canSave = false;
    const realFetch = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === videoUrl) return canSave ? new Response(new Uint8Array([1, 2])) : new Response(null, { status: 503 });
      if (url === providerUrl && init?.method === "POST") {
        const key = new Headers(init.headers).get("Idempotency-Key")!;
        const { input: payload } = JSON.parse(String(init.body));
        assert.equal(payload.duration_seconds, 15);
        assert.equal(payload.nsfw_checker, true);
        assert.equal(new URL(payload.reference_video[0]).pathname, "/api/template-media/fixed/24k-magic/v5/" + (key.endsWith("opening-1") ? "opening" : "finale"));
        submitted.push(key);
        return Response.json({ id: key, status: "processing" });
      }
      if (url.startsWith(providerUrl + "/")) return Response.json(blocked
        ? { id: url.split("/").pop(), status: "failed", consumed_credits: 0, error: { code: "CONTENT_POLICY_VIOLATION", message: "The input video was blocked because it may contain a real person." } }
        : { id: url.split("/").pop(), status: "succeeded", result: { assets: [{ type: "video", url: videoUrl }] } });
      return realFetch(input, init);
    });
    async function advance(id: string) {
      await env.DB.prepare("UPDATE template_generation SET updated_at=? WHERE id=?").bind("2001-01-01T00:00:00.000Z", id).run();
      await reconcileCruiseJobs(bindings);
      const response = await request("/api/template-generations/" + id, { headers }, bindings);
      return (await response.json() as { job: { status: string; canRetry: boolean; consumedCredits: number } }).job;
    }
    const body = { ...photos, requestId: crypto.randomUUID() };
    const paused = await submit(body);
    assert.equal(paused.status, 503);
    assert.equal((await paused.json() as {error: {code: string}}).error.code, "TEMPLATE_PAUSED");
    assert.deepEqual(submitted, []);
    bindings.CRUISE_TRIAL_ENABLED = "true";
    const enabled = await request("/api/templates/24k-magic", { headers }, bindings);
    assert.deepEqual((await enabled.json() as typeof configBody).capabilities, {
      generationEnabled: true, uploadsPublic: true, templatePaused: false,
    });
    const first = await submit(body);
    assert.equal(first.status, 202);
    const { job } = await first.json() as { job: { id: string; templateVersion: number } };
    assert.equal(job.templateVersion, 5);
    assert.equal((await submit({ ...body, templateVersion: 4 })).status, 409);
    const failed = await advance(job.id);
    assert.equal(failed.status, "failed");
    assert.equal(failed.canRetry, false);
    assert.equal(failed.consumedCredits, 0);
    assert.equal((await submit({ retryId: crypto.randomUUID() }, "/" + job.id + "/retry")).status, 503);
    assert.deepEqual(submitted, [`template-${job.id}-opening-1`]);

    blocked = false;
    const accepted = await submit({ ...photos, requestId: crypto.randomUUID() });
    const secondId = (await accepted.json() as { job: { id: string } }).job.id;
    await advance(secondId);
    assert.equal(submitted.length, 2, "an opening still being downloaded must not trigger the finale");
    canSave = true;
    await advance(secondId);
    assert.deepEqual(submitted.slice(1), [`template-${secondId}-opening-1`, `template-${secondId}-finale-1`]);
  });

  it("rejects a forged session cookie", async () => {
    const { cookie } = await createSession();
    const response = await request("/api/me", { headers: { Cookie: `${cookie}tampered` } });
    assert.equal(response.status, 401);
  });

  it("rejects a correctly signed but expired D1 session", async () => {
    const { cookie } = await createSession(true);
    const response = await request("/api/me", { headers: { Cookie: cookie } });
    assert.equal(response.status, 401);
  });

  it("starts Google OAuth with the public callback URL and browser-bound state", async () => {
    const beforeCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM "verification"').first<{ count: number }>();
    const response = await post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/" });
    assert.equal(response.status, 200);
    const body = await response.json() as { url: string; redirect: boolean };
    assert.equal(body.redirect, true);
    const target = new URL(body.url);
    assert.equal(target.origin, "https://accounts.google.com");
    assert.equal(target.searchParams.get("client_id"), env.GOOGLE_CLIENT_ID);
    assert.equal(target.searchParams.get("redirect_uri"), `${origin}/api/auth/callback/google`);
    assert.equal(target.searchParams.get("response_type"), "code");
    assert.ok(target.searchParams.get("state"));
    assert.ok(target.searchParams.get("scope")?.includes("openid"));
    const cookies = response.headers.getSetCookie();
    assert.ok(cookies.some((cookie) => /state=/i.test(cookie)), "OAuth state must be bound to the browser with a cookie.");
    assert.ok(cookies.every((cookie) => /HttpOnly/i.test(cookie) && /Secure/i.test(cookie) && /SameSite=Lax/i.test(cookie)));
    const afterCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM "verification"').first<{ count: number }>();
    assert.equal(afterCount!.count, beforeCount!.count + 1);
  });

  it("rejects a sign-in request from an untrusted origin", async () => {
    const response = await post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/" }, { Origin: "https://attacker.example" });
    assert.equal(response.status, 403);
  });

  it("rejects auth mutations without an Origin or with a null Origin", async () => {
    for (const suppliedOrigin of [undefined, "null"]) {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (suppliedOrigin) headers.Origin = suppliedOrigin;
      const response = await request("/api/auth/sign-in/social", {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "google", callbackURL: "/" }),
      });
      assert.equal(response.status, 403);
    }
  });

  it("rejects a callback URL pointing outside the application", async () => {
    const response = await post("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "https://attacker.example/steal",
    });
    assert.equal(response.status, 403);
  });

  it("rejects OAuth callbacks that have no valid state", async () => {
    const beforeCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first<{ count: number }>();
    const response = await request("/api/auth/callback/google?code=untrusted-code&state=untrusted-state");
    assert.ok(response.status >= 300 && response.status < 500);
    assert.ok(!response.headers.getSetCookie().some((cookie) => /session_token=[^;]/.test(cookie)));
    const afterCount = await env.DB.prepare('SELECT COUNT(*) AS count FROM "session"').first<{ count: number }>();
    assert.equal(afterCount!.count, beforeCount!.count);
  });

  it("rejects a valid OAuth state when the browser state cookie is missing", async () => {
    const started = await post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/" });
    assert.equal(started.status, 200);
    const { url } = await started.json() as { url: string };
    const state = new URL(url).searchParams.get("state")!;
    const response = await request(`/api/auth/callback/google?code=untrusted-code&state=${state}`);
    assert.equal(response.status, 302);
    assert.equal(new URL(response.headers.get("location")!).searchParams.get("error"), "state_mismatch");
    assert.ok(!response.headers.getSetCookie().some((cookie) => /session_token=[^;]/.test(cookie)));
  });

  it("completes a simulated Google OAuth exchange and reuses the same user on repeat login", async (t) => {
    // No real Google credentials or network access: only the token and JWKS responses are mocked.
    // The application's state, PKCE, D1 writes, and session handling run normally.
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "local-test-key", alg: "RS256", use: "sig" };
    const providerId = `google-${crypto.randomUUID()}`;
    const email = `${providerId}@example.test`;
    const realFetch = globalThis.fetch;
    let authorization: URL;
    let tokenExchanges = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.href === "https://oauth2.googleapis.com/token") {
        const form = new URLSearchParams(await new Request(input, init).text());
        assert.equal(form.get("grant_type"), "authorization_code");
        assert.equal(form.get("client_id"), env.GOOGLE_CLIENT_ID);
        assert.equal(form.get("client_secret"), env.GOOGLE_CLIENT_SECRET);
        assert.equal(form.get("redirect_uri"), `${origin}/api/auth/callback/google`);
        assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), authorization.searchParams.get("code_challenge"));
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: jwk.kid })).toString("base64url");
        const claims = Buffer.from(JSON.stringify({
          iss: "https://accounts.google.com",
          aud: env.GOOGLE_CLIENT_ID,
          sub: providerId,
          iat: now,
          exp: now + 3600,
          nonce: authorization.searchParams.get("nonce") ?? undefined,
          name: "Mock Google User",
          email,
          email_verified: true,
          picture: "https://example.test/avatar.png",
        })).toString("base64url");
        const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), privateKey).toString("base64url");
        tokenExchanges += 1;
        return Response.json({
          access_token: "mock-google-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: `${header}.${claims}.${signature}`,
        });
      }
      if (target.href === "https://www.googleapis.com/oauth2/v3/certs") {
        return Response.json({ keys: [jwk] });
      }
      assert.ok(!/(^|\.)google(?:apis)?\.com$/.test(target.hostname), "Unexpected Google endpoint: test must not call a real provider.");
      return realFetch(input, init);
    });

    let firstUserId: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = await post("/api/auth/sign-in/social", { provider: "google", callbackURL: "/account" });
      assert.equal(start.status, 200);
      const { url } = await start.json() as { url: string };
      authorization = new URL(url);
      const state = authorization.searchParams.get("state")!;
      const stateCookie = start.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ");
      const callback = await request(`/api/auth/callback/google?code=mock-code-${attempt}&state=${state}`, {
        headers: { Cookie: stateCookie },
      });
      assert.equal(callback.status, 302);
      assert.equal(new URL(callback.headers.get("location")!, origin).pathname, "/account");
      const sessionCookie = callback.headers.getSetCookie().find((cookie) => /session_token=[^;]/.test(cookie));
      assert.ok(sessionCookie, "A successful OAuth callback must issue a session cookie.");
      assert.match(sessionCookie, /HttpOnly/i);
      assert.match(sessionCookie, /Secure/i);
      const profile = await request("/api/me", { headers: { Cookie: sessionCookie.split(";")[0] } });
      assert.equal(profile.status, 200);
      const result = await profile.json() as { user: { id: string; email: string; emailVerified: boolean } };
      assert.equal(result.user.email, email);
      assert.equal(result.user.emailVerified, true);
      if (firstUserId) assert.equal(result.user.id, firstUserId);
      firstUserId = result.user.id;
      const verification = await env.DB.prepare('SELECT id FROM "verification" WHERE identifier = ?')
        .bind(`auth-state:${state}`).first();
      assert.equal(verification, null, "The OAuth state must be consumed after successful callback.");
    }
    assert.equal(tokenExchanges, 2);
    const users = await env.DB.prepare('SELECT COUNT(*) AS count FROM "user" WHERE email = ?').bind(email).first<{ count: number }>();
    const accounts = await env.DB.prepare('SELECT COUNT(*) AS count FROM "account" WHERE "providerId" = ? AND "accountId" = ?')
      .bind("google", providerId).first<{ count: number }>();
    assert.equal(users!.count, 1);
    assert.equal(accounts!.count, 1);
  });

  it("returns the authenticated user without tokens and revokes the session on sign-out", async () => {
    const { cookie, user, session } = await createSession();
    const profile = await request("/api/me", { headers: { Cookie: cookie } });
    assert.equal(profile.status, 200);
    const body = await profile.json() as { user: { id: string; email: string }; session: { id: string } };
    assert.equal(body.user.id, user.id);
    assert.equal(body.user.email, user.email);
    assert.equal(body.session.id, session.id);
    assert.ok(!JSON.stringify(body).includes(session.token));
    assert.deepEqual(Object.keys(body.user).sort(), ["email", "emailVerified", "id", "image", "name"]);
    assert.deepEqual(Object.keys(body.session).sort(), ["expiresAt", "id"]);

    const signedOut = await post("/api/auth/sign-out", {}, { Cookie: cookie });
    assert.equal(signedOut.status, 200);
    assert.ok(signedOut.headers.getSetCookie().some((value) => /session_token=;/.test(value) && /Max-Age=0/i.test(value)));
    const stored = await env.DB.prepare('SELECT id FROM "session" WHERE token = ?').bind(session.token).first();
    assert.equal(stored, null);
    const afterLogout = await request("/api/me", { headers: { Cookie: cookie } });
    assert.equal(afterLogout.status, 401);
  });

  it("serves only the signed template clip, including provider HEAD and byte-range requests", async (t) => {
    const bindings = env as AppEnv;
    const { clipKeys: cruiseClipKeys, audioKey: cruiseAudioKey } = cruiseSpec(5);
    await bindings.MEDIA.put(cruiseClipKeys.opening, "opening");
    await bindings.MEDIA.put(cruiseClipKeys.finale, "finale");
    await bindings.MEDIA.delete(cruiseAudioKey);
    await assert.rejects(resolveCruiseAssets(bindings), { code: "TEMPLATE_UNAVAILABLE" });
    await bindings.MEDIA.put(cruiseAudioKey, "private audio");

    const signed = await resolveCruiseAssets(bindings);
    const clip = new URL(signed.opening);
    assert.equal(clip.pathname, "/api/template-media/fixed/24k-magic/v5/opening");
    const oldClip = new URL(clip.href);
    oldClip.pathname = "/api/template-media/fixed/24k-magic/v3/opening";
    assert.equal((await request(oldClip.pathname + clip.search)).status, 404);
    await bindings.MEDIA.put("templates/24k-magic/v3/01-deck-dance.mp4", "old opening");
    const oldSignature = createHmac("sha256", bindings.BETTER_AUTH_SECRET)
      .update(`provider-read\n${oldClip.pathname}\n${oldClip.searchParams.get("expires")}`).digest("hex");
    oldClip.searchParams.set("signature", oldSignature);
    const legacy = await request(oldClip.pathname + oldClip.search);
    assert.equal(legacy.status, 200);
    assert.equal(await legacy.text(), "old opening");
    assert.equal((await request(clip.pathname + oldClip.search)).status, 404);
    const response = await request(clip.pathname + clip.search, { headers: { Range: "bytes=2-4" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 2-4/7");
    assert.equal(await response.text(), "eni");
    const head = await request(clip.pathname + clip.search, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "7");
    assert.equal(await head.text(), "");
    assert.equal((await request(clip.pathname + clip.search, { headers: { Range: "bytes=7-" } })).status, 416);

    assert.equal((await request(clip.pathname)).status, 404);
    assert.equal((await request(new URL(signed.finale).pathname + clip.search)).status, 404);
    assert.equal((await request(clip.pathname.replace("opening", "audio") + clip.search)).status, 404);
    const expiry = Number(clip.searchParams.get("expires")) * 1000;
    t.mock.method(Date, "now", () => expiry);
    assert.equal((await request(clip.pathname + clip.search)).status, 404);
    assert.equal((await request(oldClip.pathname + oldClip.search)).status, 404);
  });
});
