import {
  DRIVER,
  baseValidate,
  mockPublish,
  type PlatformAdapter,
  type PublishRequest,
  type PublishResult,
} from "./types";

/**
 * The remaining networks. Capabilities + validation are fully real everywhere
 * (that is what the composer enforces). `publish` is live for the adapters with
 * a real implementation below and mock-driven for the rest, whose live call
 * shape is documented inline so turning one on is a contained change.
 *
 * `rateLimit` reports the network's published daily cap with zero consumed: the
 * cap is a real platform constant, but how much of it this account has spent is
 * only knowable from the live API, and inventing a number would put a fictional
 * figure into the publisher's defer messages.
 */

/* -------------------------------------------------------------------------- */
/* TikTok — Content Posting API v2                                            */
/* -------------------------------------------------------------------------- */

const TIKTOK_API = "https://open.tiktokapis.com/v2";

/**
 * TikTok pulls the file itself and then transcodes, so the wait is a download
 * plus an encode rather than just an encode. Two minutes of polling covers a
 * normal reel; past that we stop rather than hold the worker open forever.
 */
const TIKTOK_POLL_ATTEMPTS = 30;
const TIKTOK_POLL_MS = 4000;

interface TikTokEnvelope {
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; log_id?: string };
}

/**
 * Every v2 endpoint answers with the same `{ data, error }` envelope, and a
 * failure can arrive as HTTP 200 with `error.code` set — so the status line
 * alone never proves the call worked and both are checked. The thrown error
 * carries TikTok's own code so `tiktokRetryable` can classify it rather than
 * string-matching a message.
 */
async function tiktokPost(path: string, token: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${TIKTOK_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      // TikTok documents the charset on this header explicitly; a bare
      // application/json is rejected by the publish endpoints.
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  let json: TikTokEnvelope;
  try {
    json = (await res.json()) as TikTokEnvelope;
  } catch {
    // A gateway page instead of JSON is an infrastructure blip, not a rejection.
    throw Object.assign(new Error(`TikTok ${res.status}: response was not JSON`), {
      status: res.status,
      transient: true,
    });
  }

  const code = json.error?.code ?? "";
  if (!res.ok || (code && code !== "ok")) {
    throw Object.assign(new Error(`TikTok ${code || res.status}: ${json.error?.message ?? `HTTP ${res.status}`}`), {
      status: res.status,
      code,
    });
  }
  return json.data ?? {};
}

/**
 * Network faults, 5xx and TikTok's own throttles are worth another attempt. A
 * rejected token, an unverified pull domain or a video TikTok will not accept
 * are configuration, and retrying them just burns the attempt budget.
 */
function tiktokRetryable(e: unknown): boolean {
  const err = e as { status?: number; code?: string; transient?: boolean };
  if (err.transient) return true;
  if (err.status === 429 || (err.status ?? 0) >= 500) return true;
  // Neither field set means `fetch` itself rejected — DNS, TLS, socket.
  if (err.status === undefined && err.code === undefined) return true;
  return ["rate_limit_exceeded", "spam_risk_too_many_posts", "internal_error"].includes(err.code ?? "");
}

/**
 * TikTok Direct Post is init-then-poll:
 *   1. POST /v2/post/publish/video/init/   -> returns a publish_id, after which
 *      TikTok fetches the file itself from `video_url` (PULL_FROM_URL).
 *   2. POST /v2/post/publish/status/fetch/ -> poll that publish_id until it
 *      reports PUBLISH_COMPLETE.
 *
 * Two things sink this integration in practice and neither is visible in the
 * code path: the app needs the `video.publish` scope and an approved audit
 * (an unaudited app can only post SELF_ONLY), and PULL_FROM_URL only accepts a
 * host whose ownership was verified in the developer console. A raw Supabase
 * signed URL is on an unverified domain and is refused at step 1 with
 * `url_ownership_unverified` — a setup error, which is why it is not retried.
 */
async function tiktokPublish(req: PublishRequest): Promise<PublishResult> {
  const token = req.connection.accessToken;
  if (!token) {
    return { ok: false, error: "TikTok connection has no access token — reconnect the account.", retryable: false };
  }

  // TikTok fetches the video from this URL, so it must be absolute and readable
  // from the public internet. A relative render path would resolve to nothing on
  // TikTok's side, so it is refused here instead of initialising an empty post.
  const videoUrl = req.mediaUrls[0] ?? "";
  if (!/^https:\/\//i.test(videoUrl)) {
    return {
      ok: false,
      error: `TikTok pulls the video over HTTPS from a verified domain; this post carries ${videoUrl ? `"${videoUrl}"` : "no media URL"}.`,
      retryable: false,
    };
  }

  // There is no separate caption field: `title` is the whole description and
  // hashtags live inside it as plain text, the same as typing them in the app.
  const title = [req.caption, req.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  let publishId: string;
  try {
    const init = await tiktokPost("/post/publish/video/init/", token, {
      post_info: {
        title,
        // Required by Direct Post, and deliberately not a constant: an unaudited
        // app may only publish SELF_ONLY and a private account refuses
        // PUBLIC_TO_EVERYONE, so the operator declares what their app is cleared
        // for. The default fails loudly rather than quietly posting in private.
        privacy_level: process.env.TIKTOK_PRIVACY_LEVEL ?? "PUBLIC_TO_EVERYONE",
      },
      source_info: { source: "PULL_FROM_URL", video_url: videoUrl },
    });
    publishId = typeof init.publish_id === "string" ? init.publish_id : "";
    if (!publishId) {
      return { ok: false, error: "TikTok returned no publish_id for the upload.", retryable: true };
    }
  } catch (e) {
    return { ok: false, error: (e as Error).message, retryable: tiktokRetryable(e) };
  }

  /**
   * Past this line the video is already with TikTok, and a retry would re-run
   * init — a new publish_id, a second copy of the same video, and no externalId
   * recorded for the publisher to dedupe against. So a poll that never resolves
   * is reported as permanent with the publish_id in the message: an operator can
   * check one id by hand, but nobody can un-post a duplicate.
   */
  let lastError = `TikTok did not reach PUBLISH_COMPLETE within ${(TIKTOK_POLL_ATTEMPTS * TIKTOK_POLL_MS) / 1000}s`;

  for (let i = 0; i < TIKTOK_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, TIKTOK_POLL_MS));

    let status: Record<string, unknown>;
    try {
      status = await tiktokPost("/post/publish/status/fetch/", token, { publish_id: publishId });
    } catch (e) {
      lastError = (e as Error).message;
      // A blip while polling says nothing about the publish; keep asking until
      // the attempts run out. A hard rejection will not change, so stop early.
      if (tiktokRetryable(e)) continue;
      break;
    }

    const state = String(status.status ?? "");
    if (state === "PUBLISH_COMPLETE") {
      // TikTok's own field name is misspelled in the API; the corrected spelling
      // is read as well in case that is ever fixed underneath us.
      const ids = status.publicaly_available_post_id ?? status.publicly_available_post_id;
      const postId = Array.isArray(ids) && ids.length ? String(ids[0]) : "";

      // TikTok returns ids, never a URL. A watch link can only be assembled from
      // the creator's @username, and the connection stores whatever user/info
      // gave at connect time — which is a display name for most accounts. So a
      // link is offered only when the stored handle really is a @username;
      // otherwise the id goes back on its own rather than a URL that would 404.
      const handle = req.connection.handle?.trim() ?? "";
      const permalink =
        postId && /^@[A-Za-z0-9._]{1,24}$/.test(handle)
          ? `https://www.tiktok.com/${handle}/video/${postId}`
          : undefined;

      return { ok: true, externalId: postId || publishId, ...(permalink ? { permalink } : {}) };
    }
    if (state === "FAILED") {
      return {
        ok: false,
        error: `TikTok rejected the video: ${String(status.fail_reason ?? "no reason given")}`,
        retryable: false,
      };
    }
  }

  return { ok: false, error: `${lastError} (publish_id ${publishId})`, retryable: false };
}

