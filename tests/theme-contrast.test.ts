import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

/**
 * Theme guard.
 *
 * The app has one palette and two themes. Every surface and text colour is a
 * semantic token (`ink-*` for surfaces, `mist-*` for text) that re-declares
 * itself under `[data-theme]`, so a screen written in tokens is correct in both
 * themes for free. A raw Tailwind colour — `text-white`, `bg-black`,
 * `text-slate-400` — does not re-declare itself, which is how the app shipped a
 * `hover:text-white` on a pill whose background is white in light mode: the
 * label vanished on hover.
 *
 * This test fails on any new raw colour utility in the UI. Some raw colours are
 * correct and stay: text over a photograph, a fixed dark overlay, a label on a
 * brand-coloured chip. Those are listed below one by one, each with the reason
 * it is legitimate, so adding one is a deliberate act with a written argument
 * rather than a habit.
 *
 * Contrast ratios for the token pairs are asserted at the bottom, read out of
 * globals.css so the numbers cannot drift away from the source of truth.
 */

const ROOT = process.cwd();
const SCAN = ["src/components", "src/app"];

/**
 * Directories skipped entirely. A QA harness whose whole purpose is to render
 * the bad states side by side cannot also be held to the rule it demonstrates.
 */
const SKIP_DIRS = [
  /(^|\/)qa-harness(\/|$)/,
];

/** Utilities whose colour is baked in and therefore identical in both themes. */
const RAW = new RegExp(
  String.raw`(?:^|[\s"'\`])(?:[a-z-]+:)*` +
    String.raw`(?:text|bg|border|ring|fill|stroke|from|via|to|divide|placeholder|decoration|outline|accent|caret)` +
    String.raw`-(?:white|black|slate|gray|grey|zinc|neutral|stone)(?:[-/]\d+)*`,
  "g",
);

/**
 * Files exempt wholesale, with the reason.
 *
 * The YouTube surfaces are owned elsewhere and are not ours to edit; they are
 * listed so this test reports honestly rather than silently skipping them.
 */
const EXEMPT_FILES: Record<string, string> = {
  "src/components/channels/youtube-videos.tsx":
    "owned by the YouTube integration; out of bounds for this codebase's edits",
  "src/components/showcase/onyx-tower-render.tsx":
    "every label sits directly on the photoreal tower render inside a fixed bg-black frame — the surface never flips",
  "src/components/auth/sign-in-form.tsx":
    "inline Google mark; its path fills are the vendor's fixed brand colours",
  "src/app/(app)/inbox/whatsapp/marketing/studio/DevicePreview.tsx":
    "renders what a post will look like ON Instagram, WhatsApp and Facebook — " +
    "their chrome is fixed brand colour, so a preview that flipped with our " +
    "theme would stop being a preview of anything",
};

/**
 * Individual allowed occurrences: "<file>:<utility>" -> why it is correct.
 * Anything not on this list must use a semantic token.
 */
