"use client";

import { useState } from "react";
import { ArrowLeft, CheckCircle2, Loader2, Save } from "lucide-react";
import type { VoiceAgentConfig, VoiceLanguage } from "@/lib/voice/types";
import { VOICE_LANGUAGES } from "@/lib/voice/types";
import { dateTime } from "@/lib/crm/format";
import { Badge, Card, SectionTitle } from "../ui";

/**
 * Text-only settings. Everything on this form is wording the agent uses;
 * nothing here can change which voice, model or phone line it runs on.
 */

const field = "w-full rounded-xl border border-ink-700 bg-ink-850 px-3 py-2 text-[12.5px] text-mist-100 outline-none shadow-sm hover:border-ink-600 focus:border-brand-500/60";
const label = "mb-1 block text-[11px] font-medium uppercase tracking-wider text-mist-400";

function Field({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className={label}>{title}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-mist-500">{hint}</span>}
    </label>
  );
}

export function VoiceSettingsForm({ initial, brandId }: { initial: VoiceAgentConfig; brandId: string }) {
  const [c, setC] = useState(initial);
  const [offerings, setOfferings] = useState(initial.offerings.join("\n"));
  const [doNotSay, setDoNotSay] = useState(initial.doNotSay.join("\n"));
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string; detail?: string } | null>(null);

  const set = <K extends keyof VoiceAgentConfig>(k: K, v: VoiceAgentConfig[K]) => setC((p) => ({ ...p, [k]: v }));

  function toggleLanguage(l: VoiceLanguage) {
    set("languages", c.languages.includes(l) ? c.languages.filter((x) => x !== l) : [...c.languages, l]);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setNote(null);
    try {
      const res = await fetch("/api/voice/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...c, brandId, offerings, doNotSay }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setNote({ ok: false, text: json.error ?? "The settings were not saved." });
        return;
      }
      setC(json.config);
      setOfferings(json.config.offerings.join("\n"));
      setDoNotSay(json.config.doNotSay.join("\n"));
      setNote({ ok: json.synced, text: json.message, detail: json.detail });
    } catch {
      setNote({ ok: false, text: "The settings were not saved — the request did not reach the server." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <a href={`/voice?brand=${encodeURIComponent(brandId)}`} className="flex items-center gap-1.5 text-[12px] text-mist-400 hover:text-mist-100">
          <ArrowLeft size={13} /> Back to calls
        </a>
        {c.lastSync && (
          <Badge tone={c.lastSync.ok ? "good" : "warn"}>
            {c.lastSync.ok ? "Live" : "Saved, not live"} · {dateTime(c.lastSync.at)}
          </Badge>
        )}
      </div>

      <Card>
        <SectionTitle title="How the agent introduces itself" hint="The greeting is the first thing every caller hears." />
        <div className="space-y-4">
          <Field title="Business name">
            <input className={field} value={c.businessName} onChange={(e) => set("businessName", e.target.value)} maxLength={80} required />
          </Field>
          <Field title="Greeting" hint="One or two sentences. Keep it short — it is spoken, not read.">
            <textarea className={field} rows={2} value={c.greeting} onChange={(e) => set("greeting", e.target.value)} maxLength={400} required />
          </Field>
          <div>
            <span className={label}>Languages</span>
            <div className="flex flex-wrap gap-2">
              {VOICE_LANGUAGES.map((l) => {
                const on = c.languages.includes(l);
                return (
                  <button
                    key={l}
                    type="button"
                    onClick={() => toggleLanguage(l)}
                    aria-pressed={on}
                    className={
                      on
                        ? "rounded-full border border-brand-500/50 bg-brand-500/20 px-3.5 py-1.5 text-[12px] font-medium text-brand-200"
                        : "rounded-full border border-ink-700 bg-ink-850 px-3.5 py-1.5 text-[12px] text-mist-300 hover:border-ink-600"
                    }
                  >
                    {l}
                  </button>
                );
              })}
            </div>
            <span className="mt-1 block text-[11px] text-mist-500">The agent switches to whichever of these the caller speaks.</span>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle title="What the agent knows" hint="Plain facts. The agent will not invent anything that is not written here." />
        <div className="space-y-4">
          <Field title="Office hours" hint="e.g. Monday to Saturday, 9:30am to 7pm">
            <input className={field} value={c.officeHours} onChange={(e) => set("officeHours", e.target.value)} maxLength={200} />
          </Field>
          <Field title="Location / address">
            <input className={field} value={c.location} onChange={(e) => set("location", e.target.value)} maxLength={300} />
          </Field>
          <Field title="Projects and offerings" hint="One per line. Name, configuration, and anything a caller usually asks first.">
            <textarea className={field} rows={5} value={offerings} onChange={(e) => setOfferings(e.target.value)} />
          </Field>
          <Field title="Pricing guidance" hint="What the agent may say about price. Leave blank and it will defer to the sales team.">
            <textarea className={field} rows={3} value={c.pricingGuidance} onChange={(e) => set("pricingGuidance", e.target.value)} maxLength={1500} />
          </Field>
        </div>
      </Card>

      <Card>
        <SectionTitle title="Handing over" hint="What happens when the caller wants a person, or the agent should stay quiet." />
        <div className="space-y-4">
          <Field title="Transfer-to number" hint="With country code. Blank means the agent offers a callback instead of transferring.">
            <input className={field} type="tel" placeholder="+91 98450 12345" value={c.transferTo} onChange={(e) => set("transferTo", e.target.value)} maxLength={20} />
          </Field>
          <Field title="Do not say" hint="One per line. Claims, phrases or topics the agent must avoid.">
            <textarea className={field} rows={3} value={doNotSay} onChange={(e) => setDoNotSay(e.target.value)} />
          </Field>
        </div>
      </Card>

      {note && (
        <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px] ${note.ok ? "bg-good-500/10 text-good-400" : "bg-warn-500/10 text-warn-300"}`}>
          <CheckCircle2 size={14} className="mt-0.5 shrink-0" />
          <div>
            <p>{note.text}</p>
            {note.detail && <p className="mt-0.5 text-[11px] opacity-80">{note.detail}</p>}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {c.updatedAt && <span className="text-[11px] text-mist-500">Last saved {dateTime(c.updatedAt)} by {c.updatedBy}</span>}
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/40 bg-brand-500/20 px-5 py-2 text-[12.5px] font-semibold text-brand-200 transition-all hover:bg-brand-500/30 disabled:opacity-50"
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save and update agent
        </button>
      </div>
    </form>
  );
}
