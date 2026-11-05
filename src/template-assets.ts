import { Hono } from "hono";
import type { AppBindings, AppEnv } from "./env";
import { MediaError, publicOrigin, serveMedia } from "./media";

const prefix = "templates/24k-magic/v3";
export const cruiseClipKeys = {
  opening: `${prefix}/01-deck-dance.mp4`,
  finale: `${prefix}/02-reaction-and-duet.mp4`,
};
export const cruiseAudioKey = `${prefix}/reference-audio.m4a`;

export const fixedMediaPath = "/api/template-media/fixed/24k-magic/v3";
const lifetimeSeconds = 24 * 60 * 60;
const encoder = new TextEncoder();
type Clip = keyof typeof cruiseClipKeys;

function signingKey(env: AppEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) throw new Error("Missing signing key");
  return crypto.subtle.importKey("raw", encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function signatureInput(clip: Clip, expires: string) {
  return encoder.encode(`provider-read\n${fixedMediaPath}/${clip}\n${expires}`);
}

export async function resolveCruiseAssets(env: AppEnv): Promise<{ opening: string; finale: string }> {
  try {
    const origin = publicOrigin(env);
    const objects = await Promise.all([cruiseClipKeys.opening, cruiseClipKeys.finale, cruiseAudioKey].map(key => env.MEDIA.head(key)));
    if (objects.some(object => !object?.size)) throw new Error("Missing template asset");
    const key = await signingKey(env);
    const expires = String(Math.floor(Date.now() / 1000) + lifetimeSeconds);
    async function providerUrl(clip: Clip) {
      const bytes = await crypto.subtle.sign("HMAC", key, signatureInput(clip, expires));
      const url = new URL(`${fixedMediaPath}/${clip}`, origin);
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
fixedMediaRoutes.on(["GET", "HEAD"], "/:clip", async (c) => {
  const clip = c.req.param("clip");
  const expires = c.req.query("expires") ?? "";
  const signature = c.req.query("signature") ?? "";
  const now = Math.floor(Date.now() / 1000);
  if ((clip !== "opening" && clip !== "finale") || !/^\d{10}$/.test(expires) ||
    Number(expires) <= now || !/^[0-9a-f]{64}$/.test(signature)) return c.notFound();

  const key = await signingKey(c.env);
  const mac = Uint8Array.from(signature.match(/../g)!, byte => Number.parseInt(byte, 16));
  if (!await crypto.subtle.verify("HMAC", key, mac, signatureInput(clip, expires))) return c.notFound();

  const objectKey = cruiseClipKeys[clip];
  const metadata = await c.env.MEDIA.head(objectKey);
  if (!metadata) return c.notFound();
  return serveMedia(c, { object_key: objectKey, content_type: "video/mp4", byte_size: metadata.size });
});
