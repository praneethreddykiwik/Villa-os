"use client";

import { useState } from "react";
import { Check, FileText, Loader2, Plus, Send, Trash2, X } from "lucide-react";
import clsx from "clsx";
import type { ChecklistItem, ChecklistItemStatus } from "@/lib/ops/types";
import { Badge, Card, SectionTitle } from "../ui";

/**
 * The loan officer's checklist editor.
 *
 * This screen is the authority on what a customer must provide. The assistant
 * reads the result and has no way to add to it, so everything the customer is
 * ever asked for originates here.
 */

const STATUS_TONE: Record<ChecklistItemStatus, "neutral" | "good" | "warn" | "bad" | "brand"> = {
  NOT_REQUESTED: "neutral",
  REQUESTED: "brand",
  UPLOADED: "warn",
  UNDER_REVIEW: "warn",
  ACCEPTED: "good",
  REJECTED: "bad",
  NOT_REQUIRED: "neutral",
};

export interface DocumentSummary {
  id: string;
  checklistItemId?: string;
  filename: string;
  sizeBytes: number;
  status: string;
  createdAt: string;
  rejectionReason?: string;
}

export function ChecklistEditor({
  loanCaseId,
  items: initial,
  documents,
  templates,
}: {
  loanCaseId: string;
  items: ChecklistItem[];
  documents: DocumentSummary[];
  templates: Array<{ id: string; name: string; count: number }>;
}) {
  const [items, setItems] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  async function call(body: Record<string, unknown>, key: string) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/ops/loan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ loanCaseId, ...body }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Request failed");
        return null;
      }
      return json;
    } finally {
      setBusy(null);
    }
  }

  async function reload() {
    const res = await fetch(`/api/ops/loan?caseId=${loanCaseId}`);
    const json = await res.json();
    if (json.ok) setItems(json.checklist);
  }

  async function review(documentId: string, decision: "ACCEPTED" | "REJECTED", rejectionReason?: string) {
    setBusy(documentId);
    setError(null);
    try {
      const res = await fetch("/api/ops/documents", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId, decision, rejectionReason }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Review failed");
        return;
      }
      // Surface whether the customer was actually told — a decision they never
      // heard about is the failure mode worth seeing immediately.
      setNote(
        json.customerNotified?.sent
          ? `${decision === "ACCEPTED" ? "Accepted" : "Rejected"} — the customer has been told.`
          : `${decision === "ACCEPTED" ? "Accepted" : "Rejected"}, but the customer could NOT be messaged: ${json.customerNotified?.reason ?? "unknown"}. An escalation has been raised.`,
      );
      setRejecting(null);
      setReason("");
      await reload();
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  async function download(documentId: string) {
    const res = await fetch(`/api/ops/documents?id=${documentId}`);
    const json = await res.json();
    if (!json.ok) {
      setError(json.error);
      return;
    }
    // The signed reference is fetched at click time and lives ~5 minutes.
    window.open(`/api/ops/documents?id=${documentId}&download=${encodeURIComponent(json.downloadToken)}`, "_blank");
  }

  const docFor = (itemId: string) =>
    documents
      .filter((d) => d.checklistItemId === itemId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>}
      {note && <p className="rounded-lg bg-good-500/10 px-3 py-2 text-[12px] text-good-400">{note}</p>}

      <Card>
        <SectionTitle
          title="Required documents"
          hint="You own this list. The assistant can only ask for what appears here."
          action={
            <div className="flex flex-wrap items-center gap-2">
              {items.length === 0 &&
                templates.map((t) => (
                  <button
                    key={t.id}
                    disabled={busy !== null}
                    onClick={async () => {
                      await call({ action: "applyTemplate", templateId: t.id }, t.id);
                      await reload();
                    }}
                    className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-brand-500 disabled:opacity-50"
                  >
                    {busy === t.id ? <Loader2 size={12} className="animate-spin" /> : `Apply "${t.name}" (${t.count})`}
                  </button>
                ))}
              <button
                onClick={() => setAdding(true)}
                className="flex items-center gap-1 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
              >
                <Plus size={12} /> Add
              </button>
              {items.some((i) => i.status === "NOT_REQUESTED") && (
                <button
                  disabled={busy !== null}
                  onClick={async () => {
                    const r = await call({ action: "requestDocuments" }, "request");
                    if (r) {
                      setNote(`${r.requested} item(s) requested. The assistant will ask for them one at a time.`);
                      await reload();
                    }
                  }}
                  className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-50"
                >
                  {busy === "request" ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Request from customer
                </button>
              )}
            </div>
          }
        />

        {adding && (
          <AddItemForm
            onCancel={() => setAdding(false)}
            onSave={async (item) => {
              await call({ action: "addItems", items: [item] }, "add");
              setAdding(false);
              await reload();
            }}
          />
        )}

        {items.length === 0 && !adding && (
          <p className="py-6 text-center text-[12.5px] text-mist-400">
            No checklist yet. Apply a template or add items — until you do, the assistant will not ask the customer for anything.
          </p>
        )}

        <div className="space-y-2">
          {items.map((i) => {
            const doc = docFor(i.id);
            return (
              <div key={i.id} className="rounded-xl border border-ink-700 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FileText size={14} className="text-mist-400" />
                  <span className="text-[13px] font-medium text-mist-100">{i.customerLabel}</span>
                  <Badge tone={STATUS_TONE[i.status]}>{i.status.replace(/_/g, " ")}</Badge>
                  <Badge tone="neutral">{i.required ? "Required" : "Optional"}</Badge>
                  <span className="text-[10.5px] text-mist-500">{i.acceptedFormats.join(", ")}</span>

                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      disabled={busy !== null}
                      onClick={async () => {
                        await call({ action: "updateItem", itemId: i.id, patch: { required: !i.required } }, i.id);
                        await reload();
                      }}
                      className="rounded border border-ink-700 px-2 py-1 text-[10.5px] text-mist-300 hover:text-mist-100"
                    >
                      Make {i.required ? "optional" : "required"}
                    </button>
                    <button
                      disabled={busy !== null}
                      onClick={async () => {
                        await call(
                          { action: "updateItem", itemId: i.id, patch: { status: i.status === "NOT_REQUIRED" ? "NOT_REQUESTED" : "NOT_REQUIRED" } },
                          i.id,
                        );
                        await reload();
                      }}
                      className="rounded border border-ink-700 px-2 py-1 text-[10.5px] text-mist-300 hover:text-mist-100"
                    >
                      {i.status === "NOT_REQUIRED" ? "Reinstate" : "Waive"}
                    </button>
                    <button
                      disabled={busy !== null}
                      onClick={async () => {
                        await call({ action: "removeItem", itemId: i.id }, i.id);
                        await reload();
                      }}
                      className="text-mist-400 hover:text-bad-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>

                <p className="mt-1 text-[11.5px] text-mist-400">{i.description}</p>
                {i.rejectionReason && (
                  <p className="mt-1 text-[11.5px] text-bad-400">Rejected: {i.rejectionReason}</p>
                )}

                {doc && (
                  <div className="mt-2.5 rounded-lg border border-ink-700 bg-ink-850 p-2.5">
                    <div className="flex flex-wrap items-center gap-2 text-[11.5px]">
                      <span className="text-mist-200">{doc.filename}</span>
                      <span className="text-mist-500">{Math.round(doc.sizeBytes / 1024)}KB</span>
                      <Badge tone={doc.status === "ACCEPTED" ? "good" : doc.status === "REJECTED" ? "bad" : "warn"}>{doc.status}</Badge>
                      <span className="tnum text-[10.5px] text-mist-400">{new Date(doc.createdAt).toLocaleString()}</span>
                      <button onClick={() => download(doc.id)} className="ml-auto rounded border border-ink-700 px-2 py-1 text-[10.5px] text-mist-200 hover:border-ink-600">
                        Open
                      </button>
                    </div>

                    {["RECEIVED", "UNDER_REVIEW"].includes(doc.status) && (
                      <div className="mt-2">
                        {rejecting === doc.id ? (
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              autoFocus
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              placeholder="Why can't this be accepted? The customer sees this."
                              className="min-w-[240px] flex-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[11.5px] outline-none focus:border-bad-500"
                            />
                            <button
                              disabled={!reason.trim() || busy !== null}
                              onClick={() => review(doc.id, "REJECTED", reason)}
                              className="rounded-lg bg-bad-500/15 px-2.5 py-1.5 text-[11.5px] font-medium text-bad-400 hover:bg-bad-500/25 disabled:opacity-40"
                            >
                              Confirm rejection
                            </button>
                            <button onClick={() => { setRejecting(null); setReason(""); }} className="text-mist-400 hover:text-mist-100">
                              <X size={13} />
                            </button>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <button
                              disabled={busy !== null}
                              onClick={() => review(doc.id, "ACCEPTED")}
                              className={clsx("flex items-center gap-1.5 rounded-lg bg-good-500/15 px-2.5 py-1.5 text-[11.5px] font-medium text-good-400 hover:bg-good-500/25 disabled:opacity-40")}
                            >
                              {busy === doc.id ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Accept
                            </button>
                            <button
                              disabled={busy !== null}
                              onClick={() => setRejecting(doc.id)}
                              className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11.5px] text-mist-300 hover:border-bad-500/50 hover:text-bad-400"
                            >
                              Reject
                            </button>
                            <span className="text-[10.5px] text-mist-500">
                              The customer is told &ldquo;received&rdquo; until you decide.
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function AddItemForm({
  onCancel,
  onSave,
}: {
  onCancel: () => void;
  onSave: (item: {
    documentType: string;
    customerLabel: string;
    description: string;
    required: boolean;
    acceptedFormats: string[];
  }) => void;
}) {
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [required, setRequired] = useState(true);
  const [formats, setFormats] = useState("pdf, jpg, png");

  return (
    <div className="mb-3 space-y-2 rounded-xl border border-brand-500/40 p-3">
      <div className="grid gap-2 md:grid-cols-2">
        <label className="text-[11px] text-mist-400">
          Name the customer sees
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Income proof"
            className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
          />
        </label>
        <label className="text-[11px] text-mist-400">
          Accepted formats
          <input
            value={formats}
            onChange={(e) => setFormats(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
          />
        </label>
      </div>
      <label className="block text-[11px] text-mist-400">
        Description sent to the customer
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Last 3 months of salary slips"
          className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-brand-500"
        />
      </label>
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-[12px] text-mist-200">
          <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} className="accent-[var(--color-brand-500)]" />
          Required (counts toward completion)
        </label>
        <button
          disabled={!label.trim()}
          onClick={() =>
            onSave({
              // A stable machine key derived from the label, so the same
              // requirement cannot be added twice under different wording.
              documentType: label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"),
              customerLabel: label.trim(),
              description: description.trim(),
              required,
              acceptedFormats: formats.split(",").map((f) => f.trim().toLowerCase()).filter(Boolean),
            })
          }
          className="ml-auto rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
        >
          Add item
        </button>
        <button onClick={onCancel} className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-300">
          Cancel
        </button>
      </div>
    </div>
  );
}
