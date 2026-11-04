import { betterAuth } from "better-auth";

export type AuthEnv = Pick<Env, "DB"> & {
  BETTER_AUTH_URL: string;
  BETTER_AUTH_SECRET: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
};

export function createAuth(env: AuthEnv) {
  const origin = new URL(env.BETTER_AUTH_URL);
  const local = origin.hostname === "localhost" || origin.hostname === "127.0.0.1";
  if (origin.origin !== env.BETTER_AUTH_URL || (!local && origin.protocol !== "https:")) {
    throw new Error("BETTER_AUTH_URL must be an HTTPS origin (HTTP is allowed on localhost).");
  }
  if (env.BETTER_AUTH_SECRET.length < 32 || !env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error("Google OAuth credentials and a 32-character auth secret are required.");
  }

  return betterAuth({
    appName: "airaptovideo",
    baseURL: origin.origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin.origin],
    emailAndPassword: { enabled: false },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        accessType: "online",
        prompt: "select_account",
      },
    },
    session: { cookieCache: { enabled: false } },
    // Persist rate limits across Worker isolates instead of using in-memory counters.
    rateLimit: { enabled: true, storage: "database" },
    advanced: {
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: origin.protocol === "https:",
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax" },
    },
  });
}
