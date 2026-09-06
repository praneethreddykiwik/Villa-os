"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, Eye, Info, Loader2,
  MessageCircle, Play, RefreshCw, ThumbsUp, Tv2, Users, Youtube,
  CheckCircle2, Globe2, Lock, Trophy, Activity, BarChart3,
} from "lucide-react";
import type { YouTubeCommentThread, YouTubeSnapshot } from "@/lib/youtube/public";
import { computeTotals, performancePct, rankByViews, type RecentComment, type YouTubeTotals } from "@/lib/youtube/studio";
import { Badge, Card, SectionTitle, fmt } from "@/components/ui";
import { useInterval } from "@/hooks/use-interval";

type Snapshot = YouTubeSnapshot & { handle: string; fresh?: boolean; retryAfter?: number };
type SnapshotResponse = ({ ok: true } & Snapshot) | { ok: false; code?: string; error: string };
type CommentsResponse = { ok: true; threads: YouTubeCommentThread[] } | { ok: false; code?: string; error: string };
type RecentResponse = { ok: true; comments: RecentComment[] } | { ok: false; code?: string; error: string };

const POLL_MS = 30_000; // 30s live polling interval
const RECENT_POLL_MS = 120_000; // matches the server's 2-min comment cache

/**
 * Owner-only metrics need the Google OAuth client from docs/platform-oauth-setup.md
 * section 1. The repo's docs/ are not served, so the pill deep-links to
 * /connections (where the YouTube "Connect" lives) and names the guide.
 */
const OAUTH_DOC = "/connections";
const OAUTH_DOC_LABEL = "docs/platform-oauth-setup.md §1";

