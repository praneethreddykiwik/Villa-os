import type { ComponentOverride, PricingComponent, UnitAttributes } from "./types";

/**
 * NATURAL-LANGUAGE PRICING CHANGES
 *
 * The workflow this serves: a director is sitting across from a buyer, says
 * "change the base price to 4,800", and the sheet on screen updates in front of
 * them instead of being re-exported from a spreadsheet.
 *
 * Three rules make that safe:
 *  1. Parsing is deterministic. Ambiguity returns a question, never a guess —
 *     silently altering the wrong row during a live negotiation is worse than
 *     saying "which charge did you mean?".
 *  2. It returns an *intent*, not a mutation. Applying is a separate,
 *     authorised, audited step.
 *  3. It cannot invent components. It can only address rows that already exist
 *     in the configured model.
 */

export type PricingIntent =
  | { kind: "SET_RATE"; componentId: string; label: string; value: number; previous: number }
  | { kind: "WAIVE"; componentId: string; label: string }
  | { kind: "REINSTATE"; componentId: string; label: string }
  | { kind: "SET_UNIT"; field: keyof UnitAttributes; value: number | string; previous: number | string | undefined }
  | { kind: "AMBIGUOUS"; message: string; candidates: Array<{ id: string; label: string }> }
  | { kind: "UNRECOGNISED"; message: string };

/**
 * Indian numeric forms. "4,800" is 4800; "5 lakh" is 500000; "1.2 cr" is
 * 12000000. A per-sft rate is written plainly, a flat charge is often written
 * in lakh, so both have to parse.
 */
