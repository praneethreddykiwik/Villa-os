import type {
  ComponentOverride, PercentageBasis, PricingComponent, QuoteLine, QuoteTotals, QuoteVersion, UnitAttributes,
} from "./types";

/**
 * PRICE CALCULATION — pure.
 *
 * Given a component set, the unit's attributes and any negotiated overrides,
 * produce the line items and totals. No I/O, no stored state: the same inputs
 * always produce the same sheet, which is what makes an old version
 * reproducible months later when someone asks how a number was reached.
 */

/** Rounded to whole rupees — a quotation sheet never shows paise. */
function rupees(n: number): number {
  return Math.round(n);
}

/** Does this component apply to this unit? */
export function applies(component: PricingComponent, unit: UnitAttributes): boolean {
  const w = component.appliesWhen;
  if (!w) return true;
  if (w.facingIn?.length && (!unit.facing || !w.facingIn.includes(unit.facing))) return false;
  if (w.cornerOnly && !unit.corner) return false;
  if (w.minFloor !== undefined && unit.floor < w.minFloor) return false;
  if (w.minAreaSqft !== undefined && unit.areaSqft < w.minAreaSqft) return false;
  if (w.unitTypeIn?.length && (!unit.unitType || !w.unitTypeIn.includes(unit.unitType))) return false;
  return true;
}

function describe(component: PricingComponent, rate: number, unit: UnitAttributes): string {
  switch (component.kind) {
    case "base_per_sft":
    case "per_sft":
      return `${rate.toLocaleString("en-IN")} × ${unit.areaSqft.toLocaleString("en-IN")} sft`;
    case "per_floor_per_sft": {
      const floors = Math.max(0, unit.floor - (component.baseFloor ?? 0));
      return `${rate.toLocaleString("en-IN")} × ${unit.areaSqft.toLocaleString("en-IN")} sft × ${floors} floor${floors === 1 ? "" : "s"}`;
    }
    case "percentage":
      return `${rate}% of ${basisLabel(component.basis)}`;
    case "flat":
    default:
      return "Fixed";
  }
}

function basisLabel(basis?: PercentageBasis): string {
  if (!basis || basis === "subtotal") return "subtotal";
  if (basis === "base_only") return "base value";
  return "selected components";
}

/**
 * Two passes: everything concrete first, then percentages over whatever basis
 * they name. A single pass cannot work — GST charged on the subtotal has to see
 * the subtotal, and a component ordered before it would otherwise be missed.
 */
export function calculate(
  components: PricingComponent[],
  unit: UnitAttributes,
  overrides: ComponentOverride[] = [],
): { lines: QuoteLine[]; totals: QuoteTotals } {
  const overrideFor = new Map(overrides.map((o) => [o.componentId, o]));
  const active = components
    .filter((c) => c.active)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const lines: QuoteLine[] = [];
  const amountById = new Map<string, number>();

  const concrete = active.filter((c) => c.kind !== "percentage");
  for (const component of concrete) {
    const o = overrideFor.get(component.id);
    const relevant = applies(component, unit);
    const waived = Boolean(o?.waived) || !relevant;
    const rate = o?.value ?? component.value;

    let amount = 0;
    if (!waived) {
      switch (component.kind) {
        case "base_per_sft":
        case "per_sft":
          amount = rate * unit.areaSqft;
          break;
        case "per_floor_per_sft":
          amount = rate * unit.areaSqft * Math.max(0, unit.floor - (component.baseFloor ?? 0));
          break;
        case "flat":
          amount = rate;
          break;
      }
    }
    amount = rupees(amount);
    amountById.set(component.id, amount);

    // A component that simply does not apply to this unit is not shown; one that
    // applies but was waived in negotiation IS shown, struck through, because
    // "I cancelled the east-facing charge for you" is the point of the sheet.
    if (!relevant && !o?.waived) continue;

    lines.push({
      componentId: component.id,
      label: component.label,
      kind: component.kind,
      category: component.category,
      rate,
      basis: describe(component, rate, unit),
      amount,
      waived,
      overridden: o?.value !== undefined,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.amount, 0);
  const baseAmount = lines.filter((l) => l.kind === "base_per_sft").reduce((s, l) => s + l.amount, 0);

  for (const component of active.filter((c) => c.kind === "percentage")) {
    const o = overrideFor.get(component.id);
    const relevant = applies(component, unit);
    const waived = Boolean(o?.waived) || !relevant;
    const rate = o?.value ?? component.value;

    let basisAmount = subtotal;
    if (component.basis === "base_only") basisAmount = baseAmount;
    else if (component.basis && component.basis !== "subtotal") {
      basisAmount = component.basis.componentIds.reduce((s, id) => s + (amountById.get(id) ?? 0), 0);
    }

    const amount = waived ? 0 : rupees((basisAmount * rate) / 100);
    amountById.set(component.id, amount);
    if (!relevant && !o?.waived) continue;

    lines.push({
      componentId: component.id,
      label: component.label,
      kind: component.kind,
      category: component.category,
      rate,
      basis: describe(component, rate, unit),
      amount,
      waived,
      overridden: o?.value !== undefined,
    });
  }

  const byCategory = (c: PricingComponent["category"]) =>
    lines.filter((l) => l.category === c).reduce((s, l) => s + l.amount, 0);

  const grandTotal = lines.reduce((s, l) => s + l.amount, 0);

  return {
    lines,
    totals: {
      base: byCategory("BASE"),
      preferential: byCategory("PREFERENTIAL"),
      amenity: byCategory("AMENITY"),
      statutory: byCategory("STATUTORY"),
      other: byCategory("OTHER"),
      subtotal,
      grandTotal,
      effectiveRatePerSqft: unit.areaSqft ? rupees(grandTotal / unit.areaSqft) : 0,
    },
  };
}

export interface LineDiff {
  label: string;
  before?: number;
  after?: number;
  delta: number;
  change: "ADDED" | "REMOVED" | "WAIVED" | "REINSTATED" | "RATE_CHANGED" | "UNCHANGED";
}

export interface VersionDiff {
  lines: LineDiff[];
  totalBefore: number;
  totalAfter: number;
  delta: number;
}

/**
 * Compare two versions. This is the digital equivalent of putting the old
 * printout beside the new one — the client's stated way of running a
 * negotiation, and the reason versions are immutable.
 */
export function diffVersions(before: QuoteVersion, after: QuoteVersion): VersionDiff {
  const beforeById = new Map(before.lines.map((l) => [l.componentId, l]));
  const afterById = new Map(after.lines.map((l) => [l.componentId, l]));
  const ids = [...new Set([...beforeById.keys(), ...afterById.keys()])];

  const lines: LineDiff[] = ids.map((id) => {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    const label = a?.label ?? b?.label ?? id;
    const beforeAmount = b?.amount;
    const afterAmount = a?.amount;
    const delta = (afterAmount ?? 0) - (beforeAmount ?? 0);

    let change: LineDiff["change"] = "UNCHANGED";
    if (!b && a) change = "ADDED";
    else if (b && !a) change = "REMOVED";
    else if (b && a) {
      if (!b.waived && a.waived) change = "WAIVED";
      else if (b.waived && !a.waived) change = "REINSTATED";
      else if (b.rate !== a.rate) change = "RATE_CHANGED";
    }

    return { label, before: beforeAmount, after: afterAmount, delta, change };
  });

  return {
    lines: lines.filter((l) => l.change !== "UNCHANGED" || l.delta !== 0),
    totalBefore: before.totals.grandTotal,
    totalAfter: after.totals.grandTotal,
    delta: after.totals.grandTotal - before.totals.grandTotal,
  };
}
