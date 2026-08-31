"use client";

import { useMemo, useState } from "react";
import { CalendarClock, IndianRupee, Star } from "lucide-react";
import clsx from "clsx";
import type { Lead, LeadStatus } from "@/lib/crm/types";
import { LEAD_STATUSES, SOURCE_LABELS } from "@/lib/crm/types";
import { initials, inr, inrRange, relativeDay } from "@/lib/crm/format";
import { Badge } from "../ui";

/**
 * Deal pipeline.
 *
 * Each column header carries the *weighted* value of its stage, not the raw sum.
 * A ₹100 Cr column of brand-new enquiries is not worth ₹100 Cr, and showing it
 * that way is how forecasts end up fiction. Weights are stage close-rates.
 */

/** Probability of closing, by stage. Applied to the midpoint of each budget band. */
const STAGE_PROBABILITY: Record<LeadStatus, number> = {
  new: 0.03,
  contacted: 0.08,
  site_visit_scheduled: 0.2,
  negotiation: 0.45,
  booking_token_paid: 0.85,
  won: 1,
  lost: 0,
};

export function Pipeline({ leads }: { leads: Lead[] }) {
  const [rows, setRows] = useState(leads);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<LeadStatus | null>(null);

  const byStage = useMemo(() => {
    const map = new Map<LeadStatus, Lead[]>();
    for (const s of LEAD_STATUSES) {
      map.set(
        s.id,
        rows.filter((l) => l.status === s.id).sort((a, b) => b.score - a.score),
      );
    }
    return map;
  }, [rows]);

  async function move(leadId: string, status: LeadStatus) {
    const before = rows;
    setRows((r) => r.map((l) => (l.id === leadId ? { ...l, status } : l)));
    const res = await fetch("/api/crm/leads", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leadId, status }),
    });
    const json = await res.json();
    if (!json.ok) setRows(before);
    else setRows((r) => r.map((l) => (l.id === leadId ? json.lead : l)));
  }

  const totalWeighted = rows.reduce(
    (a, l) => a + ((l.budgetMin + l.budgetMax) / 2) * STAGE_PROBABILITY[l.status],
    0,
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-4 text-[12px] text-mist-400">
        <span>
          Weighted forecast{" "}
          <span className="tnum font-semibold text-mist-100">{inr(totalWeighted)}</span>
        </span>
        <span>
          Gross open{" "}
          <span className="tnum font-semibold text-mist-100">
            {inr(rows.filter((l) => !["won", "lost"].includes(l.status)).reduce((a, l) => a + (l.budgetMin + l.budgetMax) / 2, 0))}
          </span>
        </span>
        <span className="text-mist-500">Drag a card to move the deal — milestone dates and follow-ups update automatically.</span>
      </div>

      <div className="flex gap-3 overflow-x-auto pb-2">
        {LEAD_STATUSES.map((stage) => {
          const list = byStage.get(stage.id) ?? [];
          const gross = list.reduce((a, l) => a + (l.budgetMin + l.budgetMax) / 2, 0);
          const weighted = gross * STAGE_PROBABILITY[stage.id];
          return (
            <div
              key={stage.id}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(stage.id);
              }}
              onDragLeave={() => setOver((s) => (s === stage.id ? null : s))}
              onDrop={() => {
                if (drag) void move(drag, stage.id);
                setDrag(null);
                setOver(null);
              }}
              className={clsx(
                "flex w-[280px] shrink-0 flex-col rounded-xl border border-ink-700 bg-ink-900/60",
                over === stage.id && "drop-target",
              )}
            >
              <div className="border-b border-ink-700 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full" style={{ background: stage.color }} />
                  <span className="truncate text-[11.5px] font-semibold uppercase tracking-wider text-mist-100">{stage.label}</span>
                  <span className="tnum ml-auto text-[12px] text-mist-400">{list.length}</span>
                </div>
                <div className="mt-1 flex items-baseline gap-2 text-[10.5px]">
                  <span className="tnum font-semibold text-mist-200">{inr(weighted)}</span>
                  <span className="text-mist-500">weighted · {Math.round(STAGE_PROBABILITY[stage.id] * 100)}%</span>
                  <span className="tnum ml-auto text-mist-400">{inr(gross)}</span>
                </div>
              </div>

              <div className="flex-1 space-y-2 overflow-y-auto p-2">
                {list.map((l) => (
                  <article
                    key={l.id}
                    draggable
                    onDragStart={() => setDrag(l.id)}
                    onDragEnd={() => setDrag(null)}
                    className={clsx(
                      "cursor-grab rounded-xl border border-ink-700 bg-ink-850 p-2.5 active:cursor-grabbing",
                      drag === l.id && "drag-ghost",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-ink-700 text-[9px] font-semibold text-mist-200">
                        {initials(l.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <span className="truncate text-[12.5px] font-semibold text-mist-100">{l.name}</span>
                          {l.isHNWI && <Star size={9} className="shrink-0 fill-warn-400 text-warn-400" />}
                        </div>
                        <div className="truncate text-[10.5px] text-mist-400">{l.projectInterest}</div>
                      </div>
                      <span className={clsx("tnum text-[11px] font-semibold", l.score >= 70 ? "text-good-400" : l.score >= 40 ? "text-warn-400" : "text-mist-500")}>
                        {l.score}
                      </span>
                    </div>

                    <div className="mt-2 flex items-center gap-1 text-[11px] font-medium text-mist-200">
                      <IndianRupee size={10} className="text-mist-400" />
                      {inrRange(l.budgetMin, l.budgetMax).replace("₹", "")}
                    </div>

                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      <Badge tone="neutral">{SOURCE_LABELS[l.source]}</Badge>
                      {l.kycStatus === "verified" && <Badge tone="good">KYC</Badge>}
                      {l.kycStatus === "pending" && <Badge tone="warn">KYC pending</Badge>}
                    </div>

                    {l.siteVisitAt && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10.5px] text-mist-400">
                        <CalendarClock size={9} /> Site visit {relativeDay(l.siteVisitAt)}
                      </div>
                    )}
                    <div className="mt-1 text-[10px] text-mist-500">
                      {l.assignedTo} · touched {l.lastContactedAt ? relativeDay(l.lastContactedAt) : "never"}
                    </div>
                  </article>
                ))}
                {!list.length && (
                  <div className="rounded-xl border border-dashed border-ink-700 py-8 text-center text-[11.5px] text-mist-500">
                    Drop a deal here
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
