import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * The outbound event bus and the inbound idempotency window.
 *
 * The behaviours pinned here are the ones whose absence is silent: a delivery
 * that blows up the booking that triggered it, a config field that becomes an
 * SSRF, a signature that cannot be verified, and a retried n8n run that books
 * the same buyer twice.
 */

const dir = isolate("events");
after(() => cleanup(dir));

const bus = require("../src/lib/events/bus") as typeof import("../src/lib/events/bus");
const { mutate, read } = require("../src/lib/db") as typeof import("../src/lib/db");

function register(url: string, events: Array<import("../src/lib/events/bus").GlentreeEvent | "*">): string {
  // Written straight to the store rather than through addSubscriber's caller, so
  // a URL the config route would reject can still be exercised at delivery time.
  const sub = bus.addSubscriber({ url, events, secret: "s".repeat(32), createdBy: "test" });
  return sub.id;
}

function reset(): void {
  mutate((d) => {
    d.webhookSubscribers = [];
    d.webhookDeliveries = [];
  });
}

describe("subscriber URL safety", () => {
  test("plain http is refused — the payload carries buyer names and numbers", () => {
    assert.match(bus.checkWebhookUrl("http://hooks.example.com/x") ?? "", /https/);
  });

  test("loopback, link-local and private literals are refused", () => {
    for (const u of [
      "https://localhost/x",
      "https://127.0.0.1/x",
      "https://127.9.9.9/x",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/x",
      "https://192.168.1.10/x",
      "https://172.20.0.1/x",
      "https://[::1]/x",
    ]) {
      assert.notEqual(bus.checkWebhookUrl(u), null, `${u} should be refused`);
    }
  });

  test("embedded credentials are refused, a normal https endpoint is not", () => {
    assert.notEqual(bus.checkWebhookUrl("https://user:pw@hooks.example.com/x"), null);
    assert.equal(bus.checkWebhookUrl("https://hooks.example.com/webhook/abc"), null);
  });
});

describe("delivery signing", () => {
  test("the signature is HMAC-SHA256 over the exact bytes sent", async () => {
    reset();
    register("https://hooks.example.invalid/ok", ["appointment.booked"]);

    const seen: Array<{ body: string; headers: Record<string, string> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      seen.push({ body: String(init.body), headers: init.headers as Record<string, string> });
      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      const results = await bus.dispatch("appointment.booked", { appointmentId: "apt_1" });
      assert.equal(results.length, 1);
      assert.equal(results[0].ok, true);
    } finally {
      globalThis.fetch = original;
    }

    const { body, headers } = seen[0];
    // Recomputed the way the documented n8n snippet does it: over the raw body,
    // never over a re-stringified parse.
    const expected = `sha256=${createHmac("sha256", "s".repeat(32)).update(body, "utf8").digest("hex")}`;
    assert.equal(headers["x-glentree-signature"], expected);
    assert.equal(headers["x-glentree-event"], "appointment.booked");
    assert.match(headers["x-glentree-delivery"], /^[0-9a-f-]{36}$/);
    // The delivery id in the header is the one inside the signed envelope, so a
    // subscriber can dedupe on it without trusting an unsigned header.
    assert.equal(JSON.parse(body).id, headers["x-glentree-delivery"]);
  });
});

