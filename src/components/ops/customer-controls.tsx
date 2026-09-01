"use client";

import { useState } from "react";
import { Bot, Loader2, UserCheck } from "lucide-react";
import clsx from "clsx";
import { Card } from "../ui";

/**
 * Human takeover, per lane.
 *
 * The two lanes are independent on purpose: a sales manager running a
 * negotiation should not silence the document-collection assistant, and a loan
 * officer taking over paperwork should not stop sales follow-up.
 */
export function CustomerControls({
  customerId,
  salesControl,
  loanControl,
  canWriteSales,
  canWriteLoan,
  hasLoanCase,
}: {
  customerId: string;
  salesControl: string;
  loanControl: string;
  canWriteSales: boolean;
  canWriteLoan: boolean;
  hasLoanCase: boolean;
}) {
  const [state, setState] = useState({ SALES: salesControl, LOAN: loanControl });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle(lane: "SALES" | "LOAN") {
    const next = state[lane] === "AI_ACTIVE" ? "HUMAN_CONTROL" : "AI_ACTIVE";
    setBusy(lane);
    setError(null);
    try {
      const res = await fetch("/api/ops/customers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, control: { lane, state: next } }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setState((s) => ({ ...s, [lane]: next }));
    } finally {
      setBusy(null);
    }
  }

  const lanes: Array<{ lane: "SALES" | "LOAN"; label: string; enabled: boolean }> = [
    { lane: "SALES", label: "Sales assistant", enabled: canWriteSales },
    { lane: "LOAN", label: "Document assistant", enabled: canWriteLoan && hasLoanCase },
  ];

  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">Automation control</span>
        {lanes.map(({ lane, label, enabled }) => {
          const active = state[lane] === "AI_ACTIVE";
          return (
            <button
              key={lane}
              disabled={!enabled || busy === lane}
              onClick={() => toggle(lane)}
              title={enabled ? undefined : "You do not have permission to change this lane"}
              className={clsx(
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] transition-colors disabled:opacity-40",
                active ? "border-good-500/40 bg-good-500/10 text-good-400" : "border-warn-500/40 bg-warn-500/10 text-warn-400",
              )}
            >
              {busy === lane ? <Loader2 size={13} className="animate-spin" /> : active ? <Bot size={13} /> : <UserCheck size={13} />}
              {label}: {active ? "AI ACTIVE" : "HUMAN CONTROL"}
            </button>
          );
        })}
        <span className="text-[11px] text-mist-400">
          Taking control pauses scheduled follow-ups in that lane only. Releasing resumes them.
        </span>
        {error && <span className="text-[11px] text-bad-400">{error}</span>}
      </div>
    </Card>
  );
}
