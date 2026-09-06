import { mutate, read } from "../db";
import { uid } from "../ids";
import type { WhatsAppStatus } from "../platforms/whatsapp";
import { normalisePhone, setControl } from "./customers";
import { activeCase } from "./loan";
import type { Appointment } from "../appointments/types";
import type { AuditEvent, Customer, DeliveryStatus, DocumentRecord, Escalation, LoanCase, OpsMessage } from "./types";

/**
 * WHATSAPP INBOX
 *
 * Read model over `opsMessages`. Every message the customer sent and every
 * reply — AI, human, follow-up — is already recorded there by the agent; this
 * module only groups, counts and annotates. It writes exactly two things:
 * delivery receipts onto outbound rows, and the staff read mark on inbound rows.
 */

const RANK: Record<DeliveryStatus, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** Apply platform receipts to the outbound rows they belong to. Returns the number matched. */
export function applyDeliveryStatuses(statuses: WhatsAppStatus[]): number {
  if (!statuses.length) return 0;
  return mutate((db) => {
    let n = 0;
    for (const s of statuses) {
      const msg = db.opsMessages.find((m) => m.externalId === s.messageId && m.direction === "outbound");
      if (!msg) continue;
      // Receipts are not ordered: a late "sent" must not undo "read".
      if (msg.deliveryStatus && RANK[msg.deliveryStatus] >= RANK[s.status] && s.status !== "failed") continue;
      msg.deliveryStatus = s.status;
      msg.deliveryAt = s.timestamp;
      if (s.status === "failed") msg.deliveryError = s.error ?? "Delivery failed";
      n += 1;
    }
    return n;
  });
}

export type InboxFilter = "all" | "unread" | "human" | "needs_reply";

export interface ConversationSummary {
  customerId: string;
  name: string;
  phone: string;
  lastMessage: string;
  lastAt: string;
  lastDirection: OpsMessage["direction"];
  unread: number;
  mode: "ai" | "human";
  needsReply: boolean;
  leadStage: Customer["leadStage"];
}

function isWhatsApp(m: OpsMessage): boolean {
  return m.channel === "whatsapp";
}

