import type { Board, BoardColumn, BoardFieldKey } from "../types";
import { uid } from "../ids";

/**
 * Board templates.
 *
 * Applying a template rewrites the column set but never deletes cards: cards
 * whose column disappears become "orphans" and are surfaced in a banner so a
 * person decides where they go. Silently deleting someone's work to apply a
 * layout is the fastest way to lose their trust in the tool.
 */

/** Clicking a column's colour dot cycles through this ramp. */
export const COLUMN_COLORS = [
  "#f59e0b", // amber
  "#8b8b95", // graphite
  "#22c55e", // green
  "#f43f5e", // rose
  "#22d3ee", // cyan
  "#a78bfa", // violet
  "#f472b6", // pink
  "#a8a29e", // stone
];

export function nextColor(current: string): string {
  const i = COLUMN_COLORS.indexOf(current);
  return COLUMN_COLORS[(i + 1) % COLUMN_COLORS.length];
}

export const ALL_FIELDS: Array<{ key: BoardFieldKey; label: string; icon: string }> = [
  { key: "description", label: "Description", icon: "text" },
  { key: "priority", label: "Priority", icon: "chevron" },
  { key: "dueDate", label: "Due Date", icon: "calendar" },
  { key: "tags", label: "Tags", icon: "tag" },
  { key: "assignee", label: "Assignee", icon: "user" },
  { key: "automationLabel", label: "Automation Label", icon: "zap" },
  { key: "linkedPost", label: "Linked Post", icon: "link" },
];

export const DEFAULT_FIELDS: Record<BoardFieldKey, boolean> = {
  description: true,
  priority: true,
  dueDate: true,
  tags: true,
  assignee: true,
  automationLabel: false,
  linkedPost: false,
};

export interface BoardTemplate {
  id: string;
  name: string;
  columns: Array<Omit<BoardColumn, "id">>;
  fields?: Partial<Record<BoardFieldKey, boolean>>;
}

export const TEMPLATES: BoardTemplate[] = [
  {
    id: "default",
    name: "Default",
    columns: [
      { name: "Pending Approval", color: COLUMN_COLORS[0], hitl: true },
      { name: "To Do", color: COLUMN_COLORS[1], hitl: false },
      { name: "Done", color: COLUMN_COLORS[2], hitl: false },
    ],
  },
  {
    id: "content",
    name: "Content Calendar",
    columns: [
      { name: "Ideas", color: COLUMN_COLORS[7], hitl: false },
      { name: "Drafting", color: COLUMN_COLORS[4], hitl: false },
      { name: "Needs Approval", color: COLUMN_COLORS[0], hitl: true },
      { name: "Scheduled", color: COLUMN_COLORS[1], hitl: false },
      { name: "Published", color: COLUMN_COLORS[2], hitl: false },
    ],
    fields: { automationLabel: true, linkedPost: true },
  },
  {
    id: "software",
    name: "Software Dev",
    columns: [
      { name: "Backlog", color: COLUMN_COLORS[7], hitl: false },
      { name: "To Do", color: COLUMN_COLORS[1], hitl: false },
      { name: "In Progress", color: COLUMN_COLORS[4], hitl: false, wipLimit: 3 },
      { name: "In Review", color: COLUMN_COLORS[0], hitl: true },
      { name: "Done", color: COLUMN_COLORS[2], hitl: false },
    ],
  },
  {
    id: "sales",
    name: "Sales Pipeline",
    columns: [
      { name: "Lead In", color: COLUMN_COLORS[7], hitl: false },
      { name: "Qualified", color: COLUMN_COLORS[4], hitl: false },
      { name: "Proposal Sent", color: COLUMN_COLORS[1], hitl: false },
      { name: "Negotiation", color: COLUMN_COLORS[0], hitl: true },
      { name: "Won", color: COLUMN_COLORS[2], hitl: false },
    ],
  },
  {
    id: "agency",
    name: "Agency",
    columns: [
      { name: "Client Request", color: COLUMN_COLORS[7], hitl: false },
      { name: "In Production", color: COLUMN_COLORS[4], hitl: false },
      { name: "Internal Review", color: COLUMN_COLORS[5], hitl: true },
      { name: "Client Approval", color: COLUMN_COLORS[0], hitl: true },
      { name: "Delivered", color: COLUMN_COLORS[2], hitl: false },
    ],
  },
  {
    id: "support",
    name: "Support",
    columns: [
      { name: "New", color: COLUMN_COLORS[3], hitl: false },
      { name: "Triaged", color: COLUMN_COLORS[0], hitl: false },
      { name: "Waiting on Customer", color: COLUMN_COLORS[7], hitl: false },
      { name: "Escalated", color: COLUMN_COLORS[5], hitl: true },
      { name: "Resolved", color: COLUMN_COLORS[2], hitl: false },
    ],
  },
];

export function templateColumns(templateId: string): BoardColumn[] {
  const t = TEMPLATES.find((x) => x.id === templateId) ?? TEMPLATES[0];
  return t.columns.map((c) => ({ ...c, id: uid("col") }));
}

export function makeBoard(brandId: string, name: string, templateId = "default"): Board {
  const t = TEMPLATES.find((x) => x.id === templateId) ?? TEMPLATES[0];
  const now = new Date().toISOString();
  return {
    id: uid("board"),
    brandId,
    name,
    columns: templateColumns(templateId),
    fields: { ...DEFAULT_FIELDS, ...(t.fields ?? {}) },
    templateId,
    createdAt: now,
    updatedAt: now,
  };
}

/** Cards pointing at a column that no longer exists. */
export function orphanCards<T extends { columnId: string }>(cards: T[], columns: BoardColumn[]): T[] {
  const live = new Set(columns.map((c) => c.id));
  return cards.filter((c) => !live.has(c.columnId));
}
