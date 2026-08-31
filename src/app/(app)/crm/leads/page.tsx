import { pageContext } from "@/lib/page-context";
import { inr } from "@/lib/crm/format";
import { TopBar } from "@/components/shell";
import { Stat } from "@/components/ui";
import { LeadsGrid } from "@/components/crm/leads-grid";
import { CrmEmpty } from "../_empty";

export const dynamic = "force-dynamic";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const leads = db.leads.filter((l) => l.brandId === brandId);
  const brokers = db.brokers.filter((b) => b.brandId === brandId);

  const open = leads.filter((l) => !["won", "lost"].includes(l.status));
  const pipelineValue = open.reduce((a, l) => a + (l.budgetMin + l.budgetMax) / 2, 0);
  const wonValue = leads.filter((l) => l.status === "won").reduce((a, l) => a + (l.budgetMin + l.budgetMax) / 2, 0);
  const conversion = leads.length ? (leads.filter((l) => l.status === "won").length / leads.length) * 100 : 0;

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Leads" subtitle={`${leads.length} leads · ${brand.name}`} />
      <div className="space-y-5 p-7">
        {leads.length === 0 ? (
          <CrmEmpty brandName={brand.name} brandId={brandId} />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-5">
              <Stat label="Open leads" value={String(open.length)} sub={`${leads.length} all time`} />
              <Stat label="Pipeline value" value={inr(pipelineValue)} sub="sum of budget midpoints" />
              <Stat label="Closed won" value={inr(wonValue)} sub={`${leads.filter((l) => l.status === "won").length} deals`} />
              <Stat label="Conversion" value={`${conversion.toFixed(1)}%`} sub="lead → won" />
              <Stat label="HNWI" value={String(leads.filter((l) => l.isHNWI).length)} sub="₹8 Cr+ budget" />
            </div>
            <LeadsGrid leads={leads} brokers={brokers} />
          </>
        )}
      </div>
    </>
  );
}
