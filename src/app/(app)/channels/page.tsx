import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { pageContext, qs } from "@/lib/page-context";
import { ensureFreshStats } from "@/lib/engine/freshness";
import { channelMeta, isUsableConnection, connectionProblem } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Badge, Card, Dot, Empty, SectionTitle, fmt } from "@/components/ui";
import { CHANNEL_TABS, hasSignal, snapshotFor } from "./_data";

export const dynamic = "force-dynamic";

/**
 * The channels index — every tab side by side, so the question "which one is
 * actually working" is answered before anyone opens a tab.
 *
 * A channel with no connection is still listed. Hiding it would leave the reader
 * unable to tell "we are not on LinkedIn" from "LinkedIn did badly", which is
 * the one comparison this page exists to make.
 */
export default async function ChannelsIndexPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Refresh YouTube rows older than ten minutes before reading; a failed
  // refresh renders the stale store rather than an error.
  const pre = pageContext(sp);
  const fresh = await ensureFreshStats(pre.brandId);
  const { db, brand, brandId, range, prev, days } = fresh.refreshed ? pageContext(sp) : pre;
  const link = qs(sp);

  const snaps = CHANNEL_TABS.map((channel) => snapshotFor(db, brandId, channel, range, prev));
  const connected = snaps.filter((s) => s.connections.length > 0);
  const missing = snaps.filter((s) => s.connections.length === 0);
  const measured = connected.filter(hasSignal);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Channels"
        subtitle={`${brand.name} · ${connected.length} of ${snaps.length} connected · last ${days} days`}
      />

      <div className="space-y-6 p-7">
        {connected.length === 0 ? (
          <Empty
            title={`No channels are connected for ${brand.name}`}
            hint={`Every figure on these tabs is read back from the channel's own reporting, so there is nothing to compare until at least one account is connected. Connect Instagram, Facebook, LinkedIn or YouTube and each one gets its own tracked tab.`}
          />
        ) : (
          <Card>
            <SectionTitle
              title="Side by side"
              hint={
                measured.length
                  ? "Account figures for the selected range. A channel that reported no day shows a dash rather than a zero."
                  : "Connected, but none of these channels has reported a day in this range yet."
              }
            />
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-[12px]">
                <thead>
                  <tr className="border-b border-ink-800 text-left text-[10px] uppercase tracking-wider text-mist-400">
                    <th className="py-2 font-medium">Channel</th>
                    <th className="py-2 font-medium">Handle</th>
                    <th className="py-2 text-right font-medium">Followers</th>
                    <th className="py-2 text-right font-medium">Net</th>
                    <th className="py-2 text-right font-medium">Impressions</th>
                    <th className="py-2 text-right font-medium">Reach</th>
                    <th className="py-2 text-right font-medium">Eng. rate</th>
                    <th className="py-2 text-right font-medium">Posts</th>
                    <th className="py-2 font-medium">Last synced</th>
                    <th className="py-2" />
                  </tr>
                </thead>
                <tbody>
                  {connected.map((s) => {
                    const r = s.rollup;
                    return (
                      <tr key={s.channel} className="border-b border-ink-800/60 last:border-0 hover:bg-ink-850/40">
                        <td className="py-2">
                          <Link href={`/channels/${s.channel}${link}`} className="flex items-center gap-1.5 text-mist-100 hover:underline">
                            <Dot color={s.color} />
                            {s.label}
                          </Link>
                        </td>
                        <td className="max-w-[160px] truncate py-2 text-mist-400">
                          {s.connections.map((c) => c.handle).join(", ")}
                        </td>
                        {/* The follower level comes off the connection record, so it
                            is present the moment an account is linked — the rest of
                            the row needs a synced day and says so when there is none. */}
                        <td className="tnum py-2 text-right">{s.followers === null ? "—" : fmt.n(s.followers)}</td>
                        <td className={`tnum py-2 text-right ${r && r.followerDelta < 0 ? "text-bad-400" : r ? "text-good-400" : "text-mist-400"}`}>
                          {r ? `${r.followerDelta >= 0 ? "+" : ""}${fmt.n(r.followerDelta)}` : "—"}
                        </td>
                        <td className="tnum py-2 text-right">{r ? fmt.n(r.impressions) : "—"}</td>
                        <td className="tnum py-2 text-right">{r ? fmt.n(r.reach) : "—"}</td>
                        <td className="tnum py-2 text-right">{r ? fmt.pct(r.engagementRate, 2) : "—"}</td>
                        <td className="tnum py-2 text-right text-mist-300">{s.posts.length}</td>
                        <td className="py-2 text-[11px] text-mist-400">
                          {s.lastSyncedAt ? new Date(s.lastSyncedAt).toLocaleDateString() : "never"}
                        </td>
                        <td className="py-2 text-right">
                          <Link href={`/channels/${s.channel}${link}`} className="inline-flex items-center text-mist-400 hover:text-mist-100">
                            <ChevronRight size={14} />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        <div>
          <SectionTitle
            title="All tabs"
            hint="Each channel is tracked on its own tab, connected or not"
          />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {snaps.map((s) => {
              const meta = channelMeta(s.channel);
              const live = s.connections.some((c) => isUsableConnection(c));
              return (
                <Link key={s.channel} href={`/channels/${s.channel}${link}`} className="card card-hover p-4">
                  <div className="flex items-center gap-2">
                    <span
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[13px] font-bold text-white"
                      style={{ background: meta.color }}
                    >
                      {meta.label[0]}
                    </span>
                    <span className="truncate text-[13px] font-medium text-mist-100">{meta.label}</span>
                    <Badge tone={live ? "good" : "neutral"} className="ml-auto">
                      {s.connections.length === 0 ? "not connected" : live ? "connected" : "needs attention"}
                    </Badge>
                  </div>
                  <div className="mt-3 text-[11.5px] text-mist-400">
                    {s.connections.length === 0
                      ? `No ${meta.label} account on ${brand.name}.`
                      : hasSignal(s)
                        ? `${s.followers === null ? "—" : fmt.full(s.followers)} followers · ${s.posts.length} posts this period`
                        : `${s.followers === null ? "—" : fmt.full(s.followers)} followers · nothing reported in the last ${days} days`}
                  </div>
                </Link>
              );
            })}
          </div>
        </div>

        {missing.length > 0 && (
          <Card>
            <SectionTitle title="Not connected" hint="These tabs stay empty until the account is linked" />
            <p className="text-[12.5px] leading-relaxed text-mist-400">
              {missing.map((s) => s.label).join(", ")} {missing.length === 1 ? "has" : "have"} no account on{" "}
              {brand.name}. Nothing is estimated for a channel that is not connected — the tab reports
              what the platform reports, or it reports nothing.
            </p>
            <Link
              href={`/connections${link}`}
              className="mt-3 inline-block rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
            >
              Go to connections
            </Link>
          </Card>
        )}
      </div>
    </>
  );
}
