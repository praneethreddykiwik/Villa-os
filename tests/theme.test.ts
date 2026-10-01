import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { readThemeChoice, THEME_COOKIE } from "../src/lib/theme";

/**
 * The theme contract between the server and the browser.
 *
 * Both layouts render from this cookie before any JavaScript runs, so the
 * failure mode is not an exception — it is a page served in the wrong colours,
 * or served dark and then flipping to light after hydration. A cookie is
 * attacker-controllable in the sense that anyone can type one, so the value
 * reaching `data-theme` has to be narrowed to the three it may be rather than
 * passed through.
 */
describe("theme choice", () => {
  test("accepts exactly the three real choices", () => {
    assert.equal(readThemeChoice("light"), "light");
    assert.equal(readThemeChoice("dark"), "dark");
    assert.equal(readThemeChoice("system"), "system");
  });

  test("falls back to system for anything else", () => {
    // Absent cookie — the common case on a first visit.
    assert.equal(readThemeChoice(undefined), "system");
    assert.equal(readThemeChoice(""), "system");
    // A hand-written cookie must not reach the data-theme attribute verbatim.
    assert.equal(readThemeChoice("Dark"), "system");
    assert.equal(readThemeChoice('" onload="x'), "system");
  });

  test("server and client agree on one cookie name", () => {
    const root = fs.readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
    const lib = fs.readFileSync(path.join(process.cwd(), "src/lib/theme.ts"), "utf8");
    // The root layout stamps <html data-theme> from this cookie; if it read a
    // different name the server would always render the default theme and the
    // client would correct it after paint — the exact flash the cookie exists
    // to prevent.
    assert.ok(root.includes("THEME_COOKIE"), "root layout should read the shared cookie name");
    // applyTheme must build the cookie FROM the constant, not repeat the
    // string — so the check is that the source interpolates it, not that the
    // literal name appears (it would not).
    assert.ok(
      lib.includes("${THEME_COOKIE}="),
      "applyTheme should write the cookie via the shared constant",
    );
    assert.equal(THEME_COOKIE, "glentree-theme");
  });

  test('"system" clears the attribute rather than naming a theme', () => {
    const lib = fs.readFileSync(path.join(process.cwd(), "src/lib/theme.ts"), "utf8");
    // Writing data-theme="system" would match neither token block and strand
    // the page on the dark defaults, so absence is what makes the media query
    // take over.
    assert.ok(
      /delete document\.documentElement\.dataset\.theme/.test(lib),
      "system must remove data-theme so prefers-color-scheme decides",
    );
  });
});

/**
 * Appearance and sign-out belong to the person, not the page, so they are
 * mounted by the app layout. They used to live in TopBar, which 36 of the 65
 * app pages never render — including /ops, where every account without
 * analytics.view lands at sign-in. That is why sales and marketing had no way
 * to leave dark mode and no way to sign out.
 */
describe("quick settings reach every screen", () => {
  const layout = () =>
    fs.readFileSync(path.join(process.cwd(), "src/app/(app)/layout.tsx"), "utf8");

  test("is mounted by the app layout, not by a page", () => {
    assert.match(layout(), /<QuickSettings/, "app layout must render QuickSettings");
  });

  test("sits outside <main>, so the no-access branch still has it", () => {
    const src = layout();
    const closeMain = src.indexOf("</main>");
    assert.ok(closeMain !== -1, "app layout should render a <main>");
    assert.ok(
      src.indexOf("<QuickSettings") > closeMain,
      "QuickSettings must be outside <main> so it survives the no-access branch",
    );
  });

  test("no page mounts a second appearance control", () => {
    // Two switches for one setting is how they drift out of step.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".tsx") && !full.endsWith("quick-settings.tsx")) {
          if (/<ThemeToggle\b/.test(fs.readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    walk(path.join(process.cwd(), "src"));
    assert.deepEqual(offenders, [], `stale theme switch still mounted: ${offenders.join(", ")}`);
  });
});
