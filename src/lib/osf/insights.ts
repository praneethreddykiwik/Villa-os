import { complete, extractJson, hasLLM } from "../ai/provider";
import { db } from "./supabase";

/**
 * AI insights that can be checked.
 *
 * The rule layer is the source of truth: every insight is a pure function of
 * aggregates read out of Supabase, and the numbers that triggered it are stored
 * alongside it in `evidence` so a claim can be verified instead of believed.
 * The LLM layer is optional and deliberately powerless — it may only re-word and
 * prioritise numbers it was handed, and anything it returns carrying a number we
 * did not measure is thrown away (see `sanitiseAiInsights`).
 */

export type InsightSeverity = "info" | "warning" | "critical" | "success";

export interface Evidence {
  label: string;
  value: string | number;
  detail?: string;
}

export interface AiInsight {
  id: string;
  insight_type: string;
  severity: InsightSeverity;
  title: string;
  description: string;
  evidence: Evidence[];
  recommendation: string | null;
  expected_impact: string | null;
  action_label: string | null;
  action_href: string | null;
  category: string | null;
  is_dismissed: boolean;
  generated_by_ai: boolean;
  created_at: string;
}

export type DraftInsight = Omit<AiInsight, "id" | "is_dismissed" | "created_at">;

/**
 * Thresholds live in one place because they are the whole argument: an insight
 * is only as trustworthy as the line it had to cross. The minimums guard
 * against calling "1 of 2 objections" a 50% trend.
 */
export const THRESHOLDS = {
  staleLeadDays: 3,
  staleLeadsMin: 3,
  objectionSharePct: 30,
  objectionsMin: 5,
  unansweredQuestionsMin: 4,
  volumeChangePct: 30,
  prevWeekLeadsMin: 5,
  siteVisitCompletionPct: 50,
  siteVisitsMin: 5,
  sourceSharePct: 60,
  sourceLeadsMin: 10,
  /** A dismissal silences the same title for this long before it can return. */
  dismissalCooldownDays: 7,
} as const;

/** Pages an insight is allowed to link to. Also the whitelist for LLM output. */
const ALLOWED_HREFS = new Set([
  "/inbox/whatsapp",
  "/inbox/whatsapp/communication/whatsapp",
  "/inbox/whatsapp/sales/site-visits",
  "/inbox/whatsapp/crm/leads",
  "/inbox/whatsapp/crm/pipeline",
  "/inbox/whatsapp/crm/follow-ups",
  "/settings/villa/properties",
]);

// -----------------------------------------------------------------------------
// Signals
// -----------------------------------------------------------------------------

export interface ObjectionSignal {
  category: string;
  total: number;
  pct: number;
}

export interface TopicSignal {
  topic: string;
  count: number;
}

export interface SourceSignal {
  source: string;
  campaign: string | null;
  leads: number;
  hot: number;
  qualified: number;
}

export interface InsightSignals {
  computedAt: string;
  totalLeads: number | null;
  leadsLast7d: number | null;
  leadsPrev7d: number | null;
  hotLeads: number | null;
  hotUnassigned: number | null;
  staleLeads: number | null;
  objections: ObjectionSignal[];
  objectionsTotal: number;
  unansweredQuestions: number | null;
  unansweredTopics: TopicSignal[];
  sources: SourceSignal[];
  sourceLeadsTotal: number;
  siteVisitsRequested: number | null;
  siteVisitsCompleted: number | null;
  followUpsPending: number | null;
  followUpsOverdue: number | null;
  oldestOverdueFollowUpAt: string | null;
  handoffsPendingNotification: number | null;
  oldestPendingHandoffAt: string | null;
}

type CountResponse = { count: number | null; error: { message: string } | null };

/** A failed count (e.g. 0009 not applied yet) becomes null, and every rule that
 *  depends on it is skipped — a missing column must never become a claim. */
