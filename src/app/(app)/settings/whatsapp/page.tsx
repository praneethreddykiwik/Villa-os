import Link from "next/link";
import { Suspense } from "react";
import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { CardSkeleton } from "@/components/skeletons";
import { KnowledgeEditor } from "@/components/knowledge-editor";
import { whatsappClientStatus } from "@/lib/osf/whatsapp/client-status";

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
        {/* Restored after the go-live checklist was removed, but rewritten:
            the panel that used to sit here was the operator's readiness list,
            which named the vendors and printed raw API errors. This reads the
            same checks and uses none of their words. */}
        <Suspense fallback={<CardSkeleton rows={4} />}>
          <StatusSection />
        </Suspense>

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

/**
 * Four rows, each answering a question an owner would actually ask. Streamed,
 * because confirming the number is reachable is an outbound call and the rest
 * of the page should not wait on it.
 */
async function StatusSection() {
  const status = await whatsappClientStatus();
  if (!status) return null;

  return (
    <Card>
      <SectionTitle
        title="WhatsApp status"
        hint={status.allReady ? "Everything needed to answer buyers is in place" : "Some things still need setting up"}
      />
      <ul>
        {status.rows.map((row) => (
          <li
            key={row.label}
            className="flex items-start justify-between gap-4 border-b border-ink-700 py-3 last:border-0"
          >
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-mist-100">{row.label}</div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-mist-400">{row.detail}</p>
            </div>
            <Badge tone={row.ready ? "good" : "warn"}>{row.ready ? "Ready" : "Not yet"}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}
