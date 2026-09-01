/**
 * PROPERTY PRICING & NEGOTIATION
 *
 * Models the priced quotation sheet a builder hands a buyer — the thing that is
 * a spreadsheet today, reprinted on every round of negotiation.
 *
 * The requirement, in the client's own terms: a base rate per sft, then rows for
 * east-facing, corner, floor-rise (₹25/sft *per floor*), amenities, parking,
 * documentation, registration and GST — "at least 10 to 15 rows". Some rows are
 * charged per square foot and therefore differ per buyer; others are flat and
 * identical for everyone. During negotiation a component is waived or a rate
 * tweaked, and a *new sheet* is produced while the old one is kept beside it for
 * comparison.
 *
 * Two consequences drive this design:
 *  1. Calculation is a pure function of (component set + unit attributes +
 *     overrides). It never mutates a stored total.
 *  2. A negotiation produces a new immutable version. Nothing is overwritten,
 *     because "what did we offer him last week?" must always be answerable.
 */

export type ComponentKind =
  /** Rate per square foot — the base rate row. */
  | "base_per_sft"
  /** Any other per-square-foot charge. */
  | "per_sft"
  /** Fixed amount, identical for every buyer. */
  | "flat"
  /** Rate per sft applied once per floor above the base floor (floor rise). */
  | "per_floor_per_sft"
  /** Percentage of a configured basis (GST, for example). */
  | "percentage";

/** What a percentage component is charged on. */
export type PercentageBasis =
  | "subtotal"
  /** Only the base-rate row — the usual basis for statutory charges. */
  | "base_only"
  /** An explicit list of component ids. */
  | { componentIds: string[] };

/**
 * Conditions are a closed, typed set rather than an expression language.
 * A builder's sales team configures these; letting them write arbitrary
 * predicates would be both a support burden and an injection surface.
 */
export interface AppliesWhen {
  facingIn?: Facing[];
  cornerOnly?: boolean;
  minFloor?: number;
  minAreaSqft?: number;
  unitTypeIn?: string[];
}

export const FACINGS = ["EAST", "WEST", "NORTH", "SOUTH", "NORTH_EAST", "NORTH_WEST", "SOUTH_EAST", "SOUTH_WEST"] as const;
export type Facing = (typeof FACINGS)[number];

export interface PricingComponent {
  id: string;
  orgId: string;
  modelId: string;
  /** Row label as it appears on the customer's sheet. */
  label: string;
  kind: ComponentKind;
  /** Rate, amount or percent depending on `kind`. */
  value: number;
  basis?: PercentageBasis;
  /** Floor from which floor-rise starts accruing. */
  baseFloor?: number;
  appliesWhen?: AppliesWhen;
  /** Whether sales may waive or alter it during negotiation. */
  negotiable: boolean;
  /** Grouping on the printed sheet. */
  category: "BASE" | "PREFERENTIAL" | "AMENITY" | "STATUTORY" | "OTHER";
  sortOrder: number;
  active: boolean;
  notes?: string;
}

export interface PricingModel {
  id: string;
  orgId: string;
  /** The project or phase this sheet belongs to. */
  projectId: string;
  name: string;
  currency: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** The buyer-specific inputs that make one sheet differ from another. */
export interface UnitAttributes {
  unitRef?: string;
  areaSqft: number;
  floor: number;
  facing?: Facing;
  corner?: boolean;
  unitType?: string;
}

/** A negotiated deviation from the configured component. */
export interface ComponentOverride {
  componentId: string;
  /** Removed from this quote entirely — "I cancelled the east-facing charge". */
  waived?: boolean;
  /** Replacement rate/amount — "change the base price to 4,800". */
  value?: number;
  reason?: string;
}

export interface QuoteLine {
  componentId: string;
  label: string;
  kind: ComponentKind;
  category: PricingComponent["category"];
  /** The rate actually used, after overrides. */
  rate: number;
  /** How the amount was reached, in words, for the printed sheet. */
  basis: string;
  amount: number;
  waived: boolean;
  overridden: boolean;
}

export interface QuoteTotals {
  base: number;
  preferential: number;
  amenity: number;
  statutory: number;
  other: number;
  subtotal: number;
  grandTotal: number;
  /** Effective all-in rate per sft — the number buyers actually compare. */
  effectiveRatePerSqft: number;
}

export interface QuoteVersion {
  id: string;
  orgId: string;
  quoteId: string;
  version: number;
  modelId: string;
  customerId?: string;
  unit: UnitAttributes;
  overrides: ComponentOverride[];
  lines: QuoteLine[];
  totals: QuoteTotals;
  /** Set when this version replaced an earlier one. */
  supersedesVersionId?: string;
  note?: string;
  createdById?: string;
  createdAt: string;
}

export interface Quote {
  id: string;
  orgId: string;
  modelId: string;
  customerId?: string;
  projectId: string;
  currentVersionId?: string;
  status: "DRAFT" | "SHARED" | "NEGOTIATING" | "ACCEPTED" | "LOST";
  createdById?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PricingDatabase {
  pricingModels: PricingModel[];
  pricingComponents: PricingComponent[];
  quotes: Quote[];
  quoteVersions: QuoteVersion[];
}

export const EMPTY_PRICING: PricingDatabase = {
  pricingModels: [],
  pricingComponents: [],
  quotes: [],
  quoteVersions: [],
};
