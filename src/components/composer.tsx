"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Check, Clock, Loader2, Sparkles, Wand2 } from "lucide-react";
import clsx from "clsx";
import type { Brand, ChannelId, Connection, MediaAsset, PostFormat } from "@/lib/types";
import { Badge, Card, SectionTitle } from "./ui";

/**
 * COMPOSER
 *
 * One idea → per-network variants → validated → scheduled.
 *
 * The two things that make this genuinely useful rather than a textarea:
 *  1. Validation is live and comes from each platform's real capability set, so
 *     you cannot schedule something that will fail at 6am.
 *  2. Each network gets its own caption. Cross-posting identical text is the most
 *     common reason multi-channel publishing underperforms.
 */

interface Props {
  brand: Brand;
  /**
   * Deliberately NOT `Connection & {...}`.
   *
   * Requiring the full Connection here forced the server page to hand over
   * every field on the record — including accessToken and refreshToken — and
   * left the page stripping secrets by hand. Naming only the fields this
   * component renders makes a credential in client props a type error rather
   * than a leak nobody notices.
   */
  connections: Array<Pick<Connection, "id" | "channel" | "handle" | "status"> & {
    label: string;
    color: string;
    capabilities: Caps;
  }>;
  media: MediaAsset[];
  slots: Array<{ isoTime: string; reason: string }>;
}

interface Caps {
  formats: PostFormat[];
  captionLimit: number;
  hashtagLimit: number;
  supportsFirstComment: boolean;
  supportsStories: boolean;
}

const FORMATS: PostFormat[] = ["reel", "feed", "story", "carousel"];
const TONES = ["warm", "punchy", "luxury", "playful", "informative"] as const;

