"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, Eye, Info, Loader2,
  MessageCircle, RefreshCw, ThumbsUp, Activity, BarChart3, 
  Linkedin, Globe2, Share2
} from "lucide-react";
import { Badge, Card, SectionTitle, fmt } from "@/components/ui";
import { useInterval } from "@/hooks/use-interval";
import Link from "next/link";

type LinkedInPost = {
  id: string;
  text: string;
  publishedAt: string;
  visibility: string;
  metrics: {
    likes: number;
    comments: number;
    shares: number;
    impressions: number;
  };
};

type LinkedInResponse = 
  | { ok: true; posts: LinkedInPost[]; handle: string; authorUrn: string; connectionId: string }
  | { ok: false; code?: string; error: string };

const POLL_MS = 60_000;

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function useVisible() {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const on = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);
  return visible;
}

export function LinkedInStudio({ brandId }: { brandId: string }) {
  const [data, setData] = useState<LinkedInResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const visible = useVisible();
  const inflight = useRef(false);

  const load = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    setRefreshing(true);
    fetch(`/api/channels/linkedin/posts?brandId=${encodeURIComponent(brandId)}`, { cache: "no-store" })
      .then((r) => r.json() as Promise<LinkedInResponse>)
      .then((r) => {
        if (r.ok) {
          setData(r);
          setError(null);
          setLastUpdated(new Date());
        } else {
          setError(r.error);
          if (r.code === "no_token") {
             setData(r);
          }
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setLoading(false);
        setRefreshing(false);
        inflight.current = false;
      });
  }, [brandId]);

  useInterval(load, visible ? POLL_MS : null);

  if (data && !data.ok && data.code === "no_token") {
    return (
      <Card>
        <SectionTitle title="LinkedIn Studio" hint="Publishing connector & analytics" />
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.04] p-5 text-[13px] leading-relaxed text-mist-300 shadow-sm mt-4">
          <div className="flex items-start gap-4">
            <Info size={20} className="mt-0.5 shrink-0 text-sky-400" />
            <div className="space-y-3">
              <h3 className="text-[15px] font-semibold text-mist-100">Analytics require an OAuth connection</h3>
              <p>
                LinkedIn requires a direct OAuth connection with your LinkedIn account to read your posts and engagement metrics.
              </p>
              <div className="rounded-lg bg-ink-900/60 p-3 border border-ink-800">
                <p className="font-medium text-mist-200 mb-1">Company Pages vs Personal Profiles</p>
                <p className="text-[12px] text-mist-400">
                  Personal profiles have restricted API access. To view full analytics including reach, impressions, and engagement timeseries, you must connect a <strong>Company Page</strong> that you administer.
                </p>
              </div>
              <div className="pt-2">
                <Link href="/connections" className="inline-flex items-center justify-center rounded-lg bg-sky-500 px-4 py-2 text-[13px] font-semibold text-white hover:bg-sky-400 transition-colors">
                  Go to Connections to reconnect
                </Link>
              </div>
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const posts = data?.ok ? data.posts : [];
  const totals = posts.reduce((acc, p) => ({
    likes: acc.likes + p.metrics.likes,
    comments: acc.comments + p.metrics.comments,
    shares: acc.shares + p.metrics.shares,
    impressions: acc.impressions + p.metrics.impressions,
  }), { likes: 0, comments: 0, shares: 0, impressions: 0 });

  return (
    <div className="space-y-6">
      {/* Studio Header (Status & Live Beacon) */}
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink-800 bg-ink-900/60 px-5 py-4 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#0077b5] text-white shadow-md">
            <Linkedin size={22} />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-[15px] font-bold text-mist-100">{data?.ok ? data.handle || "LinkedIn Account" : "LinkedIn Account"}</h2>
              <Badge tone="good">Live</Badge>
            </div>
            <p className="text-[11.5px] text-mist-400">Real-time engagement metrics</p>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-4">
          {lastUpdated && (
            <div className="flex items-center gap-1.5 text-[11px] text-emerald-400 font-medium">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              Updated {clock(lastUpdated)}
            </div>
          )}
          <button
            onClick={() => load()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-800 px-3 py-1.5 text-[11px] font-semibold text-mist-200 transition-colors hover:bg-ink-700 disabled:opacity-50"
          >
            <RefreshCw size={12} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {/* Posts List */}
      <Card>
        <SectionTitle
          title="Published posts"
          hint={data?.ok ? `${posts.length} recent posts` : "Recent posts"}
        />

        {loading && !data ? (
          <TableSkeleton />
        ) : error && !data ? (
          <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>
        ) : !data?.ok || posts.length === 0 ? (
          <div className="py-10 text-center">
            <Linkedin size={28} className="mx-auto text-mist-500" />
            <p className="mt-2 text-[12.5px] text-mist-300">No posts found</p>
            <p className="text-[11.5px] text-mist-500">Your recent LinkedIn posts will appear here.</p>
          </div>
        ) : (
          <>
            {error && <p className="mb-3 rounded-lg bg-warn-500/10 px-3 py-1.5 text-[11px] text-warn-400">Last refresh failed ({error}); showing the previous snapshot.</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[700px] text-[12px]">
                <thead>
                  <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                    <th className="py-2.5 font-medium">Post</th>
                    <th className="py-2.5 font-medium">Visibility</th>
                    <th className="py-2.5 font-medium">Date</th>
                    <th className="py-2.5 text-right font-medium">Impressions</th>
                    <th className="py-2.5 text-right font-medium">Likes</th>
                    <th className="py-2.5 text-right font-medium">Comments</th>
                    <th className="py-2.5 text-right font-medium">Shares</th>
                    <th className="py-2.5 text-right font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.map((p) => {
                    const isExpanded = open === p.id;
                    const permalink = `https://www.linkedin.com/feed/update/${p.id}/`;
                    return (
                      <tr key={p.id} className="group border-b border-ink-800/50 hover:bg-ink-900/40">
                        <td className="py-3 pr-4">
                          <div className="flex max-w-[320px] items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <span className="block truncate font-medium text-mist-100">{p.text || "(No caption)"}</span>
                              <span className="text-[10.5px] text-mist-500 mt-0.5 block truncate">ID: {p.id.split(':').pop()}</span>
                            </div>
                          </div>
                        </td>
                        <td className="py-3">
                          <span className="inline-flex items-center gap-1 rounded-full bg-good-500/10 border border-good-500/25 px-2 py-0.5 text-[10.5px] font-semibold text-good-400">
                            <Globe2 size={10} /> {p.visibility}
                          </span>
                        </td>
                        <td className="py-3 text-mist-400 text-[11.5px]">
                          {new Date(p.publishedAt).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" })}
                        </td>
                        <td className="tnum py-3 text-right font-semibold text-mist-100">{fmt.n(p.metrics.impressions)}</td>
                        <td className="tnum py-3 text-right text-emerald-400 font-semibold">{fmt.n(p.metrics.likes)}</td>
                        <td className="tnum py-3 text-right text-amber-400 font-semibold">{fmt.n(p.metrics.comments)}</td>
                        <td className="tnum py-3 text-right text-sky-400 font-semibold">{fmt.n(p.metrics.shares)}</td>
                        <td className="py-3 text-right">
                          <a
                            href={permalink}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex h-7 w-7 items-center justify-center rounded border border-ink-700 bg-ink-800 text-mist-300 hover:bg-ink-700 hover:text-mist-100 transition-colors"
                            title="View on LinkedIn"
                          >
                            <ExternalLink size={13} />
                          </a>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Channel totals */}
            <div className="mt-4 border-t border-ink-800 pt-4">
              <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-mist-400">Channel totals</p>
              </div>
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-5">
                <div className="rounded-lg border border-ink-800/80 bg-ink-900/50 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-mist-400">
                    <Activity size={11} className="text-mist-300" /> Total posts
                  </div>
                  <div className="tnum mt-1 text-[15px] font-bold text-mist-100">{fmt.full(posts.length)}</div>
                </div>
                <div className="rounded-lg border border-ink-800/80 bg-ink-900/50 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-mist-400">
                    <Eye size={11} className="text-blue-400" /> Total impressions
                  </div>
                  <div className="tnum mt-1 text-[15px] font-bold text-mist-100">{fmt.full(totals.impressions)}</div>
                </div>
                <div className="rounded-lg border border-ink-800/80 bg-ink-900/50 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-mist-400">
                    <ThumbsUp size={11} className="text-emerald-400" /> Total likes
                  </div>
                  <div className="tnum mt-1 text-[15px] font-bold text-mist-100">{fmt.full(totals.likes)}</div>
                </div>
                <div className="rounded-lg border border-ink-800/80 bg-ink-900/50 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-mist-400">
                    <MessageCircle size={11} className="text-amber-400" /> Total comments
                  </div>
                  <div className="tnum mt-1 text-[15px] font-bold text-mist-100">{fmt.full(totals.comments)}</div>
                </div>
                <div className="rounded-lg border border-ink-800/80 bg-ink-900/50 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-mist-400">
                    <Share2 size={11} className="text-sky-400" /> Total shares
                  </div>
                  <div className="tnum mt-1 text-[15px] font-bold text-mist-100">{fmt.full(totals.shares)}</div>
                </div>
              </div>
            </div>
          </>
        )}
      </Card>
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
