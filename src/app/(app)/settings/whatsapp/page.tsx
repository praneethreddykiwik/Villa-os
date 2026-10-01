import Link from "next/link";
import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle } from "@/components/ui";
import { KnowledgeEditor } from "@/components/knowledge-editor";

export const dynamic = "force-dynamic";

/**
 * WhatsApp, as a tab of Settings: what the assistant knows.
 *
 * This screen used to open with two panels of connection diagnostics — a
 * go-live checklist and a number health card — rendered with no permission
 * check at all. Between them they named the messaging vendor, the AI vendor
 * and the hosting arrangement, printed raw API error bodies with their HTTP
 * status codes, and told the reader which environment variables were unset.
 * All of it was visible to every signed-in person.
 *
 * None of it was a decision this business makes. Whether a credential is set
 * is the administrator's problem and is answered elsewhere; what the assistant
 * says to a customer is the client's problem, and that is the whole of this
 * tab now.
 */
export default async function WhatsAppSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Settings" subtitle={`${brand.name} · WhatsApp`} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <KnowledgeEditor brandId={brandId} />

        <Card>
          <SectionTitle title="Prices and plans" hint="Where the rest of the assistant's answers come from" />
          <p className="text-[12px] text-mist-400">
            Prices, plot sizes, amenities and possession dates are read from the property records, so they are
            edited once under Properties and both the chat and the voice agent follow.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/settings/properties" className="btn-ghost !py-2 text-xs">
              Edit properties
            </Link>
            <Link href="/inbox/whatsapp/simulator" className="btn-ghost !py-2 text-xs">
              Test a conversation
            </Link>
          </div>
        </Card>
      </div>
    </>
  );
}