function toCount(res: CountResponse): number | null {
  return res.error ? null : (res.count ?? 0);
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function pctOf(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((100 * part) / whole * 10) / 10;
}

export async function computeSignals(): Promise<InsightSignals> {
  const supabase = db();
  const now = new Date().toISOString();
  const d7 = daysAgo(7);
  const d14 = daysAgo(14);
  const stale = daysAgo(THRESHOLDS.staleLeadDays);

  const [
    totalLeadsRes,
    last7Res,
    prev7Res,
    hotRes,
    hotUnassignedRes,
    staleRes,
    objectionsRes,
    questionsRes,
    sourcesRes,
    visitsRes,
    visitsDoneRes,
    followUpsPendingRes,
    followUpsOverdueRes,
    oldestOverdueRes,
    handoffsRes,
    oldestHandoffRes,
  ] = await Promise.all([
    supabase.from("villa_leads").select("id", { count: "exact", head: true }),
    supabase.from("villa_leads").select("id", { count: "exact", head: true }).gte("created_at", d7),
    supabase
      .from("villa_leads")
      .select("id", { count: "exact", head: true })
      .gte("created_at", d14)
      .lt("created_at", d7),
    supabase
      .from("villa_leads")
      .select("id", { count: "exact", head: true })
      .eq("lead_temperature", "hot"),
    supabase
      .from("villa_leads")
      .select("id", { count: "exact", head: true })
      .eq("lead_temperature", "hot")
      .is("assigned_to", null),
    supabase
      .from("villa_leads")
      .select("id", { count: "exact", head: true })
      .lt("last_contact_at", stale)
      .eq("opted_out", false)
      .not("pipeline_stage", "in", "(booked,lost)"),
    supabase.from("villa_objection_summary").select("*"),
    supabase.from("villa_questions").select("topic").eq("unanswered", true).limit(1000),
    supabase.from("villa_source_summary").select("*"),
    supabase.from("villa_site_visits").select("id", { count: "exact", head: true }),
    supabase
      .from("villa_site_visits")
      .select("id", { count: "exact", head: true })
      .eq("status", "completed"),
    supabase
      .from("villa_follow_ups")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("villa_follow_ups")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .lt("scheduled_at", now),
    supabase
      .from("villa_follow_ups")
      .select("scheduled_at")
      .eq("status", "pending")
      .lt("scheduled_at", now)
      .order("scheduled_at", { ascending: true })
      .limit(1),
    supabase
      .from("villa_handoffs")
      .select("id", { count: "exact", head: true })
      .eq("notified", false),
    supabase
      .from("villa_handoffs")
      .select("created_at")
      .eq("notified", false)
      .order("created_at", { ascending: true })
      .limit(1),
  ]);

  const objections = ((objectionsRes.data ?? []) as ObjectionSignal[])
    .map((o) => ({ category: o.category, total: Number(o.total), pct: Number(o.pct) }))
    .sort((a, b) => b.total - a.total);

  const topicCounts = new Map<string, number>();
  for (const row of (questionsRes.data ?? []) as Array<{ topic: string }>) {
    topicCounts.set(row.topic, (topicCounts.get(row.topic) ?? 0) + 1);
  }
  const unansweredTopics = [...topicCounts.entries()]
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count);

  const sources = ((sourcesRes.data ?? []) as SourceSignal[]).map((s) => ({
    source: s.source,
    campaign: s.campaign,
    leads: Number(s.leads),
    hot: Number(s.hot),
    qualified: Number(s.qualified),
  }));

  return {
    computedAt: now,
    totalLeads: toCount(totalLeadsRes),
    leadsLast7d: toCount(last7Res),
    leadsPrev7d: toCount(prev7Res),
    hotLeads: toCount(hotRes),
    hotUnassigned: toCount(hotUnassignedRes),
    staleLeads: toCount(staleRes),
    objections,
    objectionsTotal: objections.reduce((sum, o) => sum + o.total, 0),
    unansweredQuestions: questionsRes.error ? null : (questionsRes.data ?? []).length,
    unansweredTopics,
    sources,
    sourceLeadsTotal: sources.reduce((sum, s) => sum + s.leads, 0),
    siteVisitsRequested: toCount(visitsRes),
    siteVisitsCompleted: toCount(visitsDoneRes),
    followUpsPending: toCount(followUpsPendingRes),
    followUpsOverdue: toCount(followUpsOverdueRes),
    oldestOverdueFollowUpAt:
      (oldestOverdueRes.data as Array<{ scheduled_at: string }> | null)?.[0]?.scheduled_at ?? null,
    handoffsPendingNotification: toCount(handoffsRes),
    oldestPendingHandoffAt:
      (oldestHandoffRes.data as Array<{ created_at: string }> | null)?.[0]?.created_at ?? null,
  };
}

