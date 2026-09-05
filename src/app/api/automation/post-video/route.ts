import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { actorLabel, requirePermission } from "@/lib/auth/session";
import { logActivity } from "@/lib/engine/publisher";
import { read, resolveBrandId } from "@/lib/db";
import { rateLimit } from "@/lib/ops/ratelimit";
import { FIELDS, MAX_TOTAL_BYTES, type N8nSubmission } from "@/lib/automation/types";
import {
  checkImage,
  checkReferenceCount,
  checkVideo,
  openSubmission,
  readFields,
  settleSubmission,
  videoFormUrl,
  videoFormUrlProblem,
} from "@/lib/automation/video-post";

/**
 * HAND A VIDEO TO THE OPERATOR'S n8n WORKFLOW.
 *
 * The browser posts the form here; this validates it and forwards it, as
 * multipart, to the configured workflow URL. The page never holds that URL.
 * Anyone who has it can push a video onto the business's YouTube channel
 * without signing in to anything, so it stays server-side — and n8n form
 * endpoints send no CORS headers anyway, which would turn a direct browser
 * POST into an opaque failure after a several-hundred-megabyte upload.
 *
 * `marketing.publish`, not `marketing.read`: this ends in something public
 * appearing on four networks under the brand's name.
 */

export const runtime = "nodejs";

/** Bodies here are video-sized; the default execution window is far too short. */
export const maxDuration = 300;

/**
 * How long to wait on the workflow.
 *
 * Longer than the event bus's ten seconds because this request *is* the upload —
 * n8n cannot answer until the last byte has crossed — but still bounded, or a
 * stalled workflow holds a request, its memory and the operator's browser tab
 * open indefinitely.
 */
const FORWARD_TIMEOUT_MS = 180_000;

/** Read a File part, or undefined when it was left empty. */
function filePart(form: FormData, name: string): File | undefined {
  const v = form.get(name);
  return v instanceof File && v.size > 0 ? v : undefined;
}

