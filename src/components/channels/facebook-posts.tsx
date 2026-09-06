"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown, ChevronRight, ExternalLink, Eye, Info, Loader2,
  Play, RefreshCw, ThumbsUp, MessageCircle, CheckCircle2,
  Tv2, Globe2, Share2, Sparkles
} from "lucide-react";
import { Badge, Card, SectionTitle, fmt } from "@/components/ui";
import { useInterval } from "@/hooks/use-interval";

export interface FacebookUploadItem {
  id: string;
  platformPostId: string | null;
  postUrl: string | null;
  title: string;
  caption: string;
  mediaType: string;
  uploadedAt: string;
  status: "completed" | "failed" | "processing";
  pageId: string | null;
  pageName: string;
  changes?: string[];
  error?: string | null;
}

interface FacebookPostsResponse {
  ok: boolean;
  page?: {
    id: string;
    name: string;
    manager: string;
    url: string;
  };
  posts?: FacebookUploadItem[];
  lastSyncedAt?: string;
  error?: string;
}

const POLL_MS = 30_000; // 30s auto-polling

function relative(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString("en", { month: "short", day: "numeric" });
}

export function FacebookPosts({ brandId }: { brandId: string }) {
  const [data, setData] = useState<FacebookPostsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const inflight = useRef(false);

  const fetchPosts = useCallback(() => {
    if (inflight.current) return;
    inflight.current = true;
    setRefreshing(true);

    fetch(`/api/channels/facebook/posts`, { cache: "no-store" })
      .then((r) => r.json() as Promise<FacebookPostsResponse>)
      .then((res) => {
        if (res.ok) {
          setData(res);
          setError(null);
        } else {
          setError(res.error || "Failed to load Facebook posts");
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
    fetchPosts();
  }, [fetchPosts]);

  useInterval(fetchPosts, POLL_MS);

  const page = data?.page;
  const posts = data?.posts ?? [];
  const completedPosts = posts.filter((p) => p.status === "completed");

  return (
    <div className="space-y-6">
      {/* Facebook Page Connection Banner */}
      <Card>
        <SectionTitle
          title="Facebook Page"
          hint={page ? `${page.name} · Managed by ${page.manager}` : "Live from Meta via the publishing connector"}
          action={
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-[10.5px] text-good-400">
                <span className="beacon-dot bg-good-400" />
                Live
                {lastUpdated && (
                  <span className="text-mist-500">
                    · synced {lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </span>
                )}
                <button
                  type="button"
                  onClick={fetchPosts}
                  disabled={refreshing}
                  className="text-mist-400 hover:text-mist-100 transition-colors"
                  title="Refresh Facebook feed"
                >
                  <RefreshCw size={11} className={refreshing ? "animate-spin text-mist-200" : ""} />
                </button>
              </span>
              {page && (
                <a
                  href={page.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-400 hover:text-brand-300"
                >
                  Open Facebook Page <ExternalLink size={11} />
                </a>
              )}
            </div>
          }
        />

        {/* Page Identity details */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-3.5">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-[#1877F2]" />
              <span className="text-[11px] font-medium uppercase tracking-wider text-mist-500">Target Page</span>
            </div>
            <p className="mt-1 text-[15px] font-bold text-mist-100">{page?.name ?? "Kiwik.One"}</p>
            <p className="text-[11px] text-mist-400">Page ID: {page?.id ?? "1368849489636077"}</p>
          </div>

          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-3.5">
            <div className="flex items-center gap-2">
              <Globe2 size={12} className="text-good-400" />
              <span className="text-[11px] font-medium uppercase tracking-wider text-mist-500">Connector State</span>
            </div>
            <p className="mt-1 text-[15px] font-bold text-good-400">Live & Connected</p>
            <p className="text-[11px] text-mist-400">Via publishing connector{page?.manager ? ` (${page.manager})` : ""}</p>
          </div>

          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-3.5">
            <div className="flex items-center gap-2">
              <Tv2 size={12} className="text-purple-400" />
              <span className="text-[11px] font-medium uppercase tracking-wider text-mist-500">Reels & Videos</span>
            </div>
            <p className="mt-1 text-[15px] font-bold text-mist-100">{completedPosts.length}</p>
            <p className="text-[11px] text-mist-400">Published to Reels</p>
          </div>
        </div>

        {/* Informational Guidance Note */}
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-ink-800 bg-ink-900/50 p-3 text-[12px] leading-relaxed text-mist-400">
          <Info size={14} className="mt-0.5 shrink-0 text-brand-400" />
          <span>
            <strong className="text-mist-200">Where Facebook posts appear: </strong>
            Automated videos and reels are published directly to your Facebook Page (
            <a href={page?.url || "https://www.facebook.com/1368849489636077"} target="_blank" rel="noreferrer" className="text-brand-400 hover:underline">
              {page?.name || "Kiwik.One"}
            </a>
            ) under the <strong className="text-mist-200">Reels</strong> tab. Meta Graph API policy restricts automated posting to business Pages and does not publish to personal user timelines.
          </span>
        </div>
      </Card>

      {/* Videos & Reels Table */}
      <Card>
        <SectionTitle
          title="Published Videos & Reels"
          hint="Every video published to Facebook through the automation pipeline"
        />

        {loading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-[12.5px] text-mist-400">
            <Loader2 size={14} className="animate-spin" /> Loading Facebook posts…
          </p>
        ) : error ? (
          <p className="rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>
        ) : posts.length === 0 ? (
          <p className="py-8 text-center text-[12.5px] text-mist-400">
            No videos published to Facebook yet. Submit a video from the Publish tab to start.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-[11.5px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-2.5 font-medium">Video / Reel</th>
                  <th className="py-2.5 font-medium">Platform</th>
                  <th className="py-2.5 font-medium">Published</th>
                  <th className="py-2.5 font-medium">Status</th>
                  <th className="py-2.5 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {posts.map((post) => {
                  const expanded = open === post.id;
                  return (
                    <FacebookRow
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

function FacebookRow({
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
        <td className="py-3 pr-3">
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={onToggle}
              className="flex min-w-0 items-center gap-1.5 text-left text-mist-100 hover:underline"
              aria-expanded={expanded}
            >
              {expanded ? (
                <ChevronDown size={12} className="shrink-0 text-brand-400" />
              ) : (
                <ChevronRight size={12} className="shrink-0 text-mist-400" />
              )}
              <span className="max-w-[380px] truncate font-medium">{post.title}</span>
            </button>
          </div>
        </td>
        <td className="py-3 text-mist-300">
          <span className="inline-flex items-center gap-1 rounded bg-[#1877F2]/10 px-2 py-0.5 text-[10.5px] font-medium text-[#1877F2]">
            Facebook Reel
          </span>
        </td>
        <td className="py-3 text-mist-400">
          <span title={new Date(post.uploadedAt).toLocaleString()}>
            {relative(post.uploadedAt)}
          </span>
        </td>
        <td className="py-3">
          {isCompleted ? (
            <Badge tone="good" className="gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-good-400" /> Live on Facebook
            </Badge>
          ) : post.status === "processing" ? (
            <Badge tone="neutral" className="gap-1">
              <Loader2 size={10} className="animate-spin" /> Processing
            </Badge>
          ) : (
            <Badge tone="bad">Failed</Badge>
          )}
        </td>
        <td className="py-3 text-right">
          {post.postUrl ? (
            <a
              href={post.postUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-800 px-2.5 py-1 text-[11px] font-medium text-mist-200 transition-colors hover:border-ink-600 hover:bg-ink-700 hover:text-mist-100"
            >
              Open Reel <ExternalLink size={11} />
            </a>
          ) : (
            <span className="text-mist-500">—</span>
          )}
        </td>
      </tr>

      {expanded && (
        <tr className="border-b border-ink-800/40">
          <td colSpan={5} className="bg-ink-900/30 px-5 py-4">
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

              {post.error && (
                <p className="rounded-lg bg-bad-500/10 p-2.5 text-[11px] text-bad-400">
                  <strong>Error details: </strong> {post.error}
                </p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
