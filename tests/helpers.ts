import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Every test file gets its own store and document directory. Sharing state
 * between suites is how test order becomes load-bearing, which is how a suite
 * stops catching regressions.
 */
export function isolate(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ops-${name}-`));
  process.env.OPS_DATA_DIR = path.join(dir, "data");
  process.env.OPS_DOCUMENT_DIR = path.join(dir, "documents");
  process.env.PLATFORM_DRIVER = "mock";
  process.env.WORKER_SECRET = "test-secret";
  process.env.OPS_SESSION_SECRET = "test-session-secret";
  delete process.env.ANTHROPIC_API_KEY; // deterministic extraction in tests
  return dir;
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A minimal PDF that passes the magic-byte and size checks. */
export function samplePdf(marker = "A"): Buffer {
  return Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
}
