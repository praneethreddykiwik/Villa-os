import { mutate, read } from "../db";
import { uid } from "../ids";
import { audit } from "./audit";
import { sentimentTrend } from "./intelligence";
import type { ControlState, Customer, LeadStage } from "./types";

/**
 * CUSTOMER SERVICE — the single source of truth.
 *
 * Identity is the phone number, normalised to digits, scoped to the org. That is
 * the only key WhatsApp actually gives us, and deriving identity from anything
 * else (name, email) creates duplicates the moment someone types their name
 * differently.
 *
 * Existing `Lead` and `CrmContact` records are *linked*, not copied. Nothing in
 * this module writes a second copy of a person's details.
 */

/** Digits only, keeping a leading country code. Two formats of the same number
 *  must resolve to one customer or the whole workflow forks. */
export function normalisePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "").replace(/^0+/, "");
}

export function findByPhone(orgId: string, phone: string): Customer | undefined {
  const key = normalisePhone(phone);
  return read().customers.find((c) => c.orgId === orgId && normalisePhone(c.phone) === key);
}

export interface UpsertInput {
  orgId: string;
  phone: string;
  name?: string;
  email?: string;
  source?: string;
  leadId?: string;
  contactId?: string;
}

/**
 * Get-or-create. Idempotent by phone, so a webhook replay or a second enquiry
 * from the same number extends one profile instead of forking it.
 */
export function upsertCustomer(input: UpsertInput): { customer: Customer; created: boolean } {
  const existing = findByPhone(input.orgId, input.phone);
  const now = new Date().toISOString();

  if (existing) {
    const patch: Partial<Customer> = {};
    // Only fill blanks — never overwrite a human-corrected name with a WhatsApp
    // profile name.
    if (input.name && !existing.name) patch.name = input.name;
    if (input.email && !existing.email) patch.email = input.email;
    if (input.leadId && !existing.leadId) patch.leadId = input.leadId;
    if (input.contactId && !existing.contactId) patch.contactId = input.contactId;
    if (Object.keys(patch).length) {
      mutate((db) => {
        const c = db.customers.find((x) => x.id === existing.id);
        if (c) Object.assign(c, patch, { updatedAt: now });
      });
    }
    return { customer: { ...existing, ...patch }, created: false };
  }

  const customer: Customer = {
    id: uid("cus"),
    orgId: input.orgId,
    name: input.name ?? "Unknown",
    phone: input.phone,
    email: input.email,
    source: input.source ?? "whatsapp",
    leadStatus: "new",
    leadStage: "NEW",
    loanRequired: "UNKNOWN",
    intent: "INFORMATIONAL",
    sentiment: "NEUTRAL",
    sentimentConfidence: 0.5,
    leadScore: 0,
    preferredChannel: "whatsapp",
    preferences: {},
    notes: "",
    tags: [],
    salesControl: "AI_ACTIVE",
    loanControl: "AI_ACTIVE",
    optedOut: false,
    createdAt: now,
    updatedAt: now,
    leadId: input.leadId,
    contactId: input.contactId,
  };

  mutate((db) => void db.customers.push(customer));
  audit({
    orgId: input.orgId,
    actorType: "system",
    action: "customer.created",
    entity: "customer",
    entityId: customer.id,
    customerId: customer.id,
    metadata: { source: customer.source, phone: customer.phone },
  });
  return { customer, created: true };
}

export function getCustomer(customerId: string): Customer | undefined {
  return read().customers.find((c) => c.id === customerId);
}

/** Patch the profile and record what changed, by whom. */
export function updateCustomer(
  customerId: string,
  patch: Partial<Customer>,
  actor: { id?: string; type: "human" | "ai" | "system" },
): Customer | null {
  const before = getCustomer(customerId);
  if (!before) return null;

  // Identity, ownership and audit columns are not patchable through this path.
  const { id: _i, orgId: _o, createdAt: _c, ...safe } = patch;
  const now = new Date().toISOString();

  const after = mutate((db) => {
    const c = db.customers.find((x) => x.id === customerId);
    if (!c) return null;
    Object.assign(c, safe, { updatedAt: now });
    return { ...c };
  });
  if (!after) return null;

  const changed = Object.keys(safe).filter(
    (k) => JSON.stringify(asRecord(before)[k]) !== JSON.stringify(asRecord(after)[k]),
  );
  if (changed.length) {
    audit({
      orgId: before.orgId,
      actorId: actor.id,
      actorType: actor.type,
      action: "customer.updated",
      entity: "customer",
      entityId: customerId,
      customerId,
      metadata: { changed, before: pick(before, changed), after: pick(after, changed) },
    });
  }
  return after;
}

