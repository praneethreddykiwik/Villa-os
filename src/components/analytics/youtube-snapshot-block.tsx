"use client";

import { useCallback, useState } from "react";
import { Eye, ThumbsUp, MessageCircle, Users, Youtube, ExternalLink } from "lucide-react";
import { Card, SectionTitle, fmt } from "@/components/ui";
import { useInterval } from "@/hooks/use-interval";
import type { YouTubeSnapshot } from "@/lib/youtube/public";

type Snapshot = YouTubeSnapshot & { handle: string };
type Response = ({ ok: true } & Snapshot) | { ok: false; error: string };

/** Ring chart built with SVG — no external dep. */
function Ring({
  value, max, color, size = 80, strokeWidth = 8,
}: {
  value: number; max: number; color: string; size?: number; strokeWidth?: number;
}) {
  const r = (size - strokeWidth) / 2;
  const circ = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={strokeWidth} />
      <circle
        cx={size / 2} cy={size / 2} r={r}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.8s ease" }}
      />
    </svg>
  );
}

export function YouTubeSnapshotBlock({ brandId }: { brandId: string }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const poll = useCallback(() => {
    fetch(`/api/channels/youtube/videos?brandId=${encodeURIComponent(brandId)}`)
      .then((r) => r.json() as Promise<Response>)
      .then((r) => { if (r.ok) { setSnap(r); setError(null); } else setError(r.error); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [brandId]);

  useInterval(poll, 60_000);

  if (loading) return null;
  if (error || !snap) return null; // silent — channel might not be YouTube

  const totalViews = snap.videos.reduce((s, v) => s + v.views, 0);
  const totalLikes = snap.videos.reduce((s, v) => s + v.likes, 0);
  const totalComments = snap.videos.reduce((s, v) => s + v.comments, 0);
  const subs = snap.channel.stats.subscribers;

  // Ring max = subscribers (for rough reach sense)
  const ringMax = Math.max(subs, totalViews, 1);

  return (
    <Card>
      <SectionTitle
        title="YouTube"
        hint={`${snap.channel.title} · live from YouTube's public API`}
        action={
          <a
            href={`https://www.youtube.com/${snap.handle}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100"
          >
            <Youtube size={11} className="text-bad-400" /> Open channel <ExternalLink size={10} />
          </a>
        }
      />

      <div className="flex flex-col gap-5 sm:flex-row">
        {/* Ring cluster */}
        <div className="flex items-center justify-center gap-4">
          <div className="relative">
            <Ring value={totalViews} max={ringMax} color="#3b82f6" size={90} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <Eye size={11} className="text-blue-400" />
            </div>
          </div>
          <div className="relative">
            <Ring value={subs} max={ringMax} color="#8b5cf6" size={90} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <Users size={11} className="text-purple-400" />
            </div>
          </div>
          <div className="relative">
            <Ring value={totalLikes} max={ringMax} color="#22c55e" size={90} />
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <ThumbsUp size={11} className="text-good-400" />
            </div>
          </div>
        </div>

        {/* Stats */}
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-4">
          <YTStat label="Subscribers" value={fmt.n(subs)} icon={Users} color="text-purple-400" />
          <YTStat label="Total Views" value={fmt.n(totalViews)} icon={Eye} color="text-blue-400" />
          <YTStat label="Total Likes" value={fmt.n(totalLikes)} icon={ThumbsUp} color="text-good-400" />
          <YTStat label="Comments" value={fmt.n(totalComments)} icon={MessageCircle} color="text-warn-400" />
        </div>
      </div>

      {/* Top 3 videos mini-list */}
      {snap.videos.length > 0 && (
        <div className="mt-4 space-y-2">
          <p className="text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">Top videos by views</p>
          {snap.videos.slice(0, 3).map((v) => (
            <div key={v.id} className="flex items-center gap-3 text-[11.5px]">
              {v.thumbnail && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={v.thumbnail} alt="" className="h-8 w-14 shrink-0 rounded object-cover" loading="lazy" />
              )}
              <span className="flex-1 truncate text-mist-200">{v.title}</span>
              <span className="tnum shrink-0 text-mist-400">{fmt.n(v.views)} views</span>
              <a href={v.url} target="_blank" rel="noreferrer" className="shrink-0 text-mist-500 hover:text-mist-200">
                <ExternalLink size={10} />
              </a>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function YTStat({ label, value, icon: Icon, color }: { label: string; value: string; icon: typeof Eye; color: string }) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-xl border border-ink-800 bg-ink-900/40 p-3">
      <div className="flex items-center gap-1.5">
        <Icon size={12} className={color} />
        <span className="text-[9.5px] font-semibold uppercase tracking-wider text-mist-500">{label}</span>
      </div>
      <span className="tnum text-[18px] font-bold tracking-tight text-mist-100">{value}</span>
    </div>
  );
}
