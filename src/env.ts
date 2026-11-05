import type { AuthEnv } from "./auth";

export type AppEnv = AuthEnv & Pick<Env, "MEDIA" | "IMAGES"> & {
  SEEAPI_API_KEY?: string;
  SEEAPI_API_BASE_URL?: string;
  MEDIA_PUBLIC_BASE_URL?: string;
  TEMPLATE_DEBUG_EMAILS?: string;
  TEMPLATE_REFERENCE_VIDEO_URL?: string;
};

export type AppBindings = { Bindings: AppEnv; Variables: { userId: string } };

export function canDebugTemplates(env: AppEnv, email: string) {
  const host = new URL(env.BETTER_AUTH_URL).hostname;
  if (host === "localhost" || host === "127.0.0.1") return true;
  return (env.TEMPLATE_DEBUG_EMAILS ?? "").split(",").map((value) => value.trim().toLowerCase()).filter(Boolean).includes(email.toLowerCase());
}
