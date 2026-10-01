import { db } from "./supabase";

/**
 * Read and write side of the Properties section — projects, villa types, live
 * units, and plan assets.
 *
 * The knowledge base is the only thing the AI agent may quote from, so the
 * shape of a NULL matters here: a missing price or bedroom count is not a gap
 * to be filled in by the UI, it is a fact that has not been approved for the
 * agent to state. Nothing in this file substitutes a default for one.
 */

// -----------------------------------------------------------------------------
// Unit status
// -----------------------------------------------------------------------------

export const UNIT_STATUSES = ["available", "under_booking", "reserved", "sold", "blocked"] as const;

export type UnitStatus = (typeof UNIT_STATUSES)[number];

const STATUS_SET = new Set<string>(UNIT_STATUSES);

export function isUnitStatus(value: string): value is UnitStatus {
  return STATUS_SET.has(value);
}

export const UNIT_STATUS_LABELS: Record<UnitStatus, string> = {
  available: "Available",
  under_booking: "Under booking",
  reserved: "Reserved",
  sold: "Sold",
  blocked: "Blocked",
};

/**
 * Board tile styling. Available is the only state that gets a positive colour;
 * sold and blocked recede so a mostly-sold board reads as depleted at a glance
 * rather than as a wall of noise.
 */
export const UNIT_STATUS_TILE: Record<UnitStatus, string> = {
  available: "border-[rgba(94,201,141,0.35)] bg-[rgba(94,201,141,0.13)] text-[var(--color-success)]",
  under_booking: "border-[rgba(239,180,92,0.35)] bg-[rgba(239,180,92,0.13)] text-[var(--color-warm)]",
  reserved: "border-[rgba(109,168,232,0.35)] bg-[rgba(109,168,232,0.13)] text-[var(--color-info)]",
  sold: "border-[var(--color-line-strong)] bg-[var(--color-raised)] text-[var(--color-muted)]",
  blocked: "border-dashed border-[var(--color-line)] bg-transparent text-[var(--color-faint)]",
};

/** Solid swatch for the legend and the per-type count pills. */
export const UNIT_STATUS_DOT: Record<UnitStatus, string> = {
  available: "bg-[var(--color-success)]",
  under_booking: "bg-[var(--color-warm)]",
  reserved: "bg-[var(--color-info)]",
  sold: "bg-[var(--color-line-strong)]",
  blocked: "bg-[var(--color-line)]",
};

export type StatusCounts = Record<UnitStatus, number>;

function emptyCounts(): StatusCounts {
  return { available: 0, under_booking: 0, reserved: 0, sold: 0, blocked: 0 };
}

function addCounts(into: StatusCounts, from: StatusCounts): void {
  for (const status of UNIT_STATUSES) into[status] += from[status];
}

function sumCounts(counts: StatusCounts): number {
  return UNIT_STATUSES.reduce((total, status) => total + counts[status], 0);
}

/**
 * Share of stock that has left the market.
 *
 * Blocked units are excluded from the numerator — a plot held back for the
 * developer has not been absorbed by a buyer. Returns null on an empty board so
 * callers render an em dash rather than 0%, which would read as "nothing is
 * selling" when the truth is "nothing is loaded".
 */
export function absorption(counts: StatusCounts): number | null {
  const total = sumCounts(counts);
  if (total === 0) return null;
  return ((counts.sold + counts.reserved + counts.under_booking) / total) * 100;
}

// Unit numbers mix letters and digits ("A-9", "A-10"), which sort wrong
// lexically — A-10 would land before A-9 and the board would look shuffled.
const naturally = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

// -----------------------------------------------------------------------------
// Row shapes
// -----------------------------------------------------------------------------

export interface ProjectCardRow {
  id: string;
  slug: string;
  name: string;
  developer: string | null;
  status: string | null;
  phase: string | null;
  expected_delivery: string | null;
  village: string | null;
  mandal: string | null;
  district: string | null;
  state: string | null;
  rera_number: string | null;
  rera_status: string | null;
  hmda_permit_no: string | null;
  total_land_acres: number | null;
  total_units: number | null;
  configurations: string[] | null;
  starting_price_inr: number | null;
  max_price_inr: number | null;
  price_note: string | null;
  cover_image: string | null;
  positioning: string | null;
}

const PROJECT_CARD_COLUMNS =
  "id, slug, name, developer, status, phase, expected_delivery, village, mandal, district, state, " +
  "rera_number, rera_status, hmda_permit_no, total_land_acres, total_units, configurations, " +
  "starting_price_inr, max_price_inr, price_note, cover_image, positioning";

