import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * Voice agent settings — validation, persistence, prompt template and the
 * provider push. The push is exercised only in its documented no-op modes
 * (no key, no agent id): nothing in the suite may mutate a real account.
 */

const dir = isolate("voice-settings");
after(() => cleanup(dir));

const { read } = require("../src/lib/db") as typeof import("../src/lib/db");
const settings = require("../src/lib/voice/settings") as typeof import("../src/lib/voice/settings");

function src(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

let brandId = "";
before(() => {
  brandId = read().brands[0]?.id ?? "";
  assert.ok(brandId);
});

const ctx = () => ({ brandId, businessName: "Glentree", actor: "tester" });

describe("validation", () => {
  test("accepts text fields only, trims, and drops unknown keys", () => {
    const v = settings.validateConfig(
      {
        businessName: "  Glentree Villas ",
        greeting: "Hi there",
        officeHours: "9am–7pm",
        location: "Hyderabad",
        offerings: "Villa A\n\nVilla B\n",
        pricingGuidance: "Starts at 1.2 Cr",
        languages: ["Hindi", "Klingon", "English"],
        transferTo: "+91 98450 12345",
        doNotSay: ["guaranteed returns"],
        model: "gpt-4o",
        voice: "nova",
      },
      ctx(),
    );
    assert.ok(v.ok);
    if (!v.ok) return;
    assert.equal(v.config.businessName, "Glentree Villas");
    assert.deepEqual(v.config.offerings, ["Villa A", "Villa B"]);
    assert.deepEqual(v.config.languages, ["Hindi", "English"]);
    assert.equal(v.config.transferTo, "+919845012345");
    assert.equal("model" in v.config, false);
    assert.equal("voice" in v.config, false);
  });

  test("rejects a missing greeting, no languages, and a transfer number without a country code", () => {
    assert.equal(settings.validateConfig({ businessName: "X", languages: ["Hindi"] }, ctx()).ok, false);
    assert.equal(settings.validateConfig({ businessName: "X", greeting: "Hi", languages: [] }, ctx()).ok, false);
    assert.equal(
      settings.validateConfig({ businessName: "X", greeting: "Hi", languages: ["Hindi"], transferTo: "9845012345" }, ctx()).ok,
      false,
    );
  });
});

describe("persistence and template", () => {
  test("saves per brand and reads back", () => {
    const v = settings.validateConfig({ businessName: "Glentree", greeting: "Namaste", languages: ["Telugu"] }, ctx());
    assert.ok(v.ok);
    if (!v.ok) return;
    settings.saveConfig(v.config);
    assert.equal(settings.getConfig(brandId, "fallback").greeting, "Namaste");
    assert.equal(settings.getConfig("other-brand", "fallback").businessName, "fallback");
  });

  test("system prompt carries the fields and the fixed guardrails", () => {
    const c = settings.getConfig(brandId, "Glentree");
    const prompt = settings.buildSystemPrompt({ ...c, offerings: ["Lakeview villas"], doNotSay: ["guaranteed appreciation"], transferTo: "+919845012345" });
    assert.match(prompt, /phone assistant for Glentree/);
    assert.match(prompt, /Telugu/);
    assert.match(prompt, /- Lakeview villas/);
    assert.match(prompt, /- guaranteed appreciation/);
    assert.match(prompt, /transfer the call to \+919845012345/);
    assert.match(prompt, /Never invent a price/);
    assert.doesNotMatch(prompt, /bolna/i);
  });
});

describe("provider push", () => {
  test("is a documented no-op without a key or agent id", async () => {
    const prevKey = process.env.BOLNA_API_KEY;
    const prevAgent = process.env.BOLNA_AGENT_ID;
    try {
      delete process.env.BOLNA_API_KEY;
      delete process.env.BOLNA_AGENT_ID;
      const c = settings.getConfig(brandId, "Glentree");
      const a = await settings.syncConfig(c);
      assert.equal(a.synced, false);
      assert.doesNotMatch(a.message, /bolna/i);
      assert.match(a.detail ?? "", /BOLNA_API_KEY/);

      process.env.BOLNA_API_KEY = "bn-test";
      const b = await settings.syncConfig(c);
      assert.equal(b.synced, false);
      assert.doesNotMatch(b.message, /bolna/i);
      assert.match(b.detail ?? "", /BOLNA_AGENT_ID/);

      settings.recordSync(brandId, b);
      assert.equal(settings.getConfig(brandId, "x").lastSync?.ok, false);
    } finally {
      if (prevKey) process.env.BOLNA_API_KEY = prevKey; else delete process.env.BOLNA_API_KEY;
      if (prevAgent) process.env.BOLNA_AGENT_ID = prevAgent; else delete process.env.BOLNA_AGENT_ID;
    }
  });

  test("updateAgent only sends the documented patchable fields", () => {
    const client = src("src/lib/bolna/client.ts");
    assert.match(client, /method: "PATCH"/);
    assert.match(client, /\/v2\/agent\/\$\{encodeURIComponent\(agentId\)\}/);
    assert.match(client, /agent_prompts = \{ task_1: \{ system_prompt/);
    assert.doesNotMatch(client, /agentConfig\.synthesizer/);
  });
});

describe("routes and access", () => {
  test("PUT /api/voice/settings requires workflows.manage and never returns provider detail to non-admins", () => {
    const route = src("src/app/api/voice/settings/route.ts");
    assert.match(route, /guard\("workflows\.manage"\)/);
    assert.match(route, /hasPermission\(session, "users\.manage"\)/);
  });

  test("/voice/settings is mapped before the general /voice rule", () => {
    const access = src("src/lib/auth/page-access.ts");
    const settingsAt = access.indexOf('[/^\\/voice\\/settings/, "workflows.manage"]');
    const voiceAt = access.indexOf('[/^\\/voice/, "customers.read"]');
    assert.ok(settingsAt > -1 && voiceAt > settingsAt);
  });

  test("client-facing voice UI names no vendor", () => {
    for (const f of ["src/components/voice/voice-panel.tsx", "src/components/voice/voice-settings-form.tsx", "src/app/(app)/voice/page.tsx", "src/app/(app)/voice/settings/page.tsx"]) {
      const text = src(f);
      // The diagnostics panel is admin-only and is the single allowed mention.
      const outsideDiagnostics = text.replace(/function ProviderDiagnostics[\s\S]*?\n}\n/, "");
      assert.doesNotMatch(outsideDiagnostics, /bolna/i, `${f} mentions the vendor`);
    }
  });
});
