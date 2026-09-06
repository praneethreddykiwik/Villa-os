import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2 } from "lucide-react";
import { read } from "@/lib/db";
import { canAccessCustomer, sessionFromCookies } from "@/lib/ops/auth";
import { getConfig } from "@/lib/ops/config";
import { caseProgress, checklistFor, getCase } from "@/lib/ops/loan";
import { documentsFor } from "@/lib/ops/documents";
import { Badge, Bar, Card, SectionTitle, Stat } from "@/components/ui";
import { ChecklistEditor } from "@/components/ops/checklist-editor";
import { CaseControls } from "@/components/ops/case-controls";

export const dynamic = "force-dynamic";

/** The loan officer's working surface for one case. */
export default async function LoanCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const session = await sessionFromCookies();
  if (!session) redirect("/ops");
  if (!["ADMIN", "LOAN_OFFICER"].includes(session.role)) redirect("/ops");

  const loanCase = getCase(caseId);
  if (!loanCase || loanCase.orgId !== session.orgId) notFound();
  if (!(await canAccessCustomer(session, loanCase.customerId))) redirect("/ops/loans");

  const db = read();
  const customer = db.customers.find((c) => c.id === loanCase.customerId);
  const items = checklistFor(caseId);
  const progress = caseProgress(caseId);
  const documents = documentsFor(loanCase.customerId);
  const cfg = getConfig(session.orgId);
  const followUps = db.followUps.filter((f) => f.loanCaseId === caseId);
  const nextFollowUp = followUps
    .filter((f) => f.status === "SCHEDULED")
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0];
  const officers = db.teamMembers.filter((m) => m.orgId === session.orgId && m.role === "LOAN_OFFICER" && m.active);

  return (
    <div className="space-y-5 p-7">
      <Link href="/ops/loans" className="inline-flex items-center gap-1.5 text-[12px] text-mist-400 hover:text-mist-100">
        <ArrowLeft size={13} /> All cases
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-[19px] font-semibold tracking-tight">{customer?.name ?? "Unknown customer"}</h1>
          <p className="text-[12px] text-mist-400">
            {customer?.phone} · {loanCase.loanType}
            {loanCase.requestedAmount ? ` · requested ${loanCase.requestedAmount.toLocaleString()}` : ""} · opened{" "}
            {new Date(loanCase.createdAt).toLocaleDateString()}
          </p>
        </div>
        <Badge tone={loanCase.status === "READY_FOR_ANALYSIS" ? "good" : loanCase.status === "DOCUMENTS_INCOMPLETE" ? "bad" : "neutral"}>
          {loanCase.status.replace(/_/g, " ")}
        </Badge>
        {customer && (
          <Badge tone={customer.loanControl === "HUMAN_CONTROL" ? "warn" : "good"}>
            {customer.loanControl === "HUMAN_CONTROL" ? "HUMAN CONTROL" : "AI ACTIVE"}
          </Badge>
        )}
        <Link href={`/ops/customers/${loanCase.customerId}`} className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600">
          Customer 360
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Completion" value={`${progress.completionPct}%`} sub={`${progress.requiredAccepted}/${progress.requiredTotal} required`} />
        <Stat label="Awaiting review" value={String(progress.awaitingReview.length)} sub="your action" />
        <Stat label="Missing" value={String(progress.missing.length)} sub="with the customer" />
        <Stat label="Rejected" value={String(progress.rejected.length)} sub="replacements needed" />
        <Stat label="Documents" value={String(documents.length)} sub="received all-time" />
        <Stat
          label="Next follow-up"
          value={nextFollowUp ? new Date(nextFollowUp.scheduledAt).toLocaleDateString() : "—"}
          sub={nextFollowUp ? new Date(nextFollowUp.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "none scheduled"}
        />
      </div>

      {loanCase.status === "READY_FOR_ANALYSIS" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-good-500/40 bg-good-500/10 px-4 py-3">
          <CheckCircle2 size={16} className="text-good-400" />
          <div className="flex-1 text-[12.5px] text-mist-100">
            <span className="font-semibold">Ready for analysis.</span>{" "}
            {progress.awaitingReview.length > 0
              ? `Every required document is in — ${progress.awaitingReview.length} still need your accept/reject decision.`
              : "Every required document has been accepted. The customer has been told the loan officer will call."}
            {loanCase.readyForReviewAt ? ` Since ${new Date(loanCase.readyForReviewAt).toLocaleString()}.` : ""}
          </div>
        </div>
      )}

      <Card>
        <div className="flex items-center gap-3">
          <Bar value={progress.requiredAccepted} max={Math.max(1, progress.requiredTotal)} color="var(--color-good-500)" />
          <span className="tnum shrink-0 text-[14px] font-semibold">{progress.completionPct}%</span>
        </div>
        <p className="mt-2 text-[11.5px] text-mist-400">
          Completion counts accepted <em>required</em> items only. Once every required document is received the case moves to
          READY_FOR_ANALYSIS and you are notified — the assistant tells the customer everything was received, and says nothing about approval.
        </p>
      </Card>

      <CaseControls
        loanCaseId={caseId}
        customerId={loanCase.customerId}
        status={loanCase.status}
        officers={officers.map((o) => ({ id: o.id, name: o.name }))}
        assignedOfficerId={loanCase.assignedOfficerId}
        loanControl={customer?.loanControl ?? "AI_ACTIVE"}
      />

      <ChecklistEditor
        loanCaseId={caseId}
        items={items}
        documents={documents.map((d) => ({
          id: d.id,
          checklistItemId: d.checklistItemId,
          filename: d.filename,
          sizeBytes: d.sizeBytes,
          status: d.status,
          createdAt: d.createdAt,
          rejectionReason: d.rejectionReason,
        }))}
        templates={cfg.checklistTemplates.map((t) => ({ id: t.id, name: t.name, count: t.items.length }))}
      />

      {loanCase.officerNotes.length > 0 && (
        <Card>
          <SectionTitle title="Case notes" />
          <ul className="space-y-1 text-[12px] text-mist-300">
            {loanCase.officerNotes.map((n, i) => (
              <li key={i}>· {n}</li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <SectionTitle title="Follow-up activity" hint="What the assistant has done and what it will do next" />
        <div className="space-y-1.5">
          {followUps.map((f) => (
            <div key={f.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
              <Badge tone={f.status === "ESCALATED" ? "bad" : f.status === "SCHEDULED" ? "brand" : "neutral"}>{f.status}</Badge>
              <span className="text-mist-200">{f.kind.replace(/_/g, " ").toLowerCase()}</span>
              <span className="text-mist-400">{f.reason}</span>
              <span className="tnum ml-auto text-[10.5px] text-mist-400">
                {f.attempts}/{f.maxAttempts} attempts · next {new Date(f.scheduledAt).toLocaleString()}
              </span>
            </div>
          ))}
          {!followUps.length && <p className="text-[12px] text-mist-400">No follow-ups scheduled yet.</p>}
        </div>
      </Card>
    </div>
  );
}
