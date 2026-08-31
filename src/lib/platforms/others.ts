import { DRIVER, baseValidate, mockPublish, type PlatformAdapter } from "./types";

/**
 * The remaining networks. Each one is deliberately thin: capabilities + validation
 * are fully real (that is what the composer enforces), while `publish` is wired to
 * the mock driver until you drop in the network's token. The live call shape for
 * each is documented inline so turning one on is a contained change.
 */

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
  // Live: POST /v2/post/publish/video/init/ (PULL_FROM_URL) then poll
  // POST /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE.
  publish: async (req) => mockPublish("tiktok", req),
  rateLimit: async () => ({ used: 2, quota: 15, windowHours: 24 }),
};

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
  // Live: resumable upload to youtube/v3/videos?part=snippet,status with
  // status.publishAt for scheduling.
  publish: async (req) => mockPublish("youtube", req),
  rateLimit: async () => ({ used: 1, quota: 6, windowHours: 24 }),
};

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
  // Live: POST /rest/posts with author=urn:li:organization:{id}, media registered
  // first through /rest/images?action=initializeUpload.
  publish: async (req) => mockPublish("linkedin", req),
  rateLimit: async () => ({ used: 3, quota: 100, windowHours: 24 }),
};

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
  // Live: POST /2/tweets, media via v1.1 chunked upload (INIT/APPEND/FINALIZE).
  publish: async (req) => mockPublish("x", req),
  rateLimit: async () => ({ used: 4, quota: 100, windowHours: 24 }),
};

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
  // Live: POST /v4/accounts/{acct}/locations/{loc}/localPosts
  publish: async (req) => mockPublish("google_business", req),
  rateLimit: async () => ({ used: 1, quota: 10, windowHours: 24 }),
};

export const ALL_CONTENT_ADAPTERS = [tiktok, youtube, linkedin, x, googleBusiness];
export { DRIVER };
