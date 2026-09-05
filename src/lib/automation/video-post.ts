import { mutate, read } from "../db";
import { checkWebhookUrl } from "../events/bus";
import { uid } from "../ids";
import { validateUpload } from "../media/store";
import {
  FIELDS,
  LIMITS,
  MAX_IMAGE_BYTES,
  MAX_REFERENCE_PHOTOS,
  N8N_PLATFORMS,
  VIDEO_FORM_URL_SETTING,
  YES_NO,
  isN8nPlatform,
  type N8nPlatform,
  type N8nSubmission,
  type YesNo,
} from "./types";

/**
 * VIDEO POSTING — validation and the submission log.
 *
 * The browser never talks to n8n directly. It posts here, this checks the
 * submission, and the route forwards it server-side. Two reasons, both
 * structural rather than stylistic: the workflow URL is a capability (anyone
 * holding it can inject a post into the operator's YouTube channel), so it must
 * not be shipped to a browser; and an n8n Form endpoint sends no CORS headers,
 * so a direct fetch from the page would fail opaquely with nothing useful to
 * show the person who just waited out a 400 MB upload.
 */

/** How many rows the operator's history keeps. Matches the delivery log's shape. */
const MAX_SUBMISSION_LOG = 200;

/** The configured workflow URL, or "" when the setting is unset or blank. */
export function videoFormUrl(): string {
  return (process.env[VIDEO_FORM_URL_SETTING] ?? "").trim();
}

/**
 * Why the forward cannot be attempted, or null when it can.
 *
 * The URL goes through the same `checkWebhookUrl` the subscriber registry uses.
 * It arrives from the environment rather than from a request, so this is not
 * guarding against a hostile submitter — it is guarding against a typo that
 * would otherwise send the video, and the Drive/Telegram material with it, over
 * plaintext http or at a host on the deployment's own private network.
 */
export function videoFormUrlProblem(): string | null {
  const url = videoFormUrl();
  if (!url) {
    return `No n8n workflow URL is configured. Set ${VIDEO_FORM_URL_SETTING} to your workflow's form or webhook URL and restart the app.`;
  }
  const problem = checkWebhookUrl(url);
  return problem ? `${VIDEO_FORM_URL_SETTING} is not usable: ${problem}` : null;
}

/* -------------------------------------------------------------------------- */
/* Field validation                                                           */
/* -------------------------------------------------------------------------- */

export interface VideoPostFields {
  title: string;
  description: string;
  thumbnailText: string;
  extraInstructions: string;
  platforms: N8nPlatform[];
  driveFolder: string;
  createFolder: YesNo;
  publicLink: YesNo;
  telegramChatId: string;
}

export type FieldResult = { ok: true; fields: VideoPostFields } | { ok: false; error: string };

