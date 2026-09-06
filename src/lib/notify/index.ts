import { mutate, read } from "../db";
import { uid } from "../ids";
import { availabilityFor, markConfirmationSent } from "../appointments/engine";
import type { Appointment } from "../appointments/types";
import { audit, notify as inAppNotify } from "../ops/audit";
import { findByPhone } from "../ops/customers";
import { deliver } from "../ops/agent";
import { resolveDefaultOrgId } from "../ops/seed";
import type { OpsNotification, Role } from "../ops/types";
import { icsFor } from "./ics";

/**
 * NOTIFICATIONS — one door out.
 *
 * Three channels, one call. Every channel reports an outcome instead of
 * throwing, and every outcome is written to `notificationLog`, because "did the
 * manager actually get told about Sunday's visit" is a question the desk asks
 * and a swallowed promise rejection cannot answer.
 *
 *  - in-app:   opsNotifications (always available)
 *  - email:    Resend, only when RESEND_API_KEY + NOTIFY_FROM_EMAIL are set;
 *              otherwise a "not configured" outcome, never a throw
 *  - whatsapp: the customer, through deliver() — the only WhatsApp send path,
 *              so the 24h-window, opt-out and cap guards all still apply
 */

export type NotifyChannel = "in_app" | "email" | "whatsapp";

export interface DeliveryOutcome {
  channel: NotifyChannel;
  ok: boolean;
  /** Human-readable: an address, an error, or why it was skipped. */
  detail: string;
  to?: string;
}

export interface NotificationLogEntry extends DeliveryOutcome {
  id: string;
  orgId: string;
  event: string;
  entity: string;
  entityId: string;
  createdAt: string;
}

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  attachments?: Array<{ filename: string; content: string; contentType?: string }>;
}

export interface NotifyEvent {
  orgId: string;
  /** e.g. "appointment.booked" */
  event: string;
  entity: string;
  entityId: string;
  customerId?: string;
  inApp?: {
    title: string;
    body: string;
    category: OpsNotification["category"];
    recipientId?: string;
    recipientRole?: Role;
    severity?: OpsNotification["severity"];
  };
  email?: EmailMessage;
  whatsapp?: { customerId: string; text: string; tag?: string };
}

/** Log is bounded: it is evidence for the desk, not an archive. */
const LOG_CAP = 2000;

export function emailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.NOTIFY_FROM_EMAIL);
}

/** NOTIFY_EMAILS, comma-separated, blanks dropped. */
export function configuredRecipients(): string[] {
  return (process.env.NOTIFY_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
}

export async function sendEmail(msg: EmailMessage): Promise<DeliveryOutcome> {
  const to = [...new Set(msg.to.map((s) => s.trim()).filter((s) => s.includes("@")))];
  const joined = to.join(", ");
  if (!emailConfigured()) {
    return { channel: "email", ok: false, to: joined, detail: "not configured: set RESEND_API_KEY and NOTIFY_FROM_EMAIL" };
  }
  if (!to.length) return { channel: "email", ok: false, detail: "no recipients: set NOTIFY_EMAILS or assign a host with an email" };

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.NOTIFY_FROM_EMAIL,
        to,
        subject: msg.subject,
        text: msg.text,
        html: msg.html,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, content_type: a.contentType })),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { channel: "email", ok: false, to: joined, detail: `Resend HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { channel: "email", ok: true, to: joined, detail: data.id ? `Resend id ${data.id}` : "sent" };
  } catch (e) {
    return { channel: "email", ok: false, to: joined, detail: e instanceof Error ? e.message : String(e) };
  }
}

function log(ev: NotifyEvent, outcomes: DeliveryOutcome[]): void {
  const now = new Date().toISOString();
  const entries: NotificationLogEntry[] = outcomes.map((o) => ({
    id: uid("nlog"),
    orgId: ev.orgId,
    event: ev.event,
    entity: ev.entity,
    entityId: ev.entityId,
    createdAt: now,
    ...o,
  }));
  mutate((d) => {
    d.notificationLog = [...(d.notificationLog ?? []), ...entries].slice(-LOG_CAP);
  });
}

export async function notify(ev: NotifyEvent): Promise<DeliveryOutcome[]> {
  const outcomes: DeliveryOutcome[] = [];

  if (ev.inApp) {
    try {
      inAppNotify({ orgId: ev.orgId, event: ev.event, customerId: ev.customerId, ...ev.inApp });
      outcomes.push({ channel: "in_app", ok: true, detail: ev.inApp.recipientId ?? ev.inApp.recipientRole ?? "broadcast" });
    } catch (e) {
      outcomes.push({ channel: "in_app", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  if (ev.email) outcomes.push(await sendEmail(ev.email));

  if (ev.whatsapp) {
    try {
      const res = await deliver(ev.orgId, ev.whatsapp.customerId, ev.whatsapp.text, "ai", undefined, {
        automated: true,
        tag: ev.whatsapp.tag,
      });
      outcomes.push({
        channel: "whatsapp",
        ok: res.ok,
        to: ev.whatsapp.customerId,
        detail: res.ok ? "sent" : res.requiresTemplate ? "outside the 24h window — needs a template or a call" : res.error ?? "send failed",
      });
    } catch (e) {
      outcomes.push({ channel: "whatsapp", ok: false, to: ev.whatsapp.customerId, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  log(ev, outcomes);
  return outcomes;
}

/* -------------------------------------------------------------------------- */
/* Appointments                                                                */
/* -------------------------------------------------------------------------- */

export type AppointmentEvent = "booked" | "confirmed" | "rescheduled" | "cancelled" | "no_show" | "reminder";

function when(a: Appointment): string {
  const tz = availabilityFor(a.brandId).timezone || "Asia/Kolkata";
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: tz, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  }).format(new Date(a.startsAt));
}

const TITLES: Record<AppointmentEvent, string> = {
  booked: "Site visit booked",
  confirmed: "Site visit confirmed",
  rescheduled: "Site visit moved",
  cancelled: "Site visit cancelled",
  no_show: "Site visit no-show",
  reminder: "Site visit tomorrow",
};

/** What the buyer is told. `null` = nothing goes to the customer for this event. */
function customerText(a: Appointment, event: AppointmentEvent, brandName: string): string | null {
  const first = a.customerName.split(" ")[0];
  const t = when(a);
  switch (event) {
    case "booked":
    case "confirmed":
      return `Hi ${first}, your site visit with ${brandName} is confirmed for ${t}. We'll send a reminder before it. Reply here if you need to change the time.`;
    case "rescheduled":
      return `Hi ${first}, your site visit with ${brandName} has been moved to ${t}. Reply here if that doesn't suit.`;
    case "cancelled":
      return `Hi ${first}, your site visit with ${brandName} on ${t} has been cancelled. Reply here whenever you'd like to pick another time.`;
    case "reminder":
      return `Hi ${first}, a reminder: your site visit with ${brandName} is ${t}. See you there — reply here if anything changes.`;
    case "no_show":
      return null;
  }
}

