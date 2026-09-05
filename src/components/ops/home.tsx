"use client";

import Link from "next/link";
import {
  ArrowRight,
  Building2,
  GitBranch,
  LogOut,
  MessageSquare,
  PhoneCall,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
} from "lucide-react";
import { browserClient } from "@/lib/supabase/client";
import { Badge, Card } from "../ui";

/**
 * Landing page after sign-in.
 *
 * Destinations are chosen by *permission*, never by role name. A custom role an
 * admin invents later automatically gets the right doors without a code change.
 */
const DESTINATIONS: Array<{
  href: string;
  label: string;
  description: string;
  icon: typeof Users;
  needs: string;
  badge: string;
  color: string;
}> = [
  {
    href: "/ops/admin",
    label: "Control Centre",
    description: "Executive pipeline, team workload, SLA thresholds and audit oversight",
    icon: ShieldCheck,
    needs: "analytics.view",
    badge: "Management",
    color: "from-sky-500/20 to-indigo-500/20 text-sky-400 border-sky-500/30",
  },
  {
    href: "/ops/sales",
    label: "Sales Workspace",
    description: "Active inquiries, call triggers, WhatsApp chats & follow-up scheduler",
    icon: Users,
    needs: "sales.read",
    badge: "Sales Queue",
    color: "from-emerald-500/20 to-teal-500/20 text-emerald-400 border-emerald-500/30",
  },
  {
    href: "/crm/pipeline",
    label: "Deal Pipeline",
    description: "Visual Kanban board across visit scheduled, negotiation & token deposit",
    icon: GitBranch,
    needs: "sales.read",
    badge: "Deals",
    color: "from-cyan-500/20 to-blue-500/20 text-cyan-400 border-cyan-500/30",
  },
  {
    href: "/voice",
    label: "AI Voice Agents",
    description: "Bolna outbound calling agents, automated Hindi/Telugu scripts & transcripts",
    icon: PhoneCall,
    needs: "customers.read",
    badge: "Bolna Voice",
    color: "from-purple-500/20 to-pink-500/20 text-purple-400 border-purple-500/30",
  },
  {
    href: "/ops/loans",
    label: "Loan Cases",
    description: "KYC document checklists, eligibility verification and bank submissions",
    icon: Wallet,
    needs: "loans.read",
    badge: "Finance",
    color: "from-amber-500/20 to-orange-500/20 text-amber-400 border-amber-500/30",
  },
  {
    href: "/ops/messages",
    label: "Team Messages",
    description: "Internal communication threads and department handovers",
    icon: MessageSquare,
    needs: "customers.read",
    badge: "Support",
    color: "from-violet-500/20 to-purple-500/20 text-violet-400 border-violet-500/30",
  },
];

export function OpsHome({
  session,
}: {
  session: { name: string; roles: string[]; permissions: string[] };
}) {
  const allowed = new Set(session.permissions);

  async function signOut() {
    try {
      await browserClient().auth.signOut();
    } catch {
      /* fall through to server call */
    }
    await fetch("/api/ops/session", { method: "DELETE" });
    window.location.href = "/ops";
  }

  const visible = DESTINATIONS.filter((d) => allowed.has(d.needs));

  return (
    <div className="mx-auto max-w-4xl p-7 sm:p-10 space-y-8">
      {/* Hero Header Banner */}
      <div className="glass-card relative overflow-hidden p-6 sm:p-8">
        <div className="absolute right-0 top-0 -mt-8 -mr-8 h-48 w-48 rounded-full bg-gradient-to-br from-brand-500/10 to-transparent blur-2xl pointer-events-none" />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="relative grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400/20 to-brand-600/30 border border-brand-500/30 text-brand-300 shadow-md">
              <Building2 size={24} />
              <span className="beacon-dot absolute -bottom-0.5 -right-0.5 bg-good-400" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-mist-100">
                  Welcome, {session.name}
                </h1>
                {session.roles.map((r) => (
                  <Badge key={r} tone="brand" pulse>
                    {r.replace(/_/g, " ")}
                  </Badge>
                ))}
              </div>
              <p className="mt-1 text-[12.5px] text-mist-400 flex items-center gap-2">
                <span>Glentree Command Center</span>
                <span>·</span>
                <span className="text-mist-300 font-medium">
                  {session.permissions.length} active capability{session.permissions.length === 1 ? "" : "ies"}
                </span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <Link
              href="/setup"
              className="inline-flex items-center gap-1.5 rounded-xl border border-ink-750 bg-ink-850/80 px-3 py-2 text-[12px] font-medium text-mist-300 hover:text-mist-100 hover:border-ink-600 transition-colors"
            >
              <Sparkles size={13} className="text-brand-400" />
              Diagnostics
            </Link>
            <button
              onClick={signOut}
              className="inline-flex items-center gap-1.5 rounded-xl border border-ink-750 bg-ink-850/80 px-3 py-2 text-[12px] font-medium text-mist-300 hover:text-bad-400 hover:border-bad-500/30 transition-colors"
            >
              <LogOut size={13} />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Grid of Workspaces */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-[15px] font-bold tracking-tight gradient-heading">Available Workspaces</h2>
            <p className="text-[12px] text-mist-400">Jump directly into your operational modules</p>
          </div>
          <span className="text-[11px] font-medium text-mist-500">
            {visible.length} workspace{visible.length === 1 ? "" : "s"} accessible
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
          {visible.map((d) => {
            const Icon = d.icon;
            return (
              <Link key={d.href} href={d.href} className="group">
                <div className="glass-card card-interactive p-5 flex flex-col justify-between h-full">
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-3">
                      <div
                        className={`grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br border ${d.color} shadow-sm group-hover:scale-105 transition-transform duration-200`}
                      >
                        <Icon size={19} />
                      </div>
                      <Badge tone="neutral" className="text-[10px] uppercase font-semibold tracking-wider">
                        {d.badge}
                      </Badge>
                    </div>
                    <h3 className="text-[14.5px] font-semibold text-mist-100 group-hover:text-brand-300 transition-colors">
                      {d.label}
                    </h3>
                    <p className="mt-1 text-[12px] leading-relaxed text-mist-400">
                      {d.description}
                    </p>
                  </div>
                  <div className="mt-4 pt-3 border-t border-ink-800/40 flex items-center justify-between text-[11.5px] font-medium text-mist-500 group-hover:text-mist-200 transition-colors">
                    <span>Open workspace</span>
                    <ArrowRight
                      size={14}
                      className="group-hover:translate-x-1 transition-transform duration-150 text-brand-400"
                    />
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        {!visible.length && (
          <Card>
            <p className="text-[12.5px] leading-relaxed text-mist-300">
              Your account has no role assigned yet. Ask an administrator to assign a role from the Control Centre Team tab.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
