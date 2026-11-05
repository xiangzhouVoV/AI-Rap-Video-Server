import { Hono } from "hono";
import type { AppBindings } from "./env";
import { publicOrigin } from "./media";

export const cruisePrompt = "Make a live-action dance comedy using the selected duration and framing. Cast the person in Image 1 as the sole performer. Keep their facial proportions, hair, skin tone, build and visible clothing consistent across cuts. Use Video 1 to guide the dance rhythm and body mechanics, without copying the reference performer's identity. Open inside a ship's doorway: a proud smile and a brief collar adjustment, hands near the neck. Then cut outside to a sunlit cruise deck and show a full-body sideways groove. Move to a low view of the shoes for a short sliding step and a small kick. Return to a wider view near the deck stairs for loose arm movements, bent knees and a side lunge, ending in a confident pose. Fit the sequence to the requested duration; simplify the cuts when time is short. Keep the playful swagger and believable weight shifts. Recompose each shot for the selected output framing, keeping the complete body visible in wide shots. Use consistent daylight and stable camera positions. Follow the reference audio rhythm where available. No spoken dialogue, extra performers, text or logos. Preserve identity and clothing in every shot; avoid malformed limbs and feet moving through the deck.";

export const templateRoutes = new Hono<AppBindings>();
templateRoutes.get("/24k-magic", (c) => {
  let uploadsPublic = false;
  try { publicOrigin(c.env); uploadsPublic = true; } catch { /* Local uploads remain available for preview. */ }
  return c.json({
    userId: c.get("userId"),
    template: {
      id: "24k-magic", name: "24K Magic Cruise Dance", version: 1, prompt: cruisePrompt,
      model: "seedance-2", duration: 10, resolution: "720p", aspectRatio: "9:16", generateAudio: true,
      referenceVideoUrl: c.env.TEMPLATE_REFERENCE_VIDEO_URL || null,
    },
    capabilities: {
      generationEnabled: Boolean(c.env.SEEAPI_API_KEY), uploadsPublic,
      reason: !c.env.SEEAPI_API_KEY ? "The video provider is not configured."
        : !uploadsPublic ? "Local uploads need a public HTTPS media origin. Use direct HTTPS media links for local generation, or configure MEDIA_PUBLIC_BASE_URL." : undefined,
    },
  });
});
