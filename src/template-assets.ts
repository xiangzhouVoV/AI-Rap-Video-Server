import { Hono } from "hono";
import type { AppBindings, AppEnv } from "./env";
import { MediaError, publicOrigin, serveMedia } from "./media";

const prefix = "templates/24k-magic";
function clipKeys(directory: string) {
  return {
    opening: `${directory}/01-deck-dance.mp4`,
    finale: `${directory}/02-reaction-and-duet.mp4`,
  };
}
const legacyClipKeys = clipKeys(prefix + "/v3");
const v3ClipKeys = clipKeys(prefix + "/v3/720p");
export const cruiseClipKeys = { opening: prefix + "/v4/opening.mp4", finale: prefix + "/v4/finale.mp4" };
export const cruiseAudioKey = prefix + "/v4/reference-audio.m4a";
export const cruiseTemplateVersion = 4;

export const fixedMediaPath = "/api/template-media/fixed/24k-magic";
const lifetimeSeconds = 24 * 60 * 60;
const encoder = new TextEncoder();
const specifications = {
  3: {
    clipKeys: v3ClipKeys, audioKey: prefix + "/v3/reference-audio.m4a", path: fixedMediaPath + "/v3/720p",
    aspectRatio: "4:3", cut: 13.7, duration: 26.554, providerSeconds: 15,
  },
  4: {
    clipKeys: cruiseClipKeys, audioKey: cruiseAudioKey, path: fixedMediaPath + "/v4",
    aspectRatio: "16:9", cut: 302 / 30, duration: 605 / 30, providerSeconds: 11,
  },
};

export function cruiseSpec(version: number) {
  if (version !== 3 && version !== 4) throw new Error("Unknown template version");
  return specifications[version];
}

export type Clip = keyof typeof cruiseClipKeys;

export const cruisePauseMessage = "Generation is paused for this template pending approval. You can check again later.";

export function isCruiseClipPaused(env: AppEnv, scene: Clip, version = cruiseTemplateVersion) {
  // The retired opening was rejected by the provider. Keep it on hold even if the active hold changes.
  if (version === 3 && scene === "opening") return true;
  return env.CRUISE_PAUSED_CLIP_KEY === cruiseSpec(version).clipKeys[scene];
}

export function currentCruiseClipPath(scene: Clip, version = cruiseTemplateVersion) {
  return `${cruiseSpec(version).path}/${scene}`;
}

function signingKey(env: AppEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("Missing signing key");
  return crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function signatureInput(path: string, expires: string) {
  return encoder.encode(`provider-read\n${path}\n${expires}`);
}

export async function resolveCruiseAssets(env: AppEnv, version = cruiseTemplateVersion): Promise<{ opening: string; finale: string }> {
  try {
    const origin = publicOrigin(env);
    const { clipKeys, audioKey } = cruiseSpec(version);
    const objects = await Promise.all([clipKeys.opening, clipKeys.finale, audioKey].map(key => env.MEDIA.head(key)));
    if (objects.some(object => !object?.size)) throw new Error("Missing template asset");
    const key = await signingKey(env);
    const expires = String(Math.floor(Date.now() / 1000) + lifetimeSeconds);
    async function providerUrl(clip: Clip) {
      const url = new URL(currentCruiseClipPath(clip, version), origin);
      const bytes = await crypto.subtle.sign("HMAC", key, signatureInput(url.pathname, expires));
      url.searchParams.set("expires", expires);
      url.searchParams.set("signature", Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join(""));
      return url.href;
    }
    const [opening, finale] = await Promise.all([providerUrl("opening"), providerUrl("finale")]);
    return { opening, finale };
  } catch {
    throw new MediaError(503, "TEMPLATE_UNAVAILABLE", "This template is temporarily unavailable. Please try again later.");
  }
}

export const fixedMediaRoutes = new Hono<AppBindings>();
fixedMediaRoutes.on(["GET", "HEAD"], ["/v3/:clip", "/v3/720p/:clip", "/v4/:clip"], async (c) => {
  const clip = c.req.param("clip");
  const expires = c.req.query("expires") ?? "";
  const signature = c.req.query("signature") ?? "";
  const now = Math.floor(Date.now() / 1000);
  if ((clip !== "opening" && clip !== "finale") || !/^\d{10}$/.test(expires) ||
    Number(expires) <= now || !/^[0-9a-f]{64}$/.test(signature)) return c.notFound();

  const key = await signingKey(c.env);
  const mac = Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, mac, signatureInput(c.req.path, expires))) return c.notFound();

  // Pending provider tasks may still read a previously issued, revisionless URL.
  const keys = c.req.path === `${fixedMediaPath}/v3/${clip}` ? legacyClipKeys
    : c.req.path === currentCruiseClipPath(clip, 3) ? v3ClipKeys : cruiseClipKeys;
  const objectKey = keys[clip];
  const metadata = await c.env.MEDIA.head(objectKey);
  if (!metadata) return c.notFound();
  return serveMedia(c, { object_key: objectKey, content_type: "video/mp4", byte_size: metadata.size });
});
