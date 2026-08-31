import { pageContext } from "@/lib/page-context";
import { adapterFor, channelMeta } from "@/lib/platforms/registry";
import { DRIVER } from "@/lib/platforms/types";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge, fmt } from "@/components/ui";
import { ConnectPanel, type ConnectRow } from "@/components/connect-panel";
import { CONNECT_SPECS } from "@/lib/platforms/oauth";

export const dynamic = "force-dynamic";

export default async function ConnectionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const connections = db.connections.filter((c) => c.brandId === brandId);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Connections"
        subtitle={`${connections.length} accounts on ${brand.name}`}
        right={<Badge tone={DRIVER === "live" ? "good" : "warn"}>driver: {DRIVER}</Badge>}
      />

      <div className="space-y-6 p-7">
        <ConnectPanel
          brandId={brandId}
          rows={CONNECT_SPECS.map<ConnectRow>((spec) => {
            const existing = connections.find((c) => c.channel === spec.channel);
            return {
              channel: spec.channel,
              label: spec.label,
              color: spec.color,
              connected: existing?.status === "connected",
              status: existing?.status,
              handle: existing?.handle,
              scopes: spec.scopes,
              unlocks: spec.unlocks,
              notes: spec.notes,
              envVars: spec.envVars,
            };
          })}
        />

        {connections.some((c) => c.status !== "connected") && (
          <Card className="border-bad-500/30 bg-bad-500/[0.04]">
            <div className="text-[12.5px] font-medium text-bad-400">
              {connections.filter((c) => c.status !== "connected").length} connection(s) need attention — posts targeting them are deferred, not lost.
            </div>
          </Card>
        )}

        <div>
          <SectionTitle title="Connected accounts" hint="Tokens are stored server-side and never sent to the browser" />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {connections.map((c) => {
              const meta = channelMeta(c.channel);
              const adapter = adapterFor(c.channel);
              const expiring = c.tokenExpiresAt && new Date(c.tokenExpiresAt).getTime() - Date.now() < 14 * 864e5;
              return (
                <Card key={c.id} className="card-hover">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[13px] font-bold text-white" style={{ background: meta.color }}>
                      {meta.label[0]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-medium text-mist-100">{meta.label}</span>
                        <Badge tone={c.status === "connected" ? "good" : "bad"}>{c.status}</Badge>
                      </div>
                      <div className="truncate text-[11px] text-mist-400">{c.handle}</div>
                      {c.followers > 0 && <div className="tnum mt-0.5 text-[11px] text-mist-300">{fmt.full(c.followers)} followers</div>}
                    </div>
                  </div>

                  {c.lastError && <p className="mt-2 rounded-lg bg-bad-500/10 px-2 py-1.5 text-[11px] text-bad-400">{c.lastError}</p>}

                  <div className="mt-3 space-y-1 text-[10.5px] text-mist-400">
                    <div>ID <span className="text-mist-300">{c.externalId}</span></div>
                    <div className={expiring ? "text-warn-400" : ""}>
                      Token {c.tokenExpiresAt ? `expires ${new Date(c.tokenExpiresAt).toLocaleDateString()}` : "n/a"}
                    </div>
                    <div>Last synced {c.lastSyncedAt ? new Date(c.lastSyncedAt).toLocaleString() : "never"}</div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {c.scopes.slice(0, 4).map((s) => (
                      <span key={s} className="rounded bg-ink-800 px-1.5 py-0.5 text-[9.5px] text-mist-400">{s}</span>
                    ))}
                  </div>

                  {adapter && (
                    <div className="mt-3 border-t border-ink-800 pt-2.5 text-[10.5px] text-mist-400">
                      <div className="mb-1 font-medium text-mist-300">Publishing limits</div>
                      <div>Formats: {adapter.capabilities.formats.join(", ")}</div>
                      <div>Caption: {adapter.capabilities.captionLimit.toLocaleString()} chars · {adapter.capabilities.hashtagLimit} hashtags · {adapter.capabilities.maxMedia} media</div>
                      <div>
                        {adapter.capabilities.supportsNativeScheduling ? "Native scheduling" : "Queued by Orbit"}
                        {adapter.capabilities.supportsStories && " · stories"}
                        {adapter.capabilities.supportsFirstComment && " · first comment"}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>


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
