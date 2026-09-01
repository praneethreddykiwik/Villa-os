"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, MessageSquare, RefreshCw, Send, Sparkles } from "lucide-react";
import clsx from "clsx";
import type { Conversation } from "@/lib/types";
import { Badge, Card, SectionTitle } from "./ui";

/**
 * Unified inbox across every connected channel.
 *
 * The WhatsApp path is special-cased for one real reason: the 24-hour customer
 * service window. Inside it you can reply freely; outside it only an approved
 * template delivers. The UI shows which state a thread is in *before* you type,
 * rather than letting you write a reply that Meta will silently reject.
 */

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function Inbox({
  conversations,
  brandId,
  channelMeta,
}: {
  conversations: Conversation[];
  brandId: string;
  channelMeta: Record<string, { label: string; color: string }>;
}) {
  const [list, setList] = useState(conversations);
  const [filter, setFilter] = useState<"open" | "leads" | "all">("open");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const shown = list.filter((c) =>
    filter === "all" ? true : filter === "leads" ? c.isLead : c.status === "open",
  );

  async function sync() {
    setSyncing(true);
    setNote(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      const json = await res.json();
      // A refusal carries no totals. Reporting on the body without the status
      // turned a 403 from the permission gate into a note about a retrieval
      // that never ran — and the operator concludes the channels are quiet.
      if (!res.ok || !json.ok) {
        setNote(json.error ?? "Could not retrieve — nothing was fetched.");
        return;
      }
      setNote(`Retrieved ${json.totals.conversations} new message(s) from ${json.sources.length} channel(s).`);
      if (json.totals.conversations > 0) window.location.reload();
    } finally {
      setSyncing(false);
    }
  }

  async function reply(c: Conversation) {
    const text = drafts[c.id] ?? c.draftReply ?? "";
    if (!text.trim()) return;
    setBusy(c.id);
    setNote(null);
    try {
      if (c.channel === "whatsapp") {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ conversationId: c.id, text }),
        });
        const json = await res.json();
        if (!res.ok || !json.ok) {
          setNote(json.error ?? "The message was not sent.");
          return;
        }
      }
      setList((l) => l.map((x) => (x.id === c.id ? { ...x, status: "replied", reply: text } : x)));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <SectionTitle
        title="Inbox"
        hint="Comments, DMs, mentions and WhatsApp across every connected channel"
        action={
          <button
            onClick={sync}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-50"
          >
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync now
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["open", "leads", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              "rounded-lg border px-2.5 py-1 text-[11.5px] capitalize",
              filter === f ? "border-brand-500 bg-brand-500/12 text-mist-100" : "border-ink-700 text-mist-300 hover:border-ink-600",
            )}
          >
            {f} ({f === "all" ? list.length : f === "leads" ? list.filter((c) => c.isLead).length : list.filter((c) => c.status === "open").length})
          </button>
        ))}
        {note && <span className="ml-auto text-[11.5px] text-warn-400">{note}</span>}
      </div>

      <div className="space-y-2.5">
        {shown.map((c) => {
          const meta = channelMeta[c.channel] ?? { label: c.channel, color: "#64748b" };
          const isWhatsApp = c.channel === "whatsapp";
          const inWindow = Date.now() - new Date(c.createdAt).getTime() < WINDOW_MS;
          const hoursLeft = Math.max(0, Math.round((WINDOW_MS - (Date.now() - new Date(c.createdAt).getTime())) / 3600_000));

          return (
            <div key={c.id} className="rounded-xl border border-ink-700 p-3.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-6 w-6 place-items-center rounded-md text-[10px] font-bold text-white" style={{ background: meta.color }}>
                  {meta.label[0]}
                </span>
                <span className="text-[12.5px] font-medium text-mist-100">{c.author}</span>
                <Badge tone="neutral">{c.kind}</Badge>
                {c.isLead && <Badge tone="good">lead</Badge>}
                <Badge tone={c.sentiment === "negative" ? "bad" : c.sentiment === "positive" ? "good" : "neutral"}>{c.sentiment}</Badge>
                <Badge tone={c.status === "open" ? "warn" : "neutral"}>{c.status}</Badge>
                {isWhatsApp && (
                  <Badge tone={inWindow ? "good" : "bad"}>
                    {inWindow ? `${hoursLeft}h left to reply freely` : "template required"}
                  </Badge>
                )}
                <span className="tnum ml-auto text-[10.5px] text-mist-400">
                  {new Date(c.createdAt).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>

              <p className="mt-2 text-[12.5px] leading-relaxed text-mist-300">{c.text}</p>

              {c.status === "replied" && c.reply && (
                <div className="mt-2 rounded-lg border-l-2 border-good-500 bg-ink-850 px-3 py-2 text-[12px] text-mist-300">
                  <div className="mb-0.5 flex items-center gap-1.5 text-[10.5px] font-medium text-good-400">
                    <MessageSquare size={10} /> Replied
                  </div>
                  {c.reply}
                </div>
              )}

              {c.status === "open" && (
                <div className="mt-2.5">
                  {isWhatsApp && !inWindow && (
                    <p className="mb-2 flex items-center gap-1.5 rounded-lg bg-warn-500/10 px-2.5 py-1.5 text-[11.5px] text-warn-400">
                      <AlertTriangle size={12} />
                      The 24-hour window has closed — only an approved template will deliver.
                    </p>
                  )}
                  {c.draftReply && !drafts[c.id] && (
                    <div className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-medium text-brand-400">
                      <Sparkles size={10} /> AI draft — edit before sending
                    </div>
                  )}
                  <textarea
                    value={drafts[c.id] ?? c.draftReply ?? ""}
                    onChange={(e) => setDrafts((d) => ({ ...d, [c.id]: e.target.value }))}
                    rows={2}
                    placeholder="Write a reply…"
                    className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[12px] leading-relaxed outline-none focus:border-brand-500"
                  />
                  <button
                    onClick={() => reply(c)}
                    disabled={busy === c.id}
                    className="mt-2 flex items-center gap-1.5 rounded-lg bg-brand-500 px-2.5 py-1.5 text-[11.5px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
                  >
                    {busy === c.id ? <Loader2 size={11} className="animate-spin" /> : <Send size={11} />}
                    {isWhatsApp ? "Send on WhatsApp" : "Reply"}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!shown.length && <p className="py-6 text-center text-[12px] text-mist-400">Nothing here — all clear.</p>}
      </div>
    </Card>
  );
}