/**
 * Tell everyone who needs to know about a visit. Fire-and-forget from the
 * engine, awaited by the reminder tick. Never throws.
 */
export async function notifyAppointment(a: Appointment, event: AppointmentEvent): Promise<DeliveryOutcome[]> {
  try {
    const db = read();
    const orgId = await resolveDefaultOrgId();
    const brand = db.brands.find((b) => b.id === a.brandId);
    const brandName = brand?.name ?? "the team";
    const host = a.assignedTo
      ? db.teamMembers.find((m) => m.active && (m.name === a.assignedTo || m.email === a.assignedTo))
      : undefined;
    const last = a.history.at(-1);

    const title = `${TITLES[event]}: ${a.customerName}`;
    const lines = [
      `${a.customerName} · ${a.customerPhone}${a.customerEmail ? ` · ${a.customerEmail}` : ""}`,
      `When: ${when(a)} (${a.durationMinutes} min)`,
      `Host: ${a.assignedTo || "Unassigned"} · Source: ${a.channel} · Status: ${a.status}`,
      last?.reason ? `Reason: ${last.reason}` : "",
      a.notes ? `Notes: ${a.notes}` : "",
    ].filter(Boolean);

    const recipients = [...configuredRecipients(), ...(host?.email ? [host.email] : [])];
    const customer = findByPhone(orgId, a.customerPhone);
    const text = customerText(a, event, brandName);

    // The WhatsApp agent's own reply is the confirmation for a chat booking;
    // a second "you're booked" a moment later reads as a glitch.
    const agentBooked = event === "booked" && a.channel === "whatsapp" && a.createdBy === "ai";
    const whatsapp =
      text && customer && !agentBooked ? { customerId: customer.id, text, tag: `appointment_${event}` } : undefined;

    const outcomes = await notify({
      orgId,
      event: `appointment.${event}`,
      entity: "appointment",
      entityId: a.id,
      customerId: customer?.id,
      inApp: {
        title,
        body: lines.join("\n"),
        category: "SALES",
        recipientId: host?.id,
        recipientRole: host ? undefined : "SALES_MANAGER",
        severity: event === "cancelled" || event === "no_show" ? "WARNING" : "INFO",
      },
      email: {
        to: recipients,
        subject: `[${brandName}] ${title} — ${when(a)}`,
        text: lines.join("\n"),
        attachments: [{
          filename: `site-visit-${a.id}.ics`,
          content: Buffer.from(icsFor(a, { brandName })).toString("base64"),
          contentType: "text/calendar",
        }],
      },
      whatsapp,
    });

    if (text && !whatsapp) {
      const detail = agentBooked ? "skipped: the assistant's reply was the confirmation" : "skipped: no customer record for this phone";
      log({ orgId, event: `appointment.${event}`, entity: "appointment", entityId: a.id }, [{ channel: "whatsapp", ok: false, detail }]);
      outcomes.push({ channel: "whatsapp", ok: false, detail });
    }

    if ((event === "booked" || event === "confirmed") && outcomes.some((o) => o.channel === "whatsapp" && o.ok)) {
      markConfirmationSent(a.id);
    }
    return outcomes;
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    try {
      audit({ orgId: "unknown", actorType: "system", action: "notify.failed", entity: "appointment", entityId: a.id, metadata: { event, detail } });
    } catch { /* the log must not be the thing that breaks */ }
    return [{ channel: "in_app", ok: false, detail }];
  }
}
