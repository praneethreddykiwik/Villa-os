"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Activity, BarChart3, CalendarCheck, CalendarDays, Film, Gauge, Inbox, KanbanSquare, Lightbulb, MapPin,
  Megaphone, PlugZap, Sparkles, Star, FileText, Settings,
  Users, GitBranch, Contact, UserCheck, ListTodo, BellRing, Building2, Wallet, ShieldCheck, MessageSquare,
  PhoneCall, Menu, X,
  Instagram, Facebook, Linkedin, Youtube, Workflow,
} from "lucide-react";
import clsx from "clsx";
import { GlentreeTree } from "./brand/glentree-tree";
import type { Brand } from "@/lib/types";
import { VisitRequestsBell } from "./visit-requests-bell";
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
    { href: "/showcase", label: "Project Showcase", icon: Building2 },
    { href: "/publish-v2", label: "Publish a video", icon: Sparkles },
    { href: "/board", label: "Board", icon: KanbanSquare },
    { href: "/calendar", label: "Calendar", icon: CalendarDays },
    { href: "/ideas", label: "Post ideas", icon: Lightbulb },
  ]},
  // One set of customer records, not two. These used to point at JSON-backed
  // screens that no agent ever wrote to, so a lead that arrived by WhatsApp
  // was invisible here. They now open the same Supabase records the agents
  // use; the old /crm/* URLs redirect, so nothing anyone bookmarked breaks.
  { group: "CRM", items: [
    { href: "/inbox/whatsapp/crm/leads", label: "Leads", icon: Users },
    { href: "/inbox/whatsapp/crm/pipeline", label: "Pipeline", icon: GitBranch },
    { href: "/inbox/whatsapp/crm/contacts", label: "Contacts", icon: Contact },
    { href: "/inbox/whatsapp/crm/customers", label: "Customers", icon: UserCheck },
    // Gated by the same rule the page is: `requiredPermissionFor` matches
    // /^\/inbox\/whatsapp\/(crm|sales)/ to sales.read, so this link and the
    // screen behind it cannot drift into a visible link to a locked door.
    { href: "/inbox/whatsapp/sales/site-visits", label: "Site visits", icon: CalendarCheck },
    { href: "/inbox/whatsapp/crm/follow-ups", label: "Follow-ups", icon: BellRing },
  ]},
  // Conversations with leads, as opposed to records about them. Both are gated
  // on customers.read like the directory, so they filter with the CRM group.
  { group: "Engage", items: [
    { href: "/voice", label: "Voice calls", icon: PhoneCall },
    // One door for everything WhatsApp: the inbox, the assistant's training
    // and the sales workspace behind it, as tabs rather than as three
    // separate sidebar entries pointing at the same subject.
    // Straight to the conversations, which is what "WhatsApp" means to the
    // person clicking it. It used to land on the workspace dashboard, so the
    // box for starting a new chat looked like it did not exist.
    { href: "/inbox/whatsapp/communication/whatsapp", label: "WhatsApp", icon: Inbox },
  ]},
  { group: "Grow", items: [
    { href: "/ads", label: "Ads · Meta + Google", icon: Megaphone },
    { href: "/engagement", label: "Engagement", icon: Inbox, badgeKey: "inbox" as const },
    { href: "/reviews", label: "Reviews", icon: Star, badgeKey: "reviews" as const },
    { href: "/local", label: "Local visibility", icon: MapPin },
  ]},
  { group: "Operations", items: [
    { href: "/ops/messages", label: "Messages", icon: MessageSquare },
    { href: "/ops/sales", label: "Sales queue", icon: Users },
    { href: "/ops/loans", label: "Loan cases", icon: Wallet },
    { href: "/ops/admin", label: "Control centre", icon: ShieldCheck },
  ]},
  { group: "System", items: [
    { href: "/reports", label: "Reports", icon: FileText },
    { href: "/settings", label: "Settings", icon: Settings },
    // The operational side of the business — calling hours, retry policy —
    // as opposed to which vendors are wired up, which is /settings.
    { href: "/settings/villa", label: "Villa profile", icon: Building2 },
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

  /**
   * Below `lg` the sidebar is an off-canvas drawer.
   *
   * It used to be a permanent 240px column in a flex row at every width, so on
   * a 375px phone the whole application had 135px to render into. Nothing was
   * usable; the dashboard was effectively desktop-only.
   */
  const [open, setOpen] = useState(false);

  // Opening a link must reveal the page it opened, not leave the drawer over it.
  useEffect(() => {
    setOpen(false);
  }, [pathname, params]);

  // Escape closes it, and the page behind must not scroll under the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [open]);

  return (
    <>
      {/* The opener. Fixed so it is reachable from anywhere on a long page, and
          gone entirely at lg where the real sidebar is always on screen. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
        aria-expanded={open}
        className="fixed left-3 top-3 z-50 grid h-10 w-10 place-items-center rounded-xl border border-ink-700/80 bg-ink-900/80 text-mist-200 backdrop-blur-xl transition hover:bg-ink-800 lg:hidden"
      >
        <Menu size={18} strokeWidth={1.75} aria-hidden />
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-ink-950/70 backdrop-blur-sm lg:hidden"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

    <aside
      className={clsx(
        "z-50 flex h-screen w-[260px] shrink-0 flex-col border-r border-ink-800/80 bg-ink-950/95 backdrop-blur-3xl shadow-lg transition-transform duration-200",
        "fixed inset-y-0 left-0",
        open ? "translate-x-0" : "-translate-x-full",
        // At lg it stops being a drawer and goes back to being a column.
        "lg:sticky lg:top-0 lg:w-[240px] lg:translate-x-0 lg:bg-ink-950/50",
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        aria-label="Close navigation"
        className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-lg text-mist-400 transition hover:bg-ink-800 hover:text-mist-100 lg:hidden"
      >
        <X size={16} strokeWidth={1.75} aria-hidden />
      </button>
      <div className="flex items-center gap-3 px-5 py-5 border-b border-ink-800/40">
        {/* The client's own mark, in their green. It keeps its brand colour in
            both themes rather than taking the app accent — a logo that changes
            colour with a theme toggle stops being a logo. */}
        <div className="relative grid h-9 w-9 shrink-0 place-items-center rounded-2xl border border-ink-700/60 bg-ink-900/60 text-[color:var(--brand-tree)] shadow-sm">
          <GlentreeTree size={22} />
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
                  /* The active page was signalled by colour alone, which a
                     screen reader cannot read out. */
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "group relative mb-0.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-[13px] font-medium transition-all duration-150",
                    active
                      ? "liquid-glass-pill bg-ink-700 text-mist-100 shadow-sm border border-brand-500/55"
                      : "text-mist-400 hover:bg-ink-800/60 hover:text-mist-100",
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
    </>
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
    <header className="sticky top-0 z-20 flex items-center gap-4 border-b border-ink-800/70 bg-ink-950/60 px-4 sm:px-6 lg:px-7 py-3.5 backdrop-blur-3xl">
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[17.5px] font-bold tracking-tight gradient-heading">{title}</h1>
        {subtitle && <p className="truncate text-xs text-mist-400">{subtitle}</p>}
      </div>

      <div className="flex items-center gap-3">
        {/* Was a "Live Infrastructure" badge linking to /setup — a status
            about the deployment, which is the vendor's concern, in the one
            place every screen shows. This is the client's concern: somebody
            asked to visit and is waiting on an answer. */}
        <VisitRequestsBell />
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
                  ? "bg-ink-700 text-mist-100 shadow-sm border border-brand-500/55"
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

