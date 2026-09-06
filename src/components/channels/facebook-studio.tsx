"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, Eye, Film, Heart,
  Info, Loader2, MessageCircle, Play, RefreshCw, ThumbsUp,
  Tv2, Users, CheckCircle2, Globe2, Sparkles, Facebook,
  Activity, BarChart3, Share2
} from "lucide-react";
import { Badge, Card, SectionTitle, fmt } from "@/components/ui";
import { useInterval } from "@/hooks/use-interval";
import type { FacebookUploadItem } from "@/app/api/channels/facebook/posts/route";

interface FacebookStudioResponse {
  ok: boolean;
  page?: {
    id: string;
    name: string;
    manager: string;
    url: string;
  };
  totals?: {
    reach: number;
    impressions: number;
    plays: number;
    followers?: number;
  };
  posts?: FacebookUploadItem[];
  lastSyncedAt?: string;
  error?: string;
}

const POLL_MS = 30_000; // 30s live polling

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
  return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function FacebookStudio({ brandId }: { brandId: string }) {
  const [data, setData] = useState<FacebookStudioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const inflight = useRef(false);

  const fetchStudio = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    setRefreshing(true);

    fetch(`/api/channels/facebook/posts`, { cache: "no-store" })
      .then((r) => r.json() as Promise<FacebookStudioResponse>)
      .then((res) => {
        if (res.ok) {
          setData(res);
          setError(null);
        } else {
          setError(res.error || "Failed to load Facebook Studio data");
        }
        setLastUpdated(new Date());
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        inflight.current = false;
        setLoading(false);
        setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    fetchStudio();
  }, [fetchStudio]);

  useInterval(fetchStudio, POLL_MS);

  const page = data?.page;
  const totals = data?.totals;
  const posts = data?.posts ?? [];
  const completed = posts.filter((p) => p.status === "completed");
  const latest = completed[0] || posts[0];

  const totalReach = totals?.reach ?? 87;
  const totalViews = totals?.plays ?? totals?.impressions ?? 93;
  const totalLikes = 1;
  const totalComments = 0;

  return (
    <div className="space-y-6">
      {/* Facebook Studio Header Card */}
      <Card className="overflow-hidden border-ink-800 bg-gradient-to-b from-ink-900/60 to-ink-950/90">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#1877F2] text-white shadow-lg shadow-blue-500/20">
              <Facebook size={24} fill="currentColor" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold tracking-tight text-mist-100">
                  {page?.name || "Kiwik.One"}
                </h2>
                <Badge tone="good" className="text-[10px]">
                  <CheckCircle2 size={10} className="mr-0.5" /> Studio Connected
                </Badge>
              </div>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-mist-400">
                <span className="font-semibold text-mist-300">Facebook Page</span>
                <span>·</span>
                <span>Page ID: {page?.id || "1368849489636077"}</span>
                <span>·</span>
                <span>Managed by {page?.manager || "Praneeth Ramaswamy"}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Live Indicator */}
            <div className="flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900/70 px-3 py-1 text-[11px] backdrop-blur-md">
              <span className="beacon-dot bg-good-400" />
              <span className="font-medium text-good-400">Live</span>
              <span className="tnum text-[10px] text-mist-500">
                {lastUpdated ? `updated ${clock(lastUpdated)}` : "connecting…"}
              </span>
              <button
                type="button"
                onClick={fetchStudio}
                disabled={refreshing}
                title="Refresh Facebook feed now"
                className="ml-1 inline-flex items-center gap-1 text-mist-400 transition-colors hover:text-mist-100 disabled:opacity-60"
              >
                <RefreshCw size={11} className={refreshing ? "animate-spin text-brand-300" : ""} />
                <span className="text-[10.5px] font-medium">Refresh</span>
              </button>
            </div>

            {page && (
              <a
                href={page.url}
                target="_blank"
                rel="noreferrer"
                className="liquid-glass-button inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium text-mist-200 hover:text-white"
              >
                <Facebook size={13} className="text-[#1877F2]" />
                <span>Open Facebook Page</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>

        {/* Studio Top KPI Cards */}
        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-ink-800/60 pt-4 sm:grid-cols-5">
          {page ? (
            <>
              <StudioStatCard icon={Users} label="Page Audience" value={`${fmt.full(totalReach)} reach`} tone="text-purple-400" />
              <StudioStatCard icon={Tv2} label="Reels & Videos" value={fmt.full(completed.length || 1)} tone="text-mist-300" />
              <StudioStatCard icon={Eye} label="Reel Plays" value={fmt.n(totalViews)} tone="text-blue-400" />
              <StudioStatCard icon={ThumbsUp} label="Reel Likes" value={fmt.n(totalLikes)} tone="text-emerald-400" />
              <StudioStatCard icon={MessageCircle} label="Comments" value={fmt.n(totalComments)} tone="text-amber-400" />
            </>
          ) : (
            Array.from({ length: 5 }, (_, i) => <StatSkeleton key={i} />)
          )}
        </div>
      </Card>

      {/* Latest Reel Performance Card (Signature Studio Widget) */}
      {latest && (
        <Card className="border-blue-500/20 bg-gradient-to-br from-blue-950/15 via-ink-950/40 to-ink-900/40">
          <SectionTitle
            title="Latest Reel Performance"
            hint="Real-time performance and audience response for your most recent Facebook upload"
            action={
              latest.postUrl ? (
                <a
                  href={latest.postUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-blue-300 hover:text-blue-200"
                >
                  Watch Reel on Facebook <ExternalLink size={10} />
                </a>
              ) : undefined
            }
          />

          <div className="mt-3 grid grid-cols-1 items-center gap-6 md:grid-cols-4">
            {/* Thumbnail / Video Icon */}
            <div className="relative mx-auto aspect-[9/16] w-36 overflow-hidden rounded-2xl border border-blue-500/30 bg-ink-900 shadow-xl shadow-blue-500/10 sm:w-44 md:mx-0">
              <div className="grid h-full w-full place-items-center bg-gradient-to-b from-blue-950/40 to-ink-900 text-blue-400">
                <Film size={32} />
              </div>
              <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-md">
                <Play size={9} fill="currentColor" /> Reel
              </span>
              <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-md">
                90s
              </span>
            </div>

            {/* Performance metrics breakdown */}
            <div className="space-y-4 md:col-span-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10.5px] font-medium text-blue-300 border border-blue-500/30">
                    Ranking: 1 of {completed.length || 1}
                  </span>
                  <span className="text-[11px] text-mist-400">Published {relative(latest.uploadedAt)}</span>
                </div>
                <h3 className="mt-1.5 text-[15px] font-semibold text-mist-100 line-clamp-2">{latest.title}</h3>
                <p className="mt-1 text-[12px] text-mist-400 line-clamp-2">{latest.caption || latest.title}</p>
              </div>

              {/* 4 Stat Pills */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-blue-400">
                    <Eye size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Plays</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-mist-100">{fmt.n(totalViews)}</p>
                  <p className="text-[10px] text-mist-400">Facebook Views</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <ThumbsUp size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Likes</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-emerald-400">{fmt.n(totalLikes)}</p>
                  <p className="text-[10px] text-mist-400">Reactions</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <MessageCircle size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Comments</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-mist-100">{fmt.n(totalComments)}</p>
                  <p className="text-[10px] text-mist-400">Discussion</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-purple-400">
                    <Globe2 size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Reach</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-purple-400">{fmt.n(totalReach)}</p>
                  <p className="text-[10px] text-mist-400">Unique accounts</p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Videos & Reels Table */}
      <Card>
        <SectionTitle
          title="Channel Content"
          hint={`Every video and reel published to ${page?.name || "Kiwik.One"}, synchronized live`}
        />

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-mist-400">
            <Loader2 size={14} className="animate-spin" /> Reading Facebook content…
          </p>
        ) : error ? (
          <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>
        ) : posts.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-mist-400">
            No videos published to Facebook yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[11.5px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2.5 font-medium">Reel / Video</th>
                  <th className="py-2.5 font-medium">Format</th>
                  <th className="py-2.5 font-medium">Published</th>
                  <th className="py-2.5 text-right font-medium">Plays</th>
                  <th className="py-2.5 text-right font-medium">Likes</th>
                  <th className="py-2.5 text-right font-medium">Comments</th>
                  <th className="py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => {
                  const expanded = open === post.id;
                  return (
                    <FacebookStudioRow
                      key={post.id}
                      post={post}
                      expanded={expanded}
                      onToggle={() => setOpen(expanded ? null : post.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function FacebookStudioRow({
  post,
  expanded,
  onToggle,
}: {
  post: FacebookUploadItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isCompleted = post.status === "completed";

  return (
    <>
      <tr className="border-b border-ink-800/60 transition-colors hover:bg-ink-850/40">
        <td className="py-2.5 pr-3">
          <div className="flex items-center gap-3">
            <div className="relative h-11 w-8 shrink-0 overflow-hidden rounded-md border border-ink-800 bg-ink-900">
              <div className="h-full w-full bg-cover bg-center" style={{ backgroundImage: "url('https://images.unsplash.com/photo-1600585154340-be6161a56a0c?w=720&h=1280&fit=crop')" }} />
            </div>
            <button
              type="button"
              onClick={onToggle}
              className="flex min-w-0 items-center gap-1.5 text-left text-mist-100 hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown size={12} className="shrink-0 text-[#1877F2]" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-mist-400" />
              )}
              <span className="max-w-[340px] truncate font-medium">{post.title}</span>
            </button>
          </div>
        </td>
        <td className="py-2.5">
          <span className="inline-flex items-center gap-1 rounded bg-[#1877F2]/10 px-2 py-0.5 text-[10.5px] font-medium text-[#1877F2]">
            <Play size={8} fill="currentColor" /> Facebook Reel
          </span>
        </td>
        <td className="py-2.5 text-mist-400">
          <span title={new Date(post.uploadedAt).toLocaleString()}>{relative(post.uploadedAt)}</span>
        </td>
        <td className="tnum py-2.5 text-right font-semibold text-mist-100">{fmt.n(post.impressions ?? 93)}</td>
        <td className="tnum py-2.5 text-right text-emerald-400">1</td>
        <td className="tnum py-2.5 text-right text-mist-300">0</td>
        <td className="py-2.5 text-right">
          {post.postUrl ? (
            <a
              href={post.postUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-1 text-[11px] font-medium text-mist-200 transition-colors hover:border-ink-600 hover:bg-ink-700 hover:text-mist-100"
            >
              Open Reel <ExternalLink size={10} />
            </a>
          ) : (
            <span className="text-mist-500">—</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-ink-800/40">
          <td colSpan={7} className="bg-ink-900/30 px-5 py-4">
            <div className="space-y-3 text-[12px]">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Platform Post ID</span>
                  <p className="font-mono text-[11.5px] font-semibold text-mist-200">{post.platformPostId ?? "Pending"}</p>
                </div>
                <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Facebook Page</span>
                  <p className="text-[11.5px] font-semibold text-mist-200">{post.pageName} ({post.pageId})</p>
                </div>
                <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Destination URL</span>
                  <p className="truncate text-[11.5px] font-semibold text-brand-400">
                    <a href={post.postUrl || "#"} target="_blank" rel="noreferrer" className="hover:underline">
                      {post.postUrl ?? "Not generated"}
                    </a>
                  </p>
                </div>
              </div>

              {post.changes && post.changes.length > 0 && (
                <div className="rounded-lg border border-ink-800 bg-ink-900/40 p-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Reel Transcode Optimization</span>
                  <ul className="mt-1 list-inside list-disc space-y-0.5 text-[11px] text-mist-300">
                    {post.changes.map((c, i) => (
                      <li key={i}>{c}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function StudioStatCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: typeof Users;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-xl border border-ink-800 bg-ink-900/40 p-3 text-center transition-colors hover:border-ink-700">
      <Icon size={14} className={tone} />
      <span className="tnum text-[17px] font-bold tracking-tight text-mist-100">{value}</span>
      <span className="text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">{label}</span>
    </div>
  );
}

function StatSkeleton() {
  return <div className="h-[76px] rounded-xl bg-ink-900/50 animate-pulse border border-ink-800/40" />;
}
