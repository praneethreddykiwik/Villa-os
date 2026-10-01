import { db } from "../osf/supabase";

/**
 * OPERATIONAL SETTINGS FOR THE VILLA BUSINESS.
 *
 * Calling hours, concurrency and retry policy used to be `const`s in
 * src/lib/voice/queue.ts. That made "stop calling people after 7pm" a code
 * change, a review and a deploy — for a decision the sales desk is better
 * placed to make than anyone editing TypeScript.
 *
 * WHY THE READS ARE FORGIVING AND THE WRITES ARE NOT
 *
 * These numbers decide when real phones ring. A read that throws would stop
 * the queue entirely, so every read falls back to DEFAULTS — which are exactly
 * today's constants, so a missing table or a dead network changes nothing.
 *
 * A write is the opposite: an end hour before the start hour silently stops
 * the queue dialling forever, and a concurrency of 50 means fifty people hear
 * a busy tone from one number. Those are refused here, and again by CHECK
 * constraints in the table, because this row is reachable by anything holding
 * the service key.
 */

export interface VillaSettings {
  brandId: string;
  callingStartHour: number;
  callingEndHour: number;
  callingTimeZone: string;
  maxConcurrentCalls: number;
  maxAttempts: number;
  retryBackoffMinutes: number;
  callTimeoutMinutes: number;
  updatedAt: string | null;
  updatedBy: string | null;
}

/** Today's behaviour. Changing these changes the product's defaults. */
export const DEFAULTS: Omit<VillaSettings, "brandId" | "updatedAt" | "updatedBy"> = {
  callingStartHour: 9,
  callingEndHour: 20,
  callingTimeZone: "Asia/Kolkata",
  maxConcurrentCalls: 1,
  maxAttempts: 2,
  retryBackoffMinutes: 60,
  callTimeoutMinutes: 15,
};

/**
 * The bounds a human may set, and the reason for each ceiling.
 *
 * These mirror the CHECK constraints on villa_settings exactly. If you change
 * one, change both — the table is the backstop, not the interface.
 */
export const BOUNDS = {
  callingStartHour: { min: 0, max: 23, label: "Start hour" },
  callingEndHour: { min: 1, max: 24, label: "End hour" },
  /** One outbound number is shared across brands; ten is already optimistic. */
  maxConcurrentCalls: { min: 1, max: 10, label: "Calls at once" },
  maxAttempts: { min: 1, max: 5, label: "Attempts per number" },
  retryBackoffMinutes: { min: 5, max: 1440, label: "Wait before retrying" },
  callTimeoutMinutes: { min: 2, max: 120, label: "Give up on a silent call after" },
} as const;

export function defaultSettings(brandId: string): VillaSettings {
  return { brandId, ...DEFAULTS, updatedAt: null, updatedBy: null };
}

const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; value: VillaSettings }>();

function fromRow(brandId: string, row: Record<string, unknown>): VillaSettings {
  const num = (key: string, fallback: number) => {
    const v = row[key];
    return typeof v === "number" && Number.isFinite(v) ? v : fallback;
  };
  return {
    brandId,
    callingStartHour: num("calling_start_hour", DEFAULTS.callingStartHour),
    callingEndHour: num("calling_end_hour", DEFAULTS.callingEndHour),
    callingTimeZone:
      typeof row.calling_time_zone === "string" && row.calling_time_zone.trim()
        ? row.calling_time_zone
        : DEFAULTS.callingTimeZone,
    maxConcurrentCalls: num("max_concurrent_calls", DEFAULTS.maxConcurrentCalls),
    maxAttempts: num("max_attempts", DEFAULTS.maxAttempts),
    retryBackoffMinutes: num("retry_backoff_minutes", DEFAULTS.retryBackoffMinutes),
    callTimeoutMinutes: num("call_timeout_minutes", DEFAULTS.callTimeoutMinutes),
    updatedAt: typeof row.updated_at === "string" ? row.updated_at : null,
    updatedBy: typeof row.updated_by === "string" ? row.updated_by : null,
  };
}

