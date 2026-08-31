import { pageContext } from "@/lib/page-context";
import { channelMeta } from "@/lib/platforms/registry";
import { CHANNEL_ORDER } from "@/lib/platforms/registry";
import { TopBar } from "@/components/shell";
import { Stat } from "@/components/ui";
import { Inbox } from "@/components/inbox";

export const dynamic = "force-dynamic";

export default async function EngagementPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const items = db.conversations
    .filter((c) => c.brandId === brandId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const open = items.filter((c) => c.status === "open");
  const leads = items.filter((c) => c.isLead);
  const whatsapp = items.filter((c) => c.channel === "whatsapp");

  const meta = Object.fromEntries(CHANNEL_ORDER.map((c) => [c, channelMeta(c)]));

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="Engagement"
        subtitle={`${open.length} open · ${leads.length} look like leads · ${brand.name}`}
      />

      <div className="space-y-6 p-7">
        <div className="grid gap-3 md:grid-cols-4">
          <Stat label="Open" value={String(open.length)} sub="awaiting a reply" />
          <Stat label="Leads detected" value={String(leads.length)} sub="asking about price or availability" />
          <Stat label="WhatsApp" value={String(whatsapp.length)} sub="conversations this week" />
          <Stat label="Negative" value={String(items.filter((c) => c.sentiment === "negative").length)} sub="handle these first" />
        </div>

        <Inbox conversations={items} brandId={brandId} channelMeta={meta} />
      </div>
    </>
  );
}
