import { read } from "../db";
import { activeProvider } from "../ai/provider";
import { graphVersion } from "./types";

/**
 * WHATSAPP HEALTH — read-only facts for the admin card on /settings.
 *
 * One Graph call (the phone-number object) with an 8s deadline and a 5-minute
 * in-process cache so the settings page cannot hammer the API or hang on it.
 * Everything else is local: env presence and the newest inbound message.
 */

export interface WhatsAppPhoneInfo {
  displayNumber?: string;
  verifiedName?: string;
  qualityRating?: string;
  nameStatus?: string;
  verificationStatus?: string;
  error?: string;
}

export interface WhatsAppHealth {
  phoneNumberId: string;
  phone: WhatsAppPhoneInfo | null;
  verifyTokenSet: boolean;
  appSecretSet: boolean;
  tokenSet: boolean;
  publicBaseUrl: string;
  lastInboundAt: string | null;
  aiWriterReady: boolean;
}

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: WhatsAppPhoneInfo }>();

export async function fetchPhoneInfo(
  phoneNumberId: string,
  token = process.env.META_SYSTEM_USER_TOKEN,
  now = Date.now(),
): Promise<WhatsAppPhoneInfo | null> {
  if (!phoneNumberId || !token) return null;
  const hit = cache.get(phoneNumberId);
  if (hit && now - hit.at < CACHE_MS) return hit.value;
  let value: WhatsAppPhoneInfo;
  try {
    const fields = "display_phone_number,verified_name,quality_rating,name_status,code_verification_status";
    const res = await fetch(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}?fields=${fields}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json()) as {
      display_phone_number?: string;
      verified_name?: string;
      quality_rating?: string;
      name_status?: string;
      code_verification_status?: string;
      error?: { message?: string };
    };
    value = res.ok
      ? {
          displayNumber: json.display_phone_number,
          verifiedName: json.verified_name,
          qualityRating: json.quality_rating,
          nameStatus: json.name_status,
          verificationStatus: json.code_verification_status,
        }
      : { error: json.error?.message ?? `Graph ${res.status}` };
  } catch (e) {
    value = { error: (e as Error).message };
  }
  cache.set(phoneNumberId, { at: now, value });
  return value;
}

export async function whatsappHealth(): Promise<WhatsAppHealth> {
  const set = (k: string) => Boolean(process.env[k]?.trim());
  const db = read();
  const conn = db.connections.find((c) => c.channel === "whatsapp");
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim() || conn?.externalId || "";
  const lastInbound = db.opsMessages
    .filter((m) => m.channel === "whatsapp" && m.direction === "inbound")
    .reduce<string | null>((best, m) => (!best || m.createdAt > best ? m.createdAt : best), null);
  return {
    phoneNumberId,
    phone: await fetchPhoneInfo(phoneNumberId),
    verifyTokenSet: set("WHATSAPP_VERIFY_TOKEN"),
    appSecretSet: set("META_APP_SECRET"),
    tokenSet: set("META_SYSTEM_USER_TOKEN"),
    publicBaseUrl: process.env.PUBLIC_BASE_URL?.trim() ?? "",
    lastInboundAt: lastInbound,
    aiWriterReady: activeProvider() !== null,
  };
}
