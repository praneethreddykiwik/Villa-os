"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Phone, PhoneOff, PlayCircle, Clock, X, Users } from "lucide-react";

/**
 * THE OUTBOUND CALL QUEUE.
 *
 * Numbers go in here; the agent works through them. The screen deliberately
 * shows the unglamorous parts — what failed, what is waiting out a retry, and
 * why nothing is dialling — because a queue that only ever reports success is
 * one nobody notices has stalled.
 */

type Status = "queued" | "calling" | "done" | "failed" | "cancelled";

interface Entry {
  id: string;
  phone: string;
  name: string | null;
  status: Status;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  notBefore: string | null;
  updatedAt: string;
}

interface Summary {
  entries: Entry[];
  counts: Record<Status, number>;
  callingNow: boolean;
  withinCallingHours: boolean;
  note: string | null;
  configured?: boolean;
}

const STATUS_STYLE: Record<Status, string> = {
  queued: "border-ink-700 bg-ink-850 text-mist-300",
  calling: "border-brand-500/40 bg-brand-500/15 text-brand-300",
  done: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  failed: "border-amber-500/30 bg-amber-500/10 text-amber-300",
  cancelled: "border-ink-700 bg-ink-850 text-mist-500",
};

const STATUS_LABEL: Record<Status, string> = {
  queued: "Waiting",
  calling: "On the call",
  done: "Called",
  failed: "Not reached",
  cancelled: "Cancelled",
};

