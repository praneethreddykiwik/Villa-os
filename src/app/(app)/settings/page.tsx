import { pageContext } from "@/lib/page-context";
import { getSession, hasPermission } from "@/lib/auth/session";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { BOUNDS, loadSettings } from "@/lib/villa/settings";
import { VillaSettingsForm } from "@/components/settings/villa-settings-form";

export const dynamic = "force-dynamic";

/**
 * SETTINGS — how this business behaves, in one place.
 *
 * This screen and "Villa profile" used to be two sidebar entries for one
 * subject: the brand's own details sat here, the hours its agents work sat
 * there, and nobody could say which to open. They are tabs of one screen now,
 * and this is the general tab.
 *
 * What is NOT here is as deliberate as what is. The previous version opened
 * with a panel of install diagnostics — whether a media encoder was present,
 * whether a worker secret was set, which model provider was active. None of
 * that is a decision this business makes, and all of it names the machinery
 * behind the product to the people it is sold to.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const canEdit = hasPermission(await getSession(), "workflows.manage");
  const settings = await loadSettings(brandId);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Settings" subtitle={brand.name} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <Card>
          <SectionTitle
            title="Calling policy"
            hint="Used by the voice agent every time it dials — changes apply within 30 seconds"
          />
          <VillaSettingsForm initial={settings} bounds={BOUNDS} canEdit={canEdit} />
        </Card>

        <Card>
          <SectionTitle
            title="Business profile"
            hint="Both agents speak from this — the more specific it is, the better they sound"
          />
          <dl className="space-y-3 text-[12.5px]">
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-mist-400">Name</dt>
              <dd className="text-mist-100">{brand.name}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-mist-400">Industry</dt>
              <dd className="text-mist-100">{brand.industry}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-mist-400">Tone of voice</dt>
              <dd className="leading-relaxed text-mist-300">{brand.voice}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-mist-400">Who you sell to</dt>
              <dd className="text-mist-300">{brand.audience}</dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-mist-400">What you offer</dt>
              <dd className="mt-1 flex flex-wrap gap-1.5">
                {brand.offerings.map((o) => (
                  <Badge key={o} tone="neutral">
                    {o}
                  </Badge>
                ))}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] uppercase tracking-wider text-mist-400">Timezone</dt>
              <dd className="text-mist-300">{brand.timezone}</dd>
            </div>
          </dl>
        </Card>

        {/* Only worth a card when there is more than one — a list of one is a
            heading over the name already in the top bar. */}
        {db.brands.length > 1 && (
          <Card>
            <SectionTitle title="Brands" hint="Each one keeps its own leads, conversations and campaigns" />
            <div className="space-y-2">
              {db.brands.map((b) => (
                <div key={b.id} className="flex items-center gap-3 rounded-lg border border-ink-700 p-3">
                  <span className="h-7 w-7 rounded-lg" style={{ background: b.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-medium text-mist-100">{b.name}</div>
                    <div className="text-[11px] text-mist-400">{b.industry}</div>
                  </div>
                  {b.id === brandId && <Badge tone="brand">active</Badge>}
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
