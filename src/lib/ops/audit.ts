import { mutate } from "../db";
import { uid } from "../ids";
import type { AuditEvent, OpsNotification, Role } from "./types";

/**
 * AUDIT LOG — append-only.
 *
 * Nothing in the application updates or deletes an audit row; the only write
 * path is `audit()`. That is what makes it usable as evidence when someone asks
 * "who rejected this document, and when?" months later.
 *
 * Audit is deliberately separate from the user-facing activity feed: the feed is
 * curated and can be filtered, the audit log records everything.
 */
export function audit(e: {
  orgId: string;
  actorId?: string;
  actorType: AuditEvent["actorType"];
  action: string;
  entity: string;
  entityId: string;
  customerId?: string;
  metadata?: Record<string, unknown>;
}): AuditEvent {
  const event: AuditEvent = {
    id: uid("aud"),
    orgId: e.orgId,
    actorId: e.actorId,
    actorType: e.actorType,
    action: e.action,
    entity: e.entity,
    entityId: e.entityId,
    customerId: e.customerId,
    metadata: e.metadata ?? {},
    createdAt: new Date().toISOString(),
  };
  mutate((db) => void db.auditEvents.push(event));
  return event;
}

export function notify(n: {
  orgId: string;
  recipientId?: string;
  recipientRole?: Role;
  category: OpsNotification["category"];
  event: string;
  title: string;
  body: string;
  customerId?: string;
  severity?: OpsNotification["severity"];
}): OpsNotification {
  const notification: OpsNotification = {
    id: uid("ntf"),
    orgId: n.orgId,
    recipientId: n.recipientId,
    recipientRole: n.recipientRole,
    category: n.category,
    event: n.event,
    title: n.title,
    body: n.body,
    customerId: n.customerId,
    severity: n.severity ?? "INFO",
    read: false,
    createdAt: new Date().toISOString(),
  };
  mutate((db) => void db.opsNotifications.push(notification));
  return notification;
}
