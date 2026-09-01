"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Play, Clock, AlertTriangle, Sparkles } from "lucide-react";
import clsx from "clsx";
import type { Post } from "@/lib/types";
import { Badge } from "./ui";

/**
 * Publishing calendar.
 *
 * Month / week / day like the tools clients already know, but with two things
 * those tools mostly lack:
 *  - drag a post to a new day and it reschedules every target with it, and
 *  - "best slot" ghosts from the timing engine, so an empty day tells you when
 *    to fill it rather than just being empty.
 */

type View = "month" | "week" | "day";

export interface CalendarPost {
  id: string;
  caption: string;
  status: Post["status"];
  scheduledAt: string;
  autoScheduled: boolean;
  channels: Array<{ channel: string; label: string; color: string; format: string }>;
  error?: string;
}

const STATUS_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "brand"> = {
  published: "good",
  scheduled: "brand",
  needs_approval: "warn",
  failed: "bad",
  draft: "neutral",
  idea: "neutral",
  approved: "brand",
  publishing: "warn",
};

export function CalendarView({
  posts,
  slots,
  brandColor,
}: {
  posts: CalendarPost[];
  slots: Array<{ isoTime: string; reason: string; confidence: number }>;
  brandColor: string;
}) {
  const [view, setView] = useState<View>("month");
  const [cursor, setCursor] = useState(() => {
    // Start on the month containing the next scheduled post, not today — an empty
    // calendar because "today" is quiet is a bad first impression.
    const next = posts.find((p) => new Date(p.scheduledAt) > new Date());
    return next ? new Date(next.scheduledAt) : new Date();
  });
  const [dragging, setDragging] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [tickResult, setTickResult] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  const [local, setLocal] = useState(posts);

  const days = useMemo(() => buildDays(cursor, view), [cursor, view]);

  const byDay = useMemo(() => {
    const map = new Map<string, CalendarPost[]>();
    for (const p of local) {
      const key = new Date(p.scheduledAt).toDateString();
      map.set(key, [...(map.get(key) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt));
    return map;
  }, [local]);

  const slotsByDay = useMemo(() => {
    const map = new Map<string, typeof slots>();
    for (const s of slots) {
      const key = new Date(s.isoTime).toDateString();
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return map;
  }, [slots]);

  // Mirrors the ghost-cell condition in the grid below: a slot only shows on a
  // day that has no posts. The timing engine returns nothing until the account
  // has published history, so on a fresh workspace this is 0 and the legend
  // explaining dashed cells must not claim there are any.
  const ghostDays = useMemo(
    () =>
      days.filter((d) => {
        const key = d.toDateString();
        return !(byDay.get(key)?.length) && Boolean(slotsByDay.get(key)?.length);
      }).length,
    [days, byDay, slotsByDay],
  );

  async function drop(dayKey: string) {
    if (!dragging) return;
    const post = local.find((p) => p.id === dragging);
    setDragging(null);
    if (!post) return;
    const old = new Date(post.scheduledAt);
    const target = new Date(dayKey);
    target.setHours(old.getHours(), old.getMinutes(), 0, 0);
    const iso = target.toISOString();
    const previous = local;
    setLocal((list) => list.map((p) => (p.id === post.id ? { ...p, scheduledAt: iso } : p)));
    setDropError(null);
    const res = await fetch("/api/posts", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ postId: post.id, scheduledAt: iso }),
    });
    const json = await res.json();
    // The optimistic move has to be rolled back when the server refuses it.
    // Leaving the card on the new day after a 403 from the permission gate
    // showed a schedule the publisher will never act on: the post still goes
    // out at its old time, and the calendar is the only place anyone looks.
    if (!res.ok || !json.ok) {
      setLocal(previous);
      setDropError(json.error ?? "Could not reschedule that post — it stays where it was.");
    }
  }

  async function runQueue() {
    setRunning(true);
    setTickResult(null);
    try {
      // The worker secret must never reach the browser. This calls the tick as
      // the signed-in user; the route accepts either a session or the secret.
      const res = await fetch("/api/publish/tick", { method: "POST" });
      const json = await res.json();
      setTickResult(
        json.ok
          ? `Checked ${json.checked} targets · ${json.published} published · ${json.failed} failed · ${json.deferred} deferred`
          : json.error,
      );
    } finally {
      setRunning(false);
    }
  }

  const move = (dir: number) => {
    const next = new Date(cursor);
    if (view === "month") next.setMonth(next.getMonth() + dir);
    else if (view === "week") next.setDate(next.getDate() + dir * 7);
    else next.setDate(next.getDate() + dir);
    setCursor(next);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <button onClick={() => move(-1)} className="grid h-7 w-7 place-items-center rounded-lg border border-ink-700 text-mist-300 hover:border-ink-600 hover:text-mist-100">
            <ChevronLeft size={14} />
          </button>
          <button onClick={() => move(1)} className="grid h-7 w-7 place-items-center rounded-lg border border-ink-700 text-mist-300 hover:border-ink-600 hover:text-mist-100">
            <ChevronRight size={14} />
          </button>
        </div>
        <h3 className="text-[14px] font-semibold">
          {view === "day"
            ? cursor.toLocaleDateString("en", { weekday: "long", day: "numeric", month: "long" })
            : cursor.toLocaleDateString("en", { month: "long", year: "numeric" })}
        </h3>
        <button onClick={() => setCursor(new Date())} className="rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-mist-300 hover:text-mist-100">
          Today
        </button>

        <div className="ml-auto flex items-center gap-2">
          {tickResult && <span className="text-[11px] text-mist-300">{tickResult}</span>}
          <button
            onClick={runQueue}
            disabled={running}
            className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-50"
          >
            <Play size={12} /> {running ? "Running…" : "Run queue now"}
          </button>
          <div className="flex overflow-hidden rounded-lg border border-ink-700">
            {(["month", "week", "day"] as View[]).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={clsx("px-2.5 py-1.5 text-[12px] capitalize", view === v ? "bg-ink-700 text-mist-100" : "text-mist-400 hover:text-mist-200")}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      </div>

      {dropError && (
        <p className="rounded-lg border border-bad-500/40 bg-bad-500/[0.06] px-3 py-2 text-[11.5px] text-bad-400">{dropError}</p>
      )}

      <div className={clsx("grid gap-px overflow-hidden rounded-xl border border-ink-700 bg-ink-700", view === "day" ? "grid-cols-1" : "grid-cols-7")}>
        {view !== "day" &&
          ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
            <div key={d} className="bg-ink-900 px-2 py-1.5 text-center text-[10px] font-semibold uppercase tracking-wider text-mist-400">
              {d}
            </div>
          ))}

        {days.map((day) => {
          const key = day.toDateString();
          const list = byDay.get(key) ?? [];
          const daySlots = slotsByDay.get(key) ?? [];
          const inMonth = day.getMonth() === cursor.getMonth() || view !== "month";
          const isToday = key === new Date().toDateString();

          return (
            <div
              key={key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(key)}
              className={clsx(
                "min-h-[104px] bg-ink-900 p-1.5 transition-colors",
                !inMonth && "opacity-40",
                view === "day" && "min-h-[380px]",
                dragging && "hover:bg-ink-850",
              )}
            >
              <div className="mb-1 flex items-center gap-1.5 px-0.5">
                <span className={clsx("tnum text-[11px]", isToday ? "grid h-4.5 w-4.5 place-items-center rounded-full bg-brand-500 px-1 font-semibold text-[var(--a-on)]" : "text-mist-400")}>
                  {day.getDate()}
                </span>
                {list.length > 0 && <span className="tnum text-[10px] text-mist-500">{list.length}</span>}
              </div>

              <div className="space-y-1">
                {list.map((p) => (
                  <div
                    key={p.id}
                    draggable
                    onDragStart={() => setDragging(p.id)}
                    onDragEnd={() => setDragging(null)}
                    className="cursor-grab rounded-md border-l-2 bg-ink-800 px-1.5 py-1 active:cursor-grabbing"
                    style={{ borderLeftColor: p.channels[0]?.color ?? brandColor }}
                    title={p.caption}
                  >
                    <div className="flex items-center gap-1">
                      <span className="tnum text-[9.5px] font-medium text-mist-400">
                        {new Date(p.scheduledAt).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      {p.status === "failed" && <AlertTriangle size={9} className="text-bad-400" />}
                      {p.autoScheduled && <Sparkles size={9} className="text-brand-400" />}
                    </div>
                    <div className="line-clamp-2 text-[10.5px] leading-tight text-mist-200">{p.caption}</div>
                    <div className="mt-1 flex flex-wrap gap-0.5">
                      {p.channels.slice(0, 4).map((c, i) => (
                        <span key={i} className="h-1.5 w-1.5 rounded-full" style={{ background: c.color }} title={`${c.label} · ${c.format}`} />
                      ))}
                      <span className="ml-auto">
                        <Badge tone={STATUS_TONE[p.status] ?? "neutral"} className="!px-1 !py-0 !text-[9px]">
                          {p.status.replace("_", " ")}
                        </Badge>
                      </span>
                    </div>
                  </div>
                ))}

                {/* Ghost slots: the timing engine's recommendation for empty days. */}
                {list.length === 0 &&
                  daySlots.slice(0, 1).map((s) => (
                    <div
                      key={s.isoTime}
                      className="rounded-md border border-dashed border-brand-500/40 px-1.5 py-1 text-brand-400/90"
                      title={s.reason}
                    >
                      <div className="flex items-center gap-1 text-[9.5px] font-medium">
                        <Clock size={9} />
                        {new Date(s.isoTime).toLocaleTimeString("en", { hour: "2-digit", minute: "2-digit" })}
                      </div>
                      <div className="text-[9.5px] leading-tight opacity-80">best slot</div>
                    </div>
                  ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* The second sentence is a legend, so it only belongs here when there is
          something on screen to read it against. */}
      <p className="text-[11px] text-mist-400">
        Drag any post to another day to reschedule every channel with it.
        {ghostDays > 0 && (
          <>
            {" "}
            Dashed cells are the timing engine&apos;s recommended slots, computed from this
            account&apos;s own history.
          </>
        )}
      </p>
    </div>
  );
}

function buildDays(cursor: Date, view: View): Date[] {
  if (view === "day") return [new Date(cursor)];
  if (view === "week") {
    const start = new Date(cursor);
    const offset = (start.getDay() + 6) % 7; // week starts Monday
    start.setDate(start.getDate() - offset);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      return d;
    });
  }
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const start = new Date(first);
  start.setDate(start.getDate() - ((first.getDay() + 6) % 7));
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    return d;
  });
}
