"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Check, Loader2, Send, Trash2, Upload, Zap,
} from "lucide-react";
import clsx from "clsx";
import { Badge, Card, SectionTitle } from "../ui";
import {
  FIELDS,
  INBOUND_SECRET_HEADER,
  MAX_REFERENCE_PHOTOS,
  N8N_PLATFORMS,
  type N8nPlatform,
  type N8nSubmission,
} from "@/lib/automation/types";

/**
 * THE n8n SCREEN.
 *
 * Two halves, because an operator's automation has two directions and they fail
 * for different reasons. The top half is the wiring — where events go, what n8n
 * must send back, and whether any of it is actually working. The bottom half is
 * the thing they use every day: the video-posting form their workflow already
 * exposes, recreated here so the whole job happens in one place.
 *
 * The registry is fetched rather than server-rendered. It lists every external
 * system wired into this business, so the API gates it on `workflows.manage`;
 * this screen is open to `marketing.read` so the people who actually post videos
 * can reach the form. Asking the API and rendering its refusal keeps that split
 * honest — there is exactly one gate, and it is the one on the data.
 */

/** Mirrors the shape `/api/integrations/n8n` returns, secrets already stripped. */
interface Subscriber {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
  createdBy: string;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  consecutiveFailures: number;
}

interface Delivery {
  id: string;
  subscriberId: string;
  url: string;
  event: string;
  at: string;
  ok: boolean;
  attempts: number;
  status?: number;
  error?: string;
  durationMs: number;
}

const INPUT =
  "w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[12.5px] text-mist-100 outline-none placeholder:text-mist-500 focus:border-brand-500";
const BUTTON =
  "flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-50";

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function when(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

/**
 * Field label plus its help text, so every hint sits in the same place.
 *
 * A plain wrapper rather than a `<label>`: the platform picker's children are
 * buttons, and a label containing several controls binds itself to the first
 * one — clicking the caption would have toggled YouTube.
 */
function Field({ label, hint, required, children }: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1.5">
        <span className="text-[11.5px] font-medium text-mist-200">{label}</span>
        {required && <span className="text-[10px] uppercase tracking-wider text-bad-400">required</span>}
      </div>
      {hint && <p className="mb-1.5 text-[10.5px] leading-relaxed text-mist-400">{hint}</p>}
      {children}
    </div>
  );
}