export const tiktok: PlatformAdapter = {
  channel: "tiktok",
  label: "TikTok",
  color: "#00F2EA",
  capabilities: {
    formats: ["reel", "story"],
    captionLimit: 2200,
    hashtagLimit: 30,
    maxMedia: 1,
    supportsStories: false,
    supportsFirstComment: false,
    supportsNativeScheduling: false,
    supportsStickers: false,
    videoMaxSec: { reel: 600 },
    aspectRatios: { reel: ["9:16"] },
  },
  validate: (req) => baseValidate(req, tiktok.capabilities, "TikTok"),
  publish: async (req) => (DRIVER === "mock" ? mockPublish("tiktok", req) : tiktokPublish(req)),
  rateLimit: async () => ({ used: 0, quota: 15, windowHours: 24 }),
};

/* -------------------------------------------------------------------------- */
/* YouTube                                                                     */
/* -------------------------------------------------------------------------- */

const YT_UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";
const YT_API = "https://www.googleapis.com/youtube/v3";

/** Every YouTube response is read defensively: an HTML 502 from a proxy is not JSON. */
async function ytJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  try {
    return (JSON.parse(text) || {}) as Record<string, unknown>;
  } catch {
    return { error: { message: text.slice(0, 300) || `YouTube ${res.status}` } };
  }
}

/**
 * Google's error envelope is `{ error: { code, message, errors: [{ reason }] } }`.
 * The `reason` is what distinguishes a quota refusal from a malformed request,
 * so it is carried onto the Error rather than being flattened into the message.
 */
function ytError(status: number, body: Record<string, unknown>): Error {
  const err = body.error as
    | { message?: string; errors?: Array<{ reason?: string }> }
    | undefined;
  return Object.assign(new Error(err?.message ?? `YouTube ${status}`), {
    status,
    reason: err?.errors?.[0]?.reason,
  });
}

/** 429 / 5xx and Google's own throttling reasons clear on their own; a 400 will not. */
function ytRetryable(e: unknown): boolean {
  const err = e as { status?: number; reason?: string; retryable?: boolean };
  if (err.retryable === true) return true;
  if (err.status === 429 || (err.status ?? 0) >= 500) return true;
  // A thrown fetch — DNS failure, ECONNRESET, TLS error, or the socket dying
  // part-way through PUTting a large file — carries no status and no reason.
  // That is the most likely failure of this adapter, and treating it as
  // permanent marks the post dead on a blip it would survive on retry.
  if (err.status === undefined && err.reason === undefined) return true;
  // quotaExceeded/uploadLimitExceeded are daily budgets rather than bad input —
  // the publisher's backoff is the right answer, not marking the post failed.
  return [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "quotaExceeded",
    "uploadLimitExceeded",
    "backendError",
    "internalError",
  ].includes(err.reason ?? "");
}

/**
 * YouTube refuses `<` and `>` anywhere in a title or description (invalidTitle /
 * invalidDescription), so they are stripped and the text is clipped to the
 * platform's cap — losing the tail of a caption beats failing the upload.
 */