export function listConversations(
  orgId: string,
  opts: { filter?: InboxFilter; q?: string; customerIds?: Set<string> } = {},
): ConversationSummary[] {
  const db = read();
  const byCustomer = new Map<string, OpsMessage[]>();
  for (const m of db.opsMessages) {
    if (m.orgId !== orgId || !isWhatsApp(m)) continue;
    if (opts.customerIds && !opts.customerIds.has(m.customerId)) continue;
    const arr = byCustomer.get(m.customerId);
    if (arr) arr.push(m);
    else byCustomer.set(m.customerId, [m]);
  }
  const out: ConversationSummary[] = [];
  for (const [customerId, msgs] of byCustomer) {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) continue;
    msgs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = msgs[msgs.length - 1];
    const unread = msgs.filter((m) => m.direction === "inbound" && !m.readAt).length;
    out.push({
      customerId,
      name: c.name || c.phone,
      phone: c.phone,
      lastMessage: last.body,
      lastAt: last.createdAt,
      lastDirection: last.direction,
      unread,
      mode: c.salesControl === "HUMAN_CONTROL" ? "human" : "ai",
      needsReply: last.direction === "inbound",
      leadStage: c.leadStage,
    });
  }
  const q = opts.q?.trim().toLowerCase();
  const qDigits = q ? q.replace(/\D/g, "") : "";
  return out
    .filter((s) => {
      if (opts.filter === "unread" && s.unread === 0) return false;
      if (opts.filter === "human" && s.mode !== "human") return false;
      if (opts.filter === "needs_reply" && !s.needsReply) return false;
      if (q) {
        const hit =
          s.name.toLowerCase().includes(q) ||
          (qDigits.length >= 3 && normalisePhone(s.phone).includes(qDigits)) ||
          s.lastMessage.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    })
    .sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** Inline system events shown between bubbles. */
export interface ThreadEvent {
  id: string;
  kind: "escalated" | "visit_booked" | "control" | "stage" | "opted_out" | "send_failed";
  label: string;
  at: string;
}

export interface ThreadMessage extends OpsMessage {
  authorName: string;
  document?: Pick<DocumentRecord, "id" | "filename" | "mimeType" | "sizeBytes" | "status">;
}

export interface ThreadPayload {
  customer: Customer;
  messages: ThreadMessage[];
  events: ThreadEvent[];
  documents: DocumentRecord[];
  escalations: Escalation[];
  appointments: Appointment[];
  loanCase: LoanCase | null;
  assignedManagerName?: string;
  assignedOfficerName?: string;
  /** False when the 24h service window has closed — free text will not deliver. */
  canFreeText: boolean;
  lastInboundAt?: string;
}

const WINDOW_MS = 24 * 60 * 60 * 1000;

function eventFromAudit(a: AuditEvent): ThreadEvent | null {
  const meta = a.metadata ?? {};
  switch (a.action) {
    case "escalation.created":
      return { id: a.id, kind: "escalated", label: `Escalated: ${String(meta.reason ?? "needs a person")}`, at: a.createdAt };
    case "customer.stage_changed":
      return { id: a.id, kind: "stage", label: `Stage → ${String(meta.to ?? meta.stage ?? "updated")}`, at: a.createdAt };
    case "customer.opted_out":
      return { id: a.id, kind: "opted_out", label: "Customer opted out", at: a.createdAt };
    case "message.send_failed":
      return {
        id: a.id,
        kind: "send_failed",
        label: meta.requiresTemplate ? "Reply blocked: 24-hour window closed" : `Send failed: ${String(meta.error ?? "")}`,
        at: a.createdAt,
      };
    case "control.taken":
      if (meta.lane && meta.lane !== "SALES") return null;
      return { id: a.id, kind: "control", label: "AI paused — a person is handling this chat", at: a.createdAt };
    case "control.released":
      if (meta.lane && meta.lane !== "SALES") return null;
      return { id: a.id, kind: "control", label: "AI resumed", at: a.createdAt };
    default:
      return null;
  }
}

export function getThread(orgId: string, customerId: string): ThreadPayload | null {
  const db = read();
  const customer = db.customers.find((c) => c.id === customerId && c.orgId === orgId);
  if (!customer) return null;
  const members = new Map(db.teamMembers.map((m) => [m.id, m.name]));
  const docs = db.documents.filter((d) => d.customerId === customerId);
  const docById = new Map(docs.map((d) => [d.id, d]));

  const messages: ThreadMessage[] = db.opsMessages
    .filter((m) => m.customerId === customerId && (isWhatsApp(m) || m.channel === "system"))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((m) => {
      const doc = m.documentId ? docById.get(m.documentId) : undefined;
      return {
        ...m,
        authorName:
          m.authorType === "ai"
            ? "AI"
            : m.authorType === "human"
              ? (m.authorId && members.get(m.authorId)) || "Staff"
              : m.authorType === "customer"
                ? customer.name || customer.phone
                : "System",
        document: doc ? { id: doc.id, filename: doc.filename, mimeType: doc.mimeType, sizeBytes: doc.sizeBytes, status: doc.status } : undefined,
      };
    });

  const events: ThreadEvent[] = db.auditEvents
    .filter((a) => a.customerId === customerId)
    .map(eventFromAudit)
    .filter((e): e is ThreadEvent => e !== null);
  const phone = normalisePhone(customer.phone);
  const appointments = (db.appointments ?? [])
    .filter((a) => normalisePhone(a.customerPhone) === phone)
    .sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  for (const a of appointments) {
    events.push({
      id: `appt-${a.id}`,
      kind: "visit_booked",
      label: `Site visit ${a.status}: ${new Date(a.startsAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`,
      at: a.createdAt ?? a.startsAt,
    });
  }
  events.sort((a, b) => a.at.localeCompare(b.at));

  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const canFreeText = Boolean(lastInbound && Date.now() - new Date(lastInbound.createdAt).getTime() < WINDOW_MS);

  return {
    customer,
    messages,
    events,
    documents: docs,
    escalations: db.escalations.filter((e) => e.customerId === customerId),
    appointments,
    loanCase: activeCase(customerId) ?? null,
    assignedManagerName: customer.assignedSalesManagerId ? members.get(customer.assignedSalesManagerId) : undefined,
    assignedOfficerName: customer.assignedLoanOfficerId ? members.get(customer.assignedLoanOfficerId) : undefined,
    canFreeText,
    lastInboundAt: lastInbound?.createdAt,
  };
}

/** Staff opened the thread: every unread inbound becomes read. Returns count marked. */
export function markThreadRead(customerId: string): number {
  const now = new Date().toISOString();
  return mutate((db) => {
    let n = 0;
    for (const m of db.opsMessages) {
      if (m.customerId === customerId && m.direction === "inbound" && !m.readAt) {
        m.readAt = now;
        n += 1;
      }
    }
    return n;
  });
}

/** Pause or resume the AI for the sales lane of one customer. */
export function setInboxControl(customerId: string, paused: boolean, actor: { id?: string; type: "human" | "ai" | "system" }): Customer | null {
  return setControl(customerId, "SALES", paused ? "HUMAN_CONTROL" : "AI_ACTIVE", actor);
}

/**
 * Record an outbound sent through a path that bypasses the agent (the social
 * inbox reply route). Keyed on the platform id so a retry cannot double-record.
 */
export function recordExternalOutbound(input: {
  orgId: string;
  customerId: string;
  body: string;
  authorType: "human" | "ai";
  authorId?: string;
  externalId?: string;
}): OpsMessage | null {
  return mutate((db) => {
    if (input.externalId && db.opsMessages.some((m) => m.externalId === input.externalId)) return null;
    const msg: OpsMessage = {
      id: uid("msg"),
      orgId: input.orgId,
      customerId: input.customerId,
      channel: "whatsapp",
      direction: "outbound",
      body: input.body,
      authorType: input.authorType,
      authorId: input.authorId,
      externalId: input.externalId,
      automated: false,
      createdAt: new Date().toISOString(),
    };
    db.opsMessages.push(msg);
    return msg;
  });
}
