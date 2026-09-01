/**
 * The legacy→real permission map, exported for tests.
 *
 * Lives beside the mapping rather than inside the route module so a test can
 * assert the translation table without importing Next-only server code.
 */
export const MAP_FOR_TEST: Record<string, string> = {
  "customer:read": "customers.read",
  "customer:write": "customers.write",
  "sales:read": "sales.read",
  "sales:write": "sales.write",
  "loan:read": "loans.read",
  "loan:write": "loans.write",
  "document:read": "documents.read",
  // No `document:download` — it aliased `documents.read`, which made the
  // download handler's second permission check incapable of failing. See the
  // note on MAP in src/lib/ops/auth.ts.
  "document:review": "documents.verify",
  "admin:read": "analytics.view",
  "admin:write": "users.manage",
  "config:write": "workflows.manage",
  "audit:read": "audit.view",
};
