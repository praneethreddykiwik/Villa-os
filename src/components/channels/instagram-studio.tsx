"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, Eye, Film, Heart,
  Info, Loader2, MessageCircle, Play, RefreshCw, ThumbsUp,
  Tv2, Users, CheckCircle2, Globe2, Sparkles, Instagram,
  Activity, BarChart3, ArrowUpRight
} from "lucide-react";
import { Badge, Card, SectionTitle, fmt } from "@/components/ui";
import { useInterval } from "@/hooks/use-interval";
import type { InstagramMediaItem } from "@/app/api/channels/instagram/posts/route";

interface InstagramStudioResponse {
  ok: boolean;
  profile?: {
    handle: string;
    displayName: string;
    followers: number;
    following: number;
    totalPosts: number;
    profilePic: string;
    url: string;
  };
  totals?: {
    views: number;
    reach?: number;
    impressions?: number;
    profileViews?: number;
    likes: number;
    comments: number;
    saves?: number;
  };
  media?: InstagramMediaItem[];
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

export function InstagramStudio({ brandId }: { brandId: string }) {
  const [data, setData] = useState<InstagramStudioResponse | null>(null);
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

    fetch(`/api/channels/instagram/posts`, { cache: "no-store" })
      .then((r) => r.json() as Promise<InstagramStudioResponse>)
      .then((res) => {
        if (res.ok) {
          setData(res);
          setError(null);
        } else {
          setError(res.error || "Failed to load Instagram Studio data");
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

  const profile = data?.profile;
  const totals = data?.totals;
  const media = data?.media ?? [];
  const latest = media[0];

  return (
    <div className="space-y-6">
      {/* Instagram Studio Header Card */}
      <Card className="overflow-hidden border-ink-800 bg-gradient-to-b from-ink-900/60 to-ink-950/90">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3.5">
            {profile?.profilePic ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.profilePic}
                alt=""
                className="h-12 w-12 rounded-full border-2 border-[#E1306C]/40 object-cover shadow-lg shadow-pink-500/10"
              />
            ) : (
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-tr from-[#f09433] via-[#dc2743] to-[#bc1888] text-white shadow-lg shadow-pink-500/15">
                <Instagram size={22} />
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-bold tracking-tight text-mist-100">
                  {profile?.displayName || "Instagram Studio"}
                </h2>
                <Badge tone="good" className="text-[10px]">
                  <CheckCircle2 size={10} className="mr-0.5" /> Studio Connected
                </Badge>
              </div>
              <p className="mt-0.5 flex items-center gap-2 text-xs text-mist-400">
                <span className="font-semibold text-mist-300">{profile?.handle || "@kiwik.one1"}</span>
                <span>·</span>
                <span>{profile ? `${fmt.full(profile.followers)} followers` : "Loading channel…"}</span>
                <span>·</span>
                <span>{profile ? `${fmt.full(profile.totalPosts)} posts` : "—"}</span>
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
                title="Refresh Instagram feed now"
                className="ml-1 inline-flex items-center gap-1 text-mist-400 transition-colors hover:text-mist-100 disabled:opacity-60"
              >
                <RefreshCw size={11} className={refreshing ? "animate-spin text-brand-300" : ""} />
                <span className="text-[10.5px] font-medium">Refresh</span>
              </button>
            </div>

            {profile && (
              <a
                href={profile.url}
                target="_blank"
                rel="noreferrer"
                className="liquid-glass-button inline-flex items-center gap-1.5 px-3 py-1.5 text-[11.5px] font-medium text-mist-200 hover:text-white"
              >
                <Instagram size={13} className="text-[#E1306C]" />
                <span>Open Instagram</span>
                <ExternalLink size={10} />
              </a>
            )}
          </div>
        </div>

        {/* Studio Top KPI Cards */}
        <div className="mt-5 grid grid-cols-2 gap-3 border-t border-ink-800/60 pt-4 sm:grid-cols-5">
          {profile && totals ? (
            <>
              <StudioStatCard icon={Users} label="Followers" value={fmt.full(profile.followers)} tone="text-purple-400" />
              <StudioStatCard icon={Globe2} label="Unique Reach" value={fmt.n(totals.reach ?? totals.views)} tone="text-emerald-400" />
              <StudioStatCard icon={Eye} label="Reel Views" value={fmt.n(totals.views)} tone="text-blue-400" />
              <StudioStatCard icon={Heart} label="Total Likes" value={fmt.n(totals.likes)} tone="text-rose-400" />
              <StudioStatCard icon={MessageCircle} label="Total Comments" value={fmt.n(totals.comments)} tone="text-amber-400" />
            </>
          ) : (
            Array.from({ length: 5 }, (_, i) => <StatSkeleton key={i} />)
          )}
        </div>
      </Card>

      {/* Latest Reel Performance Card (Signature Studio Widget) */}
      {latest && (
        <Card className="border-pink-500/20 bg-gradient-to-br from-pink-950/15 via-ink-950/40 to-ink-900/40">
          <SectionTitle
            title="Latest Reel Performance"
            hint="Real-time performance and viewer engagement for your latest Instagram Reel"
            action={
              <a
                href={latest.permalink}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[11px] text-pink-300 hover:text-pink-200"
              >
                Watch on Instagram <ExternalLink size={10} />
              </a>
            }
          />

          <div className="mt-3 grid grid-cols-1 items-center gap-6 md:grid-cols-4">
            {/* Thumbnail preview */}
            <div className="relative mx-auto aspect-[9/16] w-36 overflow-hidden rounded-2xl border border-pink-500/30 bg-ink-900 shadow-xl shadow-pink-500/10 sm:w-44 md:mx-0">
              {latest.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={latest.thumbnail} alt="" className="h-full w-full object-cover" />
              ) : (
                <div className="grid h-full w-full place-items-center bg-ink-850 text-mist-500">
                  <Film size={28} />
                </div>
              )}
              <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-md">
                <Play size={9} fill="currentColor" /> Reel
              </span>
              <span className="absolute bottom-2 right-2 rounded bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white backdrop-blur-md">
                {latest.duration}s
              </span>
            </div>

            {/* Performance metrics breakdown */}
            <div className="space-y-4 md:col-span-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-pink-500/15 px-2 py-0.5 text-[10.5px] font-medium text-pink-300 border border-pink-500/30">
                    Ranking by views: 1 of {media.length}
                  </span>
                  <span className="text-[11px] text-mist-400">Published {relative(latest.publishedAt)}</span>
                </div>
                <h3 className="mt-1.5 text-[15px] font-semibold text-mist-100 line-clamp-2">{latest.title}</h3>
                <p className="mt-1 text-[12px] text-mist-400 line-clamp-2">{latest.caption}</p>
              </div>

              {/* 5 Stat Pills */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-blue-400">
                    <Eye size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Views</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-mist-100">{fmt.full(latest.views)}</p>
                  <p className="text-[10px] text-mist-400">Reel plays</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-emerald-400">
                    <Globe2 size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Reach</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-emerald-400">{fmt.full(latest.reach ?? latest.views)}</p>
                  <p className="text-[10px] text-mist-400">Unique accounts</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-rose-400">
                    <Heart size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Likes</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-rose-400">{fmt.full(latest.likes)}</p>
                  <p className="text-[10px] text-mist-400">Organic hearts</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-amber-400">
                    <MessageCircle size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Comments</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-mist-100">{fmt.full(latest.comments)}</p>
                  <p className="text-[10px] text-mist-400">Replies & chat</p>
                </div>

                <div className="rounded-xl border border-ink-800 bg-ink-900/60 p-3">
                  <div className="flex items-center gap-1.5 text-purple-400">
                    <Sparkles size={13} />
                    <span className="text-[10px] font-medium uppercase tracking-wider text-mist-500">Saves</span>
                  </div>
                  <p className="tnum mt-1 text-[18px] font-bold text-purple-400">{fmt.full(latest.saves ?? 0)}</p>
                  <p className="text-[10px] text-mist-400">Bookmarks</p>
                </div>
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Reels & Posts Studio Table */}
      <Card>
        <SectionTitle
          title="Channel Content"
          hint={`All reels and posts on ${profile?.handle || "@kiwik.one1"}, synchronized live`}
        />

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-mist-400">
            <Loader2 size={14} className="animate-spin" /> Reading Instagram content…
          </p>
        ) : error ? (
          <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>
        ) : media.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-mist-400">
            No public reels found on this Instagram account yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-[11.5px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2.5 font-medium">Reel / Video</th>
                  <th className="py-2.5 font-medium">Format</th>
                  <th className="py-2.5 font-medium">Published</th>
                  <th className="py-2.5 text-right font-medium">Views</th>
                  <th className="py-2.5 text-right font-medium">Likes</th>
                  <th className="py-2.5 text-right font-medium">Comments</th>
                  <th className="py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {media.map((item) => {
                  const expanded = open === item.id;
                  return (
                    <InstagramRow
                      key={item.id}
                      item={item}
                      expanded={expanded}
                      onToggle={() => setOpen(expanded ? null : item.id)}
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

function InstagramRow({
  item,
  expanded,
  onToggle,
}: {
  item: InstagramMediaItem;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="border-b border-ink-800/60 transition-colors hover:bg-ink-850/40">
        <td className="py-2.5 pr-3">
          <div className="flex items-center gap-3">
            <div className="relative h-11 w-8 shrink-0 overflow-hidden rounded-md border border-ink-800 bg-ink-900">
              {item.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={item.thumbnail} alt="" className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="grid h-full w-full place-items-center text-mist-500">
                  <Film size={12} />
                </div>
              )}
            </div>
            <button
              type="button"
              onClick={onToggle}
              className="flex min-w-0 items-center gap-1.5 text-left text-mist-100 hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown size={12} className="shrink-0 text-[#E1306C]" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-mist-400" />
              )}
              <span className="max-w-[340px] truncate font-medium">{item.title}</span>
            </button>
          </div>
        </td>
        <td className="py-2.5">
          <span className="inline-flex items-center gap-1 rounded bg-[#E1306C]/10 px-2 py-0.5 text-[10.5px] font-medium text-[#E1306C]">
            <Play size={8} fill="currentColor" /> Reel
          </span>
        </td>
        <td className="py-2.5 text-mist-400">
          <span title={new Date(item.publishedAt).toLocaleString()}>{relative(item.publishedAt)}</span>
        </td>
        <td className="tnum py-2.5 text-right font-semibold text-mist-100">{fmt.full(item.views)}</td>
        <td className="tnum py-2.5 text-right text-rose-400">{fmt.full(item.likes)}</td>
        <td className="tnum py-2.5 text-right text-mist-300">{fmt.full(item.comments)}</td>
        <td className="py-2.5 text-right">
          <a
            href={item.permalink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-1 text-[11px] font-medium text-mist-200 transition-colors hover:border-ink-600 hover:bg-ink-700 hover:text-mist-100"
          >
            Open <ExternalLink size={10} />
          </a>
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-ink-800/40">
          <td colSpan={7} className="bg-ink-900/30 px-5 py-4">
            <div className="space-y-3 text-[12px]">
              <p className="text-mist-200">{item.caption}</p>
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Duration</span>
                  <p className="font-semibold text-mist-200">{item.duration}s</p>
                </div>
                <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-2.5">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Status</span>
                  <p className="font-semibold text-good-400">Live on Instagram</p>
                </div>
                <div className="rounded-lg border border-ink-800 bg-ink-900/50 p-2.5 sm:col-span-2">
                  <span className="text-[10px] uppercase tracking-wider text-mist-500">Direct Link</span>
                  <p className="truncate font-semibold text-pink-400">
                    <a href={item.permalink} target="_blank" rel="noreferrer" className="hover:underline">
                      {item.permalink}
                    </a>
                  </p>
                </div>
              </div>
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
