import assert from "node:assert/strict";
import test, { after, before, describe } from "node:test";
import { cleanup, isolate, seedTeam } from "./helpers";

/**
 * WHATSAPP INBOX
 *
 * The inbox is a read model over the conversation store plus two writes:
 * delivery receipts and the staff read mark. Everything here runs against the
 * isolated store with the stub transport — nothing is sent.
 */
const dir = isolate("wa-inbox");
after(() => cleanup(dir));

const { read, resetToBootstrap } = require("../src/lib/db") as typeof import("../src/lib/db");
const { ensureOpsSeed, defaultOrgId } = require("../src/lib/ops/seed") as typeof import("../src/lib/ops/seed");
const { handleInbound, deliver } = require("../src/lib/ops/agent") as typeof import("../src/lib/ops/agent");
const { parseStatuses } = require("../src/lib/platforms/whatsapp") as typeof import("../src/lib/platforms/whatsapp");
const { getCustomer } = require("../src/lib/ops/customers") as typeof import("../src/lib/ops/customers");
const inbox = require("../src/lib/ops/inbox") as typeof import("../src/lib/ops/inbox");

let ORG = "";
before(() => {
  resetToBootstrap();
  ORG = defaultOrgId();
  ensureOpsSeed(ORG);
  seedTeam(ORG);
});

let n = 0;
const wamid = () => `wamid.INBOX${++n}`;

const statusPayload = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: "1700000000", recipient_id: "919811000001", ...extra }] } }] }],
});

describe("status parsing", () => {
  test("reads sent/delivered/read/failed and drops unknown values", () => {
    const p = {
      entry: [{ changes: [{ value: { statuses: [
        { id: "a", status: "sent", timestamp: "1700000000" },
        { id: "b", status: "read", timestamp: "1700000001" },
        { id: "c", status: "bogus", timestamp: "1700000002" },
        { id: "d", status: "failed", timestamp: "1700000003", errors: [{ code: 131047, title: "Re-engagement message" }] },
      ] } }] }],
    };
    const out = parseStatuses(p);
    assert.deepEqual(out.map((s) => [s.messageId, s.status]), [["a", "sent"], ["b", "read"], ["d", "failed"]]);
    assert.equal(out[0].timestamp, "2023-11-14T22:13:20.000Z");
    assert.equal(out[2].error, "Re-engagement message");
  });

  test("a status without a usable timestamp does not throw", () => {
    const out = parseStatuses({ entry: [{ changes: [{ value: { statuses: [
      { id: "wamid.1", status: "delivered" },
      { id: "wamid.2", status: "read", timestamp: "not-a-number" },
    ] } }] }] });
    assert.equal(out.length, 2);
    for (const s of out) assert.ok(!Number.isNaN(Date.parse(s.timestamp)));
  });

  test("a payload with only messages yields no statuses", () => {
    assert.deepEqual(parseStatuses({ entry: [{ changes: [{ value: { messages: [{ id: "x" }] } }] }] }), []);
  });

  test("receipts land on the outbound row and never regress", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 000001", name: "Status Sam", body: "Hello, what do you have?", externalId: wamid() });
    const sent = read().opsMessages.find((m) => m.customerId === out.customerId && m.direction === "outbound");
    assert.ok(sent?.externalId, "the AI reply was recorded with a platform id");

    assert.equal(inbox.applyDeliveryStatuses(parseStatuses(statusPayload(sent!.externalId!, "delivered"))), 1);
    assert.equal(read().opsMessages.find((m) => m.id === sent!.id)!.deliveryStatus, "delivered");

    // A late "sent" receipt must not undo "delivered".
    inbox.applyDeliveryStatuses(parseStatuses(statusPayload(sent!.externalId!, "sent")));
    assert.equal(read().opsMessages.find((m) => m.id === sent!.id)!.deliveryStatus, "delivered");

    inbox.applyDeliveryStatuses(parseStatuses(statusPayload(sent!.externalId!, "read")));
    assert.equal(read().opsMessages.find((m) => m.id === sent!.id)!.deliveryStatus, "read");

    assert.equal(inbox.applyDeliveryStatuses(parseStatuses(statusPayload("wamid.unknown", "read"))), 0);
  });
});

