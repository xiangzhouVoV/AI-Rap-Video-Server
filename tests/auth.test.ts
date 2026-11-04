import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { getPlatformProxy } from "wrangler";
import { createAuth, type AuthEnv } from "../src/auth";
import app from "../src/index";

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
});
