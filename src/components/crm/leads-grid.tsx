"use client";

import { useMemo, useState } from "react";
import { ArrowUpDown, Filter, Phone, Search, Star, X } from "lucide-react";
import clsx from "clsx";
import type { Broker, Lead, LeadSource, LeadStatus } from "@/lib/crm/types";
import { BUDGET_BANDS, KYC_LABELS, LEAD_STATUSES, SOURCE_LABELS } from "@/lib/crm/types";
import { initials, inrRange, relativeDay, shortDate } from "@/lib/crm/format";
import { Badge, Card } from "../ui";

/**
 * Unified leads grid.
 *
 * The filter that matters most here is **budget**, and it is a range-vs-range
 * problem, not equality: a lead states ₹4–7 Cr, the filter asks for ₹5–10 Cr,
 * and the right answer is "yes, they overlap". Filtering on a midpoint would
 * silently hide half the qualifying pipeline.
 */

type SortKey = "score" | "budget" | "created" | "lastContacted";

export function LeadsGrid({ leads, brokers }: { leads: Lead[]; brokers: Broker[] }) {
  const [rows, setRows] = useState(leads);
  const [statuses, setStatuses] = useState<LeadStatus[]>([]);
  const [bands, setBands] = useState<string[]>([]);
  const [sources, setSources] = useState<LeadSource[]>([]);
  const [brokerId, setBrokerId] = useState<string>("");
  const [hnwiOnly, setHnwiOnly] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<SortKey>("score");
  const [busy, setBusy] = useState<string | null>(null);

  const brokerName = useMemo(() => Object.fromEntries(brokers.map((b) => [b.id, b])), [brokers]);

  const filtered = useMemo(() => {
    const selectedBands = BUDGET_BANDS.filter((b) => bands.includes(b.id));
    return rows
      .filter((l) => {
        if (statuses.length && !statuses.includes(l.status)) return false;
        if (sources.length && !sources.includes(l.source)) return false;
        if (brokerId && l.brokerId !== brokerId) return false;
        if (hnwiOnly && !l.isHNWI) return false;
        if (selectedBands.length) {
          // Range overlap, not midpoint containment.
          const hit = selectedBands.some((b) => l.budgetMax >= b.min && l.budgetMin <= b.max);
          if (!hit) return false;
        }
        if (q) {
          const hay = `${l.name} ${l.phone} ${l.email ?? ""} ${l.city} ${l.projectInterest} ${l.unitType}`.toLowerCase();
          if (!hay.includes(q.toLowerCase())) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Closed deals sink regardless of sort key: a won lead scores 100 and
        // would otherwise sit permanently at the top of a list whose purpose is
        // showing the team what to work on next.
        const aClosed = a.status === "won" || a.status === "lost";
        const bClosed = b.status === "won" || b.status === "lost";
        if (aClosed !== bClosed) return aClosed ? 1 : -1;
        if (sort === "score") return b.score - a.score;
        if (sort === "budget") return b.budgetMax - a.budgetMax;
        if (sort === "created") return b.createdAt.localeCompare(a.createdAt);
        return (b.lastContactedAt ?? "").localeCompare(a.lastContactedAt ?? "");
      });
  }, [rows, statuses, bands, sources, brokerId, hnwiOnly, q, sort]);

  const pipelineValue = filtered
    .filter((l) => !["won", "lost"].includes(l.status))
    .reduce((a, l) => a + (l.budgetMin + l.budgetMax) / 2, 0);

  async function move(leadId: string, status: LeadStatus) {
    setBusy(leadId);
    try {
      const res = await fetch("/api/crm/leads", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ leadId, status }),
      });
      const json = await res.json();
      if (json.ok) setRows((r) => r.map((l) => (l.id === leadId ? json.lead : l)));
    } finally {
      setBusy(null);
    }
  }

  function toggle<T>(list: T[], value: T, set: (v: T[]) => void) {
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  }

  const activeFilters = statuses.length + bands.length + sources.length + (brokerId ? 1 : 0) + (hnwiOnly ? 1 : 0);

  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, phone, project…"
              className="w-full rounded-lg border border-ink-700 bg-ink-850 py-2 pl-8 pr-3 text-[12.5px] outline-none placeholder:text-mist-500 focus:border-brand-500"
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[12px] outline-none"
          >
            <option value="score">Sort: Lead score</option>
            <option value="budget">Sort: Budget</option>
            <option value="created">Sort: Newest</option>
            <option value="lastContacted">Sort: Last contacted</option>
          </select>
          {activeFilters > 0 && (
            <button
              onClick={() => {
                setStatuses([]); setBands([]); setSources([]); setBrokerId(""); setHnwiOnly(false);
              }}
              className="flex items-center gap-1 rounded-lg border border-ink-700 px-2.5 py-2 text-[12px] text-mist-300 hover:text-mist-100"
            >
              <X size={12} /> Clear {activeFilters}
            </button>
          )}
        </div>

        <div className="space-y-2.5 border-t border-ink-700 pt-3">
          <FilterRow label="Status">
            {LEAD_STATUSES.map((s) => (
              <Chip key={s.id} active={statuses.includes(s.id)} onClick={() => toggle(statuses, s.id, setStatuses)} dot={s.color}>
                {s.label}
                <span className="tnum ml-1 opacity-60">{rows.filter((l) => l.status === s.id).length}</span>
              </Chip>
            ))}
          </FilterRow>

          <FilterRow label="Budget">
            {BUDGET_BANDS.map((b) => (
              <Chip key={b.id} active={bands.includes(b.id)} onClick={() => toggle(bands, b.id, setBands)}>
                {b.label}
              </Chip>
            ))}
          </FilterRow>

          <FilterRow label="Source">
            {(Object.keys(SOURCE_LABELS) as LeadSource[]).map((s) => (
              <Chip key={s} active={sources.includes(s)} onClick={() => toggle(sources, s, setSources)}>
                {SOURCE_LABELS[s]}
              </Chip>
            ))}
          </FilterRow>

          <FilterRow label="Broker">
            <select
              value={brokerId}
              onChange={(e) => setBrokerId(e.target.value)}
              className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-1 text-[11.5px] outline-none"
            >
              <option value="">Any broker</option>
              {brokers.map((b) => (
                <option key={b.id} value={b.id}>{b.name} · {b.firm}</option>
              ))}
            </select>
            <Chip active={hnwiOnly} onClick={() => setHnwiOnly((v) => !v)}>
              <Star size={10} /> HNWI only
            </Chip>
          </FilterRow>
        </div>

        <div className="flex flex-wrap items-center gap-4 border-t border-ink-700 pt-3 text-[11.5px] text-mist-400">
          <span><span className="tnum font-semibold text-mist-100">{filtered.length}</span> of {rows.length} leads</span>
          <span>Open pipeline value <span className="tnum font-semibold text-mist-100">{inrRange(pipelineValue, pipelineValue)}</span></span>
          <span>HNWI <span className="tnum font-semibold text-mist-100">{filtered.filter((l) => l.isHNWI).length}</span></span>
          <span>Broker-sourced <span className="tnum font-semibold text-mist-100">{filtered.filter((l) => l.brokerId).length}</span></span>
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[1000px] text-[12px]">
          <thead>
            <tr className="border-b border-ink-700 text-left text-[10px] uppercase tracking-wider text-mist-400">
              <th className="px-4 py-2.5 font-medium">Lead</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 font-medium">Budget</th>
              <th className="px-3 py-2.5 font-medium">Project / Unit</th>
              <th className="px-3 py-2.5 font-medium">Source</th>
              <th className="px-3 py-2.5 font-medium">Broker</th>
              <th className="px-3 py-2.5 font-medium">KYC</th>
              <th className="px-3 py-2.5 font-medium">Owner</th>
              <th className="px-3 py-2.5 text-right font-medium">
                <span className="inline-flex items-center gap-1"><ArrowUpDown size={10} /> Score</span>
              </th>
              <th className="px-4 py-2.5 text-right font-medium">Last touch</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((l) => {
              const status = LEAD_STATUSES.find((s) => s.id === l.status)!;
              const broker = l.brokerId ? brokerName[l.brokerId] : undefined;
              return (
                <tr key={l.id} className={clsx("border-b border-ink-700/60 last:border-0 hover:bg-ink-850/50", busy === l.id && "opacity-50")}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-2.5">
                      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink-700 text-[10px] font-semibold text-mist-200">
                        {initials(l.name)}
                      </span>
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="truncate font-medium text-mist-100">{l.name}</span>
                          {l.isHNWI && <Star size={10} className="shrink-0 fill-warn-400 text-warn-400" />}
                        </span>
                        <span className="flex items-center gap-1 text-[10.5px] text-mist-400">
                          <Phone size={9} /> {l.phone} · {l.city}
                        </span>
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <select
                      value={l.status}
                      onChange={(e) => move(l.id, e.target.value as LeadStatus)}
                      className="rounded-md border border-ink-700 bg-ink-850 px-1.5 py-1 text-[11px] outline-none"
                      style={{ color: status.color }}
                    >
                      {LEAD_STATUSES.map((s) => (
                        <option key={s.id} value={s.id} className="text-mist-100">{s.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="tnum px-3 py-2.5 font-medium text-mist-200">{inrRange(l.budgetMin, l.budgetMax)}</td>
                  <td className="px-3 py-2.5">
                    <div className="text-mist-200">{l.projectInterest}</div>
                    <div className="text-[10.5px] text-mist-400">{l.unitType}</div>
                  </td>
                  <td className="px-3 py-2.5 text-mist-300">{SOURCE_LABELS[l.source]}</td>
                  <td className="px-3 py-2.5">
                    {broker ? (
                      <span className="text-mist-300">
                        {broker.name}
                        <span className="block text-[10px] text-mist-400">{broker.firm} · {broker.commissionPct}%</span>
                      </span>
                    ) : (
                      <span className="text-mist-500">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={l.kycStatus === "verified" ? "good" : l.kycStatus === "pending" ? "warn" : l.kycStatus === "rejected" ? "bad" : "neutral"}>
                      {KYC_LABELS[l.kycStatus]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-mist-300">{l.assignedTo}</td>
                  <td className="px-3 py-2.5 text-right">
                    <span className={clsx("tnum font-semibold", l.score >= 70 ? "text-good-400" : l.score >= 40 ? "text-warn-400" : "text-mist-400")}>
                      {l.score}
                    </span>
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-mist-400">
                    {l.lastContactedAt ? relativeDay(l.lastContactedAt) : <span className="text-bad-400">never</span>}
                    <span className="block text-[10px]">added {shortDate(l.createdAt)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && (
          <p className="px-4 py-10 text-center text-[12.5px] text-mist-400">
            No leads match these filters. <button onClick={() => { setStatuses([]); setBands([]); setSources([]); setBrokerId(""); setHnwiOnly(false); setQ(""); }} className="text-brand-400 underline">Clear them</button>.
          </p>
        )}
      </Card>
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="flex w-16 shrink-0 items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-mist-400">
        <Filter size={9} /> {label}
      </span>
      {children}
    </div>
  );
}

function Chip({
  active,
  onClick,
  dot,
  children,
}: {
  active: boolean;
  onClick: () => void;
  dot?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition-colors",
        active ? "border-brand-500 bg-brand-500/12 text-mist-100" : "border-ink-700 text-mist-300 hover:border-ink-600",
      )}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: dot }} />}
      {children}
    </button>
  );
}
