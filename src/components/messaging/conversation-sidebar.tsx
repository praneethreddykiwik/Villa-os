"use client";

import { Search, Users } from "lucide-react";
import clsx from "clsx";
import { useState } from "react";
import { summarise } from "@/lib/messaging/payloads";
import type { ConversationItem } from "@/lib/messaging/types";

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

function when(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function ConversationSidebar({
  conversations,
  activeId,
  onSelect,
  onlineIds,
}: {
  conversations: ConversationItem[];
  activeId: string;
  onSelect: (id: string) => void;
  onlineIds: Set<string>;
}) {
  const [query, setQuery] = useState("");
  const shown = conversations.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="flex w-[280px] shrink-0 flex-col border-r border-ink-700">
      <div className="border-b border-ink-700 p-3">
        <div className="relative">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-mist-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people"
            className="w-full rounded-lg border border-ink-700 bg-ink-850 py-2 pl-8 pr-3 text-[12.5px] outline-none placeholder:text-mist-500 focus:border-brand-500"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {shown.map((c) => {
          const active = c.id === activeId;
          const online = c.type === "user" && onlineIds.has(c.id);
          return (
            <button
              key={c.id}
              onClick={() => onSelect(c.id)}
              className={clsx(
                "flex w-full items-center gap-2.5 border-b border-ink-700/50 px-3 py-2.5 text-left transition-colors",
                active ? "bg-brand-500/[0.10]" : "hover:bg-ink-850",
              )}
            >
              <span className="relative shrink-0">
                <span
                  className={clsx(
                    "grid h-9 w-9 place-items-center rounded-full text-[11px] font-semibold",
                    c.type === "everyone" ? "bg-brand-500/15 text-brand-400" : "bg-ink-700 text-mist-200",
                  )}
                >
                  {c.type === "everyone" ? <Users size={15} /> : initials(c.name)}
                </span>
                {online && (
                  <span
                    className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-good-500"
                    title="Online"
                  />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={clsx("truncate text-[13px]", c.unreadCount ? "font-semibold text-mist-100" : "text-mist-200")}>
                    {c.name}
                  </span>
                  <span className="tnum ml-auto shrink-0 text-[10px] text-mist-400">{when(c.lastMessage?.createdAt)}</span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className={clsx("truncate text-[11.5px]", c.unreadCount ? "text-mist-200" : "text-mist-400")}>
                    {c.lastMessage ? summarise(c.lastMessage.body) : "No messages yet"}
                  </span>
                  {c.unreadCount > 0 && (
                    <span className="tnum ml-auto shrink-0 rounded-full bg-brand-500 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--a-on)]">
                      {c.unreadCount}
                    </span>
                  )}
                </span>
              </span>
            </button>
          );
        })}
        {!shown.length && <p className="p-4 text-center text-[12px] text-mist-400">No matches.</p>}
      </div>
    </div>
  );
}
