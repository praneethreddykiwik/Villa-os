import Link from "next/link";
import { redirect } from "next/navigation";
import { read } from "@/lib/db";
import { sessionFromCookies } from "@/lib/ops/auth";
import { defaultChecklist, loanWorkspace } from "@/lib/ops/loan";
import { Badge, Bar, Card, SectionTitle, Stat } from "@/components/ui";
import { DefaultChecklistEditor } from "@/components/ops/default-checklist-editor";

export const dynamic = "force-dynamic";

export default async function LoanWorkspacePage() {
  const session = await sessionFromCookies();
  if (!session) redirect("/ops");
  if (!["ADMIN", "LOAN_OFFICER"].includes(session.role)) redirect("/ops");

  const officerId = session.role === "ADMIN" ? undefined : session.memberId;
  const ws = loanWorkspace(session.orgId, officerId);
  const db = read();
  const name = (id?: string) => db.teamMembers.find((m) => m.id === id)?.name ?? "Unassigned";
  const defaults = defaultChecklist(session.orgId).items;

  return (
    <div className="space-y-6 p-7">
      <div>
        <h1 className="text-[19px] font-semibold tracking-tight">Loan department</h1>
        <p className="text-[12px] text-mist-400">
          {session.role === "ADMIN" ? "All officers" : session.name} · {ws.active.length} active cases
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Active" value={String(ws.active.length)} />
        <Stat label="New" value={String(ws.newCases.length)} sub="no checklist yet" />
        <Stat label="Waiting on customer" value={String(ws.waitingForCustomer.length)} />
        <Stat label="Awaiting review" value={String(ws.awaitingReview.length)} sub="your action" />
        <Stat label="Ready for analysis" value={String(ws.readyForAnalysis.length)} />
        <Stat label="Overdue" value={String(ws.overdue.length)} sub="past review SLA" />
      </div>

      <DefaultChecklistEditor items={defaults} />

      <div>
        <SectionTitle title="Cases" hint="Sorted by what needs a decision first" />
        <div className="space-y-3">
          {[...ws.active]
            .sort((a, b) => (b.progress.awaitingReview.length - a.progress.awaitingReview.length) || (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0))
            .map(({ loanCase, customer, progress, lastFollowUp, nextFollowUp, overdue, checklist }) => (
              <Card key={loanCase.id} className={overdue ? "border-bad-500/35" : undefined}>
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`/ops/loans/${loanCase.id}`} className="text-[13.5px] font-semibold text-mist-100 hover:underline">
                    {customer?.name ?? "Unknown"}
                  </Link>
                  <Badge tone={loanCase.status === "READY_FOR_ANALYSIS" ? "good" : loanCase.status === "DOCUMENTS_INCOMPLETE" ? "bad" : "neutral"}>
                    {loanCase.status.replace(/_/g, " ")}
                  </Badge>
                  {progress.awaitingReview.length > 0 && <Badge tone="warn">{progress.awaitingReview.length} to review</Badge>}
                  {overdue && <Badge tone="bad">overdue</Badge>}
                  {customer && (
                    <Badge tone={customer.loanControl === "HUMAN_CONTROL" ? "warn" : "good"}>
                      {customer.loanControl === "HUMAN_CONTROL" ? "HUMAN CONTROL" : "AI ACTIVE"}
                    </Badge>
                  )}
                  <span className="ml-auto text-[11px] text-mist-400">{name(loanCase.assignedOfficerId)}</span>
                </div>

                <div className="mt-3 flex items-center gap-3">
                  <Bar value={progress.requiredAccepted} max={Math.max(1, progress.requiredTotal)} color="var(--color-good-500)" />
                  <span className="tnum shrink-0 text-[12px] font-semibold text-mist-100">{progress.completionPct}%</span>
                  <span className="shrink-0 text-[11px] text-mist-400">
                    {progress.requiredAccepted}/{progress.requiredTotal} required accepted
                    {progress.awaitingReview.length > 0 ? ` · ${progress.awaitingReview.length} received` : ""}
                  </span>
                </div>

                {checklist && checklist.length > 0 && (
                  <div className="mt-3.5 space-y-1.5 border-t border-ink-800/60 pt-3">
                    <div className="text-[11px] font-medium text-mist-400">Document Checklist (5-Point Villa Loan Verification):</div>
                    <div className="flex flex-wrap gap-1.5">
                      {checklist.filter((c) => c.required).map((item) => {
                        const isAccepted = item.status === "ACCEPTED";
                        const isUploaded = item.status === "UPLOADED" || item.status === "UNDER_REVIEW";
                        const isRejected = item.status === "REJECTED";
                        return (
                          <span
                            key={item.id}
                            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px] font-medium ${
                              isAccepted
                                ? "bg-good-500/15 text-good-400 border border-good-500/30"
                                : isUploaded
                                  ? "bg-warn-500/15 text-warn-400 border border-warn-500/30"
                                  : isRejected
                                    ? "bg-bad-500/15 text-bad-400 border border-bad-500/30"
                                    : "bg-ink-800 text-mist-400 border border-ink-700"
                            }`}
                          >
                            <span>{item.customerLabel}</span>
                            <span className="opacity-75">({item.status.replace(/_/g, " ").toLowerCase()})</span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                {loanCase.status === "READY_FOR_ANALYSIS" && (
                  <div className="mt-3 flex items-center justify-between rounded-lg border border-good-500/30 bg-good-500/10 px-3 py-2 text-[11.5px]">
                    <span className="font-medium text-good-400">
                      ✓ All required documents received — file ready for bank submission (HDFC / SBI / ICICI)
                    </span>
                    <Link
                      href={`/ops/loans/${loanCase.id}`}
                      className="rounded bg-good-500/20 px-2.5 py-1 text-[11px] font-semibold text-good-300 hover:bg-good-500/30 transition-colors"
                    >
                      Process Loan File →
                    </Link>
                  </div>
                )}

                <div className="mt-3 grid gap-3 text-[11.5px] md:grid-cols-4">
                  <div>
                    <div className="text-mist-400">Missing</div>
                    <div className="text-mist-200">{progress.missing.map((i) => i.customerLabel).join(", ") || "—"}</div>
                  </div>
                  <div>
                    <div className="text-mist-400">Rejected</div>
                    <div className="text-bad-400">{progress.rejected.map((i) => i.customerLabel).join(", ") || "—"}</div>
                  </div>
                  <div>
                    <div className="text-mist-400">Last AI follow-up</div>
                    <div className="text-mist-200">{lastFollowUp?.lastSentAt ? new Date(lastFollowUp.lastSentAt).toLocaleString() : "—"}</div>
                  </div>
                  <div>
                    <div className="text-mist-400">Next follow-up</div>
                    <div className="text-mist-200">{nextFollowUp ? new Date(nextFollowUp.scheduledAt).toLocaleString() : "—"}</div>
                  </div>
                </div>
              </Card>
            ))}
          {!ws.active.length && (
            <Card><p className="py-6 text-center text-[12.5px] text-mist-400">No active cases. A case opens when sales marks financing required.</p></Card>
          )}
        </div>
      </div>
    </div>
  );
}
