import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { getConfig } from "@/lib/voice/settings";
import { VoiceSettingsForm } from "@/components/voice/voice-settings-form";

export const dynamic = "force-dynamic";

/** What the voice agent says. Gated on workflows.manage in page-access.ts. */
export default async function VoiceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const config = getConfig(brandId, brand.name);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Voice agent settings" subtitle={brand.name} />
      <div className="p-7">
        <VoiceSettingsForm initial={config} brandId={brandId} />
      </div>
    </>
  );
}
