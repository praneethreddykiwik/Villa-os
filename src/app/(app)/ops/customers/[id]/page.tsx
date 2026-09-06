import { notFound, redirect } from "next/navigation";
import { read } from "@/lib/db";
import { canAccessCustomer, can, sessionFromCookies } from "@/lib/ops/auth";
import { snapshot } from "@/lib/ops/customers";
import { sentimentTimeline } from "@/lib/ops/intelligence";
import { activeCase, caseProgress, checklistFor } from "@/lib/ops/loan";
import { buildBriefing } from "@/lib/ops/sales";
import { Badge, Bar, Card, SectionTitle, Stat } from "@/components/ui";
import { CustomerControls } from "@/components/ops/customer-controls";
import { SalesActions } from "@/components/ops/sales-actions";

export const dynamic = "force-dynamic";

/** Actor of a timeline row, so AI / human / customer / system are never confused. */
const ACTOR_TONE = { ai: "brand", human: "good", customer: "neutral", system: "neutral" } as const;

export default async function Customer360({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await sessionFromCookies();
  if (!session) redirect("/ops");
  if (!(await canAccessCustomer(session, id))) redirect("/ops");

  const snap = snapshot(id);
  if (!snap) notFound();

  const db = read();
  const c = snap.customer;
  const loanCase = activeCase(id);
  const checklist = loanCase ? checklistFor(loanCase.id) : [];
  const progress = loanCase ? caseProgress(loanCase.id) : null;
  const briefing = buildBriefing(id);
  const mayReadDocuments = can(session, "document:read");
  const name = (mid?: string) => db.teamMembers.find((m) => m.id === mid)?.name ?? "Unassigned";

  const managers = db.teamMembers.filter((m) => m.orgId === session.orgId && m.role === "SALES_MANAGER" && m.active);
  const messages = db.opsMessages.filter((m) => m.customerId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const timeline = db.auditEvents.filter((a) => a.customerId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const scores = db.scoreEvents.filter((s) => s.customerId === id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const documents = db.documents.filter((d) => d.customerId === id);

  return (
    <div className="space-y-6 p-7">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-[19px] font-semibold tracking-tight">{c.name}</h1>
          <p className="text-[12px] text-mist-400">
            {c.phone}{c.email ? ` · ${c.email}` : ""} · {c.source} · added {new Date(c.createdAt).toLocaleDateString()}
          </p>
        </div>
        <Badge tone="neutral">{c.leadStage.replace(/_/g, " ")}</Badge>
        <Badge tone={c.salesControl === "HUMAN_CONTROL" ? "warn" : "good"}>SALES {c.salesControl === "HUMAN_CONTROL" ? "HUMAN" : "AI"}</Badge>
        <Badge tone={c.loanControl === "HUMAN_CONTROL" ? "warn" : "good"}>LOAN {c.loanControl === "HUMAN_CONTROL" ? "HUMAN" : "AI"}</Badge>
        {c.optedOut && <Badge tone="bad">opted out</Badge>}
      </div>

      <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Lead score" value={String(c.leadScore)} sub={scores[0] ? `was ${scores[0].previousScore}` : undefined} />
        <Stat label="Sentiment" value={c.sentiment.replace("_", " ")} sub={`${Math.round(c.sentimentConfidence * 100)}% · ${snap.trend}`} />
        <Stat label="Intent" value={c.intent.replace(/_/g, " ")} />
        <Stat label="Financing" value={c.loanRequired} />
        <Stat label="Sales owner" value={name(c.assignedSalesManagerId)} />
        <Stat label="Loan officer" value={name(c.assignedLoanOfficerId)} />
      </div>

      <CustomerControls
        customerId={id}
        salesControl={c.salesControl}
        loanControl={c.loanControl}
        canWriteSales={can(session, "sales:write")}
        canWriteLoan={can(session, "loan:write")}
        hasLoanCase={Boolean(loanCase)}
      />

      {can(session, "sales:write") && (
        <SalesActions
          customerId={id}
          managers={managers.map((m) => ({ id: m.id, name: m.name }))}
          assignedTo={c.assignedSalesManagerId}
          hasLoanCase={Boolean(loanCase)}
          loanCaseId={loanCase?.id}
        />
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <SectionTitle title="AI briefing" hint="Assembled from stored structured state — not a re-reading of the transcript" />
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg border border-ink-700 bg-ink-850 p-3 text-[11.5px] leading-relaxed text-mist-300">
{briefing.text}
          </pre>
        </Card>

        <Card>
          <SectionTitle title="Sentiment over time" hint="How the customer moved, and why" />
          <div className="space-y-2">
            {sentimentTimeline(id).slice(-8).map((e) => (
              <div key={e.id} className="flex items-start gap-2 text-[11.5px]">
                <Badge tone={["NEGATIVE", "VERY_NEGATIVE"].includes(e.sentiment) ? "bad" : ["POSITIVE", "VERY_POSITIVE"].includes(e.sentiment) ? "good" : "neutral"}>
                  {e.sentiment.replace("_", " ")}
                </Badge>
                <span className="min-w-0 flex-1">
                  <span className="block text-mist-300">{e.intent.replace(/_/g, " ")}</span>
                  <span className="block text-[10.5px] text-mist-400">{e.reason}</span>
                </span>
                <span className="tnum shrink-0 text-[10px] text-mist-500">{new Date(e.createdAt).toLocaleDateString()}</span>
              </div>
            ))}
            {!sentimentTimeline(id).length && <p className="text-[12px] text-mist-400">No readings yet.</p>}
          </div>
        </Card>
      </div>

      {loanCase && progress && (
        <Card>
          <SectionTitle
            title="Loan case"
            hint={`${loanCase.status.replace(/_/g, " ")} · ${loanCase.loanType} · officer ${name(loanCase.assignedOfficerId)}`}
            action={
              can(session, "loan:write") ? (
                <a href={`/ops/loans/${loanCase.id}`} className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[11.5px] text-mist-200 hover:border-ink-600">
                  Open case workspace
                </a>
              ) : undefined
            }
          />
          <div className="mb-4 flex items-center gap-3">
            <Bar value={progress.requiredAccepted} max={Math.max(1, progress.requiredTotal)} color="var(--color-good-500)" />
            <span className="tnum shrink-0 text-[13px] font-semibold">{progress.completionPct}%</span>
            <span className="shrink-0 text-[11px] text-mist-400">{progress.requiredAccepted}/{progress.requiredTotal} required accepted</span>
          </div>

          <div className="overflow-x-auto">
          <table className="w-full text-[11.5px] min-w-[600px]">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[10px] uppercase tracking-wider text-mist-400">
                <th className="py-2 font-medium">Document</th>
                <th className="py-2 font-medium">Required</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium">Note</th>
                <th className="py-2 text-right font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {checklist.map((i) => (
                <tr key={i.id} className="border-b border-ink-700/60 last:border-0">
                  <td className="py-2 text-mist-200">{i.customerLabel}</td>
                  <td className="py-2 text-mist-400">{i.required ? "Required" : "Optional"}</td>
                  <td className="py-2">
                    <Badge tone={i.status === "ACCEPTED" ? "good" : i.status === "REJECTED" ? "bad" : ["UPLOADED", "UNDER_REVIEW"].includes(i.status) ? "warn" : "neutral"}>
                      {i.status.replace(/_/g, " ")}
                    </Badge>
                  </td>
                  <td className="py-2 text-mist-400">{i.rejectionReason ?? "—"}</td>
                  <td className="tnum py-2 text-right text-mist-400">{new Date(i.updatedAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>

          <div className="mt-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-mist-400">Documents</div>
            {!mayReadDocuments ? (
              <p className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[11.5px] text-mist-400">
                Hidden — your role does not have access to loan documents. Case status above is visible to sales so you
                can answer &ldquo;where is my application?&rdquo; without seeing the customer&rsquo;s financial records.
              </p>
            ) : (
              <div className="space-y-1.5">
                {documents.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2 text-[11.5px]">
                    <span className="text-mist-200">{d.filename}</span>
                    <span className="text-mist-500">{Math.round(d.sizeBytes / 1024)}KB</span>
                    <Badge tone={d.status === "ACCEPTED" ? "good" : d.status === "REJECTED" ? "bad" : "warn"}>{d.status}</Badge>
                    {d.rejectionReason && <span className="text-bad-400">{d.rejectionReason}</span>}
                    <span className="tnum ml-auto text-[10.5px] text-mist-400">
                      {d.uploadedBy} · {new Date(d.createdAt).toLocaleString()}
                    </span>
                  </div>
                ))}
                {!documents.length && <p className="text-[11.5px] text-mist-400">No documents received yet.</p>}
              </div>
            )}
          </div>
        </Card>
      )}

      <div className="grid gap-5 xl:grid-cols-2">
        <Card>
          <SectionTitle title="Conversation" hint="Raw messages, preserved alongside the structured extraction" />
          <div className="max-h-[420px] space-y-2 overflow-y-auto">
            {messages.map((m) => (
              <div key={m.id} className={m.direction === "inbound" ? "" : "pl-8"}>
                <div className={`rounded-lg border px-3 py-2 text-[12px] ${m.direction === "inbound" ? "border-ink-700 bg-ink-850" : "border-brand-500/30 bg-brand-500/[0.06]"}`}>
                  <div className="mb-1 flex items-center gap-2">
                    <Badge tone={ACTOR_TONE[m.authorType]}>{m.authorType}</Badge>
                    {m.automated && <Badge tone="neutral">automated</Badge>}
                    <span className="tnum ml-auto text-[10px] text-mist-400">{new Date(m.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="leading-relaxed text-mist-200">{m.body}</p>
                </div>
              </div>
            ))}
            {!messages.length && <p className="text-[12px] text-mist-400">No messages yet.</p>}
          </div>
        </Card>

        <Card>
          <SectionTitle title="Activity timeline" hint="Every material event, newest first" />
          <div className="max-h-[420px] space-y-1.5 overflow-y-auto">
            {timeline.map((t) => (
              <div key={t.id} className="flex items-start gap-2 text-[11.5px]">
                <span className="tnum w-32 shrink-0 text-mist-400">{new Date(t.createdAt).toLocaleString()}</span>
                <Badge tone={ACTOR_TONE[t.actorType]}>{t.actorType}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="text-mist-200">{t.action.replace(/[._]/g, " ")}</span>
                  {t.actorId && <span className="text-mist-500"> · {name(t.actorId)}</span>}
                </span>
              </div>
            ))}
            {!timeline.length && <p className="text-[12px] text-mist-400">Nothing recorded yet.</p>}
          </div>
        </Card>
      </div>
    </div>
  );
}
