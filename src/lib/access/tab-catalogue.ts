import { requiredPermissionFor } from "@/lib/auth/page-access";
import type { Permission } from "@/lib/auth/session";

/**
 * THE SIDEBAR, AS DATA.
 *
 * One list, used twice: the sidebar renders it with icons, and the control
 * centre renders it as the thing an administrator switches on and off. They
 * cannot drift, because there is nothing to drift from — adding a screen here
 * adds it to both.
 *
 * Each tab's permission is not stored here. It is asked of
 * `requiredPermissionFor`, the same function the layout gate calls before it
 * serves the page and the same permission the API routes behind that page
 * demand. That is what makes a switch on the control centre real rather than
 * cosmetic: turning a tab off does not hide a link, it removes the permission,
 * and the permission is what the page gate and the endpoints both consult.
 */

export interface TabEntry {
  href: string;
  label: string;
  badgeKey?: "suggestions" | "inbox" | "reviews";
}

export interface TabGroup {
  group: string;
  items: TabEntry[];
}

export const TAB_CATALOGUE: TabGroup[] = [
  {
    group: "Overview",
    items: [
      { href: "/dashboard", label: "Dashboard" },
      { href: "/insights", label: "AI Insights", badgeKey: "suggestions" },
      { href: "/analytics", label: "Analytics" },
    ],
  },
  {
    group: "Channels",
    items: [
      { href: "/channels/instagram", label: "Instagram" },
      { href: "/channels/facebook", label: "Facebook" },
      { href: "/channels/linkedin", label: "LinkedIn" },
      { href: "/channels/youtube", label: "YouTube" },
    ],
  },
  {
    group: "Create & publish",
    items: [
      { href: "/showcase", label: "Project Showcase" },
      { href: "/publish-v2", label: "Publish a video" },
      { href: "/board", label: "Board" },
      { href: "/calendar", label: "Calendar" },
      { href: "/ideas", label: "Post ideas" },
    ],
  },
  {
    group: "CRM",
    items: [
      { href: "/inbox/whatsapp/crm/leads", label: "Leads" },
      { href: "/inbox/whatsapp/crm/pipeline", label: "Pipeline" },
      { href: "/inbox/whatsapp/crm/contacts", label: "Contacts" },
      { href: "/inbox/whatsapp/crm/customers", label: "Customers" },
      { href: "/inbox/whatsapp/sales/site-visits", label: "Site visits" },
      { href: "/inbox/whatsapp/crm/follow-ups", label: "Follow-ups" },
    ],
  },
  {
    group: "Engage",
    items: [
      { href: "/voice", label: "Voice calls" },
      { href: "/inbox/whatsapp/communication/whatsapp", label: "WhatsApp" },
    ],
  },
  {
    group: "Grow",
    items: [
      { href: "/ads", label: "Ads · Meta + Google" },
      { href: "/engagement", label: "Engagement", badgeKey: "inbox" },
      { href: "/reviews", label: "Reviews", badgeKey: "reviews" },
      { href: "/local", label: "Local visibility" },
    ],
  },
  {
    group: "Operations",
    items: [
      { href: "/ops/messages", label: "Messages" },
      { href: "/ops/sales", label: "Sales queue" },
      { href: "/ops/loans", label: "Loan cases" },
      { href: "/ops/admin", label: "Control centre" },
    ],
  },
  {
    group: "System",
    items: [
      { href: "/reports", label: "Reports" },
      { href: "/settings", label: "Settings" },
      { href: "/settings/villa", label: "Villa profile" },
    ],
  },
];

/** The permission a tab needs, or null for one nobody can be given. */
export function permissionForTab(href: string): Permission | null {
  const required = requiredPermissionFor(href);
  return required === "allow" || required === null ? null : required;
}

export interface TabRow {
  /** The permission every tab in `tabs` shares. */
  permission: Permission;
  group: string;
  tabs: TabEntry[];
}

/**
 * The catalogue folded into one row per (group, permission).
 *
 * Twenty-eight tabs are gated by seven permissions, so several tabs genuinely
 * move together — Instagram, Facebook, LinkedIn and YouTube are one decision,
 * not four. Pretending otherwise would mean drawing four switches that always
 * flip at once, and an administrator would reasonably read the first one that
 * "didn't work" as a bug. Grouping them says what is true: this is one choice,
 * and here is everything it opens.
 */
export function tabRows(): TabRow[] {
  const rows: TabRow[] = [];
  for (const group of TAB_CATALOGUE) {
    const byPermission = new Map<Permission, TabEntry[]>();
    for (const item of group.items) {
      const permission = permissionForTab(item.href);
      if (!permission) continue;
      const list = byPermission.get(permission);
      if (list) list.push(item);
      else byPermission.set(permission, [item]);
    }
    for (const [permission, tabs] of byPermission) {
      rows.push({ permission, group: group.group, tabs });
    }
  }
  return rows;
}

/**
 * Capabilities that are not a tab: the right to change something once you are
 * already on the screen, plus the two that gate figures rather than pages.
 *
 * These have to stay visible here. They are the difference between a role that
 * can read the pipeline and one that can move a deal through it, and if the
 * control centre only listed tabs they would be invisible and unchangeable —
 * which is how a "read-only" role quietly keeps the ability to write.
 */
export const ACTION_PERMISSIONS: Array<{ key: Permission; label: string; hint: string }> = [
  { key: "customers.write", label: "Edit customers", hint: "Change contact records and reply to conversations" },
  { key: "sales.write", label: "Edit sales records", hint: "Move deals, assign leads, change stages" },
  { key: "inquiries.create", label: "Register enquiries", hint: "Log a walk-in or a new enquiry" },
  { key: "loans.write", label: "Edit loan cases", hint: "Progress a loan application" },
  { key: "documents.read", label: "See documents", hint: "Open a customer's uploaded paperwork" },
  { key: "documents.verify", label: "Verify documents", hint: "Approve or reject submitted paperwork" },
  { key: "marketing.publish", label: "Publish marketing", hint: "Post to the connected social channels" },
  { key: "construction.read", label: "See construction", hint: "Read site progress reports" },
  { key: "construction.upload", label: "Upload site updates", hint: "Add progress photos and reports" },
  { key: "pricing.read", label: "See pricing", hint: "View the price list" },
  { key: "pricing.negotiate", label: "Negotiate pricing", hint: "Offer a discount against the list price" },
  { key: "financials.view", label: "See financials", hint: "Revenue, margin and commission figures" },
  { key: "audit.view", label: "See the audit log", hint: "Who changed what, and when" },
  { key: "users.manage", label: "Manage people and access", hint: "Open this screen and change what others can do" },
];
