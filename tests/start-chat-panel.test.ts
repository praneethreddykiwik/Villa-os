import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * Starting a WhatsApp conversation with somebody who has not written to us.
 *
 * The panel was already built, and reported as missing — because opened, it
 * rendered inside the page header's flex row of actions, grew sideways, and
 * pushed its own inputs and Send button past the right edge of the screen.
 * "There is no input box" was literally true from where the user was sitting.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const PAGE = "src/app/(app)/inbox/whatsapp/communication/whatsapp/page.tsx";
const PANEL = "src/app/(app)/inbox/whatsapp/communication/whatsapp/StartChat.tsx";

describe("the panel is not trapped in the header", () => {
  const src = read(PAGE);

  test("it is rendered as its own block", () => {
    assert.match(src, /<div className="mb-4">\s*<StartChat returnTo=\{BASE\} \/>/);
  });

  test("it is no longer a header action", () => {
    // A flex item does not wrap, so a full-width card inside the actions row
    // can only grow off-screen.
    const actions = src.slice(src.indexOf("actions={"), src.indexOf("      />", src.indexOf("actions={")));
    assert.doesNotMatch(actions, /StartChat/);
  });

  test("the header still carries the things that belong there", () => {
    const actions = src.slice(src.indexOf("actions={"), src.indexOf("      />", src.indexOf("actions={")));
    assert.match(actions, /LiveRefresh/);
  });
});

describe("the opening message is the outbound one", () => {
  const src = read(PANEL);

  test("it introduces us, because they have never heard from us", () => {
    // The inbound greeting welcomes somebody who already wrote in. Sending
    // that to a cold number reads as a reply to a message they never sent.
    assert.match(src, /const DEFAULT_TEMPLATE\s*=/);
    const tmpl = src.slice(src.indexOf("const DEFAULT_TEMPLATE"), src.indexOf("interface Sample"));
    assert.match(tmpl, /this is Glentree Homes/);
    assert.doesNotMatch(tmpl, /Welcome to/i);
  });

  test("it names the person, or says 'there' when we have no name", () => {
    const tmpl = src.slice(src.indexOf("const DEFAULT_TEMPLATE"), src.indexOf("interface Sample"));
    assert.match(tmpl, /\{name\}/);
  });

  test("it offers a next step rather than just announcing itself", () => {
    const tmpl = src.slice(src.indexOf("const DEFAULT_TEMPLATE"), src.indexOf("interface Sample"));
    assert.match(tmpl, /brochure|site visit/i);
  });

  test("it is editable before sending, not hard-coded into the send", () => {
    assert.match(src, /useState\(DEFAULT_TEMPLATE\)/);
  });
});

describe("the friction that protects the number stays", () => {
  const src = read(PANEL);

  test("nothing sends until a preview has been seen", () => {
    assert.match(src, /preview/i);
    assert.match(src, /setPreview\(null\)/);
  });

  test("editing the list invalidates an approved preview", () => {
    // Approving one list and sending a different one is the failure this
    // whole flow exists to prevent.
    assert.match(src, /function edit\(/);
  });

  test("the send button says how many people it will message", () => {
    assert.match(src, /Message \{?/);
  });
});
