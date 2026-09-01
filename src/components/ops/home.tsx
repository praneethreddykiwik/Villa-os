"use client";

import Link from "next/link";
import { Building2, LogOut, MessageSquare, ShieldCheck, Users, Wallet } from "lucide-react";
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
}> = [
  { href: "/ops/admin", label: "Control centre", description: "Pipeline, team workload, SLA and escalations", icon: ShieldCheck, needs: "analytics.view" },
  { href: "/ops/sales", label: "Sales workspace", description: "Your leads, calls and follow-ups", icon: Users, needs: "sales.read" },
  { href: "/ops/loans", label: "Loan cases", description: "Checklists, documents and reviews", icon: Wallet, needs: "loans.read" },
  { href: "/ops/messages", label: "Messages", description: "Talk to the team", icon: MessageSquare, needs: "customers.read" },
];

export function OpsHome({
  session,
}: {
  session: { name: string; roles: string[]; permissions: string[] };
}) {
  const allowed = new Set(session.permissions);

  async function signOut() {
    // Sign out of Supabase, then clear the cookie server-side too so a failed
    // client-side call cannot leave a replayable session behind.
    try {
      await browserClient().auth.signOut();
    } catch {
      /* fall through to the server call */
    }
    await fetch("/api/ops/session", { method: "DELETE" });
    window.location.href = "/ops";
  }

  const visible = DESTINATIONS.filter((d) => allowed.has(d.needs));

  return (
    <div className="mx-auto max-w-3xl p-10">
      <div className="flex flex-wrap items-center gap-3">
        <Building2 size={20} className="text-mist-400" />
        <div className="flex-1">
          <h1 className="text-[20px] font-semibold tracking-tight">{session.name}</h1>
          <p className="text-[12px] text-mist-400">
            {session.roles.length ? session.roles.join(", ").replace(/_/g, " ") : "No role assigned"} ·{" "}
            {session.permissions.length} permission{session.permissions.length === 1 ? "" : "s"}
          </p>
        </div>
        {session.roles.map((r) => (
          <Badge key={r} tone="brand">{r.replace(/_/g, " ")}</Badge>
        ))}
        <button
          onClick={signOut}
          className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-300 hover:text-mist-100"
        >
          <LogOut size={13} /> Sign out
        </button>
      </div>

      <div className="mt-6 space-y-2">
        {visible.map((d) => {
          const Icon = d.icon;
          return (
            <Link key={d.href} href={d.href}>
              <Card className="card-hover flex items-center gap-3">
                <Icon size={17} className="text-brand-400" />
                <span className="flex-1">
                  <span className="block text-[13.5px] font-medium text-mist-100">{d.label}</span>
                  <span className="block text-[11.5px] text-mist-400">{d.description}</span>
                </span>
              </Card>
            </Link>
          );
        })}
        {!visible.length && (
          <Card>
            <p className="text-[12.5px] leading-relaxed text-mist-300">
              Your account has no role assigned yet, so there is nothing to open. Ask an administrator to
              assign one — they can do it from the Team tab of the control centre.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}