export function Composer({ brand, connections, media, slots }: Props) {
  const [topic, setTopic] = useState("");
  const [format, setFormat] = useState<PostFormat>("reel");
  const [tone, setTone] = useState<(typeof TONES)[number]>("warm");
  const [cta, setCta] = useState("");
  const [selected, setSelected] = useState<string[]>(connections.filter((c) => c.channel === "instagram").map((c) => c.id));
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [master, setMaster] = useState("");
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [firstComment, setFirstComment] = useState("");
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [when, setWhen] = useState(slots[0]?.isoTime ?? "");
  const [busy, setBusy] = useState<"copy" | "save" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Only offer channels that support the chosen format.
  const eligible = useMemo(
    () => connections.filter((c) => c.capabilities.formats.includes(format) || (c.channel === "youtube" && format === "reel") || c.channel === "google_business"),
    [connections, format],
  );

  const chosen = eligible.filter((c) => selected.includes(c.id));

  /** Live per-channel validation mirroring what the adapters enforce server-side. */
  const issues = useMemo(() => {
    const out: Array<{ id: string; label: string; message: string }> = [];
    for (const c of chosen) {
      const text = captions[c.id] ?? master;
      const tagText = hashtags.map((h) => `#${h}`).join(" ");
      const len = `${text} ${tagText}`.trim().length;
      if (len > c.capabilities.captionLimit) {
        out.push({ id: c.id, label: c.label, message: `${len} chars — ${c.label} allows ${c.capabilities.captionLimit}` });
      }
      if (hashtags.length > c.capabilities.hashtagLimit) {
        out.push({ id: c.id, label: c.label, message: `${hashtags.length} hashtags — ${c.label} allows ${c.capabilities.hashtagLimit}` });
      }
      if (!text.trim()) out.push({ id: c.id, label: c.label, message: "Caption is empty" });
      if (format !== "text" && mediaIds.length === 0) {
        out.push({ id: c.id, label: c.label, message: `${format} posts need media attached` });
      }
      if (format === "carousel" && mediaIds.length < 2) {
        out.push({ id: c.id, label: c.label, message: "A carousel needs at least 2 items" });
      }
    }
    return out;
  }, [chosen, captions, master, hashtags, format, mediaIds]);

  async function generate() {
    if (!topic.trim()) return;
    setBusy("copy");
    setResult(null);
    try {
      const res = await fetch("/api/ai/copy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brandId: brand.id,
          topic,
          format,
          tone,
          cta: cta || undefined,
          channels: [...new Set(chosen.map((c) => c.channel))] as ChannelId[],
        }),
      });
      const json = await res.json();
      const variants: Array<{ channel: ChannelId; caption: string; hashtags: string[]; firstComment?: string }> = json.variants ?? [];
      const next: Record<string, string> = {};
      for (const c of chosen) {
        const v = variants.find((x) => x.channel === c.channel);
        if (v) next[c.id] = v.caption;
      }
      setCaptions(next);
      setMaster(variants[0]?.caption ?? "");
      setHashtags(variants[0]?.hashtags ?? []);
      setFirstComment(variants.find((v) => v.firstComment)?.firstComment ?? "");
    } finally {
      setBusy(null);
    }
  }

  async function schedule(status: "scheduled" | "draft" | "needs_approval") {
    setBusy("save");
    setResult(null);
    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brandId: brand.id,
          caption: master,
          hashtags,
          mediaIds,
          connectionIds: chosen.map((c) => c.id),
          format,
          scheduledAt: when || undefined,
          perChannelCaptions: captions,
          firstComment: firstComment || undefined,
          status,
        }),
      });
      const json = await res.json();
      setResult(
        json.ok
          ? { ok: true, message: `Saved to ${chosen.length} channel${chosen.length === 1 ? "" : "s"} as ${status.replace("_", " ")}` }
          : { ok: false, message: (json.errors ?? ["Could not save"]).join(" · ") },
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <div className="space-y-5">
        <Card>
          <SectionTitle title="What is this post about?" hint="One line is enough — the AI writes the variants" />
          {/* A brand with no offerings recorded yet would interpolate "undefined". */}
          <input
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            placeholder={brand.offerings[0] ? `e.g. ${brand.offerings[0]} — what makes it different` : "What makes this worth posting about"}
            className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] outline-none placeholder:text-mist-500 focus:border-brand-500"
          />

          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-mist-400">Format</label>
              <div className="flex flex-wrap gap-1">
                {FORMATS.map((f) => (
                  <button
                    key={f}
                    onClick={() => setFormat(f)}
                    className={clsx("rounded-lg border px-2 py-1 text-[11.5px] capitalize", format === f ? "border-brand-500 bg-brand-500/12 text-mist-100" : "border-ink-700 text-mist-300 hover:border-ink-600")}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-mist-400">Tone</label>
              <select value={tone} onChange={(e) => setTone(e.target.value as never)} className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] capitalize outline-none">
                {TONES.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-[11px] font-medium text-mist-400">Call to action</label>
              <input value={cta} onChange={(e) => setCta(e.target.value)} placeholder="e.g. Learn more" className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12px] outline-none placeholder:text-mist-500" />
            </div>
          </div>

          <button
            onClick={generate}
            disabled={!topic.trim() || !chosen.length || busy === "copy"}
            className="mt-3 flex items-center gap-2 rounded-lg bg-brand-500 px-3 py-2 text-[12.5px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
          >
            {busy === "copy" ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            Write {chosen.length} channel variant{chosen.length === 1 ? "" : "s"}
          </button>
        </Card>

        <Card>
          <SectionTitle title="Publish to" hint={`${chosen.length} of ${eligible.length} eligible channels selected`} />
          <div className="grid gap-2 sm:grid-cols-2">
            {eligible.map((c) => {
              const on = selected.includes(c.id);
              const broken = c.status !== "connected";
              return (
                <button
                  key={c.id}
                  disabled={broken}
                  onClick={() => setSelected((s) => (on ? s.filter((x) => x !== c.id) : [...s, c.id]))}
                  className={clsx(
                    "flex items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors",
                    on ? "border-brand-500/60 bg-brand-500/[0.07]" : "border-ink-700 hover:border-ink-600",
                    broken && "cursor-not-allowed opacity-45",
                  )}
                >
                  <span className="grid h-7 w-7 place-items-center rounded-lg text-[11px] font-bold text-white" style={{ background: c.color }}>
                    {c.label[0]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] font-medium text-mist-100">{c.label}</span>
                    <span className="block truncate text-[10.5px] text-mist-400">{c.handle}</span>
                  </span>
                  {broken ? <Badge tone="bad">{c.status}</Badge> : on && <Check size={14} className="text-brand-400" />}
                </button>
              );
            })}
          </div>
        </Card>

        <Card>
          <SectionTitle title="Media" hint="Edited clips come from the Video Studio, already rendered per aspect ratio" />
          <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
            {media.slice(0, 12).map((m) => {
              const on = mediaIds.includes(m.id);
              return (
                <button
                  key={m.id}
                  onClick={() => setMediaIds((s) => (on ? s.filter((x) => x !== m.id) : [...s, m.id]))}
                  className={clsx("relative aspect-[9/16] overflow-hidden rounded-lg border-2 transition-colors", on ? "border-brand-500" : "border-ink-700 hover:border-ink-600")}
                  style={{ background: `linear-gradient(150deg, ${brand.color}44, #10141f)` }}
                >
                  <span className="absolute inset-x-1 bottom-1 truncate text-left text-[9px] text-mist-200">{m.tags[0]}</span>
                  {m.kind === "video" && <span className="absolute left-1 top-1 rounded bg-black/50 px-1 text-[8px] text-white">{m.durationSec}s</span>}
                  {on && <span className="absolute right-1 top-1 grid h-4 w-4 place-items-center rounded-full bg-brand-500 text-[var(--a-on)]"><Check size={9} /></span>}
                </button>
              );
            })}
          </div>
        </Card>
      </div>

      <div className="space-y-5">
        {issues.length > 0 && (
          <Card className="border-warn-500/30 bg-warn-500/[0.04]">
            <div className="mb-2 flex items-center gap-2 text-[12px] font-medium text-warn-400">
              <AlertTriangle size={13} /> {issues.length} issue{issues.length === 1 ? "" : "s"} to fix before scheduling
            </div>
            <ul className="space-y-1 text-[11.5px] text-mist-300">
              {issues.map((i, n) => (
                <li key={n}>· {i.message}</li>
              ))}
            </ul>
          </Card>
        )}

        <Card>
          <SectionTitle title="Per-channel copy" hint="Each network gets text written for it, not a copy-paste" />
          {chosen.length === 0 && <p className="text-[12px] text-mist-400">Select at least one channel.</p>}
          <div className="space-y-3">
            {chosen.map((c) => {
              const text = captions[c.id] ?? master;
              const len = text.length;
              const over = len > c.capabilities.captionLimit;
              return (
                <div key={c.id}>
                  <div className="mb-1 flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full" style={{ background: c.color }} />
                    <span className="text-[11.5px] font-medium text-mist-200">{c.label}</span>
                    <span className={clsx("tnum ml-auto text-[10.5px]", over ? "text-bad-400" : "text-mist-400")}>
                      {len}/{c.capabilities.captionLimit}
                    </span>
                  </div>
                  <textarea
                    value={text}
                    onChange={(e) => setCaptions((s) => ({ ...s, [c.id]: e.target.value }))}
                    rows={4}
                    placeholder="Write, or hit Generate above"
                    className={clsx(
                      "w-full resize-y rounded-lg border bg-ink-850 px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-mist-500",
                      over ? "border-bad-500/60" : "border-ink-700 focus:border-brand-500",
                    )}
                  />
                </div>
              );
            })}
          </div>

          <div className="mt-3">
            <label className="mb-1 block text-[11px] font-medium text-mist-400">Hashtags</label>
            {/* States the input format rather than showing sample tags: any example
                we hard-code belongs to one industry and misleads every other brand. */}
            <input
              value={hashtags.join(" ")}
              onChange={(e) => setHashtags(e.target.value.split(/[\s,]+/).map((h) => h.replace(/^#/, "")).filter(Boolean))}
              placeholder="Space or comma separated, no # needed"
              className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] outline-none placeholder:text-mist-500"
            />
          </div>

          {chosen.some((c) => c.capabilities.supportsFirstComment) && (
            <div className="mt-3">
              <label className="mb-1 block text-[11px] font-medium text-mist-400">
                First comment <span className="text-mist-500">— where hashtags belong on Instagram</span>
              </label>
              <input
                value={firstComment}
                onChange={(e) => setFirstComment(e.target.value)}
                className="w-full rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[12px] outline-none"
              />
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle title="When" hint="Slots ranked by this account's own engagement history" />
          <div className="space-y-1.5">
            {slots.map((s) => (
              <button
                key={s.isoTime}
                onClick={() => setWhen(s.isoTime)}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left",
                  when === s.isoTime ? "border-brand-500 bg-brand-500/10" : "border-ink-700 hover:border-ink-600",
                )}
              >
                <Clock size={13} className="text-brand-400" />
                <span className="tnum text-[12px] font-medium text-mist-100">
                  {new Date(s.isoTime).toLocaleString("en", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <span className="ml-auto truncate text-[10.5px] text-mist-400">{s.reason}</span>
              </button>
            ))}
            <input
              type="datetime-local"
              value={when ? new Date(when).toISOString().slice(0, 16) : ""}
              onChange={(e) => setWhen(new Date(e.target.value).toISOString())}
              className="w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-2 text-[12px] outline-none"
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              onClick={() => schedule("scheduled")}
              disabled={busy === "save" || issues.length > 0 || !chosen.length}
              className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3.5 py-2 text-[12.5px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-40"
            >
              {busy === "save" ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Schedule
            </button>
            <button onClick={() => schedule("needs_approval")} disabled={busy === "save"} className="rounded-lg border border-ink-700 px-3 py-2 text-[12.5px] text-mist-200 hover:border-ink-600">
              Send for approval
            </button>
            <button onClick={() => schedule("draft")} disabled={busy === "save"} className="rounded-lg border border-ink-700 px-3 py-2 text-[12.5px] text-mist-200 hover:border-ink-600">
              Save draft
            </button>
          </div>
          {result && (
            <p className={clsx("mt-2 text-[11.5px]", result.ok ? "text-good-400" : "text-bad-400")}>{result.message}</p>
          )}
        </Card>
      </div>
    </div>
  );
}
