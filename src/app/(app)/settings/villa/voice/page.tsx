import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle } from "@/components/ui";
import { getConfig } from "@/lib/voice/settings";
import { VoiceSettingsForm } from "@/components/voice/voice-settings-form";

export const dynamic = "force-dynamic";

/**
 * What the voice agent says, as a tab of the villa profile.
 *
 * The same form that lived at /voice/settings. It is here because "what the
 * agent says" and "when the agent calls" are one decision made by one person,
 * and splitting them across two areas of the app meant neither was found.
 */
export default async function VillaVoiceSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const config = getConfig(brandId, brand.name);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Villa profile" subtitle={`${brand.name} · voice agent`} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <Card>
          <SectionTitle
            title="What the agent says"
            hint="Wording only — the voice, model and telephony are configured by your operator and cannot be broken from here"
          />
          <VoiceSettingsForm initial={config} brandId={brandId} />
        </Card>
      </div>
    </>
  );
}
