import { Hono } from "hono";
import type { AppBindings } from "./env";
import { publicOrigin } from "./media";
import { cruisePauseMessage, cruiseSpec, cruiseTemplateVersion, cruiseTrialVersion, isCruiseClipPaused } from "./template-assets";

// Retain the original default when hashing retries of jobs created with version 1.
export const cruisePromptV1 = "Make a live-action dance comedy using the selected duration and framing. Cast the person in Image 1 as the sole performer. Keep their facial proportions, hair, skin tone, build and visible clothing consistent across cuts. Use Video 1 to guide the dance rhythm and body mechanics, without copying the reference performer's identity. Open inside a ship's doorway: a proud smile and a brief collar adjustment, hands near the neck. Then cut outside to a sunlit cruise deck and show a full-body sideways groove. Move to a low view of the shoes for a short sliding step and a small kick. Return to a wider view near the deck stairs for loose arm movements, bent knees and a side lunge, ending in a confident pose. Fit the sequence to the requested duration; simplify the cuts when time is short. Keep the playful swagger and believable weight shifts. Recompose each shot for the selected output framing, keeping the complete body visible in wide shots. Use consistent daylight and stable camera positions. Follow the reference audio rhythm where available. No spoken dialogue, extra performers, text or logos. Preserve identity and clothing in every shot; avoid malformed limbs and feet moving through the deck.";

export const cruisePromptV2 = [
  "Make a live-action cruise-deck dance comedy. Use Image 1 for the dancer's face, skin tone and hairstyle. Use Image 2 for the partner's face, skin tone and hairstyle. Use Video 1 for wardrobe, movement, blocking and camera timing.",
  "The dancer wears a bright yellow coverall, blue gloves and a respirator with pink filters. Open on the dancer smiling and lifting the respirator, then show the dancer's crossing steps on deck.",
  "The partner wears a pale yellow shirt, black tie and glasses. Show the partner leaning in the doorway while the dancer moves in the background. Follow the partner's reaction, then the dancer's kick and split beside the white blanket.",
  "End on both people together. The dancer from Image 1 keeps dancing on the left. The partner from Image 2 smiles from under the white blanket in the right foreground. Keep each identity consistent through cuts, distance changes and partial occlusion. Fit the actions to the selected duration and framing.",
].join(" ");

const cast = "Cast two distinct people throughout the clip. Use Image 1 for the face, skin tone and hairstyle of A, the deck dancer. A wears a bright yellow coverall, blue gloves, brown boots and a respirator with pink filters at the neck. Use Image 2 for the face, skin tone and hairstyle of B, the partner in a pale yellow shirt, glasses and black tie, later wrapped in a white blanket. Use Video 1 for their costumes, movement, props, blocking, framing, focus and cut timing. Follow each person across cuts, including when one becomes small, turns away or is partly hidden. Keep A matched to Image 1 and B to Image 2 whenever either face is visible. Preserve the reference depth, natural occlusion and horizontal framing.";
export const legacyScenePrompts = {
  opening: cast + " Open on A smiling and lifting the respirator with both blue gloves. Match the smile and visible face to Image 1. Cut to the deck dance, the boots crossing close to camera, then the low wide view beside the stairs. In the corridor shot, B enters through the left door, stops and leans against the wall. Match B to Image 2 as soon as B appears. A is still dancing far behind B on the deck. Preserve that distance through the last corridor frame.",
  finale: cast + " Open close on B resting the head against one hand. Use Image 2 for B and keep the distant dancer A matched to Image 1. Follow the glance, the insert of the red emergency case and the cut back to B lifting both fists. By the funnel, A runs, kicks and drops into a split beside the white blanket. In the closing two-shot, A dances on the left behind B. B smiles from under the blanket in the right foreground. Show the Image 1 dancer and the Image 2 partner together through the final frame. Keep the blanket edge in front of B where it covers the face.",
};

const cartoonCast = "Recreate the cartoon choreography as a live-action scene on a bright ship deck. Cast the person in Image 1 as the magenta-hooded dancer and the person in Image 2 as the human reacting in the doorway. Preserve each photo subject's facial features, hair and natural human proportions. Use Video 1 to match camera positions, cuts, dance steps and the relative positions of the two roles. Translate the bear's performance into human posture, hands and expressions for the Image 2 actor. Keep the wide horizontal framing.";
export const scenePrompts = {
  opening: cartoonCast + " This opening follows the Image 1 dancer. Frame the hands clapping beside the face, then the turn and the stepping feet. Cut low to the footwork, then wide as the dancer performs by the deck stairs. Follow the changes of camera angle and the movement in Video 1. Keep the doorway partner offscreen throughout this opening.",
  finale: cartoonCast + " Open at the corridor doorway: the Image 2 partner steps out from the left, leans against the wall and watches. The Image 1 dancer continues moving far away by the railing. Match the partner's close-up reaction, the brief red emergency case insert, and the return to the partner raising both hands at the end.",
};

const trialCast = "Use Image 1 as the deck dancer in the black leather jacket and Image 2 as the doorway partner in the backwards cap. Preserve the face, hair and skin tone of each photo subject in every shot. Follow Video 1 for wardrobe, blocking, camera distance, cuts and pace, including movement in the background. Keep the warm evening light and wide horizontal composition.";
export const trialScenePrompts = {
  opening: trialCast + " Open on the dancer smiling. Raise both hands separately with the fingers loosely curled, one hand just beneath each side of the jaw. Tilt the head slightly and hold for one beat, with space between the hands throughout; no clapping. Cut wide for the cross-steps, low for the sliding boots, then wide again for the bent-knee groove by the stairs. In the passage, the partner comes out of the left doorway and leans against the wall with one hand at the temple. Keep the dancer moving far behind the partner. End in the partner's close-up against the ocean.",
  finale: trialCast + " Continue the doorway close-up: the partner looks sideways, cut to the red emergency cabinet and back to the partner raising both fists. Return outdoors to the ship's funnel. The partner peeks out of the white duvet as the dancer kicks and drops into a wide split with legs extended across the deck. In the following two-shot the dancer keeps stepping on the left and the bundled partner bobs in the right foreground. Play the last gag: the same partner pops up inside the white vent with the red tube, followed by the final exterior cut. Preserve the shot order and each role through the last frame.",
};

export const templateRoutes = new Hono<AppBindings>();
templateRoutes.get("/24k-magic", (c) => {
  const requested = c.req.query("version") ?? String(cruiseTemplateVersion);
  if (requested !== String(cruiseTemplateVersion) && requested !== String(cruiseTrialVersion)) return c.notFound();
  const version = Number(requested);
  let uploadsPublic = false;
  const { duration, aspectRatio } = cruiseSpec(version);
  const templatePaused = isCruiseClipPaused(c.env, "opening", version) || isCruiseClipPaused(c.env, "finale", version);
  try { publicOrigin(c.env); uploadsPublic = true; } catch { /* Local uploads remain available for preview. */ }
  return c.json({
    userId: c.get("userId"),
    template: {
      id: "24k-magic", name: "24K Magic Cruise Dance", version,
      duration, resolution: "720p", aspectRatio,
    },
    capabilities: {
      generationEnabled: Boolean(c.env.SEEAPI_API_KEY) && uploadsPublic && !templatePaused, uploadsPublic, templatePaused,
      reason: templatePaused ? cruisePauseMessage : !c.env.SEEAPI_API_KEY ? "The video provider is not configured."
        : !uploadsPublic ? "Video generation is not available in this environment." : undefined,
    },
  });
});
