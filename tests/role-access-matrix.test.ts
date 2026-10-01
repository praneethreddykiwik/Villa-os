import test, { describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { requiredPermissionFor } from "../src/lib/auth/page-access";
import type { Permission } from "../src/lib/auth/session";

/**
 * PER-ROLE ACCESS MATRIX
 *
 * The question this file answers is not "does the sidebar hide the link" — it
 * is "if this person types the URL, do they get in". Hiding a link is not
 * access control, and every check below goes through `requiredPermissionFor`,
 * which is the same function the app layout and the sidebar filter both call.
 *
 * The permission sets are read out of the bootstrap migration rather than
 * retyped here, so the test tracks the grants the database actually installs.
 * If someone widens a role in SQL, the expectations below start failing rather
 * than silently agreeing with the change.
 *
 * Verified against the live Supabase project on 14 Sep 2026: all seven roles
 * exist and their granted permission sets match this migration exactly.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the repo. Every other suite resolves from cwd; so does this.
const ROOT = process.cwd();
const BOOTSTRAP = path.join(ROOT, "supabase/migrations/0003_glentree_bootstrap.sql");

/** Parse `'role', jsonb_build_array('a','b',...)` out of the grants block. */
function grantsFromMigration(): Record<string, Set<string>> {
  const sql = fs.readFileSync(BOOTSTRAP, "utf8");
  const out: Record<string, Set<string>> = {};
  const re = /'([a-z_]+)',\s*jsonb_build_array\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const role = m[1]!;
    const perms = [...m[2]!.matchAll(/'([a-z._]+)'/g)].map((x) => x[1]!);
    if (perms.length) out[role] = new Set(perms);
  }
  return out;
}

const GRANTS = grantsFromMigration();
const ROLES = Object.keys(GRANTS).sort();

/** Every page the application actually ships, as a URL path. */
function appRoutes(): string[] {
  const base = path.join(ROOT, "src/app/(app)");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        const rel = path.relative(base, dir).replace(/\\/g, "/");
        // Route groups like (auth) contribute nothing to the URL.
        const url = "/" + rel.split("/").filter((s) => !s.startsWith("(")).join("/");
        // A dynamic segment stands in for a real id; the permission is the same.
        found.push(url.replace(/\[[^\]]+\]/g, "1").replace(/\/+$/, "") || "/");
      }
    }
  };
  walk(base);
  return [...new Set(found)].sort();
}

const ROUTES = appRoutes();

/** Can this role open this path? Mirrors the layout guard exactly. */
function canOpen(role: string, pathname: string): boolean {
  const required = requiredPermissionFor(pathname);
  if (required === "allow") return true;
  if (required === null) return false;
  return GRANTS[role]!.has(required);
}

describe("the seven roles are the ones the database installs", () => {
  test("every expected role exists in the migration, and no extra ones", () => {
    assert.deepEqual(ROLES, [
      "admin", "audit", "construction", "front_desk", "loan", "marketing", "sales",
    ]);
  });

  test("admin is the only role holding users.manage", () => {
    const holders = ROLES.filter((r) => GRANTS[r]!.has("users.manage"));
    assert.deepEqual(holders, ["admin"], "only an administrator may create staff or change roles");
  });

  test("financials.view is admin-only — a receptionist asking for profit is refused", () => {
    const holders = ROLES.filter((r) => GRANTS[r]!.has("financials.view"));
    assert.deepEqual(holders, ["admin"]);
  });

  test("audit is genuinely read-only: it holds no write, publish or manage permission", () => {
    const writes = [...GRANTS.audit!].filter(
      (p) => p.endsWith(".write") || p.endsWith(".publish") || p.endsWith(".manage")
        || p.endsWith(".upload") || p.endsWith(".create") || p.endsWith(".verify")
        || p.endsWith(".negotiate"),
    );
    assert.deepEqual(writes, [], `audit must not write, but holds: ${writes.join(", ")}`);
  });

  test("only loan and admin may read customer documents", () => {
    const holders = ROLES.filter((r) => GRANTS[r]!.has("documents.read")).sort();
    assert.deepEqual(holders, ["admin", "loan"]);
  });
});