function ytText(raw: string, max: number): string {
  const clean = raw.replace(/[<>]/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}

/**
 * snippet.tags are keywords, not hashtags, so the `#` comes off. YouTube budgets
 * all tags against one 500-character allowance and rejects the whole insert when
 * it is blown, so the list is trimmed to fit instead.
 */
function ytTags(hashtags: string[]): string[] {
  const tags: string[] = [];
  let budget = 500;
  for (const raw of hashtags) {
    const tag = raw.replace(/^#/, "").trim();
    if (!tag) continue;
    // A tag containing a space is quoted by the API, and those quotes count.
    const cost = tag.length + 1 + (tag.includes(" ") ? 2 : 0);
    if (cost > budget) break;
    budget -= cost;
    tags.push(tag);
  }
  return tags;
}

/**
 * YouTube has no pull-from-URL ingest: unlike Meta it will not fetch the media
 * itself, the bytes have to be handed to it. So publishing is three steps:
 *   1. read the video from our signed storage URL,
 *   2. POST an upload session to /upload/youtube/v3/videos?uploadType=resumable
 *      carrying the metadata, which answers with a session URI in `Location`,
 *   3. PUT the bytes at that URI, which answers with the created video.
 *
 * Scheduling is native: a video with privacyStatus "private" plus status.publishAt
 * goes public by itself at that time. The pair is only honoured together — a
 * "public" video with publishAt publishes immediately — so both are set or neither.
 */
async function ytPublish(req: PublishRequest): Promise<PublishResult> {
  const token = req.connection.accessToken;
  if (!token) return { ok: false, error: "YouTube connection has no access token.", retryable: false };

  const source = req.mediaUrls[0];
  if (!source) return { ok: false, error: "YouTube needs a video file to upload.", retryable: false };

  // The title is the caption's first non-empty line: a whole caption as a title
  // reads as spam and would be cut at 100 characters anyway. There is no honest
  // fallback — snippet.title is required and inventing one would put words the
  // marketer never wrote on the channel — so an empty caption is a real error.
  const title = ytText(req.caption.split("\n").find((l) => l.trim()) ?? "", 100);
  if (!title) {
    return { ok: false, error: "YouTube needs a title — the caption is empty.", retryable: false };
  }
  // Hashtags live in the description on YouTube; the first three there also
  // surface above the title on the watch page.
  const hashtags = req.hashtags.map((h) => (h.startsWith("#") ? h : `#${h}`)).join(" ");
  const description = ytText([req.caption, hashtags].filter(Boolean).join("\n\n"), 5000);

  /**
   * `publishAt` only means anything in the future.
   *
   * The publisher dispatches a target once its scheduled time has *passed*
   * (dueTargets in src/lib/engine/publisher.ts), and then forwards that same
   * time here because YouTube advertises native scheduling. So the value that
   * arrives is always in the past by the time it arrives, and YouTube rejects a
   * past publishAt — meaning every scheduled upload failed and the first comment
   * below, gated on the same flag, was never posted either.
   *
   * A time that has already passed is what "publish now" means, so it is dropped
   * and the video goes public immediately. Only a genuinely future time is
   * forwarded as a scheduled release.
   */
  let publishAt: string | undefined;
  if (req.scheduledAt) {
    const when = new Date(req.scheduledAt);
    if (Number.isNaN(when.getTime())) {
      return { ok: false, error: `YouTube: "${req.scheduledAt}" is not a valid schedule time.`, retryable: false };
    }
    // A small margin: a release a few seconds out is racing the upload itself.
    if (when.getTime() > Date.now() + 60_000) publishAt = when.toISOString();
  }

  try {
    const src = await fetch(source, { cache: "no-store" });
    if (!src.ok) {
      throw Object.assign(new Error(`could not read the video from storage (HTTP ${src.status})`), {
        status: src.status,
      });
    }
    // Buffered rather than streamed on purpose: the resumable endpoint wants a
    // Content-Length, which fetch can only derive from a sized body. Shorts are
    // capped at 180s by `capabilities`, which keeps that bounded.
    const bytes = new Uint8Array(await src.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw Object.assign(new Error("the stored video is empty"), { status: 400 });
    }
    // Storage may label an upload application/octet-stream; YouTube documents
    // video/* as acceptable, which is safer than forwarding a wrong concrete type.
    const srcType = src.headers.get("content-type") ?? "";
    const contentType = srcType.startsWith("video/") ? srcType : "video/*";

    const initRes = await fetch(`${YT_UPLOAD}?uploadType=resumable&part=snippet,status`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        // Declared up front so an over-large or wrong-typed file is refused
        // before the bytes are spent on it.
        "x-upload-content-length": String(bytes.byteLength),
        "x-upload-content-type": contentType,
      },
      body: JSON.stringify({
        snippet: { title, description, tags: ytTags(req.hashtags) },
        status: {
          privacyStatus: publishAt ? "private" : "public",
          ...(publishAt ? { publishAt } : {}),
          // Required on API uploads since the 2020 COPPA change — the insert is
          // rejected without it. Villa marketing is not children's content.
          selfDeclaredMadeForKids: false,
        },
      }),
      cache: "no-store",
    });
    if (!initRes.ok) throw ytError(initRes.status, await ytJson(initRes));

    const session = initRes.headers.get("location");
    if (!session) {
      // An OK response with no session URI leaves nothing to upload to and
      // nothing to resume, so the only sane answer is to start over later.
      throw Object.assign(new Error("YouTube opened no upload session (no Location header)"), {
        retryable: true,
      });
    }

    const put = await fetch(session, {
      method: "PUT",
      // The session URI is pre-authorised, but the bearer is sent anyway so a
      // proxy that strips the upload_id still authenticates.
      headers: { authorization: `Bearer ${token}`, "content-type": contentType },
      body: bytes,
      cache: "no-store",
    });
    // 308 "Resume Incomplete" means only part of the file landed. Resuming needs
    // the session URI to outlive this call, which it does not, so the upload is
    // reported as retryable and starts fresh.
    if (put.status === 308) {
      throw Object.assign(new Error("YouTube accepted only part of the upload"), { retryable: true });
    }
    const created = await ytJson(put);
    if (!put.ok) throw ytError(put.status, created);

    const videoId = created.id ? String(created.id) : "";
    if (!videoId) {
      throw Object.assign(new Error("YouTube returned no video id"), { retryable: true });
    }
    // The file can be accepted and then refused (duplicate, claimed audio, too
    // long). That is final — re-uploading the same bytes fails the same way.
    const status = created.status as { uploadStatus?: string; rejectionReason?: string } | undefined;
    if (status?.uploadStatus === "rejected") {
      return {
        ok: false,
        error: `YouTube rejected the video: ${status.rejectionReason ?? "no reason given"}`,
        retryable: false,
      };
    }

    // The video is live from here on. A failed first comment must not report the
    // publish as failed, or the publisher retries and uploads a duplicate.
    if (req.firstComment && !publishAt) {
      try {
        await fetch(`${YT_API}/commentThreads?part=snippet`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            snippet: { videoId, topLevelComment: { snippet: { textOriginal: req.firstComment } } },
          }),
          cache: "no-store",
        });
      } catch {
        // Swallowed deliberately — see above.
      }
    }

    return { ok: true, externalId: videoId, permalink: `https://youtube.com/watch?v=${videoId}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message, retryable: ytRetryable(e) };
  }
}

export const youtube: PlatformAdapter = {
  channel: "youtube",
  label: "YouTube",
  color: "#FF0000",
  capabilities: {
    formats: ["short", "reel"],
    captionLimit: 5000,
    hashtagLimit: 15,
    maxMedia: 1,
    supportsStories: false,
    supportsFirstComment: true,
    supportsNativeScheduling: true,
    supportsStickers: false,
    videoMaxSec: { short: 180, reel: 180 },
    aspectRatios: { short: ["9:16"], reel: ["9:16"] },
  },
  validate: (req) => baseValidate(req, youtube.capabilities, "YouTube"),
  publish: async (req) => (DRIVER === "mock" ? mockPublish("youtube", req) : ytPublish(req)),
  rateLimit: async () => ({ used: 0, quota: 6, windowHours: 24 }),
};

/* -------------------------------------------------------------------------- */
/* LinkedIn — versioned Posts API (/rest)                                     */
/* -------------------------------------------------------------------------- */

const LINKEDIN_REST = "https://api.linkedin.com/rest";
const LINKEDIN_ATTEMPTS = 3;

/**
 * LinkedIn pins every request to a monthly version and retires each one after
 * roughly a year, so the version is deployment state rather than a constant — a
 * default left un-bumped is what turns a working integration into a 426 twelve
 * months from now. Override with LINKEDIN_API_VERSION.
 */
function linkedinVersion(): string {
  return process.env.LINKEDIN_API_VERSION ?? "202510";
}

/** 429 and 5xx are worth another attempt; a 4xx (dead token, bad URN, rejected asset) never will be. */
function linkedinRetryable(e: unknown): boolean {
  const err = e as { status?: number; retryable?: boolean };
  if (typeof err.retryable === "boolean") return err.retryable;
  // fetch itself threw — DNS, TLS, socket. Nothing reached LinkedIn, so retry.
  if (err.status === undefined) return true;
  return err.status === 429 || err.status >= 500;
}

/**
 * Creating the post is the one step that is not safe to repeat: a 5xx can mean
 * "written, then the response died", and a blind retry of that posts twice. So
 * the create only retries when the request demonstrably never landed.
 */
function linkedinCreateRetryable(e: unknown): boolean {
  const err = e as { status?: number };
  return err.status === undefined || err.status === 429;
}

/**
 * Bounded retry around one step. Which failures count is a parameter because an
 * upload that half-happened is discarded server-side, while a post that
 * half-happened is a post.
 */
async function linkedinAttempt<T>(step: () => Promise<T>, worthRetrying = linkedinRetryable): Promise<T> {
  let last: unknown;
  for (let i = 0; i < LINKEDIN_ATTEMPTS; i++) {
    try {
      return await step();
    } catch (e) {
      last = e;
      if (i === LINKEDIN_ATTEMPTS - 1 || !worthRetrying(e)) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

/**
 * One versioned REST call. A create answers with an empty body and returns the
 * new URN in `x-restli-id`, so the headers come back alongside the JSON.
 */
async function linkedinCall(
  path: string,
  init: { method: "GET" | "POST"; token: string; body?: unknown },
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${LINKEDIN_REST}/${path}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${init.token}`,
      "LinkedIn-Version": linkedinVersion(),
      // Without this the versioned endpoints answer in Rest.li 1.0 shapes.
      "X-Restli-Protocol-Version": "2.0.0",
      "content-type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });

  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { message: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    throw Object.assign(new Error(`LinkedIn: ${String(json.message ?? `HTTP ${res.status}`)}`), {
      status: res.status,
    });
  }
  return { json, headers: res.headers };
}

