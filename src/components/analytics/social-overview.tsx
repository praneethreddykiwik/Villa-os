import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { channelMeta, isUsableConnection } from "@/lib/platforms/registry";
import { rollupByChannel, statsFor, type Range } from "@/lib/metrics/aggregate";
import { updatedAgo, youtubeRangeRollup } from "@/lib/metrics/youtube";
import { Card, Dot, SectionTitle, fmt } from "@/components/ui";
import type { ChannelId, Database } from "@/lib/types";

/**
 * One card per connected social channel, shared by /analytics and /dashboard
 * so the two never disagree. YouTube carries real synced numbers; the other
 * channels are publish-only here (no insights API behind them), so they show
 * what is known — follower level and last post — and point to /connections.
 */
export const OVERVIEW_CHANNELS: ChannelId[] = ["instagram", "facebook", "linkedin", "youtube", "google_business"];

export function SocialOverview({
  db, brandId, range, lastSyncedAt, link = "",
}: {
  db: Database;
  brandId: string;
  range: Range;
  /** Newest YouTube sync stamp — the "Updated x min ago" label. */
  lastSyncedAt: string | null;
  link?: string;
}) {
  const stats = statsFor(db, brandId);
  const rollups = rollupByChannel(stats, range);
  const yt = youtubeRangeRollup(stats, range);
  const cards = OVERVIEW_CHANNELS.map((channel) => {
    const conns = db.connections.filter((c) => c.brandId === brandId && c.channel === channel && isUsableConnection(c));
    if (conns.length === 0) return null;
    const lastPost = db.posts
      .filter((p) => p.brandId === brandId && p.status === "published" && p.publishedAt && p.targets.some((t) => t.channel === channel))
      .sort((a, b) => b.publishedAt!.localeCompare(a.publishedAt!))[0];
    return {
      channel,
      meta: channelMeta(channel),
      handles: conns.map((c) => c.handle).join(", "),
      followers: conns.reduce((n, c) => n + (c.followers ?? 0), 0),
      native: conns.some((c) => Boolean(c.accessToken?.trim())),
      rollup: rollups.find((r) => r.channel === channel) ?? null,
      lastPostAt: lastPost?.publishedAt ?? null,
    };
  }).filter((c): c is NonNullable<typeof c> => c !== null);

  return (
    <Card>
      <SectionTitle
        title="Social overview"
        hint={cards.length ? "Every connected channel, what each one can report" : "No social channel is connected yet"}
        action={<span className="tnum text-[11px] text-mist-400">Updated {updatedAgo(lastSyncedAt)}</span>}
      />
      {cards.length === 0 ? (
        <p className="py-6 text-center text-[12.5px] text-mist-400">
          Connect a channel to see it here. <Link href={`/connections${link}`} className="text-mist-200 underline">Connections</Link>
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {cards.map((c) => (
            <div key={c.channel} className="rounded-xl border border-ink-800 bg-ink-900/40 p-3.5">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-mist-100">
                <Dot color={c.meta.color} />
                {c.meta.label}
              </div>
              <p className="truncate text-[10.5px] text-mist-500">{c.handles}</p>
              {c.channel === "youtube" ? (
                <div className="mt-2 space-y-1 text-[11.5px]">
                  <Row label="Subscribers" value={fmt.n(c.followers)} delta={yt.subscriberDelta} />
                  <Row label="Views" value={fmt.n(yt.views)} />
                  <Row label="Engagements" value={fmt.n(yt.engagements)} />
                  <Row label="Uploads" value={String(yt.uploads)} />
                </div>
              ) : (
                <div className="mt-2 space-y-1 text-[11.5px]">
                  <Row label="Followers" value={c.followers ? fmt.n(c.followers) : "—"} />
                  <Row label="Last post" value={c.lastPostAt ? new Date(c.lastPostAt).toLocaleDateString("en", { day: "numeric", month: "short" }) : "none yet"} />
                  {c.native && c.rollup ? (
                    <Row label="Impressions" value={fmt.n(c.rollup.impressions)} />
                  ) : (
                    <p className="pt-1 text-[10.5px] leading-snug text-mist-400">
                      Insights need the native connection.{" "}
                      <Link href={`/connections${link}`} className="inline-flex items-center gap-0.5 text-mist-200 hover:underline">
                        Connect <ArrowUpRight size={10} />
                      </Link>
                    </p>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Row({ label, value, delta }: { label: string; value: string; delta?: number }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-mist-400">{label}</span>
      <span className="tnum text-mist-100">
        {value}
        {delta !== undefined && delta !== 0 && (
          <span className={`ml-1 text-[10px] ${delta > 0 ? "text-good-400" : "text-bad-400"}`}>
            {delta > 0 ? "+" : ""}{fmt.n(delta)}
          </span>
        )}
      </span>
    </div>
  );
}
