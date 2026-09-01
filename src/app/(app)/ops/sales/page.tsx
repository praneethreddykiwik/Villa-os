import Link from "next/link";
import { redirect } from "next/navigation";
import { read } from "@/lib/db";
import { sessionFromCookies } from "@/lib/ops/auth";
import { salesWorkspace } from "@/lib/ops/sales";
import { getConfig } from "@/lib/ops/config";
import { Badge, Card, SectionTitle, Stat } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Sales workspace. Ordered by what needs attention now, not by raw data: the
 * overdue and urgent work is above the fold, the full lead list below it.
 */
export default async function SalesWorkspacePage() {
  const session = await sessionFromCookies();
  if (!session) redirect("/ops");
  if (!["ADMIN", "SALES_MANAGER"].includes(session.role)) redirect("/ops");

  const memberId = session.role === "ADMIN" ? undefined : session.memberId;
  const ws = salesWorkspace(session.orgId, memberId);
  const db = read();
  const cfg = getConfig(session.orgId);
  const name = (id?: string) => db.teamMembers.find((m) => m.id === id)?.name ?? "Unassigned";

  return (
    <div className="space-y-6 p-7">
      <div>
        <h1 className="text-[19px] font-semibold tracking-tight">Sales workspace</h1>
        <p className="text-[12px] text-mist-400">
          {session.role === "ADMIN" ? "All managers" : session.name} · {ws.myLeads.length} leads
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="My leads" value={String(ws.myLeads.length)} />
        <Stat label="New" value={String(ws.newLeads.length)} sub="not yet worked" />
        <Stat label="Hot" value={String(ws.hotLeads.length)} sub={`score > ${cfg.scoring.bands.warm}`} />
        <Stat label="Calls pending" value={String(ws.callsPending.length)} />
        <Stat label="Overdue" value={String(ws.overdueTasks.length)} sub="past SLA" />
        <Stat label="Financing" value={String(ws.loanRequired.length)} sub="loan required" />
      </div>

      {ws.callsPending.length > 0 && (
        <div>
          <SectionTitle title="Calls to make" hint="Each carries an AI briefing — you should not need the transcript first" />
          <div className="space-y-2.5">
            {[...ws.callsPending]
              .sort((a, b) => a.dueAt.localeCompare(b.dueAt))
              .map((t) => {
                const customer = db.customers.find((c) => c.id === t.customerId);
                const overdue = new Date(t.dueAt).getTime() < Date.now();
                return (
                  <Card key={t.id} className={overdue ? "border-bad-500/35" : undefined}>
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={`/ops/customers/${t.customerId}`} className="text-[13.5px] font-semibold text-mist-100 hover:underline">
                        {customer?.name ?? "Unknown"}
                      </Link>
                      <Badge tone={t.priority === "URGENT" ? "bad" : t.priority === "HIGH" ? "warn" : "neutral"}>{t.priority}</Badge>
                      <Badge tone="neutral">score {t.leadScore}</Badge>
                      <Badge tone={["NEGATIVE", "VERY_NEGATIVE"].includes(t.sentiment) ? "bad" : "neutral"}>{t.sentiment}</Badge>
                      {overdue && <Badge tone="bad">overdue</Badge>}
                      <span className="ml-auto text-[11px] text-mist-400">
                        {name(t.assignedToId)} · due {new Date(t.dueAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[12px] text-mist-300">{t.reason}</p>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-850 p-3 text-[11.5px] leading-relaxed text-mist-300">
{t.aiSummary}
                    </pre>
                  </Card>
                );
              })}
          </div>
        </div>
      )}

      <div>
        <SectionTitle title="My leads" hint="Ordered by lead score" />
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[900px] text-[12px]">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[10px] uppercase tracking-wider text-mist-400">
                <th className="px-4 py-2.5 font-medium">Customer</th>
                <th className="px-3 py-2.5 font-medium">Stage</th>
                <th className="px-3 py-2.5 font-medium">Intent</th>
                <th className="px-3 py-2.5 font-medium">Sentiment</th>
                <th className="px-3 py-2.5 font-medium">Financing</th>
                <th className="px-3 py-2.5 font-medium">Control</th>
                <th className="px-3 py-2.5 font-medium">Owner</th>
                <th className="px-4 py-2.5 text-right font-medium">Score</th>
              </tr>
            </thead>
            <tbody>
              {[...ws.myLeads].sort((a, b) => b.leadScore - a.leadScore).map((c) => (
                <tr key={c.id} className="border-b border-ink-700/60 last:border-0 hover:bg-ink-850/50">
                  <td className="px-4 py-2.5">
                    <Link href={`/ops/customers/${c.id}`} className="font-medium text-mist-100 hover:underline">{c.name}</Link>
                    <div className="text-[10.5px] text-mist-400">{c.phone}</div>
                  </td>
                  <td className="px-3 py-2.5"><Badge tone="neutral">{c.leadStage.replace(/_/g, " ")}</Badge></td>
                  <td className="px-3 py-2.5 text-mist-300">{c.intent.replace(/_/g, " ")}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={["NEGATIVE", "VERY_NEGATIVE"].includes(c.sentiment) ? "bad" : ["POSITIVE", "VERY_POSITIVE"].includes(c.sentiment) ? "good" : "neutral"}>
                      {c.sentiment.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-mist-300">{c.loanRequired}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={c.salesControl === "HUMAN_CONTROL" ? "warn" : "good"}>
                      {c.salesControl === "HUMAN_CONTROL" ? "HUMAN" : "AI"}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-mist-400">{name(c.assignedSalesManagerId)}</td>
                  <td className="px-4 py-2.5 text-right"><span className="tnum font-semibold">{c.leadScore}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!ws.myLeads.length && (
            <p className="px-4 py-10 text-center text-[12.5px] text-mist-400">
              No leads yet. Customers appear here when they message the WhatsApp number.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
