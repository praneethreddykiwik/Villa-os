import { mutate, read } from "../db";
import type { WorkflowConfig } from "./types";

/**
 * CONFIGURATION ENGINE
 *
 * Every business rule in the workflow — scoring weights, follow-up cadences,
 * assignment strategy, quiet hours, SLA targets, escalation conditions,
 * checklist presets — is data, not code. Changing how an organisation qualifies
 * a lead or chases a document must not require a deploy.
 *
 * The defaults below are a *starting configuration*, not hardcoded behaviour:
 * every engine reads the stored config and falls back to these only when an org
 * has never saved one.
 */

export function defaultConfig(orgId: string): WorkflowConfig {
  return {
    orgId,
    scoring: {
      // Weights are additive and auditable — every point is traceable to a signal.
      rules: [
        { id: "asked_pricing", signal: "asked_pricing", label: "Asked about pricing", points: 10, enabled: true },
        { id: "asked_availability", signal: "asked_availability", label: "Asked about availability", points: 8, enabled: true },
        { id: "requested_visit", signal: "requested_visit", label: "Requested a site visit", points: 18, enabled: true },
        { id: "asked_financing", signal: "asked_financing", label: "Asked financing questions", points: 12, enabled: true },
        { id: "provided_budget", signal: "provided_budget", label: "Provided a budget", points: 14, enabled: true },
        { id: "provided_details", signal: "provided_details", label: "Provided personal details", points: 8, enabled: true },
        { id: "requested_human", signal: "requested_human", label: "Requested human contact", points: 20, enabled: true },
        { id: "fast_response", signal: "fast_response", label: "Responds quickly", points: 6, enabled: true },
        { id: "repeat_engagement", signal: "repeat_engagement", label: "Repeated engagement", points: 10, enabled: true },
        { id: "documents_ready", signal: "documents_ready", label: "Documents being submitted", points: 12, enabled: true },
        { id: "near_term_timeline", signal: "near_term_timeline", label: "Near-term purchase timeline", points: 12, enabled: true },
        { id: "positive_sentiment", signal: "positive_sentiment", label: "Positive sentiment", points: 8, enabled: true },
        { id: "negative_sentiment", signal: "negative_sentiment", label: "Negative sentiment", points: -12, enabled: true },
        { id: "not_interested", signal: "not_interested", label: "Stated not interested", points: -30, enabled: true },
        { id: "stale", signal: "stale", label: "No contact in 7+ days", points: -10, enabled: true },
      ],
      bands: { cold: 30, warm: 60, hot: 80 },
    },

    salesTriggers: [
      { id: "high_intent", label: "High-intent lead", condition: "intent in HIGH_INTENT,READY_TO_PROCEED", priority: "HIGH", enabled: true },
      { id: "requested_human", label: "Customer asked for a call", condition: "requestedHuman == true", priority: "URGENT", enabled: true },
      { id: "score_threshold", label: "Lead score crossed hot threshold", condition: "score >= 80", priority: "HIGH", enabled: true },
      { id: "negative_sentiment", label: "Negative sentiment needs intervention", condition: "sentiment in NEGATIVE,VERY_NEGATIVE", priority: "URGENT", enabled: true },
      { id: "ai_uncertain", label: "AI could not answer confidently", condition: "aiUncertain == true", priority: "NORMAL", enabled: true },
      { id: "financing_concern", label: "Financing concern raised", condition: "intent == FINANCING_CONCERN", priority: "HIGH", enabled: true },
    ],

    followUps: [
      {
        id: "document_collection",
        kind: "DOCUMENT_REQUEST",
        // Day 0 request, +1 gentle, +3 firmer, +5 escalate. Deliberately short —
        // a stalled application costs more than a slightly persistent reminder.
        steps: [
          { afterDays: 0, template: "document_request" },
          { afterDays: 1, template: "document_reminder_1" },
          { afterDays: 3, template: "document_reminder_2" },
          { afterDays: 5, template: "document_final" },
        ],
        maxAttempts: 4,
        cooldownHours: 20,
        escalateAfterAttempts: 4,
      },
      {
        id: "document_rejected",
        kind: "DOCUMENT_REJECTED",
        steps: [
          { afterDays: 0, template: "document_rejected" },
          { afterDays: 2, template: "document_reminder_1" },
          { afterDays: 4, template: "document_final" },
        ],
        maxAttempts: 3,
        cooldownHours: 20,
        escalateAfterAttempts: 3,
      },
      {
        id: "promised_action",
        kind: "PROMISED_ACTION",
        // The customer said they would send something. One nudge after the
        // promised time, then it becomes a human's problem, not a robot's.
        steps: [
          { afterDays: 1, template: "promised_followup" },
          { afterDays: 3, template: "document_reminder_2" },
        ],
        maxAttempts: 2,
        cooldownHours: 20,
        escalateAfterAttempts: 2,
      },
      {
        id: "no_response",
        kind: "NO_RESPONSE",
        steps: [
          { afterDays: 2, template: "checking_in" },
          { afterDays: 5, template: "checking_in_final" },
        ],
        maxAttempts: 2,
        cooldownHours: 48,
        escalateAfterAttempts: 2,
      },
    ],

    escalations: [
      { id: "customer_frustrated", label: "Customer frustrated", condition: "sentiment in NEGATIVE,VERY_NEGATIVE", severity: "HIGH", lane: "SALES", enabled: true },
      { id: "requested_human", label: "Customer requested a human", condition: "requestedHuman == true", severity: "HIGH", lane: "SALES", enabled: true },
      { id: "ai_low_confidence", label: "AI not confident", condition: "aiConfidence < 0.5", severity: "MEDIUM", lane: "SALES", enabled: true },
      { id: "document_disputed", label: "Customer disputes a requirement", condition: "disputesRequirement == true", severity: "MEDIUM", lane: "LOAN", enabled: true },
      { id: "document_unavailable", label: "Customer says they cannot provide a document", condition: "cannotProvide == true", severity: "MEDIUM", lane: "LOAN", enabled: true },
      { id: "approval_question", label: "Customer asked about approval odds", condition: "asksApproval == true", severity: "HIGH", lane: "LOAN", enabled: true },
      { id: "repeated_failure", label: "Repeated document submission failures", condition: "rejections >= 2", severity: "HIGH", lane: "LOAN", enabled: true },
      { id: "followups_exhausted", label: "Follow-up attempts exhausted", condition: "attempts >= maxAttempts", severity: "MEDIUM", lane: "LOAN", enabled: true },
      { id: "price_negotiation", label: "Customer wants to negotiate price", condition: "negotiatesPrice == true", severity: "HIGH", lane: "SALES", enabled: true },
      { id: "legal_question", label: "Customer asked about legal terms", condition: "asksLegal == true", severity: "MEDIUM", lane: "SALES", enabled: true },
      { id: "ai_unknown", label: "Assistant could not understand twice in a row", condition: "unknownStreak >= 2", severity: "MEDIUM", lane: "SALES", enabled: true },
      { id: "window_closed", label: "Reply blocked by the 24h WhatsApp window", condition: "requiresTemplate == true", severity: "MEDIUM", lane: "SALES", enabled: true },
    ],

    assignment: { sales: "LEAST_LOADED", loan: "LEAST_LOADED" },

    messaging: {
      // 21:00–09:00 local. Financial-document chasing at 2am destroys trust.
      quietHoursStart: 21,
      quietHoursEnd: 9,
      timezone: "Asia/Kolkata",
      maxAutomatedPerDay: 2,
    },

    sla: { firstResponseMinutes: 30, salesCallHours: 24, documentReviewHours: 24 },

    checklistTemplates: [
      {
        id: "standard_home_loan",
        name: "Standard home loan",
        items: [
          { documentType: "identity", customerLabel: "Photo ID", description: "Government-issued photo identity document", required: true, acceptedFormats: ["pdf", "jpg", "png"] },
          { documentType: "address_proof", customerLabel: "Address proof", description: "A recent utility bill or equivalent showing your address", required: true, acceptedFormats: ["pdf", "jpg", "png"] },
          { documentType: "income_proof", customerLabel: "Income proof", description: "Recent salary slips or income statement", required: true, acceptedFormats: ["pdf", "jpg", "png"] },
          { documentType: "bank_statements", customerLabel: "Bank statements", description: "Last 6 months of bank statements", required: true, acceptedFormats: ["pdf"] },
          { documentType: "employment_proof", customerLabel: "Employment proof", description: "Employment letter or contract", required: true, acceptedFormats: ["pdf", "jpg", "png"] },
          { documentType: "tax_documents", customerLabel: "Tax documents", description: "Latest tax return or assessment", required: true, acceptedFormats: ["pdf"] },
          { documentType: "property_documents", customerLabel: "Property documents", description: "Agreement or allotment letter for the property", required: false, acceptedFormats: ["pdf"] },
        ],
      },
      {
        id: "self_employed",
        name: "Self-employed",
        items: [
          { documentType: "identity", customerLabel: "Photo ID", description: "Government-issued photo identity document", required: true, acceptedFormats: ["pdf", "jpg", "png"] },
          { documentType: "address_proof", customerLabel: "Address proof", description: "A recent utility bill or equivalent", required: true, acceptedFormats: ["pdf", "jpg", "png"] },
          { documentType: "business_proof", customerLabel: "Business registration", description: "Business registration or incorporation certificate", required: true, acceptedFormats: ["pdf"] },
          { documentType: "tax_documents", customerLabel: "Tax returns", description: "Last 2 years of tax returns", required: true, acceptedFormats: ["pdf"] },
          { documentType: "bank_statements", customerLabel: "Bank statements", description: "Last 12 months, business and personal", required: true, acceptedFormats: ["pdf"] },
          { documentType: "audited_financials", customerLabel: "Financial statements", description: "Audited financials where available", required: false, acceptedFormats: ["pdf"] },
        ],
      },
    ],

    updatedAt: new Date().toISOString(),
  };
}

/** Read the org's config, creating the default on first access. */
export function getConfig(orgId: string): WorkflowConfig {
  const existing = read().workflowConfigs.find((c) => c.orgId === orgId);
  if (existing) return existing;
  const created = defaultConfig(orgId);
  mutate((db) => void db.workflowConfigs.push(created));
  return created;
}

/** Shallow-merge a partial update. Section objects are replaced wholesale. */
export function updateConfig(orgId: string, patch: Partial<WorkflowConfig>): WorkflowConfig {
  return mutate((db) => {
    const i = db.workflowConfigs.findIndex((c) => c.orgId === orgId);
    const base = i >= 0 ? db.workflowConfigs[i] : defaultConfig(orgId);
    const next: WorkflowConfig = { ...base, ...patch, orgId, updatedAt: new Date().toISOString() };
    if (i >= 0) db.workflowConfigs[i] = next;
    else db.workflowConfigs.push(next);
    return next;
  });
}
