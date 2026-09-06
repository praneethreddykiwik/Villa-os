"use client";

import { useState } from "react";
import { ChevronDown, ChevronUp, Loader2, Plus, Save, Trash2 } from "lucide-react";
import { Card, SectionTitle } from "../ui";

/**
 * The org's default document set — what every new loan case starts with and
 * what the assistant lists on WhatsApp. Saved through the loan API, so a loan
 * officer can maintain it without admin rights.
 */
export interface DefaultItem {
  documentType: string;
  customerLabel: string;
  description: string;
  required: boolean;
  acceptedFormats: string[];
}

export function DefaultChecklistEditor({ items: initial }: { items: DefaultItem[] }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<DefaultItem[]>(initial);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = (idx: number, p: Partial<DefaultItem>) => setItems((all) => all.map((i, n) => (n === idx ? { ...i, ...p } : i)));
  const move = (idx: number, dir: -1 | 1) =>
    setItems((all) => {
      const next = [...all];
      const j = idx + dir;
      if (j < 0 || j >= next.length) return all;
      [next[idx], next[j]] = [next[j], next[idx]];
      return next;
    });

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/ops/loan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "setDefaultChecklist", items }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Save failed");
        return;
      }
      setItems(json.items);
      setNote(`Saved. New cases start with ${json.items.length} items (${json.items.filter((i: DefaultItem) => i.required).length} required).`);
    } finally {
      setBusy(false);
    }
  }

  const requiredCount = items.filter((i) => i.required).length;

  return (
    <Card>
      <SectionTitle
        title="Default document set"
        hint={`Applied to every new case · ${items.length} items, ${requiredCount} required · the assistant lists the required ones on WhatsApp`}
        action={
          <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600">
            {open ? <ChevronUp size={12} /> : <ChevronDown size={12} />} {open ? "Hide" : "Edit"}
          </button>
        }
      />
      {!open && (
        <p className="text-[12px] text-mist-300">
          {items.map((i) => `${i.customerLabel}${i.required ? "" : " (optional)"}`).join(" · ") || "No default items — new cases will start empty."}
        </p>
      )}
      {open && (
        <div className="space-y-2">
          {error && <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>}
          {note && <p className="rounded-lg bg-good-500/10 px-3 py-2 text-[12px] text-good-400">{note}</p>}
          {requiredCount > 8 && (
            <p className="rounded-lg bg-warn-500/10 px-3 py-2 text-[12px] text-warn-400">
              More than 8 required items: the WhatsApp list shows the first 8 and asks for the rest once those are in.
            </p>
          )}
          {items.map((i, idx) => (
            <div key={idx} className="grid gap-2 rounded-xl border border-ink-700 p-2.5 md:grid-cols-[1.2fr_2fr_auto]">
              <input
                value={i.customerLabel}
                onChange={(e) => patch(idx, { customerLabel: e.target.value })}
                placeholder="Name the customer sees"
                className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
              />
              <input
                value={i.description}
                onChange={(e) => patch(idx, { description: e.target.value })}
                placeholder="One-line description sent with it"
                className="rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
              />
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-[11.5px] text-mist-200">
                  <input type="checkbox" checked={i.required} onChange={(e) => patch(idx, { required: e.target.checked })} className="accent-[var(--color-brand-500)]" />
                  Required
                </label>
                <button onClick={() => move(idx, -1)} disabled={idx === 0} className="text-mist-400 hover:text-mist-100 disabled:opacity-30" title="Move up"><ChevronUp size={13} /></button>
                <button onClick={() => move(idx, 1)} disabled={idx === items.length - 1} className="text-mist-400 hover:text-mist-100 disabled:opacity-30" title="Move down"><ChevronDown size={13} /></button>
                <button onClick={() => setItems((all) => all.filter((_, n) => n !== idx))} className="text-mist-400 hover:text-bad-400" title="Remove"><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setItems((all) => [...all, { documentType: "", customerLabel: "", description: "", required: true, acceptedFormats: ["jpg", "png", "pdf"] }])}
              className="flex items-center gap-1 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
            >
              <Plus size={12} /> Add document
            </button>
            <span className="text-[11px] text-mist-500">Accepted formats: JPG, PNG, PDF.</span>
            <button
              disabled={busy || items.some((i) => !i.customerLabel.trim())}
              onClick={save}
              className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save default set
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
