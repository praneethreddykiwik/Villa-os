import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * Icon-only buttons must carry an accessible name.
 *
 * lucide-react renders a bare <svg> with no text, so a button whose only child
 * is an icon announces as an empty button to a screen reader. These are source
 * assertions (the app is auth-gated, no DOM runner here): each button below is
 * pinned to keep its aria-label.
 */

const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const CASES: Array<[file: string, label: string]> = [
  ["src/components/whatsapp-inbox/inbox.tsx", "Dismiss error"],
  ["src/components/whatsapp-inbox/simulator.tsx", "Close simulator"],
  ["src/components/whatsapp-inbox/simulator.tsx", "Send message"],
  ["src/components/board-settings.tsx", "Close board settings"],
  ["src/components/messaging/message-composer.tsx", "Cancel reply"],
  ["src/components/voice/voice-panel.tsx", "Close call details"],
  ["src/components/quick-settings.tsx", "Close settings"],
  ["src/components/quick-settings.tsx", "Settings, appearance and account"],
];

describe("icon-only buttons have accessible names", () => {
  for (const [file, label] of CASES) {
    test(`${file} — "${label}"`, () => {
      const src = read(file);
      assert.ok(
        src.includes(`aria-label="${label}"`),
        `${file}: icon-only button lost its aria-label="${label}"`,
      );
      // the labelled button must be a real button, not a form-submitting default
      const idx = src.indexOf(`aria-label="${label}"`);
      const open = src.lastIndexOf("<button", idx);
      const tag = src.slice(open, idx);
      assert.match(tag, /type="(button|submit)"/, `${file}: button near "${label}" has no explicit type`);
    });
  }
});