/**
 * Pull the object out of storage so it can be pushed to LinkedIn. Unlike Meta,
 * LinkedIn has no fetch-from-URL: the bytes travel through this process.
 */
async function linkedinDownload(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    // Retryable whatever the status: these are signed URLs and the next attempt
    // mints a fresh one, so an expiry here is not a permanent failure.
    throw Object.assign(new Error(`Could not read media for upload (HTTP ${res.status})`), {
      retryable: true,
    });
  }
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/**
 * Images: register, PUT the bytes at the URL you are handed, then reference the
 * returned `urn:li:image:` in the post. The URN exists from the initialize call
 * onward but only resolves once the upload completes.
 */
async function linkedinUploadImage(url: string, owner: string, token: string): Promise<string> {
  const { json } = await linkedinCall("images?action=initializeUpload", {
    method: "POST",
    token,
    body: { initializeUploadRequest: { owner } },
  });
  const value = (json.value ?? {}) as { uploadUrl?: string; image?: string };
  if (!value.uploadUrl || !value.image) {
    throw new Error("LinkedIn: image upload was initialized without an upload URL");
  }

  const media = await linkedinDownload(url);
  const put = await fetch(value.uploadUrl, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": media.contentType },
    body: media.bytes,
  });
  if (!put.ok) {
    throw Object.assign(new Error(`LinkedIn: image upload failed (HTTP ${put.status})`), {
      status: put.status,
    });
  }
  return value.image;
}