function whenLocal(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function CallQueue({ brandId, onChange }: { brandId: string; onChange?: () => void }) {
  const [data, setData] = useState<Summary | null>(null);
  const [numbers, setNumbers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [leads, setLeads] = useState<{ id: string; name: string | null; phone: string; source: string | null }[]>([]);
  const [leadsNote, setLeadsNote] = useState("");
  const [showLeads, setShowLeads] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/voice/queue?brand=${encodeURIComponent(brandId)}`);
      const json = await res.json();
      if (json.ok) setData(json);
    } catch {
      /* the panel keeps showing the last good state rather than blanking */
    }
  }, [brandId]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a call is live the run is changing under the operator; once it is
  // idle there is nothing to poll for and the interval is dropped.
  useEffect(() => {
    if (!data?.callingNow && !(data?.counts.queued ?? 0)) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [data?.callingNow, data?.counts.queued, load]);

  /**
   * Leads we already hold a number for — including the ones typed into an
   * Instagram DM, which the platform never gives us and which used to be
   * unreachable by phone.
   */
  async function loadLeads() {
    setShowLeads(true);
    setLeadsNote("");
    try {
      const res = await fetch(`/api/voice/queue/leads?brand=${encodeURIComponent(brandId)}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || "Could not load leads.");
      setLeads(json.leads);
      if (json.unavailable) setLeadsNote(json.unavailable);
      else if (json.leads.length === 0) setLeadsNote("No leads with a phone number that are not already queued.");
    } catch (e) {
      setLeadsNote((e as Error).message);
    }
  }

  /** Append to the box rather than queueing directly — the operator still sees
   *  exactly who is about to be called before anything rings. */
  function addLead(phone: string) {
    setNumbers((n) => (n.trim() ? `${n.trim()}\n${phone}` : phone));
    setLeads((ls) => ls.filter((l) => l.phone !== phone));
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/voice/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId, phones: numbers }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Could not queue those numbers.");

      // apiOk spreads its payload alongside `ok` — there is no `data`
      // wrapper. Reading one threw before a single number was queued.
      const { added, rejected, pumped } = json;
      setData(json.queue);
      setNumbers("");

      const parts: string[] = [`${added.length} number${added.length === 1 ? "" : "s"} queued.`];
      if (pumped?.dialled > 0) parts.push("Calling the first one now.");
      else if (pumped?.idle) parts.push(pumped.idle[0].toUpperCase() + pumped.idle.slice(1) + ".");
      // Named individually: "3 rejected" makes the operator diff two lists by
      // hand to find out which of their numbers never got called.
      if (rejected.length > 0) {
        parts.push(
          `Skipped ${rejected.map((r: { phone: string; reason: string }) => `${r.phone} (${r.reason})`).join(", ")}.`,
        );
      }
      setNotice(parts.join(" "));
      onChange?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      const res = await fetch("/api/voice/queue", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId, ids: [id] }),
      });
      const json = await res.json();
      if (json.ok) setData(json.queue);
    } catch {
      /* the row stays as it was; the operator can try again */
    }
  }

  const counts = data?.counts;
  const pending = (counts?.queued ?? 0) + (counts?.calling ?? 0);

  return (
    <div className="space-y-4">
      <form onSubmit={add} className="space-y-2">
        <label htmlFor="queue-numbers" className="block text-[11px] font-semibold uppercase tracking-wider text-mist-400">
          Numbers to call
        </label>
        <textarea
          id="queue-numbers"
          rows={3}
          value={numbers}
          onChange={(e) => setNumbers(e.target.value)}
          placeholder={"+919876543210\n+919812345678"}
          className="w-full rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 font-mono text-[12.5px] text-mist-100 placeholder:text-mist-600 focus:border-brand-500 focus:outline-none"
        />
        <p className="text-[11px] text-mist-500">
          One per line, or separated by commas. Country code required — the agent never guesses one.
        </p>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={busy || !numbers.trim()}
            className="flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? <Loader2 size={13} className="animate-spin" /> : <PlayCircle size={13} />}
            Queue and start calling
          </button>
          <button
            type="button"
            onClick={() => void loadLeads()}
            className="flex items-center gap-1.5 rounded-full border border-ink-700 bg-ink-850 px-3 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
          >
            <Users size={13} /> Add from leads
          </button>
          {pending > 0 && (
            <span className="text-[11.5px] text-mist-400">
              {pending} waiting{data?.callingNow ? " · one on a call now" : ""}
            </span>
          )}
        </div>
      </form>

      {showLeads && (
        <div className="rounded-xl border border-ink-800 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-medium text-mist-200">Leads with a phone number</span>
            <button type="button" onClick={() => setShowLeads(false)} className="text-mist-500 hover:text-mist-200">
              <X size={13} />
            </button>
          </div>
          {leadsNote && <p className="text-[12px] text-mist-400">{leadsNote}</p>}
          {leads.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto">
              {leads.map((l) => (
                <li key={l.id} className="flex items-center gap-2 text-[12.5px]">
                  <button
                    type="button"
                    onClick={() => addLead(l.phone)}
                    className="rounded-full border border-ink-700 px-2 py-0.5 text-[11px] text-mist-300 hover:border-brand-500/50 hover:text-brand-300"
                  >
                    Add
                  </button>
                  <span className="font-mono text-mist-100">{l.phone}</span>
                  <span className="truncate text-mist-400">{l.name ?? "Unnamed"}</span>
                  {l.source && <span className="ml-auto text-[11px] text-mist-500">{l.source}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="text-[12px] text-amber-300">{error}</p>}
      {notice && <p className="text-[12px] text-mist-300">{notice}</p>}
      {data?.note && (
        <p className="flex items-start gap-1.5 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] text-mist-300">
          <Clock size={13} className="mt-0.5 shrink-0" /> {data.note}
        </p>
      )}
      {data && data.configured === false && (
        <p className="text-[12px] text-amber-300">
          The voice agent is not connected, so nothing will be dialled until an administrator configures it.
        </p>
      )}

      {data && data.entries.length > 0 && (
        <ul className="divide-y divide-ink-800 rounded-xl border border-ink-800">
          {data.entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-3 py-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10.5px] font-medium ${STATUS_STYLE[e.status]}`}>
                {STATUS_LABEL[e.status]}
              </span>
              <span className="font-mono text-[12.5px] text-mist-100">{e.phone}</span>
              {e.name && <span className="truncate text-[12px] text-mist-400">{e.name}</span>}
              <span className="ml-auto flex items-center gap-3 text-[11px] text-mist-500">
                {e.attempts > 1 && <span>attempt {e.attempts}</span>}
                {e.notBefore && e.status === "queued" && <span>retry after {whenLocal(e.notBefore)}</span>}
                {e.lastError && <span className="max-w-[18rem] truncate text-amber-400/80">{e.lastError}</span>}
                {e.status === "queued" && (
                  <button
                    type="button"
                    onClick={() => void cancel(e.id)}
                    aria-label={`Cancel the call to ${e.phone}`}
                    className="text-mist-500 hover:text-mist-200"
                  >
                    <X size={13} />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {data && data.entries.length === 0 && (
        <p className="flex items-center gap-2 py-6 text-center text-[12.5px] text-mist-400">
          <PhoneOff size={14} /> Nothing queued. Paste numbers above and the agent will work through them.
        </p>
      )}

      {counts && (counts.done > 0 || counts.failed > 0) && (
        <p className="flex items-center gap-1.5 text-[11.5px] text-mist-500">
          <Phone size={12} /> {counts.done} called · {counts.failed} not reached
        </p>
      )}
    </div>
  );
}
