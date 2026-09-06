import { Star } from "lucide-react";
import { pageContext } from "@/lib/page-context";
import { HNWI_LABELS, KYC_LABELS } from "@/lib/crm/types";
import { initials, inr, shortDate } from "@/lib/crm/format";
import { TopBar } from "@/components/shell";
import { Badge, Bar, Card, SectionTitle, Stat } from "@/components/ui";
import { CrmEmpty } from "../_empty";

export const dynamic = "force-dynamic";

const TXN_LABEL: Record<string, string> = {
  booking_token: "Booking token",
  agreement: "Agreement + stamp duty",
  installment: "Construction installment",
  registration: "Registration",
  final_payment: "Final payment",
};

/**
 * Customer profiles: the money view. For each buyer, the payment ladder of an
 * Indian residential sale — token, agreement, construction-linked installments,
 * registration — with what has been collected and what is overdue.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const customers = db.crmContacts
    .filter((c) => c.brandId === brandId && (c.type === "customer" || c.type === "investor"))
    .sort((a, b) => b.lifetimeValue - a.lifetimeValue);

  const allTxns = customers.flatMap((c) => c.transactions);
  const collected = allTxns.filter((t) => t.status === "paid").reduce((a, t) => a + t.amount, 0);
  const outstanding = allTxns.filter((t) => t.status === "pending").reduce((a, t) => a + t.amount, 0);
  const overdue = allTxns.filter((t) => t.status === "overdue");
  const overdueValue = overdue.reduce((a, t) => a + t.amount, 0);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Customers" subtitle={`${customers.length} buyers · ${brand.name}`} />
      <div className="space-y-5 p-7">
        {customers.length === 0 ? (
          <CrmEmpty brandName={brand.name} brandId={brandId} />
        ) : (
          <>
            <div className="grid gap-3 md:grid-cols-4">
              <Stat label="Collected" value={inr(collected)} sub={`${allTxns.filter((t) => t.status === "paid").length} payments`} />
              <Stat label="Scheduled" value={inr(outstanding)} sub="future milestones" />
              <Stat label="Overdue" value={inr(overdueValue)} sub={`${overdue.length} payment(s) past due`} />
              <Stat label="Avg. deal size" value={inr(customers.reduce((a, c) => a + c.transactions.reduce((s, t) => s + t.amount, 0), 0) / customers.length)} sub="total contract value" />
            </div>

            {overdue.length > 0 && (
              <Card className="border-bad-500/30 bg-bad-500/[0.04]">
                <SectionTitle title="Overdue payments" hint="Chase these before they compound into a registration delay" />
                <div className="space-y-1.5">
                  {overdue.map((t) => {
                    const owner = customers.find((c) => c.id === t.contactId);
                    return (
                      <div key={t.id} className="flex flex-wrap items-center gap-3 text-[12px]">
                        <span className="font-medium text-mist-100">{owner?.name}</span>
                        <span className="text-mist-400">{t.project} · {t.unit}</span>
                        <Badge tone="bad">{TXN_LABEL[t.type]}</Badge>
                        <span className="tnum ml-auto font-semibold text-bad-400">{inr(t.amount)}</span>
                        <span className="tnum text-mist-400">due {shortDate(t.date)}</span>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            <div className="space-y-4">
              {customers.map((c) => {
                const total = c.transactions.reduce((a, t) => a + t.amount, 0);
                const paid = c.transactions.filter((t) => t.status === "paid").reduce((a, t) => a + t.amount, 0);
                return (
                  <Card key={c.id}>
                    <div className="flex flex-wrap items-start gap-3">
                      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-ink-700 text-[12px] font-semibold text-mist-200">
                        {initials(c.name)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="text-[14px] font-semibold text-mist-100">{c.name}</h3>
                          {(c.hnwiTier === "hnwi" || c.hnwiTier === "uhnwi") && <Star size={11} className="fill-warn-400 text-warn-400" />}
                          <Badge tone={c.hnwiTier === "uhnwi" ? "brand" : "neutral"}>{HNWI_LABELS[c.hnwiTier]}</Badge>
                          <Badge tone={c.kycStatus === "verified" ? "good" : "warn"}>KYC {KYC_LABELS[c.kycStatus]}</Badge>
                          {c.type === "investor" && <Badge tone="neutral">investor</Badge>}
                        </div>
                        <p className="mt-0.5 text-[11.5px] text-mist-400">
                          {c.occupation}{c.company ? ` · ${c.company}` : ""} · {c.city} · RM {c.relationshipManager}
                        </p>
                      </div>
                      <div className="text-right">
                        <div className="tnum text-[16px] font-semibold text-mist-100">{inr(paid)}</div>
                        <div className="text-[10.5px] text-mist-400">of {inr(total)} contract value</div>
                      </div>
                    </div>

                    <div className="mt-3">
                      <Bar value={paid} max={total} color="var(--color-good-500)" />
                    </div>

                    <div className="overflow-x-auto">
                    <table className="mt-3 w-full text-[11.5px] min-w-[500px]">
                      <thead>
                        <tr className="border-b border-ink-700 text-left text-[9.5px] uppercase tracking-wider text-mist-400">
                          <th className="py-1.5 font-medium">Milestone</th>
                          <th className="py-1.5 font-medium">Unit</th>
                          <th className="py-1.5 font-medium">Mode</th>
                          <th className="py-1.5 font-medium">Reference</th>
                          <th className="py-1.5 text-right font-medium">Amount</th>
                          <th className="py-1.5 text-right font-medium">Date</th>
                          <th className="py-1.5 text-right font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.transactions.map((t) => (
                          <tr key={t.id} className="border-b border-ink-700/50 last:border-0">
                            <td className="py-1.5 text-mist-200">{TXN_LABEL[t.type]}</td>
                            <td className="py-1.5 text-mist-400">{t.unit}</td>
                            <td className="py-1.5 uppercase text-mist-400">{t.mode.replace("_", " ")}</td>
                            <td className="py-1.5 font-mono text-[10.5px] text-mist-500">{t.reference}</td>
                            <td className="tnum py-1.5 text-right text-mist-200">{inr(t.amount)}</td>
                            <td className="tnum py-1.5 text-right text-mist-400">{shortDate(t.date)}</td>
                            <td className="py-1.5 text-right">
                              <Badge tone={t.status === "paid" ? "good" : t.status === "overdue" ? "bad" : "neutral"}>{t.status}</Badge>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
