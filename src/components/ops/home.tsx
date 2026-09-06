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
    description: "Outbound AI calling, automated multilingual scripts & call transcripts",
    icon: PhoneCall,
    needs: "customers.read",
    badge: "AI Voice",
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
      <div className="liquid-glass-card relative overflow-hidden p-6 sm:p-8">
        <div className="absolute right-0 top-0 -mt-10 -mr-10 h-56 w-56 rounded-full bg-gradient-to-br from-purple-500/20 via-pink-500/15 to-transparent blur-3xl pointer-events-none" />
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-5">
          <div className="flex items-start gap-4">
            <div className="relative grid h-13 w-13 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand-400/25 via-brand-500/20 to-brand-600/30 border border-white/20 text-brand-300 shadow-lg">
              <Building2 size={26} />
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
              <p className="mt-1 text-[13px] text-mist-400 flex items-center gap-2">
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
              className="liquid-glass-button px-4 py-2 text-[12px] font-medium text-mist-200 hover:text-white"
            >
              <Sparkles size={13} className="text-brand-400 mr-1.5" />
              Diagnostics
            </Link>
            <button
              onClick={signOut}
              className="liquid-glass-button px-4 py-2 text-[12px] font-medium text-mist-300 hover:text-bad-400 hover:border-bad-500/30"
            >
              <LogOut size={13} className="mr-1.5" />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Grid of Workspaces */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-[16px] font-bold tracking-tight gradient-heading">Operational Hubs</h2>
            <p className="text-[12.5px] text-mist-400">Direct liquid access into your business engines</p>
          </div>
          <span className="text-[11.5px] font-medium text-mist-500">
            {visible.length} workspace{visible.length === 1 ? "" : "s"} accessible
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {visible.map((d) => {
            const Icon = d.icon;
            const isVoice = d.href === "/voice";
            return (
              <Link key={d.href} href={d.href} className="group">
                <div className="liquid-glass-card liquid-glass-interactive p-6 flex flex-col justify-between h-full">
                  <div>
                    <div className="flex items-center justify-between gap-3 mb-3.5">
                      <div
                        className={`grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br border ${d.color} shadow-sm group-hover:scale-110 transition-transform duration-200`}
                      >
                        <Icon size={20} />
                      </div>
                      <Badge
                        tone={isVoice ? "holographic" : "neutral"}
                        className="text-[10.5px] uppercase font-semibold tracking-wider"
                      >
                        {d.badge}
                      </Badge>
                    </div>
                    <h3 className="text-[15px] font-bold text-mist-100 group-hover:text-brand-300 transition-colors">
                      {d.label}
                    </h3>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-mist-400">
                      {d.description}
                    </p>
                  </div>
                  <div className="mt-5 pt-3.5 border-t border-ink-800/50 flex items-center justify-between text-[11.5px] font-semibold text-mist-400 group-hover:text-mist-100 transition-colors">
                    <span>Open Workspace</span>
                    <ArrowRight
                      size={14}
                      className="group-hover:translate-x-1.5 transition-transform duration-150 text-brand-400"
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
