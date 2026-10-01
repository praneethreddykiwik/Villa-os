"use client";

import { useState } from "react";
import { Clock, Loader2, Phone, RotateCcw, Save } from "lucide-react";
import type { VillaSettings } from "@/lib/villa/settings";

/**
 * The calling window and retry policy, as a form.
 *
 * These were constants in the queue until now, so the thing this screen has to
 * get right is not the saving — it is making the consequence of each number
 * legible before somebody changes it. "Calls at once: 5" is meaningless; "five
 * phones ring at the same time from one number" is a decision.
 *
 * Every field is bounded here AND on the server AND by a CHECK constraint on
 * the table. The client bounds exist to explain, not to enforce.
 */

interface Bound {
  min: number;
  max: number;
  label: string;
}

const HOURS = Array.from({ length: 25 }, (_, h) => h);

/** The zones this business plausibly operates in, plus whatever is already set. */
const ZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Singapore",
  "Europe/London",
  "America/New_York",
];

function hourLabel(h: number): string {
  if (h === 0) return "12 midnight";
  if (h === 12) return "12 noon";
  if (h === 24) return "midnight";
  return h < 12 ? `${h}:00 am` : `${h - 12}:00 pm`;
}

export function VillaSettingsForm({
  initial,
  bounds,
  canEdit,
}: {
  initial: VillaSettings;
  bounds: Record<string, Bound>;
  canEdit: boolean;
}) {
  const [form, setForm] = useState<VillaSettings>(initial);
  const [saved, setSaved] = useState<VillaSettings>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const windowInvalid = form.callingStartHour >= form.callingEndHour;

  function set<K extends keyof VillaSettings>(key: K, value: VillaSettings[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setError("");
    setNotice("");
  }

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const res = await fetch("/api/villa/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Could not save those settings.");
      setSaved(json.settings);
      setForm(json.settings);
      setNotice("Saved. The queue picks this up within 30 seconds.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const number = (key: keyof VillaSettings, bound: Bound, hint: string) => (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wide text-[var(--color-faint)]">{bound.label}</span>
      <input
        type="number"
        min={bound.min}
        max={bound.max}
        step={1}
        disabled={!canEdit}
        value={String(form[key] as number)}
        onChange={(e) => set(key, Number(e.target.value) as VillaSettings[typeof key])}
        className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-mist-100 disabled:opacity-60"
      />
      <span className="mt-1 block text-[11px] text-mist-400">{hint}</span>
    </label>
  );

  return (
    <div className="space-y-6">
      <section>
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-mist-100">
          <Clock size={14} aria-hidden /> When calls may go out
        </h3>
        <p className="mt-1 text-[11.5px] text-mist-400">
          Nobody is dialled outside this window. Anything queued outside it waits rather than being dropped.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-[var(--color-faint)]">First call</span>
            <select
              disabled={!canEdit}
              value={form.callingStartHour}
              onChange={(e) => set("callingStartHour", Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-mist-100 disabled:opacity-60"
            >
              {HOURS.slice(0, 24).map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-[var(--color-faint)]">Last call</span>
            <select
              disabled={!canEdit}
              value={form.callingEndHour}
              onChange={(e) => set("callingEndHour", Number(e.target.value))}
              className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-mist-100 disabled:opacity-60"
            >
              {HOURS.slice(1).map((h) => (
                <option key={h} value={h}>{hourLabel(h)}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[11px] uppercase tracking-wide text-[var(--color-faint)]">Time zone</span>
            <select
              disabled={!canEdit}
              value={form.callingTimeZone}
              onChange={(e) => set("callingTimeZone", e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[13px] text-mist-100 disabled:opacity-60"
            >
              {[...new Set([form.callingTimeZone, ...ZONES])].map((z) => (
                <option key={z} value={z}>{z}</option>
              ))}
            </select>
          </label>
        </div>
        {windowInvalid ? (
          <p className="mt-2 text-[12px] text-amber-400">
            The last call has to be later than the first, or nothing is ever dialled.
          </p>
        ) : (
          <p className="mt-2 text-[12px] text-mist-400">
            Calls run {hourLabel(form.callingStartHour)} to {hourLabel(form.callingEndHour)}, {form.callingTimeZone}.
          </p>
        )}
      </section>

      <section>
        <h3 className="flex items-center gap-2 text-[13px] font-medium text-mist-100">
          <Phone size={14} aria-hidden /> How the queue dials
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {number(
            "maxConcurrentCalls",
            bounds.maxConcurrentCalls,
            "Phones ringing at the same time from one number. Above a handful, callers hear a busy tone and the provider bills for it anyway.",
          )}
          {number(
            "maxAttempts",
            bounds.maxAttempts,
            "Total tries per number. Only a no-answer is retried — somebody who declined is never called again.",
          )}
          {number(
            "retryBackoffMinutes",
            bounds.retryBackoffMinutes,
            "Minutes to wait before trying a no-answer again.",
          )}
          {number(
            "callTimeoutMinutes",
            bounds.callTimeoutMinutes,
            "How long to wait for a call that never reported back before freeing the line.",
          )}
        </div>
      </section>

      {error && <p className="text-[12px] text-red-400">{error}</p>}
      {notice && <p className="text-[12px] text-emerald-400">{notice}</p>}

      {canEdit ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          {dirty && (
            <button
              type="button"
              onClick={() => { setForm(saved); setError(""); setNotice(""); }}
              disabled={busy}
              className="btn-ghost !py-2 text-xs"
            >
              <RotateCcw size={14} aria-hidden /> Undo changes
            </button>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={busy || !dirty || windowInvalid}
            title={!dirty ? "Nothing has changed" : windowInvalid ? "Fix the calling window first" : undefined}
            className="btn-gold"
          >
            {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
            Save settings
          </button>
        </div>
      ) : (
        <p className="text-[11.5px] text-mist-400">
          These are set by whoever administers this workspace. Ask them if the calling window needs to change.
        </p>
      )}

      {saved.updatedAt && (
        <p className="text-[11px] text-[var(--color-faint)]">
          Last changed {new Date(saved.updatedAt).toLocaleString()}
          {saved.updatedBy ? ` by ${saved.updatedBy}` : ""}.
        </p>
      )}
    </div>
  );
}
