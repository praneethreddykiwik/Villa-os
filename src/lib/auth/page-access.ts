import type { Permission } from "./session";

/**
 * PAGE-LEVEL ACCESS MAP
 *
 * Every screen states the one permission it requires. Enforced once, in the app
 * layout, so a new page cannot ship without a decision — an unlisted path is
 * denied, not allowed.
 *
 * This exists because hiding a link is not access control. Before this map, a
 * receptionist who typed /dashboard directly reached live customer and revenue
 * data, even though the navigation never offered it.
 */
const RULES: Array<[RegExp, Permission]> = [
  // Operations
  [/^\/ops\/admin/, "analytics.view"],
  [/^\/ops\/sales/, "sales.read"],
  [/^\/ops\/loans/, "loans.read"],
  [/^\/ops\/customers/, "customers.read"],
  [/^\/ops\/messages/, "customers.read"],

  // Analytics and reporting — business performance, not everyone's business.
  [/^\/(dashboard|analytics|insights|reports|ads|activity)/, "analytics.view"],

  // Customer records. The contact directory is a lookup tool the front desk
  // genuinely needs; the pipeline, deal values and follow-up queue are sales
  // work and carry commercial information, so they need sales.read.
  [/^\/crm\/contacts/, "customers.read"],
  [/^\/crm\//, "sales.read"],
  [/^\/(engagement|reviews)/, "customers.read"],

  // Marketing surfaces
  [/^\/(composer|studio|ideas|calendar|board|local)/, "marketing.read"],

  // Configuration
  [/^\/(connections|settings)/, "workflows.manage"],
];

/**
 * Paths any signed-in person may open. The sign-in and setup screens are not
 * listed because they no longer live under this layout at all — they are in the
 * `(auth)` route group, which has no navigation to leak and no guard to loop on.
 */
const ALWAYS_ALLOWED = [/^\/ops$/, /^\/$/];

export function requiredPermissionFor(pathname: string): Permission | null | "allow" {
  if (ALWAYS_ALLOWED.some((r) => r.test(pathname))) return "allow";
  for (const [pattern, permission] of RULES) {
    if (pattern.test(pathname)) return permission;
  }
  // Unlisted paths are denied by default rather than quietly permitted.
  return null;
}
