import { pageContext } from "@/lib/page-context";
import { settingLabel, showOperatorDetail } from "@/lib/whitelabel";
import { channelMeta, isUsableConnection, connectionProblem } from "@/lib/platforms/registry";
import { webhookHealth } from "@/lib/platforms/health";
import { ChannelHealthPanel, type ChannelHealthRow } from "@/components/channel-health";
import { DRIVER } from "@/lib/platforms/types";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { ConnectPanel, type ConnectRow } from "@/components/connect-panel";
import { CONNECT_SPECS } from "@/lib/platforms/oauth";
import { UPLOAD_POST_PREFIX } from "@/lib/uploadpost/connections";
import { getSession, hasPermission } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const connections = db.connections.filter((c) => c.brandId === brandId);
  // Connector-backed rows carry a vendor-prefixed id; only admins see the raw value.
  const isAdmin = hasPermission(await getSession(), "users.manage");

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Channels &amp; Connections"
        subtitle={`${connections.length} accounts on ${brand.name}`}
        right={<Badge tone={DRIVER === "live" ? "good" : "warn"}>driver: {DRIVER}</Badge>}
      />

      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <ConnectPanel
          brandId={brandId}
          rows={CONNECT_SPECS.map<ConnectRow>((spec) => {
            const existing = connections.find((c) => c.channel === spec.channel);
            return {
              channel: spec.channel,
              label: spec.label,
              color: spec.color,
              connected: existing ? isUsableConnection(existing) : false,
              problem: existing ? connectionProblem(existing) : null,
              status: existing?.status,
              handle: existing?.handle,
              scopes: spec.scopes,
              unlocks: spec.unlocks,
              notes: spec.notes,
              // Plain-language on a client install, raw names for the vendor.
              // Deduped because two variables can mean the same thing to a reader.
              envVars: showOperatorDetail()
                ? spec.envVars
                : Array.from(new Set(spec.envVars.map(settingLabel))),
            };
          })}
        />

        {/*
          The live grid replaces the old read-out of stored fields. Those fields
          described what was written at connect time, not whether the credential
          still works — which is the only question this screen exists to answer.
        */}
        <ChannelHealthPanel
          brandId={brandId}
          initialWebhooks={webhookHealth()}
          initial={connections.map<ChannelHealthRow>((c) => {
            const meta = channelMeta(c.channel);
            const problem = connectionProblem(c);
            return {
              channel: c.id,
              label: meta.label,
              color: meta.color,
              handle: c.handle,
              tokenExpiresAt: c.tokenExpiresAt,
              lastSyncedAt: c.lastSyncedAt,
              state: isUsableConnection(c) ? "unchecked" : "absent",
              detail: problem ?? "Checking with the platform\u2026",
            };
          })}
        />

        <Card>
          <SectionTitle title="How publishing works" />
          <ul className="space-y-1.5 text-[12px] leading-relaxed text-mist-300">
            <li>· A post fans out to one <em>target</em> per account. Targets succeed and fail independently — Instagram going out does not depend on TikTok.</li>
            <li>· Before publishing, the worker asks each platform how much of the daily quota is left and defers rather than burning an API error.</li>
            <li>· Retryable failures (429, 5xx, media still transcoding) back off 2 → 10 → 45 minutes. Permanent failures (caption too long, wrong aspect ratio) stop immediately and surface in the calendar.</li>
            <li>· Set <code className="rounded bg-ink-800 px-1">PLATFORM_DRIVER=live</code> plus the tokens in <code className="rounded bg-ink-800 px-1">.env</code> to publish for real.</li>
          </ul>
        </Card>
      </div>
    </>
  );
}
