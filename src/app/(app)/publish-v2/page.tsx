import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Badge } from "@/components/ui";
import { V2Form } from "@/components/automation/v2-form";

export const dynamic = "force-dynamic";

export default async function PublishV2Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Publish a video"
        subtitle={brand.name}
        right={<Badge tone="good">pipeline active</Badge>}
      />

      <div className="p-4 sm:p-6 lg:p-7">
        <V2Form brandId={brandId} brandName={brand.name} />
      </div>
    </>
  );
}