// -----------------------------------------------------------------------------
// Rule layer — no API key, always runs
// -----------------------------------------------------------------------------

export function ruleBasedInsights(s: InsightSignals): DraftInsight[] {
  const out: DraftInsight[] = [];

  // Nothing has happened yet. An empty board is honest; a vague insight is not.
  if (!s.totalLeads) return out;

  if (s.hotUnassigned && s.hotLeads) {
    out.push({
      insight_type: "risk",
      severity: "critical",
      title: "Hot leads have no owner",
      description: `${s.hotUnassigned} of ${s.hotLeads} hot leads are not assigned to any team member, so nobody is accountable for the next reply.`,
      evidence: [
        { label: "Unassigned hot leads", value: s.hotUnassigned },
        { label: "Hot leads total", value: s.hotLeads },
        { label: "Share of hot leads unowned", value: `${pctOf(s.hotUnassigned, s.hotLeads)}%` },
      ],
      recommendation: "Assign an owner to every hot lead before the next follow-up window.",
      expected_impact: `${s.hotUnassigned} high-intent conversation${s.hotUnassigned === 1 ? "" : "s"} get a named owner.`,
      action_label: "Open leads",
      action_href: "/inbox/whatsapp/crm/leads",
      category: "sales",
      generated_by_ai: false,
    });
  }

  if (s.followUpsOverdue && s.followUpsOverdue > 0) {
    const evidence: Evidence[] = [
      { label: "Overdue follow-ups", value: s.followUpsOverdue },
      { label: "Pending follow-ups total", value: s.followUpsPending ?? s.followUpsOverdue },
    ];
    if (s.oldestOverdueFollowUpAt) {
      evidence.push({
        label: "Oldest overdue since",
        value: new Date(s.oldestOverdueFollowUpAt).toLocaleString("en-IN"),
      });
    }
    out.push({
      insight_type: "risk",
      severity: "warning",
      title: "Follow-ups are overdue",
      description: `${s.followUpsOverdue} follow-up${s.followUpsOverdue === 1 ? " is" : "s are"} still pending past the time ${s.followUpsOverdue === 1 ? "it was" : "they were"} scheduled for.`,
      evidence,
      recommendation: "Work the overdue queue oldest-first, or reschedule what is no longer relevant.",
      expected_impact: "Promised replies land before the buyer moves on.",
      action_label: "Open follow-ups",
      action_href: "/inbox/whatsapp/crm/follow-ups",
      category: "sales",
      generated_by_ai: false,
    });
  }

  if (s.handoffsPendingNotification && s.handoffsPendingNotification > 0) {
    const evidence: Evidence[] = [
      { label: "Handoffs awaiting notification", value: s.handoffsPendingNotification },
    ];
    if (s.oldestPendingHandoffAt) {
      evidence.push({
        label: "Oldest raised at",
        value: new Date(s.oldestPendingHandoffAt).toLocaleString("en-IN"),
      });
    }
    out.push({
      insight_type: "risk",
      severity: "critical",
      title: "Handoff requests were never notified",
      description: `${s.handoffsPendingNotification} handoff${s.handoffsPendingNotification === 1 ? "" : "s"} raised by the agent ${s.handoffsPendingNotification === 1 ? "has" : "have"} not been sent to the sales team — a buyer asked for a human and nobody was told.`,
      evidence,
      recommendation:
        "Check that SALES_TEAM_WHATSAPP is set and the notification path is working, then contact these buyers directly.",
      expected_impact: "Buyers who explicitly asked for a person stop waiting.",
      action_label: "Open overview",
      action_href: "/inbox/whatsapp",
      category: "sales",
      generated_by_ai: false,
    });
  }

  if (s.staleLeads !== null && s.staleLeads >= THRESHOLDS.staleLeadsMin) {
    out.push({
      insight_type: "risk",
      severity: "warning",
      title: "Live leads are going cold",
      description: `${s.staleLeads} leads that are still in play have had no contact for more than ${THRESHOLDS.staleLeadDays} days.`,
      evidence: [
        { label: `No contact in over ${THRESHOLDS.staleLeadDays} days`, value: s.staleLeads },
        { label: "Leads total", value: s.totalLeads },
        { label: "Share of all leads", value: `${pctOf(s.staleLeads, s.totalLeads)}%` },
        {
          label: "Excluded from the count",
          value: "opted out, booked, lost",
          detail: "Only leads still worth contacting are counted.",
        },
      ],
      recommendation: "Schedule a follow-up for each, or move the dead ones to Lost so the pipeline is honest.",
      expected_impact: "The pipeline reflects real, worked opportunities.",
      action_label: "Open pipeline",
      action_href: "/inbox/whatsapp/crm/pipeline",
      category: "sales",
      generated_by_ai: false,
    });
  }

  const topObjection = s.objections[0];
  if (
    topObjection &&
    s.objectionsTotal >= THRESHOLDS.objectionsMin &&
    topObjection.pct >= THRESHOLDS.objectionSharePct
  ) {
    const label = topObjection.category.replace(/_/g, " ");
    out.push({
      insight_type: "recommendation",
      severity: "info",
      title: `Objections concentrate on ${label}`,
      description: `${topObjection.pct}% of all recorded objections are about ${label} (${topObjection.total} of ${s.objectionsTotal}).`,
      evidence: [
        { label: `Objections about ${label}`, value: topObjection.total },
        { label: "Objections recorded in total", value: s.objectionsTotal },
        { label: "Share", value: `${topObjection.pct}%` },
        ...s.objections.slice(1, 3).map((o) => ({
          label: `Next: ${o.category.replace(/_/g, " ")}`,
          value: `${o.total} (${o.pct}%)`,
        })),
      ],
      recommendation: `Answer the ${label} objection up front in ad creative and the first WhatsApp reply, instead of leaving it to the rep.`,
      expected_impact: "The most common blocker is handled before it stalls a conversation.",
      action_label: "Open leads",
      action_href: "/inbox/whatsapp/crm/leads",
      category: "marketing",
      generated_by_ai: false,
    });
  }

  if (s.unansweredQuestions !== null && s.unansweredQuestions >= THRESHOLDS.unansweredQuestionsMin) {
    out.push({
      insight_type: "knowledge_gap",
      severity: "warning",
      title: "The knowledge base has gaps",
      description: `${s.unansweredQuestions} buyer questions could not be answered from the knowledge base. The agent is designed to refuse rather than guess, so each one is a conversation that stalled.`,
      evidence: [
        { label: "Unanswered questions", value: s.unansweredQuestions },
        ...s.unansweredTopics.slice(0, 4).map((t) => ({
          label: `Topic: ${t.topic.replace(/_/g, " ")}`,
          value: t.count,
        })),
      ],
      recommendation: "Add the missing facts to the project record or FAQs so the agent can answer these itself.",
      expected_impact: "Fewer stalled conversations and fewer handoffs for questions the agent could answer.",
      action_label: "Open properties",
      action_href: "/settings/villa/properties",
      category: "knowledge",
      generated_by_ai: false,
    });
  }

  if (
    s.leadsLast7d !== null &&
    s.leadsPrev7d !== null &&
    s.leadsPrev7d >= THRESHOLDS.prevWeekLeadsMin
  ) {
    const change = Math.round(((s.leadsLast7d - s.leadsPrev7d) / s.leadsPrev7d) * 1000) / 10;
    const evidence: Evidence[] = [
      { label: "Leads in the last 7 days", value: s.leadsLast7d },
      { label: "Leads in the 7 days before that", value: s.leadsPrev7d },
      { label: "Change", value: `${change > 0 ? "+" : ""}${change}%` },
    ];

    if (change <= -THRESHOLDS.volumeChangePct) {
      out.push({
        insight_type: "trend",
        severity: "warning",
        title: "Lead volume is down week over week",
        description: `New leads fell from ${s.leadsPrev7d} to ${s.leadsLast7d} between the previous 7 days and the last 7 days, a ${Math.abs(change)}% drop.`,
        evidence,
        recommendation: "Check campaign delivery and spend for the same window before changing creative.",
        expected_impact: "A delivery problem is caught while it is still this week's problem.",
        action_label: "Open leads",
        action_href: "/inbox/whatsapp/crm/leads",
        category: "marketing",
        generated_by_ai: false,
      });
    } else if (change >= THRESHOLDS.volumeChangePct) {
      out.push({
        insight_type: "trend",
        severity: "success",
        title: "Lead volume is up week over week",
        description: `New leads rose from ${s.leadsPrev7d} to ${s.leadsLast7d} between the previous 7 days and the last 7 days, a ${change}% increase.`,
        evidence,
        recommendation: "Confirm response capacity covers the extra volume before it turns into slow first replies.",
        expected_impact: "The extra volume is worked rather than queued.",
        action_label: "Open leads",
        action_href: "/inbox/whatsapp/crm/leads",
        category: "marketing",
        generated_by_ai: false,
      });
    }
  }

  if (
    s.siteVisitsRequested !== null &&
    s.siteVisitsCompleted !== null &&
    s.siteVisitsRequested >= THRESHOLDS.siteVisitsMin
  ) {
    const rate = pctOf(s.siteVisitsCompleted, s.siteVisitsRequested);
    if (rate < THRESHOLDS.siteVisitCompletionPct) {
      out.push({
        insight_type: "risk",
        severity: "warning",
        title: "Site visits are not being completed",
        description: `${s.siteVisitsCompleted} of ${s.siteVisitsRequested} requested site visits are marked completed (${rate}%).`,
        evidence: [
          { label: "Site visits requested", value: s.siteVisitsRequested },
          { label: "Site visits completed", value: s.siteVisitsCompleted },
          { label: "Completion rate", value: `${rate}%` },
        ],
        recommendation:
          "Confirm each booked slot the day before, and update the visit status after it happens so this number stays true.",
        expected_impact: "The strongest buying signal in the funnel stops leaking.",
        action_label: "Open overview",
        action_href: "/inbox/whatsapp",
        category: "sales",
        generated_by_ai: false,
      });
    }
  }

  const topSource = [...s.sources].sort((a, b) => b.leads - a.leads)[0];
  if (
    topSource &&
    s.sourceLeadsTotal >= THRESHOLDS.sourceLeadsMin &&
    pctOf(topSource.leads, s.sourceLeadsTotal) >= THRESHOLDS.sourceSharePct
  ) {
    const share = pctOf(topSource.leads, s.sourceLeadsTotal);
    out.push({
      insight_type: "risk",
      severity: "info",
      title: `Lead flow depends on ${topSource.source}`,
      description: `${share}% of all leads come from ${topSource.source} (${topSource.leads} of ${s.sourceLeadsTotal}). A change on that one channel moves the whole pipeline.`,
      evidence: [
        { label: `Leads from ${topSource.source}`, value: topSource.leads },
        { label: "Leads across all sources", value: s.sourceLeadsTotal },
        { label: "Share", value: `${share}%` },
        { label: `Hot leads from ${topSource.source}`, value: topSource.hot },
      ],
      recommendation: "Give a second channel enough budget to prove itself before this one changes.",
      expected_impact: "Lead flow survives one channel having a bad month.",
      action_label: "Open leads",
      action_href: "/inbox/whatsapp/crm/leads",
      category: "marketing",
      generated_by_ai: false,
    });
  }

  return out;
}