describe("failure is bounded and never reaches the caller", () => {
  test("a 500 is retried to the cap and then given up on, with the reason logged", async () => {
    reset();
    register("https://hooks.example.invalid/down", ["*"]);

    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("", { status: 500 });
    }) as typeof fetch;

    try {
      const [result] = await bus.dispatch("lead.created", { leadId: "lead_1" });
      assert.equal(result.ok, false);
      assert.equal(result.attempts, 3, "three attempts is the documented ceiling");
      assert.match(result.error ?? "", /500/);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 3);

    const log = bus.recentDeliveries();
    assert.equal(log.length, 1);
    assert.equal(log[0].ok, false);
  });

  test("a 4xx is not retried — the subscriber rejected it on purpose", async () => {
    reset();
    register("https://hooks.example.invalid/bad", ["*"]);

    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch;

    try {
      const [result] = await bus.dispatch("post.failed", {});
      assert.equal(result.ok, false);
      assert.equal(result.attempts, 1);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 1);
  });

  test("a subscriber that throws does not propagate — emit() is fire-and-forget", async () => {
    reset();
    register("https://hooks.example.invalid/throws", ["*"]);

    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;

    try {
      const [result] = await bus.dispatch("review.received", {});
      assert.equal(result.ok, false);
      assert.match(result.error ?? "", /ECONNREFUSED/);
      // The synchronous entry point must not throw either.
      assert.doesNotThrow(() => bus.emit("review.received", {}));
    } finally {
      globalThis.fetch = original;
    }
  });

  test("a stored URL that would now be refused is never fetched", async () => {
    reset();
    // Bypasses the route's validation the way a row written before the rule
    // existed would.
    mutate((d) => {
      d.webhookSubscribers = [
        {
          id: "hook_legacy",
          url: "http://169.254.169.254/latest/meta-data",
          events: ["*"],
          secret: "s".repeat(32),
          active: true,
          createdAt: new Date().toISOString(),
          createdBy: "legacy",
          consecutiveFailures: 0,
        },
      ];
    });

    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      const [result] = await bus.dispatch("lead.created", {});
      assert.equal(result.ok, false);
      assert.equal(result.attempts, 0);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(calls, 0, "the metadata endpoint must never be contacted");
  });
});

describe("routing and the delivery log", () => {
  test("only subscribers registered for the event are called", async () => {
    reset();
    register("https://hooks.example.invalid/leads", ["lead.created"]);
    register("https://hooks.example.invalid/all", ["*"]);
    register("https://hooks.example.invalid/posts", ["post.published"]);

    const hit: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      hit.push(String(url));
      return new Response("", { status: 200 });
    }) as typeof fetch;

    try {
      await bus.dispatch("lead.created", {});
    } finally {
      globalThis.fetch = original;
    }
    assert.deepEqual(hit.sort(), [
      "https://hooks.example.invalid/all",
      "https://hooks.example.invalid/leads",
    ]);
  });

  test("the log is bounded, so it cannot grow without limit", async () => {
    reset();
    register("https://hooks.example.invalid/ok", ["*"]);

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 200 })) as typeof fetch;
    try {
      for (let i = 0; i < 210; i++) await bus.dispatch("message.received", { i });
    } finally {
      globalThis.fetch = original;
    }

    const stored = (read().webhookDeliveries ?? []).filter((e) => e.direction === "outbound");
    assert.equal(stored.length, 200);
  });

  test("secrets are stripped from the list the API returns", () => {
    reset();
    register("https://hooks.example.invalid/x", ["*"]);
    const listed = bus.publicSubscribers();
    assert.equal(listed.length, 1);
    assert.equal("secret" in listed[0], false);
  });
});

describe("inbound idempotency", () => {
  test("a repeat inside the window replays the first result", () => {
    reset();
    assert.equal(bus.replayReceipt("run-1"), undefined);

    bus.rememberReceipt("run-1", "book_appointment", { appointment: { id: "apt_1" } });
    const seen = bus.replayReceipt("run-1");
    assert.ok(seen);
    assert.deepEqual(seen.result, { appointment: { id: "apt_1" } });

    // A second write under the same key must not shadow the first answer.
    bus.rememberReceipt("run-1", "book_appointment", { appointment: { id: "apt_2" } });
    assert.deepEqual(bus.replayReceipt("run-1")?.result, { appointment: { id: "apt_1" } });
  });

  test("an expired receipt stops replaying, so the key becomes usable again", () => {
    reset();
    bus.rememberReceipt("run-2", "create_lead", { lead: { id: "lead_1" } });
    mutate((d) => {
      for (const e of d.webhookDeliveries ?? []) {
        if (e.direction === "inbound") e.expiresAt = new Date(Date.now() - 1000).toISOString();
      }
    });
    assert.equal(bus.replayReceipt("run-2"), undefined);
  });

  test("receipts do not count against the outbound log's 200-entry cap", () => {
    reset();
    bus.rememberReceipt("run-3", "create_lead", { lead: { id: "lead_1" } });
    const kinds = (read().webhookDeliveries ?? []).map((e) => e.direction);
    assert.deepEqual(kinds, ["inbound"]);
    assert.equal(bus.recentDeliveries().length, 0);
  });
});
