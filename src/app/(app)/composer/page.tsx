import { pageContext } from "@/lib/page-context";
import { adapterFor } from "@/lib/platforms/registry";
import { suggestSlots } from "@/lib/engine/besttime";
import { TopBar } from "@/components/shell";
import { Composer } from "@/components/composer";

export const dynamic = "force-dynamic";

export default async function ComposerPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  // Capabilities are serialised from the adapters so the client validates with
  // exactly the same limits the server will enforce at publish time.
  const connections = db.connections
    .filter((c) => c.brandId === brandId && adapterFor(c.channel))
    .map((c) => {
      const a = adapterFor(c.channel)!;
      return {
        ...c,
        accessToken: undefined,
        label: a.label,
        color: a.color,
        capabilities: {
          formats: a.capabilities.formats,
          captionLimit: a.capabilities.captionLimit,
          hashtagLimit: a.capabilities.hashtagLimit,
          supportsFirstComment: a.capabilities.supportsFirstComment,
          supportsStories: a.capabilities.supportsStories,
        },
      };
    });

  const media = db.media.filter((m) => m.brandId === brandId);
  const slots = suggestSlots(db, brandId, { count: 4 }).map((s) => ({ isoTime: s.isoTime, reason: s.reason }));

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Composer" subtitle={`Write once, publish everywhere · ${brand.name}`} />
      <div className="p-7">
        <Composer brand={brand} connections={connections} media={media} slots={slots} />
      </div>
    </>
  );
}
