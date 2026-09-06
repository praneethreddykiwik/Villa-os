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
  // Agent suites assert what the agent says, not that Meta accepted it. The mock
  // driver deliberately fails now, so tests opt into a stub transport instead.
  process.env.WHATSAPP_TRANSPORT = "stub";
  process.env.WORKER_SECRET = "test-secret";
  process.env.OPS_SESSION_SECRET = "test-session-secret";
  // Deterministic extraction in tests: no provider key may leak in from the shell.
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GROQ_API_KEY;
  delete process.env.GEMINI_API_KEY;
  // Notification suites stub fetch; nothing else may reach Resend or a real inbox.
  delete process.env.RESEND_API_KEY;
  // Org resolution must stay local: with a service-role key present it would
  // ask Supabase over the network and every fixture would land in another org.
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.NOTIFY_FROM_EMAIL;
  delete process.env.NOTIFY_EMAILS;
  // The WhatsApp knowledge base seeds from docs/glentree-facts.md on first use;
  // suites must not depend on what that file says today. A suite that wants
  // file seeding points KB_FACTS_PATH at its own fixture.
  process.env.KB_FACTS_PATH = "";
  return dir;
}

export function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A minimal PDF that passes the magic-byte and size checks. */
export function samplePdf(marker = "A"): Buffer {
  return Buffer.from(`%PDF-1.4\n%${marker}\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`);
}

/**
 * Team fixture.
 *
 * The application no longer provisions a roster of its own — real staff are
 * Supabase Auth users created by `npm run provision-users`, and the assignment
 * engine reads them from there. The suites below still need a deterministic set
 * of assignees to exercise round-robin and least-loaded routing, so they build
 * their own here. Test data belongs in the test, not in the shipped bootstrap.
 */
export function seedTeam(orgId: string): void {
  const { mutate } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { uid } = require("../src/lib/ids") as typeof import("../src/lib/ids");
  const now = new Date().toISOString();
  const roster = [
    { name: "Team Admin", email: "admin@test.invalid", role: "ADMIN" as const, capacity: 999 },
    { name: "Sales Manager 1", email: "sales1@test.invalid", role: "SALES_MANAGER" as const, capacity: 25 },
    { name: "Sales Manager 2", email: "sales2@test.invalid", role: "SALES_MANAGER" as const, capacity: 25 },
    { name: "Sales Manager 3", email: "sales3@test.invalid", role: "SALES_MANAGER" as const, capacity: 25 },
    { name: "Loan Officer 1", email: "loan1@test.invalid", role: "LOAN_OFFICER" as const, capacity: 20 },
    { name: "Loan Officer 2", email: "loan2@test.invalid", role: "LOAN_OFFICER" as const, capacity: 20 },
    { name: "Loan Officer 3", email: "loan3@test.invalid", role: "LOAN_OFFICER" as const, capacity: 20 },
  ];
  mutate((d) => {
    if (d.teamMembers.some((m) => m.orgId === orgId)) return;
    d.teamMembers.push(
      ...roster.map((r) => ({ id: uid("mem"), orgId, active: true, createdAt: now, ...r })),
    );
  });
}
