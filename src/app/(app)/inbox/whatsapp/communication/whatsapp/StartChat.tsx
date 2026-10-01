"use client";

import { useState } from "react";
import { AlertTriangle, Loader2, MessageSquarePlus, Send, X } from "lucide-react";

/**
 * Opens WhatsApp conversations with a pasted list of numbers.
 *
 * Two deliberate pieces of friction, both there because this messages people
 * who have not written to us and the number itself is at stake:
 *
 *  1. Nothing sends until Preview has been pressed. The preview shows the
 *     parsed count, every rejected line with its reason, and the first few
 *     messages rendered exactly as they will arrive — so a broken {name} or a
 *     mistyped number is caught before anybody's phone buzzes rather than after.
 *  2. Send is disabled until then, and the button says how many people it is
 *     about to message. "Send" invites a reflex; "Message 14 people" does not.
 */

const DEFAULT_TEMPLATE =
  "Hi {name}, this is Glentree Homes. Thanks for your interest in Glentree Serenity, our premium villas at Nadergul, Hyderabad. Would you like the brochure or to book a site visit?";

interface Sample {
  phone: string;
  name: string | null;
  message: string;
}

interface PreviewState {
  count: number;
  samples: Sample[];
  rejected: { line: string; reason: string }[];
}

export function StartChat({ returnTo }: { returnTo: string }) {
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState("");
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Any edit invalidates the preview: approving one list and sending a
  // different one is the failure this whole flow exists to prevent.
  function edit(setter: (value: string) => void) {
    return (value: string) => {
      setter(value);
      setPreview(null);
      setError("");
    };
  }

  async function post(isPreview: boolean) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/osf/outreach", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          recipients,
          template,
          next: returnTo,
          ...(isPreview ? { preview: "1" } : {}),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "That did not work.");
        if (json.rejected?.length) {
          setPreview({ count: 0, samples: [], rejected: json.rejected });
        }
        return;
      }

      if (isPreview) {
        setPreview({ count: json.count, samples: json.samples, rejected: json.rejected ?? [] });
      } else {
        // The threads now exist; a reload is what shows them in the list.
        window.location.href = `${returnTo.split("?")[0]}?sent=${json.sent}${
          json.skipped ? `&skipped=${json.skipped}` : ""
        }${json.failed ? `&failed=${json.failed}` : ""}`;
      }
    } catch {
      setError("The request did not complete. Nothing further was sent.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="btn-ghost !py-2 text-xs">
        <MessageSquarePlus size={14} strokeWidth={2} aria-hidden />
        Start a chat
      </button>
    );
  }

  return (
    <div className="card mb-4 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-[var(--color-ink)]">Start a conversation</h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">
            One number per line, country code first. Anything after the number is used as their
            name.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Close"
          className="text-[var(--color-faint)] hover:text-[var(--color-ink)]"
        >
          <X size={15} strokeWidth={2} />
        </button>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <label htmlFor="outreach-recipients" className="label">
            Numbers
          </label>
          <textarea
            id="outreach-recipients"
            rows={6}
            value={recipients}
            onChange={(e) => edit(setRecipients)(e.target.value)}
            placeholder={"919876543210, Koushik S\n919812345678 Priya\n+91 98765 43211"}
            className="field mt-1 resize-y font-mono text-[12.5px]"
          />
        </div>

        <div>
          <label htmlFor="outreach-template" className="label">
            Opening message · <code className="text-[var(--color-gold-100)]">{"{name}"}</code> is
            replaced, or &ldquo;there&rdquo; when you give no name
          </label>
          <textarea
            id="outreach-template"
            rows={6}
            value={template}
            onChange={(e) => edit(setTemplate)(e.target.value)}
            className="field mt-1 resize-y"
          />
        </div>
      </div>

      <p className="mt-3 flex items-start gap-2 rounded-xl border border-[var(--color-gold-line)] bg-[var(--color-gold-soft)] px-3 py-2.5 text-xs leading-relaxed text-[var(--color-ink)]">
        <AlertTriangle size={14} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--color-gold-300)]" aria-hidden />
        <span>
          These people have not messaged you. WhatsApp bans numbers for unsolicited bulk sending,
          and the ban takes every conversation with it — so this sends at most 25 at a time, a few
          seconds apart. Keep the list small and the message relevant.
        </span>
      </p>

      {error && (
        <p className="mt-3 text-xs text-[var(--color-danger)]">{error}</p>
      )}

      {preview && preview.rejected.length > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--color-line)] p-3">
          <p className="label mb-1.5">Skipped lines</p>
          <ul className="space-y-1 text-xs text-[var(--color-muted)]">
            {preview.rejected.map((r, i) => (
              <li key={i}>
                <code className="text-[var(--color-ink)]">{r.line}</code> — {r.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      {preview && preview.count > 0 && (
        <div className="mt-3 rounded-xl border border-[var(--color-line)] p-3">
          <p className="label mb-1.5">
            This is what arrives — {preview.count} {preview.count === 1 ? "person" : "people"}
          </p>
          <ul className="space-y-2">
            {preview.samples.map((s) => (
              <li key={s.phone} className="text-xs">
                <span className="font-mono text-[var(--color-muted)]">{s.phone}</span>
                <p className="mt-0.5 rounded-lg bg-[var(--color-raised)] px-3 py-2 leading-relaxed text-[var(--color-ink)]">
                  {s.message}
                </p>
              </li>
            ))}
          </ul>
          {preview.count > preview.samples.length && (
            <p className="mt-2 text-[11px] text-[var(--color-faint)]">
              …and {preview.count - preview.samples.length} more, worded the same way.
            </p>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        {/* The send button is deliberately dead until Preview has been pressed,
            but a greyed-out button with only a title attribute reads as broken
            rather than as locked — the tooltip never appears on touch and is
            easy to miss on a pointer. Say it in the open instead. */}
        {!preview && (
          <p className="mr-auto text-[11px] text-[var(--color-faint)]">
            Press Preview first — it checks the list and shows the wording before anything sends.
          </p>
        )}
        <button
          type="button"
          onClick={() => void post(true)}
          disabled={busy || !recipients.trim() || !template.trim()}
          className="btn-ghost !py-2 text-xs"
        >
          {busy && !preview ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null}
          Preview
        </button>
        <button
          type="button"
          onClick={() => void post(false)}
          disabled={busy || !preview || preview.count === 0}
          title={preview ? undefined : "Preview the list first"}
          className="btn-gold"
        >
          {busy && preview ? (
            <Loader2 size={14} className="animate-spin" aria-hidden />
          ) : (
            <Send size={14} strokeWidth={2} aria-hidden />
          )}
          {preview && preview.count > 0
            ? `Message ${preview.count} ${preview.count === 1 ? "person" : "people"}`
            : "Message them"}
        </button>
      </div>
    </div>
  );
}