const ALLOW: Record<string, string> = {
  // --- Text on a permanently dark backdrop (photo, render, video, scrim) ---
  "src/components/showcase/cinematic-stage.tsx:text-white":
    "caption sits on a from-black/80 gradient laid over the photograph",
  "src/components/showcase/cinematic-stage.tsx:bg-black/50":
    "prev/next controls float on the image itself",
  "src/components/showcase/cinematic-stage.tsx:bg-black/70": "hover state of the same controls",
  "src/components/showcase/cinematic-stage.tsx:border-white/20": "hairline on those controls, over the image",
  "src/components/showcase/cinematic-stage.tsx:bg-white/40": "slide indicator dots, over the image",
  "src/components/showcase/cinematic-stage.tsx:bg-white/70": "active slide indicator dot, over the image",
  "src/components/showcase/serenity-master-plan.tsx:bg-black/80": "modal scrim over the aerial master plan",
  "src/components/osf/shell/CommandPalette.tsx:bg-black/70":
    "scrim behind the command dialog — a dark veil is correct under a modal in either theme",
  "src/components/showcase/serenity-master-plan.tsx:bg-black/85": "modal scrim over the interior tour",
  "src/components/showcase/serenity-master-plan.tsx:ring-black/40":
    "villa dot outline drawn on the aerial photograph, not on a themed surface",
  "src/components/showcase/serenity-master-plan.tsx:ring-white":
    "selected/focused villa dot on the aerial photograph — white is the only ring that reads on it",
  "src/components/showcase/serenity-master-plan.tsx:bg-white/5":
    "plate behind a floor-plan image, which is drawn on white paper in both themes",
  // The 3D cutaway's stage is a fixed dark radial gradient in both themes — the
  // model is lit as if at dusk, and a light stage would wash the room colours
  // out entirely. Everything below is drawn on that stage, never on a themed
  // surface, so these do not flip by design.
  "src/components/showcase/unit-3d-view.tsx:text-white": "unit name read out over the dark stage",
  "src/components/showcase/unit-3d-view.tsx:text-white/70": "room dimensions under it, same stage",
  "src/components/showcase/unit-3d-view.tsx:text-white/50": "drawn-area line and the slider icon, same stage",
  "src/components/showcase/unit-3d-view.tsx:text-white/40": "the drag/scroll hint, same stage",
  "src/components/showcase/unit-3d-view.tsx:bg-black/40": "pill behind the wall-height slider, floating on the stage",
  "src/components/showcase/unit-3d-view.tsx:bg-white/25": "the slider's own track inside that pill",
  "src/components/showcase/onyx-tower-explorer.tsx:bg-black/60": "breadcrumb bar over the photoreal render",
  "src/components/showcase/onyx-tower-explorer.tsx:border-white/15": "hairline on that breadcrumb bar",
  "src/components/showcase/onyx-tower-explorer.tsx:text-white/85": "breadcrumb text on that bar",
  "src/components/showcase/onyx-tower-explorer.tsx:text-white/70": "inactive breadcrumb crumb on that bar",
  "src/components/showcase/onyx-tower-explorer.tsx:hover:text-white": "hover of that crumb, still on the dark bar",
  "src/components/showcase/onyx-tower-explorer.tsx:text-white/40": "breadcrumb separator on that bar",
  "src/components/showcase/onyx-tower-explorer.tsx:text-white": "current breadcrumb crumb on that bar",
  "src/components/showcase/onyx-tower-explorer.tsx:bg-white":
    "plate behind an apartment plan image — the plans are line art on white paper",
  "src/components/showcase/onyx-showcase.tsx:bg-white": "plate behind a floor-plan image, as above",
  "src/components/showcase/onyx-showcase.tsx:bg-black/80": "lightbox scrim over the plan",
  "src/components/showcase/panorama-viewer.tsx:border-white/25":
    "hotspot pill hairline, floating on the 360 panorama",
  "src/components/showcase/panorama-viewer.tsx:hover:border-white/50": "hover of that hotspot pill",
  "src/components/studio.tsx:bg-black/40": "duration/caption chips over video thumbnails",
  "src/components/studio.tsx:bg-black/45": "burned-in caption preview over the video frame",
  "src/components/studio.tsx:bg-black/50": "duration chip over the video frame",
  "src/components/studio.tsx:text-white": "text inside those over-video chips",
  "src/components/studio.tsx:border-white/70": "safe-area guide drawn over the video frame",
  "src/components/channels/facebook-studio.tsx:bg-black/75": "Reel/duration chips over the video thumbnail",
  "src/components/channels/instagram-studio.tsx:bg-black/75": "Reel/duration chips over the video thumbnail",
  "src/components/voice/voice-panel.tsx:bg-black/40": "drawer scrim",
  "src/components/voice/start-call.tsx:bg-black/60": "dialog scrim",
  "src/components/whatsapp-inbox/simulator.tsx:bg-black/70": "dialog scrim",
  "src/components/automation/v2-form.tsx:bg-black": "letterbox behind the HTML5 video preview",

  "src/components/showcase/serenity-master-plan.tsx:focus-visible:ring-white":
    "focus ring on a villa dot drawn on the aerial photograph — white is the only ring that reads on it",
  "src/components/showcase/cinematic-stage.tsx:from-black/80":
    "gradient scrim under the caption, laid over the photograph",
  "src/components/showcase/cinematic-stage.tsx:hover:bg-black/70":
    "hover of the prev/next controls, over the image",
  "src/components/showcase/cinematic-stage.tsx:bg-white":
    "active slide indicator dot, over the image",
  "src/components/showcase/cinematic-stage.tsx:hover:bg-white/70":
    "hover of an inactive slide indicator dot, over the image",

  // --- Labels on a fixed coloured chip, tile or gradient ---
  "src/components/ui.tsx:text-white":
    "Badge/Button holographic variant — .holographic-sheen paints the same pink-purple-blue gradient in both themes",
  "src/components/ui.tsx:bg-white": "pulse dot on that same holographic gradient",
  "src/components/ui.tsx:border-white/10":
    "specular hairline on the primary button; decorative, and the label uses --a-on",
  "src/components/shell.tsx:text-white": "icon inside .holographic-orb, a fixed gradient",
  "src/components/shell.tsx:border-white/20": "specular hairline on the brand mark",
  "src/app/(app)/connections/page.tsx:text-white": "monogram on a channel's fixed brand colour",
  "src/app/(app)/channels/page.tsx:text-white": "monogram on a channel's fixed brand colour",
  "src/components/connect-panel.tsx:text-white": "monogram on a channel's fixed brand colour",
  "src/components/channel-health.tsx:text-white": "monogram on a channel's fixed brand colour",
  "src/components/inbox.tsx:text-white": "monogram on a channel's fixed brand colour",
  "src/components/reviews-panel.tsx:text-white": "monogram on a review source's fixed brand colour",
  "src/app/(app)/local/page.tsx:text-white":
    "rank number on a fixed RANK_FILL colour, each chosen to clear 4.5:1 against white",
  "src/components/channels/facebook-studio.tsx:text-white": "icon on the fixed brand tile",
  "src/components/channels/instagram-studio.tsx:text-white": "icon on the fixed brand tile",
  "src/components/channels/linkedin-studio.tsx:text-white": "icon on the fixed brand tile / solid sky button",
  "src/components/analytics/uploadpost-live-studio.tsx:text-white":
    "icons on fixed platform-coloured tiles (blue, red, LinkedIn blue, IG gradient)",
  "src/components/automation/v2-form.tsx:text-white": "channel icon on a fixed brand gradient tile",
  "src/components/automation/v2-form.tsx:from-zinc-700": "X's brand tile is deliberately near-black in both themes",
  "src/components/automation/v2-form.tsx:to-zinc-900": "the other stop of that same tile",
  "src/components/whatsapp-inbox/simulator.tsx:text-white":
    "device mock of the WhatsApp chat UI — its chrome is fixed hex on purpose, it is a screenshot of another app",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/** Comments explain the code; they are not shipped classNames. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
}

describe("theme contrast", () => {
  test("no raw, non-flipping colour utilities outside the allowlist", () => {
    const offences: string[] = [];

    for (const root of SCAN) {
      const dir = path.join(ROOT, root);
      if (!fs.existsSync(dir)) continue;

      for (const file of walk(dir)) {
        const rel = path.relative(ROOT, file).split(path.sep).join("/");
        if (EXEMPT_FILES[rel]) continue;
        if (SKIP_DIRS.some((re) => re.test(rel))) continue;

        const src = stripComments(fs.readFileSync(file, "utf8"));
        for (const m of src.matchAll(RAW)) {
          const util = m[0].replace(/^[\s"'`]+/, "");
          if (ALLOW[`${rel}:${util}`]) continue;
          offences.push(`${rel}: ${util}`);
        }
      }
    }

    assert.deepEqual(
      [...new Set(offences)].sort(),
      [],
      "Raw colour utilities do not flip between themes. Use a semantic token " +
        "(text-mist-100/200/300/400, bg-ink-800/900/950, border-ink-600/700), or — " +
        "if the element genuinely sits on a permanently dark or fixed-colour " +
        "surface — add it to ALLOW in this file with the reason.",
    );
  });

  test("solid-accent buttons carry their label in --a-on, never text-white", () => {
    // bg-brand-500 is near-white in dark mode, so a hard-coded `text-white`
    // label disappears there. --a-on is the token that pairs with the accent.
    const SITES: Array<[string, RegExp]> = [
      ["src/components/automation/v2-form.tsx", /from-brand-500 to-brand-400 text-\[var\(--a-on\)\]/],
      ["src/components/voice/start-call.tsx", /bg-brand-500 px-3[^"]*text-\[var\(--a-on\)\]/],
      ["src/components/voice/start-call.tsx", /bg-brand-500 py-2\.5[^"]*text-\[var\(--a-on\)\]/],
      ["src/components/whatsapp-inbox/inbox.tsx", /bg-brand-500 px-3[^"]*text-\[var\(--a-on\)\]/],
    ];
    for (const [rel, re] of SITES) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      assert.ok(re.test(src), `${rel}: solid-accent button lost its text-[var(--a-on)] label colour`);
      assert.ok(
        !/bg-brand-500[^"]*text-white/.test(src),
        `${rel}: a solid-accent button is back on text-white, invisible in dark mode`,
      );
    }
  });

  /* ---------------------------------------------------------------------- */

  const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");

  /** Pull the hex declarations out of one `:root` block. */
  function tokens(re: RegExp): Record<string, string> {
    const m = css.match(re);
    assert.ok(m, `theme block not found: ${re}`);
    const out: Record<string, string> = {};
    for (const [, k, v] of m[0].matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) out[k] = v;
    return out;
  }
  const THEME = {
    dark: tokens(/:root \{[\s\S]*?\n\}/),
    light: tokens(/:root\[data-theme="light"\] \{[\s\S]*?\n\}/),
  };

  const ALIAS: Record<string, string> = {
    "ink-950": "--s-bg", "ink-900": "--s-surface", "ink-850": "--s-input",
    "ink-800": "--s-raised", "ink-700": "--s-border", "ink-600": "--s-border-strong",
    "ink-500": "--s-faint", "mist-400": "--t-muted", "mist-300": "--t-secondary",
    "mist-200": "--t-strong", "mist-100": "--t-primary",
    "brand-500": "--a-500", "a-on": "--a-on",
    "good-400": "--c-good", "warn-400": "--c-warn", "bad-400": "--c-bad",
  };

  const hex = (theme: "dark" | "light", name: string): string => {
    if (name.startsWith("#")) return name;
    const v = THEME[theme][ALIAS[name] ?? name];
    assert.ok(v, `unknown token ${name} in ${theme}`);
    return v;
  };
  const channels = (h: string): number[] => {
    const n = h.length === 4 ? [...h.slice(1)].map((c) => c + c).join("") : h.slice(1, 7);
    return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  };
  const luminance = (h: string): number =>
    channels(h)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
      .reduce((a, c, i) => a + c * [0.2126, 0.7152, 0.0722][i], 0);
  /** Flatten a translucent foreground onto its backdrop before measuring. */
  const flatten = (fg: string, bg: string, alpha: number): string => {
    const [f, b] = [channels(fg), channels(bg)];
    return (
      "#" +
      f
        .map((v, i) => Math.round((v * alpha + b[i] * (1 - alpha)) * 255).toString(16).padStart(2, "0"))
        .join("")
    );
  };
  const contrast = (a: string, b: string): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (hi + 0.05) / (lo + 0.05);
  };

  test("local rank fills and legend dots use the same audited hexes", () => {
    const page = fs.readFileSync(path.join(ROOT, "src/app/(app)/local/page.tsx"), "utf8");
    const fills = page.match(/const RANK_FILL = \{([^}]*)\}/);
    assert.ok(fills, "RANK_FILL constant not found");
    for (const h of ["#15803d", "#b45309", "#be123c"]) {
      assert.ok(fills[1].includes(h), `RANK_FILL no longer contains ${h}`);
      assert.ok(page.includes(`bg-[${h}]`), `legend dot for ${h} is out of sync with RANK_FILL`);
    }
    for (const bright of ["#22c55e", "#fbbf24", "#f43f5e"]) {
      assert.ok(!page.includes(bright), `${bright} is back: white on it fails 4.5:1`);
    }
  });

  /** [label, foreground, foreground alpha, background, minimum ratio] */
  const PAIRS: Array<[string, string, number, string, number]> = [
    // The pairs this audit changed.
    ["liquid button label, rest", "mist-200", 1, "ink-900", 4.5],
    ["liquid button label, hover (was text-white)", "mist-100", 1, "ink-900", 4.5],
    ["nav / segmented pill, active label", "mist-100", 1, "ink-700", 4.5],
    ["nav / segmented pill, active border", "brand-500", 0.55, "ink-700", 3.0],
    ["nav / segmented pill, hover label", "mist-200", 1, "ink-800", 4.5],
    ["showcase contact link, rest", "mist-200", 1, "ink-900", 4.5],
    ["showcase contact link, hover (was text-white)", "mist-100", 1, "ink-900", 4.5],
    ["showcase chrome button, hover (was text-white)", "mist-100", 1, "ink-800", 4.5],
    ["error boundary body", "mist-300", 1, "ink-900", 4.5],
    ["error boundary button, hover", "mist-100", 1, "ink-800", 4.5],
    ["solid accent button label (was text-white)", "a-on", 1, "brand-500", 4.5],
    ["review auto-reply knob, on (was bg-white)", "a-on", 1, "brand-500", 3.0],
    ["review auto-reply knob, off", "mist-100", 1, "ink-600", 3.0],
    ["Onyx lift-lobby label", "mist-300", 1, "ink-800", 4.5],
    ["local rank cell, top 3", "#ffffff", 1, "#15803d", 4.5],
    ["local rank cell, 4-10", "#ffffff", 1, "#b45309", 4.5],
    ["local rank cell, 11+", "#ffffff", 1, "#be123c", 4.5],
    // Token-level baselines: if these regress, every screen regresses with them.
    ["muted text on the page", "mist-400", 1, "ink-950", 4.5],
    ["muted text on a card", "mist-400", 1, "ink-900", 4.5],
    ["muted text on a raised surface", "mist-400", 1, "ink-800", 4.5],
    ["secondary text on a card", "mist-300", 1, "ink-900", 4.5],
    ["status good on a card", "good-400", 1, "ink-900", 4.5],
    ["status warn on a card", "warn-400", 1, "ink-900", 4.5],
    ["status bad on a card", "bad-400", 1, "ink-900", 4.5],
  ];

  for (const [label, fg, alpha, bg, min] of PAIRS) {
    for (const theme of ["dark", "light"] as const) {
      test(`${label} clears ${min}:1 in ${theme}`, () => {
        const back = hex(theme, bg);
        const front = alpha === 1 ? hex(theme, fg) : flatten(hex(theme, fg), back, alpha);
        const ratio = contrast(front, back);
        assert.ok(
          ratio >= min,
          `${label} in ${theme}: ${front} on ${back} is ${ratio.toFixed(2)}:1, needs ${min}:1`,
        );
      });
    }
  }

  test("the review auto-reply knob is not painted a raw white", () => {
    const src = fs.readFileSync(path.join(ROOT, "src/components/reviews-panel.tsx"), "utf8");
    const knob = src.match(/autoReply \? "left-\[18px\][^"]*" : "left-0\.5[^"]*"/);
    assert.ok(knob, "auto-reply knob classes not found");
    assert.ok(!/bg-white|bg-black|bg-slate-|bg-gray-/.test(knob[0]),
      `knob uses a non-flipping colour: ${knob[0]}`);
    assert.match(knob[0], /bg-\[var\(--a-on\)\]/);
    assert.match(knob[0], /bg-mist-100/);
  });
});

