import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { WhatsAppTrainingPanel } from "@/components/voice/whatsapp-training-panel";

export const dynamic = "force-dynamic";

export default async function WhatsAppTrainingPage({
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
        title="WhatsApp AI"
        subtitle={`Train the assistant · ${brand.name}`}
      />
      <div className="p-7">
        <WhatsAppTrainingPanel brandId={brandId} />
      </div>
    </>
  );
}
