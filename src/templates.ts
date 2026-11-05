import { Hono } from "hono";
import type { AppBindings } from "./env";
import { publicOrigin } from "./media";
import { cruisePauseMessage, isCruiseClipPaused } from "./template-assets";

// Retain the original default when hashing retries of jobs created with version 1.
export const cruisePromptV1 = "Make a live-action dance comedy using the selected duration and framing. Cast the person in Image 1 as the sole performer. Keep their facial proportions, hair, skin tone, build and visible clothing consistent across cuts. Use Video 1 to guide the dance rhythm and body mechanics, without copying the reference performer's identity. Open inside a ship's doorway: a proud smile and a brief collar adjustment, hands near the neck. Then cut outside to a sunlit cruise deck and show a full-body sideways groove. Move to a low view of the shoes for a short sliding step and a small kick. Return to a wider view near the deck stairs for loose arm movements, bent knees and a side lunge, ending in a confident pose. Fit the sequence to the requested duration; simplify the cuts when time is short. Keep the playful swagger and believable weight shifts. Recompose each shot for the selected output framing, keeping the complete body visible in wide shots. Use consistent daylight and stable camera positions. Follow the reference audio rhythm where available. No spoken dialogue, extra performers, text or logos. Preserve identity and clothing in every shot; avoid malformed limbs and feet moving through the deck.";

export const cruiseTemplateVersion = 3;
export const cruisePromptV2 = [
  "Make a live-action cruise-deck dance comedy. Use Image 1 for the dancer's face, skin tone and hairstyle. Use Image 2 for the partner's face, skin tone and hairstyle. Use Video 1 for wardrobe, movement, blocking and camera timing.",
  "The dancer wears a bright yellow coverall, blue gloves and a respirator with pink filters. Open on the dancer smiling and lifting the respirator, then show the dancer's crossing steps on deck.",
  "The partner wears a pale yellow shirt, black tie and glasses. Show the partner leaning in the doorway while the dancer moves in the background. Follow the partner's reaction, then the dancer's kick and split beside the white blanket.",
  "End on both people together. The dancer from Image 1 keeps dancing on the left. The partner from Image 2 smiles from under the white blanket in the right foreground. Keep each identity consistent through cuts, distance changes and partial occlusion. Fit the actions to the selected duration and framing.",
].join(" ");

const cast = "Cast two distinct people throughout the clip. Use Image 1 for the face, skin tone and hairstyle of A, the deck dancer. A wears a bright yellow coverall, blue gloves, brown boots and a respirator with pink filters at the neck. Use Image 2 for the face, skin tone and hairstyle of B, the partner in a pale yellow shirt, glasses and black tie, later wrapped in a white blanket. Use Video 1 for their costumes, movement, props, blocking, framing, focus and cut timing. Follow each person across cuts, including when one becomes small, turns away or is partly hidden. Keep A matched to Image 1 and B to Image 2 whenever either face is visible. Preserve the reference depth, natural occlusion and horizontal framing.";
export const scenePrompts = {
  opening: cast + " Open on A smiling and lifting the respirator with both blue gloves. Match the smile and visible face to Image 1. Cut to the deck dance, the boots crossing close to camera, then the low wide view beside the stairs. In the corridor shot, B enters through the left door, stops and leans against the wall. Match B to Image 2 as soon as B appears. A is still dancing far behind B on the deck. Preserve that distance through the last corridor frame.",
  finale: cast + " Open close on B resting the head against one hand. Use Image 2 for B and keep the distant dancer A matched to Image 1. Follow the glance, the insert of the red emergency case and the cut back to B lifting both fists. By the funnel, A runs, kicks and drops into a split beside the white blanket. In the closing two-shot, A dances on the left behind B. B smiles from under the blanket in the right foreground. Show the Image 1 dancer and the Image 2 partner together through the final frame. Keep the blanket edge in front of B where it covers the face.",
};

export const templateRoutes = new Hono<AppBindings>();
templateRoutes.get("/24k-magic", (c) => {
  let uploadsPublic = false;
  const templatePaused = isCruiseClipPaused(c.env, "opening") || isCruiseClipPaused(c.env, "finale");
  try { publicOrigin(c.env); uploadsPublic = true; } catch { /* Local uploads remain available for preview. */ }
  return c.json({
    userId: c.get("userId"),
    template: {
      id: "24k-magic", name: "24K Magic Cruise Dance", version: cruiseTemplateVersion,
      duration: 26.554, resolution: "720p", aspectRatio: "4:3",
    },
    capabilities: {
      generationEnabled: Boolean(c.env.SEEAPI_API_KEY) && uploadsPublic && !templatePaused, uploadsPublic, templatePaused,
      reason: templatePaused ? cruisePauseMessage : !c.env.SEEAPI_API_KEY ? "The video provider is not configured."
        : !uploadsPublic ? "Video generation is not available in this environment." : undefined,
    },
  });
});
