"use client";

import { useMemo, useState } from "react";
import {
  Check, Clock, FileText, Handshake, Loader2, MessageCircle, Phone, RefreshCw, Users, Wallet, Zap,
} from "lucide-react";
import clsx from "clsx";
import type { CrmTask, TaskType } from "@/lib/crm/types";
import { RULE_BY_ID } from "@/lib/crm/rules";
import { dateTime, relativeDay } from "@/lib/crm/format";
import { Badge, Card, SectionTitle } from "../ui";

const TYPE_ICON: Record<TaskType, typeof Phone> = {
  call: Phone,
  site_visit: Users,
  document: FileText,
  agreement: Handshake,
  payment: Wallet,
  meeting: Users,
  whatsapp: MessageCircle,
};

/**
 * Task list, shared by /crm/tasks and /crm/follow-ups.
 *
 * Auto-generated tasks show *which rule* created them and why. A reminder whose
 * origin you cannot see is a reminder people learn to dismiss.
 */
export function TasksList({
  tasks,
  brandId,
  leadNames,
  groupByDay = false,
  title,
  hint,
}: {
  tasks: CrmTask[];
  brandId: string;
  leadNames: Record<string, string>;
  groupByDay?: boolean;
  title: string;
  hint: string;
}) {
  const [rows, setRows] = useState(tasks);
  const [filter, setFilter] = useState<"open" | "overdue" | "done" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const now = Date.now();
  const isOverdue = (t: CrmTask) => t.status === "open" && new Date(t.dueAt).getTime() < now;

  const shown = rows.filter((t) =>
    filter === "all" ? true : filter === "overdue" ? isOverdue(t) : filter === "done" ? t.status === "done" : t.status === "open",
  );

  const grouped = useMemo(() => {
    const sorted = [...shown].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    if (!groupByDay) return [["", sorted]] as Array<[string, CrmTask[]]>;
    const map = new Map<string, CrmTask[]>();
    for (const t of sorted) {
      const key = new Date(t.dueAt).toDateString();
      map.set(key, [...(map.get(key) ?? []), t]);
    }
    return [...map.entries()];
  }, [shown, groupByDay]);

  async function setStatus(taskId: string, status: CrmTask["status"], dueAt?: string) {
    setBusy(taskId);
    try {
      const res = await fetch("/api/crm/tasks", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId, status, dueAt }),
      });
      const json = await res.json();
      if (json.ok) setRows((r) => r.map((t) => (t.id === taskId ? json.task : t)));
    } finally {
      setBusy(null);
    }
  }

  async function generate() {
    setGenerating(true);
    setNote(null);
    try {
      const res = await fetch("/api/crm/followups", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      const json = await res.json();
      // A 403 has no counts, so the "nothing new" branch below rendered
      // "all undefined rule matches already have a task" — a reassuring
      // sentence about work the server refused to do.
      if (!res.ok || !json.ok) {
        setNote(json.error ?? "Could not generate follow-ups — nothing was created.");
        return;
      }
      setNote(
        json.created > 0
          ? `${json.created} new reminder(s) created from ${json.evaluated} rule matches.`
          : `Nothing new — all ${json.evaluated} rule matches already have a task.`,
      );
      if (json.created > 0) window.location.reload();
    } finally {
      setGenerating(false);
    }
  }

  const counts = {
    open: rows.filter((t) => t.status === "open").length,
    overdue: rows.filter(isOverdue).length,
    done: rows.filter((t) => t.status === "done").length,
    all: rows.length,
  };

  return (
    <Card>
      <SectionTitle
        title={title}
        hint={hint}
        action={
          <button
            onClick={generate}
            disabled={generating}
            className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-50"
          >
            {generating ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Generate reminders
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(["open", "overdue", "done", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={clsx(
              "rounded-lg border px-2.5 py-1 text-[11.5px] capitalize",
              filter === f ? "border-brand-500 bg-brand-500/12 text-mist-100" : "border-ink-700 text-mist-300 hover:border-ink-600",
              f === "overdue" && counts.overdue > 0 && filter !== f && "text-bad-400",
            )}
          >
            {f} ({counts[f]})
          </button>
        ))}
        {note && <span className="ml-auto text-[11.5px] text-good-400">{note}</span>}
      </div>

      <div className="space-y-4">
        {grouped.map(([day, list]) => (
          <div key={day || "all"}>
            {groupByDay && day && (
              <div className="mb-1.5 flex items-center gap-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">
                  {new Date(day).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}
                </h4>
                <span className="text-[10.5px] text-mist-500">{relativeDay(new Date(day).toISOString())}</span>
                <span className="h-px flex-1 bg-ink-700" />
              </div>
            )}

            <div className="space-y-1.5">
              {list.map((t) => {
                const Icon = TYPE_ICON[t.type] ?? Phone;
                const overdue = isOverdue(t);
                return (
                  <div
                    key={t.id}
                    className={clsx(
                      "flex flex-wrap items-center gap-2.5 rounded-xl border p-3",
                      t.status === "done" ? "border-ink-700 opacity-55" : overdue ? "border-bad-500/35 bg-bad-500/[0.05]" : "border-ink-700",
                    )}
                  >
                    <button
                      onClick={() => setStatus(t.id, t.status === "done" ? "open" : "done")}
                      disabled={busy === t.id}
                      className={clsx(
                        "grid h-5 w-5 shrink-0 place-items-center rounded-full border transition-colors",
                        t.status === "done" ? "border-good-500 bg-good-500 text-[var(--a-on)]" : "border-ink-600 hover:border-good-500",
                      )}
                    >
                      {t.status === "done" && <Check size={11} />}
                    </button>

                    <Icon size={14} className="shrink-0 text-mist-400" />

                    <div className="min-w-0 flex-1">
                      <div className={clsx("text-[12.5px]", t.status === "done" ? "text-mist-400 line-through" : "text-mist-100")}>
                        {t.title}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10.5px] text-mist-400">
                        <span>{t.assignedTo}</span>
                        {t.leadId && leadNames[t.leadId] && <span>· {leadNames[t.leadId]}</span>}
                        {t.autoGenerated && t.rule && (
                          <span className="flex items-center gap-1 text-brand-400" title={RULE_BY_ID[t.rule]?.why}>
                            <Zap size={9} /> {RULE_BY_ID[t.rule]?.label ?? t.rule}
                          </span>
                        )}
                      </div>
                      {t.autoGenerated && t.notes && (
                        <p className="mt-1 text-[10.5px] leading-relaxed text-mist-500">{t.notes}</p>
                      )}
                    </div>

                    {t.priority === "high" && <Badge tone="bad">high</Badge>}
                    <span className={clsx("tnum flex items-center gap-1 text-[11px]", overdue ? "text-bad-400" : "text-mist-400")}>
                      <Clock size={10} /> {dateTime(t.dueAt)}
                    </span>

                    {t.status === "open" && (
                      <button
                        onClick={() => setStatus(t.id, "open", new Date(Date.now() + 86400000).toISOString())}
                        className="rounded-lg border border-ink-700 px-2 py-1 text-[10.5px] text-mist-400 hover:text-mist-100"
                      >
                        +1 day
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        {!shown.length && <p className="py-8 text-center text-[12px] text-mist-400">Nothing here.</p>}
      </div>
    </Card>
  );
}
