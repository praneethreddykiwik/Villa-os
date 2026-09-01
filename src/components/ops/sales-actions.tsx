"use client";

import { useState } from "react";
import { CheckCircle2, Loader2, Phone, ThumbsDown, Wallet } from "lucide-react";
import { Card, SectionTitle } from "../ui";

/**
 * The sales manager's call flow.
 *
 * "Financing required" is the pivot of the whole lifecycle: one action flips the
 * customer, opens the loan case and routes it to the loan queue, so a manager
 * cannot leave the handoff half-done.
 */
export function SalesActions({
  customerId,
  managers,
  assignedTo,
  hasLoanCase,
  loanCaseId,
}: {
  customerId: string;
  managers: Array<{ id: string; name: string }>;
  assignedTo?: string;
  hasLoanCase: boolean;
  loanCaseId?: string;
}) {
  const [note, setNote] = useState("");
  const [requirements, setRequirements] = useState("");
  const [loanType, setLoanType] = useState("standard");
  const [amount, setAmount] = useState("");
  const [owner, setOwner] = useState(assignedTo ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function act(body: Record<string, unknown>, key: string, success: string) {
    setBusy(key);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/ops/sales", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId, ...body }),
      });
      const json = await res.json();
      if (!json.ok || json.error) {
        setError(json.error ?? "Request failed");
        return null;
      }
      setMessage(success);
      setTimeout(() => window.location.reload(), 700);
      return json;
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3">
      <SectionTitle title="Call flow" hint="Log the outcome, then route the customer to whatever comes next" />

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={2}
        placeholder="Call notes — what was discussed, what was agreed…"
        className="w-full resize-y rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-brand-500"
      />
      <input
        value={requirements}
        onChange={(e) => setRequirements(e.target.value)}
        placeholder="Customer requirements, comma separated — these go onto the profile"
        className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] outline-none focus:border-brand-500"
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          disabled={busy !== null}
          onClick={() =>
            act(
              {
                action: "logCall",
                note: note.trim() || "Call completed",
                requirements: requirements.split(",").map((r) => r.trim()).filter(Boolean),
              },
              "call",
              "Call logged and the open task closed.",
            )
          }
          className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
        >
          {busy === "call" ? <Loader2 size={12} className="animate-spin" /> : <Phone size={12} />} Log call
        </button>

        <button
          disabled={busy !== null}
          onClick={() => act({ action: "markQualified", note: note.trim() }, "qual", "Marked qualified.")}
          className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-mist-200 hover:border-good-500/50 hover:text-good-400 disabled:opacity-40"
        >
          <CheckCircle2 size={12} /> Qualified
        </button>

        <button
          disabled={busy !== null}
          onClick={() => act({ action: "markNotInterested", note: note.trim() }, "lost", "Marked not interested; automation stops.")}
          className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-mist-200 hover:border-bad-500/50 hover:text-bad-400 disabled:opacity-40"
        >
          <ThumbsDown size={12} /> Not interested
        </button>

        <label className="ml-auto text-[11px] text-mist-400">
          Owner
          <select
            value={owner}
            onChange={(e) => {
              setOwner(e.target.value);
              void act({ action: "reassign", assigneeId: e.target.value, note: "Manual reassignment" }, "owner", "Reassigned.");
            }}
            className="ml-2 rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] text-mist-100 outline-none"
          >
            <option value="">Unassigned</option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="rounded-xl border border-ink-700 p-3">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mist-400">Financing</div>
        {hasLoanCase ? (
          <p className="text-[12px] text-mist-300">
            A loan case is already open for this customer.{" "}
            {loanCaseId && (
              <a href={`/ops/loans/${loanCaseId}`} className="text-brand-400 hover:underline">
                Open the case
              </a>
            )}
          </p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <label className="text-[11px] text-mist-400">
              Loan type
              <input
                value={loanType}
                onChange={(e) => setLoanType(e.target.value)}
                className="mt-1 block w-36 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none"
              />
            </label>
            <label className="text-[11px] text-mist-400">
              Requested amount
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ""))}
                placeholder="optional"
                className="mt-1 block w-40 rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none"
              />
            </label>
            <button
              disabled={busy !== null}
              onClick={() =>
                act(
                  {
                    action: "markFinancingRequired",
                    loanType: loanType.trim() || "standard",
                    ...(amount ? { requestedAmount: Number(amount) } : {}),
                  },
                  "loan",
                  "Loan case opened and routed to the loan queue.",
                )
              }
              className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
            >
              {busy === "loan" ? <Loader2 size={12} className="animate-spin" /> : <Wallet size={12} />} Mark financing required
            </button>
            <span className="text-[11px] text-mist-400">
              Opens the case, assigns an officer and moves the customer to the loan stage.
            </span>
          </div>
        )}
      </div>

      {error && <p className="text-[11.5px] text-bad-400">{error}</p>}
      {message && <p className="text-[11.5px] text-good-400">{message}</p>}
    </Card>
  );
}
