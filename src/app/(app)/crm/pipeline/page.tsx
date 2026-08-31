import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Pipeline } from "@/components/crm/pipeline";
import { CrmEmpty } from "../_empty";

export const dynamic = "force-dynamic";

export default async function PipelinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const leads = db.leads.filter((l) => l.brandId === brandId);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Pipeline" subtitle={`${leads.length} deals · ${brand.name}`} />
      <div className="p-7">
        {leads.length === 0 ? <CrmEmpty brandName={brand.name} brandId={brandId} /> : <Pipeline leads={leads} />}
      </div>
    </>
  );
}
