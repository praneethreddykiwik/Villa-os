import { headers } from "next/headers";
import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Badge } from "@/components/ui";
import { N8nPanel } from "@/components/automation/n8n-panel";
import { INBOUND_PATH } from "@/lib/automation/types";
import { recentSubmissions, videoFormUrlProblem } from "@/lib/automation/video-post";

export const dynamic = "force-dynamic";

/**
 * AUTOMATION — the n8n screen.
 *
 * One place for both directions of the operator's automation: the wiring
 * (subscribers, deliveries, the inbound endpoint n8n calls back on) and the
 * video-posting form their workflow already exposes.
 *
 * Only three things are computed here, because everything else belongs to a
 * gated API the panel calls for itself: the public origin (a server-side fact
 * the browser cannot be trusted to report), whether the two settings are
 * present, and the submission history. Presence, never values — the inbound
 * secret and the workflow URL are both capabilities, and a screen that prints
 * either turns a shoulder-glance into an authenticated caller.
 */
export default async function AutomationPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  // Built from the request rather than a configured base URL: this is the
  // address the operator is looking at, which is the one that will work when
  // they paste it into n8n.
  const h = await headers();
  const proto = h.get("x-forwarded-proto") ?? "https";
  const inboundUrl = `${proto}://${h.get("host") ?? ""}${INBOUND_PATH}`;

  const formProblem = videoFormUrlProblem();
  const submissions = recentSubmissions(25);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Publish video"
        subtitle={`Post content to all channels · ${brand.name}`}
        right={<Badge tone={formProblem ? "bad" : "good"}>{formProblem ? "not configured" : "configured"}</Badge>}
      />

      <div className="p-7">
        <N8nPanel
          inboundUrl={inboundUrl}
          inboundSecretConfigured={Boolean(process.env.N8N_WEBHOOK_SECRET)}
          formUrlProblem={formProblem}
          submissions={submissions}
        />
      </div>
    </>
  );
}