function text(form: FormData, name: string, max: number): string {
  const v = form.get(name);
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

/**
 * Read the non-file half of the form.
 *
 * Platforms are accepted either as repeated parts (what a checkbox group posts)
 * or as one comma-separated value (what n8n itself uses), because this endpoint
 * is reachable by anything holding `marketing.publish`, not only by our own
 * page, and rejecting the shape the downstream system speaks would be perverse.
 */
export function readFields(form: FormData): FieldResult {
  const title = text(form, FIELDS.title, LIMITS.title);
  if (!title) return { ok: false, error: `${FIELDS.title} is required.` };

  const description = text(form, FIELDS.description, LIMITS.description);
  if (!description) return { ok: false, error: `${FIELDS.description} is required.` };

  const rawPlatforms = form
    .getAll(FIELDS.platforms)
    .flatMap((v) => (typeof v === "string" ? v.split(",") : []))
    .map((v) => v.trim())
    .filter(Boolean);

  const platforms: N8nPlatform[] = [];
  for (const p of rawPlatforms) {
    if (!isN8nPlatform(p)) {
      return { ok: false, error: `Unknown platform "${p.slice(0, 40)}". Choose from: ${N8N_PLATFORMS.join(", ")}.` };
    }
    // Deduplicated, or a double-submitted checkbox posts the same video twice.
    if (!platforms.includes(p)) platforms.push(p);
  }
  if (!platforms.length) return { ok: false, error: `Choose at least one platform under "${FIELDS.platforms}".` };

  const createFolderRaw = text(form, FIELDS.createFolder, 8).toLowerCase() || "yes";
  const publicLinkRaw = text(form, FIELDS.publicLink, 8).toLowerCase() || "no";
  for (const [label, value] of [
    [FIELDS.createFolder, createFolderRaw],
    [FIELDS.publicLink, publicLinkRaw],
  ] as const) {
    if (!(YES_NO as readonly string[]).includes(value)) {
      return { ok: false, error: `"${label}" must be yes or no.` };
    }
  }

  return {
    ok: true,
    fields: {
      title,
      description,
      thumbnailText: text(form, FIELDS.thumbnailText, LIMITS.thumbnailText),
      extraInstructions: text(form, FIELDS.extraInstructions, LIMITS.extraInstructions),
      platforms,
      driveFolder: text(form, FIELDS.driveFolder, LIMITS.driveFolder),
      createFolder: createFolderRaw as YesNo,
      publicLink: publicLinkRaw as YesNo,
      telegramChatId: text(form, FIELDS.telegramChatId, LIMITS.telegramChatId),
    },
  };
}

export type FileCheck = { ok: true; mime: string } | { ok: false; error: string };

/**
 * Confirm the video is a video from its own bytes.
 *
 * `validateUpload` already refuses an unknown container and an oversized file;
 * the extra `kind` check exists because it happily accepts a JPEG, and a JPEG
 * forwarded as the "Video File" would fail deep inside somebody else's workflow
 * — after the upload, the Drive folder and the thumbnail run had all happened.
 */
export function checkVideo(bytes: Buffer): FileCheck {
  const verdict = validateUpload(bytes);
  if ("error" in verdict) return { ok: false, error: `${FIELDS.video}: ${verdict.error}` };
  if (verdict.kind !== "video") return { ok: false, error: `${FIELDS.video} must be a video — MP4, MOV or WebM.` };
  // The detected type is handed back rather than discarded so the forwarded part
  // carries the container we proved, not the one the browser claimed.
  return { ok: true, mime: verdict.mime };
}

/** Same, for the thumbnail and the reference photos, which must be stills. */
export function checkImage(label: string, bytes: Buffer): FileCheck {
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `${label}: ${(bytes.byteLength / 1048576).toFixed(1)} MB is over the ${MAX_IMAGE_BYTES / 1048576} MB image limit.`,
    };
  }
  const verdict = validateUpload(bytes);
  if ("error" in verdict) return { ok: false, error: `${label}: ${verdict.error}` };
  if (verdict.kind !== "image") return { ok: false, error: `${label} must be an image — JPEG, PNG or WebP.` };
  return { ok: true, mime: verdict.mime };
}

export function checkReferenceCount(n: number): string | null {
  return n > MAX_REFERENCE_PHOTOS
    ? `${FIELDS.referencePhotos}: at most ${MAX_REFERENCE_PHOTOS} photos.`
    : null;
}

/* -------------------------------------------------------------------------- */
/* Submission log                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Record the attempt before it is made.
 *
 * Deliberately not "record the result afterwards": the forward can take minutes
 * with a large file, and a crash or a redeploy in the middle would otherwise
 * erase all trace of a video that n8n may well have received and published.
 */
export function openSubmission(input: { by: string; title: string; platforms: N8nPlatform[] }): N8nSubmission {
  const row: N8nSubmission = {
    id: uid("n8nsub"),
    at: new Date().toISOString(),
    by: input.by,
    title: input.title,
    platforms: input.platforms,
    status: "queued",
  };
  mutate((d) => {
    d.n8nSubmissions = [...(d.n8nSubmissions ?? []), row].slice(-MAX_SUBMISSION_LOG);
  });
  return row;
}

export function settleSubmission(
  id: string,
  patch: { status: N8nSubmission["status"]; n8nStatus?: number; error?: string },
): N8nSubmission | null {
  return mutate((d) => {
    const row = (d.n8nSubmissions ?? []).find((s) => s.id === id);
    if (!row) return null;
    row.status = patch.status;
    row.n8nStatus = patch.n8nStatus;
    row.error = patch.error;
    return row;
  });
}

/** Newest first. */
export function recentSubmissions(limit = 25): N8nSubmission[] {
  return (read().n8nSubmissions ?? []).slice(-limit).reverse();
}
