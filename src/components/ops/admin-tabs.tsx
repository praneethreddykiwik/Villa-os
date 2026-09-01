"use client";

import { useState } from "react";
import Link from "next/link";
import { Activity, BarChart3, ShieldAlert, Users, Wallet } from "lucide-react";
import clsx from "clsx";
import { Badge, Bar, Card, SectionTitle, Stat } from "../ui";
import { TeamManager } from "./team-manager";

/**
 * Admin control centre.
 *
 * Organised around the question an owner actually asks — "what is each team
 * doing right now?" — rather than around database tables. Every tab answers it
 * for one department, in plain language, with the number that matters first.
 */

export interface SalesPerson {
  id: string;
  name: string;
  assigned: number;
  open: number;
  callsPending: number;
  callsCompleted: number;
  overdue: number;
  hotLeads: number;
  medianResponseHours: number | null;
  lastActivityAt?: string;
  recent: Array<{ at: string; what: string; customer?: string }>;
}

export interface LoanPerson {
  id: string;
  name: string;
  activeCases: number;
  awaitingReview: number;
  waitingOnCustomer: number;
  overdue: number;
  docsAccepted: number;
  docsRejected: number;
  recent: Array<{ at: string; what: string; customer?: string }>;
}

export interface AdminData {
  totals: Record<string, number>;
  pipeline: Array<{ stage: string; count: number }>;
  sales: SalesPerson[];
  loans: LoanPerson[];
  escalations: Array<{ id: string; customerId: string; customer: string; reason: string; severity: string; lane: string; createdAt: string }>;
  activity: Array<{ id: string; at: string; actor: string; actorType: string; action: string; customer?: string }>;
}

const TABS = [
  { id: "overview", label: "Overview", icon: BarChart3 },
  { id: "sales", label: "Sales team", icon: Users },
  { id: "loans", label: "Loan department", icon: Wallet },
  { id: "team", label: "People & access", icon: ShieldAlert },
  { id: "activity", label: "Activity log", icon: Activity },
] as const;

