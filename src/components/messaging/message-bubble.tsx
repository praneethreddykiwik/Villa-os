"use client";

import { useEffect, useState } from "react";
import { Check, CheckCheck, CornerUpLeft, Loader2, Pencil, Play, Smile, Trash2 } from "lucide-react";
import clsx from "clsx";
import { parseMessage, summarise, type QuotedReply } from "@/lib/messaging/payloads";
import type { Message, MessageProfile } from "@/lib/messaging/types";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "🎉", "👀", "✅"];

/** Media lives in a private bucket; the URL is signed on demand and expires. */
function useSignedMedia(path: string | undefined, resolve: (p: string) => Promise<string | null>) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!path) return;
    void resolve(path).then((u) => !cancelled && setUrl(u));
    return () => {
      cancelled = true;
    };
  }, [path, resolve]);
  return url;
}

export function MessageBubble({
  message,
  mine,
  showSender,
  profilesById,
  onReply,
  onReact,
  onEdit,
  onDelete,
  resolveMedia,
}: {
  message: Message;
  mine: boolean;
  showSender: boolean;
  profilesById: Map<string, MessageProfile>;
  onReply: (q: QuotedReply) => void;
  onReact: (id: string, emoji: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
  resolveMedia: (path: string) => Promise<string | null>;
}) {
  const parsed = parseMessage(message.body);
  const [showReactions, setShowReactions] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(parsed.type === "text" ? parsed.text : "");
  const mediaUrl = useSignedMedia(parsed.type !== "text" ? parsed.media : undefined, resolveMedia);

  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const senderName = message.sender?.fullName ?? "Unknown";

  return (
    <div className={clsx("group flex gap-2", mine ? "flex-row-reverse" : "flex-row")}>
      {!mine && (
        <span className="mt-auto grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink-700 text-[10px] font-semibold text-mist-200">
          {senderName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase()}
        </span>
      )}

      <div className={clsx("flex min-w-0 max-w-[min(560px,78%)] flex-col", mine ? "items-end" : "items-start")}>
        {showSender && !mine && (
          <span className="mb-0.5 px-1 text-[10.5px] font-medium text-mist-400">{senderName}</span>
        )}

        <div
          className={clsx(
            "relative rounded-2xl px-3 py-2",
            mine
              ? "rounded-br-md bg-brand-500 text-[var(--a-on)]"
              : "rounded-bl-md border border-ink-700 bg-ink-850 text-mist-100",
          )}
        >
          {parsed.replyTo && (
            <div
              className={clsx(
                "mb-1.5 rounded-lg border-l-2 px-2 py-1 text-[11px]",
                mine ? "border-white/50 bg-black/15" : "border-brand-500 bg-ink-800",
              )}
            >
              <div className="font-medium opacity-80">{parsed.replyTo.senderName}</div>
              <div className="truncate opacity-70">{parsed.replyTo.snippet}</div>
            </div>
          )}

          {parsed.type === "image" && (
            <div className="mb-1">
              {mediaUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={mediaUrl} alt={parsed.caption ?? "Photo"} className="max-h-72 rounded-lg object-cover" />
              ) : (
                <div className="grid h-40 w-56 place-items-center rounded-lg bg-black/20">
                  <Loader2 size={16} className="animate-spin opacity-60" />
                </div>
              )}
              {parsed.caption && <p className="mt-1 text-[13px] leading-relaxed">{parsed.caption}</p>}
            </div>
          )}

          {parsed.type === "voice" && (
            <div className="flex items-center gap-2 py-0.5">
              {mediaUrl ? (
                <audio controls src={mediaUrl} className="h-8 max-w-[240px]" />
              ) : (
                <span className="flex items-center gap-2 text-[12px] opacity-70">
                  <Play size={13} /> Loading voice note…
                </span>
              )}
              {parsed.durationSec ? (
                <span className="tnum text-[10.5px] opacity-70">{Math.round(parsed.durationSec)}s</span>
              ) : null}
            </div>
          )}

          {parsed.type === "text" &&
            (editing ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onEdit(message.id, draft);
                      setEditing(false);
                    }
                    if (e.key === "Escape") setEditing(false);
                  }}
                  className="min-w-[180px] rounded border border-white/30 bg-black/20 px-2 py-1 text-[13px] outline-none"
                />
                <button onClick={() => { onEdit(message.id, draft); setEditing(false); }} className="text-[11px] underline">
                  Save
                </button>
              </div>
            ) : (
              <p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{parsed.text}</p>
            ))}

          <div className={clsx("mt-1 flex items-center gap-1.5 text-[10px]", mine ? "opacity-80" : "text-mist-400")}>
            <span className="tnum">{time}</span>
            {message.editedAt && <span>· edited</span>}
            {mine && (message.isReadByMe ? <CheckCheck size={11} /> : <Check size={11} />)}
          </div>

          {parsed.reactions && Object.keys(parsed.reactions).length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {Object.entries(parsed.reactions).map(([emoji, ids]) => (
                <button
                  key={emoji}
                  onClick={() => onReact(message.id, emoji)}
                  title={ids.map((id) => profilesById.get(id)?.fullName ?? "Someone").join(", ")}
                  className={clsx(
                    "rounded-full px-1.5 py-0.5 text-[11px]",
                    mine ? "bg-black/20" : "bg-ink-700",
                  )}
                >
                  {emoji} <span className="tnum opacity-70">{ids.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Actions appear on hover so the thread stays quiet at rest. */}
        <div
          className={clsx(
            "mt-0.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100",
            mine ? "flex-row-reverse" : "flex-row",
          )}
        >
          <button
            onClick={() => onReply({ id: message.id, senderName, snippet: summarise(message.body), isMedia: parsed.type !== "text" })}
            title="Reply"
            className="rounded p-1 text-mist-400 hover:text-mist-100"
          >
            <CornerUpLeft size={12} />
          </button>
          <div className="relative">
            <button onClick={() => setShowReactions((v) => !v)} title="React" className="rounded p-1 text-mist-400 hover:text-mist-100">
              <Smile size={12} />
            </button>
            {showReactions && (
              <div className="absolute bottom-full z-10 mb-1 flex gap-0.5 rounded-full border border-ink-700 bg-ink-900 px-1.5 py-1 shadow-xl">
                {QUICK_REACTIONS.map((e) => (
                  <button
                    key={e}
                    onClick={() => { onReact(message.id, e); setShowReactions(false); }}
                    className="rounded px-1 text-[14px] hover:bg-ink-800"
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
          {mine && parsed.type === "text" && (
            <button onClick={() => setEditing(true)} title="Edit" className="rounded p-1 text-mist-400 hover:text-mist-100">
              <Pencil size={12} />
            </button>
          )}
          {mine && (
            <button onClick={() => onDelete(message.id)} title="Delete" className="rounded p-1 text-mist-400 hover:text-bad-400">
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
