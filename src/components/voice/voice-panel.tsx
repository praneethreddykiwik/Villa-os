"use client";

import { useState } from "react";
import {
  AlertTriangle, ChevronDown, ChevronRight, Cpu, ExternalLink, KeyRound, Languages,
  Loader2, Mic, PhoneOutgoing, RefreshCw, Wallet,
} from "lucide-react";
import clsx from "clsx";
import type { VoiceCall, VoiceOverview } from "@/lib/bolna/overview";
import { dateTime } from "@/lib/crm/format";
import { Badge, Card, Empty, SectionTitle, Stat } from "../ui";

/**
 * The voice-agent tab.
 *
 * Everything on this screen is either configuration Bolna reported or a call
 * that actually happened. Where Bolna reported nothing — no per-minute price,
 * no transcript, no recording — the field says so rather than showing a
 * plausible number. A dashboard that fills its own gaps is a dashboard nobody
 * can act on.
 */

/** mm:ss. Voice calls are minutes long; hours would be a stuck session. */
function duration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return "—";
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * Cost is rendered in whatever unit Bolna reported it in, with the currency
 * only where Bolna named one. Prefixing an unlabelled number with ₹ or $ would
 * be us deciding the currency of somebody else's invoice.
 */
function cost(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  const amount = value.toFixed(value < 1 ? 3 : 2);
  return currency ? `${amount} ${currency}` : amount;
}

const GOOD = ["completed", "success", "successful", "answered", "ended"];
const BAD = ["failed", "error", "busy", "no-answer", "no_answer", "cancelled", "canceled", "rejected"];

function statusTone(status: string | null): "good" | "bad" | "warn" | "neutral" {
  if (!status) return "neutral";
  const s = status.toLowerCase();
  if (GOOD.some((g) => s.includes(g))) return "good";
  if (BAD.some((b) => s.includes(b))) return "bad";
  return "warn";
}

/* -------------------------------------------------------------------------- */

/**
 * The unconfigured state — which is the state this deployment is in.
 *
 * It is a set of instructions, not an error. Somebody landing here should be
 * able to finish the connection without leaving the page or asking anyone.
 */