// -----------------------------------------------------------------------------
// Optional LLM layer
// -----------------------------------------------------------------------------

/** Every number the model is allowed to repeat back. Anything else is invented. */
function allowedNumbers(s: InsightSignals): Set<number> {
  const nums: Array<number | null> = [
    s.totalLeads,
    s.leadsLast7d,
    s.leadsPrev7d,
    s.hotLeads,
    s.hotUnassigned,
    s.staleLeads,
    s.objectionsTotal,
    s.unansweredQuestions,
    s.sourceLeadsTotal,
    s.siteVisitsRequested,
    s.siteVisitsCompleted,
    s.followUpsPending,
    s.followUpsOverdue,
    s.handoffsPendingNotification,
    ...s.objections.flatMap((o) => [o.total, o.pct]),
    ...s.unansweredTopics.map((t) => t.count),
    ...s.sources.flatMap((x) => [x.leads, x.hot, x.qualified]),
  ];
  return new Set(nums.filter((n): n is number => typeof n === "number"));
}

interface RawAiInsight {
  title?: unknown;
  description?: unknown;
  recommendation?: unknown;
  expected_impact?: unknown;
  severity?: unknown;
  category?: unknown;
  action_href?: unknown;
  action_label?: unknown;
  evidence?: unknown;
}