describe("dark: variant tracks the app's resolved theme, not the OS", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");
  const block = css.match(/@custom-variant dark \{[\s\S]*?\n\}\n/)?.[0];

  test("globals.css redefines the dark variant", () => {
    assert.ok(block, "no `@custom-variant dark` block — `dark:` falls back to prefers-color-scheme");
  });

  test("it matches explicit data-theme=dark", () => {
    assert.match(block!, /:root\[data-theme="dark"\]/);
  });

  test("OS preference only applies when no explicit theme is set", () => {
    const media = block!.match(/@media \(prefers-color-scheme: dark\)[\s\S]*/)?.[0];
    assert.ok(media, "no prefers-color-scheme case for the 'system' state");
    assert.match(media, /:root:not\(\[data-theme="dark"\]\):not\(\[data-theme="light"\]\)/);
  });
});

describe("active states are visible in light mode", () => {
  /**
   * The sidebar item, the range pills and LiquidSegmentedControl once marked
   * "active" with `bg-white/15 dark:bg-white/12 border-white/20`. Flattened
   * over the light page that is ~1.02:1 against the track — no visible active
   * state at all. The boundary is now carried by an accent-tinted border.
   */
  const FILES = ["src/components/shell.tsx", "src/components/ui.tsx"];

  for (const file of FILES) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");

    test(`${file} has no white/black active fills`, () => {
      // Only the `active ? "..."` branches; a white hairline over a brand
      // gradient elsewhere is decorative and flips with the gradient.
      const branches = src.match(/\bactive\s*\?\s*"[^"]*"/g) ?? [];
      assert.ok(branches.length > 0, `${file}: no active branch found`);
      for (const branch of branches) {
        assert.ok(
          !/(bg|border)-(white|black)\/\d+/.test(branch),
          `${file} paints an active state with a non-flipping raw colour: ${branch}`,
        );
      }
    });

    test(`${file} marks the active state with the accent border`, () => {
      assert.match(src, /bg-ink-700 text-mist-100 shadow-sm border border-brand-500\/55/);
    });
  }
});

