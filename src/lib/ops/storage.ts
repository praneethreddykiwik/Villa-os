import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * DOCUMENT STORAGE
 *
 * Customer identity documents, bank statements and tax returns must never be
 * reachable by URL guessing, and must never live under `public/`.
 *
 * This module stores them outside the served tree and hands out short-lived,
 * HMAC-signed URLs that are re-authorised on every access. The `DocumentStore`
 * interface is the seam: swapping in S3 or Supabase Storage means implementing
 * four methods, and the signed-URL contract stays identical.
 */

export interface StoredObject {
  key: string;
  sizeBytes: number;
  sha256: string;
}

export interface DocumentStore {
  put(key: string, data: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

/** Local filesystem store. `.private/` is outside `public/` and gitignored. */
export class LocalDocumentStore implements DocumentStore {
  constructor(
    private readonly root = process.env.OPS_DOCUMENT_DIR
      ? path.resolve(process.env.OPS_DOCUMENT_DIR)
      : process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
      ? path.join("/tmp", ".private", "documents")
      : path.join(process.cwd(), ".private", "documents"),
  ) {}

  private resolve(key: string): string {
    // Reject traversal explicitly rather than relying on the caller: a key of
    // "../../.env" must never resolve outside the store root.
    if (!/^[a-zA-Z0-9._/-]+$/.test(key) || key.includes("..")) {
      throw new Error("Invalid storage key");
    }
    const full = path.join(this.root, key);
    if (!full.startsWith(this.root)) throw new Error("Path traversal rejected");
    return full;
  }

  async put(key: string, data: Buffer): Promise<StoredObject> {
    const full = this.resolve(key);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, data, { mode: 0o600 });
    return { key, sizeBytes: data.byteLength, sha256: sha256(data) };
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.promises.readFile(this.resolve(key));
    } catch {
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.promises.unlink(this.resolve(key));
    } catch {
      /* already gone */
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

let store: DocumentStore = new LocalDocumentStore();

/** Swap the backend (S3, Supabase Storage) without touching call sites. */
export function setDocumentStore(next: DocumentStore): void {
  store = next;
}
export function documentStore(): DocumentStore {
  return store;
}

export function sha256(data: Buffer): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/* -------------------------------------------------------------------------- */
/* Signed URLs                                                                 */
/* -------------------------------------------------------------------------- */

function signingSecret(): string {
  const s = process.env.OPS_DOCUMENT_SECRET ?? process.env.OPS_SESSION_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("OPS_DOCUMENT_SECRET must be set in production");
    }
    return "dev-only-insecure-document-secret";
  }
  return s;
}

export interface SignedRef {
  documentId: string;
  expiresAt: number;
  signature: string;
}

/**
 * Sign a short-lived reference to a document.
 *
 * The signature binds the document id, the expiry AND the requesting member, so
 * a link leaked from one person's browser cannot be replayed by another. The
 * download route still re-checks permissions server-side — the signature is a
 * second lock, not the only one.
 */
export function signDocumentRef(documentId: string, memberId: string, ttlSeconds = 300): string {
  const expiresAt = Date.now() + ttlSeconds * 1000;
  const payload = `${documentId}.${memberId}.${expiresAt}`;
  const signature = crypto.createHmac("sha256", signingSecret()).update(payload).digest("base64url");
  return `${expiresAt}.${signature}`;
}

export function verifyDocumentRef(documentId: string, memberId: string, token: string | null): boolean {
  if (!token) return false;
  const [expiresRaw, signature] = token.split(".");
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = crypto
    .createHmac("sha256", signingSecret())
    .update(`${documentId}.${memberId}.${expiresAt}`)
    .digest("base64url");
  const a = Buffer.from(signature ?? "");
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Keys are opaque and unguessable; the customer id is a folder, not a secret. */
export function buildStorageKey(customerId: string, documentId: string, filename: string): string {
  const ext = (filename.split(".").pop() ?? "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  return `${customerId}/${documentId}.${ext || "bin"}`;
}

export const ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/webp",
]);

export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

/** Reject anything we are not prepared to store or render, with a clear reason. */
export function validateUpload(mimeType: string, sizeBytes: number, acceptedFormats?: string[]): string | null {
  if (!ALLOWED_MIME.has(mimeType)) return `Unsupported file type: ${mimeType}`;
  if (sizeBytes > MAX_DOCUMENT_BYTES) return `File is larger than ${Math.round(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB`;
  if (sizeBytes <= 0) return "File is empty";
  if (acceptedFormats?.length) {
    const ext = mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1];
    const ok = acceptedFormats.some((f) => f.toLowerCase() === ext || (f === "jpg" && ext === "jpeg"));
    if (!ok) return `This item accepts ${acceptedFormats.join(", ")}`;
  }
  return null;
}