export function parseAmount(raw: string): number | null {
  const text = raw.toLowerCase().replace(/,/g, "").trim();
  const m = text.match(/(\d+(?:\.\d+)?)\s*(cr|crore|crores|l|lac|lakh|lakhs|k)?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  switch (m[2]) {
    case "cr": case "crore": case "crores": return n * 1e7;
    case "l": case "lac": case "lakh": case "lakhs": return n * 1e5;
    case "k": return n * 1e3;
    default: return n;
  }
}

/** Token overlap against the row label — tolerant of word order and plurals. */
function score(label: string, phrase: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  const a = new Set(norm(label));
  const b = norm(phrase);
  if (!a.size || !b.length) return 0;
  const hits = b.filter((w) => a.has(w) || [...a].some((x) => x.startsWith(w) || w.startsWith(x))).length;
  return hits / Math.max(a.size, b.length);
}

const WAIVE_WORDS = /\b(remove|cancel|waive|drop|delete|take off|forget|scrap|no)\b/i;
const REINSTATE_WORDS = /\b(reinstate|restore|add back|put back|re-?apply|bring back)\b/i;
const SET_WORDS = /\b(change|set|make|update|reduce|lower|increase|raise|revise)\b/i;

/**
 * Parse one instruction against the model's actual components.
 * `components` is the entire vocabulary this parser has — nothing else exists.
 */
export function parseInstruction(
  instruction: string,
  components: PricingComponent[],
  unit: UnitAttributes,
  currentOverrides: ComponentOverride[] = [],
): PricingIntent {
  const text = instruction.trim();
  if (!text) return { kind: "UNRECOGNISED", message: "Nothing to do." };

  /* ---- Unit attributes ------------------------------------------------- */
  const areaMatch = text.match(/\b(?:area|size|sft|square\s*(?:feet|foot))\D{0,12}(\d[\d,]*)/i);
  if (areaMatch && /\b(change|set|make|update|to|is)\b/i.test(text)) {
    const value = parseAmount(areaMatch[1]);
    if (value) return { kind: "SET_UNIT", field: "areaSqft", value, previous: unit.areaSqft };
  }
  const floorMatch = text.match(/\bfloor\D{0,12}(\d+)\b/i);
  if (floorMatch && SET_WORDS.test(text) && !/floor\s*rise/i.test(text)) {
    return { kind: "SET_UNIT", field: "floor", value: Number(floorMatch[1]), previous: unit.floor };
  }

  /* ---- Which row is being talked about? -------------------------------- */
  const ranked = components
    .filter((c) => c.active)
    .map((c) => ({ c, s: score(c.label, text) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (!ranked.length) {
    return {
      kind: "UNRECOGNISED",
      message: `I could not match that to a charge on this sheet. Available rows: ${components.filter((c) => c.active).map((c) => c.label).join(", ")}.`,
    };
  }

  // A near-tie is genuinely ambiguous — "corner charge" vs "corner premium".
  const top = ranked[0];
  const contenders = ranked.filter((x) => x.s >= top.s - 0.001);
  if (contenders.length > 1) {
    return {
      kind: "AMBIGUOUS",
      message: "That could mean more than one row. Which did you mean?",
      candidates: contenders.map((x) => ({ id: x.c.id, label: x.c.label })),
    };
  }

  const component = top.c;
  const isWaived = currentOverrides.some((o) => o.componentId === component.id && o.waived);

  if (REINSTATE_WORDS.test(text)) {
    return { kind: "REINSTATE", componentId: component.id, label: component.label };
  }
  if (WAIVE_WORDS.test(text)) {
    if (!component.negotiable) {
      return { kind: "UNRECOGNISED", message: `"${component.label}" is marked non-negotiable and cannot be waived.` };
    }
    return { kind: "WAIVE", componentId: component.id, label: component.label };
  }

  // "to 4,800" / "at 4800" / a bare number when a change verb is present.
  const valueMatch = text.match(/(?:to|at|=|:)\s*([\d.,]+\s*(?:cr|crore|crores|l|lac|lakh|lakhs|k)?)/i)
    ?? (SET_WORDS.test(text) ? text.match(/([\d][\d.,]*\s*(?:cr|crore|crores|l|lac|lakh|lakhs|k)?)\s*$/i) : null);

  if (valueMatch) {
    if (!component.negotiable) {
      return { kind: "UNRECOGNISED", message: `"${component.label}" is marked non-negotiable and cannot be changed.` };
    }
    const value = parseAmount(valueMatch[1]);
    if (value === null) return { kind: "UNRECOGNISED", message: `I could not read "${valueMatch[1]}" as an amount.` };
    const current = currentOverrides.find((o) => o.componentId === component.id)?.value ?? component.value;
    return { kind: "SET_RATE", componentId: component.id, label: component.label, value, previous: current };
  }

  if (isWaived) {
    return { kind: "REINSTATE", componentId: component.id, label: component.label };
  }

  return {
    kind: "UNRECOGNISED",
    message: `I matched "${component.label}" but could not tell what to do with it. Try "set ${component.label} to 4800" or "waive ${component.label}".`,
  };
}

/** Fold an intent into the override set. Pure — the caller decides to persist. */
export function applyIntent(intent: PricingIntent, overrides: ComponentOverride[]): ComponentOverride[] {
  const next = overrides.filter((o) => !("componentId" in intent) || o.componentId !== intent.componentId);
  switch (intent.kind) {
    case "SET_RATE":
      return [...next, { componentId: intent.componentId, value: intent.value }];
    case "WAIVE":
      return [...next, { componentId: intent.componentId, waived: true }];
    case "REINSTATE":
      return next;
    default:
      return overrides;
  }
}

/** One-line summary for the confirmation prompt and the audit record. */
export function describeIntent(intent: PricingIntent): string {
  switch (intent.kind) {
    case "SET_RATE":
      return `Set "${intent.label}" from ${intent.previous.toLocaleString("en-IN")} to ${intent.value.toLocaleString("en-IN")}`;
    case "WAIVE":
      return `Waive "${intent.label}"`;
    case "REINSTATE":
      return `Reinstate "${intent.label}"`;
    case "SET_UNIT":
      return `Set ${String(intent.field)} to ${intent.value}`;
    case "AMBIGUOUS":
      return intent.message;
    default:
      return intent.message;
  }
}
