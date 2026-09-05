import type { ChannelId } from "../types";
import { facebook, instagram } from "./meta";
import { googleBusiness, linkedin, tiktok, x, youtube } from "./others";
import { whatsapp } from "./whatsapp";
import type { PlatformAdapter } from "./types";

const adapters: Record<string, PlatformAdapter> = {
  instagram,
  facebook,
  tiktok,
  youtube,
  linkedin,
  x,
  google_business: googleBusiness,
  whatsapp,
};

export function adapterFor(channel: ChannelId): PlatformAdapter | undefined {
  return adapters[channel];
}

export function contentAdapters(): PlatformAdapter[] {
  return Object.values(adapters);
}

/** Presentation metadata for ad channels, which have no publish path. */
export const AD_CHANNELS: Record<string, { label: string; color: string }> = {
  meta_ads: { label: "Meta Ads", color: "#0866FF" },
  google_ads: { label: "Google Ads", color: "#FBBC04" },
};

export function channelMeta(channel: ChannelId): { label: string; color: string } {
  const a = adapters[channel];
  if (a) return { label: a.label, color: a.color };
  return AD_CHANNELS[channel] ?? { label: channel, color: "#64748b" };
}

export const CHANNEL_ORDER: ChannelId[] = [
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "linkedin",
  "x",
  "google_business",
  "whatsapp",
  "meta_ads",
  "google_ads",
];

/**
 * Is this connection actually usable?
 *
 * `status === "connected"` was trusted everywhere — the Connections screen, the
 * per-channel tabs, the retrieval sync and the WhatsApp send path all keyed off
 * it alone. A row can carry that status with no access token at all (two did:
 * Instagram and YouTube, written outside the OAuth callback), and every one of
 * those surfaces then reported a live integration that could not publish, fetch
 * a metric or send a message. A channel is connected when it holds a credential
 * that can act, not when a string says so.
 */
export function isUsableConnection(c: {
  status?: string;
  accessToken?: string;
  channel?: string;
}): boolean {
  if (c.status !== "connected") return false;
  if (c.accessToken?.trim()) return true;
  if ((c.channel === "youtube" || c.channel === "instagram") && Boolean(process.env.UPLOAD_POST_API_KEY?.trim())) {
    return true;
  }
  return false;
}

/** Why a connection that claims to be connected cannot actually be used. */
export function connectionProblem(c: {
  status?: string;
  accessToken?: string;
  channel?: string;
}): string | null {
  if (c.status !== "connected") return null;
  if (!c.accessToken?.trim()) {
    if ((c.channel === "youtube" || c.channel === "instagram") && Boolean(process.env.UPLOAD_POST_API_KEY?.trim())) {
      return null;
    }
    return "No access token stored — reconnect this channel to publish or read metrics.";
  }
  return null;
}