/**
 * The settings in force, from cache when fresh.
 *
 * Never throws: a brand with no row, a table that does not exist yet and a
 * database that is down all answer with today's defaults.
 */
export async function loadSettings(brandId: string): Promise<VillaSettings> {
  const hit = cache.get(brandId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let value = defaultSettings(brandId);
  try {
    const { data, error } = await db()
      .from("villa_settings")
      .select("*")
      .eq("brand_id", brandId)
      .maybeSingle();
    if (!error && data) value = fromRow(brandId, data as Record<string, unknown>);
  } catch {
    /* defaults — see the module note */
  }
  cache.set(brandId, { at: Date.now(), value });
  return value;
}

/**
 * The last loaded settings, without awaiting.
 *
 * For the synchronous callers that cannot become async without rewriting half
 * the queue — they render a summary rather than deciding whether to dial, so
 * a value up to CACHE_TTL_MS stale is the right trade.
 */
export function cachedSettings(brandId: string): VillaSettings {
  return cache.get(brandId)?.value ?? defaultSettings(brandId);
}

export function invalidateSettings(brandId?: string): void {
  if (brandId) cache.delete(brandId);
  else cache.clear();
}

export type SettingsValidation =
  | { ok: true; settings: VillaSettings }
  | { ok: false; error: string };

function intInRange(raw: unknown, key: keyof typeof BOUNDS): number | null {
  // Absent is not zero. `Number("")` and `Number(null)` are both 0, and 0 is a
  // legal start hour — so a field the form failed to send would quietly set
  // calling to begin at midnight rather than being refused.
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string" && raw.trim() === "") return null;

  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isInteger(n)) return null;
  const { min, max } = BOUNDS[key];
  return n >= min && n <= max ? n : null;
}

/** Rejects a zone the runtime cannot actually resolve, rather than storing it. */
function validTimeZone(raw: unknown): string | null {
  const tz = typeof raw === "string" ? raw.trim() : "";
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(new Date());
    return tz;
  } catch {
    return null;
  }
}

export function validateSettings(brandId: string, input: Record<string, unknown>): SettingsValidation {
  const out = defaultSettings(brandId);

  for (const key of [
    "callingStartHour",
    "callingEndHour",
    "maxConcurrentCalls",
    "maxAttempts",
    "retryBackoffMinutes",
    "callTimeoutMinutes",
  ] as const) {
    const v = intInRange(input[key], key);
    if (v === null) {
      const { min, max, label } = BOUNDS[key];
      return { ok: false, error: `${label} must be a whole number between ${min} and ${max}.` };
    }
    out[key] = v;
  }

  const tz = validTimeZone(input.callingTimeZone);
  if (!tz) {
    return { ok: false, error: "That is not a time zone this system recognises, e.g. Asia/Kolkata." };
  }
  out.callingTimeZone = tz;

  // The one rule that cannot be expressed per-field: a window that closes
  // before it opens is never satisfied, so the queue would stop dialling
  // altogether and report only that it is outside calling hours.
  if (out.callingStartHour >= out.callingEndHour) {
    return { ok: false, error: "Calls must start before they stop — the end hour has to be later than the start hour." };
  }

  return { ok: true, settings: out };
}

export async function saveSettings(settings: VillaSettings, actor: string): Promise<void> {
  const { error } = await db()
    .from("villa_settings")
    .upsert(
      {
        brand_id: settings.brandId,
        calling_start_hour: settings.callingStartHour,
        calling_end_hour: settings.callingEndHour,
        calling_time_zone: settings.callingTimeZone,
        max_concurrent_calls: settings.maxConcurrentCalls,
        max_attempts: settings.maxAttempts,
        retry_backoff_minutes: settings.retryBackoffMinutes,
        call_timeout_minutes: settings.callTimeoutMinutes,
        updated_at: new Date().toISOString(),
        updated_by: actor,
      },
      { onConflict: "brand_id" },
    );
  if (error) throw new Error(error.message);
  invalidateSettings(settings.brandId);
}
