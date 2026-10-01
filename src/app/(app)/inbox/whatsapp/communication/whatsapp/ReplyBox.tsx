"use client";

import { useEffect, useState } from "react";
import { Clock, FileText, Loader2, Lock, Send } from "lucide-react";

/**
 * The WhatsApp composer.
 *
 * Client-side for one reason that matters: the 24-hour customer-service window
 * expires while the tab is open. A server-rendered composer would happily keep
 * offering a free-text box twenty minutes after Meta stopped accepting one, and
 * the rep would only find out when the send failed. The countdown here is
 * derived from a real timestamp (the customer's last inbound message), and when
 * it hits zero the composer switches itself to template-only.
 */

const MAX_TEXT = 4096;

function formatLeft(ms: number): string {
  if (ms <= 0) return "Window closed";
  const minutes = Math.floor(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m left` : `${minutes}m left`;
}

export default function ReplyBox({
  conversationId,
  windowClosesAt,
  initiallyOpen,
  initialLabel,
  preferredLanguage,
  windowApplies = true,
  channel = "whatsapp",
  textLimit = MAX_TEXT,
  returnTo,
}: {
  conversationId: string;
  /** ISO instant free-text stops being allowed. Null when the customer never wrote. */
  windowClosesAt: string | null;
  initiallyOpen: boolean;
  initialLabel: string;
  preferredLanguage: string;
  /**
   * False on Evolution, which has no service window and no template approval.
   * The countdown and the template-only lock are Meta rules; showing them on a
   * deployment they do not govern invents a deadline the rep does not have.
   */
  windowApplies?: boolean;
  /**
   * Which transport this thread is on, so the copy names the surface the rep
   * is actually typing into rather than always saying WhatsApp.
   */
  channel?: string;
  /** The transport's own cap — Instagram stops at 1000 where WhatsApp allows 4096. */
  textLimit?: number;
  /**
   * Where to land after sending. The composer now appears on the inbox as well
   * as the WhatsApp console, and a rep who replies from the inbox should stay
   * on the inbox — being thrown into a different screen mid-conversation reads
   * as the app losing their place. Defaults to the console it was written for,
   * so the existing call site is unchanged.
   *
   * The server still validates this against an allowlist before redirecting;
   * it is a convenience, not a trusted value.
   */
  returnTo?: string;
}) {
  // Null until mounted so the first client render matches the server's.
  const [now, setNow] = useState<number | null>(null);
  const [mode, setMode] = useState<"text" | "template">("text");
  const [text, setText] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [templateParams, setTemplateParams] = useState("");

  /**
   * One send per press.
   *
   * These are ordinary form POSTs, so the browser navigates and the page
   * reloads — but that takes as long as the server takes, and nothing stopped
   * a second press in the meantime. Somebody who pressed Send five times
   * because the page had not moved yet sent the customer five messages.
   *
   * Set on submit and never cleared: the navigation replaces this component,
   * so there is no state to restore, and leaving it latched means a failed
   * submit cannot be retried by hammering the button either.
   */
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const closesAt = windowClosesAt ? new Date(windowClosesAt).getTime() : null;
  const live = now !== null && closesAt !== null;
  const open = !windowApplies || (live ? now < closesAt : initiallyOpen);
  const label = live ? formatLeft(closesAt - now) : initialLabel;

  // Message templates are a WhatsApp Business feature; Instagram Direct and
  // Messenger have no equivalent, so a closed window there is simply closed.
  const templatesAvailable = channel === "whatsapp";
  const channelName =
    channel === "instagram" ? "Instagram" : channel === "facebook" ? "Messenger" : "this channel";

  // A closed window falls back to the template composer — but only where
  // templates exist. On Instagram and Messenger it would be a form that cannot
  // send, so the composer is withheld entirely and the notice above stands alone.
  const composing = open ? mode : templatesAvailable ? "template" : "none";
  const over = text.length > textLimit;
  const params = templateParams
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);

  const next = returnTo ?? `/inbox/whatsapp/communication/whatsapp?c=${conversationId}`;

  return (
    <div className="mt-5 border-t border-[var(--color-line)] pt-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {windowApplies ? (
          <span
            className={`pill ${
              open
                ? "bg-[color-mix(in_oklab,var(--c-good)_14%,transparent)] text-[var(--color-success)]"
                : "bg-[color-mix(in_oklab,var(--c-warn)_14%,transparent)] text-[var(--color-warm)]"
            }`}
          >
            {open ? <Clock size={12} strokeWidth={2} aria-hidden /> : <Lock size={12} strokeWidth={2} aria-hidden />}
            24h window · {label}
          </span>
        ) : (
          <span className="text-[11px] text-[var(--color-faint)]">
            No sending window on this connection — you can reply at any time.
          </span>
        )}

        {open && templatesAvailable && (
          <div className="flex items-center gap-1 rounded-xl border border-[var(--color-line)] bg-[var(--color-void)] p-1">
            {(["text", "template"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setMode(value)}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  mode === value
                    ? "bg-[var(--color-gold-soft)] text-[var(--color-gold-100)]"
                    : "text-[var(--color-muted)] hover:text-[var(--color-ink)]"
                }`}
              >
                {value === "text" ? "Free text" : "Template"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!open && (
        <div className="mb-3 rounded-xl border border-[var(--color-gold-line)] bg-[var(--color-gold-soft)] p-4">
          <h3 className="flex items-center gap-2 text-sm font-semibold text-[var(--color-gold-300)]">
            <Lock size={14} strokeWidth={2} aria-hidden />
            Free text is disabled
          </h3>
          {templatesAvailable ? (
            <>
              <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-ink)]">
                Meta only accepts a free-form message within 24 hours of the customer&apos;s last
                inbound one. That window has closed, so the only message the WhatsApp Cloud API
                will deliver to this number is a <strong>pre-approved template</strong>. Sending
                one re-opens the window as soon as the customer replies.
              </p>
              <p className="mt-2 text-xs text-[var(--color-muted)]">
                Templates are created and approved in the Meta Business Manager, not here — this
                box takes the approved template&apos;s name.
              </p>
            </>
          ) : (
            <p className="mt-1.5 text-sm leading-relaxed text-[var(--color-ink)]">
              Meta only accepts a message within 24 hours of the customer&apos;s last inbound one,
              and {channelName} has no template to re-open it with. Nothing can be sent on this
              thread until they write again. If it matters now, reach them on another channel.
            </p>
          )}
        </div>
      )}

      {composing === "text" ? (
        <form
          action="/api/osf/communication"
          method="POST"
          onSubmit={(event) => {
            if (sending) {
              event.preventDefault();
              return;
            }
            setSending(true);
          }}
        >
          <input type="hidden" name="action" value="send_text" />
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="next" value={next} />

          <textarea
            name="text"
            rows={3}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Reply as a human. This pauses the AI on this lead."
            className="field resize-y"
          />

          <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-muted)]">
              Sending sets{" "}
              <code className="rounded bg-[var(--color-raised)] px-1.5 py-0.5 text-[11px] text-[var(--color-gold-100)]">
                ai_paused
              </code>{" "}
              so the agent stops replying on this thread.
            </p>
            <div className="flex items-center gap-3">
              <span
                className={`text-xs tabular-nums ${
                  over ? "text-[var(--color-danger)]" : "text-[var(--color-faint)]"
                }`}
              >
                {text.length.toLocaleString("en-IN")} / {textLimit.toLocaleString("en-IN")}
              </span>
              <button
                type="submit"
                className="btn-gold"
                disabled={sending || text.trim() === "" || over}
              >
                {sending ? (
                  <Loader2 size={14} className="animate-spin" aria-hidden />
                ) : (
                  <Send size={14} strokeWidth={2} aria-hidden />
                )}
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </form>
      ) : composing === "none" ? null : (
        <form
          action="/api/osf/communication"
          method="POST"
          className="space-y-3"
          onSubmit={(event) => {
            if (sending) {
              event.preventDefault();
              return;
            }
            setSending(true);
          }}
        >
          <input type="hidden" name="action" value="send_template" />
          <input type="hidden" name="conversationId" value={conversationId} />
          <input type="hidden" name="next" value={next} />

          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_140px]">
            <label className="block">
              <span className="label">Approved template name</span>
              <input
                name="templateName"
                value={templateName}
                onChange={(event) => setTemplateName(event.target.value)}
                placeholder="site_visit_reminder"
                className="field mt-1.5"
                autoComplete="off"
              />
            </label>
            <label className="block">
              <span className="label">Language</span>
              <input
                name="language"
                defaultValue={preferredLanguage}
                placeholder="en"
                className="field mt-1.5"
                autoComplete="off"
              />
            </label>
          </div>

          <label className="block">
            <span className="label">Body variables</span>
            <input
              name="params"
              value={templateParams}
              onChange={(event) => setTemplateParams(event.target.value)}
              placeholder="Ravi | Saturday 11am"
              className="field mt-1.5"
              autoComplete="off"
            />
            <span className="mt-1.5 block text-xs text-[var(--color-muted)]">
              Separate with <code className="rounded bg-[var(--color-raised)] px-1 py-0.5 text-[11px]">|</code>.
              They fill {"{{1}}"}, {"{{2}}"} … in the approved body, in order.
            </span>
          </label>

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[var(--color-muted)]">
              {templateName.trim()
                ? `Sends "${templateName.trim().toLowerCase()}" with ${params.length} variable${
                    params.length === 1 ? "" : "s"
                  }.`
                : "The name must match the template exactly as approved in Meta."}
            </p>
            <button type="submit" className="btn-gold" disabled={sending || templateName.trim() === ""}>
              <FileText size={14} strokeWidth={2} aria-hidden />
              Send template
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
