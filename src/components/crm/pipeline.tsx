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

/**
 * What a pipeline card actually draws.
 *
 * Named fields, not `Lead`, for the same reason the composer names its
 * connection fields: a board that renders no contact details was being handed
 * every lead's phone, email and private notes, and all of it was serialised
 * into the page for anyone with the HTML. Asking for the columns this screen
 * draws means a field added to Lead later is excluded by default.
 */
export type PipelineLead = Pick<
  Lead,
  | "id"
  | "name"
  | "status"
  | "score"
  | "source"
  | "budgetMin"
  | "budgetMax"
  | "projectInterest"
  | "assignedTo"
  | "isHNWI"
  | "kycStatus"
  | "lastContactedAt"
  | "siteVisitAt"
>;

export function Pipeline({ leads }: { leads: PipelineLead[] }) {
  const [rows, setRows] = useState(leads);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<LeadStatus | null>(null);

  const byStage = useMemo(() => {
    const map = new Map<LeadStatus, PipelineLead[]>();
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
    <div className="space-y-4">
      <div className="liquid-glass-pill flex flex-wrap items-center gap-4 px-5 py-3 text-[12px] text-mist-400 shadow-md">
        <span className="flex items-center gap-2">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-good-400 beacon-dot" />
          Weighted forecast{" "}
          <span className="tnum font-bold text-mist-100">{inr(totalWeighted)}</span>
        </span>
        <span className="text-ink-700">|</span>
        <span>
          Gross open{" "}
          <span className="tnum font-bold text-mist-100">
            {inr(rows.filter((l) => !["won", "lost"].includes(l.status)).reduce((a, l) => a + (l.budgetMin + l.budgetMax) / 2, 0))}
          </span>
        </span>
        <span className="text-mist-500 ml-auto hidden md:inline">Drag cards across stages to automatically trigger follow-up schedules.</span>
      </div>

      <div className="flex gap-4 overflow-x-auto pb-6 pt-1">
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
                "liquid-glass-card flex w-[290px] shrink-0 flex-col rounded-3xl p-0 transition-all",
                over === stage.id && "ring-2 ring-brand-500/60 border-brand-500/70 shadow-lg shadow-brand-500/10",
              )}
            >
              <div className="border-b border-ink-800/70 px-4 py-3.5 bg-ink-900/30 rounded-t-3xl">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full ring-2 ring-ink-950" style={{ background: stage.color }} />
                  <span className="truncate text-[12px] font-bold uppercase tracking-wider text-mist-100">{stage.label}</span>
                  <span className="tnum ml-auto rounded-full bg-ink-800/80 px-2 py-0.5 text-[11px] font-semibold text-mist-200">{list.length}</span>
                </div>
                <div className="mt-1.5 flex items-baseline gap-2 text-[11px]">
                  <span className="tnum font-bold text-mist-100">{inr(weighted)}</span>
                  <span className="text-mist-500">weighted · {Math.round(STAGE_PROBABILITY[stage.id] * 100)}%</span>
                  <span className="tnum ml-auto text-mist-400">{inr(gross)}</span>
                </div>
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-3 max-h-[calc(100vh-300px)]">
                {list.map((l) => (
                  <article
                    key={l.id}
                    draggable
                    onDragStart={() => setDrag(l.id)}
                    onDragEnd={() => setDrag(null)}
                    className={clsx(
                      "liquid-glass-card liquid-glass-interactive cursor-grab rounded-2xl p-3.5 border border-white/15 dark:border-white/10 active:cursor-grabbing active:scale-[0.98]",
                      drag === l.id && "drag-ghost opacity-50",
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-ink-800 border border-ink-700/60 text-[10.5px] font-bold text-mist-100">
                        {initials(l.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-bold text-mist-100">{l.name}</span>
                          {l.isHNWI && <Star size={12} className="shrink-0 fill-amber-400 text-amber-400 drop-shadow-sm" />}
                        </div>
                        <div className="truncate text-[11px] text-mist-400">{l.projectInterest}</div>
                      </div>
                      <span className={clsx("tnum rounded px-1.5 py-0.5 text-[10.5px] font-semibold", l.score >= 70 ? "bg-good-500/15 text-good-400" : l.score >= 40 ? "bg-warn-500/15 text-warn-400" : "bg-ink-800 text-mist-500")}>
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
                  <div className="rounded-xl border border-dashed border-ink-800/80 bg-ink-950/20 py-8 text-center text-[11.5px] text-mist-500 hover:border-ink-700/80 transition-colors">
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
