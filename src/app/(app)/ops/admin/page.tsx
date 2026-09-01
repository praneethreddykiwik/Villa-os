import { redirect } from "next/navigation";
import { read } from "@/lib/db";
import { getSession, hasPermission } from "@/lib/auth/session";
import { workload } from "@/lib/ops/assignment";
import { getConfig } from "@/lib/ops/config";
import { caseProgress } from "@/lib/ops/loan";
import { LEAD_STAGES } from "@/lib/ops/types";
import { AdminTabs, type AdminData } from "@/components/ops/admin-tabs";

export const dynamic = "force-dynamic";

/** Human-readable stage names — the internal enum is not for an owner to read. */
const STAGE_LABEL: Record<string, string> = {
  NEW: "New enquiry",
  QUALIFYING: "Being qualified",
  QUALIFIED: "Qualified",
  SALES_CALL: "Sales call done",
  FINANCING_REQUIRED: "Needs financing",
  LOAN_CASE: "Loan opened",
  DOCUMENT_COLLECTION: "Collecting documents",
  DOCUMENT_REVIEW: "Documents under review",
  READY_FOR_ANALYSIS: "Ready for decision",
  DECISION: "Decision made",
  COMPLETED: "Completed",
};

export default async function AdminPage() {
  const session = await getSession();
  if (!session) redirect("/ops");
  if (!hasPermission(session, "analytics.view")) redirect("/ops");

  const db = read();
  const org = db.workspaces[0]?.id ?? "";
  const now = Date.now();
  const cfg = getConfig(org);

  const customers = db.customers.filter((c) => c.orgId === org);
  const tasks = db.salesTasks.filter((t) => t.orgId === org);
  const cases = db.loanCases.filter((l) => l.orgId === org);
  const docs = db.documents.filter((d) => d.orgId === org);
  const members = db.teamMembers.filter((m) => m.orgId === org && m.active);
  const audit = db.auditEvents.filter((a) => a.orgId === org);
  const nameOf = (id?: string) => members.find((m) => m.id === id)?.name ?? "Unassigned";
  const customerName = (id?: string) => customers.find((c) => c.id === id)?.name ?? "";

  const salesLoad = workload(org, "SALES");
  const loanLoad = workload(org, "LOAN");

  const data: AdminData = {
    totals: {
      Customers: customers.length,
      "New enquiries": customers.filter((c) => c.leadStage === "NEW").length,
      "Hot leads": customers.filter((c) => c.leadScore > cfg.scoring.bands.warm).length,
      "Calls pending": tasks.filter((t) => ["OPEN", "IN_PROGRESS"].includes(t.status)).length,
      "Loan cases": cases.filter((l) => !["COMPLETED", "REJECTED"].includes(l.status)).length,
      "Documents received": docs.length,
      "Documents rejected": docs.filter((d) => d.status === "REJECTED").length,
      "Ready for decision": cases.filter((l) => l.status === "READY_FOR_ANALYSIS").length,
    },

    pipeline: LEAD_STAGES.filter((s) => s !== "LOST").map((s) => ({
      stage: STAGE_LABEL[s] ?? s,
      count: customers.filter((c) => c.leadStage === s).length,
    })),

    sales: members
      .filter((m) => m.role === "SALES_MANAGER" || m.role === "ADMIN")
      .map((m) => {
        const mine = customers.filter((c) => c.assignedSalesManagerId === m.id);
        const myTasks = tasks.filter((t) => t.assignedToId === m.id);
        const done = myTasks.filter((t) => t.status === "COMPLETED" && t.completedAt);
        const times = done
          .map((t) => new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime())
          .sort((a, b) => a - b);
        const acts = audit.filter((a) => a.actorId === m.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          id: m.id,
          name: m.name,
          assigned: salesLoad.get(m.id) ?? 0,
          open: mine.filter((c) => !["COMPLETED", "LOST"].includes(c.leadStage)).length,
          callsPending: myTasks.filter((t) => ["OPEN", "IN_PROGRESS"].includes(t.status)).length,
          callsCompleted: done.length,
          overdue: myTasks.filter((t) => !["COMPLETED", "CANCELLED"].includes(t.status) && new Date(t.dueAt).getTime() < now).length,
          hotLeads: mine.filter((c) => c.leadScore > cfg.scoring.bands.warm).length,
          medianResponseHours: times.length ? Math.round(times[Math.floor(times.length / 2)] / 3600_000) : null,
          lastActivityAt: acts[0]?.createdAt,
          recent: acts.slice(0, 5).map((a) => ({
            at: a.createdAt,
            what: a.action.replace(/[._]/g, " "),
            customer: customerName(a.customerId),
          })),
        };
      }),

    loans: members
      .filter((m) => m.role === "LOAN_OFFICER" || m.role === "ADMIN")
      .map((m) => {
        const mine = cases.filter((l) => l.assignedOfficerId === m.id);
        const progresses = mine.map((l) => caseProgress(l.id));
        const acts = audit.filter((a) => a.actorId === m.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return {
          id: m.id,
          name: m.name,
          activeCases: loanLoad.get(m.id) ?? 0,
          awaitingReview: progresses.reduce((a, p) => a + p.awaitingReview.length, 0),
          waitingOnCustomer: progresses.filter((p) => p.missing.length > 0 || p.rejected.length > 0).length,
          overdue: mine.filter(
            (l) => caseProgress(l.id).awaitingReview.length > 0 &&
              now - new Date(l.updatedAt).getTime() > cfg.sla.documentReviewHours * 3600_000,
          ).length,
          docsAccepted: docs.filter((d) => d.reviewedById === m.id && d.status === "ACCEPTED").length,
          docsRejected: docs.filter((d) => d.reviewedById === m.id && d.status === "REJECTED").length,
          recent: acts.slice(0, 5).map((a) => ({
            at: a.createdAt,
            what: a.action.replace(/[._]/g, " "),
            customer: customerName(a.customerId),
          })),
        };
      }),

    escalations: db.escalations
      .filter((e) => e.orgId === org && e.status === "OPEN")
      .map((e) => ({
        id: e.id,
        customerId: e.customerId,
        customer: customerName(e.customerId) || "Unknown",
        reason: e.reason,
        severity: e.severity,
        lane: e.lane,
        createdAt: e.createdAt,
      })),

    activity: audit
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 200)
      .map((a) => ({
        id: a.id,
        at: a.createdAt,
        actor: nameOf(a.actorId) || a.actorType,
        actorType: a.actorType,
        action: a.action,
        customer: customerName(a.customerId),
      })),
  };

  return (
    <div className="space-y-5 p-7">
      <div>
        <h1 className="text-[19px] font-semibold tracking-tight">Control centre</h1>
        <p className="text-[12px] text-mist-400">
          Signed in as {session.fullName} · everything happening across the business
        </p>
      </div>
      <AdminTabs data={data} />
    </div>
  );
}
