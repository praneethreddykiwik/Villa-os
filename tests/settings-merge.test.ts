import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

/**
 * Settings and "Villa profile" were one subject behind two sidebar entries.
 *
 * The split was never meaningful to anyone using it: the business's own
 * details sat in one and the hours its agents work sat in the other, and the
 * only way to learn which to open was to open both. They are tabs of one
 * screen now, and these assertions keep them that way.
 */
describe("settings is one screen", () => {
  test("the villa-profile tabs live under /settings", () => {
    for (const tab of ["properties", "whatsapp", "voice"]) {
      assert.ok(exists(`src/app/(app)/settings/${tab}/page.tsx`), `/settings/${tab} should exist`);
      assert.ok(
        !exists(`src/app/(app)/settings/villa/${tab}/page.tsx`),
        `/settings/villa/${tab} should have moved, not been copied`,
      );
    }
  });

  test("the old paths redirect rather than 404", () => {
    // These were in the navigation for weeks. A bookmark or a link in a
    // message should land on the screen it used to open.
    assert.match(read("src/app/(app)/settings/villa/page.tsx"), /redirect\("\/settings"\)/);
    const catchAll = read("src/app/(app)/settings/villa/[...rest]/page.tsx");
    assert.match(catchAll, /redirect\(/);
    // Segments arrive decoded; re-encoding keeps a stray slash from changing
    // which path this resolves to.
    assert.match(catchAll, /encodeURIComponent/);
  });

  test("the sidebar offers one Settings, not two entries for one subject", () => {
    const catalogue = read("src/lib/access/tab-catalogue.ts");
    assert.ok(catalogue.includes('{ href: "/settings", label: "Settings" }'));
    assert.ok(
      !/href: "\/settings\/villa"/.test(catalogue),
      "Villa profile should no longer be its own sidebar entry",
    );
  });

  test("every tab in the strip is a real page", () => {
    const tabs = read("src/components/settings/villa-tabs.tsx");
    const hrefs = [...tabs.matchAll(/href: "(\/settings[^"]*)"/g)].map((m) => m[1]!);
    assert.ok(hrefs.length >= 4, "expected the four settings tabs");
    for (const href of hrefs) {
      const rel = href === "/settings" ? "" : href.replace("/settings/", "/");
      assert.ok(
        exists(`src/app/(app)/settings${rel}/page.tsx`),
        `${href} is in the tab strip but has no page`,
      );
    }
  });
});

/**
 * The WhatsApp tab is what the assistant knows, not how it is plumbed.
 *
 * It used to open with a go-live checklist and a number health card, rendered
 * with no permission check at all. Between them they named the messaging
 * vendor, the AI vendor and the hosting arrangement, and printed raw API error
 * bodies with their status codes — to every signed-in person.
 */
describe("the client never meets the plumbing", () => {
  const page = () => read("src/app/(app)/settings/whatsapp/page.tsx");

  test("the knowledge base is on the WhatsApp tab", () => {
    assert.match(page(), /<KnowledgeEditor/);
  });

  test("the connection diagnostics are not", () => {
    const src = page();
    assert.ok(!/whatsappReadiness/.test(src), "the go-live checklist leaks vendor names");
    assert.ok(!/WhatsAppHealthCard/.test(src), "the health card leaks provider ids and status codes");
  });

  test("the restored status panel uses its own words, never the checks' own", () => {
    // It derives from the same readiness checks, so the guarantee cannot be
    // "it does not read them" — it is that it throws every string away and
    // takes only the state. Rendering check.label/detail/fix would put
    // "Evolution server connected" back on a client screen.
    // Comments stripped first: the file's own header names these fields in
    // prose to explain what it refuses to render, and matching that prose
    // would fail the test for saying the right thing.
    const mod = read("src/lib/osf/whatsapp/client-status.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const leak of ["c.label", "c.detail", "c.fix", "check.label", "check.detail", "check.fix"]) {
      assert.ok(!mod.includes(leak), `client status must not render ${leak}`);
    }
    // Only the state is taken off each check.
    assert.match(mod, /\[c\.id, c\.state\]/);
    const page = read("src/app/(app)/settings/whatsapp/page.tsx");
    assert.match(page, /whatsappClientStatus/);
  });

  test("no vendor or infrastructure word reaches the client status rows", () => {
    const mod = read("src/lib/osf/whatsapp/client-status.ts");
    // Strings only — the prose in the file's own header explains what it is
    // avoiding and legitimately names those things.
    const strings = [...mod.matchAll(/(?:ready|pending|label):\s*"([^"]+)"/g)].map((m) => m[1]!);
    assert.ok(strings.length >= 8, "expected the row wordings to be found");
    const banned = /\b(meta|graph|evolution|baileys|supabase|groq|anthropic|bolna|whisper|webhook|token|api|endpoint|env|deploy)\b/i;
    for (const line of strings) {
      assert.ok(!banned.test(line), `client-facing status text leaks: "${line}"`);
    }
  });

  test("the go-live checklist is gated on the operator flag, not a permission", () => {
    // workflows.manage was the wrong gate: the client's own administrator
    // holds it, so the check let the detail through to exactly the person it
    // was meant to keep it from.
    const src = read("src/app/(app)/inbox/whatsapp/whatsapp/page.tsx");
    assert.match(src, /if \(!showOperatorDetail\(\)\) redirect\(/);
  });

  test("the card that listed the suppliers is gone, not merely gated", () => {
    // It was hidden behind an environment flag, which left it one deleted
    // condition away from naming every vendor on one screen.
    assert.ok(!exists("src/components/settings/admin-diagnostics.tsx"));
    assert.ok(!exists("src/components/settings/whatsapp-health.tsx"));
  });

  test("the general tab carries no install diagnostics", () => {
    const src = read("src/app/(app)/settings/page.tsx");
    for (const term of ["ffmpeg", "Worker secret", "WORKER_SECRET", "Platform driver", "System status"]) {
      assert.ok(!src.includes(term), `the general settings tab still shows "${term}"`);
    }
  });

  test("server error text is never rendered verbatim", () => {
    // A database or proxy message reaching the screen is both confusing and a
    // leak; the fixed wording says the same thing to the person who needs it.
    const editor = read("src/components/knowledge-editor.tsx");
    assert.ok(!/setError\((?:json|out\.data)\.error/.test(editor));
    const form = read("src/components/settings/villa-settings-form.tsx");
    assert.ok(!/json\.error \|\|/.test(form));
  });
});
