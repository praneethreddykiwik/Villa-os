import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Pipeline, type PipelineLead } from "@/components/crm/pipeline";
import { CrmEmpty } from "../_empty";

export const dynamic = "force-dynamic";

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  // Allowlist, not the whole row. The board draws stage, value and owner; the
  // Lead record also carries the buyer's phone, email and free-text notes, and
  // handing the component the record put all of it in this page's serialised
  // props even though nothing here renders it.
  const leads: PipelineLead[] = db.leads
    .filter((l) => l.brandId === brandId)
    .map((l) => ({
      id: l.id,
      name: l.name,
      status: l.status,
      score: l.score,
      source: l.source,
      budgetMin: l.budgetMin,
      budgetMax: l.budgetMax,
      projectInterest: l.projectInterest,
      assignedTo: l.assignedTo,
      isHNWI: l.isHNWI,
      kycStatus: l.kycStatus,
      lastContactedAt: l.lastContactedAt,
      siteVisitAt: l.siteVisitAt,
    }));

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Pipeline" subtitle={`${leads.length} deals · ${brand.name}`} />
      <div className="p-7">
        {leads.length === 0 ? <CrmEmpty brandName={brand.name} brandId={brandId} /> : <Pipeline leads={leads} />}
      </div>
    </>
  );
}
