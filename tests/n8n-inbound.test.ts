import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * The inbound n8n path and the integration hardening from the security audit.
 *
 * Route files are not part of the test build (tsconfig.test.json compiles
 * src/lib only), so the route-level properties are pinned the way
 * security.test.ts pins them: by reading the source. The store-level ones —
 * receipts, the replay window — run for real against an isolated store.
 */

const dir = isolate("n8n-inbound");
after(() => cleanup(dir));

const bus = require("../src/lib/events/bus") as typeof import("../src/lib/events/bus");
const { mutate } = require("../src/lib/db") as typeof import("../src/lib/db");

function src(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("inbound receipts carry the action they answered", () => {
  test("a receipt remembers its action, so a reused key can be told apart", () => {
    mutate((d) => void (d.webhookDeliveries = []));
    bus.rememberReceipt("k-1", "create_lead", { lead: { id: "lead_1" } });
    const seen = bus.replayReceipt("k-1");
    assert.equal(seen?.action, "create_lead");
    assert.deepEqual(seen?.result, { lead: { id: "lead_1" } });
    // Unknown keys are not receipts.
    assert.equal(bus.replayReceipt("k-2"), undefined);
  });
});

describe("n8n webhook route", () => {
  const route = src("src/app/api/webhooks/n8n/route.ts");

  test("fails closed when the secret is unset and reads it from a header only", () => {
    assert.match(route, /if \(!expected\) throw new AuthError\(.*503\)/);
    assert.match(route, /headers\.get\("x-n8n-secret"\)/);
    assert.doesNotMatch(route, /searchParams\.get\("secret"\)/);
    assert.match(route, /timingSafeEqual/);
  });

  test("a key reused for a different action is refused rather than replayed", () => {
    assert.match(route, /seen\.action !== action/);
    assert.match(route, /409/);
  });

  test("the replayed answer carries the action, like the first answer did", () => {
    assert.match(route, /apiOk\(\{ action, \.\.\.seen\.result, idempotent: true/);
  });

  test("send_message queues a draft and never sends directly", () => {
    assert.match(route, /c\.draftReply = text/);
    assert.doesNotMatch(route, /sendWhatsApp|sendMessage\(conv/);
  });

  test("the inbound route is inventoried as self-authenticating in the middleware", () => {
    const mw = src("src/middleware.ts");
    assert.match(mw, /"\/api\/webhooks\/n8n"/);
  });
});

describe("integration hardening", () => {
  test("Upload-Post local media reads cannot escape public/ via a sibling prefix", () => {
    const code = src("src/lib/uploadpost/connections.ts");
    assert.match(code, /startsWith\(publicDir \+ path\.sep\)/);
    assert.match(code, /path\.resolve\(publicDir/);
  });

  test("WhatsApp verify handshake has no default token and compares in constant time", () => {
    const code = src("src/app/api/webhooks/whatsapp/route.ts");
    assert.doesNotMatch(code, /\?\? "dev-verify"/);
    assert.match(code, /MAX_WEBHOOK_BYTES/);
    // Both the GET handshake and the POST signature use a constant-time compare.
    assert.equal((code.match(/timingSafeEqual\(a, b\)/g) ?? []).length, 2);
  });

  test("connections route refuses an unknown channel before indexing the registry", () => {
    const code = src("src/app/api/connections/route.ts");
    assert.match(code, /CHANNEL_ORDER\.includes\(body\.channel\)/);
  });

  test("media upload checks the declared length before buffering the body", () => {
    const code = src("src/app/api/media/upload/route.ts");
    const declared = code.indexOf('headers.get("content-length")');
    const buffered = code.indexOf("await req.formData()");
    assert.ok(declared > -1 && declared < buffered, "content-length must be checked before formData()");
  });
});
