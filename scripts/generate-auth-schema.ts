import { mkdir, writeFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { getPlatformProxy } from "wrangler";
import { createAuth, type AuthEnv } from "../src/auth";

// Use the same SQL generator as Better Auth CLI, without its config loader.
// The CLI config loader cannot import this Wrangler version's Miniflare dependency.
const name = process.argv[2] || "0001_auth.sql";
if (!/^\d+_[a-z0-9_-]+\.sql$/.test(name)) throw new Error("Use a migration filename such as 0002_auth.sql");
const platform = await getPlatformProxy<AuthEnv>({ remoteBindings: false });
try {
  const auth = createAuth({
    ...platform.env,
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "schema-generation-only-not-a-runtime-secret",
    GOOGLE_CLIENT_ID: "schema-generation-only",
    GOOGLE_CLIENT_SECRET: "schema-generation-only",
  });
  const { compileMigrations } = await getMigrations(auth.options);
  const sql = await compileMigrations();
  if (!sql.trim() || sql.trim() === ";") {
    console.log("Local D1 schema already matches the auth configuration.");
  } else {
    await mkdir("migrations", { recursive: true });
    await writeFile(`migrations/${name}`, `-- Generated from Better Auth 1.7.14 configuration.\n${sql}\n`, { flag: "wx" });
    console.log(`Generated migrations/${name}; review before applying.`);
  }
} finally {
  await platform.dispose();
}