/** Structural read of a typed record, for generic diffing. */
function asRecord(o: unknown): Record<string, unknown> {
  return o as unknown as Record<string, unknown>;
}

function pick(o: unknown, keys: string[]): Record<string, unknown> {
  const src = asRecord(o);
  return Object.fromEntries(keys.map((k) => [k, src[k]]));
}

/** Stage transitions are logged separately — this is the workflow's spine. */
export function setStage(
  customerId: string,
  stage: LeadStage,
  actor: { id?: string; type: "human" | "ai" | "system" },
  reason?: string,
): Customer | null {
  const before = getCustomer(customerId);
  if (!before || before.leadStage === stage) return before ?? null;
  const after = updateCustomer(customerId, { leadStage: stage }, actor);
  if (after) {
    audit({
      orgId: after.orgId,
      actorId: actor.id,
      actorType: actor.type,
      action: "customer.stage_changed",
      entity: "customer",
      entityId: customerId,
      customerId,
      metadata: { from: before.leadStage, to: stage, reason },
    });
  }
  return after;
}

/**
 * Human takeover. Sales and loan lanes pause independently: a sales manager
 * running a negotiation should not silence the document-collection assistant,
 * and vice versa.
 */
export function setControl(
  customerId: string,
  lane: "SALES" | "LOAN",
  state: ControlState,
  actor: { id?: string; type: "human" | "ai" | "system" },
): Customer | null {
  const field = lane === "SALES" ? "salesControl" : "loanControl";
  const before = getCustomer(customerId);
  if (!before) return null;
  const after = updateCustomer(customerId, { [field]: state } as Partial<Customer>, actor);

  if (state === "HUMAN_CONTROL") {
    // Pause outstanding automation in that lane immediately, rather than letting
    // an already-scheduled follow-up fire after a human took over.
    mutate((db) => {
      for (const f of db.followUps) {
        if (f.customerId === customerId && f.lane === lane && f.status === "SCHEDULED") {
          f.status = "PAUSED";
          f.updatedAt = new Date().toISOString();
        }
      }
    });
  } else {
    mutate((db) => {
      for (const f of db.followUps) {
        if (f.customerId === customerId && f.lane === lane && f.status === "PAUSED") {
          f.status = "SCHEDULED";
          f.updatedAt = new Date().toISOString();
        }
      }
    });
  }

  audit({
    orgId: before.orgId,
    actorId: actor.id,
    actorType: actor.type,
    action: state === "HUMAN_CONTROL" ? "control.taken" : "control.released",
    entity: "customer",
    entityId: customerId,
    customerId,
    metadata: { lane, state },
  });
  return after;
}

/** True when automation is allowed to message this customer in this lane. */
export function automationAllowed(customer: Customer, lane: "SALES" | "LOAN"): { allowed: boolean; reason?: string } {
  if (customer.optedOut) return { allowed: false, reason: "Customer opted out of automated messages" };
  const control = lane === "SALES" ? customer.salesControl : customer.loanControl;
  if (control === "HUMAN_CONTROL") return { allowed: false, reason: `${lane} lane is under human control` };
  return { allowed: true };
}

export interface CustomerSnapshot {
  customer: Customer;
  trend: ReturnType<typeof sentimentTrend>;
  messageCount: number;
  lastInboundAt?: string;
  openTasks: number;
  loanCaseId?: string;
}

export function snapshot(customerId: string): CustomerSnapshot | null {
  const db = read();
  const customer = db.customers.find((c) => c.id === customerId);
  if (!customer) return null;
  const messages = db.opsMessages.filter((m) => m.customerId === customerId);
  const inbound = messages.filter((m) => m.direction === "inbound");
  return {
    customer,
    trend: sentimentTrend(customerId),
    messageCount: messages.length,
    lastInboundAt: inbound[inbound.length - 1]?.createdAt,
    openTasks: db.salesTasks.filter((t) => t.customerId === customerId && t.status !== "COMPLETED" && t.status !== "CANCELLED").length,
    loanCaseId: db.loanCases.find((l) => l.customerId === customerId && l.status !== "COMPLETED")?.id,
  };
}
