import { Hono, type Context } from "hono";
import { createAuth, type AuthEnv } from "./auth";
import { canDebugTemplates, type AppBindings } from "./env";
import { templateRoutes } from "./templates";
import { generationRoutes } from "./generations";
import { mediaRoutes } from "./media";

const app = new Hono<AppBindings>();

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.use("/api/*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  await next();
});

app.use("/api/auth/*", async (c, next) => {
  if (!isConfigured(c.env)) return unavailable(c);
  // This service only accepts browser mutations from its public same-origin app.
  // Google redirects use GET and must remain reachable without an Origin header.
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("Origin") !== c.env.BETTER_AUTH_URL) {
    return c.json({ error: { code: "UNTRUSTED_ORIGIN", message: "Request origin is not allowed." } }, 403);
  }
  await next();
});
app.all("/api/auth/*", (c) => createAuth(c.env).handler(c.req.raw));

app.use("/api/*", async (c, next) => {
  const path = c.req.path;
  if (!/^\/api\/(templates|template-generations|template-media)(\/|$)/.test(path)) return next();
  if (["GET", "HEAD"].includes(c.req.method) && /^\/api\/template-media\/[^/]+\/content$/.test(path)) return next();
  if (!isConfigured(c.env)) return unavailable(c);
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method) && c.req.header("Origin") !== c.env.BETTER_AUTH_URL) {
    return c.json({ error: { code: "UNTRUSTED_ORIGIN", message: "Request origin is not allowed." } }, 403);
  }
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in to test this template." } }, 401);
  if (!canDebugTemplates(c.env, session.user.email)) return c.json({ error: { code: "DEBUG_ACCESS_REQUIRED", message: "Template generation is currently limited to configured test accounts." } }, 403);
  c.set("userId", session.user.id);
  return next();
});
app.route("/api/templates", templateRoutes);
app.route("/api/template-media", mediaRoutes);
app.route("/api/template-generations", generationRoutes);

app.get("/api/me", async (c) => {
  if (!isConfigured(c.env)) return unavailable(c);
  const session = await createAuth(c.env).api.getSession({ headers: c.req.raw.headers });
  if (!session) {
    return c.json({ error: { code: "UNAUTHORIZED", message: "Sign in to continue." } }, 401);
  }
  return c.json({
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      emailVerified: session.user.emailVerified,
      image: session.user.image,
    },
    session: { id: session.session.id, expiresAt: session.session.expiresAt },
  });
});

function isConfigured(env: AuthEnv) {
  return Boolean(env.BETTER_AUTH_URL && env.BETTER_AUTH_SECRET && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function unavailable(c: Context<AppBindings>) {
  return c.json({ error: { code: "AUTH_NOT_CONFIGURED", message: "Sign-in is temporarily unavailable." } }, 503);
}

app.onError((error, c) => {
  // Do not log request headers, tokens, OAuth codes, or provider responses.
  console.error("API request failed", error.name);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Unable to complete the request." } }, 500);
});

export default app;
