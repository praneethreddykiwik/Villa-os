"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronUp, Loader2, Users, Wifi, WifiOff } from "lucide-react";
import clsx from "clsx";
import { useMessages } from "@/hooks/use-messages";
import type { QuotedReply } from "@/lib/messaging/payloads";
import { Badge } from "../ui";
import { ConversationSidebar } from "./conversation-sidebar";
import { MessageBubble } from "./message-bubble";
import { MessageComposer } from "./message-composer";

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

export function MessagesView() {
  const [visible, setVisible] = useState(true);
  const m = useMessages(visible);
  const [replyTo, setReplyTo] = useState<QuotedReply | undefined>();
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastCountRef = useRef(0);
  const pinnedRef = useRef(true);

  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  // Auto-scroll only when the reader is already at the bottom. Yanking someone
  // back down while they are reading history is the classic chat annoyance.
  useEffect(() => {
    const grew = m.messages.length > lastCountRef.current;
    lastCountRef.current = m.messages.length;
    if (grew && pinnedRef.current) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [m.messages]);

  useEffect(() => {
    pinnedRef.current = true;
    bottomRef.current?.scrollIntoView();
  }, [m.activeId]);

  const profilesById = useMemo(() => new Map(m.profiles.map((p) => [p.id, p])), [m.profiles]);
  const active = m.conversations.find((c) => c.id === m.activeId);

  const grouped = useMemo(() => {
    const out: Array<{ day: string; items: typeof m.messages }> = [];
    for (const msg of m.messages) {
      const day = dayLabel(msg.createdAt);
      const last = out[out.length - 1];
      if (last && last.day === day) last.items.push(msg);
      else out.push({ day, items: [msg] });
    }
    return out;
  }, [m.messages]);

  if (m.error && !m.ready) {
    return (
      <div className="p-7">
        <div className="card flex items-start gap-3 border-warn-500/30 bg-warn-500/[0.05] p-5">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warn-400" />
          <div className="text-[12.5px] leading-relaxed text-mist-300">
            <strong className="block text-mist-100">Messaging is not available.</strong>
            {m.error}
            <p className="mt-2 text-mist-400">
              Messaging needs Supabase configured, the messaging migration applied, and a signed-in staff account.
              Check <a href="/setup" className="text-brand-400 hover:underline">Setup</a>, then sign in at{" "}
              <a href="/signin" className="text-brand-400 hover:underline">Sign in</a>.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-58px)] flex-col">
      <div className="flex flex-1 overflow-hidden">
        <ConversationSidebar
          conversations={m.conversations}
          activeId={m.activeId}
          onSelect={(id) => { m.setActiveId(id); setReplyTo(undefined); }}
          onlineIds={m.onlineIds}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex items-center gap-2 border-b border-ink-700 px-4 py-2.5">
            <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-700 text-[11px] font-semibold text-mist-200">
              {active?.type === "everyone" ? <Users size={14} /> : (active?.name ?? "?").split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13.5px] font-semibold text-mist-100">{active?.name ?? "Select a conversation"}</div>
              <div className="text-[11px] text-mist-400">
                {active?.type === "everyone"
                  ? `Broadcast to all ${Math.max(0, m.profiles.length)} staff`
                  : m.onlineIds.has(m.activeId)
                    ? "Online"
                    : active?.profile?.email ?? ""}
              </div>
            </div>
            <Badge tone={m.connection === "connected" ? "good" : m.connection === "reconnecting" ? "warn" : "bad"}>
              {m.connection === "connected" ? <Wifi size={10} /> : <WifiOff size={10} />} {m.connection}
            </Badge>
          </header>

          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
            className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
          >
            {m.hasMore && (
              <div className="flex justify-center">
                <button
                  onClick={m.loadOlder}
                  disabled={m.loadingOlder}
                  className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-[11.5px] text-mist-300 hover:border-ink-600 disabled:opacity-50"
                >
                  {m.loadingOlder ? <Loader2 size={12} className="animate-spin" /> : <ChevronUp size={12} />} Load earlier messages
                </button>
              </div>
            )}

            {m.loading && (
              <div className="flex justify-center py-10 text-mist-400">
                <Loader2 size={18} className="animate-spin" />
              </div>
            )}

            {!m.loading && !m.messages.length && (
              <p className="py-14 text-center text-[12.5px] text-mist-400">
                No messages yet. Say something to {active?.name ?? "the team"}.
              </p>
            )}

            {grouped.map((group) => (
              <div key={group.day} className="space-y-2">
                <div className="flex items-center gap-3">
                  <span className="h-px flex-1 bg-ink-700" />
                  <span className="text-[10.5px] uppercase tracking-wider text-mist-400">{group.day}</span>
                  <span className="h-px flex-1 bg-ink-700" />
                </div>
                {group.items.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    mine={msg.senderId === m.me?.id}
                    showSender={
                      m.activeId === "everyone" &&
                      (i === 0 || group.items[i - 1].senderId !== msg.senderId)
                    }
                    profilesById={profilesById}
                    onReply={setReplyTo}
                    onReact={m.react}
                    onEdit={m.edit}
                    onDelete={m.remove}
                    resolveMedia={m.resolveMedia}
                  />
                ))}
              </div>
            ))}
            <div ref={bottomRef} />
          </div>

          {m.error && m.ready && (
            <p className="border-t border-bad-500/30 bg-bad-500/[0.06] px-4 py-2 text-[11.5px] text-bad-400">{m.error}</p>
          )}

          <MessageComposer
            onSend={m.send}
            onSendMedia={m.sendMedia}
            sending={m.sending}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(undefined)}
            disabled={!m.ready}
            placeholder={active ? `Message ${active.name}…` : "Select a conversation"}
          />
        </div>
      </div>
    </div>
  );
}