function ago(iso?: string): string {
  if (!iso) return "no activity yet";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function AdminTabs({ data }: { data: AdminData }) {
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("overview");
  const maxStage = Math.max(1, ...data.pipeline.map((p) => p.count));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap gap-1 border-b border-ink-700">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[12.5px] transition-colors",
                tab === t.id
                  ? "border-brand-500 text-mist-100"
                  : "border-transparent text-mist-400 hover:text-mist-200",
              )}
            >
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === "overview" && (
        <div className="space-y-5">
          {data.escalations.length > 0 && (
            <Card className="border-bad-500/35 bg-bad-500/[0.05]">
              <SectionTitle
                title={`${data.escalations.length} thing${data.escalations.length === 1 ? "" : "s"} need a person`}
                hint="The system has done what it can — these are waiting on someone"
              />
              <div className="space-y-1.5">
                {data.escalations.map((e) => (
                  <div key={e.id} className="flex flex-wrap items-center gap-2 text-[12px]">
                    <Badge tone={e.severity === "HIGH" ? "bad" : "warn"}>{e.severity.toLowerCase()}</Badge>
                    <Link href={`/ops/customers/${e.customerId}`} className="font-medium text-mist-100 hover:underline">
                      {e.customer}
                    </Link>
                    <span className="text-mist-300">{e.reason}</span>
                    <span className="ml-auto text-[10.5px] text-mist-400">{e.lane.toLowerCase()} · {ago(e.createdAt)}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            {Object.entries(data.totals).map(([label, value]) => (
              <Stat key={label} label={label} value={String(value)} />
            ))}
          </div>

          <Card>
            <SectionTitle
              title="Where every customer currently sits"
              hint="One bar per stage of the journey, from first enquiry to completion"
            />
            <div className="space-y-2">
              {data.pipeline.map((s) => (
                <div key={s.stage} className="flex items-center gap-3">
                  <span className="w-48 shrink-0 text-[11.5px] text-mist-300">{s.stage}</span>
                  <Bar value={s.count} max={maxStage} />
                  <span className="tnum w-8 shrink-0 text-right text-[12px] text-mist-100">{s.count}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {tab === "sales" && (
        <div className="space-y-3">
          <p className="text-[12px] text-mist-400">
            What each salesperson is carrying right now, and what they have done recently.
            &ldquo;Overdue&rdquo; means a call that has passed its promised time.
          </p>
          {data.sales.map((p) => (
            <Card key={p.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-700 text-[11px] font-semibold text-mist-200">
                  {p.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                </span>
                <span className="text-[13.5px] font-semibold text-mist-100">{p.name}</span>
                {p.overdue > 0 && <Badge tone="bad">{p.overdue} overdue</Badge>}
                {p.hotLeads > 0 && <Badge tone="good">{p.hotLeads} hot</Badge>}
                <span className="ml-auto text-[11px] text-mist-400">last active {ago(p.lastActivityAt)}</span>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 text-[11.5px] md:grid-cols-5">
                {[
                  ["Customers assigned", p.assigned],
                  ["Still open", p.open],
                  ["Calls to make", p.callsPending],
                  ["Calls done", p.callsCompleted],
                  ["Typical reply time", p.medianResponseHours === null ? "—" : `${p.medianResponseHours}h`],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div className="text-mist-400">{label}</div>
                    <div className="tnum text-[15px] font-semibold text-mist-100">{value}</div>
                  </div>
                ))}
              </div>

              {p.recent.length > 0 && (
                <div className="mt-3 border-t border-ink-700 pt-2.5">
                  <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-mist-400">Recently</div>
                  <div className="space-y-1">
                    {p.recent.map((r, i) => (
                      <div key={i} className="flex gap-2 text-[11.5px]">
                        <span className="tnum w-20 shrink-0 text-mist-400">{ago(r.at)}</span>
                        <span className="text-mist-200">{r.what}</span>
                        {r.customer && <span className="text-mist-400">· {r.customer}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
          {!data.sales.length && (
            <Card><p className="py-6 text-center text-[12.5px] text-mist-400">Nobody is assigned to sales yet.</p></Card>
          )}
        </div>
      )}

      {tab === "loans" && (
        <div className="space-y-3">
          <p className="text-[12px] text-mist-400">
            Each loan officer&rsquo;s workload. &ldquo;Waiting on customer&rdquo; means the ball is with the buyer;
            &ldquo;needs your review&rdquo; means it is with the officer.
          </p>
          {data.loans.map((p) => (
            <Card key={p.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-8 w-8 place-items-center rounded-full bg-ink-700 text-[11px] font-semibold text-mist-200">
                  {p.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
                </span>
                <span className="text-[13.5px] font-semibold text-mist-100">{p.name}</span>
                {p.awaitingReview > 0 && <Badge tone="warn">{p.awaitingReview} to review</Badge>}
                {p.overdue > 0 && <Badge tone="bad">{p.overdue} overdue</Badge>}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[11.5px] md:grid-cols-5">
                {[
                  ["Active cases", p.activeCases],
                  ["Needs your review", p.awaitingReview],
                  ["Waiting on customer", p.waitingOnCustomer],
                  ["Documents accepted", p.docsAccepted],
                  ["Documents rejected", p.docsRejected],
                ].map(([label, value]) => (
                  <div key={String(label)}>
                    <div className="text-mist-400">{label}</div>
                    <div className="tnum text-[15px] font-semibold text-mist-100">{value}</div>
                  </div>
                ))}
              </div>
              {p.recent.length > 0 && (
                <div className="mt-3 border-t border-ink-700 pt-2.5 space-y-1">
                  {p.recent.map((r, i) => (
                    <div key={i} className="flex gap-2 text-[11.5px]">
                      <span className="tnum w-20 shrink-0 text-mist-400">{ago(r.at)}</span>
                      <span className="text-mist-200">{r.what}</span>
                      {r.customer && <span className="text-mist-400">· {r.customer}</span>}
                    </div>
                  ))}
                </div>
              )}
            </Card>
          ))}
          {!data.loans.length && (
            <Card><p className="py-6 text-center text-[12.5px] text-mist-400">No loan officers assigned yet.</p></Card>
          )}
        </div>
      )}

      {tab === "team" && <TeamManager />}

      {tab === "activity" && (
        <Card>
          <SectionTitle
            title="Everything that happened"
            hint="Who did what, and when. Automated steps are labelled so nothing is ambiguous."
          />
          <div className="max-h-[600px] space-y-1 overflow-y-auto">
            {data.activity.map((a) => (
              <div key={a.id} className="flex flex-wrap items-center gap-2 border-b border-ink-700/50 py-2 text-[11.5px] last:border-0">
                <span className="tnum w-32 shrink-0 text-mist-400">{new Date(a.at).toLocaleString()}</span>
                <Badge tone={a.actorType === "ai" ? "brand" : a.actorType === "human" ? "good" : "neutral"}>
                  {a.actorType === "ai" ? "automatic" : a.actorType}
                </Badge>
                <span className="text-mist-200">{a.action.replace(/[._]/g, " ")}</span>
                {a.customer && <span className="text-mist-400">· {a.customer}</span>}
                <span className="ml-auto text-[10.5px] text-mist-500">{a.actor}</span>
              </div>
            ))}
            {!data.activity.length && <p className="py-6 text-center text-[12.5px] text-mist-400">Nothing recorded yet.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}
