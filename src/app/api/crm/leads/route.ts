import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { scoreLead } from "@/lib/crm/rules";
import { logActivity } from "@/lib/engine/publisher";
import type { Lead, LeadStatus } from "@/lib/crm/types";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";
import { emit } from "@/lib/events/bus";

/**
 * What a webhook subscriber is told about a lead.
 *
 * An explicit projection, not the record: a lead accumulates internal fields
 * (scores, KYC state, broker commercials) and spreading it would post each new
 * one to every registered endpoint the moment it was added.
 */
function leadEvent(lead: Lead): Record<string, unknown> {
  return {
    leadId: lead.id,
    brandId: lead.brandId,
    name: lead.name,
    phone: lead.phone,
    email: lead.email,
    city: lead.city,
    status: lead.status,
    source: lead.source,
    score: lead.score,
    assignedTo: lead.assignedTo,
    projectInterest: lead.projectInterest,
  };
}

/**
 * Move a lead, reassign it, or update KYC.
 *
 * Stage changes stamp the milestone dates the rules engine reads
 * (`siteVisitAt`, `tokenPaidAt`, `wonAt`), so advancing a lead automatically
 * schedules the obligations that stage implies — no separate "create reminder"
 * step for a person to forget.
 */
export async function PATCH(req: Request) {
  // Writes a lead. Was customers.read, which front_desk holds.
  const denied = await guard("customers.write");
  if (denied) return denied;

  // Stage changes decide commissions and site visits, so the log has to name
  // the person who made them. guard() already resolved the session.
  const actor = actorLabel(await getSession());

  const body = (await req.json()) as {
    leadId: string;
    status?: LeadStatus;
    assignedTo?: string;
    kycStatus?: Lead["kycStatus"];
    siteVisitAt?: string;
    patch?: Partial<Lead>;
  };

  // Captured before the mutation, because the event has to say what the stage
  // moved *from* and the record has been overwritten by the time it is read.
  const before = read().leads.find((l) => l.id === body.leadId)?.status;

  const result = mutate((db) => {
    const lead = db.leads.find((l) => l.id === body.leadId);
    if (!lead) return null;
    const now = new Date().toISOString();

    if (body.status && body.status !== lead.status) {
      lead.status = body.status;
      if (body.status === "site_visit_scheduled" && !lead.siteVisitAt) {
        // Default to three days out; the UI can override with an explicit date.
        lead.siteVisitAt = new Date(Date.now() + 3 * 86400000).toISOString();
      }
      if (body.status === "booking_token_paid" && !lead.tokenPaidAt) lead.tokenPaidAt = now;
      if (body.status === "won" && !lead.wonAt) lead.wonAt = now;
      if (body.status !== "new") lead.lastContactedAt = lead.lastContactedAt ?? now;
    }

    if (body.assignedTo) lead.assignedTo = body.assignedTo;
    if (body.kycStatus) lead.kycStatus = body.kycStatus;
    if (body.siteVisitAt) lead.siteVisitAt = body.siteVisitAt;
    if (body.patch) Object.assign(lead, body.patch);

    lead.updatedAt = now;
    lead.score = scoreLead(lead);
    return lead;
  });

  if (!result) return NextResponse.json({ ok: false, error: "lead not found" }, { status: 404 });
  logActivity(result.brandId, "crm", `Lead "${result.name}" → ${result.status.replace(/_/g, " ")}`, actor);
  // Only when the stage actually moved. Emitting on every PATCH would fire a
  // "stage_changed" for a reassignment or a KYC edit, and a workflow keyed on
  // that name would chase a buyer who has not moved anywhere.
  if (body.status && body.status !== before) {
    emit("lead.stage_changed", { ...leadEvent(result), previousStatus: before, changedBy: actor });
  }
  return NextResponse.json({ ok: true, lead: result });
}

/** Create a lead — used by the manual add form and by inbound lead capture. */
export async function POST(req: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const actor = actorLabel(await getSession());

  const body = (await req.json()) as Partial<Lead> & { brandId: string; name: string; phone: string };
  const now = new Date().toISOString();

  const lead: Lead = {
    id: uid("lead"),
    brandId: body.brandId,
    name: body.name,
    phone: body.phone,
    email: body.email,
    city: body.city ?? "",
    status: body.status ?? "new",
    budgetMin: body.budgetMin ?? 0,
    budgetMax: body.budgetMax ?? 0,
    source: body.source ?? "website",
    brokerId: body.brokerId,
    projectInterest: body.projectInterest ?? "",
    unitType: body.unitType ?? "",
    assignedTo: body.assignedTo ?? "Unassigned",
    score: 0,
    isHNWI: (body.budgetMax ?? 0) >= 8e7,
    kycStatus: "not_started",
    notes: body.notes,
    createdAt: now,
    updatedAt: now,
    tags: body.tags ?? [],
  };
  lead.score = scoreLead(lead);

  mutate((db) => void db.leads.push(lead));
  logActivity(lead.brandId, "crm", `New lead captured: ${lead.name}`, actor);
  // Fire-and-forget. The lead is saved; whether an automation hears about it is
  // not the form submitter's problem, and a hanging subscriber must not turn a
  // captured enquiry into a failed request.
  emit("lead.created", leadEvent(lead));
  return NextResponse.json({ ok: true, lead });
}

export async function GET(req: Request) {
  const denied = await guard("customers.read");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = url.searchParams.get("brand") ?? db.brands[0]?.id;
  return NextResponse.json({ ok: true, leads: db.leads.filter((l) => l.brandId === brandId) });
}
