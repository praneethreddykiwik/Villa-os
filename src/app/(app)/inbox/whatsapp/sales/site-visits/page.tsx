import Link from "next/link";
import { Car, MapPin, Users, Video } from "lucide-react";
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  SetupNotice,
  Stat,
  TemperaturePill,
  formatPercent,
} from "@/components/osf/ui";
import { parseRange, rangeLabel, rangeStartIso } from "@/components/osf/shell/nav-config";
import { gatedLoad } from "@/lib/osf/queries";
import { zonedDatePart } from "@/lib/osf/site-visit-booking";
import {
  VISIT_STATUS_LABELS,
  VISIT_STATUS_TONES,
  VISIT_TRANSITIONS,
  VISIT_TYPES,
  VISIT_TYPE_LABELS,
  activeMembers,
  formatDateTimeIst,
  formatDay,
  istDateParts,
  leadOptions,
  listSiteVisits,
  projectOptions,
  siteVisitStats,
  splitVisits,
  type SiteVisitRow,
} from "@/lib/osf/sales";

export const dynamic = "force-dynamic";

type Search = Promise<Record<string, string | string[] | undefined>>;

/** The moment a closed visit was decided — what the date window filters on. */
function decidedAt(v: SiteVisitRow): string {
  return v.completed_at ?? v.scheduled_at ?? v.created_at;
}

function leadLabel(v: SiteVisitRow): string {
  return v.villa_leads?.name?.trim() || (v.villa_leads ? `+${v.villa_leads.phone}` : "Lead removed");
}

