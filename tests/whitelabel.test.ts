import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * White-label guard.
 *
 * Clients see Glentree, not the vendors behind it. This scans every screen and
 * component for a vendor name in something a person can read — JSX text, string
 * literals, placeholders — and fails on the first hit. Comments, import paths,
 * identifiers and env-var lookups are exempt because nobody outside the code
 * sees them. The admin diagnostics file is the one deliberate exception.
 */
const ROOT = process.cwd();
const SCAN = ["src/components", "src/app/(app)"];
const ADMIN_ONLY = new Set(["src/components/settings/admin-diagnostics.tsx"]);
const VENDOR = /\b(bolna|n8n|upload[- _]?post|uploadpost|groq|gemini|resend|supabase|orbit)\b/i;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

/** Text a person can read: string literals plus bare JSX text between tags. */
function readable(src: string): string[] {
  const out: string[] = [];
  // Attribute values nobody reads (class hooks, ids, urls) are not prose.
  src = src.replace(/\b(className|id|key|htmlFor|href|src|data-[\w-]+)=("[^"\n]*"|'[^'\n]*')/g, "");
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3]);
  // JSX text may interleave `{expr}`; drop the expressions and keep the prose around them.
  for (const m of src.matchAll(/>([^<>]+)</g)) out.push(m[1].replace(/\{[^}]*\}/g, " "));
  return out
    .map((t) => t.trim())
    .filter(Boolean)
    // Single words count too (<Badge>Bolna</Badge>). Only paths, ids and env keys
    // stay off-screen: "@/lib/bolna/x", "uploadpost:x", "BOLNA_API_KEY".
    .filter((t) => !/^[@./]/.test(t) && !/^[A-Z0-9_]+$/.test(t) && !(/[/:]/.test(t) && !/\s/.test(t)));
}

describe("vendor names never reach a non-admin screen", () => {
  const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)))
    .map((f) => path.relative(ROOT, f))
    .filter((f) => !ADMIN_ONLY.has(f));

  test("scans a meaningful set of files", () => {
    assert.ok(files.length > 20, `only ${files.length} files found`);
  });

  for (const f of files) {
    test(f, () => {
      const hits = readable(stripComments(fs.readFileSync(path.join(ROOT, f), "utf8")))
        .filter((t) => VENDOR.test(t));
      assert.deepEqual(hits, [], `vendor name in user-visible text: ${hits.join(" | ")}`);
    });
  }
});