/**
 * Video is a multipart upload: initialize returns one upload URL per byte range,
 * each PUT answers with an ETag, and finalize is rejected unless it is given
 * every ETag in range order — which is why the parts are uploaded in sequence
 * rather than in parallel.
 */
async function linkedinUploadVideo(url: string, owner: string, token: string): Promise<string> {
  const media = await linkedinDownload(url);
  const { json } = await linkedinCall("videos?action=initializeUpload", {
    method: "POST",
    token,
    body: {
      initializeUploadRequest: {
        owner,
        fileSizeBytes: media.bytes.byteLength,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    },
  });
  const value = (json.value ?? {}) as {
    video?: string;
    uploadInstructions?: Array<{ uploadUrl?: string; firstByte?: number; lastByte?: number }>;
  };
  const parts = value.uploadInstructions ?? [];
  if (!value.video || parts.length === 0) {
    throw new Error("LinkedIn: video upload was initialized without upload instructions");
  }

  const partIds: string[] = [];
  for (const part of parts) {
    if (!part.uploadUrl) throw new Error("LinkedIn: video upload instruction had no URL");
    const from = part.firstByte ?? 0;
    // lastByte is inclusive; slice's end is not.
    const to = (part.lastByte ?? media.bytes.byteLength - 1) + 1;
    const put = await fetch(part.uploadUrl, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: media.bytes.slice(from, to),
    });
    if (!put.ok) {
      throw Object.assign(new Error(`LinkedIn: video part upload failed (HTTP ${put.status})`), {
        status: put.status,
      });
    }
    const etag = put.headers.get("etag");
    if (!etag) throw new Error("LinkedIn: video part upload returned no ETag to finalize with");
    partIds.push(etag);
  }

  await linkedinCall("videos?action=finalizeUpload", {
    method: "POST",
    token,
    body: { finalizeUploadRequest: { video: value.video, uploadToken: "", uploadedPartIds: partIds } },
  });
  return value.video;
}

/**
 * The post shape follows the attachment count: none is a bare commentary, one is
 * `content.media`, several images are `content.multiImage`. There is no single
 * attachments array covering all three, and a video is only ever on its own.
 */
