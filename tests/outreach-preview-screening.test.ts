import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * The preview has to predict the send.
 *
 * startConversations refuses anyone who opted out or already has a thread, but
 * it discovers them one at a time mid-run. Preview did not ask those questions
 * at all, so it promised "Message 1 person" for a number with a 70-message
 * history and the send then skipped them — nothing delivered, and from the
 * desk's side the button simply looked broken.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const LIB = "src/lib/osf/outreach.ts";
const ROUTE = "src/app/api/osf/outreach/route.ts";
const PANEL = "src/app/(app)/inbox/whatsapp/communication/whatsapp/StartChat.tsx";

describe("the preview asks what the send will ask", () => {
  const src = read(LIB);

  test("a screening pass exists and sends nothing", () => {
    assert.match(src, /export async function screenRecipients/);
    const fn = src.slice(src.indexOf("export async function screenRecipients"), src.indexOf("export type OutreachOutcome"));
    assert.doesNotMatch(fn, /sendPlainText/);
  });

  test("it blocks an opt-out", () => {
    const fn = src.slice(src.indexOf("export async function screenRecipients"), src.indexOf("export type OutreachOutcome"));
    assert.match(fn, /lead\.opted_out/);
  });

  test("it blocks someone who already has a thread", () => {
    const fn = src.slice(src.indexOf("export async function screenRecipients"), src.indexOf("export type OutreachOutcome"));
    assert.match(fn, /message_count \?\? 0\) > 0/);
    assert.match(fn, /already has a WhatsApp thread/);
  });

  test("it only counts WhatsApp threads", () => {
    // A lead reached once on Instagram has never had a WhatsApp opener.
    const fn = src.slice(src.indexOf("export async function screenRecipients"), src.indexOf("export type OutreachOutcome"));
    assert.match(fn, /\.eq\("channel", "whatsapp"\)/);
  });

  test("a database failure degrades to 'cannot tell' rather than blocking the desk", () => {
    const fn = src.slice(src.indexOf("export async function screenRecipients"), src.indexOf("export type OutreachOutcome"));
    assert.match(fn, /catch \{/);
    assert.match(fn, /return \{ sendable: recipients, blocked \}/);
  });
});

describe("the count on the button is the count that will be messaged", () => {
  const src = read(ROUTE);

  test("preview screens before it answers", () => {
    assert.match(src, /await screenRecipients\(recipients\)/);
  });

  test("the count comes from the sendable list, not the parsed list", () => {
    const block = src.slice(src.indexOf("if (preview) {"), src.indexOf("const session = await getSession()"));
    assert.match(block, /count: sendable\.length/);
    assert.doesNotMatch(block, /count: recipients\.length/);
  });

  test("blocked people are shown with their reason, not silently dropped", () => {
    const block = src.slice(src.indexOf("if (preview) {"), src.indexOf("const session = await getSession()"));
    assert.match(block, /\.\.\.blocked\.map/);
    assert.match(block, /reason: b\.reason/);
  });

  test("the send still checks for itself — the preview is a courtesy, not the gate", () => {
    // Screening is a read taken seconds earlier; the authoritative refusal has
    // to stay inside the send loop.
    const lib = read(LIB);
    const send = lib.slice(lib.indexOf("export async function startConversations"));
    assert.match(send, /lead\.opted_out/);
    assert.match(send, /conversation\.message_count \?\? 0\) > 0/);
  });
});

describe("a disabled send button explains itself", () => {
  const src = read(PANEL);

  test("the reason is on the page, not only in a title attribute", () => {
    // A tooltip never appears on touch and is easy to miss on a pointer, so a
    // greyed-out button reads as broken rather than as locked.
    assert.match(src, /\{!preview && \(/);
    assert.match(src, /Press Preview first/);
  });
});