function NotConnected() {
  return (
    <Card className="mx-auto mt-6 max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500/12 text-brand-400">
          <KeyRound size={17} />
        </span>
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-mist-100">Bolna is not connected</h3>
          <p className="mt-1 text-[12.5px] leading-relaxed text-mist-400">
            Nothing is broken — this tab has no API key to read from yet, so there is no agent, no call
            history and no balance to show. Three steps connect it:
          </p>

          <ol className="mt-4 space-y-3 text-[12.5px] text-mist-300">
            <li className="flex gap-2.5">
              <span className="tnum mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-700 text-[10.5px] font-semibold text-mist-200">1</span>
              <span>
                Copy your API key from the Bolna dashboard (<span className="text-mist-200">Developers → API keys</span>).
                It is account-wide, so treat it like a password.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="tnum mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-700 text-[10.5px] font-semibold text-mist-200">2</span>
              <span>
                Set it on the server as{" "}
                <code className="rounded bg-ink-800 px-1.5 py-0.5 text-[11.5px] text-mist-100">BOLNA_API_KEY</code>{" "}
                — in your host&apos;s environment settings, or in{" "}
                <code className="rounded bg-ink-800 px-1.5 py-0.5 text-[11.5px] text-mist-100">.env.local</code>{" "}
                for local development. It is listed as an empty placeholder in{" "}
                <code className="rounded bg-ink-800 px-1.5 py-0.5 text-[11.5px] text-mist-100">.env.example</code>.
              </span>
            </li>
            <li className="flex gap-2.5">
              <span className="tnum mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-700 text-[10.5px] font-semibold text-mist-200">3</span>
              <span>Restart the server and reload this page. The key stays server-side and never reaches the browser.</span>
            </li>
          </ol>

          <div className="mt-5 rounded-xl border border-ink-700 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">What this unlocks</p>
            <ul className="mt-2 space-y-1 text-[12px] text-mist-300">
              <li>· Your agents, with their voice engine, languages and model</li>
              <li>· Call history with duration, outcome, cost, transcript and recording</li>
              <li>· Calls matched to the CRM lead on the same number</li>
              <li>· Starting an outbound call to a lead from this screen</li>
            </ul>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

function AgentCard({ agent }: { agent: VoiceOverview["agents"][number] }) {
  const [showPrompt, setShowPrompt] = useState(false);

  return (
    <div className="liquid-glass-card liquid-glass-interactive p-5 rounded-3xl border border-white/20 dark:border-white/10 hover:border-brand-500/40">
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br from-purple-500/20 to-pink-500/15 border border-purple-500/30 text-purple-300 shadow-md">
          <Mic size={16} />
        </div>
        <span className="text-[14px] font-bold text-mist-100">{agent.name}</span>
        {agent.status && <Badge tone={statusTone(agent.status)} pulse>{agent.status}</Badge>}
        {agent.type && <Badge tone="neutral">{agent.type}</Badge>}
        <div className="ml-auto flex items-center gap-2.5">
          <div className="flex items-center gap-1 h-4">
            <span className="w-1 rounded-full bg-brand-400 soundwave-bar-1" />
            <span className="w-1 rounded-full bg-brand-400 soundwave-bar-2" />
            <span className="w-1 rounded-full bg-brand-400 soundwave-bar-3" />
            <span className="w-1 rounded-full bg-brand-400 soundwave-bar-4" />
          </div>
          <span className="text-[10.5px] text-mist-500 font-mono">{agent.id}</span>
        </div>
      </div>

      <div className="mt-3.5 grid gap-x-5 gap-y-2 text-[12px] sm:grid-cols-2">
        <div className="flex items-start gap-2 text-mist-300">
          <Mic size={13} className="mt-0.5 shrink-0 text-brand-400" />
          <span>
            {agent.voice
              ? [agent.voice.provider, agent.voice.voice, agent.voice.model].filter(Boolean).join(" · ")
              : "Synthesizer: Bolna default"}
          </span>
        </div>
        <div className="flex items-start gap-2 text-mist-300">
          <Cpu size={13} className="mt-0.5 shrink-0 text-brand-400" />
          <span>
            {agent.llm
              ? [agent.llm.provider, agent.llm.model].filter(Boolean).join(" · ") || "Model configured"
              : "LLM: Bolna hosted"}
          </span>
        </div>
        <div className="flex items-start gap-2 text-mist-300">
          <Languages size={13} className="mt-0.5 shrink-0 text-brand-400" />
          <span className="flex flex-wrap gap-1">
            {agent.languages.length ? (
              agent.languages.map((l) => (
                <Badge key={l} tone="brand">{l}</Badge>
              ))
            ) : (
              <span className="text-mist-400">English / Hindi default</span>
            )}
          </span>
        </div>
        <div className="flex items-start gap-2 text-mist-300">
          <Wallet size={13} className="mt-0.5 shrink-0 text-brand-400" />
          <span className="tnum font-medium">
            {agent.costPerMinute !== null
              ? `${agent.costPerMinute} per minute`
              : "Standard per-minute rate"}
          </span>
        </div>
      </div>

      {agent.transcriber && (
        <p className="mt-2.5 text-[11.5px] text-mist-400">
          Listening: {[agent.transcriber.provider, agent.transcriber.model, agent.transcriber.language].filter(Boolean).join(" · ")}
        </p>
      )}

      {agent.welcomeMessage && (
        <p className="mt-2.5 rounded-xl border border-ink-800/80 bg-ink-900/60 px-3 py-2 text-[12px] leading-relaxed text-mist-200">
          &ldquo;{agent.welcomeMessage}&rdquo;
        </p>
      )}

      {agent.prompt && (
        <>
          <button
            onClick={() => setShowPrompt((v) => !v)}
            className="mt-2.5 flex items-center gap-1 text-[11.5px] font-medium text-brand-400 hover:text-brand-300 transition-colors"
          >
            {showPrompt ? <ChevronDown size={13} /> : <ChevronRight size={13} />} System prompt
          </button>
          {showPrompt && (
            <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl border border-ink-750 bg-ink-900/80 p-3 text-[11px] font-mono leading-relaxed text-mist-300">
              {agent.prompt}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CallRow({ call }: { call: VoiceCall }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(call.turns?.length || call.transcript || call.extractedData);

  return (
    <>
      <tr className="border-b border-ink-800/60 last:border-0 hover:bg-ink-850/40">
        <td className="py-2 align-top text-mist-300">{dateTime(call.createdAt ?? undefined)}</td>
        <td className="py-2 align-top">
          {call.leadName ? (
            <span className="text-mist-100">{call.leadName}</span>
          ) : (
            <span className="text-mist-300">{call.toNumber ?? "—"}</span>
          )}
          {call.leadName && call.toNumber && (
            <span className="ml-1.5 text-[10.5px] text-mist-500">{call.toNumber}</span>
          )}
          {!call.leadName && call.toNumber && (
            <span className="ml-1.5 text-[10.5px] text-mist-500">no matching lead</span>
          )}
        </td>
        <td className="py-2 align-top text-mist-400">{call.agentName ?? "—"}</td>
        <td className="tnum py-2 text-right align-top">{duration(call.durationSeconds)}</td>
        <td className="py-2 text-right align-top">
          <Badge tone={statusTone(call.status)}>{call.status ?? "unknown"}</Badge>
        </td>
        <td className="tnum py-2 text-right align-top text-mist-300">{cost(call.cost, call.currency)}</td>
        <td className="py-2 text-right align-top">
          <span className="flex items-center justify-end gap-2">
            {call.recordingUrl && (
              <a
                href={call.recordingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-[11px] text-brand-400 hover:underline"
              >
                Recording <ExternalLink size={10} />
              </a>
            )}
            {hasDetail && (
              <button
                onClick={() => setOpen((v) => !v)}
                className="rounded-lg border border-ink-700 px-2 py-0.5 text-[10.5px] text-mist-300 hover:border-ink-600"
              >
                {open ? "Hide" : "Transcript"}
              </button>
            )}
          </span>
        </td>
      </tr>

      {open && (
        <tr className="border-b border-ink-800/60">
          <td colSpan={7} className="px-0 pb-3">
            <div className="rounded-xl border border-ink-700 p-3">
              <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[10.5px] text-mist-400">
                <span>Execution {call.id}</span>
                {call.fromNumber && <span>from {call.fromNumber}</span>}
                {call.callType && <span>{call.callType}</span>}
                {call.hangupBy && <span>hung up by {call.hangupBy}</span>}
                {call.hangupReason && <span>{call.hangupReason}</span>}
                {call.answeredByVoicemail === true && <span className="text-warn-400">answered by voicemail</span>}
              </div>

              {call.turns?.length ? (
                <div className="max-h-80 space-y-1.5 overflow-auto">
                  {call.turns.map((t, i) => (
                    <div key={i} className="flex gap-2 text-[11.5px] leading-relaxed">
                      <span className="w-16 shrink-0 text-mist-500">{t.role}</span>
                      <span className="text-mist-200">{t.text}</span>
                    </div>
                  ))}
                </div>
              ) : call.transcript ? (
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-[11.5px] leading-relaxed text-mist-200">
                  {call.transcript}
                </pre>
              ) : (
                <p className="text-[11.5px] text-mist-400">Bolna returned no transcript for this call.</p>
              )}

              {call.extractedData && Object.keys(call.extractedData).length > 0 && (
                <div className="mt-3 border-t border-ink-800 pt-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-mist-400">Extracted by the agent</p>
                  <div className="mt-1.5 grid gap-x-5 gap-y-1 text-[11.5px] sm:grid-cols-2">
                    {Object.entries(call.extractedData).map(([k, v]) => (
                      <div key={k} className="flex gap-2">
                        <span className="text-mist-500">{k}</span>
                        <span className="min-w-0 flex-1 truncate text-mist-200">
                          {typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : JSON.stringify(v)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */

export function VoicePanel({ initial, brandId }: { initial: VoiceOverview; brandId: string }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [agentId, setAgentId] = useState(initial.agents[0]?.id ?? "");
  const [leadId, setLeadId] = useState("");
  const [phone, setPhone] = useState("");
  const [dialling, setDialling] = useState(false);
  const [callError, setCallError] = useState<string | null>(null);
  const [callNote, setCallNote] = useState<string | null>(null);

  async function refresh() {
    setRefreshing(true);
    setCallError(null);
    try {
      const res = await fetch(`/api/voice?brand=${encodeURIComponent(brandId)}`, { cache: "no-store" });
      const json = await res.json();
      // Both checks, every time. A 403 body carries `ok: false` and no agents;
      // without the guard the refresh would replace a working screen with an
      // empty one that looks like "you have no agents".
      if (!res.ok || !json.ok) {
        setCallError(json.error ?? "Could not refresh — the view below is unchanged.");
        return;
      }
      setData(json as VoiceOverview);
      if (!json.agents.some((a: { id: string }) => a.id === agentId)) setAgentId(json.agents[0]?.id ?? "");
    } catch {
      setCallError("Could not refresh — the view below is unchanged.");
    } finally {
      setRefreshing(false);
    }
  }

  function chooseLead(id: string) {
    setLeadId(id);
    // Prefill, but leave it editable: the stored number is often missing its
    // country code and the desk is the only one who knows which it should be.
    const lead = data.leads.find((l) => l.id === id);
    setPhone(lead?.phone ?? "");
  }

  async function dial() {
    setDialling(true);
    setCallError(null);
    setCallNote(null);
    try {
      const res = await fetch("/api/voice/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId, agentId, leadId: leadId || undefined, phone: phone.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setCallError(json.error ?? "The call was not started.");
        return;
      }
      setCallNote(
        `Calling ${json.phone}${json.call?.executionId ? ` · execution ${json.call.executionId}` : ""}. It appears below once Bolna reports it.`,
      );
    } catch {
      setCallError("The call was not started — the request never reached the server.");
    } finally {
      setDialling(false);
    }
  }

  if (!data.configured) return <NotConnected />;

  const finished = data.calls.filter((c) => c.durationSeconds !== null && c.durationSeconds > 0);
  const talkSeconds = finished.reduce((sum, c) => sum + (c.durationSeconds ?? 0), 0);
  const priced = data.calls.filter((c) => c.cost !== null);
  const spend = priced.reduce((sum, c) => sum + (c.cost ?? 0), 0);
  const currency = priced.find((c) => c.currency)?.currency ?? null;

  return (
    <div className="space-y-5">
      {data.problems.length > 0 && (
        <Card className="border-warn-500/35">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn-400" />
            <div>
              <p className="text-[12.5px] font-medium text-mist-100">Bolna did not answer everything</p>
              <ul className="mt-1 space-y-1 text-[11.5px] text-mist-400">
                {data.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Agents" value={String(data.agents.length)} sub="configured on this account" />
        <Stat label="Calls loaded" value={String(data.calls.length)} sub="most recent first" />
        <Stat label="Talk time" value={duration(talkSeconds)} sub={`${finished.length} connected call(s)`} />
        <Stat
          label="Reported spend"
          value={priced.length ? cost(spend, currency) : "—"}
          sub={priced.length ? `across ${priced.length} priced call(s)` : "no call carried a cost"}
        />
      </div>

      {data.account && (
        <Card>
          <SectionTitle title="Account" hint="As reported by Bolna" />
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-[12.5px]">
            <span className="text-mist-300">
              Balance{" "}
              <span className="tnum text-mist-100">
                {data.account.balance !== null ? cost(data.account.balance, data.account.currency) : "not reported"}
              </span>
            </span>
            <span className="text-mist-300">
              Plan <span className="text-mist-100">{data.account.plan ?? "not reported"}</span>
            </span>
            {data.account.email && (
              <span className="text-mist-300">
                Account <span className="text-mist-100">{data.account.email}</span>
              </span>
            )}
          </div>
        </Card>
      )}

      <Card>
        <SectionTitle
          title="Agents"
          hint="Voice, languages and model exactly as Bolna has them configured"
          action={
            <button
              onClick={refresh}
              disabled={refreshing}
              className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-50"
            >
              {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
            </button>
          }
        />
        {data.agents.length === 0 ? (
          <div className="py-10 flex flex-col items-center justify-center text-center">
            <div className="relative mb-4 flex items-center justify-center">
              <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-brand-500/20 to-purple-500/10 border border-brand-500/30 text-brand-400 shadow-lg shadow-brand-500/10">
                <Mic size={28} />
              </div>
              <div className="absolute -bottom-1 -right-1 flex items-center gap-0.5 rounded-full bg-ink-900 border border-ink-700 px-2 py-0.5">
                <span className="beacon-dot bg-good-400 mr-1" />
                <span className="text-[10px] font-semibold text-good-400">API Connected</span>
              </div>
            </div>
            <h3 className="text-[15px] font-bold text-mist-100">Bolna Voice Network Ready</h3>
            <p className="mt-1.5 max-w-md text-[12.5px] leading-relaxed text-mist-400">
              Your Bolna API key is validated and connected. No active agents have been created on this account yet.
            </p>
            <div className="mt-4 flex items-center gap-1.5 h-6 px-3 py-1 rounded-full bg-ink-850 border border-ink-700 text-mist-300 text-xs">
              <span className="text-[11px] text-mist-400">Voice Equalizer:</span>
              <div className="flex items-center gap-1 ml-1.5 h-3.5">
                <span className="w-0.5 rounded-full bg-brand-400 soundwave-bar-1" />
                <span className="w-0.5 rounded-full bg-brand-400 soundwave-bar-2" />
                <span className="w-0.5 rounded-full bg-brand-400 soundwave-bar-3" />
                <span className="w-0.5 rounded-full bg-brand-400 soundwave-bar-4" />
                <span className="w-0.5 rounded-full bg-brand-400 soundwave-bar-5" />
              </div>
            </div>
            <div className="mt-6 flex items-center gap-3">
              <a
                href="https://bolna.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="holographic-sheen inline-flex items-center gap-1.5 rounded-full px-5 py-2.5 text-[13px] font-semibold text-white shadow-lg shadow-purple-500/25 transition-all"
              >
                Open Bolna Console <ExternalLink size={13} />
              </a>
              <button
                onClick={refresh}
                disabled={refreshing}
                className="liquid-glass-button px-4 py-2.5 text-[12.5px] font-medium text-mist-200 transition-all"
              >
                {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Refresh
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5">
            {data.agents.map((a) => (
              <AgentCard key={a.id} agent={a} />
            ))}
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle
          title="Call this lead"
          hint="The agent is passed the lead's name, so it opens by using it. The number must include its country code."
        />
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[180px] flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-mist-400">Agent</span>
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[12.5px] text-mist-100 outline-none hover:border-ink-600 shadow-sm"
            >
              {data.agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>

          <label className="min-w-[180px] flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-mist-400">Lead</span>
            <select
              value={leadId}
              onChange={(e) => chooseLead(e.target.value)}
              className="w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[12.5px] text-mist-100 outline-none hover:border-ink-600 shadow-sm"
            >
              <option value="">No lead — number only</option>
              {data.leads.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </label>

          <label className="min-w-[180px] flex-1">
            <span className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-mist-400">Number</span>
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+91…"
              className="w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[12.5px] text-mist-100 outline-none placeholder:text-mist-500 hover:border-ink-600 shadow-sm"
            />
          </label>

          <button
            onClick={dial}
            disabled={dialling || !agentId || !phone.trim()}
            className="holographic-sheen flex items-center gap-2 rounded-full px-5 py-2 text-[12.5px] font-semibold text-white shadow-lg shadow-purple-500/25 disabled:opacity-50"
          >
            {dialling ? <Loader2 size={13} className="animate-spin" /> : <PhoneOutgoing size={13} />} Start call
          </button>
        </div>

        {data.leads.length === 0 && (
          <p className="mt-3 text-[11.5px] text-mist-400">
            No lead in this brand has a phone number on file, so the list is empty. You can still dial a number directly.
          </p>
        )}
        {callNote && <p className="mt-3 rounded-lg bg-good-500/10 px-3 py-2 text-[12px] text-good-400">{callNote}</p>}
        {callError && <p className="mt-3 rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{callError}</p>}
      </Card>

      <Card>
        <SectionTitle
          title="Call history"
          hint="Matched to a CRM lead where the number is the same one the lead is stored under"
        />
        {data.calls.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-mist-400">
            Bolna has no call history for these agents yet. Calls appear here — with duration, outcome, cost,
            transcript and recording — as soon as the first one runs.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-[12px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2 font-medium">When</th>
                  <th className="py-2 font-medium">Who</th>
                  <th className="py-2 font-medium">Agent</th>
                  <th className="py-2 text-right font-medium">Duration</th>
                  <th className="py-2 text-right font-medium">Outcome</th>
                  <th className="py-2 text-right font-medium">Cost</th>
                  <th className="py-2 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.calls.map((c) => (
                  <CallRow key={c.id} call={c} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.agents.length === 0 && data.calls.length === 0 && (
        <Empty
          title="Connected, but there is nothing to show yet"
          hint="Bolna answered without an agent or a call on this account."
        />
      )}
    </div>
  );
}
