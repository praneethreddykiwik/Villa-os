import { pageContext } from "@/lib/page-context";
import { DEFAULT_EDIT, hasFfmpeg } from "@/lib/media/render";
import { TopBar } from "@/components/shell";
import { Studio } from "@/components/studio";
import { Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function StudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const media = db.media.filter((m) => m.brandId === brandId);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Video Studio"
        subtitle={`Edit once, render per network · ${brand.name}`}
        right={<Badge tone={hasFfmpeg() ? "good" : "warn"}>{hasFfmpeg() ? "ffmpeg ready" : "ffmpeg not found"}</Badge>}
      />
      <div className="p-7">
        <Studio brand={brand} media={media} defaultEdit={DEFAULT_EDIT} />
      </div>
    </>
  );
}
