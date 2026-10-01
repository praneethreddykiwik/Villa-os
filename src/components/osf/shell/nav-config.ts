import {
  Activity,
  Bell,
  Bot,
  Brain,
  Building2,
  BarChart3,
  Clock,
  Contact,
  FileSignature,
  FileText,
  Filter,
  KeyRound,
  GitBranch,
  Grid3X3,
  Home,
  Inbox,
  IndianRupee,
  LayoutDashboard,
  Mail,
  MapPin,
  Megaphone,
  MessageCircle,
  MessageSquare,
  Plug,
  Ruler,
  Settings,
  Share2,
  Shield,
  Sparkles,
  CheckSquare,
  KanbanSquare,
  Target,
  TrendingUp,
  Trophy,
  UserCheck,
  Users,
  Wand2,
  Workflow,
  type LucideIcon,
} from "lucide-react";

/**
 * The one nav definition. Sidebar, command palette and mobile drawer all read
 * from here so a route can never exist in one surface and not the others.
 *
 * lucide-react 1.x dropped the old numeric/positional icon aliases, so a few
 * names differ from the ones you'd reach for from memory:
 * KanbanSquare (KanbanSquare), CheckSquare (CheckSquare), FileSignature
 * (FileSignature), Home (Home), Wand2 (Wand2), BarChart3 (BarChart3),
 * Filter (Filter).
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Extra command-palette search terms that don't belong in the visible label. */
  keywords?: string[];
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      {
        href: "/inbox/whatsapp/overview",
        label: "Dashboard",
        icon: LayoutDashboard,
        keywords: ["home", "today", "overview"],
      },
    ],
  },
  {
    label: "CRM",
    items: [
      { href: "/inbox/whatsapp/crm/leads", label: "Leads", icon: Users, keywords: ["enquiries", "prospects"] },
      { href: "/inbox/whatsapp/crm/rankings", label: "Client Rankings", icon: Trophy, keywords: ["hot", "warm", "cold", "score", "sentiment", "leaderboard", "intent"] },
      { href: "/inbox/whatsapp/crm/pipeline", label: "Pipeline", icon: KanbanSquare, keywords: ["kanban", "stages", "deals"] },
      { href: "/inbox/whatsapp/crm/contacts", label: "Contacts", icon: Contact, keywords: ["people", "phone"] },
      { href: "/inbox/whatsapp/crm/customers", label: "Customers", icon: UserCheck, keywords: ["buyers", "owners"] },
      { href: "/inbox/whatsapp/sales/site-visits", label: "Site Visits", icon: MapPin, keywords: ["tours", "walkthrough", "bookings", "appointments", "slots"] },
      { href: "/inbox/whatsapp/crm/follow-ups", label: "Follow-ups", icon: Clock, keywords: ["reminders", "due", "overdue"] },
    ],
  },
  {
    label: "Communication",
    items: [
      { href: "/inbox/whatsapp/communication/whatsapp", label: "WhatsApp", icon: MessageSquare, keywords: ["chats", "conversations", "inbox", "messages", "threads"] },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/inbox/whatsapp/settings", label: "Settings", icon: Settings, keywords: ["preferences", "config"] },
      { href: "/inbox/whatsapp/settings/team", label: "Team & Roles", icon: Shield, keywords: ["users", "permissions", "access"] },
      { href: "/inbox/whatsapp/settings/access", label: "Access & Sign-in", icon: KeyRound, keywords: ["rbac", "login", "accounts", "permissions", "roles"] },
      { href: "/inbox/whatsapp/settings/integrations", label: "Integrations", icon: Plug, keywords: ["api keys", "webhooks", "meta"] },
      { href: "/inbox/whatsapp/whatsapp", label: "WhatsApp Setup", icon: MessageCircle, keywords: ["go live", "webhook", "meta", "voice", "readiness"] },
      { href: "/inbox/whatsapp/simulator", label: "Simulator", icon: Bot, keywords: ["test", "sandbox", "agent"] },
    ],
  },
];

export interface FlatNavItem extends NavItem {
  group: string;
}

/** Flattened once at module scope — the palette re-filters this on every keystroke. */
export const NAV_ITEMS: FlatNavItem[] = NAV_GROUPS.flatMap((group) =>
  group.items.map((item) => ({ ...item, group: group.label })),
);

/**
 * Longest-prefix match, not a per-link `startsWith`.
 *
 * `/inbox/whatsapp/settings/team` is a prefix match for both `/inbox/whatsapp/settings` and itself; picking
 * the longest href means exactly one link ever highlights.
 *
 * The workspace root has no nav entry of its own — it renders the same screen
 * as `/inbox/whatsapp/overview` — so it is mapped onto Dashboard explicitly.
 * Without this it would prefix-match nothing and no link would highlight.
 */
export function activeHref(pathname: string): string | null {
  if (pathname === "/inbox/whatsapp") return "/inbox/whatsapp/overview";
  let best: string | null = null;
  for (const item of NAV_ITEMS) {
    const matches = pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (matches && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}

// -----------------------------------------------------------------------------
// Date range
// -----------------------------------------------------------------------------

export const RANGE_KEYS = ["7d", "30d", "90d", "ytd", "all"] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

export const RANGE_PRESETS: { key: RangeKey; label: string; short: string }[] = [
  { key: "7d", label: "Last 7 days", short: "7D" },
  { key: "30d", label: "Last 30 days", short: "30D" },
  { key: "90d", label: "Last 90 days", short: "90D" },
  { key: "ytd", label: "Year to date", short: "YTD" },
  { key: "all", label: "All time", short: "ALL" },
];

export const DEFAULT_RANGE: RangeKey = "30d";

/** Narrows an untrusted `?range=` value; anything unrecognised falls back. */
export function parseRange(value: string | string[] | undefined | null): RangeKey {
  const raw = Array.isArray(value) ? value[0] : value;
  return RANGE_KEYS.includes(raw as RangeKey) ? (raw as RangeKey) : DEFAULT_RANGE;
}

export function rangeLabel(range: string): string {
  const key = parseRange(range);
  return RANGE_PRESETS.find((p) => p.key === key)!.label;
}

/**
 * Lookback window in days, or null for all time.
 *
 * Every page filters on this rather than rolling its own arithmetic, so "last
 * 30 days" means the same thing on the funnel as it does on revenue. YTD is
 * computed from the calendar year rather than fixed at 365 — on 12 January it
 * must mean twelve days, not the previous January.
 */
export function rangeToDays(range: string): number | null {
  const key = parseRange(range);
  if (key === "all") return null;
  if (key === "ytd") {
    const now = new Date();
    const jan1 = new Date(now.getFullYear(), 0, 1);
    return Math.max(1, Math.ceil((now.getTime() - jan1.getTime()) / 86_400_000));
  }
  return { "7d": 7, "30d": 30, "90d": 90 }[key];
}

/** ISO timestamp for the start of the window, or null for all time. */
export function rangeStartIso(range: string): string | null {
  const days = rangeToDays(range);
  if (days === null) return null;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
