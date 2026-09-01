import { mutate, read } from "../db";
import { uid } from "../ids";
import { audit, notify } from "./audit";
import { getCase, refreshCaseProgress, updateChecklistItem } from "./loan";
import { buildStorageKey, documentStore, sha256, validateUpload } from "./storage";
import type { DocumentEvent, DocumentRecord } from "./types";

/**
 * DOCUMENT LIFECYCLE
 *
 * received → under review → accepted | rejected → (replacement) → …
 *
 * The hard rule this module enforces: **only a human review sets ACCEPTED.**
 * Receiving a file marks it UPLOADED and nothing more. The assistant may say
 * "received"; it may not say "accepted", because until an officer looks at it,
 * nobody knows whether the photo is legible or the statement is the right month.
 */

function event(e: Omit<DocumentEvent, "id" | "createdAt">): DocumentEvent {
  const ev: DocumentEvent = { ...e, id: uid("dev"), createdAt: new Date().toISOString() };
  mutate((db) => void db.documentEvents.push(ev));
  return ev;
}

export interface ReceiveInput {
  orgId: string;
  customerId: string;
  filename: string;
  mimeType: string;
  data: Buffer;
  checklistItemId?: string;
  loanCaseId?: string;
  uploadedBy: DocumentRecord["uploadedBy"];
  uploadedById?: string;
}

export type ReceiveResult =
  | { ok: true; document: DocumentRecord; duplicate: boolean; checklistItemId?: string }
  | { ok: false; error: string };

/**
 * Store an inbound document and link it to a checklist item.
 *
 * Deduplicates by content hash within a customer: WhatsApp redelivers media on
 * webhook retries, and a duplicate must not appear as a second submission or
 * reset a review that already happened.
 */
export async function receiveDocument(input: ReceiveInput): Promise<ReceiveResult> {
  const db = read();
  const item = input.checklistItemId ? db.checklistItems.find((i) => i.id === input.checklistItemId) : undefined;

  const invalid = validateUpload(input.mimeType, input.data.byteLength, item?.acceptedFormats);
  if (invalid) return { ok: false, error: invalid };

  const hash = sha256(input.data);
  const duplicate = db.documents.find((d) => d.customerId === input.customerId && d.sha256 === hash);
  if (duplicate) {
    event({
      orgId: input.orgId,
      documentId: duplicate.id,
      event: "RECEIVED",
      actorType: input.uploadedBy === "customer" ? "customer" : "human",
      actorId: input.uploadedById,
      detail: "Duplicate of an already-received file — ignored",
    });
    return { ok: true, document: duplicate, duplicate: true, checklistItemId: duplicate.checklistItemId };
  }

  const documentId = uid("doc");
  const storageKey = buildStorageKey(input.customerId, documentId, input.filename);

  let stored;
  try {
    stored = await documentStore().put(storageKey, input.data);
  } catch (e) {
    // Never record a document row for a file that is not actually stored.
    return { ok: false, error: `Storage failed: ${(e as Error).message}` };
  }

  const loanCaseId = input.loanCaseId ?? item?.loanCaseId;
  const record: DocumentRecord = {
    id: documentId,
    orgId: input.orgId,
    customerId: input.customerId,
    loanCaseId,
    checklistItemId: input.checklistItemId,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: stored.sizeBytes,
    storageKey: stored.key,
    sha256: stored.sha256,
    uploadedBy: input.uploadedBy,
    uploadedById: input.uploadedById,
    status: "RECEIVED",
    createdAt: new Date().toISOString(),
  };

  mutate((db2) => void db2.documents.push(record));
  event({
    orgId: input.orgId,
    documentId,
    event: "RECEIVED",
    actorType: input.uploadedBy === "customer" ? "customer" : "human",
    actorId: input.uploadedById,
    detail: `${input.filename} (${Math.round(stored.sizeBytes / 1024)}KB)`,
  });
  audit({
    orgId: input.orgId,
    actorId: input.uploadedById,
    actorType: input.uploadedBy === "customer" ? "customer" : "human",
    action: "document.received",
    entity: "document",
    entityId: documentId,
    customerId: input.customerId,
    metadata: { filename: input.filename, checklistItemId: input.checklistItemId, loanCaseId },
  });

  if (item) {
    // UPLOADED, not ACCEPTED. A human decides acceptance.
    mutate((db2) => {
      const i = db2.checklistItems.find((x) => x.id === item.id);
      if (i) {
        i.currentDocumentId = documentId;
        i.status = "UPLOADED";
        i.rejectionReason = undefined;
        i.updatedAt = new Date().toISOString();
      }
    });
    event({ orgId: input.orgId, documentId, event: "LINKED", actorType: "system", detail: item.documentType });

    const loanCase = loanCaseId ? getCase(loanCaseId) : undefined;
    notify({
      orgId: input.orgId,
      recipientId: loanCase?.assignedOfficerId,
      recipientRole: loanCase?.assignedOfficerId ? undefined : "LOAN_OFFICER",
      category: "LOAN",
      event: "document.uploaded",
      title: `Document received: ${item.customerLabel}`,
      body: "Waiting for review.",
      customerId: input.customerId,
      severity: "INFO",
    });
    if (loanCaseId) refreshCaseProgress(loanCaseId, { type: "system" });
  }

  return { ok: true, document: record, duplicate: false, checklistItemId: input.checklistItemId };
}

