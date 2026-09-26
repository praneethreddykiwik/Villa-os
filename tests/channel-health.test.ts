import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import "./helpers";

import { webhookHealth } from "../src/lib/platforms/health";

/**
 * The value of this screen is that it refuses to claim a channel works when it
 * cannot show that it does. These tests pin that refusal: every case where the
 * honest answer is "not checked" or "not set up" must not read as "working".
 */

const KEYS = [
  "PUBLIC_BASE_URL",
  "WHATSAPP_VERIFY_TOKEN",
  "META_APP_SECRET",
  "VOICE_WEBHOOK_SECRET",
  "N8N_WEBHOOK_SECRET",
  "N8N_WEBHOOK_URL",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("inbound webhook health", () => {
  test("with nothing configured, no webhook claims to be ready", () => {
    const hooks = webhookHealth();
    assert.equal(hooks.length, 3, "WhatsApp, voice and automation are all reported");
    assert.ok(
      hooks.every((h) => !h.configured),
      "an unconfigured install must not report any endpoint as ready",
    );
  });

  test("the reason names the missing piece, not just that something is wrong", () => {
    const wa = webhookHealth().find((h) => h.name === "WhatsApp messages")!;
    assert.match(
      wa.detail,
      /public address/i,
      "with no public URL the operator should be told that, since it blocks all three",
    );
  });

  test("a public address alone is not enough for WhatsApp", () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    const wa = webhookHealth().find((h) => h.name === "WhatsApp messages")!;
    assert.equal(wa.configured, false, "delivery also needs the handshake token and signing secret");
    assert.match(wa.detail, /handshake token/i);
  });

  test("a missing signing secret is called out, because every delivery is rejected without it", () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    process.env.WHATSAPP_VERIFY_TOKEN = "t";
    const wa = webhookHealth().find((h) => h.name === "WhatsApp messages")!;
    assert.equal(wa.configured, false);
    assert.match(wa.detail, /signing secret/i);
  });

  test("fully configured WhatsApp reports ready and shows the address to paste into Meta", () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    process.env.WHATSAPP_VERIFY_TOKEN = "t";
    process.env.META_APP_SECRET = "s";
    const wa = webhookHealth().find((h) => h.name === "WhatsApp messages")!;
    assert.equal(wa.configured, true);
    assert.match(wa.detail, /https:\/\/example\.test\/api\/webhooks\/whatsapp/);
  });

  test("the voice webhook fails closed without its shared secret", () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    const voice = webhookHealth().find((h) => h.name === "Voice calls")!;
    assert.equal(voice.configured, false);
    assert.match(voice.detail, /refuses every call/i);
  });

  test("automation is described as optional rather than broken", () => {
    process.env.PUBLIC_BASE_URL = "https://example.test";
    const n8n = webhookHealth().find((h) => h.name === "Automation")!;
    assert.equal(n8n.configured, false);
    assert.match(n8n.detail, /optional/i, "an unused integration must not read as a fault");
  });

  test("every webhook says what it carries, so a fault has a visible consequence", () => {
    for (const h of webhookHealth()) {
      assert.ok(h.carries.length > 10, `${h.name} should say what stops working without it`);
      assert.ok(h.path.startsWith("/api/webhooks/"), `${h.name} should name its real path`);
    }
  });
});
