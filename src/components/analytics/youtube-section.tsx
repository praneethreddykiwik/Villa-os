import { ExternalLink, Youtube } from "lucide-react";
import { fetchYouTubeSnapshotResult, youtubeChannelRef } from "@/lib/youtube/public";
import { statsFor, type Range } from "@/lib/metrics/aggregate";
import {
  engagementComposition, snapshotTotals, topVideos, updatedAgo, uploadsInRange, youtubeRangeRollup, youtubeSeries,
} from "@/lib/metrics/youtube";
import { Card, SectionTitle, Stat, fmt } from "@/components/ui";
import { DonutChart, MiniSpark, VIZ } from "@/components/charts";
import type { Database } from "@/lib/types";

/**
 * The full YouTube block on /analytics. Series come from dailyStats (per-day
 * movement written by the sync); totals and the video table come from the live
 * public snapshot, which is cached inside the client so a page refresh does
 * not spend quota. Renders nothing when no YouTube account is connected.
 */
export async function YouTubeSection({
  db, brandId, range, days, lastSyncedAt,
}: {
  db: Database;
  brandId: string;
  range: Range;
  days: number;
  lastSyncedAt: string | null;
}) {
  const conn = db.connections.find((c) => c.brandId === brandId && c.channel === "youtube" && c.status !== "disconnected");
  if (!conn?.handle) return null;

  const stats = statsFor(db, brandId);
  const rollup = youtubeRangeRollup(stats, range);
  const series = youtubeSeries(stats, range);
  const result = await fetchYouTubeSnapshotResult(youtubeChannelRef(conn));
  const snap = result.ok ? result.snapshot : null;
  const videos = snap?.videos ?? [];
  const totals = snapshotTotals(videos);
  const top = topVideos(videos, 5);
  const uploads = uploadsInRange(videos, range).length;
  const mix = engagementComposition(videos);
  const subscribers = snap?.channel.stats.subscribers ?? conn.followers ?? 0;

  return (
    <Card>
      <SectionTitle
        title="YouTube"
        hint={snap ? `${snap.channel.title} · totals live, daily series from synced stats · updated ${updatedAgo(lastSyncedAt)}` : `Live figures unavailable (${result.ok ? "" : result.error}) · showing synced stats`}
        action={
          <a
            href={`https://www.youtube.com/${conn.handle.startsWith("@") ? conn.handle : `channel/${snap?.channel.channelId ?? ""}`}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-mist-400 hover:text-mist-100"
          >
            <Youtube size={11} className="text-bad-400" /> Open channel <ExternalLink size={10} />
          </a>
        }
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Subscribers" value={fmt.n(subscribers)} sub={`${rollup.subscriberDelta >= 0 ? "+" : ""}${fmt.full(rollup.subscriberDelta)} in ${days} days`} />
        <Stat label="Views" value={fmt.n(snap ? totals.views : rollup.views)} sub={`${fmt.n(rollup.views)} in range`} />
        <Stat label="Likes" value={fmt.n(totals.likes)} sub={snap ? "lifetime, public" : "needs live read"} />
        <Stat label="Comments" value={fmt.n(totals.comments)} sub={snap ? "lifetime, public" : "needs live read"} />
        <Stat label="Uploads" value={String(snap ? uploads : rollup.uploads)} sub={`in the last ${days} days`} />
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">Top videos by views</p>
          {top.length === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-mist-400">
              {snap ? "No uploads on this channel yet." : "Video list needs the live read — check the API key or quota."}
            </p>
          ) : (
            <table className="w-full text-[11.5px]">
              <thead>
                <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                  <th className="py-1.5 font-medium">Video</th>
                  <th className="py-1.5 text-right font-medium">Views</th>
                  <th className="py-1.5 text-right font-medium">Likes</th>
                  <th className="py-1.5 text-right font-medium">Comments</th>
                  <th className="py-1.5" />
                </tr>
              </thead>
              <tbody>
                {top.map((v) => (
                  <tr key={v.id} className="border-b border-ink-800/60 last:border-0">
                    <td className="max-w-[320px] truncate py-1.5 text-mist-200">{v.title}</td>
                    <td className="tnum py-1.5 text-right">{fmt.n(v.views)}</td>
                    <td className="tnum py-1.5 text-right text-mist-300">{fmt.n(v.likes)}</td>
                    <td className="tnum py-1.5 text-right text-mist-300">{fmt.n(v.comments)}</td>
                    <td className="py-1.5 text-right">
                      <a href={v.url} target="_blank" rel="noreferrer" className="inline-flex text-mist-500 hover:text-mist-200" aria-label="Open video">
                        <ExternalLink size={11} />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <p className="mb-1 mt-5 text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">Daily views</p>
          {series.length < 2 ? (
            <p className="text-[11.5px] text-mist-400">
              {series.length === 0 ? "No synced day in this range yet." : "One synced day so far — the line appears from the second."}
            </p>
          ) : (
            <MiniSpark data={series.map((p) => p.views)} color={VIZ[1]} height={56} />
          )}
        </div>

        <div>
          <p className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-mist-500">Engagement mix</p>
          {mix.total === 0 ? (
            <p className="py-6 text-center text-[12.5px] text-mist-400">No likes or comments recorded yet.</p>
          ) : (
            <>
              <DonutChart
                height={160}
                data={[
                  { name: "Likes", value: mix.likes, color: VIZ[2] },
                  { name: "Comments", value: mix.comments, color: VIZ[3] },
                ]}
              />
              <div className="mt-2 space-y-1 text-[11.5px]">
                <div className="flex justify-between"><span className="text-mist-400">Likes</span><span className="tnum text-mist-100">{fmt.n(mix.likes)} · {fmt.pct(mix.likeShare, 0)}</span></div>
                <div className="flex justify-between"><span className="text-mist-400">Comments</span><span className="tnum text-mist-100">{fmt.n(mix.comments)} · {fmt.pct(mix.commentShare, 0)}</span></div>
              </div>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
