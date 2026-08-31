import Link from "next/link";
import { Star } from "lucide-react";
import { pageContext, qs } from "@/lib/page-context";
import { HNWI_LABELS, KYC_LABELS } from "@/lib/crm/types";
import { initials, inr, shortDate } from "@/lib/crm/format";
import { TopBar } from "@/components/shell";
import { Badge, Card, SectionTitle, Stat } from "@/components/ui";
import { CrmEmpty } from "../_empty";

export const dynamic = "force-dynamic";

/**
 * Contacts are people, not enquiries. One buyer can own three units across four
 * years; their KYC, net-worth band and relationship history belong here rather
 * than being re-entered on every new lead.
 */
export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const link = qs(sp);
  const contacts = db.crmContacts
    .filter((c) => c.brandId === brandId)
    .sort((a, b) => b.lifetimeValue - a.lifetimeValue);

  const hnwi = contacts.filter((c) => c.hnwiTier === "hnwi" || c.hnwiTier === "uhnwi");
  const kycPending = contacts.filter((c) => c.kycStatus !== "verified");

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Contacts" subtitle={`${contacts.length} people · ${brand.name}`} />
      <div className="space-y-5 p-7">
        {contacts.length === 0 ? (
          <CrmEmpty brandName={brand.name} brandId={brandId} />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Contacts" value={String(contacts.length)} sub={`${contacts.filter((c) => c.type === "customer").length} customers`} />
              <Stat label="HNWI / UHNWI" value={String(hnwi.length)} sub="net worth ₹50 Cr+" />
              <Stat label="KYC incomplete" value={String(kycPending.length)} sub="blocks payment & registration" />
              <Stat label="Lifetime value" value={inr(contacts.reduce((a, c) => a + c.lifetimeValue, 0))} sub="collected to date" />
            </div>

            <Card className="overflow-x-auto p-0">
              <SectionTitle title="" />
              <table className="w-full min-w-[900px] text-[12px]">
                <thead>
                  <tr className="border-b border-ink-700 text-left text-[10px] uppercase tracking-wider text-mist-400">
                    <th className="px-4 py-2.5 font-medium">Contact</th>
                    <th className="px-3 py-2.5 font-medium">Tier</th>
                    <th className="px-3 py-2.5 font-medium">Occupation</th>
                    <th className="px-3 py-2.5 font-medium">KYC</th>
                    <th className="px-3 py-2.5 font-medium">Documents on file</th>
                    <th className="px-3 py-2.5 font-medium">RM</th>
                    <th className="px-3 py-2.5 text-right font-medium">Lifetime value</th>
                    <th className="px-4 py-2.5 text-right font-medium">Since</th>
                  </tr>
                </thead>
                <tbody>
                  {contacts.map((c) => (
                    <tr key={c.id} className="border-b border-ink-700/60 last:border-0 hover:bg-ink-850/50">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-ink-700 text-[10px] font-semibold text-mist-200">
                            {initials(c.name)}
                          </span>
                          <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                              <Link href={`/crm/customers${link}`} className="truncate font-medium text-mist-100 hover:underline">{c.name}</Link>
                              {(c.hnwiTier === "hnwi" || c.hnwiTier === "uhnwi") && <Star size={10} className="shrink-0 fill-warn-400 text-warn-400" />}
                            </span>
                            <span className="block text-[10.5px] text-mist-400">{c.phone} · {c.city} · {c.preferredLanguage}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={c.hnwiTier === "uhnwi" ? "brand" : c.hnwiTier === "hnwi" ? "good" : "neutral"}>
                          {HNWI_LABELS[c.hnwiTier]}
                        </Badge>
                        {c.netWorthBand && <div className="mt-0.5 text-[10px] text-mist-400">{c.netWorthBand}</div>}
                      </td>
                      <td className="px-3 py-2.5 text-mist-300">
                        {c.occupation}
                        {c.company && <div className="text-[10px] text-mist-400">{c.company}</div>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={c.kycStatus === "verified" ? "good" : c.kycStatus === "pending" ? "warn" : "neutral"}>
                          {KYC_LABELS[c.kycStatus]}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex flex-wrap gap-1">
                          {["PAN", "Aadhaar", "Address proof", "Bank statement"].map((doc) => (
                            <span
                              key={doc}
                              className={`rounded px-1.5 py-0.5 text-[9.5px] ${c.kycDocs.includes(doc) ? "bg-good-500/12 text-good-400" : "bg-ink-800 text-mist-500 line-through"}`}
                            >
                              {doc}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-mist-300">{c.relationshipManager}</td>
                      <td className="tnum px-3 py-2.5 text-right font-medium text-mist-200">{inr(c.lifetimeValue)}</td>
                      <td className="tnum px-4 py-2.5 text-right text-mist-400">{shortDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </>
  );
}
