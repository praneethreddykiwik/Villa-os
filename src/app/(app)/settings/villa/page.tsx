import { pageContext } from "@/lib/page-context";
import { getSession, hasPermission } from "@/lib/auth/session";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle } from "@/components/ui";
import { BOUNDS, loadSettings } from "@/lib/villa/settings";
import { VillaSettingsForm } from "@/components/settings/villa-settings-form";

export const dynamic = "force-dynamic";

/**
 * VILLA PROFILE — the operational settings behind the business.
 *
 * Readable by anyone who works the queue, because knowing when calls go out is
 * part of using it. Editable only with `workflows.manage`: these numbers decide
 * when phones ring and how often somebody is called back.
 */
export default async function VillaSettingsPage({
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
      <TopBar brands={db.brands} brandId={brandId} title="Villa profile" subtitle={brand.name} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <Card>
          <SectionTitle
            title="Calling policy"
            hint="Used by the voice agent every time it dials — changes apply within 30 seconds, without a deploy"
          />
          <VillaSettingsForm initial={settings} bounds={BOUNDS} canEdit={canEdit} />
        </Card>
      </div>
    </>
  );
}
