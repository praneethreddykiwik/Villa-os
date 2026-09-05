/**
 * THE VIDEO-POSTING WORKFLOW CONTRACT
 *
 * The operator already runs an n8n workflow fronted by an n8n Form node: it
 * takes a video plus thumbnail material, renders and reviews the thumbnail, and
 * fans the video out to YouTube, Instagram, Facebook and X. This module is the
 * single written-down copy of that form's contract — field names, the platform
 * catalogue, and the ceilings we enforce before anything leaves the building.
 *
 * The field *names* are the form's own labels, verbatim, because that is what an
 * n8n Form trigger keys its incoming multipart parts on. Renaming one here to
 * something tidier (`videoTitle`, say) would produce a request n8n accepts with
 * a 200 and then silently drops every value from — the worst possible failure,
 * since the submitter is told it worked.
 *
 * Nothing here imports the store or the media probe, so the browser bundle can
 * use the same constants the server validates against and the form can never
 * offer a platform the server would reject.
 */

/** Exactly the checkboxes the workflow offers, spelled the way it spells them. */
export const N8N_PLATFORMS = ["YouTube", "Instagram", "Facebook", "X (Twitter)"] as const;
export type N8nPlatform = (typeof N8N_PLATFORMS)[number];

export function isN8nPlatform(v: unknown): v is N8nPlatform {
  return typeof v === "string" && (N8N_PLATFORMS as readonly string[]).includes(v);
}

/**
 * Multipart part names. Used by the browser form, by the API route that
 * validates it, and by the request forwarded to n8n — one vocabulary end to end,
 * so a rename cannot half-land.
 */
export const FIELDS = {
  video: "Video File",
  finalThumbnail: "Final Thumbnail",
  referencePhotos: "Thumbnail Reference Photos",
  title: "Video Title",
  description: "Video Description",
  thumbnailText: "Thumbnail Text",
  extraInstructions: "Extra Thumbnail Instructions",
  platforms: "Which Platforms to Post To",
  driveFolder: "Google Drive Folder Name",
  createFolder: "Create the folder if it does not exist?",
  publicLink: "Enable Anyone with link can view on the Drive folder?",
  telegramChatId: "Telegram Chat ID for thumbnail review",
} as const;

/** The two-option selects. Sent as the literal strings the workflow branches on. */
export const YES_NO = ["yes", "no"] as const;
export type YesNo = (typeof YES_NO)[number];

/** The AI thumbnail step takes at most three faces/products to feature. */
export const MAX_REFERENCE_PHOTOS = 3;

/** A reference photo or a finished thumbnail is a still image, not a master. */
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

/**
 * Ceiling on the whole multipart body.
 *
 * The video alone is bounded by the media store's own limit; this bounds the
 * sum, so four attachments each just under their individual cap cannot combine
 * into a body that has to be held in memory twice — once to validate, once to
 * forward.
 */
export const MAX_TOTAL_BYTES = 576 * 1024 * 1024;

/** Text ceilings. Generous, but a text field is an unbounded body without one. */
export const LIMITS = {
  title: 200,
  description: 5_000,
  thumbnailText: 200,
  extraInstructions: 1_000,
  driveFolder: 200,
  telegramChatId: 64,
} as const;

/**
 * One attempt to hand a video to the workflow.
 *
 * Written *before* the forward and settled after, so a process that dies
 * mid-upload leaves a `queued` row rather than no row: "we do not know whether
 * n8n got this" is a true statement, and silence is not.
 */
export interface N8nSubmission {
  id: string;
  at: string;
  /** Who submitted it — email, per `actorLabel`. */
  by: string;
  title: string;
  platforms: N8nPlatform[];
  status: "queued" | "forwarded" | "failed";
  /** The HTTP status the workflow answered with, when it answered at all. */
  n8nStatus?: number;
  /** Why it failed. Present whenever `status` is "failed". */
  error?: string;
}

/**
 * The environment setting holding the workflow's form/webhook URL.
 *
 * Named as a constant because three separate places have to tell the operator
 * which setting to fill in — the API refusal, the screen, and `.env.example` —
 * and a refusal that says "no URL is configured" without naming the setting
 * sends somebody hunting through the codebase.
 */
export const VIDEO_FORM_URL_SETTING = "N8N_VIDEO_FORM_URL";

/** The header the inbound endpoint authenticates with. Its value is never shown. */
export const INBOUND_SECRET_HEADER = "x-n8n-secret";

/** Where n8n POSTs back into this system. */
export const INBOUND_PATH = "/api/webhooks/n8n";
