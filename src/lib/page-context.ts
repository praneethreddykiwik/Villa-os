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
  // "Today" is the newest day present in the data, so demo data never looks stale.
  const latest = db.dailyStats.reduce((a, s) => (s.date > a ? s.date : a), "2026-01-01");
  const range = lastNDays(days, new Date(`${latest}T12:00:00Z`));
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