export function N8nPanel({
  inboundUrl,
  inboundSecretConfigured,
  formUrlProblem,
  submissions,
}: {
  inboundUrl: string;
  /** Whether N8N_WEBHOOK_SECRET is set. The value itself never leaves the server. */
  inboundSecretConfigured: boolean;
  /** Why the video form cannot submit, or null when it can. */
  formUrlProblem: string | null;
  submissions: N8nSubmission[];
}) {
  return (
    <div className="space-y-5">
      <ConnectionHalf inboundUrl={inboundUrl} inboundSecretConfigured={inboundSecretConfigured} />
      <VideoPostHalf formUrlProblem={formUrlProblem} />
      <SubmissionHistory rows={submissions} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* (a) Connection                                                             */
/* -------------------------------------------------------------------------- */

function ConnectionHalf({
  inboundUrl,
  inboundSecretConfigured,
}: {
  inboundUrl: string;
  inboundSecretConfigured: boolean;
}) {
  const [subscribers, setSubscribers] = useState<Subscriber[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [chosen, setChosen] = useState<string[]>(["*"]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/integrations/n8n");
      const json = await res.json();
      if (!res.ok || !json.ok) {
        // A 403 here is not a fault — it is the registry's own gate answering.
        // Rendering it as "0 subscribers" would tell a marketing user that
        // nothing is wired up, which may be the opposite of the truth.
        setDenied(json.error ?? "The webhook registry could not be read.");
        return;
      }
      setDenied(null);
      setSubscribers(json.subscribers ?? []);
      setDeliveries(json.deliveries ?? []);
      setEvents(json.events ?? []);
    } catch {
      setDenied("The webhook registry could not be reached.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function toggleEvent(name: string) {
    setChosen((c) => {
      // "*" and a hand-picked list are alternatives, not a combination — the
      // wildcard already includes everything, so keeping both would render a
      // selection that lies about what will be delivered.
      if (name === "*") return ["*"];
      const without = c.filter((x) => x !== "*");
      return without.includes(name) ? without.filter((x) => x !== name) : [...without, name];
    });
  }

  async function register(e: React.FormEvent) {
    e.preventDefault();
    setBusy("register");
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/integrations/n8n", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), events: chosen, secret }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "The subscriber was not registered.");
        return;
      }
      // Cleared immediately: the secret is write-only server-side, and leaving
      // it sitting in an input is the one copy of it a shoulder can read.
      setSecret("");
      setUrl("");
      setNote(`Registered ${host(json.subscriber.url)}. Copy the signing secret into your n8n workflow now — it is never shown again.`);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    setError(null);
    setNote(null);
    try {
      const res = await fetch(`/api/integrations/n8n?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "The subscriber was not removed.");
        return;
      }
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function test(id: string) {
    setBusy(id);
    setError(null);
    setNote(null);
    try {
      const res = await fetch("/api/integrations/n8n/test", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscriberId: id }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "The test event was not sent.");
        return;
      }
      const d = json.delivery as Delivery;
      setNote(
        d.ok
          ? `${host(d.url)} accepted the test (${d.status}) after ${d.attempts} attempt(s), in ${d.durationMs} ms.`
          : `${host(d.url)} did not accept it: ${d.error ?? `status ${d.status}`} after ${d.attempts} attempt(s).`,
      );
      await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <SectionTitle
        title="Connection"
        hint="Where this system sends events, and how n8n calls back into it"
      />

      <div className="grid gap-4 xl:grid-cols-2">
        {/* Inbound — what the operator pastes into their n8n HTTP Request node. */}
        <div className="rounded-xl border border-ink-700 p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <ArrowDownToLine size={14} className="text-mist-400" />
            <span className="text-[12.5px] font-medium text-mist-100">n8n → Glentree</span>
            <Badge tone={inboundSecretConfigured ? "good" : "bad"}>
              {inboundSecretConfigured ? "secret set" : "secret not set"}
            </Badge>
          </div>
          <p className="mb-2.5 text-[11px] leading-relaxed text-mist-400">
            Point an n8n HTTP Request node at this URL to create a lead, book a site visit or queue a
            message. Authenticate it with the header below — the value lives in the server environment
            and is never displayed here.
          </p>
          <dl className="space-y-1.5 text-[11px]">
            <div>
              <dt className="text-mist-400">URL</dt>
              <dd className="mt-0.5 break-all rounded-lg bg-ink-850 px-2 py-1.5 font-mono text-[11px] text-mist-200">
                POST {inboundUrl}
              </dd>
            </div>
            <div>
              <dt className="text-mist-400">Header</dt>
              <dd className="mt-0.5 rounded-lg bg-ink-850 px-2 py-1.5 font-mono text-[11px] text-mist-200">
                {INBOUND_SECRET_HEADER}: &lt;N8N_WEBHOOK_SECRET&gt;
              </dd>
            </div>
          </dl>
          {!inboundSecretConfigured && (
            <p className="mt-2 rounded-lg bg-bad-500/10 px-2 py-1.5 text-[11px] text-bad-400">
              N8N_WEBHOOK_SECRET is unset, so this endpoint refuses every request rather than
              accepting unauthenticated writes. Set it in the environment and restart.
            </p>
          )}
        </div>

        {/* Outbound — register the workflow's webhook. */}
        <div className="rounded-xl border border-ink-700 p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <ArrowUpFromLine size={14} className="text-mist-400" />
            <span className="text-[12.5px] font-medium text-mist-100">Glentree → n8n</span>
          </div>

          {denied ? (
            <p className="rounded-lg bg-ink-850 px-2.5 py-2 text-[11.5px] text-mist-400">{denied}</p>
          ) : (
            <form onSubmit={register} className="space-y-2.5">
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://your-n8n.example.com/webhook/orbit"
                className={INPUT}
              />
              <input
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                type="password"
                placeholder="Signing secret — at least 24 characters"
                className={INPUT}
              />
              <div className="flex flex-wrap gap-1">
                {["*", ...events].map((name) => (
                  <button
                    key={name}
                    type="button"
                    onClick={() => toggleEvent(name)}
                    className={clsx(
                      "rounded-lg border px-2 py-1 text-[10.5px]",
                      chosen.includes(name)
                        ? "border-brand-500 bg-brand-500/12 text-mist-100"
                        : "border-ink-700 text-mist-400 hover:border-ink-600",
                    )}
                  >
                    {name === "*" ? "every event" : name}
                  </button>
                ))}
              </div>
              <p className="text-[10.5px] leading-relaxed text-mist-400">
                Deliveries are signed HMAC-SHA256 over the raw body and sent as{" "}
                <code className="rounded bg-ink-800 px-1">x-glentree-signature</code>. The secret is stored
                write-only — nothing can read it back, so keep your copy.
              </p>
              <button type="submit" disabled={busy === "register" || !url || !secret} className={BUTTON}>
                {busy === "register" ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                Register workflow
              </button>
            </form>
          )}
        </div>
      </div>

      {error && <p className="mt-3 rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>}
      {note && <p className="mt-3 rounded-lg bg-good-500/10 px-3 py-2 text-[12px] text-good-400">{note}</p>}

      {!denied && (
        <>
          <div className="mt-5">
            <SectionTitle title="Registered workflows" />
            {loading ? (
              <p className="py-6 text-center text-[12px] text-mist-400">Loading…</p>
            ) : !subscribers.length ? (
              <p className="py-6 text-center text-[12px] text-mist-400">
                No workflow is registered, so no event leaves this system yet.
              </p>
            ) : (
              <div className="space-y-2">
                {subscribers.map((s) => (
                  <div key={s.id} className="flex flex-wrap items-center gap-2.5 rounded-xl border border-ink-700 p-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[12.5px] text-mist-100">{host(s.url)}</span>
                        <Badge tone={s.consecutiveFailures > 0 ? "bad" : s.lastSuccessAt ? "good" : "neutral"}>
                          {s.consecutiveFailures > 0
                            ? `${s.consecutiveFailures} failing`
                            : s.lastSuccessAt
                              ? "delivering"
                              : "untested"}
                        </Badge>
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {s.events.map((e) => (
                          <span key={e} className="rounded bg-ink-800 px-1.5 py-0.5 text-[9.5px] text-mist-400">
                            {e === "*" ? "every event" : e}
                          </span>
                        ))}
                      </div>
                      <div className="mt-0.5 text-[10.5px] text-mist-400">
                        Added {when(s.createdAt)} by {s.createdBy} · last success {when(s.lastSuccessAt)}
                      </div>
                    </div>
                    <button onClick={() => test(s.id)} disabled={busy === s.id} className={BUTTON}>
                      {busy === s.id ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
                      Send test event
                    </button>
                    <button
                      onClick={() => remove(s.id)}
                      disabled={busy === s.id}
                      className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-400 hover:border-bad-500/50 hover:text-bad-400 disabled:opacity-50"
                    >
                      <Trash2 size={13} /> Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
            <p className="mt-2 text-[10.5px] leading-relaxed text-mist-400">
              A test event carries <code className="rounded bg-ink-800 px-1">{`{ "test": true }`}</code> as
              its data and nothing else — no invented booking — and is signed and retried exactly like a
              real one. Branch on that flag in your workflow.
            </p>
          </div>

          <div className="mt-5">
            <SectionTitle title="Recent deliveries" hint="What was actually sent, and what came back" />
            {!deliveries.length ? (
              <p className="py-6 text-center text-[12px] text-mist-400">
                Nothing has been delivered yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-[11.5px]">
                  <thead>
                    <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                      <th className="py-1.5 font-medium">When</th>
                      <th className="py-1.5 font-medium">Event</th>
                      <th className="py-1.5 font-medium">Endpoint</th>
                      <th className="py-1.5 text-right font-medium">Status</th>
                      <th className="py-1.5 text-right font-medium">Attempts</th>
                      <th className="py-1.5 font-medium">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deliveries.map((d) => (
                      <tr key={d.id} className="border-b border-ink-800/60 last:border-0">
                        <td className="tnum py-1.5 text-mist-300">{when(d.at)}</td>
                        <td className="py-1.5 text-mist-300">{d.event}</td>
                        <td className="py-1.5 text-mist-400">{host(d.url)}</td>
                        <td className="py-1.5 text-right">
                          <Badge tone={d.ok ? "good" : "bad"}>{d.status ?? (d.ok ? "ok" : "no reply")}</Badge>
                        </td>
                        <td className="tnum py-1.5 text-right text-mist-300">{d.attempts}</td>
                        <td className="max-w-[240px] truncate py-1.5 text-bad-400" title={d.error}>
                          {d.error ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* (b) Video posting form                                                     */
/* -------------------------------------------------------------------------- */

function VideoPostHalf({ formUrlProblem }: { formUrlProblem: string | null }) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);

  const [platforms, setPlatforms] = useState<N8nPlatform[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function togglePlatform(p: N8nPlatform) {
    setPlatforms((list) => (list.includes(p) ? list.filter((x) => x !== p) : [...list, p]));
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setNote(null);

    const form = new FormData(e.currentTarget);
    // The checkbox group is held in React state rather than as inputs, so the
    // chosen platforms are appended here — and appended one per part, which the
    // route accepts alongside n8n's own comma-separated shape.
    for (const p of platforms) form.append(FIELDS.platforms, p);

    const references = form.getAll(FIELDS.referencePhotos).filter((f) => f instanceof File && f.size > 0);
    if (references.length > MAX_REFERENCE_PHOTOS) {
      setError(`Choose at most ${MAX_REFERENCE_PHOTOS} reference photos.`);
      return;
    }
    if (!platforms.length) {
      setError("Choose at least one platform.");
      return;
    }

    setSending(true);
    try {
      const res = await fetch("/api/automation/post-video", { method: "POST", body: form });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error ?? "The video was not sent — nothing was posted.");
        // The refused attempt is recorded server-side, so refresh to show it
        // rather than leaving the history disagreeing with the message above.
        router.refresh();
        return;
      }
      setNote(`"${json.submission.title}" was handed to the workflow for ${json.submission.platforms.join(", ")}.`);
      formRef.current?.reset();
      setPlatforms([]);
      router.refresh();
    } catch {
      setError("The upload did not complete. Nothing was sent.");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <SectionTitle
        title="Post a video"
        hint="Goes to your n8n workflow exactly as its own form would — this app does not upload to any network itself"
      />

      {formUrlProblem && (
        <p className="mb-4 flex items-start gap-2 rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {formUrlProblem} Until then this form will refuse rather than accept a video it cannot deliver.
          </span>
        </p>
      )}

      <form ref={formRef} onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label={FIELDS.video} required>
            <input type="file" name={FIELDS.video} accept="video/mp4,video/quicktime,video/webm" className={INPUT} />
          </Field>

          <Field
            label={FIELDS.finalThumbnail}
            hint="upload a finished image to use as THE thumbnail, skips AI generation and review, auto cropped to 16:9, 1:1 and 9:16"
          >
            <input type="file" name={FIELDS.finalThumbnail} accept="image/jpeg,image/png,image/webp" className={INPUT} />
          </Field>

          <Field
            label={FIELDS.referencePhotos}
            hint={`photos of the exact faces or products to feature, used by AI generation only — up to ${MAX_REFERENCE_PHOTOS}`}
          >
            <input
              type="file"
              name={FIELDS.referencePhotos}
              accept="image/jpeg,image/png,image/webp"
              multiple
              className={INPUT}
            />
          </Field>

          <Field label={FIELDS.title} required>
            <input name={FIELDS.title} className={INPUT} placeholder="The title the video is published under" />
          </Field>
        </div>

        <Field label={FIELDS.description} required>
          <textarea name={FIELDS.description} rows={4} className={clsx(INPUT, "resize-y leading-relaxed")} />
        </Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label={FIELDS.thumbnailText} hint="exact words to show on the thumbnail">
            <input name={FIELDS.thumbnailText} className={INPUT} />
          </Field>

          <Field label={FIELDS.extraInstructions} hint="colors, mood, objects">
            <textarea name={FIELDS.extraInstructions} rows={2} className={clsx(INPUT, "resize-y leading-relaxed")} />
          </Field>
        </div>

        <Field label={FIELDS.platforms} required>
          <div className="flex flex-wrap gap-1.5">
            {N8N_PLATFORMS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => togglePlatform(p)}
                className={clsx(
                  "flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12px]",
                  platforms.includes(p)
                    ? "border-brand-500 bg-brand-500/12 text-mist-100"
                    : "border-ink-700 text-mist-300 hover:border-ink-600",
                )}
              >
                {platforms.includes(p) && <Check size={12} />}
                {p}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid gap-4 md:grid-cols-3">
          <Field label={FIELDS.driveFolder} hint="leave blank for default folder">
            <input name={FIELDS.driveFolder} className={INPUT} />
          </Field>

          <Field label={FIELDS.createFolder}>
            <select name={FIELDS.createFolder} defaultValue="yes" className={INPUT}>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </Field>

          {/* Defaults to no: a link-shareable Drive folder is a public copy of
              unpublished marketing material, so sharing is a choice somebody
              makes rather than one the form makes for them. */}
          <Field label={FIELDS.publicLink}>
            <select name={FIELDS.publicLink} defaultValue="no" className={INPUT}>
              <option value="yes">yes</option>
              <option value="no">no</option>
            </select>
          </Field>
        </div>

        <Field label={FIELDS.telegramChatId} hint="blank skips review, get yours from @userinfobot">
          <input name={FIELDS.telegramChatId} className={INPUT} />
        </Field>

        {error && <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>}
        {note && <p className="rounded-lg bg-good-500/10 px-3 py-2 text-[12px] text-good-400">{note}</p>}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={sending}
            className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-[12.5px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-50"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
            {sending ? "Sending to n8n…" : "Submit"}
          </button>
          {sending && (
            <span className="text-[11px] text-mist-400">
              The whole file is uploaded twice — to here, then to n8n. Leave this tab open.
            </span>
          )}
        </div>
      </form>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Submission history                                                         */
/* -------------------------------------------------------------------------- */

function SubmissionHistory({ rows }: { rows: N8nSubmission[] }) {
  return (
    <Card>
      <SectionTitle title="Submitted videos" hint="Every hand-off to the workflow, and what it answered" />
      {!rows.length ? (
        <p className="py-8 text-center text-[12.5px] text-mist-400">
          No video has been sent to the workflow from here yet. Submissions made in n8n&apos;s own form are
          not visible to this app, so this list only shows what went through this screen.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-[11.5px]">
            <thead>
              <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                <th className="py-1.5 font-medium">When</th>
                <th className="py-1.5 font-medium">Title</th>
                <th className="py-1.5 font-medium">Platforms</th>
                <th className="py-1.5 font-medium">By</th>
                <th className="py-1.5 text-right font-medium">Status</th>
                <th className="py-1.5 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id} className="border-b border-ink-800/60 last:border-0">
                  <td className="tnum py-1.5 text-mist-300">{when(s.at)}</td>
                  <td className="max-w-[220px] truncate py-1.5 text-mist-100">{s.title}</td>
                  <td className="py-1.5 text-mist-400">{s.platforms.join(", ")}</td>
                  <td className="max-w-[160px] truncate py-1.5 text-mist-400">{s.by}</td>
                  <td className="py-1.5 text-right">
                    <Badge tone={s.status === "forwarded" ? "good" : s.status === "failed" ? "bad" : "warn"}>
                      {s.status}
                    </Badge>
                  </td>
                  <td className="max-w-[240px] truncate py-1.5 text-mist-400" title={s.error}>
                    {s.error ?? (s.n8nStatus ? `n8n answered ${s.n8nStatus}` : "")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
