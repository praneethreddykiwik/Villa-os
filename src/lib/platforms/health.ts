import { DRIVER } from "./types";
import { channelMeta } from "./registry";
import type { ChannelId, Connection } from "../types";
import { isUploadPostConnection, uploadPostLinkedAccount } from "../uploadpost/connections";

/**
 * LIVE CHANNEL HEALTH.
 *
 * `connection.status` is a string somebody wrote. It has been wrong more than
 * once in this codebase: four rows sat at "connected" with no access token at
 * all, and every screen reporting on them claimed a working integration that
 * could not publish, read a metric or send a message. `isUsableConnection()`
 * fixed the cheap half of that by also requiring a token.
 *
 * This module does the expensive half: it asks the platform. A token that
 * exists can still be revoked, expired, or scoped to assets the business no
 * longer owns, and none of that is visible locally. The only reliable answer
 * comes from the other end of the wire.
 *
 * Every probe is read-only — it reads an identity or a quota, never writes.
 * Results are cached briefly because this runs behind a screen an operator can
 * refresh repeatedly, and Meta counts every call against the app's rate limit.
 */

export type HealthState = "live" | "degraded" | "down" | "absent" | "unchecked";

export interface ChannelHealth {
  channel: ChannelId;
  label: string;
  color: string;
  state: HealthState;
  /** One line an operator can act on. Never a raw API dump. */
  detail: string;
  /** Platform-side identity confirmed by the probe, when it returns one. */
  identity?: string;
  handle?: string;
  tokenExpiresAt?: string;
  lastSyncedAt?: string;
  checkedAt: string;
}

const CACHE_MS = 60_000;
const cache = new Map<string, { at: number; value: ChannelHealth }>();

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v23.0"}`;

/** Read a Graph endpoint and return parsed JSON, or an Error describing why not. */
async function graph(path: string, token: string, timeoutMs = 8000): Promise<Record<string, unknown> | Error> {
  try {
    const res = await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const err = json.error as { message?: string; code?: number } | undefined;
      return new Error(err?.message || `HTTP ${res.status}`);
    }
    return json;
  } catch (e) {
    return new Error((e as Error).message);
  }
}

/* -------------------------------------------------------------------------- */
/* Per-platform probes. Each returns a state and a sentence, never a payload.  */
/* -------------------------------------------------------------------------- */

async function probeMetaPage(c: Connection): Promise<Pick<ChannelHealth, "state" | "detail" | "identity">> {
  const token = c.accessToken?.trim() || process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!token) return { state: "absent", detail: "No access token stored. Reconnect the account." };
  const r = await graph(`${c.externalId}?fields=id,name`, token);
  if (r instanceof Error) return { state: "down", detail: r.message };
  return { state: "live", detail: `Confirmed as ${String(r.name ?? c.handle)}.`, identity: String(r.id ?? c.externalId) };
}

async function probeInstagram(c: Connection): Promise<Pick<ChannelHealth, "state" | "detail" | "identity">> {
  const token = c.accessToken?.trim() || process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!token) return { state: "absent", detail: "No access token stored. Reconnect the account." };
  const r = await graph(`${c.externalId}?fields=id,username,followers_count`, token);
  if (r instanceof Error) return { state: "down", detail: r.message };
  // A business account that cannot report its own username is not publishable.
  if (!r.username) return { state: "degraded", detail: "Reachable, but not reporting as a Business account." };
  return { state: "live", detail: `Confirmed as @${String(r.username)}.`, identity: String(r.id ?? c.externalId) };
}

