import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight, Flame, AlertTriangle, MessageSquare } from "lucide-react";
import { DonutChart, FunnelChart, TrendChart } from "@/components/osf/charts";
import { parseRange, rangeLabel, rangeToDays } from "@/components/osf/shell/nav-config";
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  SetupNotice,
  Stat,
  TemperaturePill,
  formatCr,
  formatInr,
  formatNumber,
  formatPercent,
  timeAgo,
} from "@/components/osf/ui";
import {
  analyticsWindow,
  collapseToSources,
  delta,
  funnelStages,
  leadTrend,
  rate,
  recentActivity,
  snapshot,
  sourceBreakdown,
  unassignedHotLeads,
  clientRanking,
} from "@/lib/osf/analytics";
import { STAGE_TONES, humanise, type PipelineStage } from "@/lib/osf/crm";
import { SentimentPill } from "../crm/rankings/sentiment";
import { configStatus } from "@/lib/osf/env";
import { gatedLoad } from "@/lib/osf/queries";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

/** `rate()` returns a fraction; the formatter wants percentage points. */
function pct(ratio: number | null): string {
  return ratio === null ? "—" : formatPercent(ratio * 100);
}

export default async function OverviewPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const w = analyticsWindow(rangeToDays(range));

  // Gated on villa_daily_leads, not villa_activities: the trend chart and all
  // three KPI deltas come from that view, so if it is missing the top half of
  // this page renders zeros that read as "a quiet month" rather than "the
  // migration has not been run". villa_activities only feeds the activity list
  // at the bottom, which degrades honestly to its own empty state.
  const page = await gatedLoad({ table: "villa_daily_leads", migration: "001_schema.sql" }, () =>
    Promise.all([
      snapshot(w),
      leadTrend(w),
      sourceBreakdown(w),
      recentActivity(w, 9),
      unassignedHotLeads(6),
      clientRanking(8),
    ] as const),
  );

  if (!page.ok) {
    return (
      <>
        <PageHeader title="Overview" />
        <SetupNotice missing={page.missing} detail={page.error} />
        <Checklist />
      </>
    );
  }

  const [snap, trend, sources, activity, attention, ranking] = page.data;
  const prev = trend.previous;

  const sourceSplit = collapseToSources(sources);
  const avgBookingInr = snap.bookings > 0 ? Math.round(snap.revenueInr / snap.bookings) : null;

  // Charted separately from the KPI numbers above, but from the same window —
  // both are anchored on villa_daily_leads' UTC day buckets.
  const trendData = trend.points.map((p) => ({
    label: p.label,
    leads: p.leads,
    qualified: p.qualified,
    hot: p.hot,
  }));

  return (
    <>
      <PageHeader
        title="Overview"
        sub={`${rangeLabel(range)} — leads, qualification and revenue across every channel the agent works.`}
        actions={
          <>
            <Link
              href="/inbox/whatsapp/communication/whatsapp"
              className="btn-gold h-9 py-0 text-[13px]"
            >
              <MessageSquare size={14} strokeWidth={2} aria-hidden />
              Open conversations
            </Link>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat
          label="Leads"
          value={formatNumber(snap.leads)}
          sub={`${formatNumber(snap.conversations)} conversations`}
          delta={prev ? delta(trend.current.leads, prev.leads) : null}
        />
        <Stat
          label="Qualified"
          value={formatNumber(snap.qualified)}
          sub={`${pct(rate(snap.qualified, snap.leads))} of leads · score ≥ 50`}
          delta={prev ? delta(trend.current.qualified, prev.qualified) : null}
        />
        <Stat
          label="Hot leads"
          value={formatNumber(snap.hot)}
          sub={`${pct(rate(snap.hot, snap.leads))} of leads`}
          delta={prev ? delta(trend.current.hot, prev.hot) : null}
        />
        <Stat
          label="Site visits"
          value={formatNumber(snap.siteVisits)}
          sub={`${formatNumber(snap.siteVisitsCompleted)} completed · ${pct(
            rate(snap.siteVisits, snap.qualified),
          )} of qualified`}
        />
        <Stat
          label="Bookings"
          value={formatNumber(snap.bookings)}
          sub={`${pct(rate(snap.bookings, snap.leads))} lead → booking`}
        />
        <Stat
          gold
          label="Booked revenue"
          value={formatCr(snap.revenueInr)}
          sub={avgBookingInr === null ? "No bookings in this period" : `${formatInr(avgBookingInr)} average booking`}
        />
      </div>

      {/*
        Temperature and sentiment are the two signals the agent recomputes on
        every reply, so they belong beside the KPIs rather than only inside the
        rankings list further down. Every number here comes from
        `clientRanking()`'s own totals — the live book, deliberately not
        date-filtered, same as the rankings card.
      */}
      <Card
        title="Client signals"
        hint="Buying temperature and conversation sentiment across the whole active book."
        className="mt-5"
        actions={
          <span className="text-xs tabular-nums text-[var(--color-muted)]">
            {formatNumber(ranking.totals.all)} active
          </span>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <p className="label">Temperature</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
              <SignalCount label={<TemperaturePill value="hot" />} value={ranking.totals.hot} />
              <SignalCount label={<TemperaturePill value="warm" />} value={ranking.totals.warm} />
              <SignalCount label={<TemperaturePill value="cold" />} value={ranking.totals.cold} />
            </div>
          </div>
          <div>
            <p className="label">Sentiment</p>
            <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-2">
              <SignalCount
                label={<SentimentPill value="positive" />}
                value={ranking.sentiment.positive}
              />
              <SignalCount
                label={<SentimentPill value="neutral" />}
                value={ranking.sentiment.neutral}
              />
              <SignalCount
                label={<SentimentPill value="negative" />}
                value={ranking.sentiment.negative}
              />
              <SignalCount label={<SentimentPill value={null} />} value={ranking.sentiment.unknown} />
            </div>
          </div>
        </div>
      </Card>

      <div className="mt-5 grid gap-4 lg:grid-cols-3">
        <Card
          title="Lead flow"
          hint="Daily arrivals, how many qualified, and how many ran hot."
          className="lg:col-span-2"
        >
          {trendData.length === 0 ? (
            <Empty>No leads recorded in this period.</Empty>
          ) : (
            <TrendChart
              data={trendData}
              keys={[
                { key: "leads", name: "Leads" },
                { key: "qualified", name: "Qualified" },
                { key: "hot", name: "Hot" },
              ]}
              height={280}
            />
          )}
        </Card>

        <Card title="Where leads come from" hint="First-touch source recorded on the lead.">
          {sourceSplit.length === 0 ? (
            <Empty>No attributed leads yet.</Empty>
          ) : (
            <>
              <DonutChart data={sourceSplit} height={230} />
            </>
          )}
        </Card>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-5">
        <Card
          title="Conversion funnel"
          hint="Every conversation through to a signed booking."
          className="lg:col-span-2"
        >
          {snap.conversations === 0 && snap.leads === 0 ? (
            <Empty>Nothing has moved through the funnel in this period.</Empty>
          ) : (
            <FunnelChart stages={funnelStages(snap)} />
          )}
        </Card>

        <Card
          title="Needs attention"
          hint="Hot leads with no owner. Not filtered by date — an old one is the most urgent, not the least."
          actions={
            attention.length > 0 ? (
              <span className="pill bg-[color-mix(in_oklab,var(--c-bad)_14%,transparent)] text-[var(--color-hot)]">
                <Flame size={11} strokeWidth={2} aria-hidden />
                {attention.length}
              </span>
            ) : undefined
          }
          className="lg:col-span-3"
        >
          {attention.length === 0 ? (
            <Empty>Every hot lead has an owner.</Empty>
          ) : (
            <ul className="-my-1 divide-y divide-[var(--color-line)]">
              {attention.map((lead) => (
                <li key={lead.id} className="group relative flex items-center gap-4 py-3">
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/inbox/whatsapp/crm/leads/${lead.id}`}
                      className="truncate text-sm font-medium text-[var(--color-ink)] after:absolute after:inset-0 group-hover:text-[var(--color-gold-100)]"
                    >
                      {lead.name ?? lead.phone}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-[var(--color-muted)]">
                      {lead.budget_max_inr ? `up to ${formatCr(lead.budget_max_inr)} · ` : ""}
                      {humanise(lead.purchase_timeline)} · {timeAgo(lead.last_contact_at)}
                    </p>
                  </div>
                  <Badge tone={STAGE_TONES[lead.pipeline_stage as PipelineStage] ?? "neutral"}>
                    {humanise(lead.pipeline_stage)}
                  </Badge>
                  <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums text-[var(--color-gold-300)]">
                    {lead.lead_score}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card
        title="Client rankings"
        hint="Every active client ordered by buying intent. The score is the agent's, recomputed on each reply."
        className="mt-5"
        actions={
          <Link
            href="/inbox/whatsapp/crm/rankings"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-muted)] transition hover:text-[var(--color-gold-300)]"
          >
            All {formatNumber(ranking.totals.all)}
            <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
          </Link>
        }
      >
        {ranking.clients.length === 0 ? (
          <Empty>
            No active clients yet. Everyone who messages the WhatsApp agent is scored and appears
            here automatically.
          </Empty>
        ) : (
          <ul className="-my-1 divide-y divide-[var(--color-line)]">
            {ranking.clients.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
                <span className="w-5 shrink-0 text-xs tabular-nums text-[var(--color-faint)]">
                  {c.rank}
                </span>
                <Link
                  href={`/inbox/whatsapp/crm/leads/${c.id}`}
                  className="min-w-0 flex-1 truncate text-sm font-medium transition hover:text-[var(--color-gold-300)]"
                >
                  {c.name ?? c.phone}
                </Link>
                <SentimentPill value={c.sentiment} />
                <TemperaturePill value={c.lead_temperature} />
                <span className="w-6 shrink-0 text-right text-xs tabular-nums text-[var(--color-muted)]">
                  {c.lead_score}
                </span>
                <span className="w-20 shrink-0 text-right text-xs tabular-nums text-[var(--color-faint)]">
                  {timeAgo(c.last_contact_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Recent activity"
        hint="Everything the agent and the team logged, newest first."
        className="mt-5"
      >
        {activity.length === 0 ? (
          <Empty>No activity recorded in this period.</Empty>
        ) : (
          <ul className="-my-1 divide-y divide-[var(--color-line)]">
            {activity.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-3">
                <span className="label shrink-0 text-[var(--color-gold-700)]">
                  {humanise(row.activity_type)}
                </span>
                <p className="min-w-0 flex-1 text-sm text-[var(--color-ink)]">{row.description}</p>
                {row.villa_leads && (
                  <Link
                    href={`/inbox/whatsapp/crm/leads/${row.villa_leads.id}`}
                    className="shrink-0 text-xs text-[var(--color-muted)] underline decoration-[var(--color-line-strong)] underline-offset-2 transition hover:text-[var(--color-gold-300)]"
                  >
                    {row.villa_leads.name ?? row.villa_leads.phone}
                  </Link>
                )}
                <span className="shrink-0 text-xs tabular-nums text-[var(--color-faint)]">
                  {timeAgo(row.created_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

/** A pill with its count, sized so the four sentiment buckets wrap cleanly at 375px. */
function SignalCount({ label, value }: { label: ReactNode; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span className="text-sm font-semibold tabular-nums text-[var(--color-ink)]">
        {formatNumber(value)}
      </span>
    </span>
  );
}

/**
 * Shown only when the gate fails. `/inbox/whatsapp` is where someone lands on a fresh clone,
 * so the fix-it list belongs here rather than buried in the docs.
 */
function Checklist() {
  const s = configStatus();
  const items = [
    [
      s.aiConfigured,
      s.llmProvider === "groq" ? "AI assistant (test mode)" : "AI assistant",
      s.llmProvider === "groq"
        ? "Running on the free tier while you test. Upgrade before going live."
        : "The agent cannot reply without this.",
    ],
    [s.supabase, "Customer records", "Where leads and conversations are stored."],
    [s.whatsapp, "WhatsApp connection", "Optional to start — you can test without it."],
    [s.salesHandoff, "Sales team number", "Where hot-lead alerts get sent."],
  ] as const;

  return (
    <Card title="Setup checklist">
      <ul className="space-y-3">
        {items.map(([done, label, hint]) => (
          <li key={label} className="flex gap-3">
            <span
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                done
                  ? "bg-[var(--color-gold-500)] text-[var(--color-void)]"
                  : "border border-[var(--color-line)] text-[var(--color-muted)]"
              }`}
            >
              {done ? "✓" : ""}
            </span>
            <div>
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-[var(--color-muted)]">{hint}</p>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-5 flex items-start gap-2 border-t border-[var(--color-line)] pt-4 text-xs text-[var(--color-muted)]">
        <AlertTriangle size={13} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-[var(--color-warm)]" />
        <span>
          Then apply the database schema migration (<code className="rounded bg-[var(--color-raised)] px-1 py-0.5">001_schema.sql</code>)
          to the database. Until it exists, every page here shows this notice rather than an empty dashboard.
        </span>
      </p>
    </Card>
  );
}
