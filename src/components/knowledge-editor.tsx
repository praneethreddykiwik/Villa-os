"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Card, SectionTitle } from "@/components/ui";

/**
 * WhatsApp knowledge base editor. One card: the entries the assistant answers
 * from, and the questions it could not answer (gaps) — each gap can be turned
 * into an entry with one click, which is the whole training loop.
 */

interface Entry { id: string; topic: string; question: string; answer: string; keywords: string[]; public?: boolean; source?: string; updatedAt: string }
interface Gap { id: string; question: string; intent: string; count: number; lastAskedAt: string }
interface Draft { id?: string; topic: string; question: string; answer: string; keywords: string; public: boolean }

const EMPTY_DRAFT: Draft = { topic: "general", question: "", answer: "", keywords: "", public: false };

export function KnowledgeEditor({ brandId }: { brandId: string }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const load = useCallback(async () => {
    setError(null);
    const res = await fetch(`/api/ops/knowledge?brand=${encodeURIComponent(brandId)}`);
    const json = await res.json();
    if (!json.ok) { setError(json.error ?? "Could not load the knowledge base."); return; }
    setEntries(json.entries);
    setGaps(json.gaps);
    setTopics(json.topics);
  }, [brandId]);

  useEffect(() => { void load(); }, [load]);

  const call = async (method: string, body?: unknown, query = "") => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/ops/knowledge?brand=${encodeURIComponent(brandId)}${query}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "Request failed.");
      await load();
      return Boolean(json.ok);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft.question.trim() || !draft.answer.trim()) { setError("A question and an answer are both needed."); return; }
    const entry = { ...draft, keywords: draft.keywords.split(",").map((k) => k.trim()).filter(Boolean) };
    const ok = await call(draft.id ? "PATCH" : "POST", { brand: brandId, entry });
    if (ok) setDraft(EMPTY_DRAFT);
  };

  const edit = (e: Entry) => setDraft({ id: e.id, topic: e.topic, question: e.question, answer: e.answer, keywords: e.keywords.join(", "), public: Boolean(e.public) });
  const fromGap = (g: Gap) => setDraft({ ...EMPTY_DRAFT, topic: topics.includes(g.intent) ? g.intent : "general", question: g.question, keywords: "" });

  const shown = entries.filter((e) => !filter || `${e.topic} ${e.question} ${e.answer}`.toLowerCase().includes(filter.toLowerCase()));
  const input = "w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12.5px] text-mist-100 placeholder:text-mist-500 focus:border-brand-400 focus:outline-none";

  return (
    <Card>
      <SectionTitle
        title="WhatsApp knowledge base"
        hint="What the assistant may state to customers. Prices reach a customer only from entries marked public."
      />
      {error && <div className="mb-3 rounded-lg border border-red-900/60 bg-red-950/40 px-3 py-2 text-[12px] text-red-200">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <input className={input} placeholder="Filter entries…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void call("POST", { brand: brandId, resync: true })} title="Re-read docs/glentree-facts.md; your own edits are kept">
              Re-sync facts
            </Button>
          </div>
          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {shown.length === 0 && <div className="text-[12px] text-mist-400">No entries yet.</div>}
            {shown.map((e) => (
              <div key={e.id} className="rounded-lg border border-ink-700 p-3">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="neutral">{e.topic}</Badge>
                      {e.public && <Badge tone="good">public</Badge>}
                      {e.source && e.source !== "admin" && <Badge tone="warn">{e.source}</Badge>}
                    </div>
                    <div className="mt-1 text-[12.5px] font-medium text-mist-100">{e.question}</div>
                    <div className="mt-0.5 text-[12px] leading-relaxed text-mist-300">{e.answer}</div>
                    {e.keywords.length > 0 && <div className="mt-1 text-[11px] text-mist-500">{e.keywords.join(" · ")}</div>}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => edit(e)}>Edit</Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => void call("DELETE", undefined, `&id=${encodeURIComponent(e.id)}`)}>Delete</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="space-y-2 rounded-lg border border-ink-700 p-3">
            <div className="text-[11px] uppercase tracking-wider text-mist-400">{draft.id ? "Edit entry" : "New entry"}</div>
            <select className={input} value={draft.topic} onChange={(e) => setDraft({ ...draft, topic: e.target.value })}>
              {topics.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <input className={input} placeholder="Question the customer asks" value={draft.question} onChange={(e) => setDraft({ ...draft, question: e.target.value })} />
            <textarea className={`${input} min-h-[96px]`} placeholder="Answer, exactly as the assistant may say it" value={draft.answer} onChange={(e) => setDraft({ ...draft, answer: e.target.value })} />
            <input className={input} placeholder="Keywords, comma separated (optional)" value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} />
            <label className="flex items-center gap-2 text-[12px] text-mist-300">
              <input type="checkbox" checked={draft.public} onChange={(e) => setDraft({ ...draft, public: e.target.checked })} />
              Public — figures in this answer may be quoted to customers
            </label>
            <div className="flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => void save()}>{draft.id ? "Save changes" : "Add entry"}</Button>
              {draft.id && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(EMPTY_DRAFT)}>Cancel</Button>}
            </div>
          </div>

          <div className="rounded-lg border border-ink-700 p-3">
            <div className="text-[11px] uppercase tracking-wider text-mist-400">Unanswered questions</div>
            <div className="mt-2 max-h-[220px] space-y-1.5 overflow-y-auto">
              {gaps.length === 0 && <div className="text-[12px] text-mist-400">Nothing the assistant could not answer.</div>}
              {gaps.map((g) => (
                <div key={g.id} className="flex items-start gap-2 rounded-md bg-ink-800/60 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[12px] text-mist-100">{g.question}</div>
                    <div className="text-[11px] text-mist-500">{g.intent} · asked {g.count}×</div>
                  </div>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => fromGap(g)}>Answer</Button>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void call("DELETE", undefined, `&gap=${encodeURIComponent(g.id)}`)}>Dismiss</Button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