async function probeWhatsApp(): Promise<Pick<ChannelHealth, "state" | "detail" | "identity">> {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const token = process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!id || !token) return { state: "absent", detail: "Sender number or access token is not configured." };
  const r = await graph(`${id}?fields=display_phone_number,verified_name,quality_rating,name_status`, token);
  if (r instanceof Error) return { state: "down", detail: r.message };
  const quality = String(r.quality_rating ?? "UNKNOWN");
  const nameState = String(r.name_status ?? "UNKNOWN");
  const number = String(r.display_phone_number ?? id);
  if (quality === "RED") {
    return { state: "degraded", detail: `${number} — quality rating is RED. Sending limits apply.`, identity: number };
  }
  if (nameState !== "APPROVED") {
    return { state: "degraded", detail: `${number} — display name is ${nameState.toLowerCase().replace(/_/g, " ")}.`, identity: number };
  }
  return { state: "live", detail: `${number} — approved, quality ${quality.toLowerCase()}.`, identity: number };
}

async function probeYouTube(c: Connection): Promise<Pick<ChannelHealth, "state" | "detail" | "identity">> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    // The public Data API key is what the read paths use; without it we can say
    // nothing truthful about the channel, so say that rather than guess.
    return { state: "unchecked", detail: "No public data key set, so the channel cannot be verified from here." };
  }
  try {
    const res = await fetch(
      `https://www.googleapis.com/youtube/v3/channels?part=snippet&id=${encodeURIComponent(c.externalId)}&key=${key}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const json = (await res.json()) as { items?: Array<{ snippet?: { title?: string } }>; error?: { message?: string } };
    if (!res.ok) return { state: "down", detail: json.error?.message || `HTTP ${res.status}` };
    const title = json.items?.[0]?.snippet?.title;
    if (!title) return { state: "down", detail: "The channel id returned no channel." };
    return { state: "live", detail: `Confirmed as ${title}.`, identity: c.externalId };
  } catch (e) {
    return { state: "down", detail: (e as Error).message };
  }
}

/**
 * LinkedIn and the publishing-connector channels expose no cheap identity read
 * that does not consume a write quota, so they are reported from what is stored
 * rather than probed. Saying "unchecked" is more useful than implying a check
 * happened.
 */
function reportFromStored(c: Connection): Pick<ChannelHealth, "state" | "detail"> {
  if (!c.accessToken?.trim()) {
    return { state: "absent", detail: "No access token stored. Reconnect the account." };
  }
  if (c.status !== "connected") {
    return { state: "down", detail: c.lastError || `Marked ${c.status}.` };
  }
  if (c.tokenExpiresAt && new Date(c.tokenExpiresAt).getTime() < Date.now()) {
    return { state: "down", detail: "The stored token has expired. Reconnect the account." };
  }
  return { state: "unchecked", detail: "Credential is present. This platform offers no free health read." };
}

/**
 * Channels published through the Upload-Post connector rather than the platform
 * API directly. Their externalId is a connector handle ("uploadpost:user:x"),
 * not a Graph object, so probing Graph answers "no such object" and the screen
 * would report a perfectly good channel as broken. publisher.ts routes these to
 * the connector, so health has to ask the connector too.
 */
async function probeConnector(c: Connection): Promise<Pick<ChannelHealth, "state" | "detail" | "identity">> {
  const account = await uploadPostLinkedAccount(c.channel);
  if (!account) {
    return { state: "down", detail: "The publishing connector has no account linked for this channel." };
  }
  if (account.reauth_required) {
    return {
      state: "degraded",
      detail: `${account.handle || account.display_name} needs to be re-authorised in the publishing connector.`,
      identity: account.handle || account.display_name,
    };
  }
  return {
    state: "live",
    detail: `Linked through the publishing connector as ${account.handle || account.display_name}.`,
    identity: account.handle || account.display_name,
  };
}

/* -------------------------------------------------------------------------- */

export async function checkChannel(c: Connection, now = Date.now()): Promise<ChannelHealth> {
  const hit = cache.get(c.id);
  if (hit && now - hit.at < CACHE_MS) return hit.value;

  const meta = channelMeta(c.channel);
  const base = {
    channel: c.channel,
    label: meta.label,
    color: meta.color,
    handle: c.handle,
    tokenExpiresAt: c.tokenExpiresAt,
    lastSyncedAt: c.lastSyncedAt,
    checkedAt: new Date(now).toISOString(),
  };

  // In mock mode nothing is really connected; claiming otherwise is the exact
  // dishonesty the publisher was fixed for.
  if (DRIVER !== "live") {
    const value: ChannelHealth = {
      ...base,
      state: "unchecked",
      detail: 'Running in mock mode, so no live check was made. Set PLATFORM_DRIVER=live.',
    };
    cache.set(c.id, { at: now, value });
    return value;
  }

  let result: Pick<ChannelHealth, "state" | "detail" | "identity">;
  if (isUploadPostConnection(c)) {
    result = await probeConnector(c);
    const viaConnector: ChannelHealth = { ...base, ...result };
    cache.set(c.id, { at: now, value: viaConnector });
    return viaConnector;
  }
  switch (c.channel) {
    case "instagram":
      result = await probeInstagram(c);
      break;
    case "facebook":
      result = await probeMetaPage(c);
      break;
    case "whatsapp":
      result = await probeWhatsApp();
      break;
    case "youtube":
      result = await probeYouTube(c);
      break;
    default:
      result = reportFromStored(c);
  }

  const value: ChannelHealth = { ...base, ...result };
  cache.set(c.id, { at: now, value });
  return value;
}

export async function checkAll(connections: Connection[]): Promise<ChannelHealth[]> {
  // Probes are independent; one platform being slow must not delay the rest.
  return Promise.all(connections.map((c) => checkChannel(c)));
}

/** Drop cached results so an operator pressing "Check again" gets a fresh read. */
export function clearHealthCache(): void {
  cache.clear();
}

/* -------------------------------------------------------------------------- */
/* Inbound webhooks — the other half of "is this channel actually working".     */
/* -------------------------------------------------------------------------- */

export interface WebhookHealth {
  name: string;
  path: string;
  /** What breaks when this is not receiving. */
  carries: string;
  configured: boolean;
  detail: string;
}

export function webhookHealth(): WebhookHealth[] {
  const base = process.env.PUBLIC_BASE_URL?.trim();
  const reachable = Boolean(base);

  return [
    {
      name: "WhatsApp messages",
      path: "/api/webhooks/whatsapp",
      carries: "Incoming buyer messages and delivery receipts",
      configured: reachable && Boolean(process.env.WHATSAPP_VERIFY_TOKEN?.trim()) && Boolean(process.env.META_APP_SECRET?.trim()),
      detail: !reachable
        ? "No public address is set, so Meta has nowhere to deliver to."
        : !process.env.WHATSAPP_VERIFY_TOKEN?.trim()
          ? "The handshake token is not set, so verification will fail."
          : !process.env.META_APP_SECRET?.trim()
            ? "The signing secret is not set, so every delivery is rejected as unsigned."
            : `Ready at ${base}/api/webhooks/whatsapp`,
    },
    {
      name: "Voice calls",
      path: "/api/webhooks/bolna",
      carries: "Finished calls, transcripts and the leads they raise",
      configured: reachable && Boolean(process.env.VOICE_WEBHOOK_SECRET?.trim()),
      detail: !reachable
        ? "No public address is set."
        : !process.env.VOICE_WEBHOOK_SECRET?.trim()
          ? "The shared secret is not set, so the endpoint refuses every call."
          : `Ready at ${base}/api/webhooks/bolna`,
    },
    {
      name: "Automation",
      path: "/api/webhooks/n8n",
      carries: "Events pushed in from your automation workflows",
      configured: reachable && Boolean(process.env.N8N_WEBHOOK_SECRET?.trim() || process.env.N8N_WEBHOOK_URL?.trim()),
      detail: !reachable
        ? "No public address is set."
        : process.env.N8N_WEBHOOK_SECRET?.trim() || process.env.N8N_WEBHOOK_URL?.trim()
          ? `Ready at ${base}/api/webhooks/n8n`
          : "Not configured. Optional unless you run automation workflows.",
    },
  ];
}
