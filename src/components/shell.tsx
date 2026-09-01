"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity, BarChart3, CalendarDays, Film, Gauge, Inbox, KanbanSquare, Lightbulb, MapPin,
  Megaphone, PenSquare, PlugZap, Sparkles, Star, FileText, Settings,
  Users, GitBranch, Contact, UserCheck, ListTodo, BellRing, Building2, Wallet, ShieldCheck, MessageSquare,
} from "lucide-react";
import clsx from "clsx";
import type { Brand } from "@/lib/types";
import { requiredPermissionFor } from "@/lib/auth/page-access";

interface NavItem {
  href: string;
  label: string;
  icon: typeof Users;
  badgeKey?: "suggestions" | "inbox" | "reviews";
}
interface NavSection {
  group: string;
  items: NavItem[];
}
import { ThemeToggle } from "./theme-toggle";

const NAV: NavSection[] = [
  { group: "Overview", items: [
    { href: "/dashboard", label: "Dashboard", icon: Gauge },
    { href: "/insights", label: "AI Insights", icon: Sparkles, badgeKey: "suggestions" as const },
    { href: "/analytics", label: "Analytics", icon: BarChart3 },
  ]},
  { group: "Create & publish", items: [
    { href: "/composer", label: "Composer", icon: PenSquare },
    { href: "/studio", label: "Video Studio", icon: Film },
    { href: "/board", label: "Board", icon: KanbanSquare },
    { href: "/calendar", label: "Calendar", icon: CalendarDays },
    { href: "/ideas", label: "Post ideas", icon: Lightbulb },
  ]},
  { group: "CRM", items: [
    { href: "/crm/leads", label: "Leads", icon: Users },
    { href: "/crm/pipeline", label: "Pipeline", icon: GitBranch },
    { href: "/crm/contacts", label: "Contacts", icon: Contact },
    { href: "/crm/customers", label: "Customers", icon: UserCheck },
    { href: "/crm/tasks", label: "Tasks", icon: ListTodo },
    { href: "/crm/follow-ups", label: "Follow-ups", icon: BellRing },
  ]},
  { group: "Grow", items: [
    { href: "/ads", label: "Ads · Meta + Google", icon: Megaphone },
    { href: "/engagement", label: "Engagement", icon: Inbox, badgeKey: "inbox" as const },
    { href: "/reviews", label: "Reviews", icon: Star, badgeKey: "reviews" as const },
    { href: "/local", label: "Local visibility", icon: MapPin },
  ]},
  { group: "Operations", items: [
    { href: "/ops", label: "Workspace", icon: Building2 },
    { href: "/ops/messages", label: "Messages", icon: MessageSquare },
    { href: "/ops/sales", label: "Sales queue", icon: Users },
    { href: "/ops/loans", label: "Loan cases", icon: Wallet },
    { href: "/ops/admin", label: "Control centre", icon: ShieldCheck },
  ]},
  { group: "Deliver", items: [
    { href: "/reports", label: "Reports", icon: FileText },
    { href: "/activity", label: "Activity", icon: Activity },
    { href: "/connections", label: "Connections", icon: PlugZap },
    { href: "/settings", label: "Settings", icon: Settings },
  ]},
];

/**
 * Navigation is filtered by permission, using the same map the page guard uses.
 * Showing a link that leads to a locked door is a worse experience than not
 * showing it, and it leaks what exists.
 */
export function Sidebar({
  counts,
  permissions = [],
}: {
  counts: Record<string, number>;
  permissions?: string[];
}) {
  const allowed = new Set(permissions);
  const visible = NAV.map((section) => ({
    ...section,
    items: section.items.filter((item) => {
      const required = requiredPermissionFor(item.href);
      if (required === "allow") return true;
      if (required === null) return false;
      return allowed.has(required);
    }),
  })).filter((section) => section.items.length > 0);

  const pathname = usePathname();
  const params = useSearchParams();
  const qs = params.get("brand") ? `?brand=${params.get("brand")}` : "";

  return (
    <aside className="sticky top-0 flex h-screen w-[228px] shrink-0 flex-col border-r border-ink-800 bg-ink-900/60">
      <div className="flex items-center gap-2.5 px-5 py-5">
        <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 text-sm font-bold text-[var(--a-on)]">
          O
        </div>
        <div>
          <div className="text-[13px] font-semibold leading-tight">Orbit</div>
          <div className="text-[10px] leading-tight text-mist-400">Social · Ads · Local</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 pb-6">
        {visible.map((section) => (
          <div key={section.group} className="mb-5">
            <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist-400/70">
              {section.group}
            </div>
            {section.items.map((item) => {
              const active = pathname === item.href;
              const count = "badgeKey" in item && item.badgeKey ? counts[item.badgeKey] : 0;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={`${item.href}${qs}`}
                  className={clsx(
                    "group mb-0.5 flex items-center gap-2.5 rounded-lg px-2 py-[7px] text-[13px] transition-colors",
                    active ? "bg-brand-500/12 text-mist-100" : "text-mist-300 hover:bg-ink-800 hover:text-mist-100",
                  )}
                >
                  <Icon size={15} className={active ? "text-brand-400" : "text-mist-400 group-hover:text-mist-200"} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {count > 0 && (
                    <span className="tnum rounded-full bg-ink-700 px-1.5 text-[10px] font-semibold text-mist-200">{count}</span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

export function TopBar({
  brands,
  brandId,
  title,
  subtitle,
  right,
}: {
  brands: Brand[];
  brandId: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const brand = brands.find((b) => b.id === brandId);

  function switchBrand(id: string) {
    const next = new URLSearchParams(params.toString());
    next.set("brand", id);
    router.push(`${pathname}?${next.toString()}`);
  }

  function setRange(days: string) {
    const next = new URLSearchParams(params.toString());
    next.set("range", days);
    router.push(`${pathname}?${next.toString()}`);
  }

  const range = params.get("range") ?? "30";

  return (
    <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-ink-800 bg-ink-950/85 px-7 py-3.5 backdrop-blur">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[17px] font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="truncate text-xs text-mist-400">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-2">
        {right}
        <ThemeToggle />
        <div className="flex overflow-hidden rounded-lg border border-ink-700">
          {["7", "30", "90"].map((d) => (
            <button
              key={d}
              onClick={() => setRange(d)}
              className={clsx(
                "px-2.5 py-1.5 text-[12px] transition-colors",
                range === d ? "bg-ink-700 text-mist-100" : "text-mist-400 hover:text-mist-200",
              )}
            >
              {d}d
            </button>
          ))}
        </div>

        <div className="relative">
          <select
            value={brandId}
            onChange={(e) => switchBrand(e.target.value)}
            className="appearance-none rounded-lg border border-ink-700 bg-ink-850 py-1.5 pl-7 pr-7 text-[12px] text-mist-100 outline-none hover:border-ink-600"
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
            style={{ background: brand?.color }}
          />
        </div>
      </div>
    </header>
  );
}
