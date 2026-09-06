"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  AlertTriangle, Bot, Check, CheckCheck, Download, FileText, Loader2, Pause, Play, Search, Send, User, X,
} from "lucide-react";
import type { ConversationSummary, InboxFilter, ThreadEvent, ThreadMessage, ThreadPayload } from "@/lib/ops/inbox";

type Thread = ThreadPayload & { documentsRedacted: boolean; viewer: { memberId: string; name: string } };

const FILTERS: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "unread", label: "Unread" },
  { id: "human", label: "Human-handled" },
  { id: "needs_reply", label: "Needs reply" },
];

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "?";
}
function when(iso: string): string {
  const d = new Date(iso);
  return new Date().toDateString() === d.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (d.toDateString() === new Date().toDateString()) return "Today";
  if (d.toDateString() === new Date(Date.now() - 86400000).toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
function kb(n: number): string {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function api<T>(url: string, init?: RequestInit): Promise<T & { ok: boolean; error?: string }> {
  const r = await fetch(url, { credentials: "include", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const j = (await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }))) as T & { ok: boolean; error?: string };
  return j;
}

export function WhatsAppInbox() {
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [q, setQ] = useState("");
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [thread, setThread] = useState<Thread | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  const loadList = useCallback(async () => {
    const params = new URLSearchParams({ filter });
    if (q.trim()) params.set("q", q.trim());
    const j = await api<{ conversations: ConversationSummary[] }>(`/api/ops/whatsapp/conversations?${params}`);
    if (!j.ok) { setError(j.error ?? "Could not load conversations"); return; }
    setError(null);
    setConversations(j.conversations);
    setLoading(false);
  }, [filter, q]);

  const loadThread = useCallback(async (id: string) => {
    const j = await api<Thread>(`/api/ops/whatsapp/thread?customerId=${encodeURIComponent(id)}`);
    if (!j.ok) { setError(j.error ?? "Could not load thread"); return; }
    setThread(j);
    // Opening the thread marks it read; reflect that in the list without a refetch.
    setConversations((prev) => prev.map((c) => (c.customerId === id ? { ...c, unread: 0 } : c)));
  }, []);

  useEffect(() => { void loadList(); }, [loadList]);
  useEffect(() => { if (activeId) void loadThread(activeId); else setThread(null); }, [activeId, loadThread]);

  // Poll every 10s while the tab is visible.
  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => {
      void loadList();
      if (activeId) void loadThread(activeId);
    }, 10_000);
    return () => clearInterval(t);
  }, [visible, activeId, loadList, loadThread]);

  const onControl = async (paused: boolean) => {
    if (!thread) return;
    const j = await api<{ mode: "ai" | "human" }>("/api/ops/whatsapp/control", { method: "POST", body: JSON.stringify({ customerId: thread.customer.id, paused }) });
    if (!j.ok) { setError(j.error ?? "Could not change handling mode"); return; }
    await loadThread(thread.customer.id);
    await loadList();
  };

  return (
    <div className="flex h-[calc(100vh-64px)] min-h-[520px] overflow-hidden">
      {/* Left: conversations */}
      <div className="flex w-[300px] shrink-0 flex-col border-r border-ink-700">
        <div className="space-y-2 border-b border-ink-700 p-3">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search name, number or text"
              className="w-full rounded-lg border border-ink-700 bg-ink-850 py-2 pl-8 pr-3 text-[12.5px] outline-none placeholder:text-mist-500 focus:border-brand-500"
            />
          </div>
          <div className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                onClick={() => setFilter(f.id)}
                className={clsx(
                  "rounded-md px-2 py-1 text-[11px] font-medium",
                  filter === f.id ? "bg-brand-500/20 text-brand-300" : "text-mist-400 hover:bg-ink-800 hover:text-mist-200",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-4 text-[12px] text-mist-400"><Loader2 size={14} className="inline animate-spin" /> Loading…</div>}
          {!loading && conversations.length === 0 && <div className="p-4 text-[12px] text-mist-500">No conversations match.</div>}
          {conversations.map((c) => (
            <button
              key={c.customerId}
              onClick={() => setActiveId(c.customerId)}
              className={clsx(
                "flex w-full items-start gap-2.5 border-b border-ink-800 px-3 py-2.5 text-left hover:bg-ink-800/60",
                activeId === c.customerId && "bg-ink-800",
              )}
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-ink-700 text-[10px] font-semibold text-mist-200">{initials(c.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={clsx("truncate text-[12.5px]", c.unread ? "font-semibold text-mist-100" : "text-mist-200")}>{c.name}</span>
                  <span className="ml-auto shrink-0 text-[10.5px] text-mist-500">{when(c.lastAt)}</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-[11.5px] text-mist-400">{c.lastDirection === "outbound" ? "↩ " : ""}{c.lastMessage}</span>
                  <span className={clsx("ml-auto shrink-0 rounded px-1 text-[9.5px] font-semibold uppercase", c.mode === "human" ? "bg-warn-500/20 text-warn-300" : "bg-brand-500/20 text-brand-300")}>
                    {c.mode === "human" ? "Human" : "AI"}
                  </span>
                  {c.unread > 0 && <span className="shrink-0 rounded-full bg-good-500 px-1.5 text-[10px] font-semibold text-ink-900">{c.unread}</span>}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Right: thread */}
      {!thread ? (
        <div className="flex flex-1 items-center justify-center text-[13px] text-mist-500">
          {error ? <span className="text-warn-300">{error}</span> : "Select a conversation to read the full history."}
        </div>
      ) : (
        <ThreadPane thread={thread} error={error} onDismissError={() => setError(null)} onControl={onControl} onSent={() => { void loadThread(thread.customer.id); void loadList(); }} onError={setError} />
      )}
    </div>
  );
}

function Ticks({ m }: { m: ThreadMessage }) {
  if (m.direction !== "outbound") return null;
  const s = m.deliveryStatus;
  if (s === "failed") return <span title={m.deliveryError} className="text-warn-300"><AlertTriangle size={11} /></span>;
  if (s === "read") return <CheckCheck size={12} className="text-brand-300" />;
  if (s === "delivered") return <CheckCheck size={12} className="text-mist-400" />;
  return <Check size={12} className="text-mist-500" />;
}

function ThreadPane({ thread, error, onDismissError, onControl, onSent, onError }: {
  thread: Thread;
  error: string | null;
  onDismissError: () => void;
  onControl: (paused: boolean) => Promise<void>;
  onSent: () => void;
  onError: (e: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCount = useRef(0);
  const paused = thread.customer.salesControl === "HUMAN_CONTROL";

  useEffect(() => {
    if (thread.messages.length !== lastCount.current) {
      lastCount.current = thread.messages.length;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [thread.messages.length]);

  // Merge messages and system events into one chronological list, grouped by day.
  const grouped = useMemo(() => {
    type Row = { kind: "msg"; at: string; m: ThreadMessage } | { kind: "event"; at: string; e: ThreadEvent };
    const rows: Row[] = [
      ...thread.messages.map((m) => ({ kind: "msg" as const, at: m.createdAt, m })),
      ...thread.events.map((e) => ({ kind: "event" as const, at: e.at, e })),
    ].sort((a, b) => a.at.localeCompare(b.at));
    const out: Array<{ day: string; rows: Row[] }> = [];
    for (const r of rows) {
      const day = dayLabel(r.at);
      const last = out[out.length - 1];
      if (last && last.day === day) last.rows.push(r);
      else out.push({ day, rows: [r] });
    }
    return out;
  }, [thread.messages, thread.events]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const j = await api<{ sent: boolean }>("/api/ops/whatsapp/reply", { method: "POST", body: JSON.stringify({ customerId: thread.customer.id, text }) });
    setSending(false);
    if (!j.ok) { onError(j.error ?? "Send failed"); return; }
    setDraft("");
    onSent();
  };

  const download = async (documentId: string) => {
    const j = await api<{ downloadToken: string }>(`/api/ops/documents?id=${encodeURIComponent(documentId)}`);
    if (!j.ok) { onError(j.error ?? "Cannot download this file"); return; }
    window.open(`/api/ops/documents?id=${encodeURIComponent(documentId)}&download=${encodeURIComponent(j.downloadToken)}`, "_blank");
  };

  const c = thread.customer;

  return (
    <>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-ink-700 px-4 py-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-700 text-[10px] font-semibold text-mist-200">{initials(c.name || c.phone)}</span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-mist-100">{c.name || c.phone}</div>
            <div className="text-[11px] text-mist-400">{c.phone}</div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase", paused ? "bg-warn-500/20 text-warn-300" : "bg-brand-500/20 text-brand-300")}>
              {paused ? "Human handling" : "AI active"}
            </span>
            <button
              disabled={busy}
              onClick={async () => { setBusy(true); await onControl(!paused); setBusy(false); }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:bg-ink-800 disabled:opacity-50"
            >
              {paused ? <Play size={12} /> : <Pause size={12} />}
              {paused ? "Resume AI" : "Pause AI"}
            </button>
          </div>
        </div>

        {error && (
          <div className="flex items-start gap-2 border-b border-warn-500/30 bg-warn-500/[0.06] px-4 py-2 text-[12px] text-warn-200">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span className="flex-1">{error}</span>
            <button onClick={onDismissError} className="text-mist-400 hover:text-mist-200"><X size={13} /></button>
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {grouped.map((g) => (
            <div key={g.day} className="space-y-2">
              <div className="sticky top-0 z-10 mx-auto w-fit rounded-full bg-ink-800 px-2.5 py-0.5 text-[10.5px] text-mist-400">{g.day}</div>
              {g.rows.map((r) =>
                r.kind === "event" ? (
                  <div key={r.e.id} className="mx-auto w-fit rounded-md border border-ink-700 bg-ink-850 px-2.5 py-1 text-[11px] text-mist-400">
                    {r.e.label} · {new Date(r.e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </div>
                ) : (
                  <Bubble key={r.m.id} m={r.m} onDownload={download} />
                ),
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        <div className="border-t border-ink-700 p-3">
          {!thread.canFreeText && (
            <div className="mb-2 flex items-start gap-2 rounded-lg border border-warn-500/30 bg-warn-500/[0.06] px-3 py-2 text-[11.5px] text-warn-200">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>
                The 24-hour reply window has closed{thread.lastInboundAt ? ` (last customer message ${new Date(thread.lastInboundAt).toLocaleString()})` : ""}.
                Free-text replies will not deliver — send an approved template or call the customer. A message typed here is queued until they write again.
              </span>
            </div>
          )}
          {!paused && (
            <div className="mb-2 text-[11px] text-mist-500">The AI is answering this customer. Sending a reply does not pause it — use “Pause AI” to take over.</div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); } }}
              rows={2}
              placeholder={`Reply as ${thread.viewer.name}…`}
              className="flex-1 resize-none rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12.5px] outline-none placeholder:text-mist-500 focus:border-brand-500"
            />
            <button
              onClick={() => void send()}
              disabled={sending || !draft.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-500 px-3 text-[12px] font-medium text-white hover:bg-brand-400 disabled:opacity-50"
            >
              {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />} Send
            </button>
          </div>
        </div>
      </div>

      <SideCard thread={thread} />
    </>
  );
}

function Bubble({ m, onDownload }: { m: ThreadMessage; onDownload: (id: string) => void }) {
  const mine = m.direction === "outbound";
  const isImage = m.document?.mimeType.startsWith("image/");
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={clsx("flex", mine ? "justify-end" : "justify-start")}>
      <div className={clsx("max-w-[70%] rounded-2xl px-3 py-2 text-[12.5px] leading-relaxed", mine ? "rounded-br-sm bg-brand-500/20 text-mist-100" : "rounded-bl-sm bg-ink-800 text-mist-100")}>
        <div className="mb-0.5 flex items-center gap-1 text-[10.5px] font-semibold text-mist-400">
          {m.authorType === "ai" ? <Bot size={11} /> : <User size={11} />}
          {m.authorName}
          {m.automated && <span className="ml-1 rounded bg-ink-700 px-1 text-[9px] font-medium uppercase">follow-up</span>}
        </div>
        {m.document && (
          <button onClick={() => onDownload(m.document!.id)} className="mb-1.5 flex w-full items-center gap-2 rounded-lg border border-ink-700 bg-ink-850/70 p-2 text-left hover:bg-ink-850">
            {isImage ? (
              <span className="grid h-12 w-12 shrink-0 place-items-center rounded bg-ink-700 text-[9px] uppercase text-mist-400">image</span>
            ) : (
              <FileText size={18} className="shrink-0 text-mist-300" />
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] text-mist-100">{m.document.filename}</span>
              <span className="block text-[10.5px] text-mist-400">{kb(m.document.sizeBytes)} · {m.document.status.replace("_", " ").toLowerCase()}</span>
            </span>
            <Download size={13} className="shrink-0 text-mist-400" />
          </button>
        )}
        {!m.document && m.documentId && <div className="mb-1 text-[11px] italic text-mist-500">Attachment (restricted)</div>}
        <div className="whitespace-pre-wrap break-words">{m.body}</div>
        <div className="mt-0.5 flex items-center justify-end gap-1 text-[10px] text-mist-500">
          {time} <Ticks m={m} />
        </div>
      </div>
    </div>
  );
}

function SideCard({ thread }: { thread: Thread }) {
  const c = thread.customer;
  const upcoming = thread.appointments.filter((a) => a.status === "confirmed" || a.status === "requested" || a.status === "rescheduled");
  const openEsc = thread.escalations.filter((e) => e.status !== "RESOLVED");
  return (
    <div className="hidden w-[260px] shrink-0 space-y-4 overflow-y-auto border-l border-ink-700 p-4 text-[12px] xl:block">
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-mist-500">Customer</div>
        <div className="text-[13px] font-semibold text-mist-100">{c.name || c.phone}</div>
        <div className="text-mist-400">{c.phone}</div>
        {c.email && <div className="text-mist-400">{c.email}</div>}
      </div>
      <dl className="space-y-1.5">
        <Row k="Stage" v={c.leadStage.replace(/_/g, " ")} />
        <Row k="Score" v={String(c.leadScore)} />
        <Row k="Sentiment" v={c.sentiment.replace(/_/g, " ").toLowerCase()} />
        <Row k="Sales manager" v={thread.assignedManagerName ?? "Unassigned"} />
        <Row k="Loan officer" v={thread.assignedOfficerName ?? "—"} />
        <Row k="Source" v={c.source} />
      </dl>
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-mist-500">Loan case</div>
        {thread.loanCase ? (
          <a href={`/ops/loans/${encodeURIComponent(thread.loanCase.id)}`} className="text-brand-300 hover:underline">
            {thread.loanCase.status.replace(/_/g, " ")} · open case
          </a>
        ) : (
          <span className="text-mist-500">None</span>
        )}
      </div>
      <div>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-mist-500">Appointments</div>
        {upcoming.length === 0 && <span className="text-mist-500">None booked</span>}
        {upcoming.slice(0, 3).map((a) => (
          <div key={a.id} className="text-mist-200">
            {new Date(a.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
            <span className="ml-1 text-mist-500">({a.status})</span>
          </div>
        ))}
      </div>
      {openEsc.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-warn-300">Open escalations</div>
          {openEsc.map((e) => <div key={e.id} className="text-mist-200">{e.reason}</div>)}
        </div>
      )}
      {!thread.documentsRedacted && thread.documents.length > 0 && (
        <div>
          <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wide text-mist-500">Documents</div>
          {thread.documents.map((d) => <div key={d.id} className="truncate text-mist-200">{d.filename}</div>)}
        </div>
      )}
      <a href={`/ops/customers/${encodeURIComponent(c.id)}`} className="block text-brand-300 hover:underline">Open customer 360 →</a>
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-mist-500">{k}</dt>
      <dd className="truncate text-right text-mist-200">{v}</dd>
    </div>
  );
}