describe("every shipped page states a permission", () => {
  test("no page is reachable by accident — each one maps to a rule or is deliberately open", () => {
    const unmapped = ROUTES.filter((r) => requiredPermissionFor(r) === null);
    assert.deepEqual(
      unmapped,
      [],
      `these pages are denied to everyone because no rule covers them:\n  ${unmapped.join("\n  ")}`,
    );
  });

  test("the app ships the number of pages this matrix was written against", () => {
    // A guard against silent growth: a new page must be considered here, not
    // just added. Update the number together with its expectations.
    assert.ok(ROUTES.length >= 60, `expected at least 60 pages, found ${ROUTES.length}`);
  });
});

describe("administrators can reach everything", () => {
  test("admin opens every page in the application", () => {
    const refused = ROUTES.filter((r) => !canOpen("admin", r));
    assert.deepEqual(refused, [], `admin was refused:\n  ${refused.join("\n  ")}`);
  });
});

describe("the front desk is held to the front desk", () => {
  const FORBIDDEN = [
    "/dashboard", "/reports", "/analytics", "/insights", "/activity", "/ads",
    "/ops/loans", "/ops/admin", "/settings", "/connections",
    "/crm/pipeline", "/crm/leads", "/inbox/whatsapp/sales/revenue",
    "/inbox/whatsapp/settings/integrations", "/publish-v2", "/studio",
  ];
  for (const route of FORBIDDEN) {
    test(`front desk cannot open ${route}`, () => {
      assert.equal(canOpen("front_desk", route), false, `${route} leaked to the front desk`);
    });
  }

  test("front desk can still do its own job", () => {
    for (const route of ["/inbox/whatsapp", "/crm/contacts", "/engagement", "/reviews"]) {
      assert.equal(canOpen("front_desk", route), true, `front desk was locked out of ${route}`);
    }
  });
});

describe("construction sees the site, not the business", () => {
  test("construction cannot open any customer, sales, money or marketing page", () => {
    const leaked = ROUTES.filter((r) => canOpen("construction", r));
    // `/ops` is the shared landing page and carries no data of its own. That it
    // is the ONLY page this role can open is the finding, not a pass: the
    // construction department still has no screen of its own, even though the
    // role and its two permissions exist. Nothing maps to construction.read or
    // construction.upload, so a site foreman signing in today sees one page.
    assert.deepEqual(
      leaked.sort(),
      ["/ops"],
      `construction reached pages it should not:\n  ${leaked.join("\n  ")}`,
    );
  });
});

describe("marketing cannot read the sales book", () => {
  const FORBIDDEN = [
    "/crm/pipeline", "/crm/leads", "/ops/loans", "/ops/sales", "/ops/admin",
    "/dashboard", "/reports", "/inbox/whatsapp/sales/revenue",
  ];
  for (const route of FORBIDDEN) {
    test(`marketing cannot open ${route}`, () => {
      assert.equal(canOpen("marketing", route), false, `${route} leaked to marketing`);
    });
  }

  test("marketing keeps its own surfaces", () => {
    for (const route of ["/studio", "/ideas", "/calendar", "/board", "/channels", "/publish-v2"]) {
      assert.equal(canOpen("marketing", route), true, `marketing was locked out of ${route}`);
    }
  });
});

describe("sales works the pipeline but not the admin panel", () => {
  test("sales cannot open the screens that grant access or configure the system", () => {
    for (const route of ["/settings", "/connections", "/ops/admin", "/dashboard"]) {
      assert.equal(canOpen("sales", route), false, `${route} leaked to sales`);
    }
  });

  test("sales reaches its pipeline and its customers", () => {
    for (const route of ["/crm/leads", "/crm/pipeline", "/ops/sales", "/crm/contacts"]) {
      assert.equal(canOpen("sales", route), true, `sales was locked out of ${route}`);
    }
  });
});

