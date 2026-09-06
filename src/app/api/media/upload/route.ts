import { cookies } from "next/headers";
import { serverClient } from "@/lib/supabase/client";
import { requirePermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { rateLimit } from "@/lib/ops/ratelimit";
import { MAX_BYTES, listMedia, probeDimensions, putMedia, signedUrl, validateUpload, STORAGE_SRC_PREFIX } from "@/lib/media/store";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { uid } from "@/lib/ids";

/**
 * MEDIA UPLOAD
 *
 * The gap this fills: the Studio could render an edit and the publisher could
 * post one, but nothing could get a file into the library in the first place —
 * `media` was populated exclusively by the generated seed. With the seed gone,
 * uploading is the only way media exists at all, so this is the front door of
 * the whole publishing pipeline.
 *
 * Uploads run as the caller through the anon client, so `media_assets_write`
 * and the bucket policy decide what is allowed rather than this handler
 * deciding for them. `marketing.publish` is required up front regardless,
 * because a 403 from Postgres after a 500 MB body has been read is a waste of
 * everyone's bandwidth.
 */

export const runtime = "nodejs";

/** Bodies are large; Next's default parse limit does not apply to FormData reads. */
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const session = await requirePermission("marketing.publish");

    // An upload is expensive to serve. One misbehaving client should not be able
    // to fill the bucket, so the limit is per-account and deliberately tight.
    const limit = rateLimit(`media:upload:${session.userId}`, {
      max: 30,
      windowSeconds: 300,
      lockoutSeconds: 300,
    });
    if (!limit.allowed) {
      return apiFail(`Too many uploads. Try again in ${limit.retryAfterSeconds ?? 300} seconds.`, 429);
    }

    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart/form-data")) {
      return apiFail("Send the file as multipart/form-data.", 415);
    }

    // `req.formData()` buffers the whole body before `file.size` can be read, so
    // the declared length is checked first. A client can lie about it, which is
    // why the real size is still checked below — but an honest 2 GB upload is
    // refused here instead of after it has been held in memory.
    const declared = Number(req.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > MAX_BYTES + 1024 * 1024) {
      return apiFail(`That upload is ${(declared / 1048576).toFixed(0)} MB. The limit is ${MAX_BYTES / 1048576} MB.`, 413);
    }

    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return apiFail("No file received. Attach it as the `file` field.", 400);
    }

    // Check the declared size before reading the body into memory.
    if (file.size > MAX_BYTES) {
      return apiFail(`That file is ${(file.size / 1048576).toFixed(0)} MB. The limit is ${MAX_BYTES / 1048576} MB.`, 413);
    }

    const bytes = Buffer.from(await file.arrayBuffer());

    // The browser's declared MIME type and the extension are both hints. The
    // container is confirmed from the leading bytes before anything is stored.
    const verdict = validateUpload(bytes);
    if ("error" in verdict) return apiFail(verdict.error, 415);

    const dimensions = await probeDimensions(bytes, verdict);

    const cookieStore = await cookies();
    const sb = serverClient(cookieStore);

    const rawTags = form.get("tags");
    const tags =
      typeof rawTags === "string" && rawTags.trim()
        ? rawTags.split(",").map((t) => t.trim().slice(0, 40)).filter(Boolean).slice(0, 20)
        : [];

    const projectId = typeof form.get("projectId") === "string" ? String(form.get("projectId")) : null;

    const asset = await putMedia(sb, {
      orgId: session.orgId,
      uploaderId: session.userId,
      bytes,
      type: verdict,
      // Keep the operator's filename for display only — the object key is random.
      filename: file.name.slice(0, 200) || `upload.${verdict.ext}`,
      dimensions,
      projectId,
      tags,
    });

    /**
     * Register the upload in the JSON store as well.
     *
     * The object and its row live in Supabase, but the Studio, the Composer and
     * the render pipeline all read `db.media`. Writing only to Supabase meant a
     * video uploaded successfully and then appeared nowhere — the publishing
     * pipeline was severed at its first joint. This mirrors the record across
     * until those three read from Postgres directly.
     *
     * `src` holds the storage path behind a scheme rather than a signed URL,
     * because a signed URL expires in an hour and the render pipeline needs to
     * read the file again days later.
     */
    const db = read();
    const brandId = resolveBrandId(db, null);
    mutate((d) => {
      d.media.push({
        id: asset.id,
        brandId,
        kind: asset.kind,
        src: `${STORAGE_SRC_PREFIX}${asset.storagePath}`,
        width: asset.width,
        height: asset.height,
        durationSec: dimensions.durationSec,
        renders: {},
        createdAt: asset.createdAt,
        tags,
      });
    });

    return apiOk({
      asset: {
        ...asset,
        durationSec: dimensions.durationSec,
        url: await signedUrl(sb, asset.storagePath),
      },
    });
  } catch (e) {
    return apiError(e);
  }
}

/** The library, newest first, with a signed URL per object so it can be previewed. */
export async function GET() {
  try {
    const session = await requirePermission("marketing.read");
    const cookieStore = await cookies();
    const sb = serverClient(cookieStore);

    const assets = await listMedia(sb, session.orgId);
    const withUrls = await Promise.all(
      assets.map(async (a) => ({ ...a, url: await signedUrl(sb, a.storagePath) })),
    );
    return apiOk({ assets: withUrls });
  } catch (e) {
    return apiError(e);
  }
}