export async function POST(req: Request) {
  let submission: N8nSubmission | null = null;

  try {
    const session = await requirePermission("marketing.publish");

    // A forward costs an inbound upload and an equally large outbound one, and
    // each accepted submission is a post that goes public. Tight and per-account.
    const limit = rateLimit(`automation:post-video:${session.userId}`, {
      max: 12,
      windowSeconds: 3600,
      lockoutSeconds: 900,
    });
    if (!limit.allowed) {
      return apiFail(`Too many video submissions. Try again in ${limit.retryAfterSeconds ?? 900} seconds.`, 429);
    }

    // Checked before a byte is read. Refusing after the upload has been accepted
    // wastes the operator's entire wait on a request that could never have been
    // delivered, and "it seemed to work" is the one outcome this must never give.
    const configProblem = videoFormUrlProblem();
    if (configProblem) return apiFail(configProblem, 503);

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return apiFail("Send the submission as multipart/form-data.", 415);
    }

    // The declared length is a hint the client controls, so the real sizes are
    // summed below as well. It is still worth checking: an honest client that is
    // over the cap learns so without uploading half a gigabyte first.
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
      return apiFail(
        `That submission is ${(declared / 1048576).toFixed(0)} MB. The limit is ${MAX_TOTAL_BYTES / 1048576} MB in total.`,
        413,
      );
    }

    const form = await req.formData();

    const parsed = readFields(form);
    if (!parsed.ok) return apiFail(parsed.error, 400);
    const fields = parsed.fields;

    const video = filePart(form, FIELDS.video);
    if (!video) return apiFail(`${FIELDS.video} is required.`, 400);

    const references = form.getAll(FIELDS.referencePhotos).filter((f): f is File => f instanceof File && f.size > 0);
    const countProblem = checkReferenceCount(references.length);
    if (countProblem) return apiFail(countProblem, 400);

    const finalThumbnail = filePart(form, FIELDS.finalThumbnail);

    const total = video.size + (finalThumbnail?.size ?? 0) + references.reduce((n, f) => n + f.size, 0);
    if (total > MAX_TOTAL_BYTES) {
      return apiFail(
        `That submission is ${(total / 1048576).toFixed(0)} MB. The limit is ${MAX_TOTAL_BYTES / 1048576} MB in total.`,
        413,
      );
    }

    // Every file is confirmed from its own leading bytes. The browser's declared
    // MIME type and the extension are both attacker-chosen, and this endpoint
    // forwards whatever it accepts into a workflow that will hand it to Google
    // Drive, YouTube and a Telegram chat — so it must not be a way to push an
    // arbitrary file through the operator's own credentials.
    /**
     * Only the first bytes are read to prove the container.
     *
     * `await video.arrayBuffer()` pulled the entire upload into memory, and the
     * Blob rebuilt from it below copied every one of those bytes a second time —
     * so a 500 MB reel briefly needed a gigabyte of heap, per concurrent upload.
     * The magic-byte check never needed more than the header, and the File itself
     * is already a streamable Blob that can be appended straight to the outbound
     * body without a copy.
     */
    const videoHead = Buffer.from(await video.slice(0, 64).arrayBuffer());
    const videoCheck = checkVideo(videoHead);
    if (!videoCheck.ok) return apiFail(videoCheck.error, 415);

    let thumbnail: { file: File; mime: string; name: string } | undefined;
    if (finalThumbnail) {
      const check = checkImage(FIELDS.finalThumbnail, Buffer.from(await finalThumbnail.slice(0, 64).arrayBuffer()));
      if (!check.ok) return apiFail(check.error, 415);
      thumbnail = { file: finalThumbnail, mime: check.mime, name: finalThumbnail.name.slice(0, 200) || "thumbnail" };
    }

    const referenceFiles: Array<{ file: File; mime: string; name: string }> = [];
    for (const photo of references) {
      const check = checkImage(FIELDS.referencePhotos, Buffer.from(await photo.slice(0, 64).arrayBuffer()));
      if (!check.ok) return apiFail(check.error, 415);
      referenceFiles.push({ file: photo, mime: check.mime, name: photo.name.slice(0, 200) || "reference" });
    }

    /**
     * Rebuild the multipart body rather than streaming the original through.
     *
     * The parts that reach n8n are then exactly the ones named in the workflow's
     * contract and nothing else: no extra field an unofficial client tacked on,
     * no file under a name the form does not know, and every text value already
     * trimmed to its ceiling.
     */
    const outbound = new FormData();
    outbound.append(FIELDS.title, fields.title);
    outbound.append(FIELDS.description, fields.description);
    outbound.append(FIELDS.thumbnailText, fields.thumbnailText);
    outbound.append(FIELDS.extraInstructions, fields.extraInstructions);
    // n8n's own form sends a multi-checkbox field as one comma-separated value,
    // so that is the shape the workflow's downstream nodes already split on.
    outbound.append(FIELDS.platforms, fields.platforms.join(","));
    outbound.append(FIELDS.driveFolder, fields.driveFolder);
    outbound.append(FIELDS.createFolder, fields.createFolder);
    outbound.append(FIELDS.publicLink, fields.publicLink);
    outbound.append(FIELDS.telegramChatId, fields.telegramChatId);
    // Each part is re-typed from the container we proved rather than from the
    // browser's claim, so a workflow node that branches on content type branches
    // on something that was actually verified.
    // The File is appended directly. `.slice(0)` re-types it to the container we
    // proved without copying the bytes — a Blob slice is a view, not a duplicate.
    outbound.append(
      FIELDS.video,
      video.slice(0, video.size, videoCheck.mime),
      video.name.slice(0, 200) || "video.mp4",
    );
    if (thumbnail) {
      outbound.append(
        FIELDS.finalThumbnail,
        thumbnail.file.slice(0, thumbnail.file.size, thumbnail.mime),
        thumbnail.name,
      );
    }
    for (const ref of referenceFiles) {
      outbound.append(FIELDS.referencePhotos, ref.file.slice(0, ref.file.size, ref.mime), ref.name);
    }

    // Recorded before the forward, so a crash or a redeploy mid-upload leaves a
    // `queued` row. "We do not know whether n8n received this" is a true and
    // useful statement; no row at all is neither.
    submission = openSubmission({
      by: actorLabel(session),
      title: fields.title,
      platforms: fields.platforms,
    });

    const url = videoFormUrl();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        body: outbound,
        signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
        // A 30x would re-point a video, and whatever credentials the workflow
        // path itself represents, at a host the operator never configured.
        redirect: "manual",
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : "The workflow could not be reached.";
      settleSubmission(submission.id, { status: "failed", error });
      return apiFail(`n8n could not be reached: ${error}`, 502);
    }

    /**
     * A redirect counts as accepted, and is still not followed.
     *
     * An n8n Form trigger answers a completed submission with its completion
     * page, and a workflow configured with a "redirect on completion" URL
     * answers 3xx instead of 200. Treating that as a failure would record a
     * video that was in fact received — and published — as one that never
     * arrived. Following it is the part that stays refused: the redirect target
     * is chosen by the response, not by the operator, so honouring it would send
     * the whole upload to an address nobody configured.
     */
    const accepted = res.ok || (res.status >= 300 && res.status < 400);
    if (!accepted) {
      const error = `The workflow answered ${res.status}.`;
      settleSubmission(submission.id, { status: "failed", n8nStatus: res.status, error });
      return apiFail(
        `${error} Nothing was posted — check the workflow's execution log in n8n.`,
        502,
      );
    }

    const settled = settleSubmission(submission.id, { status: "forwarded", n8nStatus: res.status }) ?? submission;
    // Past this point the hand-off happened. Clearing the handle keeps the
    // catch below from re-labelling a delivered video as failed because
    // something downstream of the forward — the activity log, say — threw.
    submission = null;

    const brandId = resolveBrandId(read(), null);
    if (brandId) {
      logActivity(brandId, "integrations", `Video "${fields.title}" sent to n8n for ${fields.platforms.join(", ")}`, actorLabel(session));
    }

    return apiOk({ submission: settled });
  } catch (e) {
    // A fault after the row was opened must not leave it reading "queued"
    // forever — that would claim an unknown outcome for something that
    // demonstrably never left this process.
    if (submission) {
      try {
        settleSubmission(submission.id, { status: "failed", error: "The submission failed before it was forwarded." });
      } catch {
        /* the log is diagnostics; losing a line must not change the response */
      }
    }
    return apiError(e);
  }
}
