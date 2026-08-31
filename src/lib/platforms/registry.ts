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
