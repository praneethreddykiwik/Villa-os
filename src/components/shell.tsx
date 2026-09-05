"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity, BarChart3, CalendarCheck, CalendarDays, Film, Gauge, Inbox, KanbanSquare, Lightbulb, MapPin,
  Megaphone, PenSquare, PlugZap, Sparkles, Star, FileText, Settings,
  Users, GitBranch, Contact, UserCheck, ListTodo, BellRing, Building2, Wallet, ShieldCheck, MessageSquare,
  PhoneCall,
  Instagram, Facebook, Linkedin, Youtube, Workflow,
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
  // One tab per network, each tracking that network on its own. Gated by the
  // same map the pages are: `requiredPermissionFor` matches /^\/channels/ to
  // marketing.read, so these links cannot outlive the permission behind them.
  { group: "Channels", items: [
    { href: "/channels/instagram", label: "Instagram", icon: Instagram },
    { href: "/channels/facebook", label: "Facebook", icon: Facebook },
    { href: "/channels/linkedin", label: "LinkedIn", icon: Linkedin },
    { href: "/channels/youtube", label: "YouTube", icon: Youtube },
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
    // Gated by the same rule the page is: `requiredPermissionFor` matches
    // /^\/crm\// to sales.read, so this link and the screen behind it can never
    // drift apart into a visible link to a locked door.
    { href: "/crm/appointments", label: "Site visits", icon: CalendarCheck },
    { href: "/crm/tasks", label: "Tasks", icon: ListTodo },
    { href: "/crm/follow-ups", label: "Follow-ups", icon: BellRing },
    // Voice sits in CRM rather than Grow because every call on it is made to a
    // lead in this list, and it is gated on customers.read like the directory.
    { href: "/voice", label: "Voice agent", icon: PhoneCall },
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
    // Reachable on marketing.read, matching /^\/automation/ in the access map:
    // the screen's everyday half is the video-posting form, and the webhook
    // registry on it is gated by its own API rather than by this link.
    { href: "/automation", label: "Automation", icon: Workflow },
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
  sessionInfo,
}: {
  counts: Record<string, number>;
  permissions?: string[];
  sessionInfo?: { name: string; email: string; role?: string };
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
    <aside className="sticky top-0 flex h-screen w-[240px] shrink-0 flex-col border-r border-ink-800/80 bg-ink-950/50 backdrop-blur-3xl shadow-lg">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-ink-800/40">
        <div className="relative grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-br from-brand-400 via-brand-500 to-brand-600 text-sm font-bold text-[var(--a-on)] shadow-lg shadow-brand-500/25 border border-white/20">
          <span className="font-extrabold tracking-tight">V</span>
          <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-950 bg-good-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-[14px] font-bold tracking-tight text-mist-100">Glentree</span>
            <span className="rounded-full bg-brand-500/15 px-2 py-0.2 text-[9px] font-semibold text-brand-300 border border-brand-500/30">
              PRO
            </span>
          </div>
          <div className="truncate text-[10.5px] text-mist-400">Villas · Sales · Marketing</div>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {visible.map((section) => (
          <div key={section.group} className="mb-5">
            <div className="px-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist-400/70">
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
                    "group relative mb-0.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium transition-all duration-150",
                    active
                      ? "liquid-glass-pill bg-white/12 dark:bg-white/10 text-mist-100 shadow-sm border border-white/20 dark:border-white/15"
                      : "text-mist-400 hover:bg-white/5 hover:text-mist-100",
                  )}
                >
                  <Icon
                    size={15}
                    className={clsx(
                      "transition-transform duration-150 group-hover:scale-110",
                      active ? "text-brand-300" : "text-mist-400 group-hover:text-mist-200",
                    )}
                  />
                  <span className="flex-1 truncate">{item.label}</span>
                  {count > 0 && (
                    <span className="tnum rounded-full border border-brand-500/30 bg-brand-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-brand-300">
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {sessionInfo && (
        <div className="mt-auto border-t border-ink-800/60 p-3">
          <div className="flex items-center gap-2.5 rounded-2xl bg-ink-900/60 p-2.5 border border-ink-800/60 backdrop-blur-xl shadow-sm">
            <div className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-500/20 to-brand-400/10 text-[12px] font-bold text-mist-100 uppercase border border-brand-500/30 shadow-inner">
              {sessionInfo.name ? sessionInfo.name.charAt(0) : "U"}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-semibold text-mist-100">{sessionInfo.name}</div>
              <div className="truncate text-[10.5px] text-mist-400 capitalize">
                {sessionInfo.role ? sessionInfo.role.replace(/_/g, " ") : "Staff"}
              </div>
            </div>
            <span className="beacon-dot bg-good-400 shrink-0" title="Online" />
          </div>
        </div>
      )}
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
    <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-ink-800/70 bg-ink-950/60 px-7 py-3.5 backdrop-blur-3xl">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[17.5px] font-bold tracking-tight gradient-heading">{title}</h1>
        {subtitle && <p className="truncate text-xs text-mist-400">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3">
        <Link
          href="/setup"
          className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-good-500/30 bg-good-500/12 px-3 py-1 text-[11px] font-semibold text-good-400 hover:bg-good-500/20 transition-all shadow-sm"
        >
          <span className="beacon-dot bg-good-400" />
          <span>Live Infrastructure</span>
        </Link>
        {right}
        <ThemeToggle />
        <div className="flex overflow-hidden rounded-full border border-ink-700/80 bg-ink-900/60 p-0.5 backdrop-blur-xl shadow-sm">
          {["7", "30", "90"].map((d) => (
            <button
              key={d}
              onClick={() => setRange(d)}
              className={clsx(
                "rounded-full px-3 py-1 text-[11.5px] font-medium transition-all duration-150 outline-none",
                range === d
                  ? "bg-white/15 dark:bg-white/12 text-mist-100 shadow-sm border border-white/20 dark:border-white/10"
                  : "text-mist-400 hover:text-mist-200",
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
            className="appearance-none rounded-full border border-ink-700/80 bg-ink-900/70 py-1.5 pl-7 pr-7 text-[12px] font-medium text-mist-100 outline-none hover:border-ink-600 backdrop-blur-xl cursor-pointer transition-all shadow-sm"
          >
            {brands.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          <span
            className="pointer-events-none absolute left-2.5 top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full ring-2 ring-ink-950"
            style={{ background: brand?.color }}
          />
        </div>
      </div>
    </header>
  );
}

/** Floating Liquid Dock — Inspired by the bottom dock in reference screenshot */
export function LiquidDock() {
  const pathname = usePathname();
  const items = [
    { href: "/dashboard", label: "Dashboard", icon: Gauge },
    { href: "/crm/pipeline", label: "Pipeline", icon: GitBranch },
    { href: "/voice", label: "Voice AI", icon: PhoneCall, isCenter: true },
    { href: "/composer", label: "Composer", icon: PenSquare },
    { href: "/setup", label: "System", icon: Settings },
  ];

  return (
    <nav aria-label="Liquid Navigation Dock" className="liquid-dock">
      {items.map((item) => {
        const active = pathname === item.href;
        const Icon = item.icon;
        if (item.isCenter) {
          return (
            <Link
              key={item.href}
              href={item.href}
              title="Voice Agent AI Hub"
              className="holographic-orb"
            >
              <Sparkles size={20} className="text-white drop-shadow" />
            </Link>
          );
        }
        return (
          <Link
            key={item.href}
            href={item.href}
            data-active={active}
            title={item.label}
            className="liquid-dock-item"
          >
            <Icon size={18} />
          </Link>
        );
      })}
    </nav>
  );
}