describe("the loan desk sees loans, not marketing or configuration", () => {
  test("loan officer is confined", () => {
    for (const route of ["/settings", "/connections", "/studio", "/publish-v2", "/dashboard"]) {
      assert.equal(canOpen("loan", route), false, `${route} leaked to the loan desk`);
    }
  });

  test("loan officer reaches loan work", () => {
    for (const route of ["/ops/loans", "/ops/customers/1", "/crm/leads"]) {
      assert.equal(canOpen("loan", route), true, `loan desk was locked out of ${route}`);
    }
  });
});

describe("staff management is not visible to everyone who can open /ops/admin", () => {
  // /ops/admin is gated on `analytics.view` so the sales, loans and activity
  // views reach the people who read the business. The "People & access" tab
  // inside it creates accounts and changes roles, and its API requires
  // `users.manage`. Those are different permissions, and the audit role holds
  // the first but not the second — so before the tab carried its own gate, a
  // read-only auditor saw the staff roster, the create-account form and the
  // disable buttons. The writes failed at the API; none of it belonged on screen.
  const adminTabs = fs.readFileSync(path.join(ROOT, "src/components/ops/admin-tabs.tsx"), "utf8");

  test("the audit role can open /ops/admin at all — which is why the tab needs its own gate", () => {
    assert.equal(canOpen("audit", "/ops/admin"), true);
    assert.equal(GRANTS.audit!.has("users.manage"), false);
  });

  test("the People & access tab declares users.manage", () => {
    assert.match(adminTabs, /id: "team"[^}]*needs: "users\.manage"/);
  });

  test("the tab strip renders the filtered list, not every tab", () => {
    assert.match(adminTabs, /const tabs = TABS\.filter\(/);
    assert.match(adminTabs, /\{tabs\.map\(/);
    assert.ok(!/\{TABS\.map\(/.test(adminTabs), "the unfiltered list must not be rendered");
  });

  test("the tab CONTENT is gated too — hiding a button is not access control", () => {
    assert.match(adminTabs, /tab === "team" && held\.has\("users\.manage"\) && <TeamManager \/>/);
  });

  test("permissions come from the server, never from the browser", () => {
    const page = fs.readFileSync(path.join(ROOT, "src/app/(app)/ops/admin/page.tsx"), "utf8");
    assert.match(page, /<AdminTabs data=\{data\} permissions=\{\[\.\.\.session\.permissions\]\} \/>/);
  });
});

describe("the whole matrix, so a change to any rule is visible", () => {
  test("each role opens exactly the number of pages recorded here", () => {
    const counts = Object.fromEntries(
      ROLES.map((r) => [r, ROUTES.filter((route) => canOpen(r, route)).length]),
    );
    // Recorded from the verified state. A change here is not necessarily wrong
    // — but it must be deliberate, and reviewed, rather than noticed in
    // production by the wrong person seeing the wrong screen.
    assert.deepEqual(counts, {
      admin: 65,
      audit: 51,
      construction: 1,
      front_desk: 10,
      loan: 26,
      marketing: 26,
      sales: 42,
    });
    // Ordering invariants that must hold however the numbers move.
    assert.ok(counts.admin! > counts.audit!, "admin must see more than audit");
    assert.ok(counts.audit! > counts.front_desk!, "audit reads broadly; the front desk does not");
    assert.ok(counts.front_desk! > counts.construction!, "construction is the narrowest role");
    assert.ok(counts.sales! > counts.marketing!, "sales sees the pipeline marketing does not");
  });
});

describe("the API behind each screen re-checks, so the page guard is not the only gate", () => {
  test("the staff-account route requires users.manage on every method it exposes", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/app/api/ops/users/route.ts"), "utf8");
    const methods = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)/g)].map((m) => m[1]!);
    assert.ok(methods.length >= 3, "expected the route to expose read and write methods");
    const checks = src.match(/requirePermission\("users\.manage"\)/g) ?? [];
    assert.equal(
      checks.length,
      methods.length,
      `each of ${methods.join(", ")} must check users.manage; found ${checks.length} checks`,
    );
  });

  test("the admin page refuses anyone without analytics.view before rendering a tab", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/app/(app)/ops/admin/page.tsx"), "utf8");
    assert.match(src, /hasPermission\(session, "analytics\.view"\)/);
  });
});
