import { mutate, read } from "../db";
import { uid } from "../ids";
import { audit, notify } from "./audit";
import { getConfig } from "./config";
import type { Assignment, AssignmentStrategy, Role, TeamMember } from "./types";

/**
 * ASSIGNMENT
 *
 * Four strategies, chosen per queue in config. Every outcome — including
 * "nobody was available" — is recorded as an Assignment row, because "why is
 * this lead unassigned?" is a question that has to be answerable.
 */

const ROLE_FOR_QUEUE: Record<"SALES" | "LOAN", Role> = {
  SALES: "SALES_MANAGER",
  LOAN: "LOAN_OFFICER",
};

/** Open workload per member, used by LEAST_LOADED and the workload dashboard. */
export function workload(orgId: string, queue: "SALES" | "LOAN"): Map<string, number> {
  const db = read();
  const map = new Map<string, number>();
  for (const m of db.teamMembers.filter((x) => x.orgId === orgId && x.role === ROLE_FOR_QUEUE[queue] && x.active)) {
    map.set(m.id, 0);
  }
  if (queue === "SALES") {
    for (const c of db.customers) {
      if (c.orgId !== orgId || !c.assignedSalesManagerId) continue;
      if (["COMPLETED", "LOST"].includes(c.leadStage)) continue;
      map.set(c.assignedSalesManagerId, (map.get(c.assignedSalesManagerId) ?? 0) + 1);
    }
  } else {
    for (const l of db.loanCases) {
      if (l.orgId !== orgId || !l.assignedOfficerId) continue;
      if (["COMPLETED", "REJECTED"].includes(l.status)) continue;
      map.set(l.assignedOfficerId, (map.get(l.assignedOfficerId) ?? 0) + 1);
    }
  }
  return map;
}

function eligible(orgId: string, queue: "SALES" | "LOAN"): TeamMember[] {
  return read().teamMembers.filter((m) => m.orgId === orgId && m.role === ROLE_FOR_QUEUE[queue] && m.active);
}

function pick(orgId: string, queue: "SALES" | "LOAN", strategy: AssignmentStrategy): TeamMember | undefined {
  const members = eligible(orgId, queue);
  if (!members.length) return undefined;

  if (strategy === "MANUAL" || strategy === "TEAM_QUEUE") return undefined;

  const load = workload(orgId, queue);

  if (strategy === "LEAST_LOADED") {
    // Respect per-member capacity; a member at capacity is skipped entirely so
    // "least loaded" cannot mean "least loaded among the overloaded".
    const withRoom = members.filter((m) => (load.get(m.id) ?? 0) < m.capacity);
    const pool = withRoom.length ? withRoom : members;
    return [...pool].sort((a, b) => (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) || a.id.localeCompare(b.id))[0];
  }

  // ROUND_ROBIN: continue after whoever was assigned last, so restarts do not
  // reset the rotation onto the same person.
  const history = read()
    .assignments.filter((a) => a.orgId === orgId && a.queue === queue && a.assigneeId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const lastId = history[history.length - 1]?.assigneeId;
  const ordered = [...members].sort((a, b) => a.id.localeCompare(b.id));
  const lastIndex = ordered.findIndex((m) => m.id === lastId);
  return ordered[(lastIndex + 1) % ordered.length];
}

export interface AssignResult {
  assignment: Assignment;
  assignee?: TeamMember;
}

/**
 * Assign a customer (SALES) or their loan case (LOAN). Passing `assigneeId`
 * forces a manual assignment and is recorded as such.
 */
export function assign(opts: {
  orgId: string;
  customerId: string;
  queue: "SALES" | "LOAN";
  assigneeId?: string;
  reason: string;
  actorId?: string;
  actorType?: "human" | "ai" | "system";
}): AssignResult {
  const cfg = getConfig(opts.orgId);
  const strategy: AssignmentStrategy = opts.assigneeId
    ? "MANUAL"
    : opts.queue === "SALES"
      ? cfg.assignment.sales
      : cfg.assignment.loan;

  const chosen = opts.assigneeId
    ? eligible(opts.orgId, opts.queue).find((m) => m.id === opts.assigneeId)
    : pick(opts.orgId, opts.queue, strategy);

  const db = read();
  const previous =
    opts.queue === "SALES"
      ? db.customers.find((c) => c.id === opts.customerId)?.assignedSalesManagerId
      : db.loanCases.find((l) => l.customerId === opts.customerId)?.assignedOfficerId;

  const assignment: Assignment = {
    id: uid("asg"),
    orgId: opts.orgId,
    customerId: opts.customerId,
    queue: opts.queue,
    assigneeId: chosen?.id,
    previousAssigneeId: previous,
    strategy,
    reason: chosen ? opts.reason : `${opts.reason} — no eligible ${ROLE_FOR_QUEUE[opts.queue]} available, left in queue`,
    actorId: opts.actorId,
    createdAt: new Date().toISOString(),
  };

  mutate((d) => {
    d.assignments.push(assignment);
    if (opts.queue === "SALES") {
      const c = d.customers.find((x) => x.id === opts.customerId);
      if (c) {
        c.assignedSalesManagerId = chosen?.id;
        c.updatedAt = assignment.createdAt;
      }
      for (const t of d.salesTasks) {
        if (t.customerId === opts.customerId && t.status === "OPEN") t.assignedToId = chosen?.id;
      }
    } else {
      const c = d.customers.find((x) => x.id === opts.customerId);
      if (c) {
        c.assignedLoanOfficerId = chosen?.id;
        c.updatedAt = assignment.createdAt;
      }
      for (const l of d.loanCases) {
        if (l.customerId === opts.customerId && l.status !== "COMPLETED") {
          l.assignedOfficerId = chosen?.id;
          l.updatedAt = assignment.createdAt;
        }
      }
    }
  });

  audit({
    orgId: opts.orgId,
    actorId: opts.actorId,
    actorType: opts.actorType ?? "system",
    action: opts.queue === "SALES" ? "sales.assigned" : "loan.assigned",
    entity: "customer",
    entityId: opts.customerId,
    customerId: opts.customerId,
    metadata: { assigneeId: chosen?.id, previous, strategy, reason: assignment.reason },
  });

  if (chosen) {
    notify({
      orgId: opts.orgId,
      recipientId: chosen.id,
      category: opts.queue === "SALES" ? "SALES" : "LOAN",
      event: opts.queue === "SALES" ? "lead.assigned" : "loan_case.assigned",
      title: opts.queue === "SALES" ? "New lead assigned to you" : "New loan case assigned to you",
      body: opts.reason,
      customerId: opts.customerId,
      severity: "INFO",
    });
  } else {
    notify({
      orgId: opts.orgId,
      recipientRole: "ADMIN",
      category: "ADMIN",
      event: "assignment.failed",
      title: `Unassigned ${opts.queue.toLowerCase()} work`,
      body: assignment.reason,
      customerId: opts.customerId,
      severity: "WARNING",
    });
  }

  return { assignment, assignee: chosen };
}
