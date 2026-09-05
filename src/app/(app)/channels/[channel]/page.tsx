import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, PlugZap } from "lucide-react";
import { pageContext, qs } from "@/lib/page-context";
import { pctChange } from "@/lib/metrics/aggregate";
import { channelMeta } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Badge, Bar, Card, Dot, Empty, SectionTitle, Stat, fmt } from "@/components/ui";
import { TrendArea, VIZ } from "@/components/charts";
import { formatsOn, hasSignal, isChannelTab, snapshotFor, toChannelId } from "../_data";

export const dynamic = "force-dynamic";

/**
 * One channel, tracked on its own.
 *
 * Access is decided by the app layout through `requiredPermissionFor`, which
 * maps /channels to marketing.read — a read permission for a read-only screen.
 * The route adds no guard of its own, because a second gate that can disagree
 * with the first is worse than one gate everything goes through.
 */
export default async function ChannelPage({
  params,
  searchParams,
}: {
  params: Promise<{ channel: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ channel: segment }, sp] = await Promise.all([params, searchParams]);

  const channel = toChannelId(segment);
  // A segment that is not a ChannelId is not a page. Ad channels are ChannelIds
  // but have no organic surface of their own — their spend and ROAS live on
  // /ads — so they 404 here rather than rendering a tab whose every panel would
  // be empty by construction.
  if (!channel || !isChannelTab(channel)) notFound();

  const { db, brand, brandId, range, prev, days } = pageContext(sp);
  const link = qs(sp);
  const meta = channelMeta(channel);
  const snap = snapshotFor(db, brandId, channel, range, prev);
  const r = snap.rollup;
  const p = snap.previous;

  const live = snap.connections.filter((c) => c.status === "connected");
  const maxFormatReach = Math.max(...snap.formats.map((f) => f.reach), 1);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title={meta.label}
        subtitle={`${brand.name} · last ${days} days`}
        right={<Badge tone={live.length ? "good" : "neutral"}>{live.length ? "connected" : "not connected"}</Badge>}
      />

      <div className="space-y-6 p-7">
        <Link href={`/channels${link}`} className="inline-flex items-center gap-1.5 text-[12px] text-mist-400 hover:text-mist-100">
          <ArrowLeft size={13} /> All channels
        </Link>

        {snap.connections.length === 0 ? (
          <Card className="border-warn-500/25 bg-warn-500/[0.04]">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-warn-500/12 text-warn-400">
                <PlugZap size={14} />
              </span>
              <div className="min-w-0">
                <h2 className="text-[13px] font-semibold text-mist-100">{meta.label} is not connected</h2>
                <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-mist-400">
                  {brand.name} has no {meta.label} account on this workspace, so there is no handle, no
                  follower count and no metric for this tab to report. Connect the account and the figures
                  below fill in from {meta.label}&apos;s own reporting.
                </p>
                <Link
                  href={`/connections${link}`}
                  className="mt-3 inline-block rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
                >
                  Connect {meta.label}
                </Link>
              </div>
            </div>
          </Card>
        ) : (
          <Card>
            <SectionTitle
              title="Account"
              hint="Handle, follower level and sync state as the connector last reported them"
              action={
                <Link href={`/connections${link}`} className="text-[11px] text-mist-400 hover:text-mist-100">
                  Manage
                </Link>
              }
            />
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {snap.connections.map((c) => (
                <div key={c.id} className="rounded-xl border border-ink-800 p-3">
                  <div className="flex items-center gap-2">
                    <Dot color={meta.color} />
                    <span className="truncate text-[13px] font-medium text-mist-100">{c.handle}</span>
                    <Badge tone={c.status === "connected" ? "good" : "bad"} className="ml-auto">{c.status}</Badge>
                  </div>
                  <div className="tnum mt-2 text-[19px] font-semibold tracking-tight text-mist-100">
                    {fmt.full(c.followers)}
                  </div>
                  <div className="text-[11px] text-mist-400">followers reported by {meta.label}</div>
                  <div className="mt-2 text-[10.5px] text-mist-400">
                    Last synced {c.lastSyncedAt ? new Date(c.lastSyncedAt).toLocaleString() : "never"}
                  </div>
                  {c.lastError && (
                    <p className="mt-2 rounded-lg bg-bad-500/10 px-2 py-1.5 text-[11px] text-bad-400">{c.lastError}</p>
                  )}
                </div>
              ))}
            </div>
            {snap.supportedFormats.length > 0 && (
              <p className="mt-3 text-[10.5px] text-mist-400">
                Publishable formats on {meta.label}: {snap.supportedFormats.join(", ")}.
              </p>
            )}
          </Card>
        )}

        {!hasSignal(snap) ? (
          <Empty
            title={`No ${meta.label} figures for ${brand.name} yet`}
            hint={
              snap.connections.length === 0
                ? `Nothing has been synced from ${meta.label} because nothing is connected. Every number on this tab comes from ${meta.label}'s own reporting on ${brand.name}'s account — none of it is estimated, so the tab stays empty until that account exists.`
                : `The connection is in place but ${meta.label} has reported no day in the last ${days} days and no post has been published to it in that window. Publish from the composer, or widen the range, and the figures appear here.`
            }
          />
        ) : (
          <>
            {r && (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
                  <Stat
                    label="Followers"
                    value={fmt.n(r.followers)}
                    delta={p ? pctChange(r.followers, p.followers) : undefined}
                    sub={`${r.followerDelta >= 0 ? "+" : ""}${fmt.full(r.followerDelta)} net this period`}
                  />
                  <Stat label="Impressions" value={fmt.n(r.impressions)} delta={p ? pctChange(r.impressions, p.impressions) : undefined} />
                  <Stat label="Reach" value={fmt.n(r.reach)} delta={p ? pctChange(r.reach, p.reach) : undefined} />
                  <Stat label="Engagements" value={fmt.n(r.engagements)} delta={p ? pctChange(r.engagements, p.engagements) : undefined} />
                  <Stat label="Video views" value={fmt.n(r.videoViews)} delta={p ? pctChange(r.videoViews, p.videoViews) : undefined} />
                  <Stat
                    label="Engagement rate"
                    value={fmt.pct(r.engagementRate, 2)}
                    delta={p ? pctChange(r.engagementRate, p.engagementRate) : undefined}
                    sub="engagements ÷ impressions"
                  />
                </div>

                <div className="grid gap-5 xl:grid-cols-3">
                  <Card className="xl:col-span-2">
                    <SectionTitle
                      title="Impressions & engagements"
                      hint={`${meta.label} only, one point per day this channel reported`}
                    />
                    <TrendArea
                      data={snap.series}
                      series={[
                        { key: "impressions", name: "Impressions", color: VIZ[0] },
                        { key: "engagements", name: "Engagements", color: VIZ[2] },
                      ]}
                      height={280}
                    />
                  </Card>

                  <Card>
                    <SectionTitle
                      title="Follower growth"
                      hint="The level the channel reported each day, not a projection"
                    />
                    <div className="mb-2 flex items-baseline gap-2">
                      <span className="tnum text-2xl font-semibold tracking-tight text-mist-100">{fmt.n(r.followers)}</span>
                      <span className={`tnum text-[12px] font-semibold ${r.followerDelta >= 0 ? "text-good-400" : "text-bad-400"}`}>
                        {r.followerDelta >= 0 ? "+" : ""}{fmt.full(r.followerDelta)}
                      </span>
                      <span className="text-[11px] text-mist-400">over {days} days</span>
                    </div>
                    <TrendArea
                      data={snap.series}
                      series={[{ key: "followers", name: "Followers", color: VIZ[1] }]}
                      height={200}
                    />
                  </Card>
                </div>
              </>
            )}

            {!r && (
              <Card>
                <p className="py-6 text-center text-[12.5px] text-mist-400">
                  Posts published to {meta.label} in this period are listed below, but {meta.label} has
                  reported no daily account figures for it — so followers, impressions and reach have
                  nothing behind them and are left out rather than shown as zero.
                </p>
              </Card>
            )}

            <div className="grid gap-5 xl:grid-cols-2">
              <Card>
                <SectionTitle
                  title="Format breakdown"
                  hint={`Only the formats ${meta.label} accepts, averaged over posts published this period`}
                />
                {snap.posts.length === 0 ? (
                  <p className="py-6 text-center text-[12.5px] text-mist-400">
                    Nothing has been published to {meta.label} in the last {days} days, so there is no
                    format to compare.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {snap.formats.map((f) => (
                      <div key={f.format}>
                        <div className="mb-1 flex items-center gap-2 text-[11.5px]">
                          <span className="w-16 capitalize text-mist-300">{f.format}</span>
                          <span className="tnum text-mist-400">{f.posts} posts</span>
                          <span className="tnum ml-auto text-mist-100">{f.posts ? `${fmt.n(f.reach)} reach` : "—"}</span>
                          <span className="tnum w-12 text-right text-mist-400">{f.posts ? fmt.pct(f.engagementRate, 1) : "—"}</span>
                        </div>
                        <Bar value={f.reach} max={maxFormatReach} color={meta.color} />
                      </div>
                    ))}
                  </div>
                )}
              </Card>

              <Card>
                <SectionTitle
                  title="Top posts on this channel"
                  hint="Ranked by reach. Platforms report one metric set per post, so a post cross-published elsewhere shows its combined figures."
                />
                {snap.posts.length === 0 ? (
                  <p className="py-6 text-center text-[12.5px] text-mist-400">
                    No post has gone out to {meta.label} in the last {days} days.
                  </p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[560px] text-[11.5px]">
                      <thead>
                        <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                          <th className="py-2 font-medium">Post</th>
                          <th className="py-2 font-medium">Format</th>
                          <th className="py-2 text-right font-medium">Reach</th>
                          <th className="py-2 text-right font-medium">Likes</th>
                          <th className="py-2 text-right font-medium">Comm.</th>
                          <th className="py-2 text-right font-medium">Shares</th>
                          <th className="py-2 text-right font-medium">Saves</th>
                          <th className="py-2 text-right font-medium">Video</th>
                          <th className="py-2 text-right font-medium">3s hook</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snap.posts.slice(0, 10).map((post) => {
                          const m = post.metrics!;
                          return (
                            <tr key={post.id} className="border-b border-ink-800/60 last:border-0 hover:bg-ink-850/40">
                              <td className="max-w-[220px] truncate py-2 text-mist-200">{post.caption}</td>
                              <td className="py-2 capitalize text-mist-400">{formatsOn(post, channel).join(", ")}</td>
                              <td className="tnum py-2 text-right">{fmt.n(m.reach)}</td>
                              <td className="tnum py-2 text-right text-mist-300">{fmt.n(m.likes)}</td>
                              <td className="tnum py-2 text-right text-mist-300">{fmt.n(m.comments)}</td>
                              <td className="tnum py-2 text-right text-mist-300">{fmt.n(m.shares)}</td>
                              <td className="tnum py-2 text-right text-mist-300">{fmt.n(m.saves)}</td>
                              <td className="tnum py-2 text-right text-mist-300">{fmt.n(m.videoViews)}</td>
                              <td className="py-2 text-right">
                                <Badge tone={m.retention3s >= 0.65 ? "good" : m.retention3s >= 0.45 ? "warn" : "bad"}>
                                  {fmt.pct(m.retention3s * 100, 0)}
                                </Badge>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}