/** Human review. This is the only path to ACCEPTED. */
export function reviewDocument(
  documentId: string,
  decision: "ACCEPTED" | "REJECTED",
  reviewer: { id: string; type: "human" },
  rejectionReason?: string,
): { ok: true; document: DocumentRecord } | { ok: false; error: string } {
  const doc = read().documents.find((d) => d.id === documentId);
  if (!doc) return { ok: false, error: "Document not found" };
  if (decision === "REJECTED" && !rejectionReason?.trim()) {
    // A rejection without a reason is unactionable for the customer, and the
    // assistant would have nothing to tell them.
    return { ok: false, error: "A rejection reason is required" };
  }

  const now = new Date().toISOString();
  const updated = mutate((db) => {
    const d = db.documents.find((x) => x.id === documentId);
    if (!d) return null;
    d.status = decision;
    d.reviewedById = reviewer.id;
    d.reviewedAt = now;
    d.rejectionReason = decision === "REJECTED" ? rejectionReason : undefined;
    return { ...d };
  });
  if (!updated) return { ok: false, error: "Document not found" };

  event({
    orgId: updated.orgId,
    documentId,
    event: decision,
    actorType: "human",
    actorId: reviewer.id,
    detail: rejectionReason,
  });
  audit({
    orgId: updated.orgId,
    actorId: reviewer.id,
    actorType: "human",
    action: decision === "ACCEPTED" ? "document.accepted" : "document.rejected",
    entity: "document",
    entityId: documentId,
    customerId: updated.customerId,
    metadata: { rejectionReason, checklistItemId: updated.checklistItemId },
  });

  if (updated.checklistItemId) {
    updateChecklistItem(
      updated.checklistItemId,
      decision === "ACCEPTED"
        ? { status: "ACCEPTED", rejectionReason: undefined }
        : { status: "REJECTED", rejectionReason },
      { id: reviewer.id, type: "human" },
    );
  }

  return { ok: true, document: updated };
}

export function documentsFor(customerId: string): DocumentRecord[] {
  return read()
    .documents.filter((d) => d.customerId === customerId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function documentTimeline(documentId: string): DocumentEvent[] {
  return read()
    .documentEvents.filter((e) => e.documentId === documentId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function recordDownload(documentId: string, memberId: string, orgId: string): void {
  event({ orgId, documentId, event: "DOWNLOADED", actorType: "human", actorId: memberId });
  audit({
    orgId,
    actorId: memberId,
    actorType: "human",
    action: "document.downloaded",
    entity: "document",
    entityId: documentId,
    metadata: {},
  });
}
