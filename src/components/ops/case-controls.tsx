"use client";

import { useState } from "react";
import { Bot, Loader2, UserCheck } from "lucide-react";
import { LOAN_STATUSES } from "@/lib/ops/types";
import type { LoanStatus } from "@/lib/ops/types";
import { Card } from "../ui";

/**
 * Case-level controls: status, ownership, notes and the automation switch.
 *
 * Terminal statuses are offered but deliberately not reachable by automation —
 * only an authorised person sets APPROVED or REJECTED, which is why they appear
 * here and nowhere in the AI tool registry.
 */
export function CaseControls({
  loanCaseId,
  customerId,
  status,
  officers,
  assignedOfficerId,
  loanControl,
}: {
  loanCaseId: string;
  customerId: string;
  status: LoanStatus;
  officers: Array<{ id: string; name: string }>;
  assignedOfficerId?: string;
  loanControl: string;
}) {
  const [current, setCurrent] = useState(status);
  const [owner, setOwner] = useState(assignedOfficerId ?? "");
  const [control, setControl] = useState(loanControl);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function post(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/ops/loan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loanCaseId, ...body }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error ?? "Request failed");
      return json;
    } finally {
      setBusy(null);
    }
  }

  async function toggleControl() {
    const next = control === "AI_ACTIVE" ? "HUMAN_CONTROL" : "AI_ACTIVE";
    setBusy("control");
    try {
      const res = await fetch("/api/ops/customers", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, control: { lane: "LOAN", state: next } }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setControl(next);
      setMessage(
        next === "HUMAN_CONTROL"
          ? "Document automation paused. Scheduled follow-ups are held until you release it."
          : "Document automation resumed.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="text-[11px] text-mist-400">
          Status
          <select
            value={current}
            onChange={async (e) => {
              const next = e.target.value as LoanStatus;
              setCurrent(next);
              await post({ action: "setStatus", status: next }, "status");
            }}
            className="ml-2 rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-mist-100 outline-none"
          >
            {LOAN_STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>

        <label className="text-[11px] text-mist-400">
          Officer
          <select
            value={owner}
            onChange={async (e) => {
              setOwner(e.target.value);
              await post({ action: "reassign", assigneeId: e.target.value, customerId, note: "Manual reassignment" }, "owner");
            }}
            className="ml-2 rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-mist-100 outline-none"
          >
            <option value="">Unassigned</option>
            {officers.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>

        <button
          onClick={toggleControl}
          disabled={busy === "control"}
          className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12px] ${
            control === "AI_ACTIVE"
              ? "border-good-500/40 bg-good-500/10 text-good-400"
              : "border-warn-500/40 bg-warn-500/10 text-warn-400"
          }`}
        >
          {busy === "control" ? <Loader2 size={13} className="animate-spin" /> : control === "AI_ACTIVE" ? <Bot size={13} /> : <UserCheck size={13} />}
          Document assistant: {control === "AI_ACTIVE" ? "AI ACTIVE" : "HUMAN CONTROL"}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Add a case note…"
          className="min-w-[220px] flex-1 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] outline-none focus:border-brand-500"
        />
        <button
          disabled={!note.trim() || busy !== null}
          onClick={async () => {
            const r = await post({ action: "addNote", note: note.trim() }, "note");
            if (r?.ok) {
              setNote("");
              setMessage("Note added.");
            }
          }}
          className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-40"
        >
          Add note
        </button>
      </div>

      {error && <p className="text-[11.5px] text-bad-400">{error}</p>}
      {message && <p className="text-[11.5px] text-good-400">{message}</p>}
    </Card>
  );
}