export interface ProjectRow extends ProjectCardRow {
  launch_date: string | null;
  address_line: string | null;
  pincode: string | null;
  survey_no: string | null;
  maps_url: string | null;
  hmda_permit_date: string | null;
  currency: string;
  gallery: unknown;
  usps: unknown;
  amenities: unknown;
  specifications: unknown;
  sustainability: unknown;
  connectivity: unknown;
  social_infrastructure: unknown;
  financing_partners: string[] | null;
  updated_at: string;
}

export interface VillaTypeRow {
  id: string;
  project_id: string;
  name: string;
  plot_area_sqyd: number | null;
  built_up_sft: number | null;
  carpet_area_sft: number | null;
  facing: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  floors: number | null;
  has_home_theatre: boolean | null;
  has_maid_room: boolean | null;
  private_pool: boolean | null;
  price_inr: number | null;
  floor_plan_url: string | null;
  verification_note: string | null;
}

const VILLA_TYPE_COLUMNS =
  "id, project_id, name, plot_area_sqyd, built_up_sft, carpet_area_sft, facing, bedrooms, bathrooms, " +
  "floors, has_home_theatre, has_maid_room, private_pool, price_inr, floor_plan_url, verification_note";

export interface UnitRow {
  id: string;
  project_id: string;
  villa_type_id: string | null;
  unit_number: string;
  facing: string | null;
  plot_area_sqyd: number | null;
  chargeable_extra_sqyd: number | null;
  saleable_sft: number | null;
  is_corner: boolean;
  price_inr: number | null;
  status: string;
  updated_at: string;
}

export interface AssetRow {
  id: string;
  project_id: string | null;
  villa_type_id: string | null;
  kind: string;
  title: string;
  description: string | null;
  url: string;
  mime_type: string | null;
  is_ai_generated: boolean;
  shareable_by_ai: boolean;
  version: number;
  created_at: string;
}

/** Village → state, deduplicated. Enough to place a project without a map. */
export function projectLocation(project: {
  village: string | null;
  mandal: string | null;
  district: string | null;
  state: string | null;
}): string | null {
  const parts = [project.village, project.mandal, project.district, project.state]
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p));
  const unique = parts.filter((p, i) => parts.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i);
  return unique.length ? unique.join(", ") : null;
}

/**
 * Escapes a URL for interpolation into a CSS `url("...")` token.
 *
 * Only the characters that could terminate the token are encoded — running the
 * whole string through encodeURI would double-encode the `%20` already present
 * in the seeded asset paths.
 */
export function cssUrl(url: string): string {
  return `url("${url.replace(/["'\\\s<>]/g, encodeURIComponent)}")`;
}

// -----------------------------------------------------------------------------
// jsonb → renderable tree
//
// amenities / specifications / sustainability / connectivity are free-form jsonb
// transcribed from the developer's collateral. Their shape varies per project
// and nests arbitrarily (a list of strings, a map of lists, a list of objects
// each with its own list). Normalising once here keeps every page's renderer to
// three cases instead of a pile of shape guesses.
// -----------------------------------------------------------------------------

export type JsonNode =
  | { kind: "text"; value: string }
  | { kind: "list"; items: string[] }
  | { kind: "group"; entries: JsonEntry[] };

export interface JsonEntry {
  key: string;
  label: string;
  /** Null when the entry is a bare name with no detail hanging off it. */
  node: JsonNode | null;
}

const ACRONYMS: Record<string, string> = {
  sft: "SFT",
  sqft: "sq ft",
  sqyd: "sq yd",
  km: "km",
  hmda: "HMDA",
  rera: "RERA",
  igbc: "IGBC",
  stp: "STP",
  wtp: "WTP",
  ev: "EV",
  iot: "IoT",
  dg: "DG",
  orr: "ORR",
  bhk: "BHK",
  ac: "AC",
  vrv: "VRV",
  cctv: "CCTV",
  dth: "DTH",
  rcc: "RCC",
  upvc: "UPVC",
  uvpc: "UPVC",
  url: "URL",
  no: "No.",
};

export function humanizeKey(key: string): string {
  const words = key.split(/[_\-\s]+/).filter(Boolean);
  return words
    .map((word, i) => {
      const acronym = ACRONYMS[word.toLowerCase()];
      if (acronym) return acronym;
      if (i === 0) return word.charAt(0).toUpperCase() + word.slice(1);
      return word;
    })
    .join(" ");
}

/** Keys an array element uses to name itself, in preference order. */
const NAME_KEYS = ["name", "title", "place", "label", "category", "stage"];