async function linkedinPublish(req: PublishRequest): Promise<PublishResult> {
  const token = req.connection.accessToken;
  const author = req.connection.externalId;
  if (!token) {
    return { ok: false, error: "LinkedIn connection has no access token — reconnect it.", retryable: false };
  }
  if (!author?.startsWith("urn:li:")) {
    return {
      ok: false,
      error: `LinkedIn publishes as an organisation URN; this connection carries "${author}". Set LINKEDIN_ORG_URN and reconnect.`,
      retryable: false,
    };
  }

  const isVideo = (u: string) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(u);
  if (req.mediaUrls.length > 1 && req.mediaUrls.some(isVideo)) {
    return { ok: false, error: "LinkedIn takes one video per post, and does not mix video with images.", retryable: false };
  }

  const commentary = [req.caption, req.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  try {
    const assets: string[] = [];
    for (const url of req.mediaUrls) {
      assets.push(
        await linkedinAttempt(() =>
          isVideo(url) ? linkedinUploadVideo(url, author, token) : linkedinUploadImage(url, author, token),
        ),
      );
    }

    const body: Record<string, unknown> = {
      author,
      commentary,
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    };
    if (assets.length === 1) body.content = { media: { id: assets[0] } };
    else if (assets.length > 1) body.content = { multiImage: { images: assets.map((id) => ({ id })) } };

    const created = await linkedinAttempt(
      () => linkedinCall("posts", { method: "POST", token, body }),
      linkedinCreateRetryable,
    );
    // 201 with an empty body: the URN is only in the header.
    const externalId = created.headers.get("x-restli-id") ?? String(created.json.id ?? "");
    if (!externalId) {
      return { ok: false, error: "LinkedIn accepted the post but returned no id for it.", retryable: false };
    }

    if (req.firstComment) {
      // A failed comment must not fail the publish: the post is already live and
      // a retry would publish it a second time.
      await linkedinCall(`socialActions/${encodeURIComponent(externalId)}/comments`, {
        method: "POST",
        token,
        body: { actor: author, object: externalId, message: { text: req.firstComment } },
      }).catch(() => {});
    }

    return {
      ok: true,
      externalId,
      permalink: `https://www.linkedin.com/feed/update/${externalId}/`,
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message, retryable: linkedinRetryable(e) };
  }
}

export const linkedin: PlatformAdapter = {
  channel: "linkedin",
  label: "LinkedIn",
  color: "#0A66C2",
  capabilities: {
    formats: ["feed", "text", "carousel"],
    captionLimit: 3000,
    hashtagLimit: 10,
    maxMedia: 9,
    supportsStories: false,
    supportsFirstComment: true,
    supportsNativeScheduling: false,
    supportsStickers: false,
    videoMaxSec: { feed: 600 },
    aspectRatios: { feed: ["1:1", "16:9", "4:5"] },
  },
  validate: (req) => baseValidate(req, linkedin.capabilities, "LinkedIn"),
  publish: async (req) => (DRIVER === "mock" ? mockPublish("linkedin", req) : linkedinPublish(req)),
  rateLimit: async () => ({ used: 0, quota: 100, windowHours: 24 }),
};

/* -------------------------------------------------------------------------- */
/* X — v2 tweets, v1.1 media upload                                           */
/* -------------------------------------------------------------------------- */

const X_API = "https://api.twitter.com/2";
const X_UPLOAD = "https://upload.twitter.com/1.1/media/upload.json";
const X_ATTEMPTS = 3;
/** APPEND caps one segment at 5MB; 4 leaves room for the multipart envelope. */
const X_CHUNK_BYTES = 4 * 1024 * 1024;
/** A 140s clip transcodes in seconds — past this we stop rather than hold the worker. */
const X_STATUS_ATTEMPTS = 20;

interface XProcessing {
  state?: string;
  check_after_secs?: number;
  error?: { message?: string };
}

/** X answers errors in three different shapes depending on which API you hit. */
function xErrorText(body: Record<string, unknown>, status: number): string {
  const errors = body.errors as Array<{ message?: string; detail?: string }> | undefined;
  return (
    errors?.[0]?.message ??
    errors?.[0]?.detail ??
    (body.detail as string | undefined) ??
    (body.title as string | undefined) ??
    (typeof body.error === "string" ? body.error : undefined) ??
    `HTTP ${status}`
  );
}

/** 429 and 5xx are worth another attempt; a duplicate tweet or a dead token will never be. */
function xRetryable(e: unknown): boolean {
  const err = e as { status?: number; retryable?: boolean };
  if (typeof err.retryable === "boolean") return err.retryable;
  // No status at all means `fetch` rejected — DNS, TLS, socket. Nothing reached X.
  if (err.status === undefined) return true;
  return err.status === 429 || err.status >= 500;
}

/**
 * Posting is the one step that must not be repeated on a maybe: a 5xx can mean
 * the tweet was written and the response died, and X only dedupes identical text
 * for a short window. So the create retries solely when the request provably
 * never landed.
 */
function xCreateRetryable(e: unknown): boolean {
  const err = e as { status?: number };
  return err.status === undefined || err.status === 429;
}

async function xAttempt<T>(step: () => Promise<T>, worthRetrying = xRetryable): Promise<T> {
  let last: unknown;
  for (let i = 0; i < X_ATTEMPTS; i++) {
    try {
      return await step();
    } catch (e) {
      last = e;
      if (i === X_ATTEMPTS - 1 || !worthRetrying(e)) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

async function xCall(
  path: string,
  init: { method: "GET" | "POST"; token: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${X_API}/${path}`, {
    method: init.method,
    headers: { authorization: `Bearer ${init.token}`, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw Object.assign(new Error(`X: ${xErrorText(json, res.status)}`), { status: res.status });
  }
  return json;
}

/**
 * X uploads bytes, it does not fetch a URL, so the object is pulled out of
 * storage here and pushed on.
 */
async function xDownload(url: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    // Retryable whatever the status: these are signed URLs and the next attempt
    // mints a fresh one, so an expiry here is not a permanent failure.
    throw Object.assign(new Error(`Could not read media for upload (HTTP ${res.status})`), {
      retryable: true,
    });
  }
  return {
    bytes: await res.arrayBuffer(),
    contentType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** One multipart call to the upload host. APPEND answers 204 with no body at all. */
async function xUploadCall(form: FormData, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(X_UPLOAD, {
    method: "POST",
    // No content-type header: fetch has to set the multipart boundary itself.
    headers: { authorization: `Bearer ${token}` },
    body: form,
    cache: "no-store",
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  if (text) {
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      json = { error: text.slice(0, 300) };
    }
  }
  if (!res.ok) {
    throw Object.assign(new Error(`X media upload: ${xErrorText(json, res.status)}`), { status: res.status });
  }
  return json;
}

async function xUploadStatus(mediaId: string, token: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${X_UPLOAD}?command=STATUS&media_id=${encodeURIComponent(mediaId)}`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw Object.assign(new Error(`X media status: ${xErrorText(json, res.status)}`), { status: res.status });
  }
  return json;
}

/**
 * Video is INIT / APPEND / FINALIZE, and FINALIZE returns before the transcode
 * finishes — attaching the id to a tweet in that gap is rejected, so the state
 * is polled until X says `succeeded`.
 */
async function xUploadChunked(bytes: ArrayBuffer, contentType: string, token: string): Promise<string> {
  const init = new FormData();
  init.append("command", "INIT");
  init.append("total_bytes", String(bytes.byteLength));
  init.append("media_type", contentType);
  init.append("media_category", "tweet_video");
  const started = await xUploadCall(init, token);
  // media_id is a 64-bit integer that JSON.parse silently rounds; only the
  // string form survives the trip intact.
  const mediaId = String(started.media_id_string ?? "");
  if (!mediaId) throw new Error("X did not return a media id to upload into");

  for (let index = 0, offset = 0; offset < bytes.byteLength; index++, offset += X_CHUNK_BYTES) {
    const part = new FormData();
    part.append("command", "APPEND");
    part.append("media_id", mediaId);
    part.append("segment_index", String(index));
    part.append("media", new Blob([bytes.slice(offset, offset + X_CHUNK_BYTES)]));
    await xUploadCall(part, token);
  }

  const finalize = new FormData();
  finalize.append("command", "FINALIZE");
  finalize.append("media_id", mediaId);
  const finalized = await xUploadCall(finalize, token);

  // `processing_info` is absent when there is nothing to wait for.
  let info = finalized.processing_info as XProcessing | undefined;
  for (let i = 0; info && info.state !== "succeeded" && i < X_STATUS_ATTEMPTS; i++) {
    if (info.state === "failed") {
      throw Object.assign(
        new Error(`X could not process the video: ${info.error?.message ?? "no reason given"}`),
        { status: 400 },
      );
    }
    await new Promise((r) => setTimeout(r, Math.max(1, info?.check_after_secs ?? 3) * 1000));
    info = (await xUploadStatus(mediaId, token)).processing_info as XProcessing | undefined;
  }
  if (info && info.state !== "succeeded") {
    // Nothing has been tweeted yet, so re-uploading is wasteful but safe.
    throw Object.assign(new Error("X was still transcoding the video when we stopped waiting"), {
      retryable: true,
    });
  }
  return mediaId;
}

/**
 * v1.1, because a v2 tweet references `media_ids` and the v2 tweet call cannot
 * mint one. Note the auth mismatch this inherits: the connect flow stores an
 * OAuth 2.0 user token and it is sent as Bearer here, while the v1.1 upload host
 * has historically expected OAuth 1.0a signing — on an app that has not been
 * moved over, this is the call that 401s first.
 */
async function xUploadMedia(url: string, token: string): Promise<string> {
  const media = await xDownload(url);
  if (media.contentType.startsWith("video/") || /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url)) {
    return xUploadChunked(media.bytes, media.contentType, token);
  }

  // An image fits one POST. `media_category` is what makes the id attachable to
  // a tweet rather than usable only as a profile asset.
  const form = new FormData();
  form.append("media_category", media.contentType === "image/gif" ? "tweet_gif" : "tweet_image");
  form.append("media", new Blob([media.bytes], { type: media.contentType }));
  const json = await xUploadCall(form, token);
  const id = String(json.media_id_string ?? "");
  if (!id) throw new Error("X did not return a media id for the upload");
  return id;
}

async function xPublish(req: PublishRequest): Promise<PublishResult> {
  const token = req.connection.accessToken;
  if (!token) {
    return { ok: false, error: "X connection has no access token — reconnect the account.", retryable: false };
  }

  // There is no separate hashtag field: the tweet is one string and the 280
  // characters `validate` counted are these.
  const text = [req.caption, req.hashtags.map((h) => `#${h.replace(/^#/, "")}`).join(" ")]
    .filter(Boolean)
    .join("\n\n");

  try {
    const mediaIds: string[] = [];
    for (const url of req.mediaUrls) {
      mediaIds.push(await xAttempt(() => xUploadMedia(url, token)));
    }

    const body: Record<string, unknown> = { text };
    if (mediaIds.length) body.media = { media_ids: mediaIds };

    const created = await xAttempt(() => xCall("tweets", { method: "POST", token, body }), xCreateRetryable);
    const id = String((created.data as { id?: string } | undefined)?.id ?? "");
    if (!id) return { ok: false, error: "X accepted the post but returned no tweet id.", retryable: false };

    if (req.firstComment) {
      // A self-reply, and deliberately not fatal: the tweet is already out, and
      // failing here would have the publisher retry and post it twice.
      await xCall("tweets", {
        method: "POST",
        token,
        body: { text: req.firstComment, reply: { in_reply_to_tweet_id: id } },
      }).catch(() => {});
    }

    return { ok: true, externalId: id, permalink: `https://x.com/i/status/${id}` };
  } catch (e) {
    return { ok: false, error: (e as Error).message, retryable: xRetryable(e) };
  }
}

export const x: PlatformAdapter = {
  channel: "x",
  label: "X",
  color: "#0F1419",
  capabilities: {
    formats: ["text", "feed"],
    captionLimit: 280,
    hashtagLimit: 5,
    maxMedia: 4,
    supportsStories: false,
    supportsFirstComment: true,
    supportsNativeScheduling: false,
    supportsStickers: false,
    videoMaxSec: { feed: 140 },
    aspectRatios: { feed: ["16:9", "1:1"] },
  },
  validate: (req) => baseValidate(req, x.capabilities, "X"),
  publish: async (req) => (DRIVER === "mock" ? mockPublish("x", req) : xPublish(req)),
  rateLimit: async () => ({ used: 0, quota: 100, windowHours: 24 }),
};

/* -------------------------------------------------------------------------- */
/* Google Business Profile                                                     */
/* -------------------------------------------------------------------------- */

const GBP_API = "https://mybusiness.googleapis.com/v4";

/**
 * The parent of a local post is `accounts/{a}/locations/{l}`, and the two halves
 * arrive from different places — the account from env, the location from the
 * connection the OAuth callback stored. Either may already be written in its
 * qualified form, so the collection prefix is stripped rather than assumed
 * absent: `accounts/accounts/123` is a 404 against nothing.
 */
function gbpId(value: string, collection: "accounts" | "locations"): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, "");
  return trimmed.startsWith(`${collection}/`) ? trimmed.slice(collection.length + 1) : trimmed;
}

/**
 * Google's error envelope is `{ error: { code, status, message } }`, where
 * `status` is the canonical gRPC name. 429/5xx and the "busy, not wrong"
 * statuses clear on their own; a rejected summary or a location this token
 * cannot administer fails identically on every retry.
 */
function gbpRetryable(status: number, canonical?: string): boolean {
  if (status === 429 || status >= 500) return true;
  return ["RESOURCE_EXHAUSTED", "UNAVAILABLE", "INTERNAL", "DEADLINE_EXCEEDED", "ABORTED"].includes(
    canonical ?? "",
  );
}

/**
 * One call: POST to the location's localPosts collection. Unlike Meta there is
 * no container to poll — the post either exists when the response lands or it
 * does not.
 *
 * The body is the v4 LocalPost resource. `languageCode` and `summary` are the
 * required pair; `media` (pull-from-URL, same as Meta) and `callToAction` are
 * sent only when the request actually carries them, because GBP renders exactly
 * what it is given and a defaulted button is a button on the real listing that
 * nobody wrote.
 */
async function gbpPublish(req: PublishRequest): Promise<PublishResult> {
  const token = req.connection.accessToken;
  const account = gbpId(process.env.GBP_ACCOUNT_ID ?? "", "accounts");
  const location = gbpId(req.connection.externalId ?? "", "locations");
  if (!token) {
    return { ok: false, error: "Google Business connection has no access token.", retryable: false };
  }
  // Neither half of the parent can be guessed. Posting to a half-formed path
  // would either 404 or, worse, land on some other listing this token can reach.
  if (!account) {
    return { ok: false, error: "Google Business: GBP_ACCOUNT_ID is not set.", retryable: false };
  }
  if (!location) {
    return { ok: false, error: "Google Business connection has no location id.", retryable: false };
  }
  const summary = req.caption.trim();
  if (!summary) {
    return { ok: false, error: "Google Business needs post text — the caption is empty.", retryable: false };
  }

  // A link sticker is the only place a PublishRequest can carry a URL, so it is
  // the only thing that can turn into a CTA button. No link, no callToAction.
  const link = req.stickers?.find((s) => s.type === "link" && s.value.trim())?.value.trim();
  const media = req.mediaUrls[0];

  const body = {
    // Required. The language the summary is written in is a property of the
    // listing rather than of the post, so it is configured, not inferred.
    languageCode: process.env.GBP_LANGUAGE_CODE ?? "en",
    // "What's new" — the only topic type that needs no extra structure. EVENT
    // and OFFER additionally require event/offer objects the composer does not
    // model, so sending either would mean inventing a schedule or a coupon.
    topicType: "STANDARD",
    summary,
    ...(link ? { callToAction: { actionType: "LEARN_MORE", url: link } } : {}),
    ...(media
      ? {
          media: [
            {
              mediaFormat: /\.(mp4|mov|m4v)(\?|$)/i.test(media) ? "VIDEO" : "PHOTO",
              // Google fetches the file itself, so this has to be reachable
              // without our session — a signed storage URL, not a private path.
              sourceUrl: media,
            },
          ],
        }
      : {}),
  };

  /**
   * Creating a localPost is not idempotent and Google offers no idempotency key,
   * so "retry on any throw" can publish the same post twice to a real Business
   * Profile. The distinction that matters is whether the request was ever
   * dispatched: a failure raised by `fetch` itself means nothing reached Google
   * and retrying is free, while a failure raised after the response headers
   * arrived means the post may well exist and a retry would duplicate it.
   */
  let dispatched = false;

  try {
    const res = await fetch(`${GBP_API}/accounts/${account}/locations/${location}/localPosts`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    dispatched = true;
    // Read as text first: a proxy 502 is HTML, and JSON.parse on it would throw
    // past the status handling and report a parse error instead of the outage.
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = (JSON.parse(text) || {}) as Record<string, unknown>;
    } catch {
      json = {};
    }

    if (!res.ok) {
      const err = json.error as { message?: string; status?: string } | undefined;
      return {
        ok: false,
        // Google's own wording where there is any, the raw body when the failure
        // came from something in front of the API, the status as a last resort.
        error: `Google Business: ${err?.message ?? (text.slice(0, 300).trim() || `HTTP ${res.status}`)}`,
        retryable: gbpRetryable(res.status, err?.status),
      };
    }

    // `name` is the created post's full resource path,
    // accounts/{a}/locations/{l}/localPosts/{p} — the id everything downstream
    // needs to read or delete it.
    const name = typeof json.name === "string" ? json.name : "";
    if (!name) {
      // Something was probably created, but with no name there is nothing to
      // record, so this is reported as a failure rather than a success holding
      // an id we made up. Not retryable: a retry would duplicate the post.
      return {
        ok: false,
        error: "Google Business accepted the post but returned no localPost name.",
        retryable: false,
      };
    }
    // searchUrl is the public link to the post. It is absent while Google is
    // still processing the post, and an absent permalink stays absent rather
    // than becoming a guessed URL.
    const searchUrl = typeof json.searchUrl === "string" ? json.searchUrl : "";
    return { ok: true, externalId: name, ...(searchUrl ? { permalink: searchUrl } : {}) };
  } catch (e) {
    if (!dispatched) {
      // The request never left — DNS, TLS, socket. Nothing was created, so this
      // is always worth another attempt.
      return { ok: false, error: `Google Business: ${(e as Error).message}`, retryable: true };
    }
    // Google answered and the failure came from reading that answer. The post
    // may already be live, so this stops rather than risking a second copy on a
    // profile customers can see. Recovering means looking at the location.
    return {
      ok: false,
      error: `Google Business: the post was sent but the response could not be read (${(e as Error).message}). Check the location before posting again — it may already be live.`,
      retryable: false,
    };
  }
}

/**
 * Google Business Profile posts ("local posts") are what keep a listing fresh —
 * the single biggest lever on local pack visibility after review velocity.
 */
export const googleBusiness: PlatformAdapter = {
  channel: "google_business",
  label: "Google Business",
  color: "#34A853",
  capabilities: {
    formats: ["feed"],
    captionLimit: 1500,
    hashtagLimit: 0,
    maxMedia: 1,
    supportsStories: false,
    supportsFirstComment: false,
    supportsNativeScheduling: false,
    supportsStickers: false,
    videoMaxSec: {},
    aspectRatios: { feed: ["4:3", "1:1"] },
  },
  validate(req) {
    const errors = baseValidate(req, googleBusiness.capabilities, "Google Business");
    if (req.hashtags.length) errors.push("Google Business posts ignore hashtags — drop them.");
    return errors;
  },
  publish: async (req) => (DRIVER === "mock" ? mockPublish("google_business", req) : gbpPublish(req)),
  rateLimit: async () => ({ used: 0, quota: 10, windowHours: 24 }),
};

export const ALL_CONTENT_ADAPTERS = [tiktok, youtube, linkedin, x, googleBusiness];
export { DRIVER };