function duration(s: number): string {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

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
 * YouTube Studio Dashboard — real-time analytics, latest video performance,
 * video list with stats dropdown, channel totals and live comment feeds.
 */
export function YouTubeVideos({ brandId }: { brandId: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [throttled, setThrottled] = useState<number>(0);
  const visible = useVisible();
  const inflight = useRef(false);

  const load = useCallback((fresh: boolean) => {
    if (inflight.current) return;
    inflight.current = true;
    setRefreshing(true);
    const qs = `brandId=${encodeURIComponent(brandId)}${fresh ? "&fresh=1" : ""}`;
    fetch(`/api/channels/youtube/videos?${qs}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<SnapshotResponse>)
      .then((r) => {
        if (r.ok) {
          setSnap(r);
          setError(null);
          // Server said "not this time": surface the wait instead of pretending it was fresh.
          setThrottled(fresh && !r.fresh ? (r.retryAfter ?? 0) : 0);
        } else {
          setError(r.error);
        }
        setLastUpdated(new Date());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        inflight.current = false;
        setLoading(false);
        setRefreshing(false);
      });
  }, [brandId]);

  const poll = useCallback(() => load(false), [load]);
  const refresh = useCallback(() => load(true), [load]);

  useInterval(poll, visible ? POLL_MS : null);

  // Count the throttle notice down so it clears itself.
  useEffect(() => {
    if (throttled <= 0) return;
    const id = setTimeout(() => setThrottled((t) => t - 1), 1000);
    return () => clearTimeout(id);
  }, [throttled]);

  const totals = snap ? computeTotals(snap.videos) : null;
  const latest = snap && snap.videos.length > 0 ? snap.videos[0] : null;

  return (
    <div className="space-y-6">
      {/* Studio Header Card */}
      <Card className="relative overflow-hidden border-brand-500/20 bg-gradient-to-r from-red-500/[0.07] via-ink-900/50 to-ink-900/30">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            {snap?.channel.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={snap.channel.thumbnail}
                alt={snap.channel.title}
                className="h-14 w-14 rounded-2xl border-2 border-red-500/40 object-cover shadow-lg"
              />
            ) : (
              <div className={`grid h-14 w-14 place-items-center rounded-2xl bg-red-600/20 text-red-400 border border-red-500/30 ${loading ? "animate-pulse" : ""}`}>
                <Youtube size={28} />
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold tracking-tight text-mist-100">
                  {snap?.channel.title || (loading ? <span className="inline-block h-5 w-40 rounded bg-ink-800 animate-pulse align-middle" /> : "YouTube Channel")}
                </h2>
                <Badge tone="good" className="text-[10px]">
                  <CheckCircle2 size={10} className="mr-0.5" /> Studio Connected
                </Badge>
              </div>
              <p className="text-xs text-mist-400 flex items-center gap-2 mt-0.5 min-h-[16px]">
                <span>{snap?.handle || "@channel"}</span>
                <span>·</span>
                <span>{snap ? `${fmt.full(snap.channel.stats.subscribers)} subscribers` : "Loading channel…"}</span>
                {snap && <><span>·</span><span>{fmt.full(snap.channel.stats.videos)} uploads</span></>}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live indicator: green while polling, grey when the tab is hidden */}
            <div className="flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900/70 px-3 py-1 text-[11px] backdrop-blur-md">
              <span className={`beacon-dot ${visible ? "bg-good-400" : "bg-mist-500"}`} />
              <span className={`font-medium ${visible ? "text-good-400" : "text-mist-400"}`}>{visible ? "Live" : "Paused"}</span>
              <span className="tnum text-mist-500 text-[10px] min-w-[92px]">
                {lastUpdated ? `updated ${clock(lastUpdated)}` : "connecting…"}
              </span>
              <button
                type="button"
                onClick={refresh}
                disabled={refreshing}
                title={throttled > 0 ? `Fresh read available in ${throttled}s` : "Refresh from YouTube now (bypasses cache)"}
                className="ml-1 inline-flex items-center gap-1 text-mist-400 hover:text-mist-100 transition-colors disabled:opacity-60"
              >
                <RefreshCw size={11} className={refreshing ? "animate-spin text-brand-300" : ""} />
                <span className="text-[10.5px] font-medium">Refresh</span>
              </button>
            </div>

            {snap && (
              <a
                href={`https://www.youtube.com/${snap.handle}`}
                target="_blank"
                rel="noreferrer"
                className="liquid-glass-button inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium text-mist-200 hover:text-white"
              >
                <Youtube size={13} className="text-red-500" />
                <span>Open YouTube</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>
        {throttled > 0 && (
          <p className="mt-2 text-[10.5px] text-warn-400">Fresh reads are limited to one per 20s to protect the daily quota — cached figures shown; try again in {throttled}s.</p>
        )}

        {/* Studio Top KPI Cards */}
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-5 border-t border-ink-800/60 pt-4">
          {snap && totals ? (
            <>
              <StudioStatCard icon={Users} label="Subscribers" value={fmt.full(snap.channel.stats.subscribers)} tone="text-purple-400" />
              <StudioStatCard icon={Tv2} label="Uploads" value={fmt.full(snap.channel.stats.videos)} tone="text-mist-300" />
              <StudioStatCard icon={Eye} label="Channel Views" value={fmt.n(totals.views)} tone="text-blue-400" />
              <StudioStatCard icon={ThumbsUp} label="Total Likes" value={fmt.n(totals.likes)} tone="text-emerald-400" />
              <StudioStatCard icon={MessageCircle} label="Total Comments" value={fmt.n(totals.comments)} tone="text-amber-400" />
            </>
          ) : (
            Array.from({ length: 5 }, (_, i) => <StatSkeleton key={i} />)
          )}
        </div>
      </Card>

      {/* Latest Video Performance Card (Classic YouTube Studio Signature Widget) */}
      {loading && !snap ? (
        <Card className="border-brand-500/20 bg-ink-950/40">
          <SectionTitle title="Latest video performance" hint="Real-time status of your most recent upload on YouTube" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            <div className="aspect-video rounded-xl bg-ink-900 animate-pulse" />
            <div className="md:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {Array.from({ length: 3 }, (_, i) => <div key={i} className="h-[92px] rounded-xl bg-ink-900 animate-pulse" />)}
            </div>
          </div>
        </Card>
      ) : latest && snap && totals ? (
        <Card className="border-brand-500/20 bg-ink-950/40">
          <SectionTitle
            title="Latest video performance"
            hint="Real-time status of your most recent upload on YouTube"
            action={
              <a
                href={latest.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-brand-300 hover:text-brand-200"
              >
                Watch on YouTube <ExternalLink size={10} />
              </a>
            }
          />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-5 items-center">
            {/* Thumbnail + Title */}
            <div className="md:col-span-1">
              <div className="relative group overflow-hidden rounded-xl border border-ink-800 bg-ink-900 aspect-video">
                {latest.thumbnail ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={latest.thumbnail} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" />
                ) : (
                  <div className="h-full w-full grid place-items-center bg-ink-850 text-mist-500">
                    <Youtube size={32} />
                  </div>
                )}
                <span className="absolute bottom-2 right-2 rounded bg-black/80 px-1.5 py-0.5 text-[10.5px] font-semibold text-white backdrop-blur-sm">
                  {duration(latest.duration)}
                </span>
                <a
                  href={latest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="absolute inset-0 grid place-items-center bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  <span className="grid h-10 w-10 place-items-center rounded-full bg-red-600 text-white shadow-lg">
                    <Play size={18} className="translate-x-0.5" />
                  </span>
                </a>
              </div>
              <h3 className="mt-2.5 text-[13px] font-semibold text-mist-100 line-clamp-2 leading-snug">
                {latest.title}
              </h3>
              <p className="text-[11px] text-mist-400 mt-1">
                Published {latest.publishedAt ? new Date(latest.publishedAt).toLocaleDateString("en", { dateStyle: "medium" }) : "—"}
                {latest.publishedAt && <span className="text-mist-500"> · {relative(latest.publishedAt)}</span>}
              </p>
            </div>

            {/* Performance breakdown pills */}
            <div className="md:col-span-2 grid grid-cols-2 sm:grid-cols-3 gap-3">
              <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3.5">
                <div className="flex items-center justify-between text-mist-400 text-[11px]">
                  <span>Ranking by views</span>
                  <span className="tnum font-semibold text-mist-200 inline-flex items-center gap-1">
                    <Trophy size={11} className="text-amber-400" /> {rankByViews(snap.videos, latest.id)} of {snap.videos.length}
                  </span>
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="tnum text-2xl font-bold text-mist-100">{fmt.n(latest.views)}</span>
                  <span className="text-[11px] text-mist-400">views</span>
                </div>
                <PerfBar views={latest.views} avg={totals.avgViews} />
              </div>

              <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3.5">
                <div className="flex items-center justify-between text-mist-400 text-[11px]">
                  <span>Likes</span>
                  <ThumbsUp size={12} className="text-emerald-400" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="tnum text-2xl font-bold text-emerald-400">{fmt.n(latest.likes)}</span>
                  <span className="text-[11px] text-mist-400">likes</span>
                </div>
                <div className="mt-1 text-[10.5px] text-mist-400">
                  {latest.views > 0 ? `${((latest.likes / latest.views) * 100).toFixed(1)}% of viewers` : "Public engagement"}
                </div>
              </div>

              <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3.5">
                <div className="flex items-center justify-between text-mist-400 text-[11px]">
                  <span>Comments</span>
                  <MessageCircle size={12} className="text-amber-400" />
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="tnum text-2xl font-bold text-amber-400">{fmt.n(latest.comments)}</span>
                  <span className="text-[11px] text-mist-400">threads</span>
                </div>
                <div className="mt-1 text-[10.5px] text-mist-400">Community discussion</div>
              </div>

              <div className="col-span-2 sm:col-span-3 flex flex-wrap items-center gap-2 text-[10.5px] text-mist-500">
                <Lock size={10} />
                <span>Avg view duration, impressions and CTR are owner-only metrics.</span>
                <OAuthPill />
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {/* Analytics API Note */}
      <div className="flex items-start gap-2.5 rounded-xl border border-ink-800 bg-ink-900/30 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-mist-400">
        <Info size={14} className="mt-0.5 shrink-0 text-mist-300" />
        <span>
          Views, likes, uploads, and comments sync live every 30 seconds from YouTube&apos;s public API while this tab is open.
          Private owner-only metrics like impressions and CTR require a Google OAuth client with YouTube Analytics permissions
          (see {OAUTH_DOC_LABEL}).
        </span>
      </div>

      {/* Videos List (Channel Content Table) */}
      <Card>
        <SectionTitle
          title="Published videos"
          hint={snap ? `${snap.videos.length} public upload${snap.videos.length === 1 ? "" : "s"} on ${snap.channel.title}` : "All uploads"}
        />

        {loading && !snap ? (
          <TableSkeleton />
        ) : error && !snap ? (
          <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>
        ) : !snap || snap.videos.length === 0 ? (
          <div className="py-10 text-center">
            <Youtube size={28} className="mx-auto text-mist-500" />
            <p className="mt-2 text-[12.5px] text-mist-300">No public uploads yet</p>
            <p className="text-[11.5px] text-mist-500">Videos appear here as soon as they are published on the channel.</p>
          </div>
        ) : (
          <>
            {error && <p className="mb-3 rounded-lg bg-warn-500/10 px-3 py-1.5 text-[11px] text-warn-400">Last refresh failed ({error}); showing the previous snapshot.</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-[12px]">
                <thead>
                  <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                    <th className="py-2.5 font-medium">Video</th>
                    <th className="py-2.5 font-medium">Visibility</th>
                    <th className="py-2.5 font-medium">Date</th>
                    <th className="py-2.5 text-right font-medium">Length</th>
                    <th className="py-2.5 text-right font-medium">Views</th>
                    <th className="py-2.5 text-right font-medium">Likes</th>
                    <th className="py-2.5 text-right font-medium">Comments</th>
                    <th className="py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {snap.videos.map((v) => {
                    const isExpanded = open === v.id;
                    return (
                      <VideoRowItem
                        key={v.id}
                        video={v}
                        rank={rankByViews(snap.videos, v.id)}
                        total={snap.videos.length}
                        avgViews={totals?.avgViews ?? 0}
                        expanded={isExpanded}
                        onToggle={() => setOpen(isExpanded ? null : v.id)}
                      />
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Channel totals */}
            {totals && <TotalsBlock totals={totals} subscribers={snap.channel.stats.subscribers} hiddenSubs={snap.channel.stats.hiddenSubscriberCount} />}
          </>
        )}
      </Card>

      {/* Latest comments across the last 10 uploads */}
      <RecentCommentsFeed brandId={brandId} enabled={Boolean(snap && snap.videos.length > 0)} visible={visible} />
    </div>
  );
}

function OAuthPill() {
  return (
    <a
      href={OAUTH_DOC}
      title={`Connect the channel owner via Google OAuth — setup guide: ${OAUTH_DOC_LABEL}`}
      className="inline-flex items-center gap-1 rounded-full border border-warn-500/30 bg-warn-500/10 px-2 py-0.5 text-[10px] font-medium text-warn-400 hover:bg-warn-500/20 transition-colors"
    >
      <Lock size={9} /> Impressions / CTR / watch time: needs Google OAuth
    </a>
  );
}

/** "This video vs channel average" — 50% of the track is exactly average. */
function PerfBar({ views, avg }: { views: number; avg: number }) {
  const pct = performancePct(views, avg);
  const above = avg > 0 && views >= avg;
  return (
    <div className="mt-2">
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
        <div className={`h-full rounded-full transition-[width] duration-500 ${above ? "bg-good-400" : "bg-brand-400"}`} style={{ width: `${pct}%` }} />
        <span className="absolute inset-y-0 left-1/2 w-px bg-mist-500/60" title="Channel average" />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-mist-500">
        <span>vs channel avg {fmt.n(avg)}</span>
        <span className={`tnum ${above ? "text-good-400" : "text-mist-400"}`}>{avg > 0 ? `${Math.round((views / avg) * 100)}%` : "—"}</span>
      </div>
    </div>
  );
}

function TotalsBlock({ totals, subscribers, hiddenSubs }: { totals: YouTubeTotals; subscribers: number; hiddenSubs: boolean }) {
  const cells: Array<{ label: string; value: string; icon: typeof Eye; tone: string }> = [
    { label: "Total views", value: fmt.full(totals.views), icon: Eye, tone: "text-blue-400" },
    { label: "Total likes", value: fmt.full(totals.likes), icon: ThumbsUp, tone: "text-emerald-400" },
    { label: "Total comments", value: fmt.full(totals.comments), icon: MessageCircle, tone: "text-amber-400" },
    { label: "Subscribers", value: hiddenSubs ? "hidden" : fmt.full(subscribers), icon: Users, tone: "text-purple-400" },
    { label: "Uploads", value: fmt.full(totals.uploads), icon: Tv2, tone: "text-mist-300" },
    { label: "Avg views / video", value: fmt.n(totals.avgViews), icon: BarChart3, tone: "text-brand-300" },
    { label: "Engagement rate", value: `${(totals.engagementRate * 100).toFixed(2)}%`, icon: Activity, tone: "text-good-400" },
  ];
  return (
    <div className="mt-4 border-t border-ink-800 pt-4">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">Channel totals</p>
        <OAuthPill />
      </div>
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
        {cells.map((c) => (
          <div key={c.label} className="rounded-lg border border-ink-800/80 bg-ink-900/50 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-mist-400">
              <c.icon size={11} className={c.tone} /> {c.label}
            </div>
            <div className="tnum mt-1 text-[15px] font-bold text-mist-100">{c.value}</div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-mist-500">Engagement rate = (likes + comments) ÷ views across public uploads.</p>
    </div>
  );
}

function StatSkeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-ink-800/80 bg-ink-900/50 p-3.5 min-h-[74px]">
      <span className="h-3 w-16 rounded bg-ink-800 animate-pulse" />
      <span className="h-5 w-20 rounded bg-ink-800 animate-pulse" />
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2 py-2">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="flex items-center gap-3 border-b border-ink-800/50 py-3">
          <span className="h-11 w-20 rounded-lg bg-ink-900 animate-pulse" />
          <span className="h-3.5 flex-1 max-w-[280px] rounded bg-ink-800 animate-pulse" />
          <span className="ml-auto h-3.5 w-12 rounded bg-ink-800 animate-pulse" />
          <span className="h-3.5 w-12 rounded bg-ink-800 animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function StudioStatCard({
  icon: Icon, label, value, tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-xl border border-ink-800/80 bg-ink-900/50 p-3.5 shadow-sm min-h-[74px]">
      <div className="flex items-center gap-1.5 text-mist-400">
        <Icon size={13} className={tone} />
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <span className="tnum text-[20px] font-bold tracking-tight text-mist-100 mt-1">{value}</span>
    </div>
  );
}

function VideoRowItem({
  video: v,
  rank,
  total,
  avgViews,
  expanded,
  onToggle,
}: {
  video: Snapshot["videos"][number];
  rank: number;
  total: number;
  avgViews: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        className="border-b border-ink-800/50 transition-colors hover:bg-ink-850/40 cursor-pointer"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <td className="py-3 pr-3">
          <div className="flex items-center gap-3">
            <div className="relative shrink-0 overflow-hidden rounded-lg bg-ink-900 border border-ink-800 h-11 w-20">
              {v.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="h-full w-full grid place-items-center bg-ink-800 text-mist-500">
                  <Youtube size={16} />
                </div>
              )}
              <span className="absolute bottom-1 right-1 rounded bg-black/80 px-1 text-[9px] font-semibold text-white">
                {duration(v.duration)}
              </span>
            </div>
            <div className="min-w-0">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggle(); }}
                className="flex items-center gap-1 text-left text-mist-100 hover:text-brand-300 transition-colors font-medium"
              >
                {expanded ? (
                  <ChevronDown size={13} className="shrink-0 text-brand-400" />
                ) : (
                  <ChevronRight size={13} className="shrink-0 text-mist-400" />
                )}
                <span className="max-w-[320px] truncate">{v.title || v.id}</span>
              </button>
              <div className="text-[10.5px] text-mist-500 mt-0.5">ID: {v.id}</div>
            </div>
          </div>
        </td>
        <td className="py-3">
          <span className="inline-flex items-center gap-1 rounded-full bg-good-500/10 border border-good-500/25 px-2 py-0.5 text-[10.5px] font-semibold text-good-400">
            <Globe2 size={10} /> Public
          </span>
        </td>
        <td className="py-3 text-mist-400 text-[11.5px]">
          {v.publishedAt ? new Date(v.publishedAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" }) : "—"}
        </td>
        <td className="tnum py-3 text-right text-mist-300 font-mono text-[11.5px]">{duration(v.duration)}</td>
        <td className="tnum py-3 text-right font-semibold text-mist-100">{fmt.n(v.views)}</td>
        <td className="tnum py-3 text-right text-emerald-400 font-semibold">{fmt.n(v.likes)}</td>
        <td className="tnum py-3 text-right text-amber-400 font-semibold">{fmt.n(v.comments)}</td>
        <td className="py-3 text-right">
          <div className="flex items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              className="rounded-lg border border-ink-700 bg-ink-800/80 px-2 py-1 text-[11px] font-medium text-mist-300 hover:text-white hover:bg-ink-700 transition-colors"
            >
              {expanded ? "Hide" : "Details"}
            </button>
            <a
              href={v.url}
              target="_blank"
              rel="noreferrer"
              title="Watch on YouTube"
              onClick={(e) => e.stopPropagation()}
              className="grid h-7 w-7 place-items-center rounded-lg border border-ink-700 bg-ink-800/80 text-mist-300 hover:text-red-400 hover:bg-ink-700 transition-colors"
            >
              <ExternalLink size={12} />
            </a>
          </div>
        </td>
      </tr>

      {/* Expanded Accordion Panel with Stats and Comments */}
      {expanded && (
        <tr className="border-b border-ink-800/50 bg-ink-900/40">
          <td colSpan={8} className="p-4">
            <div className="space-y-4 rounded-xl border border-ink-800 bg-ink-950/60 p-4">
              {/* Stat row for this video */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <DetailStat icon={Eye} label="Views" value={fmt.full(v.views)} color="text-blue-400" />
                <DetailStat icon={ThumbsUp} label="Likes" value={fmt.full(v.likes)} color="text-emerald-400" />
                <DetailStat icon={MessageCircle} label="Comments" value={fmt.full(v.comments)} color="text-amber-400" />
                <DetailStat icon={Tv2} label="Length" value={duration(v.duration)} color="text-mist-300" />
                <DetailStat icon={Trophy} label="Rank by views" value={`${rank} of ${total}`} color="text-amber-400" />
              </div>

              {/* Performance vs channel average */}
              <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-3.5 py-2.5">
                <p className="text-[10px] uppercase tracking-wider text-mist-400">Performance vs channel average</p>
                <PerfBar views={v.views} avg={avgViews} />
              </div>

              {/* Direct links */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-[11.5px]">
                <a
                  href={v.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-red-400 hover:text-red-300 font-medium"
                >
                  <Play size={12} /> Watch on YouTube
                </a>
                <span className="text-mist-600">·</span>
                <span className="text-mist-400">Published {v.publishedAt ? new Date(v.publishedAt).toLocaleString("en", { dateStyle: "medium", timeStyle: "short" }) : "—"}</span>
                <span className="text-mist-600">·</span>
                <span className="text-mist-400 break-all">URL: {v.url}</span>
              </div>

              {/* Comments */}
              <div className="border-t border-ink-800 pt-3">
                <p className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-mist-400 flex items-center gap-1.5">
                  <MessageCircle size={12} /> Top Comments
                  <span className="tnum normal-case tracking-normal text-mist-500">· {fmt.full(v.comments)} on YouTube</span>
                </p>
                <CommentsSection videoId={v.id} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function DetailStat({
  icon: Icon, label, value, color,
}: {
  icon: typeof Eye;
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-ink-800 bg-ink-900/60 px-3.5 py-2.5">
      <Icon size={16} className={color} />
      <div>
        <p className="tnum text-[15px] font-bold text-mist-100">{value}</p>
        <p className="text-[10px] uppercase tracking-wider text-mist-400">{label}</p>
      </div>
    </div>
  );
}

function CommentItem({ t, video }: { t: YouTubeCommentThread; video?: { title: string; url: string } }) {
  return (
    <li className="flex gap-3 text-[12px] rounded-lg border border-ink-800/40 bg-ink-900/30 p-2.5">
      {t.authorAvatar ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={t.authorAvatar} alt="" className="mt-0.5 h-6 w-6 shrink-0 rounded-full object-cover" loading="lazy" />
      ) : (
        <span className="mt-0.5 h-6 w-6 shrink-0 rounded-full bg-ink-800" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-mist-400">
          <span className="font-semibold text-mist-200">{t.author}</span>
          <span title={t.publishedAt}>{t.publishedAt ? relative(t.publishedAt) : ""}</span>
          <span className="tnum inline-flex items-center gap-1 text-emerald-400 font-medium">
            <ThumbsUp size={10} /> {fmt.n(t.likeCount)}
          </span>
          <span className="tnum text-mist-400">{fmt.n(t.replies)} {t.replies === 1 ? "reply" : "replies"}</span>
        </div>
        <p className="mt-1 whitespace-pre-wrap break-words text-mist-100">{t.text}</p>
        {video && (
          <a href={video.url} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 text-[10.5px] text-mist-500 hover:text-brand-300">
            <Play size={9} className="shrink-0" /> <span className="truncate">on: {video.title}</span>
          </a>
        )}
      </div>
    </li>
  );
}

function CommentsSection({ videoId }: { videoId: string }) {
  const [threads, setThreads] = useState<YouTubeCommentThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/channels/youtube/comments?videoId=${encodeURIComponent(videoId)}`)
      .then((r) => r.json() as Promise<CommentsResponse>)
      .then((r) => {
        if (!active) return;
        if (r.ok) {
          setThreads(r.threads);
        } else {
          setError(r.error);
        }
      })
      .catch((e) => active && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => active && setLoading(false));

    return () => {
      active = false;
    };
  }, [videoId]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-3 text-[12px] text-mist-400">
        <Loader2 size={13} className="animate-spin" /> Loading comments from YouTube…
      </p>
    );
  }

  if (error) {
    return <p className="py-2 text-[12px] text-mist-400">{error}</p>;
  }

  if (!threads || threads.length === 0) {
    return <p className="py-3 text-[12px] text-mist-400">No public comments on this video yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {threads.map((t) => <CommentItem key={t.id} t={t} />)}
    </ul>
  );
}

/** Newest comments across the last 10 uploads; polls every 2 min (the server cache TTL) while visible. */
function RecentCommentsFeed({ brandId, enabled, visible }: { brandId: string; enabled: boolean; visible: boolean }) {
  const [comments, setComments] = useState<RecentComment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<Date | null>(null);

  const load = useCallback(() => {
    fetch(`/api/channels/youtube/recent-comments?brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<RecentResponse>)
      .then((r) => {
        if (r.ok) { setComments(r.comments); setError(null); } else setError(r.error);
        setUpdated(new Date());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [brandId]);

  useInterval(load, enabled && visible ? RECENT_POLL_MS : null);

  return (
    <Card>
      <SectionTitle
        title="Comments"
        hint="Latest public comments across your last 10 uploads"
        action={updated ? <span className="tnum text-[10.5px] text-mist-500">updated {clock(updated)}</span> : undefined}
      />
      {!enabled ? (
        <p className="py-6 text-center text-[12px] text-mist-500">Comments appear once the channel has public uploads.</p>
      ) : comments === null && !error ? (
        <ul className="space-y-3">
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex gap-3 rounded-lg border border-ink-800/40 bg-ink-900/30 p-2.5">
              <span className="h-6 w-6 rounded-full bg-ink-800 animate-pulse" />
              <div className="flex-1 space-y-2">
                <span className="block h-3 w-32 rounded bg-ink-800 animate-pulse" />
                <span className="block h-3 w-3/4 rounded bg-ink-800 animate-pulse" />
              </div>
            </li>
          ))}
        </ul>
      ) : error && !comments ? (
        <p className="py-2 text-[12px] text-mist-400">{error}</p>
      ) : !comments || comments.length === 0 ? (
        <div className="py-8 text-center">
          <MessageCircle size={24} className="mx-auto text-mist-500" />
          <p className="mt-2 text-[12.5px] text-mist-300">No comments yet</p>
          <p className="text-[11.5px] text-mist-500">New public comments on recent uploads will show up here.</p>
        </div>
      ) : (
        <ul className="space-y-3">
          {comments.map((c) => <CommentItem key={c.id} t={c} video={{ title: c.videoTitle, url: c.videoUrl }} />)}
        </ul>
      )}
    </Card>
  );
}