describe("chat bubble decorations flip with the accent bubble", () => {
  /**
   * The "mine" bubble is `bg-brand-500` — near-black in light mode, near-white
   * in dark. Its inner decorations (quoted-reply strip, media placeholder,
   * progress fill, inline edit input) once used `border-white/50 bg-black/20`,
   * which vanished in dark and flattened in light. They must ride --a-on, the
   * colour defined to contrast with the accent.
   */
  const file = "src/components/messaging/message-bubble.tsx";
  const src = fs.readFileSync(path.join(ROOT, file), "utf8");

  test("no raw white/black alpha fills or borders", () => {
    assert.ok(
      !/(bg|border|text)-(white|black)\/\d+/.test(src),
      `${file} paints a bubble decoration with a non-flipping raw colour`,
    );
  });

  test("decorations use var(--a-on) alphas", () => {
    assert.match(src, /border-\[var\(--a-on\)\]\/\d+/);
    assert.match(src, /bg-\[var\(--a-on\)\]\/\d+/);
  });
});

describe("onyx explorer panels keep their edges in light mode", () => {
  /**
   * The floor/unit panels float over the photoreal render. Their edges were
   * `border-white/15` with a `border-b border-white/10` header rule, and the
   * lift-lobby cell was `border-white/15 bg-white/5` — all invisible in light
   * mode, where the panel background (ink-900) is #ffffff.
   */
  const FILE = "src/components/showcase/onyx-tower-explorer.tsx";
  const src = fs.readFileSync(path.join(ROOT, FILE), "utf8");

  test("panel shells use flipping surface tokens", () => {
    for (const shell of src.match(/className="flex size-full flex-col[^"]*"/g) ?? []) {
      assert.ok(shell.includes("border-ink-500"), `panel shell keeps a raw edge: ${shell}`);
      assert.ok(!/border-white\//.test(shell), `panel shell keeps a white edge: ${shell}`);
    }
  });

  test("panel header rule and lift-lobby cell use ink tokens", () => {
    assert.match(src, /border-b border-ink-700/);
    assert.match(src, /border border-ink-700 bg-ink-800\/40[^"]*text-mist-300/);
    assert.ok(!/bg-white\/\d+/.test(src), "a white wash survives in the explorer");
  });
});

describe("app render-error boundary is themed", () => {
  /**
   * The one screen a user sees when something has already gone wrong was
   * hard-coded `bg-white` / `text-black/60` / `border-black/10` /
   * `hover:bg-black/5`, flashing a white card in dark mode.
   */
  const FILE = "src/app/(app)/error.tsx";
  const src = fs.readFileSync(path.join(ROOT, FILE), "utf8");

  test("no raw white/black colours", () => {
    assert.ok(
      !/(bg|text|border)-(white|black)(\/\d+)?\b/.test(src),
      `${FILE} paints the error card with a non-flipping raw colour`,
    );
  });

  test("card and button use flipping tokens", () => {
    assert.match(src, /border border-ink-700 bg-ink-900/);
    assert.match(src, /text-sm text-mist-300/);
    assert.match(src, /text-mist-200 hover:bg-ink-800 hover:text-mist-100/);
  });
});

describe("every semantic ramp step used in the UI is declared in @theme", () => {
  /**
   * Tailwind v4 emits a utility only for keys that exist in `@theme`. An
   * undeclared step in a custom namespace — `text-mist-500`, `text-brand-300` —
   * compiles to nothing at all: no error, no class, the element silently
   * inherits the body colour. That is how ~60 faint captions, placeholders and
   * badge labels rendered at full --t-primary weight in both themes.
   *
   * So: collect every `<util>-<ramp>-<step>` the UI actually uses, and require
   * a matching `--color-*` key. Then require each of those keys to point at a
   * variable that resolves in all three theme blocks, since a key backed by an
   * undefined var is the same invisible failure one level down.
   */
  const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");
  const theme = css.match(/@theme \{[\s\S]*?\n\}/)?.[0];
  assert.ok(theme, "no @theme block in globals.css");

  const declared = new Set(
    [...theme!.matchAll(/--color-([a-z]+-\d+):/g)].map((m) => m[1]),
  );
  /** key -> the var() it is backed by, for the resolution check below. */
  const backing = new Map(
    [...theme!.matchAll(/--color-([a-z]+-\d+):\s*var\((--[a-z0-9-]+)\)/g)].map(
      (m) => [m[1], m[2]] as const,
    ),
  );

  const RAMPS = "ink|mist|brand|good|warn|bad|viz";
  const USE = new RegExp(
    String.raw`(?:^|[\s"'\`])(?:[a-z-]+:)*` +
      String.raw`(?:text|bg|border|ring|fill|stroke|from|via|to|divide|placeholder|decoration|outline|accent|caret)` +
      String.raw`-((?:${RAMPS})-\d+)`,
    "g",
  );

  /** Walk the same trees the raw-colour guard above walks. */
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx?|css)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of SCAN) walk(path.join(ROOT, d));

  const used = new Map<string, string>();
  for (const f of files) {
    for (const [, step] of fs.readFileSync(f, "utf8").matchAll(USE)) {
      if (!used.has(step)) used.set(step, path.relative(ROOT, f));
    }
  }

  test("the UI references at least the known faint tiers", () => {
    // Guards the scanner itself: if this ever finds nothing, the assertions
    // below would pass vacuously.
    assert.ok(used.size > 10, `only ${used.size} ramp steps found — scanner broke`);
  });

  for (const [step, where] of [...used].sort()) {
    test(`${step} is declared (first used in ${where})`, () => {
      assert.ok(
        declared.has(step),
        `${step} is used in ${where} but has no --color-${step} in @theme; ` +
          `Tailwind emits no class for it and the element falls through to the inherited colour`,
      );
    });
  }

  const BLOCKS: Array<[string, RegExp]> = [
    ["dark :root", /:root \{[\s\S]*?\n\}/],
    ["prefers-color-scheme: light", /@media \(prefers-color-scheme: light\) \{[\s\S]*?\n  \}\n\}/],
    ["[data-theme=light]", /:root\[data-theme="light"\] \{[\s\S]*?\n\}/],
  ];

  for (const [name, re] of BLOCKS) {
    const block = css.match(re)?.[0];
    test(`${name} block exists`, () => assert.ok(block, `no ${name} block`));
    for (const [step, v] of backing) {
      if (!used.has(step)) continue;
      test(`${step} resolves in ${name}`, () => {
        assert.ok(
          new RegExp(`${v}:\\s*[^;]+;`).test(block!),
          `--color-${step} points at ${v}, which is not declared in the ${name} block`,
        );
      });
    }
  }
});

