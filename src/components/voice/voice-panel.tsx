"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronRight, ExternalLink, Loader2, Mic, PhoneIncoming, PhoneMissed,
  PhoneOutgoing, RefreshCw, Settings2, User, X,
} from "lucide-react";
import clsx from "clsx";
import type { VoiceClientCall, VoiceOverview } from "@/lib/voice/overview";
import { dateTime } from "@/lib/crm/format";
import { Badge, Card, LiquidSegmentedControl, SectionTitle, Stat } from "../ui";

/**
 * Voice agent — the client's view.
 *
 * Calls, what was said, what was captured, and what became of it. No vendor,
 * no model, no cost: those live in the admin-only diagnostics block at the
 * bottom, which the server includes only for users.manage.
 */

type Range = "7" | "30" | "90";

/** "4 min 12 s" — spoken, because the table is read by sales, not engineers. */
function spoken(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "—";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

const OUTCOME: Record<VoiceClientCall["outcome"], { label: string; tone: "good" | "bad" | "warn" | "neutral" }> = {
  completed: { label: "Spoke", tone: "good" },
  no_answer: { label: "No answer", tone: "warn" },
  failed: { label: "Failed", tone: "bad" },
  in_progress: { label: "In progress", tone: "neutral" },
};

function DirectionIcon({ call }: { call: VoiceClientCall }) {
  if (call.outcome === "no_answer" || call.outcome === "failed") return <PhoneMissed size={13} className="text-warn-400" />;
  return call.direction === "inbound"
    ? <PhoneIncoming size={13} className="text-brand-400" />
    : <PhoneOutgoing size={13} className="text-brand-400" />;
}

function callerLabel(call: VoiceClientCall): string {
  return call.leadName ?? call.customerName ?? call.callerPhone ?? "Unknown caller";
}

/* -------------------------------------------------------------------------- */

function Drawer({ call, onClose }: { call: VoiceClientCall; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fields = Object.entries(call.extracted);

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <button type="button" aria-label="Close" onClick={onClose} className="flex-1 bg-black/40 backdrop-blur-[2px]" />
      <aside className="flex h-full w-full max-w-xl flex-col overflow-hidden border-l border-ink-800 bg-ink-950 shadow-2xl">
        <header className="flex items-start gap-3 border-b border-ink-800 p-5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-brand-500/12 text-brand-300">
            <DirectionIcon call={call} />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold text-mist-100">{callerLabel(call)}</h3>
            <p className="tnum mt-0.5 text-[12px] text-mist-400">
              {call.callerPhone ?? "Number withheld"} · {dateTime(call.startedAt)} · {spoken(call.durationSec)}
            </p>
          </div>
          <Badge tone={OUTCOME[call.outcome].tone}>{OUTCOME[call.outcome].label}</Badge>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-mist-400 hover:bg-ink-800 hover:text-mist-100">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <section className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-xl border border-ink-800 p-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-mist-400">Customer</p>
              {call.customerId ? (
                <a href={`/ops/customers/${call.customerId}`} className="mt-1 flex items-center gap-1.5 text-[12.5px] text-brand-300 hover:underline">
                  <User size={12} /> {call.customerName ?? "Open profile"}
                </a>
              ) : (
                <p className="mt-1 text-[12.5px] text-mist-400">Not linked</p>
              )}
            </div>
            <div className="rounded-xl border border-ink-800 p-3">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-mist-400">Lead</p>
              {call.leadId ? (
                <a href={`/crm/leads?highlight=${call.leadId}`} className="mt-1 flex items-center gap-1.5 text-[12.5px] text-brand-300 hover:underline">
                  <ExternalLink size={12} /> {call.leadName ?? "Open lead"}
                  {call.leadCreated && <Badge tone="brand">new from this call</Badge>}
                </a>
              ) : (
                <p className="mt-1 text-[12.5px] text-mist-400">
                  {call.outcome === "completed" ? "No buying intent detected" : "Call was not answered"}
                </p>
              )}
            </div>
          </section>

          {call.summary && (
            <section className="rounded-xl border border-ink-800 bg-ink-900/50 p-3.5 text-[12.5px] leading-relaxed text-mist-200">
              <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-mist-400">Summary</p>
              {call.summary}
            </section>
          )}

          {fields.length > 0 && (
            <section>
              <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-mist-400">Captured on the call</p>
              <dl className="divide-y divide-ink-800 rounded-xl border border-ink-800">
                {fields.map(([k, v]) => (
                  <div key={k} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)] gap-3 px-3 py-2 text-[12px]">
                    <dt className="truncate text-mist-400">{k}</dt>
                    <dd className="text-mist-100">{v}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-[10.5px] font-semibold uppercase tracking-wider text-mist-400">Transcript</p>
              {call.recordingUrl && (
                <a href={call.recordingUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-[11.5px] text-brand-300 hover:underline">
                  <Mic size={12} /> Listen to recording
                </a>
              )}
            </div>
            {call.turns.length ? (
              <ol className="space-y-2.5">
                {call.turns.map((t, i) => (
                  <li key={i} className={clsx("flex", t.role === "agent" ? "justify-start" : "justify-end")}>
                    <div
                      className={clsx(
                        "max-w-[85%] rounded-2xl px-3.5 py-2 text-[12.5px] leading-relaxed",
                        t.role === "agent" ? "rounded-tl-sm bg-ink-800/80 text-mist-200" : "rounded-tr-sm bg-brand-500/15 text-mist-100",
                      )}
                    >
                      <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wider text-mist-400">
                        {t.role === "agent" ? "Voice agent" : "Caller"}
                      </span>
                      {t.text}
                    </div>
                  </li>
                ))}
              </ol>
            ) : call.transcript ? (
              <pre className="whitespace-pre-wrap rounded-xl bg-ink-900/60 p-3 text-[12px] leading-relaxed text-mist-200">{call.transcript}</pre>
            ) : (
              <p className="text-[12px] text-mist-400">
                {call.outcome === "in_progress" ? "The transcript arrives when the call ends." : "No transcript for this call."}
              </p>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Funnel({ f }: { f: VoiceOverview["funnel"] }) {
  const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Stat label="Calls" value={String(f.calls)} sub={`${f.answered} answered`} />
      <Stat label="Answered" value={String(f.answered)} sub={`${pct(f.answered, f.calls)}% of calls`} sparkProgress={pct(f.answered, f.calls)} />
      <Stat label="Leads" value={String(f.leads)} sub={`${pct(f.leads, f.answered)}% of answered`} sparkProgress={pct(f.leads, f.answered)} />
      <Stat label="Site visits" value={String(f.siteVisits)} sub={`${pct(f.siteVisits, f.leads)}% of leads`} sparkProgress={pct(f.siteVisits, f.leads)} />
    </div>
  );
}

/** Admin only — the server omits `diagnostics` for everyone else. */
function ProviderDiagnostics({ d }: { d: NonNullable<VoiceOverview["diagnostics"]> }) {
  const [open, setOpen] = useState(false);
  const rows: Array<[string, string, boolean]> = [
    ["Provider", d.provider, true],
    ["API key", d.apiKey ? "set" : "unset", d.apiKey],
    ["Agent id", d.agentId ?? "unset — settings will not push live", Boolean(d.agentId)],
    ["Webhook secret", d.webhookSecret ? "set" : "unset — inbound updates are refused", d.webhookSecret],
    ["Connection", d.status, d.apiKey && d.agentCount !== null],
    ["Balance", d.balance ?? "not reported", true],
    ["Spend (logged calls)", d.spend === null ? "not reported" : d.spend.toFixed(2), true],
  ];
  return (
    <Card variant="panel" className="border-dashed">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left">
        {open ? <ChevronDown size={14} className="text-mist-400" /> : <ChevronRight size={14} className="text-mist-400" />}
        <Settings2 size={14} className="text-mist-400" />
        <span className="text-[13px] font-semibold text-mist-200">Provider diagnostics</span>
        <span className="text-[11px] text-mist-500">administrators only</span>
      </button>
      {open && (
        <div className="mt-4 space-y-3">
          <dl className="grid gap-2 sm:grid-cols-2">
            {rows.map(([k, v, ok]) => (
              <div key={k} className="flex items-start gap-3 rounded-lg border border-ink-800 p-2.5">
                <Badge tone={ok ? "good" : "warn"} className="shrink-0">{ok ? "ok" : "check"}</Badge>
                <div className="min-w-0">
                  <dt className="text-[11px] text-mist-400">{k}</dt>
                  <dd className="break-all text-[12px] text-mist-100">{v}</dd>
                </div>
              </div>
            ))}
          </dl>
          {d.problems.length > 0 && (
            <ul className="space-y-1 rounded-lg border border-warn-500/30 bg-warn-500/10 p-3 text-[12px] text-warn-300">
              {d.problems.map((p, i) => (
                <li key={i} className="flex gap-2"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> {p}</li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-mist-500">Setup steps are in docs/voice-setup.md.</p>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

export function VoicePanel({ initial, brandId, canEditSettings }: { initial: VoiceOverview; brandId: string; canEditSettings: boolean }) {
  const [data, setData] = useState(initial);
  const [range, setRange] = useState<Range>(String(initial.days) as Range);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<VoiceClientCall | null>(null);

  async function load(days: Range) {
    setLoading(true);
    try {
      const res = await fetch(`/api/voice?brand=${encodeURIComponent(brandId)}&range=${days}`);
      const json = await res.json();
      if (res.ok && json.ok) setData(json.overview);
    } catch {
      /* keep the previous paint */
    } finally {
      setLoading(false);
    }
  }

  function changeRange(next: Range) {
    setRange(next);
    void load(next);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight text-mist-100">
            Voice agent
            <Badge tone={data.connected ? "good" : "warn"} pulse={data.connected}>{data.connected ? "Live" : "Not connected"}</Badge>
          </h2>
          <p className="mt-1 text-xs text-mist-400">Every call the agent handled, what was said, and what it turned into.</p>
        </div>
        <div className="flex items-center gap-2">
          <LiquidSegmentedControl<Range>
            options={[{ id: "7", label: "7 days" }, { id: "30", label: "30 days" }, { id: "90", label: "90 days" }]}
            value={range}
            onChange={changeRange}
          />
          <button
            type="button"
            onClick={() => load(range)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-[12px] text-mist-200 transition-colors hover:border-ink-600"
          >
            {loading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
          </button>
          {canEditSettings && (
            <a href={`/voice/settings?brand=${encodeURIComponent(brandId)}`} className="flex items-center gap-1.5 rounded-full border border-brand-500/40 bg-brand-500/15 px-3 py-1.5 text-[12px] font-medium text-brand-300 hover:bg-brand-500/25">
              <Settings2 size={13} /> Agent settings
            </a>
          )}
        </div>
      </div>

      <Funnel f={data.funnel} />

      <Card>
        <SectionTitle title="Calls" hint={`Last ${data.days} days · newest first`} />
        {data.calls.length === 0 ? (
          <p className="py-10 text-center text-[12.5px] text-mist-400">
            {data.connected
              ? "No calls in this period yet. They appear here as soon as the agent finishes one."
              : "The voice agent is not connected yet. An administrator can finish setup from the diagnostics below."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[12px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2.5 font-medium">When</th>
                  <th className="py-2.5 font-medium">Caller</th>
                  <th className="py-2.5 text-right font-medium">Duration</th>
                  <th className="py-2.5 text-right font-medium">Outcome</th>
                  <th className="py-2.5 text-right font-medium">Lead</th>
                  <th className="py-2.5 text-right font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => setSelected(c)}
                    className="cursor-pointer border-b border-ink-800/60 transition-colors hover:bg-ink-850/40"
                  >
                    <td className="py-2.5 text-mist-400">{dateTime(c.startedAt)}</td>
                    <td className="py-2.5">
                      <div className="flex items-center gap-2">
                        <DirectionIcon call={c} />
                        <div>
                          <span className="font-medium text-mist-100">{callerLabel(c)}</span>
                          {(c.leadName || c.customerName) && c.callerPhone && (
                            <span className="tnum block text-[11px] text-mist-400">{c.callerPhone}</span>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="tnum py-2.5 text-right text-mist-200">{spoken(c.durationSec)}</td>
                    <td className="py-2.5 text-right"><Badge tone={OUTCOME[c.outcome].tone}>{OUTCOME[c.outcome].label}</Badge></td>
                    <td className="py-2.5 text-right">
                      {c.leadId ? <Badge tone="brand">{c.leadCreated ? "New lead" : "Existing lead"}</Badge>
                      : c.intent === "callback" ? <Badge tone="warn">Callback</Badge>
                      : <span className="text-mist-500">—</span>}
                    </td>
                    <td className="py-2.5 text-right text-mist-400"><ChevronRight size={14} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.diagnostics && <ProviderDiagnostics d={data.diagnostics} />}

      {selected && <Drawer call={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
