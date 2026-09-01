"use client";

import { useState } from "react";
import { Check, Loader2, Send, Sparkles, Star } from "lucide-react";
import clsx from "clsx";
import type { Review } from "@/lib/types";
import { Badge, Card, SectionTitle } from "./ui";

const SOURCE_COLOR: Record<string, string> = {
  google: "#4285F4",
  facebook: "#1877F2",
  tripadvisor: "#00AF87",
  booking: "#003580",
};

export function ReviewsPanel({ reviews, brandId }: { reviews: Review[]; brandId: string }) {
  const [list, setList] = useState(reviews);
  const [busy, setBusy] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filter, setFilter] = useState<"all" | "unanswered" | "negative">("unanswered");
  const [autoReply, setAutoReply] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const shown = list.filter((r) =>
    filter === "all" ? true : filter === "unanswered" ? !r.replied : r.rating <= 3,
  );

  async function draft(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/ai/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId: id }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not draft a reply.");
        return;
      }
      setList((l) => l.map((r) => (r.id === id ? { ...r, draftReply: json.draft } : r)));
    } finally {
      setBusy(null);
    }
  }

  async function publish(id: string, text: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch("/api/ai/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reviewId: id, publish: true, text }),
      });
      const json = await res.json();
      // The row is only marked replied once the server says the reply was
      // stored. Mutating on the bare promise painted the green "Replied" badge
      // over a 403 from the permission gate: the operator saw an answered
      // review, the guest was never answered, and nothing here ever said
      // otherwise — the failure was invisible until someone re-read the page.
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not publish that reply — it has not been sent.");
        return;
      }
      setList((l) => l.map((r) => (r.id === id ? { ...r, replied: true, reply: text, draftReply: undefined } : r)));
    } finally {
      setBusy(null);
    }
  }

  async function bulkDraft() {
    setBulkBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/reply", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId, minRating: 4 }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not draft the positive replies.");
        return;
      }
      // Re-draft locally so the UI reflects the server without a full reload.
      const positives = list.filter((r) => !r.replied && r.rating >= 4);
      await Promise.all(positives.map((r) => draft(r.id)));
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <Card>
      <SectionTitle
        title="Review management"
        hint="AI drafts, a human approves. Nothing is published automatically unless you turn it on."
        action={
          <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-mist-300">
            <span>Auto-reply to 4–5★</span>
            <button
              onClick={() => setAutoReply((v) => !v)}
              className={clsx("relative h-5 w-9 rounded-full transition-colors", autoReply ? "bg-brand-500" : "bg-ink-600")}
            >
              <span className={clsx("absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all", autoReply ? "left-[18px]" : "left-0.5")} />
            </button>
          </label>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["unanswered", "negative", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx("rounded-lg border px-2.5 py-1 text-[11.5px] capitalize", filter === f ? "border-brand-500 bg-brand-500/12 text-mist-100" : "border-ink-700 text-mist-300 hover:border-ink-600")}
          >
            {f} ({f === "all" ? list.length : f === "unanswered" ? list.filter((r) => !r.replied).length : list.filter((r) => r.rating <= 3).length})
          </button>
        ))}
        <button
          onClick={bulkDraft}
          disabled={bulkBusy}
          className="ml-auto flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1 text-[11.5px] text-mist-200 hover:border-ink-600 disabled:opacity-50"
        >
          {bulkBusy ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Draft all positives
        </button>
      </div>

      {error && (
        <p className="mb-3 rounded-lg border border-bad-500/40 bg-bad-500/[0.06] px-3 py-2 text-[11.5px] text-bad-400">
          {error}
        </p>
      )}

      <div className="space-y-3">
        {shown.map((r) => (
          <div key={r.id} className="rounded-xl border border-ink-700 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="grid h-6 w-6 place-items-center rounded-md text-[10px] font-bold text-white" style={{ background: SOURCE_COLOR[r.source] }}>
                {r.source[0].toUpperCase()}
              </span>
              <span className="text-[12.5px] font-medium text-mist-100">{r.author}</span>
              <span className="flex gap-0.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Star key={i} size={11} className={i < r.rating ? "fill-warn-400 text-warn-400" : "text-ink-600"} />
                ))}
              </span>
              <Badge tone={r.sentiment === "positive" ? "good" : r.sentiment === "negative" ? "bad" : "neutral"}>{r.sentiment}</Badge>
              {r.topics.map((t) => (
                <Badge key={t} tone="neutral">{t}</Badge>
              ))}
              <span className="tnum ml-auto text-[10.5px] text-mist-400">{new Date(r.createdAt).toLocaleDateString()}</span>
            </div>

            <p className="mt-2 text-[12.5px] leading-relaxed text-mist-300">{r.text}</p>

            {r.replied ? (
              <div className="mt-2.5 rounded-lg border-l-2 border-good-500 bg-ink-850 px-3 py-2">
                <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] font-medium text-good-400">
                  <Check size={10} /> Replied {r.repliedAt ? new Date(r.repliedAt).toLocaleDateString() : ""}
                </div>
                <p className="text-[12px] text-mist-300">{r.reply}</p>
              </div>
            ) : (
              <div className="mt-2.5">
                {r.draftReply ? (
                  <div className="rounded-lg border border-brand-500/40 bg-brand-500/[0.05] p-2.5">
                    <div className="mb-1 flex items-center gap-1.5 text-[10.5px] font-medium text-brand-400">
                      <Sparkles size={10} /> AI draft — edit before sending
                    </div>
                    <textarea
                      value={r.draftReply}
                      onChange={(e) => setList((l) => l.map((x) => (x.id === r.id ? { ...x, draftReply: e.target.value } : x)))}
                      rows={3}
                      className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-brand-500"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => publish(r.id, r.draftReply!)}
                        disabled={busy === r.id}
                        className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
                      >
                        {busy === r.id ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />} Publish reply
                      </button>
                      <button onClick={() => draft(r.id)} disabled={busy === r.id} className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11.5px] text-mist-300 hover:border-ink-600">
                        Rewrite
                      </button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => draft(r.id)}
                    disabled={busy === r.id}
                    className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11.5px] text-mist-200 hover:border-brand-500 disabled:opacity-50"
                  >
                    {busy === r.id ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />} Draft a reply
                  </button>
                )}
              </div>
            )}
          </div>
        ))}
        {!shown.length && <p className="py-6 text-center text-[12px] text-mist-400">Nothing here — all clear.</p>}
      </div>
    </Card>
  );
}