function scalarText(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString("en-IN") : null;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return null;
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

export function toJsonNode(value: unknown): JsonNode | null {
  const scalar = scalarText(value);
  if (scalar !== null) return { kind: "text", value: scalar };
  if (value === null || value === undefined || typeof value !== "object") return null;

  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      const items = value.map(scalarText).filter((v): v is string => v !== null);
      return items.length ? { kind: "list", items } : null;
    }

    const entries: JsonEntry[] = [];
    value.forEach((item, index) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = { ...(item as Record<string, unknown>) };
        const nameKey = NAME_KEYS.find((k) => typeof record[k] === "string" && record[k]);
        const label = nameKey ? String(record[nameKey]) : `Item ${index + 1}`;
        if (nameKey) delete record[nameKey];
        // Unlike the object branch below, a null node is kept: "Sahavas" with no
        // further detail is still worth listing.
        entries.push({ key: String(index), label, node: toJsonNode(record) });
        return;
      }
      const node = toJsonNode(item);
      if (node) entries.push({ key: String(index), label: `Item ${index + 1}`, node });
    });
    return entries.length ? { kind: "group", entries } : null;
  }

  const entries: JsonEntry[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const node = toJsonNode(child);
    // An empty array or blank string under a key is absence, not content —
    // rendering the heading alone would imply data that isn't there.
    if (node) entries.push({ key, label: humanizeKey(key), node });
  }
  return entries.length ? { kind: "group", entries } : null;
}

/** How many individual facts a node renders. Used for "N listed" counts. */
export function countJsonLeaves(node: JsonNode | null): number {
  if (!node) return 0;
  if (node.kind === "text") return 1;
  if (node.kind === "list") return node.items.length;
  return node.entries.reduce((total, entry) => total + Math.max(1, countJsonLeaves(entry.node)), 0);
}

// -----------------------------------------------------------------------------
// Schema drift
//
// `requireTable` answers "does this table exist". It cannot answer "does it
// have the columns this page selects", and that is the failure mode a partially
// applied migration actually produces: PostgREST refuses a select naming an
// unknown column with an error and a NULL body, which supabase-js hands back as
// `data: null`. Coerced to `[]` — as every read below does — a stale schema is
// indistinguishable from an empty table, so the page renders "no projects yet"
// about a database holding three. That is a fabricated fact, which this product
// does not get to state. Every read therefore carries the gap it hit, and every
// page shows it as a setup problem instead of as emptiness.
// -----------------------------------------------------------------------------

interface QueryError {
  code?: string;
  message: string;
}

/** PostgREST/Postgres codes for "that column / relation isn't there". */
function isMissingSchema(error: QueryError): boolean {
  const code = error.code;
  return (
    code === "42703" || // undefined_column
    code === "42P01" || // undefined_table
    code === "PGRST205" || // unknown relation, PostgREST schema cache
    /does not exist|schema cache/i.test(error.message)
  );
}

/**
 * The first read that failed, phrased for the person who has to fix it.
 *
 * Anything that isn't schema drift is passed through verbatim rather than
 * dressed up as a migration problem — a timeout is not a missing column.
 */
