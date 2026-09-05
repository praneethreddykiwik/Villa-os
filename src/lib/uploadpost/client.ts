/**
 * UPLOAD-POST API CLIENT
 *
 * Unified social media publishing client integrating with https://api.upload-post.com.
 * Allows publishing video, reels, shorts and photos to Instagram, YouTube,
 * Facebook, LinkedIn and X via managed social account connections.
 */

const UPLOAD_POST_BASE_URL = "https://api.upload-post.com/api";

export function uploadPostApiKey(): string | undefined {
  return process.env.UPLOAD_POST_API_KEY?.trim();
}

export function uploadPostUser(): string {
  return process.env.UPLOAD_POST_USER?.trim() || "default";
}

export function isUploadPostConfigured(): boolean {
  return Boolean(uploadPostApiKey());
}

export interface SocialAccountInfo {
  display_name: string;
  handle: string;
  social_images?: string | null;
  reauth_required?: boolean;
}

export interface UploadPostProfile {
  username: string;
  social_accounts: Record<string, SocialAccountInfo | string>;
  created_at?: string;
  blocked?: boolean;
}

export interface UploadPostStatusResult {
  configured: boolean;
  valid: boolean;
  email?: string;
  plan?: string;
  activeProfile: string;
  profiles: UploadPostProfile[];
  connectedAccounts: {
    instagram?: SocialAccountInfo | null;
    youtube?: SocialAccountInfo | null;
    linkedin?: SocialAccountInfo | null;
    facebook?: SocialAccountInfo | null;
    google_business?: SocialAccountInfo | null;
  };
  error?: string;
}

export interface UploadVideoOptions {
  user?: string;
  platforms: ("instagram" | "youtube" | "facebook" | "linkedin" | "tiktok" | "x" | string)[];
  video: Blob | Buffer | string;
  filename?: string;
  title?: string;
  description?: string;
  mediaType?: "REELS" | "STORIES";
  shareToFeed?: boolean;
}

export interface UploadPhotosOptions {
  user?: string;
  platforms: ("instagram" | "facebook" | "linkedin" | string)[];
  photos: Array<Blob | Buffer | string>;
  title?: string;
  description?: string;
}

export async function checkUploadPostStatus(): Promise<UploadPostStatusResult> {
  const key = uploadPostApiKey();
  const profileUser = uploadPostUser();

  if (!key) {
    return {
      configured: false,
      valid: false,
      activeProfile: profileUser,
      profiles: [],
      connectedAccounts: {},
      error: "UPLOAD_POST_API_KEY is not configured",
    };
  }

  try {
    const meRes = await fetch(`${UPLOAD_POST_BASE_URL}/uploadposts/me`, {
      method: "GET",
      headers: {
        Authorization: `Apikey ${key}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!meRes.ok) {
      return {
        configured: true,
        valid: false,
        activeProfile: profileUser,
        profiles: [],
        connectedAccounts: {},
        error: `HTTP ${meRes.status}: ${meRes.statusText}`,
      };
    }

    const meData = (await meRes.json()) as { success?: boolean; email?: string; plan?: string };

    const usersRes = await fetch(`${UPLOAD_POST_BASE_URL}/uploadposts/users`, {
      method: "GET",
      headers: {
        Authorization: `Apikey ${key}`,
      },
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    let profiles: UploadPostProfile[] = [];
    if (usersRes.ok) {
      const usersData = (await usersRes.json()) as { success?: boolean; profiles?: UploadPostProfile[] };
      profiles = usersData.profiles ?? [];
    }

    const active = profiles.find((p) => p.username.toLowerCase() === profileUser.toLowerCase()) ?? profiles[0];

    const connected: UploadPostStatusResult["connectedAccounts"] = {};
    if (active && active.social_accounts) {
      const accounts = active.social_accounts;

      if (accounts.instagram && typeof accounts.instagram === "object" && accounts.instagram.handle) {
        connected.instagram = accounts.instagram;
      }
      if (accounts.youtube && typeof accounts.youtube === "object" && accounts.youtube.handle) {
        connected.youtube = accounts.youtube;
      }
      if (accounts.linkedin && typeof accounts.linkedin === "object" && accounts.linkedin.handle) {
        connected.linkedin = accounts.linkedin;
      }
      if (accounts.facebook && typeof accounts.facebook === "object" && accounts.facebook.handle) {
        connected.facebook = accounts.facebook;
      }
      if (accounts.google_business && typeof accounts.google_business === "object" && accounts.google_business.handle) {
        connected.google_business = accounts.google_business;
      }
    }

    return {
      configured: true,
      valid: Boolean(meData.success),
      email: meData.email,
      plan: meData.plan,
      activeProfile: active ? active.username : profileUser,
      profiles,
      connectedAccounts: connected,
    };
  } catch (err) {
    return {
      configured: true,
      valid: false,
      activeProfile: profileUser,
      profiles: [],
      connectedAccounts: {},
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function uploadPostVideo(opts: UploadVideoOptions): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const key = uploadPostApiKey();
  if (!key) return { ok: false, error: "UPLOAD_POST_API_KEY is not configured" };

  const targetUser = opts.user || uploadPostUser();
  const form = new FormData();
  form.append("user", targetUser);

  for (const p of opts.platforms) {
    form.append("platform[]", p);
  }

  if (opts.title) form.append("title", opts.title);
  if (opts.description) form.append("description", opts.description);
  if (opts.mediaType) form.append("media_type", opts.mediaType);
  if (opts.shareToFeed !== undefined) form.append("share_to_feed", String(opts.shareToFeed));

  if (typeof opts.video === "string") {
    form.append("video", opts.video);
  } else if (Buffer.isBuffer(opts.video)) {
    const blob = new Blob([new Uint8Array(opts.video)], { type: "video/mp4" });
    form.append("video", blob, opts.filename || "video.mp4");
  } else if (opts.video instanceof Blob) {
    form.append("video", opts.video, opts.filename || "video.mp4");
  }

  try {
    const res = await fetch(`${UPLOAD_POST_BASE_URL}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Apikey ${key}`,
      },
      body: form,
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        error: json?.message || `Upload failed with HTTP ${res.status}`,
        data: json,
      };
    }

    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function uploadPostPhotos(opts: UploadPhotosOptions): Promise<{
  ok: boolean;
  data?: unknown;
  error?: string;
}> {
  const key = uploadPostApiKey();
  if (!key) return { ok: false, error: "UPLOAD_POST_API_KEY is not configured" };

  const targetUser = opts.user || uploadPostUser();
  const form = new FormData();
  form.append("user", targetUser);

  for (const p of opts.platforms) {
    form.append("platform[]", p);
  }

  if (opts.title) form.append("title", opts.title);
  if (opts.description) form.append("description", opts.description);

  opts.photos.forEach((photo, idx) => {
    if (typeof photo === "string") {
      form.append("photos[]", photo);
    } else if (Buffer.isBuffer(photo)) {
      const blob = new Blob([new Uint8Array(photo)], { type: "image/jpeg" });
      form.append("photos[]", blob, `photo-${idx}.jpg`);
    } else if (photo instanceof Blob) {
      form.append("photos[]", photo, `photo-${idx}.jpg`);
    }
  });

  try {
    const res = await fetch(`${UPLOAD_POST_BASE_URL}/upload_photos`, {
      method: "POST",
      headers: {
        Authorization: `Apikey ${key}`,
      },
      body: form,
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      return {
        ok: false,
        error: json?.message || `Upload photos failed with HTTP ${res.status}`,
        data: json,
      };
    }

    return { ok: true, data: json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