const SEVERITIES = new Set<InsightSeverity>(["info", "warning", "critical", "success"]);

/**
 * Keeps only what the model was entitled to say. An insight is dropped when it
 * has no evidence, or when any evidence number is one we never measured — that
 * is the single check that stops a summariser from becoming a fabricator.
 */
function sanitiseAiInsights(raw: unknown, s: InsightSignals): DraftInsight[] {
  if (!Array.isArray(raw)) return [];
  const allowed = allowedNumbers(s);
  const out: DraftInsight[] = [];

  for (const item of raw.slice(0, 3) as RawAiInsight[]) {
    if (typeof item?.title !== "string" || typeof item?.description !== "string") continue;
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) continue;

    const evidence: Evidence[] = [];
    let poisoned = false;

    for (const e of item.evidence as Array<{ label?: unknown; value?: unknown }>) {
      if (typeof e?.label !== "string") continue;
      const value = e.value;
      if (typeof value === "number") {
        if (!allowed.has(value)) {
          poisoned = true;
          break;
        }
        evidence.push({ label: e.label, value });
      } else if (typeof value === "string") {
        const asNumber = Number(value.replace(/[%,\s]/g, ""));
        if (Number.isFinite(asNumber) && !allowed.has(asNumber)) {
          poisoned = true;
          break;
        }
        evidence.push({ label: e.label, value });
      }
    }

    if (poisoned || evidence.length === 0) continue;

    const severity =
      typeof item.severity === "string" && SEVERITIES.has(item.severity as InsightSeverity)
        ? (item.severity as InsightSeverity)
        : "info";
    const href =
      typeof item.action_href === "string" && ALLOWED_HREFS.has(item.action_href)
        ? item.action_href
        : null;

    out.push({
      insight_type: "recommendation",
      severity,
      title: item.title.slice(0, 120),
      description: item.description.slice(0, 600),
      evidence,
      recommendation: typeof item.recommendation === "string" ? item.recommendation.slice(0, 400) : null,
      expected_impact:
        typeof item.expected_impact === "string" ? item.expected_impact.slice(0, 300) : null,
      action_label: href ? (typeof item.action_label === "string" ? item.action_label : "Open") : null,
      action_href: href,
      category: typeof item.category === "string" ? item.category : "ai",
      generated_by_ai: true,
    });
  }

  return out;
}

