import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * What a staff user is allowed to see of the machinery behind the product.
 *
 * The setup page is a live probe of every vendor: which are wired, which
 * account each authenticated as, and which secrets are still unset. The last
 * of those is a target list. It belongs to whoever runs the deployment, not to
 * whoever uses it.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const SETUP = "src/app/(auth)/setup/page.tsx";
const SHELL = "src/components/shell.tsx";
const LAYOUT = "src/app/(app)/layout.tsx";

describe("the setup page is operators only", () => {
  const src = read(SETUP);

  test("it requires a permission, not merely a session", () => {
    assert.match(src, /getSession\(\)/);
    assert.match(src, /permissions\.has\("workflows\.manage"\)/);
  });

  test("the gate runs before any probe", () => {
    // A probe that ran first would reach every vendor on behalf of someone who
    // is about to be refused, and would leak timing besides.
    const gate = src.indexOf("permissions.has(");
    const probe = src.indexOf("checkSupabase()");
    assert.ok(gate > 0 && probe > 0, "expected both a gate and a probe");
    assert.ok(gate < probe, "the permission check must come before the probes");
  });

  test("refusal is a 404, not a 403", () => {
    // "You may not see this" confirms the page exists.
    assert.match(src, /notFound\(\)/);
    assert.doesNotMatch(src, /status:\s*403/);
  });

  test("it is still absent from the public paths", () => {
    // It was public once so it would work when auth itself was broken; the
    // cost was an anonymous inventory of unset secrets.
    const mw = read("src/middleware.ts");
    const list = mw.slice(mw.indexOf("const PUBLIC_PATHS"), mw.indexOf("];", mw.indexOf("const PUBLIC_PATHS")));
    assert.doesNotMatch(list, /^\s*"\/setup"/m);
  });
});

describe("the floating dock is gone", () => {
  test("the component no longer exists", () => {
    assert.doesNotMatch(read(SHELL), /LiquidDock/);
  });

  test("the app layout does not render it", () => {
    assert.doesNotMatch(read(LAYOUT), /LiquidDock/);
  });

  test("nothing links to /setup from the app chrome any more", () => {
    // The dock's fourth icon was a direct link to it.
    assert.doesNotMatch(read(SHELL), /href: "\/setup"/);
  });
});

describe("the other door into /setup", () => {
  const src = read("src/components/ops/home.tsx");

  test("the Diagnostics button is hidden without the permission", () => {
    // The page 404s without it, so showing the button to everyone else offers
    // a door that opens onto nothing.
    assert.match(src, /allowed\.has\("workflows\.manage"\) && \(/);
  });

  test("the gate wraps the link, not something near it", () => {
    const at = src.indexOf('allowed.has("workflows.manage") && (');
    const after = src.slice(at, at + 400);
    assert.match(after, /href="\/setup"/);
  });

  test("the capability count reads as English", () => {
    // "capability" + "ies" rendered as "capabilityies".
    assert.doesNotMatch(src, /capability\{/);
    assert.match(src, /"capability" : "capabilities"/);
  });
});
