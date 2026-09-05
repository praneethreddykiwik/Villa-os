import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { loadVoiceOverview } from "@/lib/bolna/overview";
import { VoicePanel } from "@/components/voice/voice-panel";

export const dynamic = "force-dynamic";

/**
 * Voice agent tab.
 *
 * The first paint is server-rendered so the operator sees the agents and the
 * call history without a spinner; the panel refreshes itself through
 * /api/voice afterwards. Both go through `loadVoiceOverview`, so what the
 * refresh returns is the same view the page opened with.
 */
export default async function VoicePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const overview = await loadVoiceOverview(brandId);

  const subtitle = overview.configured
    ? `${overview.agents.length} agent${overview.agents.length === 1 ? "" : "s"} · ${brand.name}`
    : `Not connected · ${brand.name}`;

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Voice agent" subtitle={subtitle} />
      <div className="p-7">
        <VoicePanel initial={overview} brandId={brandId} />
      </div>
    </>
  );
}
