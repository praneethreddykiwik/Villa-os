import Link from "next/link";
import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge } from "@/components/ui";
import { WhatsAppHealthCard } from "@/components/settings/whatsapp-health";
import { whatsappHealth } from "@/lib/platforms/whatsapp-health";
import { whatsappReadiness } from "@/lib/osf/whatsapp/readiness";
import { operatorText } from "@/lib/whitelabel";

export const dynamic = "force-dynamic";

/**
 * WhatsApp, as a tab of the villa profile.
 *
 * Two different questions, both of which used to live in different corners of
 * the app: "is the number healthy" (the health card, from /settings) and "can
 * we go live" (the readiness checks, from the nested System group). They are
 * the same conversation, so they are on the same screen.
 */
export default async function VillaWhatsAppSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const [health, readiness] = await Promise.all([whatsappHealth(), whatsappReadiness()]);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Villa profile" subtitle={`${brand.name} · WhatsApp`} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <Card>
          <SectionTitle
            title="Go-live checks"
            hint={
              readiness.ready
                ? "Everything needed to send and receive is in place"
                : `${readiness.blockingCount} thing${readiness.blockingCount === 1 ? "" : "s"} still blocking go-live`
            }
          />
          <ul>
            {readiness.checks.map((c) => (
              <li
                key={c.label}
                className="flex items-start justify-between gap-4 border-b border-ink-700 py-3 last:border-0"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-[12.5px] font-medium text-mist-100">{c.label}</span>
                    {c.blocking && c.state !== "ok" && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-red-400">
                        blocks go-live
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-[11.5px] leading-relaxed text-mist-400">{operatorText(c.detail)}</p>
                  {c.fix && c.state !== "ok" && (
                    <p className="mt-1 text-[11.5px] text-[var(--color-gold-300)]">→ {operatorText(c.fix)}</p>
                  )}
                </div>
                <Badge tone={c.state === "ok" ? "good" : c.state === "error" ? "bad" : "warn"}>
                  {c.state === "ok" ? "Ready" : c.state === "error" ? "Error" : "Not set"}
                </Badge>
              </li>
            ))}
          </ul>
        </Card>

        <WhatsAppHealthCard h={health} />

        <Card>
          <SectionTitle title="The assistant's knowledge" hint="What it knows about the villas when it answers" />
          <p className="text-[12px] text-mist-400">
            Prices, plot sizes, amenities and FAQs come from the property records — the same ones the voice agent
            reads — so they are edited once and both agents follow.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link href="/inbox/whatsapp/training" className="btn-ghost !py-2 text-xs">
              Train the assistant
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
