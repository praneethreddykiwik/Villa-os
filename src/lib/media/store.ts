import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * MARKETING MEDIA STORE
 *
 * Video and images destined for publishing live in the private `marketing-media`
 * bucket, with one row per object in `media_assets`. Nothing here is public: a
 * reel reaches Instagram by being handed to the Graph API, not by sitting at a
 * guessable URL, so the bucket stays private and reads go through a signed URL
 * that expires.
 *
 * Everything runs through the *anon* client carrying the caller's session, so
 * RLS decides what may be written. `media_assets_write` (migration 0005) admits
 * either `construction.upload` or `marketing.publish` — the site engineer
 * uploading progress photos and the marketing lead uploading a reel are
 * different people with different grants and both legitimately upload.
 */

export const BUCKET = "marketing-media";

/** Hard ceiling. Instagram itself rejects a reel over 1GB; we stop far earlier. */
export const MAX_BYTES = 512 * 1024 * 1024;

/**
 * Accepted types, keyed by the magic bytes that actually prove them.
 *
 * The browser-supplied `type` on a File is attacker-controlled and a filename
 * extension proves nothing, so both are treated as hints and the container is
 * confirmed from the leading bytes before anything is stored.
 */
interface TypeSpec {
  kind: "video" | "image";
  mime: string;
  ext: string;
  /** Returns true when the buffer's header matches this container. */
  match(head: Buffer): boolean;
}

const TYPES: TypeSpec[] = [
  {
    kind: "video",
    mime: "video/mp4",
    ext: "mp4",
    // ISO-BMFF: bytes 4..8 are "ftyp". Covers mp4 and the m4v/mov family below.
    match: (h) => h.length > 12 && h.subarray(4, 8).toString("latin1") === "ftyp",
  },
  {
    kind: "video",
    mime: "video/quicktime",
    ext: "mov",
    match: (h) =>
      h.length > 12 &&
      h.subarray(4, 8).toString("latin1") === "ftyp" &&
      h.subarray(8, 12).toString("latin1").startsWith("qt"),
  },
  {
    kind: "video",
    mime: "video/webm",
    ext: "webm",
    match: (h) => h.length > 4 && h.readUInt32BE(0) === 0x1a45dfa3,
  },
  {
    kind: "image",
    mime: "image/jpeg",
    ext: "jpg",
    match: (h) => h.length > 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,
  },
  {
    kind: "image",
    mime: "image/png",
    ext: "png",
    match: (h) => h.length > 8 && h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    kind: "image",
    mime: "image/webp",
    ext: "webp",
    match: (h) =>
      h.length > 12 &&
      h.subarray(0, 4).toString("latin1") === "RIFF" &&
      h.subarray(8, 12).toString("latin1") === "WEBP",
  },
];

export interface DetectedType {
  kind: "video" | "image";
  mime: string;
  ext: string;
}

/**
 * Identify the file from its own bytes.
 *
 * `quicktime` is checked before the generic mp4 rule would swallow it, because
 * both are ISO-BMFF and only the brand at offset 8 separates them.
 */
export function detectType(head: Buffer): DetectedType | null {
  const mov = TYPES.find((t) => t.ext === "mov")!;
  if (mov.match(head)) return { kind: mov.kind, mime: mov.mime, ext: mov.ext };
  const hit = TYPES.find((t) => t.match(head));
  return hit ? { kind: hit.kind, mime: hit.mime, ext: hit.ext } : null;
}

export interface ValidationFailure {
  error: string;
}

export function validateUpload(bytes: Buffer): DetectedType | ValidationFailure {
  if (bytes.byteLength === 0) return { error: "The file is empty." };
  if (bytes.byteLength > MAX_BYTES) {
    return { error: `That file is ${(bytes.byteLength / 1048576).toFixed(0)} MB. The limit is ${MAX_BYTES / 1048576} MB.` };
  }
  const type = detectType(bytes.subarray(0, 16));
  if (!type) {
    return { error: "Unsupported file. Upload MP4, MOV, WebM, JPEG, PNG or WebP." };
  }
  return type;
}

export interface Dimensions {
  width: number;
  height: number;
  durationSec?: number;
}

/**
 * Real dimensions, probed rather than assumed.
 *
 * The aspect-ratio validation and the ffmpeg crop both depend on knowing the
 * true frame size; storing a guess here produces a reel that is silently
 * letterboxed at publish time. Video goes through ffprobe (ffmpeg is already a
 * dependency of the render pipeline); images go through sharp.
 *
 * Returns zeroes when the probe is unavailable — the caller records that as
 * "unknown" rather than inventing a 1080x1920.
 */