export default async function SiteVisitsPage({ searchParams }: { searchParams: Search }) {
  const page = await gatedLoad({ table: "villa_site_visits", migration: "001_schema.sql" }, () =>
    Promise.all([
      searchParams,
      listSiteVisits(),
      leadOptions(),
      projectOptions(),
      activeMembers(),
    ] as const),
  );

  if (!page.ok) {
    return (
      <>
        <PageHeader title="Site Visits" />
        <SetupNotice missing={page.missing} detail={page.error} />
      </>
    );
  }

  const [params, visits, leads, projects, members] = page.data;
  const error = typeof params.error === "string" ? params.error : undefined;
  const range = parseRange(params.range);
  const since = rangeStartIso(range);

  const stats = siteVisitStats(visits);
  const { upcoming, closed } = splitVisits(visits);
  const closedInWindow = since ? closed.filter((v) => decidedAt(v) >= since) : closed;

  return (
    <>
      <PageHeader
        title="Site Visits"
        sub="The visit desk: what still needs a slot, who is walking the site next, and what each completed visit actually produced."
      />

      {error && (
        <div className="mb-6 rounded-2xl border border-[color-mix(in_oklab,var(--c-bad)_30%,transparent)] bg-[color-mix(in_oklab,var(--c-bad)_8%,transparent)] p-4 text-sm text-[var(--color-danger)]">
          {error}
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat label="Requested" value={stats.requested} sub="Awaiting a slot" />
        <Stat label="Scheduled" value={stats.scheduled} sub="Slot agreed or confirmed" />
        <Stat label="Completed" value={stats.completed} />
        <Stat label="No-shows" value={stats.noShow} />
        <Stat
          label="Completion rate"
          value={formatPercent(stats.completionRate, 0)}
          sub={
            stats.completed + stats.noShow > 0
              ? `${stats.completed} of ${stats.completed + stats.noShow} decided`
              : "No visit decided yet"
          }
          gold
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card
            title="Queue"
            hint="Requests without a time lead the queue — they are the ones a coordinator has to action."
          >
            {upcoming.length === 0 ? (
              <Empty>
                {visits.length === 0
                  ? "No site visit has been logged yet. The agent files one the moment a customer asks to see the property, and the form alongside adds one by hand."
                  : "Nothing open. Every visit on record has been completed, missed or cancelled."}
              </Empty>
            ) : (
              <ul className="space-y-3">
                {upcoming.map((visit) => (
                  <VisitCard key={visit.id} visit={visit} />
                ))}
              </ul>
            )}
          </Card>
        </div>

        <ScheduleForm leads={leads} projects={projects} members={members} />
      </div>

      <Card
        className="mt-5"
        title="Closed visits"
        hint={`Completed, missed and cancelled visits — ${rangeLabel(range).toLowerCase()}. Completing a visit is only half the record; the outcome is the other half.`}
      >
        {closedInWindow.length === 0 ? (
          <Empty>
            {closed.length > 0
              ? `No visit was closed in this window. ${closed.length} sit outside it.`
              : "No visit has been completed, missed or cancelled yet."}
          </Empty>
        ) : (
          <ul className="divide-y divide-[var(--color-line)]">
            {closedInWindow.map((visit) => (
              <ClosedVisit key={visit.id} visit={visit} />
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// -----------------------------------------------------------------------------

function DateChip({ visit }: { visit: SiteVisitRow }) {
  const iso = visit.scheduled_at ?? (visit.preferred_date ? `${visit.preferred_date}T00:00:00+05:30` : null);
  const parts = istDateParts(iso);

  return (
    <div
      className={`grid h-14 w-14 shrink-0 place-content-center rounded-xl border text-center ${
        parts
          ? "border-[var(--color-line)] bg-[var(--color-void)]"
          : "border-[var(--color-gold-line)] bg-[var(--color-gold-soft)]"
      }`}
    >
      {parts ? (
        <>
          <span className="text-lg font-semibold leading-none tabular-nums text-[var(--color-ink)]">
            {parts.day}
          </span>
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-faint)]">
            {parts.month}
          </span>
        </>
      ) : (
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-gold-300)]">
          No slot
        </span>
      )}
    </div>
  );
}

/**
 * Answering a request: confirm the slot they asked for, or offer another.
 *
 * The two buttons post the same form, so whichever the manager presses carries
 * whatever time is in the field. Confirming defaults to exactly what the
 * customer asked for — the common case is agreeing, and making them retype the
 * time they were given invites a typo into an appointment.
 *
 * There is no decline. Offering a different time IS the decline, and it leaves
 * the customer something to say yes to.
 */
function RespondToRequest({ visit }: { visit: SiteVisitRow }) {
  // datetime-local wants "YYYY-MM-DDTHH:MM" and nothing else. The date must
  // come out of the instant in the BUSINESS's zone: slicing the ISO string
  // takes the UTC date, so anything after 18:30 UTC pre-filled yesterday.
  const date =
    visit.preferred_date ??
    (visit.scheduled_at ? zonedDatePart(visit.scheduled_at, "Asia/Kolkata") : "") ??
    "";
  const time = (visit.preferred_time ?? "18:00").slice(0, 5);
  const asked = date ? `${date}T${time}` : "";

  return (
    <form
      action="/api/osf/site-visits/respond"
      method="POST"
      className="mt-3 space-y-2 border-t border-[var(--color-line)] pt-3"
    >
      <input type="hidden" name="visitId" value={visit.id} />

      <label className="block text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
        Time
        <input
          type="datetime-local"
          name="when"
          defaultValue={asked}
          required
          className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
      </label>

      <label className="block text-[11px] uppercase tracking-wide text-[var(--color-muted)]">
        Note (only sent when you suggest a different time)
        <input
          type="text"
          name="note"
          maxLength={160}
          placeholder="That slot is already taken."
          className="mt-1 w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-sm"
        />
      </label>

      <div className="flex flex-wrap gap-2">
        <button type="submit" name="action" value="confirm" className="btn-gold px-3 py-1.5 text-xs">
          Confirm this time
        </button>
        <button type="submit" name="action" value="alternative" className="btn-ghost px-3 py-1.5 text-xs">
          Suggest another time
        </button>
      </div>

      <p className="text-[11px] text-[var(--color-muted)]">
        Either way they get a WhatsApp message straight away. They are never told they were turned down.
      </p>
    </form>
  );
}

function VisitFacts({ visit }: { visit: SiteVisitRow }) {
  const TypeIcon = visit.visit_type === "virtual" ? Video : MapPin;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--color-muted)]">
      <span className="inline-flex items-center gap-1.5">
        <TypeIcon size={13} strokeWidth={1.75} aria-hidden />
        {VISIT_TYPE_LABELS[visit.visit_type] ?? visit.visit_type}
      </span>
      {visit.villa_projects?.name && <span>{visit.villa_projects.name}</span>}
      {visit.visitor_count !== null && (
        <span className="inline-flex items-center gap-1.5">
          <Users size={13} strokeWidth={1.75} aria-hidden />
          {visit.visitor_count} visiting
        </span>
      )}
      {visit.transport_arranged && (
        <span className="inline-flex items-center gap-1.5 text-[var(--color-gold-300)]">
          <Car size={13} strokeWidth={1.75} aria-hidden />
          Transport arranged
        </span>
      )}
      <span>
        Coordinator:{" "}
        <span className={visit.villa_team_members ? "text-[var(--color-ink)]" : "text-[var(--color-faint)]"}>
          {visit.villa_team_members?.name ?? "unassigned"}
        </span>
      </span>
    </div>
  );
}

function VisitCard({ visit }: { visit: SiteVisitRow }) {
  const moves = VISIT_TRANSITIONS[visit.status] ?? [];
  const slot = visit.scheduled_at
    ? formatDateTimeIst(visit.scheduled_at)
    : visit.preferred_date
      ? `Asked for ${formatDay(visit.preferred_date)}${visit.preferred_time ? `, ${visit.preferred_time}` : ""}`
      : "No time agreed yet";

  return (
    <li className="rounded-xl border border-[var(--color-line)] bg-[var(--color-void)]/40 p-4">
      <div className="flex gap-4">
        <DateChip visit={visit} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {visit.villa_leads ? (
              <Link
                href={`/inbox/whatsapp/crm/leads/${visit.villa_leads.id}`}
                className="truncate text-sm font-semibold text-[var(--color-ink)] hover:text-[var(--color-gold-300)]"
              >
                {leadLabel(visit)}
              </Link>
            ) : (
              <span className="text-sm font-semibold text-[var(--color-faint)]">{leadLabel(visit)}</span>
            )}
            {visit.villa_leads && <TemperaturePill value={visit.villa_leads.lead_temperature} />}
            <Badge tone={VISIT_STATUS_TONES[visit.status]}>{VISIT_STATUS_LABELS[visit.status]}</Badge>
          </div>

          <p className="mt-1 text-sm tabular-nums text-[var(--color-gold-300)]">{slot}</p>
          <VisitFacts visit={visit} />

          {visit.special_requirements && (
            <p className="mt-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-muted)]">
              {visit.special_requirements}
            </p>
          )}
        </div>
      </div>

      {visit.status === "requested" && <RespondToRequest visit={visit} />}

      {moves.length > 0 && (
        <form action="/api/osf/sales" method="POST" className="mt-3 flex flex-wrap gap-2 border-t border-[var(--color-line)] pt-3">
          <input type="hidden" name="action" value="visit-status" />
          <input type="hidden" name="visitId" value={visit.id} />
          {moves.map((next) => (
            <button
              key={next}
              type="submit"
              name="status"
              value={next}
              className="btn-ghost px-3 py-1.5 text-xs"
            >
              Mark {VISIT_STATUS_LABELS[next].toLowerCase()}
            </button>
          ))}
        </form>
      )}
    </li>
  );
}

function ClosedVisit({ visit }: { visit: SiteVisitRow }) {
  return (
    <li className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-[var(--color-ink)]">{leadLabel(visit)}</span>
        <Badge tone={VISIT_STATUS_TONES[visit.status]}>{VISIT_STATUS_LABELS[visit.status]}</Badge>
        <span className="ml-auto text-xs tabular-nums text-[var(--color-muted)]">
          {formatDateTimeIst(decidedAt(visit))}
        </span>
      </div>

      <VisitFacts visit={visit} />

      {(visit.outcome || visit.feedback) && (
        <div className="mt-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-void)]/40 px-3.5 py-3">
          {visit.outcome && (
            <p className="text-sm text-[var(--color-ink)]">
              <span className="label mr-2">Outcome</span>
              {visit.outcome}
            </p>
          )}
          {visit.feedback && (
            <p className={`text-sm text-[var(--color-muted)] ${visit.outcome ? "mt-2" : ""}`}>
              <span className="label mr-2">Feedback</span>
              {visit.feedback}
            </p>
          )}
        </div>
      )}

      {/* Only a visit that actually happened has an outcome to record. */}
      {visit.status === "completed" && (
        <details className="group mt-2.5">
          <summary className="cursor-pointer list-none text-xs font-medium text-[var(--color-gold-300)] hover:text-[var(--color-gold-100)]">
            {visit.outcome || visit.feedback ? "Revise the outcome" : "Record what came of it"}
          </summary>
          <form action="/api/osf/sales" method="POST" className="mt-3 space-y-2.5">
            <input type="hidden" name="action" value="visit-outcome" />
            <input type="hidden" name="visitId" value={visit.id} />
            <input
              type="text"
              name="outcome"
              defaultValue={visit.outcome ?? ""}
              placeholder="Outcome — e.g. shortlisted Plot 42, wants a corner unit"
              className="field"
            />
            <textarea
              name="feedback"
              rows={2}
              defaultValue={visit.feedback ?? ""}
              placeholder="What the customer said, in their words"
              className="field"
            />
            <button type="submit" className="btn-ghost px-3 py-1.5 text-xs">
              Save outcome
            </button>
          </form>
        </details>
      )}
    </li>
  );
}

// -----------------------------------------------------------------------------

function ScheduleForm({
  leads,
  projects,
  members,
}: {
  leads: Awaited<ReturnType<typeof leadOptions>>;
  projects: Awaited<ReturnType<typeof projectOptions>>;
  members: Awaited<ReturnType<typeof activeMembers>>;
}) {
  return (
    <Card
      title="Schedule a visit"
      hint="Leaving the slot blank files this as a request rather than inventing a time nobody agreed."
    >
      {leads.length === 0 ? (
        <Empty>
          Visits are always booked against a real lead.{" "}
          <Link href="/inbox/whatsapp/crm/leads" className="text-[var(--color-gold-300)] underline">
            Start from the leads list
          </Link>
          .
        </Empty>
      ) : (
        <form action="/api/osf/sales" method="POST" className="space-y-3.5">
          <input type="hidden" name="action" value="schedule-visit" />

          <label className="block">
            <span className="label mb-1.5 block">Lead</span>
            <select name="leadId" required defaultValue="" className="field">
              <option value="" disabled>
                Select a lead
              </option>
              {leads.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name ?? "Unnamed"} · +{l.phone}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label mb-1.5 block">Project</span>
            <select name="projectId" defaultValue="" className="field">
              <option value="">Not set</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label mb-1.5 block">Slot (IST)</span>
            <input type="datetime-local" name="scheduledAt" className="field" />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="label mb-1.5 block">Type</span>
              <select name="visitType" defaultValue="site" className="field">
                {VISIT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {VISIT_TYPE_LABELS[t]}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="label mb-1.5 block">Visitors</span>
              <input type="number" name="visitorCount" min={1} placeholder="—" className="field" />
            </label>
          </div>

          <label className="block">
            <span className="label mb-1.5 block">Coordinator</span>
            <select name="assignedTo" defaultValue="" className="field">
              <option value="">Unassigned</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="label mb-1.5 block">Special requirements</span>
            <input
              type="text"
              name="specialRequirements"
              placeholder="Wheelchair access, Telugu-speaking rep…"
              className="field"
            />
          </label>

          <label className="flex items-center gap-2.5 text-sm text-[var(--color-ink)]">
            <input
              type="checkbox"
              name="transportArranged"
              className="h-4 w-4 rounded border-[var(--color-line-strong)] bg-[var(--color-void)] accent-[var(--color-gold-500)]"
            />
            Transport arranged
          </label>

          <button type="submit" className="btn-gold w-full">
            Schedule visit
          </button>
        </form>
      )}
    </Card>
  );
}
