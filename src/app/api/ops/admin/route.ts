import { read } from "@/lib/db";
import { authorize } from "@/lib/ops/auth";
import { handleError, ok } from "@/lib/ops/http";
import { workload } from "@/lib/ops/assignment";
import { getConfig, updateConfig } from "@/lib/ops/config";
import { caseProgress } from "@/lib/ops/loan";
import { LEAD_STAGES } from "@/lib/ops/types";

/** Global operational view + workload/SLA. Admin only. */
export async function GET(req: Request) {
  try {
    const session = await authorize(req, "admin:read");
    const db = read();
    const org = session.orgId;
    const now = Date.now();
    const cfg = getConfig(org);

    const customers = db.customers.filter((c) => c.orgId === org);
    const tasks = db.salesTasks.filter((t) => t.orgId === org);
    const cases = db.loanCases.filter((l) => l.orgId === org);
    const docs = db.documents.filter((d) => d.orgId === org);
    const followUps = db.followUps.filter((f) => f.orgId === org);

    const pipeline = Object.fromEntries(
      LEAD_STAGES.map((s) => [s, customers.filter((c) => c.leadStage === s).length]),
    );

    const salesLoad = workload(org, "SALES");
    const loanLoad = workload(org, "LOAN");

    const members = db.teamMembers.filter((m) => m.orgId === org && m.active);
    const salesPerformance = members
      .filter((m) => m.role === "SALES_MANAGER")
      .map((m) => {
        const mine = customers.filter((c) => c.assignedSalesManagerId === m.id);
        const myTasks = tasks.filter((t) => t.assignedToId === m.id);
        const completed = myTasks.filter((t) => t.status === "COMPLETED" && t.completedAt);
        // Median, not mean: one forgotten task should not define the metric.
        const times = completed
          .map((t) => new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime())
          .sort((a, b) => a - b);
        return {
          member: { id: m.id, name: m.name, capacity: m.capacity },
          assigned: salesLoad.get(m.id) ?? 0,
          open: mine.filter((c) => !["COMPLETED", "LOST"].includes(c.leadStage)).length,
          callsPending: myTasks.filter((t) => ["OPEN", "IN_PROGRESS"].includes(t.status)).length,
          medianResponseHours: times.length ? Math.round(times[Math.floor(times.length / 2)] / 3600_000) : null,
          overdue: myTasks.filter((t) => !["COMPLETED", "CANCELLED"].includes(t.status) && new Date(t.dueAt).getTime() < now).length,
          converted: mine.filter((c) => c.leadStage === "COMPLETED").length,
        };
      });

    const loanPerformance = members
      .filter((m) => m.role === "LOAN_OFFICER")
      .map((m) => {
        const mine = cases.filter((l) => l.assignedOfficerId === m.id);
        const progresses = mine.map((l) => caseProgress(l.id));
        const closed = mine.filter((l) => l.closedAt);
        const times = closed
          .map((l) => new Date(l.closedAt!).getTime() - new Date(l.createdAt).getTime())
          .sort((a, b) => a - b);
        return {
          member: { id: m.id, name: m.name, capacity: m.capacity },
          activeCases: loanLoad.get(m.id) ?? 0,
          pendingDocuments: progresses.reduce((a, p) => a + p.missing.length, 0),
          waitingOnCustomer: progresses.filter((p) => p.missing.length > 0 || p.rejected.length > 0).length,
          waitingOnOfficer: progresses.filter((p) => p.awaitingReview.length > 0).length,
          medianProcessingDays: times.length ? Math.round(times[Math.floor(times.length / 2)] / 86400_000) : null,
          overdue: mine.filter(
            (l) => caseProgress(l.id).awaitingReview.length > 0 && now - new Date(l.updatedAt).getTime() > cfg.sla.documentReviewHours * 3600_000,
          ).length,
          completionRate: mine.length ? Math.round((mine.filter((l) => l.status === "COMPLETED").length / mine.length) * 100) : 0,
        };
      });

    return ok({
      totals: {
        customers: customers.length,
        newLeads: customers.filter((c) => c.leadStage === "NEW").length,
        hotLeads: customers.filter((c) => c.leadScore > cfg.scoring.bands.warm).length,
        salesFollowUps: followUps.filter((f) => f.lane === "SALES" && f.status === "SCHEDULED").length,
        salesCallsPending: tasks.filter((t) => ["OPEN", "IN_PROGRESS"].includes(t.status)).length,
        loanCases: cases.filter((l) => !["COMPLETED", "REJECTED"].includes(l.status)).length,
        documentsPending: cases.reduce((a, l) => a + caseProgress(l.id).missing.length, 0),
        documentsReceived: docs.length,
        documentsRejected: docs.filter((d) => d.status === "REJECTED").length,
        casesReadyForReview: cases.filter((l) => l.status === "READY_FOR_ANALYSIS").length,
        overdueFollowUps: followUps.filter((f) => f.status === "SCHEDULED" && new Date(f.scheduledAt).getTime() < now).length,
        openEscalations: db.escalations.filter((e) => e.orgId === org && e.status === "OPEN").length,
      },
      pipeline,
      salesPerformance,
      loanPerformance,
      escalations: db.escalations.filter((e) => e.orgId === org && e.status === "OPEN"),
      notifications: db.opsNotifications.filter((n) => n.orgId === org && !n.read).slice(-50),
      config: cfg,
    });
  } catch (e) {
    return handleError(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const session = await authorize(req, "config:write");
    const patch = await req.json();
    return ok({ config: updateConfig(session.orgId, patch) });
  } catch (e) {
    return handleError(e);
  }
}