function firstGap(...errors: Array<QueryError | null>): string | null {
  for (const error of errors) {
    if (!error) continue;
    if (isMissingSchema(error)) {
      return `${error.message}. This database is behind supabase/migrations/001_schema.sql — run it in the Supabase SQL editor, then reload.`;
    }
    return error.message;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Reads
// -----------------------------------------------------------------------------

export interface ProjectStats {
  villaTypes: number;
  counts: StatusCounts;
  total: number;
}

export interface Portfolio {
  projects: ProjectCardRow[];
  stats: Record<string, ProjectStats>;
  /** Non-null when a read was refused because the schema is out of date. */
  schemaError: string | null;
}

export async function projectPortfolio(): Promise<Portfolio> {
  const [projectsResult, typesResult, unitsResult] = await Promise.all([
    db().from("villa_projects").select(PROJECT_CARD_COLUMNS).eq("is_active", true).order("name"),
    db().from("villa_types").select("id, project_id").eq("is_active", true),
    db().from("villa_units").select("project_id, status"),
  ]);

  const projects = (projectsResult.data ?? []) as unknown as ProjectCardRow[];
  const stats: Record<string, ProjectStats> = {};
  for (const project of projects) {
    stats[project.id] = { villaTypes: 0, counts: emptyCounts(), total: 0 };
  }

  for (const type of (typesResult.data ?? []) as Array<{ project_id: string }>) {
    const stat = stats[type.project_id];
    if (stat) stat.villaTypes += 1;
  }

  for (const unit of (unitsResult.data ?? []) as Array<{ project_id: string; status: string }>) {
    const stat = stats[unit.project_id];
    if (!stat) continue;
    stat.total += 1;
    if (isUnitStatus(unit.status)) stat.counts[unit.status] += 1;
  }

  return {
    projects,
    stats,
    schemaError: firstGap(projectsResult.error, typesResult.error, unitsResult.error),
  };
}

export interface TypeInventory {
  villaTypeId: string | null;
  name: string;
  priceInr: number | null;
  counts: StatusCounts;
  total: number;
}

export interface Dossier {
  project: ProjectRow;
  villaTypes: VillaTypeRow[];
  inventory: TypeInventory[];
  counts: StatusCounts;
  total: number;
  assets: AssetRow[];
  schemaError: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A project by id or slug.
 *
 * Both are accepted because `id` is what the portfolio links with while the
 * slug is what a human would type. Querying `id` with a non-UUID makes Postgres
 * raise 22P02 rather than return nothing, so the column is chosen by shape.
 */
export async function projectDossier(idOrSlug: string): Promise<Dossier | null> {
  const column = UUID.test(idOrSlug) ? "id" : "slug";
  const { data } = await db()
    .from("villa_projects")
    .select("*")
    .eq(column, idOrSlug)
    .maybeSingle();

  const project = data as ProjectRow | null;
  if (!project) return null;

  const [typesResult, unitsResult, assetsResult] = await Promise.all([
    db()
      .from("villa_types")
      .select(VILLA_TYPE_COLUMNS)
      .eq("project_id", project.id)
      .eq("is_active", true)
      .order("plot_area_sqyd", { ascending: true, nullsFirst: false })
      .order("name"),
    db().from("villa_units").select("villa_type_id, status").eq("project_id", project.id),
    db()
      .from("villa_assets")
      .select("id, project_id, villa_type_id, kind, title, description, url, mime_type, is_ai_generated, shareable_by_ai, version, created_at")
      .eq("project_id", project.id)
      .eq("is_current", true)
      .order("kind"),
  ]);

  const villaTypes = (typesResult.data ?? []) as unknown as VillaTypeRow[];
  const inventory: TypeInventory[] = villaTypes.map((type) => ({
    villaTypeId: type.id,
    name: type.name,
    priceInr: type.price_inr,
    counts: emptyCounts(),
    total: 0,
  }));
  const byTypeId = new Map(inventory.map((row) => [row.villaTypeId, row]));
  const counts = emptyCounts();
  let total = 0;

  for (const unit of (unitsResult.data ?? []) as Array<{ villa_type_id: string | null; status: string }>) {
    total += 1;
    if (isUnitStatus(unit.status)) counts[unit.status] += 1;

    let row = unit.villa_type_id ? byTypeId.get(unit.villa_type_id) : undefined;
    if (!row) {
      row = byTypeId.get(null);
      if (!row) {
        row = { villaTypeId: null, name: "Unassigned", priceInr: null, counts: emptyCounts(), total: 0 };
        inventory.push(row);
        byTypeId.set(null, row);
      }
    }
    row.total += 1;
    if (isUnitStatus(unit.status)) row.counts[unit.status] += 1;
  }

  return {
    project,
    villaTypes,
    inventory,
    counts,
    total,
    assets: (assetsResult.data ?? []) as unknown as AssetRow[],
    schemaError: firstGap(typesResult.error, unitsResult.error, assetsResult.error),
  };
}

export interface CatalogEntry {
  type: VillaTypeRow;
  projectName: string;
  projectSlug: string;
  projectStatus: string | null;
  units: StatusCounts;
  unitTotal: number;
}

export interface Catalog {
  entries: CatalogEntry[];
  schemaError: string | null;
}

/** Every villa type across every project, with its live stock attached. */
export async function villaCatalog(): Promise<Catalog> {
  const [projectsResult, typesResult, unitsResult] = await Promise.all([
    db().from("villa_projects").select("id, name, slug, status").eq("is_active", true),
    db().from("villa_types").select(VILLA_TYPE_COLUMNS).eq("is_active", true).order("name"),
    db().from("villa_units").select("villa_type_id, status"),
  ]);

  const projects = new Map(
    ((projectsResult.data ?? []) as Array<{ id: string; name: string; slug: string; status: string | null }>).map(
      (p) => [p.id, p],
    ),
  );

  const entries: CatalogEntry[] = ((typesResult.data ?? []) as unknown as VillaTypeRow[]).map((type) => {
    const project = projects.get(type.project_id);
    return {
      type,
      projectName: project?.name ?? "Unknown project",
      projectSlug: project?.slug ?? type.project_id,
      projectStatus: project?.status ?? null,
      units: emptyCounts(),
      unitTotal: 0,
    };
  });

  const byTypeId = new Map(entries.map((entry) => [entry.type.id, entry]));
  for (const unit of (unitsResult.data ?? []) as Array<{ villa_type_id: string | null; status: string }>) {
    if (!unit.villa_type_id) continue;
    const entry = byTypeId.get(unit.villa_type_id);
    if (!entry) continue;
    entry.unitTotal += 1;
    if (isUnitStatus(unit.status)) entry.units[unit.status] += 1;
  }

  entries.sort(
    (a, b) =>
      a.projectName.localeCompare(b.projectName) ||
      (a.type.plot_area_sqyd ?? Infinity) - (b.type.plot_area_sqyd ?? Infinity) ||
      naturally.compare(a.type.name, b.type.name),
  );
  return {
    entries,
    schemaError: firstGap(projectsResult.error, typesResult.error, unitsResult.error),
  };
}

// -----------------------------------------------------------------------------
// Availability board
// -----------------------------------------------------------------------------

export interface TypeBoard {
  villaTypeId: string | null;
  name: string;
  priceInr: number | null;
  plotAreaSqyd: number | null;
  builtUpSft: number | null;
  verificationNote: string | null;
  units: UnitRow[];
  counts: StatusCounts;
  total: number;
}

export interface ProjectBoard {
  projectId: string;
  projectName: string;
  slug: string;
  types: TypeBoard[];
  counts: StatusCounts;
  total: number;
}

export interface AvailabilityBoard {
  projects: ProjectBoard[];
  counts: StatusCounts;
  total: number;
  /** Flat lists for the forms, so a page renders selects without re-querying. */
  projectOptions: Array<{ id: string; name: string }>;
  typeOptions: Array<{ id: string; name: string; projectId: string; projectName: string }>;
  schemaError: string | null;
}

interface SummaryRow {
  villa_type_id: string;
  total_units: number;
  available: number;
  under_booking: number;
  reserved: number;
  sold: number;
}

/**
 * The visual availability board: project → villa type → units.
 *
 * Per-type counts come from `villa_inventory_summary` where the view has a row,
 * because that view is what the rest of the product (and the agent) reads. The
 * view predates the `blocked` status and has no column for it, so blocked is
 * recovered as the residual — the enum has exactly five values, so a unit the
 * view counted in none of its four buckets is blocked by elimination.
 */
export async function availabilityBoard(): Promise<AvailabilityBoard> {
  const [projectsResult, typesResult, unitsResult, summaryResult] = await Promise.all([
    db().from("villa_projects").select("id, name, slug").eq("is_active", true).order("name"),
    db().from("villa_types").select(VILLA_TYPE_COLUMNS).eq("is_active", true),
    db().from("villa_units").select("*"),
    db().from("villa_inventory_summary").select("villa_type_id, total_units, available, under_booking, reserved, sold"),
  ]);

  const projectRows = (projectsResult.data ?? []) as Array<{ id: string; name: string; slug: string }>;
  const typeRows = (typesResult.data ?? []) as unknown as VillaTypeRow[];
  const unitRows = (unitsResult.data ?? []) as unknown as UnitRow[];
  const summaries = new Map(
    ((summaryResult.data ?? []) as SummaryRow[]).map((row) => [row.villa_type_id, row]),
  );

  const boards: ProjectBoard[] = projectRows.map((project) => ({
    projectId: project.id,
    projectName: project.name,
    slug: project.slug,
    types: [],
    counts: emptyCounts(),
    total: 0,
  }));
  const byProjectId = new Map(boards.map((board) => [board.projectId, board]));

  const typeBoards = new Map<string, TypeBoard>();
  for (const type of typeRows) {
    const board = byProjectId.get(type.project_id);
    if (!board) continue;
    const typeBoard: TypeBoard = {
      villaTypeId: type.id,
      name: type.name,
      priceInr: type.price_inr,
      plotAreaSqyd: type.plot_area_sqyd,
      builtUpSft: type.built_up_sft,
      verificationNote: type.verification_note,
      units: [],
      counts: emptyCounts(),
      total: 0,
    };
    board.types.push(typeBoard);
    typeBoards.set(type.id, typeBoard);
  }

  // Units whose villa type was cleared still exist and are still sellable, so
  // they get a bucket rather than vanishing from the board.
  const unassigned = new Map<string, TypeBoard>();
  for (const unit of unitRows) {
    const board = byProjectId.get(unit.project_id);
    if (!board) continue;

    let typeBoard = unit.villa_type_id ? typeBoards.get(unit.villa_type_id) : undefined;
    if (!typeBoard || !board.types.includes(typeBoard)) {
      typeBoard = unassigned.get(unit.project_id);
      if (!typeBoard) {
        typeBoard = {
          villaTypeId: null,
          name: "Unassigned",
          priceInr: null,
          plotAreaSqyd: null,
          builtUpSft: null,
          verificationNote: null,
          units: [],
          counts: emptyCounts(),
          total: 0,
        };
        board.types.push(typeBoard);
        unassigned.set(unit.project_id, typeBoard);
      }
    }
    typeBoard.units.push(unit);
  }

  const counts = emptyCounts();
  let total = 0;

  for (const board of boards) {
    for (const typeBoard of board.types) {
      typeBoard.units.sort((a, b) => naturally.compare(a.unit_number, b.unit_number));

      const summary = typeBoard.villaTypeId ? summaries.get(typeBoard.villaTypeId) : undefined;
      if (summary) {
        typeBoard.counts = {
          available: summary.available,
          under_booking: summary.under_booking,
          reserved: summary.reserved,
          sold: summary.sold,
          blocked: Math.max(
            0,
            summary.total_units - summary.available - summary.under_booking - summary.reserved - summary.sold,
          ),
        };
        typeBoard.total = summary.total_units;
      } else {
        for (const unit of typeBoard.units) {
          if (isUnitStatus(unit.status)) typeBoard.counts[unit.status] += 1;
        }
        typeBoard.total = typeBoard.units.length;
      }

      addCounts(board.counts, typeBoard.counts);
      board.total += typeBoard.total;
    }
    board.types.sort(
      (a, b) => (a.plotAreaSqyd ?? Infinity) - (b.plotAreaSqyd ?? Infinity) || naturally.compare(a.name, b.name),
    );
    addCounts(counts, board.counts);
    total += board.total;
  }

  return {
    projects: boards,
    counts,
    total,
    projectOptions: projectRows.map((p) => ({ id: p.id, name: p.name })),
    typeOptions: typeRows
      .map((type) => ({
        id: type.id,
        name: type.name,
        projectId: type.project_id,
        projectName: byProjectId.get(type.project_id)?.projectName ?? "",
      }))
      .sort((a, b) => a.projectName.localeCompare(b.projectName) || naturally.compare(a.name, b.name)),
    // The summary view is included: when it is absent the counts above are
    // recomputed from the unit rows and stay correct, but the board would
    // otherwise claim to be reading a view that isn't there.
    schemaError: firstGap(
      projectsResult.error,
      typesResult.error,
      unitsResult.error,
      summaryResult.error,
    ),
  };
}

// -----------------------------------------------------------------------------
// Plan assets
// -----------------------------------------------------------------------------

export const PLAN_KINDS = ["floor_plan", "site_plan", "master_plan"] as const;

export const PLAN_KIND_LABELS: Record<string, string> = {
  floor_plan: "Floor plan",
  site_plan: "Site plan",
  master_plan: "Master plan",
};

export interface PlanGroup {
  projectId: string;
  projectName: string;
  slug: string;
  /** Plans scoped to one villa type, then the project-wide ones. */
  sections: Array<{ key: string; label: string; assets: AssetRow[] }>;
  total: number;
}

export async function planAssets(): Promise<{
  groups: PlanGroup[];
  total: number;
  schemaError: string | null;
}> {
  const [projectsResult, typesResult, assetsResult] = await Promise.all([
    db().from("villa_projects").select("id, name, slug").eq("is_active", true).order("name"),
    db().from("villa_types").select("id, name"),
    db()
      .from("villa_assets")
      .select("id, project_id, villa_type_id, kind, title, description, url, mime_type, is_ai_generated, shareable_by_ai, version, created_at")
      .in("kind", PLAN_KINDS as unknown as string[])
      .eq("is_current", true)
      .order("kind")
      .order("title"),
  ]);

  const projectRows = (projectsResult.data ?? []) as Array<{ id: string; name: string; slug: string }>;
  const typeNames = new Map(
    ((typesResult.data ?? []) as Array<{ id: string; name: string }>).map((t) => [t.id, t.name]),
  );
  const assets = (assetsResult.data ?? []) as unknown as AssetRow[];

  const groups: PlanGroup[] = projectRows.map((project) => ({
    projectId: project.id,
    projectName: project.name,
    slug: project.slug,
    sections: [],
    total: 0,
  }));
  const byProjectId = new Map(groups.map((group) => [group.projectId, group]));

  for (const asset of assets) {
    const group = asset.project_id ? byProjectId.get(asset.project_id) : undefined;
    if (!group) continue;

    const key = asset.villa_type_id ?? "__project";
    const label = asset.villa_type_id
      ? (typeNames.get(asset.villa_type_id) ?? "Villa type")
      : "Community-wide";

    let section = group.sections.find((s) => s.key === key);
    if (!section) {
      section = { key, label, assets: [] };
      group.sections.push(section);
    }
    section.assets.push(asset);
    group.total += 1;
  }

  // Community-wide drawings last: a buyer looks for their own villa first.
  for (const group of groups) {
    group.sections.sort((a, b) => {
      if (a.key === "__project") return 1;
      if (b.key === "__project") return -1;
      return naturally.compare(a.label, b.label);
    });
  }

  return {
    groups: groups.filter((g) => g.total > 0),
    total: assets.length,
    schemaError: firstGap(projectsResult.error, typesResult.error, assetsResult.error),
  };
}

export function isImageAsset(asset: { mime_type: string | null; url: string }): boolean {
  if (asset.mime_type) return asset.mime_type.startsWith("image/");
  return /\.(png|jpe?g|webp|gif|avif|svg)(\?|$)/i.test(asset.url);
}

/** "PDF", "JPG" — the badge on a document card. */
export function assetExtension(asset: { mime_type: string | null; url: string }): string {
  const fromUrl = /\.([a-z0-9]{2,5})(?:\?|$)/i.exec(asset.url)?.[1];
  if (fromUrl) return fromUrl.toUpperCase();
  const subtype = asset.mime_type?.split("/")[1];
  return subtype ? subtype.toUpperCase() : "FILE";
}

// -----------------------------------------------------------------------------
// Amenities
// -----------------------------------------------------------------------------

export interface AmenityShowcase {
  projectId: string;
  projectName: string;
  slug: string;
  location: string | null;
  categories: JsonEntry[];
  total: number;
}

export async function amenityShowcase(): Promise<{
  projects: AmenityShowcase[];
  schemaError: string | null;
}> {
  const { data, error } = await db()
    .from("villa_projects")
    .select("id, name, slug, village, mandal, district, state, amenities")
    .eq("is_active", true)
    .order("name");

  const rows = (data ?? []) as Array<
    Pick<ProjectRow, "id" | "name" | "slug" | "village" | "mandal" | "district" | "state" | "amenities">
  >;

  const projects = rows.map((row) => {
    const node = toJsonNode(row.amenities);
    // A top-level list ("pool, gym, park") is as valid as a categorised map, so
    // it gets wrapped into a single unnamed category rather than dropped.
    const categories: JsonEntry[] =
      node?.kind === "group"
        ? node.entries
        : node
          ? [{ key: "amenities", label: "Amenities", node }]
          : [];

    return {
      projectId: row.id,
      projectName: row.name,
      slug: row.slug,
      location: projectLocation(row),
      categories,
      total: countJsonLeaves(node),
    };
  });

  return { projects, schemaError: firstGap(error) };
}

// -----------------------------------------------------------------------------
// Writes
// -----------------------------------------------------------------------------

export interface NewUnit {
  projectId: string;
  unitNumber: string;
  villaTypeId?: string | null;
  facing?: string | null;
  isCorner?: boolean;
  plotAreaSqyd?: number | null;
  priceInr?: number | null;
  status?: string;
}

export async function createUnit(
  input: NewUnit,
): Promise<{ ok: true; unit: UnitRow } | { ok: false; error: string }> {
  const unitNumber = input.unitNumber.trim();
  if (!input.projectId) return { ok: false, error: "a project is required" };
  if (!unitNumber) return { ok: false, error: "a unit number is required" };

  const status = input.status ?? "available";
  if (!isUnitStatus(status)) return { ok: false, error: `invalid status: ${status}` };

  if (input.villaTypeId) {
    const { data: type } = await db()
      .from("villa_types")
      .select("id, project_id")
      .eq("id", input.villaTypeId)
      .maybeSingle();
    if (!type) return { ok: false, error: "villa type not found" };
    if (type.project_id !== input.projectId) {
      return { ok: false, error: "that villa type belongs to a different project" };
    }
  }

  const { data, error } = await db()
    .from("villa_units")
    .insert({
      project_id: input.projectId,
      villa_type_id: input.villaTypeId || null,
      unit_number: unitNumber,
      facing: input.facing?.trim() || null,
      is_corner: input.isCorner ?? false,
      plot_area_sqyd: input.plotAreaSqyd ?? null,
      price_inr: input.priceInr ?? null,
      status,
    })
    .select("*")
    .single();

  if (error) return { ok: false, error: error.message };
  return { ok: true, unit: data as UnitRow };
}

export async function updateUnitStatus(
  unitId: string,
  status: string,
): Promise<{ ok: true; unit: UnitRow } | { ok: false; error: string }> {
  if (!unitId) return { ok: false, error: "a unit is required" };
  if (!isUnitStatus(status)) return { ok: false, error: `invalid status: ${status}` };

  // villa_units carries no updated_at trigger, so the timestamp is set here or
  // the board's "changed 3m ago" would never move.
  const { data, error } = await db()
    .from("villa_units")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", unitId)
    .select("*")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "unit not found" };
  return { ok: true, unit: data as UnitRow };
}

// -----------------------------------------------------------------------------
// Editing the records the agents quote from
// -----------------------------------------------------------------------------

/**
 * These three writes exist because the Properties screens were read-only: the
 * records could be looked at but not changed, so "put the new phase in" and
 * "the 4BHK went up by two lakh" both meant a developer running SQL.
 *
 * The NULL rule from the top of this file still holds. A price is not cleared
 * by submitting an empty box — that would silently revoke the agent's
 * permission to quote it, which is a different decision from correcting it, and
 * one nobody makes by tabbing past a field. Clearing is explicit.
 */

/** Slug for a new project: stable, readable, and unique within the table. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export interface NewProject {
  name: string;
  developer?: string | null;
  phase?: string | null;
  status?: string | null;
  expectedDelivery?: string | null;
  village?: string | null;
  district?: string | null;
  startingPriceInr?: number | null;
  pricePerSftInr?: number | null;
}

export async function createProject(
  input: NewProject,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const name = input.name.trim();
  if (!name) return { ok: false, error: "a project name is required" };

  const base = slugify(name);
  if (!base) return { ok: false, error: "that name cannot be turned into a web address" };

  // `slug` is unique. Rather than let the insert fail on a second "Phase II",
  // find the first free suffix — the person naming a project should not have to
  // know that a column needs to be unique.
  const { data: taken } = await db().from("villa_projects").select("slug").like("slug", `${base}%`);
  const used = new Set((taken ?? []).map((r: { slug: string }) => r.slug));
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;

  const { data, error } = await db()
    .from("villa_projects")
    .insert({
      slug,
      name,
      developer: input.developer?.trim() || null,
      phase: input.phase?.trim() || null,
      status: input.status?.trim() || "upcoming",
      expected_delivery: input.expectedDelivery?.trim() || null,
      village: input.village?.trim() || null,
      district: input.district?.trim() || null,
      starting_price_inr: input.startingPriceInr ?? null,
      price_per_sft_inr: input.pricePerSftInr ?? null,
      is_active: true,
    })
    .select("id, name")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "the project could not be created" };
  return { ok: true, id: data.id, name: data.name };
}

/**
 * The headline numbers on a project.
 *
 * `clear: true` is how a price is removed, and it is a separate decision from
 * changing one: an empty field means "not submitted", not "the agent may stop
 * quoting this".
 */
export async function updateProjectPricing(
  projectId: string,
  input: { startingPriceInr?: number | null; pricePerSftInr?: number | null; clear?: boolean },
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (!projectId) return { ok: false, error: "a project is required" };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (input.clear) {
    patch.starting_price_inr = null;
    patch.price_per_sft_inr = null;
  } else {
    if (input.startingPriceInr !== undefined && input.startingPriceInr !== null) {
      patch.starting_price_inr = input.startingPriceInr;
    }
    if (input.pricePerSftInr !== undefined && input.pricePerSftInr !== null) {
      patch.price_per_sft_inr = input.pricePerSftInr;
    }
    if (Object.keys(patch).length === 1) return { ok: false, error: "nothing to change" };
  }

  const { data, error } = await db()
    .from("villa_projects")
    .update(patch)
    .eq("id", projectId)
    .select("name")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  // PostgREST reports no error for an UPDATE that matched zero rows, so the
  // absent row is the only signal that the id was wrong.
  if (!data) return { ok: false, error: "that project no longer exists" };
  return { ok: true, name: data.name };
}

/** The price of one villa type — the number the agent quotes for that plot. */
export async function updateVillaTypePrice(
  villaTypeId: string,
  priceInr: number | null,
  options: { clear?: boolean } = {},
): Promise<{ ok: true; name: string; price: number | null } | { ok: false; error: string }> {
  if (!villaTypeId) return { ok: false, error: "a villa type is required" };
  if (!options.clear && (priceInr === null || !Number.isFinite(priceInr))) {
    return { ok: false, error: "a price is required" };
  }
  if (!options.clear && priceInr !== null && priceInr <= 0) {
    return { ok: false, error: "a price must be more than zero" };
  }

  const { data, error } = await db()
    .from("villa_types")
    .update({ price_inr: options.clear ? null : priceInr })
    .eq("id", villaTypeId)
    .select("name, price_inr")
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!data) return { ok: false, error: "that villa type no longer exists" };
  return { ok: true, name: data.name, price: data.price_inr };
}
