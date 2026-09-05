import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Stat } from "@/components/ui";
import { HOLDS_SLOT } from "@/lib/appointments/types";
import { AppointmentsView } from "@/components/crm/appointments-view";
import { CrmEmpty } from "../_empty";

export const dynamic = "force-dynamic";

/**
 * The site-visit desk.
 *
 * A villa sale turns on getting the buyer onto the plot, so the numbers that
 * matter here are not "how many bookings exist" but "what is happening today"
 * and "what has already happened that nobody has closed out". A visit whose
 * start time has passed while it is still confirmed is the expensive case: it
 * keeps holding a slot other buyers could have taken, and it leaves the lead
 * sitting in `site_visit_scheduled` for a visit that may never have happened.
 * That bucket is pulled to the top rather than buried in a date-sorted list.
 */
export default async function AppointmentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  // `?? []` because a store written before appointments existed has no such key.
  const appointments = (db.appointments ?? [])
    .filter((a) => a.brandId === brandId)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  const now = Date.now();
  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const live = appointments.filter((a) => HOLDS_SLOT.includes(a.status));
  const today = live.filter((a) => {
    const t = new Date(a.startsAt).getTime();
    return t >= now && t <= endOfToday.getTime();
  });
  const week = live.filter((a) => {
    const t = new Date(a.startsAt).getTime();
    return t > endOfToday.getTime() && t <= now + 7 * 86400000;
  });
  const needsOutcome = live.filter((a) => new Date(a.startsAt).getTime() < now);
  const completed = appointments.filter(
    (a) => a.status === "completed" && new Date(a.startsAt).getTime() > now - 30 * 86400000,
  );

  const leads = db.leads
    .filter((l) => l.brandId === brandId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((l) => ({ id: l.id, name: l.name, phone: l.phone }));

  // Hosts come from the real team list, plus anyone already carrying a visit, so
  // an assignment made before someone left the team is still selectable.
  const staff = [
    ...new Set([
      ...db.teamMembers.filter((m) => m.active).map((m) => m.name),
      ...appointments.map((a) => a.assignedTo).filter((s): s is string => Boolean(s)),
    ]),
  ].sort();

  // The CRM is per brand, and so is this. With no leads and no visits there is
  // nothing to show that would not read as a bug.
  const hasCrm = leads.length > 0 || appointments.length > 0;

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Site visits"
        subtitle={`${today.length} today · ${live.length} upcoming · ${brand.name}`}
      />
      <div className="space-y-5 p-7">
        {!hasCrm ? (
          <CrmEmpty brandName={brand.name} brandId={brandId} />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Today" value={String(today.length)} sub="still to happen" />
              <Stat label="Next 7 days" value={String(week.length)} sub="confirmed and holding a slot" />
              <Stat label="Needs an outcome" value={String(needsOutcome.length)} sub="start time passed, still open" />
              <Stat label="Completed (30d)" value={String(completed.length)} sub="buyer actually walked the plot" />
            </div>

            <AppointmentsView
              appointments={appointments}
              brandId={brandId}
              brandName={brand.name}
              leads={leads}
              staff={staff}
            />
          </>
        )}
      </div>
    </>
  );
}