describe("conversation listing and unread", () => {
  test("lists one conversation per customer, newest first, with unread counts", async () => {
    const a = await handleInbound({ orgId: ORG, phone: "+91 9811 000002", name: "Anita", body: "Is a 3BHK available?", externalId: wamid() });
    const b = await handleInbound({ orgId: ORG, phone: "+91 9811 000003", name: "Bala", body: "Send me the brochure", externalId: wamid() });
    await handleInbound({ orgId: ORG, phone: "+91 9811 000003", name: "Bala", body: "Also the price list", externalId: wamid() });

    const list = inbox.listConversations(ORG);
    const ids = list.map((c) => c.customerId);
    assert.ok(ids.indexOf(b.customerId) < ids.indexOf(a.customerId), "most recent activity first");
    const bala = list.find((c) => c.customerId === b.customerId)!;
    assert.equal(bala.unread, 2);
    assert.equal(bala.name, "Bala");
    assert.equal(bala.mode, "ai");

    const unreadOnly = inbox.listConversations(ORG, { filter: "unread" });
    assert.ok(unreadOnly.every((c) => c.unread > 0));
    assert.ok(unreadOnly.some((c) => c.customerId === a.customerId));

    // Search by name and by digits of the number.
    assert.deepEqual(inbox.listConversations(ORG, { q: "anita" }).map((c) => c.customerId), [a.customerId]);
    assert.ok(inbox.listConversations(ORG, { q: "000003" }).some((c) => c.customerId === b.customerId));
  });

  test("opening the thread marks inbound read and the thread carries authors and window state", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 000004", name: "Read Rita", body: "Hi there", externalId: wamid() });
    assert.equal(inbox.listConversations(ORG).find((c) => c.customerId === out.customerId)!.unread, 1);
    assert.equal(inbox.markThreadRead(out.customerId), 1);
    assert.equal(inbox.markThreadRead(out.customerId), 0, "idempotent");
    assert.equal(inbox.listConversations(ORG).find((c) => c.customerId === out.customerId)!.unread, 0);

    const t = inbox.getThread(ORG, out.customerId)!;
    assert.equal(t.messages[0].direction, "inbound");
    assert.equal(t.messages[0].authorName, "Read Rita");
    assert.ok(t.messages.some((m) => m.direction === "outbound" && m.authorName === "AI"));
    assert.equal(t.canFreeText, true);
    assert.equal(inbox.getThread(ORG, "cust_missing"), null);
  });
});

describe("reply recording", () => {
  test("a human reply is recorded with the staff author and shows the member's name", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 000005", name: "Reply Raj", body: "Can someone call me?", externalId: wamid() });
    const member = read().teamMembers.find((m) => m.orgId === ORG && m.role === "SALES_MANAGER")!;
    const res = await deliver(ORG, out.customerId, "Sure, calling you at 5pm.", "human", member.id);
    assert.equal(res.ok, true);

    const t = inbox.getThread(ORG, out.customerId)!;
    const human = t.messages.find((m) => m.authorType === "human")!;
    assert.equal(human.authorId, member.id);
    assert.equal(human.authorName, member.name);
    assert.equal(human.direction, "outbound");
    assert.equal(human.body, "Sure, calling you at 5pm.");
    assert.ok(human.externalId);
    assert.equal(inbox.listConversations(ORG).find((c) => c.customerId === out.customerId)!.needsReply, false);
  });

  test("an outbound sent outside the agent is recorded once, keyed on the platform id", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 000006", name: "Ext Esha", body: "Hello", externalId: wamid() });
    const first = inbox.recordExternalOutbound({ orgId: ORG, customerId: out.customerId, body: "From the other inbox", authorType: "human", authorId: "u1", externalId: "wamid.ext1" });
    assert.ok(first);
    const dup = inbox.recordExternalOutbound({ orgId: ORG, customerId: out.customerId, body: "From the other inbox", authorType: "human", authorId: "u1", externalId: "wamid.ext1" });
    assert.equal(dup, null);
    assert.equal(read().opsMessages.filter((m) => m.externalId === "wamid.ext1").length, 1);
  });
});

describe("pause / resume", () => {
  test("pausing hands the sales lane to a person, silences the AI, and resuming restores it", async () => {
    const out = await handleInbound({ orgId: ORG, phone: "+91 9811 000007", name: "Pause Pia", body: "Tell me about villas", externalId: wamid() });
    inbox.setInboxControl(out.customerId, true, { id: "staff1", type: "human" });
    assert.equal(getCustomer(out.customerId)!.salesControl, "HUMAN_CONTROL");
    assert.equal(inbox.listConversations(ORG).find((c) => c.customerId === out.customerId)!.mode, "human");
    assert.ok(inbox.listConversations(ORG, { filter: "human" }).some((c) => c.customerId === out.customerId));

    const silent = await handleInbound({ orgId: ORG, phone: "+91 9811 000007", body: "Anyone there?", externalId: wamid() });
    assert.equal(silent.reply, null, "the AI stays quiet while a person is handling the chat");

    const t = inbox.getThread(ORG, out.customerId)!;
    assert.ok(t.events.some((e) => e.kind === "control" && /paused/i.test(e.label)));

    inbox.setInboxControl(out.customerId, false, { id: "staff1", type: "human" });
    assert.equal(getCustomer(out.customerId)!.salesControl, "AI_ACTIVE");
    assert.ok(inbox.getThread(ORG, out.customerId)!.events.some((e) => e.kind === "control" && /resumed/i.test(e.label)));
  });
});
