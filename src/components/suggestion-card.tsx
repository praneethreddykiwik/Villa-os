"use client";

import { useState } from "react";
import { AlertTriangle, Check, ChevronDown, Sparkles, TrendingUp, X } from "lucide-react";
import clsx from "clsx";
import type { Suggestion } from "@/lib/types";
import { Badge } from "./ui";

/**
 * A suggestion is only useful if acting on it is one click. Every card therefore
 * carries the analyser's rationale (with the numbers it used), a projected impact
 * and an executable action that posts to /api/actions.
 */
export function SuggestionCard({ s, compact = false }: { s: Suggestion; compact?: boolean }) {
  const [open, setOpen] = useState(!compact);
  const [state, setState] = useState<Suggestion["state"]>(s.state);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function act(decision: "accepted" | "dismissed") {
    setBusy(true);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ suggestionId: s.id, brandId: s.brandId, decision, action: s.action }),
      });
      const json = await res.json();
      setState(decision);
      setResult(json.message ?? (decision === "accepted" ? "Applied" : "Dismissed"));
    } catch {
      setResult("Could not apply — check the connection");
    } finally {
      setBusy(false);
    }
  }

  const tone = s.severity === "critical" ? "bad" : s.severity === "opportunity" ? "brand" : "neutral";
  const Icon = s.severity === "critical" ? AlertTriangle : s.severity === "opportunity" ? TrendingUp : Sparkles;

  return (
    <div
      className={clsx(
        "card card-hover overflow-hidden transition-colors",
        state !== "new" && "opacity-55",
      )}
    >
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-start gap-3 p-4 text-left">
        <span
          className={clsx(
            "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
            s.severity === "critical" ? "bg-bad-500/12 text-bad-400" : s.severity === "opportunity" ? "bg-brand-500/12 text-brand-400" : "bg-ink-700 text-mist-300",
          )}
        >
          <Icon size={14} />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium leading-snug text-mist-100">{s.title}</span>
            <Badge tone={tone as never}>{s.kind.replace(/_/g, " ")}</Badge>
            {state === "accepted" && <Badge tone="good"><Check size={10} /> applied</Badge>}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-mist-400">
            <span className="tnum font-semibold text-mist-200">
              {s.projectedImpact.value.toLocaleString()} {s.projectedImpact.unit}
            </span>
            <span>{s.projectedImpact.metric}</span>
            <span className="tnum">{Math.round(s.confidence * 100)}% confidence</span>
            {s.entity && <span className="truncate">· {s.entity.label}</span>}
          </span>
        </span>

        <ChevronDown size={15} className={clsx("mt-1 shrink-0 text-mist-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="border-t border-ink-800 px-4 py-3.5">
          <p className="text-[12.5px] leading-relaxed text-mist-300">{s.rationale}</p>
          {(s.action || state === "new") && (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {s.action && (
                <button
                  disabled={busy || state !== "new"}
                  onClick={() => act("accepted")}
                  className="rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] transition-colors hover:bg-brand-600 disabled:opacity-40"
                >
                  {busy ? "Applying…" : s.action.label}
                </button>
              )}
              <button
                disabled={busy || state !== "new"}
                onClick={() => act("dismissed")}
                className="flex items-center gap-1 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-300 transition-colors hover:border-ink-600 hover:text-mist-100 disabled:opacity-40"
              >
                <X size={12} /> Dismiss
              </button>
              {result && <span className="text-[11px] text-good-400">{result}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
