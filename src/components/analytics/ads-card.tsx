import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { adTotals } from "@/lib/metrics/aggregate";
import { Card, SectionTitle, fmt } from "@/components/ui";
import type { AdStat } from "@/lib/types";

/**
 * Paid summary, or an honest placeholder. Nothing here is invented: with no
 * adStats rows the card says the space is reserved rather than showing zeros
 * that read like a measured "no spend".
 */
export function AdsCard({ rows, days, link = "" }: { rows: AdStat[]; days: number; link?: string }) {
  const t = adTotals(rows);
  return (
    <Card>
      <SectionTitle
        title="Ads"
        hint={rows.length ? `Paid totals over ${days} days` : "Paid performance"}
        action={<Link href={`/ads${link}`} className="flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100">Manage ads <ArrowUpRight size={12} /></Link>}
      />
      {rows.length === 0 ? (
        <p className="text-[12.5px] leading-relaxed text-mist-400">
          Spend, ROAS and cost per conversion will appear here once an ad account is connected.{" "}
          <Link href={`/connections${link}`} className="text-mist-200 hover:underline">Connect an ad account</Link>
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Cell label="Spend" value={fmt.moneyCompact(t.spend)} />
          <Cell label="ROAS" value={fmt.x(t.roas)} />
          <Cell label="Conversions" value={String(Math.round(t.conversions))} />
          <Cell label="Cost / conv." value={fmt.money(t.cpa)} />
        </div>
      )}
    </Card>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-3">
      <div className="text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">{label}</div>
      <div className="tnum mt-1 text-[18px] font-bold tracking-tight text-mist-100">{value}</div>
    </div>
  );
}
