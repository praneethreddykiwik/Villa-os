import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const items = db.activity.filter((a) => a.brandId === brandId);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Activity" subtitle={`Everything the system and the team did · ${brand.name}`} />
      <div className="p-7">
        <Card>
          <SectionTitle title="Audit log" hint="Automated actions are labelled so nothing the AI did is ambiguous" />
          <div className="space-y-0">
            {items.map((a, i) => (
              <div key={a.id} className="flex gap-3 border-b border-ink-800/60 py-2.5 last:border-0">
                <span className="tnum w-32 shrink-0 text-[11px] text-mist-400">
                  {new Date(a.at).toLocaleString("en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
                <Badge tone={a.actor === "ai" ? "brand" : a.actor === "system" ? "neutral" : "good"}>{a.actor}</Badge>
                <span className="text-[12.5px] text-mist-200">{a.message}</span>
                <span className="ml-auto text-[10.5px] text-mist-500">{a.kind}</span>
              </div>
            ))}
            {!items.length && <p className="py-6 text-center text-[12px] text-mist-400">Nothing logged yet.</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