export async function probeDimensions(bytes: Buffer, type: DetectedType): Promise<Dimensions> {
  if (type.kind === "image") {
    try {
      const sharp = (await import("sharp")).default;
      const meta = await sharp(bytes).metadata();
      return { width: meta.width ?? 0, height: meta.height ?? 0 };
    } catch {
      return { width: 0, height: 0 };
    }
  }

  // ffprobe needs a seekable file; a pipe fails on moov-at-end MP4s.
  const tmp = path.join(os.tmpdir(), `probe_${crypto.randomUUID()}.${type.ext}`);
  try {
    await fs.promises.writeFile(tmp, bytes);
    const out = spawnSync(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0",
       "-show_entries", "stream=width,height:format=duration",
       "-of", "json", tmp],
      { encoding: "utf8" },
    );
    if (out.status !== 0) return { width: 0, height: 0 };
    const parsed = JSON.parse(out.stdout) as {
      streams?: Array<{ width?: number; height?: number }>;
      format?: { duration?: string };
    };
    const s = parsed.streams?.[0];
    const duration = Number(parsed.format?.duration);
    return {
      width: s?.width ?? 0,
      height: s?.height ?? 0,
      durationSec: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : undefined,
    };
  } catch {
    return { width: 0, height: 0 };
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

/**
 * Object key.
 *
 * Partitioned by org so one tenant's prefix is never another's, and named with
 * a random id rather than the uploaded filename — the original name is kept in
 * the row, where it cannot collide, be guessed, or carry a path separator.
 */
export function storageKey(orgId: string, ext: string): string {
  return `${orgId}/${crypto.randomUUID()}.${ext}`;
}

export interface StoredMedia {
  id: string;
  storagePath: string;
  kind: "video" | "image";
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: string;
}

/**
 * Upload the object, then record it.
 *
 * In that order, and with the row removed if the insert fails: an orphaned
 * object costs storage, but an orphaned row points the Studio at a file that is
 * not there, which surfaces as a broken render much later and much less
 * obviously.
 */
export async function putMedia(
  sb: SupabaseClient,
  args: {
    orgId: string;
    uploaderId: string;
    bytes: Buffer;
    type: DetectedType;
    filename: string;
    dimensions: Dimensions;
    projectId?: string | null;
    tags?: string[];
  },
): Promise<StoredMedia> {
  const key = storageKey(args.orgId, args.type.ext);

  const up = await sb.storage.from(BUCKET).upload(key, args.bytes, {
    contentType: args.type.mime,
    upsert: false,
  });
  if (up.error) throw new Error(`Storage upload failed: ${up.error.message}`);

  const { data, error } = await sb
    .from("media_assets")
    .insert({
      org_id: args.orgId,
      storage_path: key,
      kind: args.type.kind,
      filename: args.filename,
      mime_type: args.type.mime,
      size_bytes: args.bytes.byteLength,
      width: args.dimensions.width || null,
      height: args.dimensions.height || null,
      project_id: args.projectId ?? null,
      uploaded_by: args.uploaderId,
      tags: args.tags ?? [],
    })
    .select("id, storage_path, kind, filename, mime_type, size_bytes, width, height, created_at")
    .single();

  if (error || !data) {
    // Do not leave the object behind pointing at nothing.
    await sb.storage.from(BUCKET).remove([key]).catch(() => {});
    throw new Error(`Could not record the upload: ${error?.message ?? "no row returned"}`);
  }

  return {
    id: data.id as string,
    storagePath: data.storage_path as string,
    kind: data.kind as "video" | "image",
    filename: data.filename as string,
    mimeType: data.mime_type as string,
    sizeBytes: Number(data.size_bytes ?? 0),
    width: Number(data.width ?? 0),
    height: Number(data.height ?? 0),
    createdAt: data.created_at as string,
  };
}

/**
 * A time-limited read URL. The bucket is private, so this is the only way the
 * browser (or a platform API fetching the file) can read the object, and the
 * link stops working when it expires.
 */
export async function signedUrl(sb: SupabaseClient, storagePath: string, expiresInSeconds = 3600): Promise<string | null> {
  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(storagePath, expiresInSeconds);
  return error ? null : data.signedUrl;
}

export async function listMedia(sb: SupabaseClient, orgId: string, limit = 100): Promise<StoredMedia[]> {
  const { data, error } = await sb
    .from("media_assets")
    .select("id, storage_path, kind, filename, mime_type, size_bytes, width, height, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((d) => ({
    id: d.id as string,
    storagePath: d.storage_path as string,
    kind: d.kind as "video" | "image",
    filename: d.filename as string,
    mimeType: d.mime_type as string,
    sizeBytes: Number(d.size_bytes ?? 0),
    width: Number(d.width ?? 0),
    height: Number(d.height ?? 0),
    createdAt: d.created_at as string,
  }));
}