async function aiInsights(s: InsightSignals, existingTitles: string[]): Promise<DraftInsight[]> {
  // Goes through the shared provider chain rather than talking to one vendor
  // directly. This file used to construct a Gemini client and pin
  // `gemini-2.5-flash`, which meant the enrichment was dark whenever Gemini was
  // the provider that was rate-limited or unkeyed — even with Groq configured
  // and answering for every other AI surface in the product. `complete()`
  // honours AI_PROVIDER/LLM_PROVIDER and falls through on failure, so insights
  // now use whichever provider the deployment is actually running on.
  if (!hasLLM()) return [];

  try {
    const prompt = `You are a sales operations analyst for a villa developer. Below are REAL aggregate numbers from the CRM database.

SIGNALS (the only facts you have):
${JSON.stringify(s, null, 2)}

Rule-based insights that already exist — do not repeat these:
${existingTitles.map((t) => `- ${t}`).join("\n") || "- (none)"}

Your job is to SUMMARISE AND PRIORITISE the signals above. Hard rules:
1. Never state a number that does not appear verbatim in SIGNALS. No estimates, no projections, no percentages you calculated yourself, no rupee figures.
2. Every insight must include an "evidence" array whose values are copied from SIGNALS.
3. If the signals do not support a specific, actionable point, return fewer insights — an empty array is a correct answer.
4. Do not invent facts about the property, pricing, or the market.
5. "action_href" must be one of: ${[...ALLOWED_HREFS].join(", ")}.

Return at most 3 insights, strictly as a JSON array (no markdown fences, no prose):
[{"title":"string","description":"string","recommendation":"string","expected_impact":"string","severity":"info|warning|critical|success","category":"sales|marketing|knowledge","action_label":"string","action_href":"string","evidence":[{"label":"string","value":"number or string copied from SIGNALS"}]}]`;

    const text = await complete({
      system:
        "You are a sales operations analyst. You summarise and prioritise numbers you are given. " +
        "You never invent a figure. You answer with JSON only.",
      prompt,
      json: true,
      // Three insights, each with a description, a recommendation and an
      // evidence array, is a large structured answer — and the reasoning models
      // on every provider spend hidden tokens before writing any of it, charged
      // against this same budget. The shared default of 1024 was enough for a
      // one-line caption but not for this, so the enrichment came back empty
      // and insights looked like it had no AI configured at all.
      maxTokens: 2500,
      // The enrichment sits behind a rule layer that has already produced the
      // page's content, so a slow model must not hold the request open.
      timeoutMs: 20_000,
      temperature: 0.3,
    });

    // extractJson tolerates the fences and preamble models add unbidden; a null
    // here means nothing parseable came back, which is a valid "no enrichment".
    const parsed = extractJson<unknown>(text);
    if (!parsed) return [];
    return sanitiseAiInsights(parsed, s);
  } catch (error) {
    console.error("[insights] LLM enrichment failed, keeping rule-based insights only", error);
    return [];
  }
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

export interface GenerateResult {
  ok: boolean;
  error?: string;
  inserted: number;
  updated: number;
  removed: number;
  suppressed: number;
  aiCount: number;
  signals?: InsightSignals;
}

function normaliseEvidence(raw: unknown): Evidence[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((e) => {
    if (!e || typeof e !== "object") return [];
    const row = e as { label?: unknown; value?: unknown; detail?: unknown };
    if (typeof row.label !== "string") return [];
    if (typeof row.value !== "string" && typeof row.value !== "number") return [];
    return [
      {
        label: row.label,
        value: row.value,
        ...(typeof row.detail === "string" ? { detail: row.detail } : {}),
      },
    ];
  });
}

function rowToInsight(row: Record<string, unknown>): AiInsight {
  return {
    id: String(row.id),
    insight_type: String(row.insight_type ?? "recommendation"),
    severity: SEVERITIES.has(row.severity as InsightSeverity)
      ? (row.severity as InsightSeverity)
      : "info",
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    evidence: normaliseEvidence(row.evidence),
    recommendation: (row.recommendation as string | null) ?? null,
    expected_impact: (row.expected_impact as string | null) ?? null,
    action_label: (row.action_label as string | null) ?? null,
    action_href: (row.action_href as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    is_dismissed: Boolean(row.is_dismissed),
    generated_by_ai: Boolean(row.generated_by_ai),
    created_at: String(row.created_at ?? ""),
  };
}

/**
 * Recomputes every insight from current data.
 *
 * Titles are the dedupe key and are deliberately number-free, so a repeat run
 * refreshes the row it already wrote instead of stacking near-identical copies.
 * Rows whose condition no longer holds are deleted rather than left behind —
 * an insight that is no longer true is worse than no insight. Dismissed rows
 * are never touched, and a dismissal suppresses its title for
 * THRESHOLDS.dismissalCooldownDays so "dismiss" means something.
 */
export async function generateInsights(): Promise<GenerateResult> {
  const empty = { inserted: 0, updated: 0, removed: 0, suppressed: 0, aiCount: 0 };

  let signals: InsightSignals;
  try {
    signals = await computeSignals();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), ...empty };
  }

  const supabase = db();
  const rules = ruleBasedInsights(signals);
  const ai = await aiInsights(signals, rules.map((r) => r.title));
  const aiDeduped = ai.filter((a) => !rules.some((r) => r.title === a.title));
  const drafts = [...rules, ...aiDeduped];

  const { data: existingRows, error: readError } = await supabase
    .from("villa_ai_insights")
    .select("id, title, is_dismissed, created_at, generated_by_ai");

  if (readError) {
    return { ok: false, error: readError.message, ...empty, signals };
  }

  const existing = (existingRows ?? []) as Array<{
    id: string;
    title: string;
    is_dismissed: boolean;
    created_at: string;
    generated_by_ai: boolean;
  }>;

  const cooldownStart = Date.now() - THRESHOLDS.dismissalCooldownDays * 86_400_000;
  const suppressedTitles = new Set(
    existing
      .filter((r) => r.is_dismissed && new Date(r.created_at).getTime() >= cooldownStart)
      .map((r) => r.title),
  );
  const liveByTitle = new Map(existing.filter((r) => !r.is_dismissed).map((r) => [r.title, r]));

  let inserted = 0;
  let updated = 0;
  let suppressed = 0;
  const keptTitles = new Set<string>();

  for (const draft of drafts) {
    if (suppressedTitles.has(draft.title)) {
      suppressed++;
      continue;
    }
    keptTitles.add(draft.title);

    const payload = {
      insight_type: draft.insight_type,
      severity: draft.severity,
      title: draft.title,
      description: draft.description,
      evidence: draft.evidence,
      recommendation: draft.recommendation,
      expected_impact: draft.expected_impact,
      action_label: draft.action_label,
      action_href: draft.action_href,
      category: draft.category,
      generated_by_ai: draft.generated_by_ai,
    };

    const match = liveByTitle.get(draft.title);
    if (match) {
      const { error } = await supabase.from("villa_ai_insights").update(payload).eq("id", match.id);
      if (error) return { ok: false, error: error.message, inserted, updated, removed: 0, suppressed, aiCount: aiDeduped.length, signals };
      updated++;
    } else {
      const { error } = await supabase.from("villa_ai_insights").insert(payload);
      if (error) return { ok: false, error: error.message, inserted, updated, removed: 0, suppressed, aiCount: aiDeduped.length, signals };
      inserted++;
    }
  }

  const staleIds = existing
    .filter((r) => !r.is_dismissed && !keptTitles.has(r.title))
    .map((r) => r.id);

  if (staleIds.length > 0) {
    await supabase.from("villa_ai_insights").delete().in("id", staleIds);
  }

  return {
    ok: true,
    inserted,
    updated,
    removed: staleIds.length,
    suppressed,
    aiCount: aiDeduped.length,
    signals,
  };
}

const SEVERITY_RANK: Record<InsightSeverity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
  success: 3,
};

export async function listInsights(): Promise<AiInsight[]> {
  const { data } = await db()
    .from("villa_ai_insights")
    .select("*")
    .eq("is_dismissed", false)
    .order("created_at", { ascending: false })
    .limit(100);

  return ((data ?? []) as Array<Record<string, unknown>>)
    .map(rowToInsight)
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

export async function dismissInsight(id: string): Promise<{ ok: boolean; error?: string }> {
  const { error } = await db().from("villa_ai_insights").update({ is_dismissed: true }).eq("id", id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export const SEVERITY_ORDER: InsightSeverity[] = ["critical", "warning", "info", "success"];

export const SEVERITY_LABELS: Record<InsightSeverity, string> = {
  critical: "Needs attention now",
  warning: "Worth fixing this week",
  info: "Recommendations",
  success: "Going well",
};
