import type { PermissionCatalogueEntry } from "./rbac";

/**
 * TURNING A PERMISSION LIST INTO SOMETHING A PERSON CAN REASON ABOUT.
 *
 * The matrix in Postgres is 30 permissions × 15 roles — 450 switches. Nobody
 * can hold that in their head, and a screen that renders it as 450 checkboxes
 * is a screen where mistakes happen quietly.
 *
 * The keys already carry the structure: `leads:read`, `leads:write`,
 * `leads:assign` are three facts about one area. So the screen shows one card
 * per AREA, with "can see it" and "can change it" as the two answers that
 * matter, and anything else in that area as a named extra.
 *
 * This is presentation only. The database still stores individual permissions
 * and `villa_can()` still checks them one at a time — grouping here cannot
 * grant anything the catalogue does not already define.
 */

export interface AccessArea {
  /** The part before the colon: "leads", "documents", "settings". */
  key: string;
  /** What the desk calls it. */
  label: string;
  /** The category the catalogue filed it under, used to group the cards. */
  category: string;
  /** The permission that means "can open this at all", if there is one. */
  view: string | null;
  /** The permission that means "can change things here", if there is one. */
  edit: string | null;
  /** Anything else in this area — assign, download, review — named. */
  extras: Array<{ key: string; label: string }>;
}

/** Areas whose name is not obvious from the permission key. */
const AREA_LABELS: Record<string, string> = {
  walkins: "Walk-ins",
  leads: "Leads",
  contacts: "Contacts",
  conversations: "Conversations",
  tasks: "Tasks",
  pricing: "Pricing",
  loan: "Loan cases",
  documents: "Documents",
  marketing: "Marketing",
  integrations: "Integrations",
  construction: "Construction",
  analytics: "Analytics",
  audit: "Audit log",
  settings: "Settings",
  team: "Team",
};

/** The categories in the order an owner would read them. */
const CATEGORY_ORDER = ["sales", "front_desk", "general", "marketing", "loan", "construction", "admin"];

const CATEGORY_LABELS: Record<string, string> = {
  sales: "Sales",
  front_desk: "Front desk",
  general: "Everyday",
  marketing: "Marketing",
  loan: "Loans",
  construction: "Construction",
  admin: "Administration",
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category.replace(/_/g, " ");
}

/** The verbs that mean "can change something", in the order they are preferred. */
const EDIT_SUFFIXES = ["write"];

export function areaLabel(key: string): string {
  return AREA_LABELS[key] ?? key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, " ");
}

/**
 * Groups the catalogue into areas, preserving every permission.
 *
 * Nothing is dropped: a permission that is neither read nor write becomes a
 * named extra, so a capability added to the database later still appears on
 * the screen rather than silently becoming un-grantable.
 */
export function groupIntoAreas(permissions: PermissionCatalogueEntry[]): AccessArea[] {
  const byArea = new Map<string, PermissionCatalogueEntry[]>();

  for (const p of permissions) {
    const area = p.key.includes(":") ? p.key.slice(0, p.key.indexOf(":")) : p.key;
    const list = byArea.get(area);
    if (list) list.push(p);
    else byArea.set(area, [p]);
  }

  const areas: AccessArea[] = [];
  for (const [key, entries] of byArea) {
    const suffix = (p: PermissionCatalogueEntry) => p.key.slice(p.key.indexOf(":") + 1);
    const view = entries.find((p) => suffix(p) === "read")?.key ?? null;
    const edit = entries.find((p) => EDIT_SUFFIXES.includes(suffix(p)))?.key ?? null;

    areas.push({
      key,
      label: areaLabel(key),
      // Every permission in an area shares a category in practice; take the
      // first rather than assuming, so a mixed area still lands somewhere.
      category: entries[0]?.category ?? "general",
      view,
      edit,
      extras: entries
        .filter((p) => p.key !== view && p.key !== edit)
        .map((p) => ({ key: p.key, label: p.label })),
    });
  }

  // An area with no read permission at all — walk-ins is write-only — still
  // has to appear, so sort rather than filter.
  return areas.sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category);
    const cb = CATEGORY_ORDER.indexOf(b.category);
    if (ca !== cb) return (ca === -1 ? 99 : ca) - (cb === -1 ? 99 : cb);
    return a.label.localeCompare(b.label);
  });
}

/** The categories present, in reading order, for rendering section headings. */
export function orderedCategories(areas: AccessArea[]): string[] {
  const seen = new Set(areas.map((a) => a.category));
  const ordered = CATEGORY_ORDER.filter((c) => seen.has(c));
  for (const c of seen) if (!ordered.includes(c)) ordered.push(c);
  return ordered;
}

/**
 * Roles that must never lose their own access.
 *
 * Removing `team:write` from the only role that has it locks everybody out of
 * this screen permanently, with no way back except the database. The UI
 * refuses it and so does the server.
 */
export const PROTECTED_ROLES = ["super_admin", "owner"] as const;

export function isProtectedRole(role: string): boolean {
  return (PROTECTED_ROLES as readonly string[]).includes(role);
}

/** What a role is called on screen. */
export function roleDisplayName(role: string): string {
  return role
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