/**
 * Keyboard focus guard.
 *
 * Two dozen inputs and selects carry Tailwind's `outline-none`, which strips the
 * browser's own focus ring. globals.css restores one with an unlayered
 * `:focus-visible` rule (unlayered so it beats the utilities layer without
 * `!important`). Deleting that rule silently reintroduces a WCAG 2.4.7 failure
 * on every form surface, so it is asserted here.
 */
describe("form controls keep a visible keyboard focus ring", () => {
  const css = fs.readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");
  const rule = css.match(
    /input:focus-visible,\s*select:focus-visible,\s*textarea:focus-visible\s*\{[^}]*\}/,
  )?.[0];

  test("the focus-visible rule exists for input, select and textarea", () => {
    assert.ok(
      rule,
      "no input/select/textarea:focus-visible rule in globals.css; " +
        "the outline-none utilities leave the focus cursor invisible",
    );
  });

  test("it declares a non-none outline", () => {
    const outline = rule!.match(/outline:\s*([^;]+);/)?.[1]?.trim();
    assert.ok(outline, "the focus-visible rule declares no outline");
    assert.ok(
      !/^none$/i.test(outline!) && /\d/.test(outline!),
      `focus outline is "${outline}"; it must have a visible width`,
    );
  });

  test("it is not nested inside an @layer, so it beats the utilities layer", () => {
    const before = css.slice(0, css.indexOf(rule!));
    const opens = (before.match(/\{/g) ?? []).length;
    const closes = (before.match(/\}/g) ?? []).length;
    assert.equal(
      opens,
      closes,
      "the focus-visible rule sits inside a block (@layer or @media); " +
        "Tailwind's utilities layer would then win and outline-none would still apply",
    );
  });
});
