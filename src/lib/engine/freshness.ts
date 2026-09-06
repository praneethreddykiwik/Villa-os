import { read } from "../db";
import { STALE_AFTER_MS, isStale } from "../metrics/youtube";
import { retrieveAll } from "./sync";

/**
 * PAGE-DRIVEN FRESHNESS
 *
 * The analytics, dashboard and channels pages read `dailyStats`; nothing
 * refreshes those rows unless someone presses Sync or a cron runs. So each of
 * those pages asks here first: if the newest YouTube row/stamp is older than
 * ten minutes, run the YouTube part of the retrieval sync before rendering.
 *
 * Non-blocking by contract: any failure (no API key, quota, network) is
 * swallowed and the page renders whatever it already holds, and a slow API
 * only delays the page by REFRESH_DEADLINE_MS — the sync keeps running in the
 * background and the next render picks up its rows. One refresh at a time per
 * brand — concurrent renders share the in-flight promise.
 */

const inflight = new Map<string, Promise<boolean>>();
/** Last attempt per brand that synced nothing (quota, bad key): skip retries within the TTL. */
const lastFailedAt = new Map<string, number>();

/** Test hook: forget remembered failures. */
export function resetFreshnessBackoff(): void {
  lastFailedAt.clear();
}
/** Longest a page render waits on the YouTube refresh before showing stale rows. */
export const REFRESH_DEADLINE_MS = 4000;

export interface FreshnessInfo {
  /** Newest YouTube sync stamp for the brand after the (possible) refresh. */
  lastSyncedAt: string | null;
  refreshed: boolean;
}

/** What the freshness decision is made from — separated so it can be unit-tested. */
export function youtubeFreshnessInput(
  db: { connections: Array<{ brandId: string; channel: string; status: string; lastSyncedAt?: string }>; dailyStats: Array<{ brandId: string; channel: string; date: string }> },
  brandId: string,
  channels: string[] = ["youtube"],
): { lastSyncedAt: string | null; newestStatDate: string | null; connected: boolean } {
  const conns = db.connections.filter((c) => c.brandId === brandId && channels.includes(c.channel) && c.status !== "disconnected");
  const lastSyncedAt = conns.map((c) => c.lastSyncedAt ?? "").filter(Boolean).sort().pop() ?? null;
  const newestStatDate = db.dailyStats
    .filter((s) => s.brandId === brandId && channels.includes(s.channel))
    .map((s) => s.date).sort().pop() ?? null;
  return { lastSyncedAt, newestStatDate, connected: conns.length > 0 };
}

/**
 * Channels the page-driven refresh covers: YouTube (public API) and the three
 * networks whose analytics the publishing connector serves. Nothing else has
 * a keyless source to refresh from.
 */
export const FRESH_CHANNELS = ["youtube", "instagram", "facebook", "linkedin"] as const;

export async function ensureFreshStats(brandId: string): Promise<FreshnessInfo> {
  const before = youtubeFreshnessInput(read(), brandId, [...FRESH_CHANNELS]);
  if (!before.connected || !isStale(before)) return { lastSyncedAt: before.lastSyncedAt, refreshed: false };

  const failed = lastFailedAt.get(brandId);
  if (failed !== undefined && Date.now() - failed < STALE_AFTER_MS) return { lastSyncedAt: before.lastSyncedAt, refreshed: false };

  let refreshed = false;
  try {
    let p = inflight.get(brandId);
    if (!p) {
      // Only a source that reached "synced" wrote rows worth re-reading;
      // anything else is remembered so the next TTL of renders skips the API.
      p = retrieveAll(brandId, { only: [...FRESH_CHANNELS], silent: true })
        .then((r) => r.totals.synced > 0)
        .then((ok) => { if (ok) lastFailedAt.delete(brandId); else lastFailedAt.set(brandId, Date.now()); return ok; })
        .finally(() => inflight.delete(brandId));
      inflight.set(brandId, p);
    }
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((res) => { timer = setTimeout(() => res("timeout"), REFRESH_DEADLINE_MS); });
    // Race, don't await: a hung fetch must not hold the page. `p` stays in
    // `inflight` and finishes (or fails) on its own.
    const won = await Promise.race([p, deadline]).finally(() => clearTimeout(timer));
    refreshed = won === true;
  } catch {
    // Stale beats blank: the caller renders what the store already holds.
    lastFailedAt.set(brandId, Date.now());
  }
  return { lastSyncedAt: youtubeFreshnessInput(read(), brandId, [...FRESH_CHANNELS]).lastSyncedAt, refreshed };
}
