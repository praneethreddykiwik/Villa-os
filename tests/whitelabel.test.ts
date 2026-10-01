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
// The WhatsApp workspace lives under src/app/(app)/inbox/whatsapp, so the whole
// ported console is swept by this guard rather than sitting outside it.
const SCAN = ["src/components", "src/app/(app)"];
// Previously held src/components/settings/admin-diagnostics.tsx, a card whose
// entire purpose was listing which supplier sits behind each product name. It
// was gated on an environment flag, which made it one deleted condition away
// from being the worst leak in the product. The file is gone, so the guard has
// no exceptions left — which is the state it should stay in.
const ADMIN_ONLY = new Set<string>();
// Widened when the WhatsApp workspace was folded in: that console was built
// against a different set of providers, and every one of them is a name the
// client must not meet.
const VENDOR =
  /\b(bolna|n8n|upload[- _]?post|uploadpost|groq|gemini|resend|supabase|orbit|anthropic|claude|whisper|baileys|evolution ?api|twilio|openai|sendgrid)\b/i;

/**
 * Infrastructure a client must never read.
 *
 * `ENV_NAME` is deliberately narrow — SCREAMING_SNAKE with a known prefix or
 * suffix — so ordinary constants (`PRIORITY_TONE`, `MAX_BYTES`) and status
 * enums shouted by an API (`UNDER_REVIEW`, `GREEN`) do not trip it. Widen the
 * prefix list rather than loosening the shape when a new provider lands.
 */
const ENV_NAME =
  /\b(?:WHATSAPP|META|SUPABASE|NEXT_PUBLIC|OSF|GROQ|ANTHROPIC|GEMINI|EVOLUTION|BOLNA|N8N|CRON|RESEND|WORKER|UPLOAD_POST|DASHBOARD|AUTH_MODE|PUBLIC_BASE_URL|LLM|AI_PROVIDER|PLATFORM_DRIVER|SALES_TEAM|TIKTOK|LINKEDIN|TWITTER)_[A-Z0-9_]+\b|\bGOOGLE(?:_ADS)?_(?:CLIENT_ID|CLIENT_SECRET|DEVELOPER_TOKEN|API_KEY)\b|\b[A-Z][A-Z0-9]{3,}(?:_[A-Z0-9]+)*_(?:API_KEY|SECRET|TOKEN|PASSWORD|SERVICE_ROLE_KEY|ANON_KEY)\b|\bPUBLIC_BASE_URL\b|\bDASHBOARD_PASSWORD\b|\bCRON_SECRET\b|\bAUTH_MODE\b/;
/** Where secrets, schema and source live on the server. */
const SECRET_PATH = /\.env(?:\.local)?\b|supabase\/migrations|\b\d{3,4}_[\w-]+\.sql\b|\bnpm run \b|\bsrc\/lib\//;
/**
 * A provider-issued identifier printed into prose — "id 1372518445937587".
 * Only flagged next to an id word, so prices, counts and dates are left alone.
 */
const INTERNAL_ID = /\b(?:id|ID|Id)\s*[:=]?\s*\d{8,}\b/;

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

/**
 * Text a person can read: string literals plus bare JSX text between tags.
 *
 * `keepShouty` keeps bare SCREAMING_SNAKE literals, which the vendor sweep drops
 * as code values but which are exactly what the infrastructure sweep hunts for.
 */
function readable(src: string, keepShouty = false): string[] {
  const out: string[] = [];
  // Attribute values nobody reads (class hooks, ids, urls) are not prose.
  src = src.replace(/\b(className|id|key|htmlFor|href|src|data-[\w-]+)=("[^"\n]*"|'[^'\n]*')/g, "");
  // A string being COMPARED against is a code value, not a label. `provider ===
  // "groq"` decides which branch runs; the branch's own text is what a person
  // reads, and that is still scanned.
  src = src.replace(/[=!]==\s*("[^"\n]*"|'[^'\n]*')/g, "=== 0");
  for (const m of src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3]);
  // JSX text may interleave `{expr}`; drop the expressions and keep the prose around them.
  // `>...<` catches JSX prose, but it also spans arrow bodies and generics in
  // ordinary code (`=> (...)`, `Array<...>`), which swept whole server functions
  // in as "text". Anything carrying statement punctuation is code, not prose.
  for (const m of src.matchAll(/>([^<>]+)</g)) {
    const text = m[1].replace(/\{[^}]*\}/g, " ");
    if (/[;{}]|=>|\.\w+\(/.test(text)) continue;
    out.push(text);
  }
  return out
    .map((t) => t.trim())
    .filter(Boolean)
    // Single words count too (<Badge>Bolna</Badge>). Only paths, ids and env keys
    // stay off-screen: "@/lib/bolna/x", "uploadpost:x", "BOLNA_API_KEY".
    .filter((t) => !/^[@./]/.test(t) && (keepShouty || !/^[A-Z0-9_]+$/.test(t)) && !(/[/:]/.test(t) && !/\s/.test(t)))
    // A bare filename passed as an argument (`migration: "001_schema.sql"`) is a
    // code value. What a person reads is the sentence built around it, and that
    // sentence is sanitised where it is rendered.
    .filter((t) => !/^[\w.-]+\.(?:sql|md|ts|tsx|js|json|css)$/.test(t));
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

describe("infrastructure detail never reaches a non-admin screen", () => {
  const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)))
    .map((f) => path.relative(ROOT, f))
    .filter((f) => !ADMIN_ONLY.has(f));

  for (const f of files) {
    test(f, () => {
      const text = readable(stripComments(fs.readFileSync(path.join(ROOT, f), "utf8")), true);
      const hits = text.filter((t) => ENV_NAME.test(t) || SECRET_PATH.test(t) || INTERNAL_ID.test(t));
      assert.deepEqual(
        hits,
        [],
        `env-var name, secret path or provider id in user-visible text: ${hits.join(" | ")}`,
      );
    });
  }
});
