"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity, Bookmark, ExternalLink, Eye, Heart, Info, Loader2,
  MessageCircle, RefreshCw, Share2, Users, BarChart3,
} from "lucide-react";
import type { SocialOverviewResponse } from "@/app/api/channels/[channel]/overview/route";
import type { RecentPost, SocialChannel } from "@/lib/uploadpost/analytics";
import { Badge, Card, SectionTitle, fmt } from "@/components/ui";
import { MiniSpark } from "@/components/charts";
import { useInterval } from "@/hooks/use-interval";

const POLL_MS = 60_000;

const LABEL: Record<SocialChannel, string> = { instagram: "Instagram", facebook: "Facebook", linkedin: "LinkedIn" };
const COLOR: Record<SocialChannel, string> = { instagram: "#e1306c", facebook: "#1877f2", linkedin: "#0a66c2" };

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function relative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
}

/** Polls only while the tab is visible; the first tick fires on mount / on return. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

/**
 * Account analytics for a connector-backed Instagram / Facebook / LinkedIn
 * row: totals, a reach sparkline and the recent posts, polled live.
 */
export function SocialOverviewPanel({ brandId, channel }: { brandId: string; channel: SocialChannel }) {
  const [data, setData] = useState<SocialOverviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [throttled, setThrottled] = useState(0);
  const visible = useVisible();
  const inflight = useRef(false);

  const load = useCallback((fresh: boolean) => {
    if (inflight.current) return;
    inflight.current = true;
    setRefreshing(true);
    const qs = `brandId=${encodeURIComponent(brandId)}${fresh ? "&fresh=1" : ""}`;
    fetch(`/api/channels/${channel}/overview?${qs}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<SocialOverviewResponse>)
      .then((r) => {
        if (r.ok) {
          setData(r);
          setError(null);
          setThrottled(fresh && !r.fresh ? (r.retryAfter ?? 0) : 0);
        } else {
          setError(r.error ?? "Could not load analytics.");
        }
        setLastUpdated(new Date());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        inflight.current = false;
        setLoading(false);
        setRefreshing(false);
      });
  }, [brandId, channel]);

  const poll = useCallback(() => load(false), [load]);
  const refresh = useCallback(() => load(true), [load]);
  useInterval(poll, visible ? POLL_MS : null);

  useEffect(() => {
    if (throttled <= 0) return;
    const id = setTimeout(() => setThrottled((t) => t - 1), 1000);
    return () => clearTimeout(id);
  }, [throttled]);

  const a = data?.analytics ?? null;
  const t = a?.totals ?? null;
  const label = LABEL[channel];
  const color = COLOR[channel];
  const reachSeries = a?.reachSeries ?? [];
  const labelOf = (key: string, fallback: string) => a?.metricLabels?.[key] ?? fallback;

  return (
    <div className="space-y-6">
      <Card className="relative overflow-hidden">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border" style={{ background: `${color}22`, borderColor: `${color}66`, color }}>
              <BarChart3 size={22} />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight text-mist-100">{label} analytics</h2>
              <p className="text-[11.5px] text-mist-400">
                {data?.handle ?? (loading ? "Loading…" : "Not connected")}
                {a?.ok && ` · last ${a.periodDays} days as ${label} reports them`}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Badge tone={error ? "bad" : a?.ok ? "good" : "neutral"} pulse={!error && Boolean(a?.ok)}>
              <span className="inline-flex items-center gap-1"><Activity size={10} /> Live</span>
            </Badge>
            <span className="tnum text-[11px] text-mist-400">
              {lastUpdated ? `updated ${clock(lastUpdated)}` : "—"}
            </span>
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing || throttled > 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11.5px] text-mist-200 hover:border-ink-600 disabled:opacity-60"
            >
              {refreshing ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
              {throttled > 0 ? `Refresh in ${throttled}s` : "Refresh"}
            </button>
          </div>
        </div>

        {error && (
          <p className="mt-4 rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>
        )}

        {!error && data && !data.connected && (
          <p className="mt-4 rounded-lg border border-ink-800 px-3 py-2 text-[12px] text-mist-400">
            {label} is not linked through the publishing connector for this brand, so there are no account analytics to show.
          </p>
        )}

        {!error && a && !a.ok && (
          <div className="mt-4 rounded-lg border border-ink-800 bg-ink-900/40 px-3 py-3 text-[12px] text-mist-300">
            <div className="flex items-start gap-2">
              <Info size={14} className="mt-0.5 shrink-0 text-mist-400" />
              <div className="min-w-0 flex-1">
                {a.reason === "personal_unsupported" && (
                  <p>{a.message ?? `${label} reports analytics only for company pages you administer, not personal profiles.`}</p>
                )}
                {a.reason === "page_id_required" && <FacebookPageIdForm brandId={brandId} onSaved={refresh} />}
                {a.reason === "not_configured" && <p>The publishing connector is not configured, so {label} analytics cannot be read.</p>}
                {a.reason === "error" && <p>{a.message ?? `${label} analytics are unavailable right now.`}</p>}
              </div>
            </div>
          </div>
        )}

        {a?.ok && t && (
          <>
            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
              <Tile icon={<Users size={13} />} label="Followers" value={fmt.n(t.followers)} />
              <Tile icon={<Eye size={13} />} label={labelOf("reach", "Reach")} value={fmt.n(t.reach)} />
              <Tile icon={<Eye size={13} />} label={labelOf("views", "Views")} value={fmt.n(t.views || t.impressions)} />
              <Tile icon={<Heart size={13} />} label="Likes" value={fmt.n(t.likes)} />
              <Tile icon={<MessageCircle size={13} />} label="Comments" value={fmt.n(t.comments)} />
              <Tile icon={<Share2 size={13} />} label="Shares" value={fmt.n(t.shares)} />
              <Tile icon={<Bookmark size={13} />} label="Saves" value={fmt.n(t.saves)} />
            </div>
            <div className="mt-5">
              <div className="mb-1 flex items-center justify-between text-[11px] text-mist-400">
                <span>{labelOf("reach", "Reach")} per day</span>
                <span className="tnum">
                  {reachSeries.length ? `${reachSeries[0].date} → ${reachSeries[reachSeries.length - 1].date}` : "no daily series reported"}
                </span>
              </div>
              {reachSeries.length > 1 ? (
                <MiniSpark data={reachSeries.map((p) => p.value)} color={color} height={64} />
              ) : (
                <p className="py-3 text-center text-[12px] text-mist-400">{label} has not reported a daily reach series yet.</p>
              )}
            </div>
          </>
        )}
      </Card>

      {data?.connected && (
        <Card>
          <SectionTitle
            title="Recent posts"
            hint={`Published to ${label} through the publishing connector, newest first, with per-post figures where ${label} reports them`}
          />
          {loading ? (
            <p className="py-6 text-center text-[12.5px] text-mist-400">Loading…</p>
          ) : data.posts.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-mist-400">Nothing has been published to {label} through the connector yet.</p>
          ) : (
            <ul className="divide-y divide-ink-800/60">
              {data.posts.map((p) => <PostRow key={`${p.platformPostId ?? p.uploadedAt}`} post={p} />)}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function Tile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-3">
      <div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider text-mist-400">{icon}{label}</div>
      <div className="tnum mt-1 text-[19px] font-semibold tracking-tight text-mist-100">{value}</div>
    </div>
  );
}

function PostRow({ post }: { post: RecentPost }) {
  const m = post.metrics;
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-medium text-mist-100">{post.title || "Untitled post"}</span>
          <Badge tone="neutral">{post.mediaType || "post"}</Badge>
        </div>
        <div className="mt-0.5 text-[11px] text-mist-400">
          {post.uploadedAt ? relative(post.uploadedAt) : ""}
          {post.postUrl && (
            <a href={post.postUrl} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-0.5 text-mist-200 hover:underline">
              Open <ExternalLink size={10} />
            </a>
          )}
        </div>
      </div>
      <div className="tnum flex flex-wrap gap-3 text-[11.5px] text-mist-300">
        {m ? (
          <>
            <span className="inline-flex items-center gap-1"><Eye size={11} />{fmt.n(m.views || m.reach)}</span>
            <span className="inline-flex items-center gap-1"><Heart size={11} />{fmt.n(m.likes)}</span>
            <span className="inline-flex items-center gap-1"><MessageCircle size={11} />{fmt.n(m.comments)}</span>
            <span className="inline-flex items-center gap-1"><Share2 size={11} />{fmt.n(m.shares)}</span>
            <span className="inline-flex items-center gap-1"><Bookmark size={11} />{fmt.n(m.saves)}</span>
          </>
        ) : (
          <span className="text-mist-500">per-post figures not reported yet</span>
        )}
      </div>
    </li>
  );
}

function FacebookPageIdForm({ brandId, onSaved }: { brandId: string; onSaved: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const save = () => {
    setBusy(true);
    setMsg(null);
    fetch("/api/channels/facebook/page-id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ brandId, pageId: value }),
    })
      .then((r) => r.json() as Promise<{ ok: boolean; error?: string }>)
      .then((r) => {
        if (r.ok) { setMsg("Saved. Loading analytics…"); onSaved(); }
        else setMsg(r.error ?? "Could not save.");
      })
      .catch((e) => setMsg(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <div>
      <p>Facebook analytics need the Page id of the page the connector publishes to. Add it in settings here — it is the number in the page&apos;s About section or URL.</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          inputMode="numeric"
          placeholder="Facebook Page id"
          className="w-56 rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-ink-500"
        />
        <button
          type="button"
          onClick={save}
          disabled={busy || !value.trim()}
          className="rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Save page id"}
        </button>
        {msg && <span className="text-[11.5px] text-mist-400">{msg}</span>}
      </div>
    </div>
  );
}
