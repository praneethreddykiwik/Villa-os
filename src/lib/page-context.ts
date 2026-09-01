import { read, resolveBrandId } from "./db";
import { lastNDays, previousRange, type Range } from "./metrics/aggregate";
import type { Database, Brand } from "./types";

export interface PageContext {
  db: Database;
  brand: Brand;
  brandId: string;
  range: Range;
  prev: Range;
  days: number;
}

/**
 * Every page resolves brand + date range the same way, from the query string, so
 * the brand switcher and the 7/30/90 toggle work identically everywhere without
 * each page reimplementing it.
 */
export function pageContext(searchParams: Record<string, string | string[] | undefined>): PageContext {
  const db = read();
  const brandId = resolveBrandId(db, typeof searchParams.brand === "string" ? searchParams.brand : undefined);
  const days = Number(typeof searchParams.range === "string" ? searchParams.range : 30) || 30;
  // "Today" is today. This used to anchor to the newest day present in
  // `dailyStats` so the generated dataset never looked stale — with real data
  // that is a bug, because it silently freezes every range on the last day a
  // sync happened and reports a fortnight-old week as "the last 7 days".
  const range = lastNDays(days, new Date());
  return {
    db,
    brandId,
    brand: db.brands.find((b) => b.id === brandId)!,
    range,
    prev: previousRange(range),
    days,
  };
}

export function qs(searchParams: Record<string, string | string[] | undefined>): string {
  const p = new URLSearchParams();
  if (typeof searchParams.brand === "string") p.set("brand", searchParams.brand);
  if (typeof searchParams.range === "string") p.set("range", searchParams.range);
  const s = p.toString();
  return s ? `?${s}` : "";
}
