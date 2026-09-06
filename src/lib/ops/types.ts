/**
 * OPERATIONS DOMAIN — customer lifecycle, sales handoff, loan processing.
 *
 * Extends the existing CRM rather than replacing it. Relationships:
 *
 *   Customer (canonical profile, one per phone number)
 *     ├── Lead            (existing crm/types.ts — now carries customerId)
 *     ├── CrmContact      (existing — now carries customerId)
 *     ├── OpsMessage[]    (WhatsApp thread, both directions)
 *     ├── SentimentEvent[]
 *     ├── ScoreEvent[]
 *     ├── SalesTask[]
 *     ├── LoanCase        (0..1 active)
 *     │     └── ChecklistItem[] ── DocumentRecord[] ── DocumentEvent[]
 *     ├── FollowUp[]
 *     └── AuditEvent[]
 *
 * Workflow state lives in relational fields with explicit enums, never inside
 * JSON blobs — JSON is reserved for genuinely open-ended metadata. That is what
 * makes the state machine queryable and the audit trail trustworthy.
 */

/* -------------------------------------------------------------------------- */
/* Controlled vocabularies                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Sentiment is a closed enum, not free-form model output. An LLM asked for "a
 * sentiment label" returns a different string every time, which makes trends,
 * filters and thresholds impossible to compute.
 */
export const SENTIMENTS = [
  "VERY_POSITIVE",
  "POSITIVE",
  "NEUTRAL",
  "UNCERTAIN",
  "NEGATIVE",
  "VERY_NEGATIVE",
] as const;
export type Sentiment = (typeof SENTIMENTS)[number];

export const INTENTS = [
  "INFORMATIONAL",
  "EXPLORING",
  "INTERESTED",
  "HIGH_INTENT",
  "READY_TO_PROCEED",
  "PRICE_CONCERN",
  "FINANCING_CONCERN",
  "DOCUMENT_DELAY",
  "HUMAN_HELP_REQUIRED",
  "NOT_INTERESTED",
] as const;
export type Intent = (typeof INTENTS)[number];

export const URGENCY = ["NONE", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type Urgency = (typeof URGENCY)[number];

export const ENGAGEMENT = ["NONE", "LOW", "MODERATE", "HIGH"] as const;
export type Engagement = (typeof ENGAGEMENT)[number];

export const BUYING_READINESS = [
  "UNKNOWN",
  "RESEARCHING",
  "COMPARING",
  "DECIDING",
  "READY",
  "STALLED",
] as const;
export type BuyingReadiness = (typeof BUYING_READINESS)[number];

/** Ordinal value used for trend maths. Never persisted — derived on demand. */
export const SENTIMENT_VALUE: Record<Sentiment, number> = {
  VERY_NEGATIVE: -2,
  NEGATIVE: -1,
  UNCERTAIN: -0.5,
  NEUTRAL: 0,
  POSITIVE: 1,
  VERY_POSITIVE: 2,
};

export type SentimentTrend = "IMPROVING" | "STABLE" | "DECLINING" | "UNKNOWN";

export const LEAD_STAGES = [
  "NEW",
  "QUALIFYING",
  "QUALIFIED",
  "SALES_CALL",
  "FINANCING_REQUIRED",
  "LOAN_CASE",
  "DOCUMENT_COLLECTION",
  "DOCUMENT_REVIEW",
  "READY_FOR_ANALYSIS",
  "DECISION",
  "COMPLETED",
  "LOST",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export type LoanRequired = "YES" | "NO" | "UNKNOWN";

/* -------------------------------------------------------------------------- */
/* Identity & access                                                           */
/* -------------------------------------------------------------------------- */

export const ROLES = ["ADMIN", "SALES_MANAGER", "LOAN_OFFICER"] as const;
export type Role = (typeof ROLES)[number];

export interface TeamMember {
  id: string;
  orgId: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  /** Caps used by the LEAST_LOADED assignment strategy. */
  capacity: number;
  /**
   * scrypt hash. Absent until the member claims their account — which is how a
   * seeded team can exist without anybody shipping default passwords.
   */
  passwordHash?: string;
  passwordSetAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  disabledAt?: string;
}

/**
 * Permissions are coarse capabilities, checked server-side on every ops route.
 * Sales deliberately cannot read loan documents: those are financial records
 * belonging to a different department, and "everyone can see everything" is not
 * an acceptable default for a system holding PAN cards and bank statements.
 */
export const PERMISSIONS = [
  "customer:read",
  "customer:write",
  "sales:read",
  "sales:write",
  "loan:read",
  "loan:write",
  "document:read",
  // `document:download` was removed rather than left listed: it translated to
  // the same database permission as `document:read`, so every check on it
  // passed automatically. A capability name that cannot deny anything invites
  // the next handler to "gate" on it too.
  "document:review",
  "admin:read",
  "admin:write",
  "config:write",
  "audit:read",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/* -------------------------------------------------------------------------- */
/* Customer — the single source of truth                                       */
/* -------------------------------------------------------------------------- */

export interface Customer {
  id: string;
  orgId: string;
  name: string;
  /** E.164. Unique per org — this is the natural key for WhatsApp identity. */
  phone: string;
  email?: string;
  source: string;
  leadStatus: string;
  leadStage: LeadStage;
  assignedSalesManagerId?: string;
  assignedLoanOfficerId?: string;
  loanRequired: LoanRequired;
  intent: Intent;
  sentiment: Sentiment;
  sentimentConfidence: number;
  leadScore: number;
  lastInteractionAt?: string;
  nextFollowUpAt?: string;
  preferredChannel: "whatsapp" | "phone" | "email";
  /** Free-form but structured facts the AI extracted, e.g. { familySize: "4" }. */
  preferences: Record<string, string>;
  budgetMin?: number;
  budgetMax?: number;
  purchaseInfo?: string;
  financingInfo?: string;
  notes: string;
  tags: string[];
  /** Independent control lanes — sales AI and loan AI pause separately. */
  salesControl: ControlState;
  loanControl: ControlState;
  /** Customer asked to stop being messaged. Hard stop for all automation. */
  optedOut: boolean;
  createdAt: string;
  updatedAt: string;
  /** Links to the pre-existing CRM records, so nothing is duplicated. */
  leadId?: string;
  contactId?: string;
}

export type ControlState = "AI_ACTIVE" | "HUMAN_CONTROL";

/* -------------------------------------------------------------------------- */
/* Conversation intelligence                                                   */
/* -------------------------------------------------------------------------- */

/** Raw message. Preserved verbatim — the structured extraction sits alongside. */
export interface OpsMessage {
  id: string;
  orgId: string;
  customerId: string;
  /** "voice" = a transcript recorded by the AI voice agent. */
  channel: "whatsapp" | "phone" | "email" | "system" | "voice";
  direction: "inbound" | "outbound";
  body: string;
  /** Set when the message carried a document. */
  documentId?: string;
  /** Which actor produced an outbound message. */
  authorType: "customer" | "ai" | "human" | "system";
  authorId?: string;
  /** Platform message id — the idempotency key for webhook replays. */
  externalId?: string;
  /**
   * True only for proactive automation (follow-ups, reminders). Replies to an
   * inbound message are not automation for rate-limiting purposes — counting
   * them would let a conversation block the reminders that conversation is about.
   */
  automated?: boolean;
  /**
   * Which composition path produced an outbound reply ("clarify", "visit_slots",
   * "media"…). Lets the agent read its own recent behaviour — e.g. count
   * consecutive clarifications — without re-parsing prose.
   */
  tag?: string;
  /** Small structured payload attached to the message, e.g. the slots offered. */
  meta?: Record<string, string>;
  createdAt: string;
}

export interface SentimentEvent {
  id: string;
  orgId: string;
  customerId: string;
  sentiment: Sentiment;
  confidence: number;
  intent: Intent;
  urgency: Urgency;
  engagement: Engagement;
  buyingReadiness: BuyingReadiness;
  objections: string[];
  concerns: string[];
  positiveSignals: string[];
  negativeSignals: string[];
  /** Which message(s) produced this reading. */
  sourceMessageId?: string;
  reason: string;
  createdAt: string;
}

/** Structured output of a conversation, stored next to the raw messages. */
export interface ConversationInsight {
  id: string;
  orgId: string;
  customerId: string;
  intent: Intent;
  sentiment: Sentiment;
  buyingSignals: string[];
  objections: string[];
  questions: string[];
  financingInterest: boolean;
  requestedHuman: boolean;
  requiredFollowUp?: string;
  /** Durable facts worth putting on the profile, e.g. "budget 5-7 Cr". */
  facts: Record<string, string>;
  summary: string;
  /** True when produced by the deterministic extractor rather than an LLM. */
  deterministic: boolean;
  createdAt: string;
}

export interface ScoreEvent {
  id: string;
  orgId: string;
  customerId: string;
  score: number;
  previousScore: number;
  band: "COLD" | "WARM" | "HOT" | "VERY_HOT";
  /** Every signal that contributed, with its weight — the score is auditable. */
  contributions: Array<{ signal: string; points: number; reason: string }>;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Sales                                                                       */
/* -------------------------------------------------------------------------- */

export type SalesTaskStatus = "OPEN" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface SalesTask {
  id: string;
  orgId: string;
  customerId: string;
  assignedToId?: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  reason: string;
  /** Which trigger rule fired, for auditability and tuning. */
  triggerId: string;
  aiSummary: string;
  sentiment: Sentiment;
  leadScore: number;
  objections: string[];
  requirements: string[];
  conversationSummary: string;
  status: SalesTaskStatus;
  dueAt: string;
  createdAt: string;
  completedAt?: string;
  notes: string[];
}

export interface Assignment {
  id: string;
  orgId: string;
  customerId: string;
  queue: "SALES" | "LOAN";
  assigneeId?: string;
  previousAssigneeId?: string;
  strategy: AssignmentStrategy;
  reason: string;
  actorId?: string;
  createdAt: string;
}

export const ASSIGNMENT_STRATEGIES = ["ROUND_ROBIN", "LEAST_LOADED", "MANUAL", "TEAM_QUEUE"] as const;
export type AssignmentStrategy = (typeof ASSIGNMENT_STRATEGIES)[number];

/* -------------------------------------------------------------------------- */
/* Loan                                                                        */
/* -------------------------------------------------------------------------- */

export const LOAN_STATUSES = [
  "NOT_STARTED",
  "INFORMATION_REQUIRED",
  "DOCUMENT_COLLECTION",
  "UNDER_REVIEW",
  "DOCUMENTS_INCOMPLETE",
  "READY_FOR_ANALYSIS",
  "APPROVED",
  "CONDITIONALLY_APPROVED",
  "REJECTED",
  "COMPLETED",
  "ON_HOLD",
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

export interface LoanCase {
  id: string;
  orgId: string;
  customerId: string;
  assignedOfficerId?: string;
  status: LoanStatus;
  loanType: string;
  requestedAmount?: number;
  customerIncome?: number;
  employmentInfo?: string;
  financialInfo?: string;
  propertyInfo?: string;
  officerNotes: string[];
  /** Set when required-document completion first reaches 100%. */
  readyForReviewAt?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
}

export const CHECKLIST_ITEM_STATUSES = [
  "NOT_REQUESTED",
  "REQUESTED",
  "UPLOADED",
  "UNDER_REVIEW",
  "ACCEPTED",
  "REJECTED",
  "NOT_REQUIRED",
] as const;
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

export interface ChecklistItem {
  id: string;
  orgId: string;
  loanCaseId: string;
  documentType: string;
  /** What the customer sees on WhatsApp — never the internal type code. */
  customerLabel: string;
  description: string;
  required: boolean;
  status: ChecklistItemStatus;
  acceptedFormats: string[];
  currentDocumentId?: string;
  rejectionReason?: string;
  dueAt?: string;
  notes?: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRecord {
  id: string;
  orgId: string;
  customerId: string;
  loanCaseId?: string;
  checklistItemId?: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Opaque key into the DocumentStore. Never a public URL. */
  storageKey: string;
  /** Content hash — deduplicates webhook replays of the same media. */
  sha256: string;
  uploadedBy: "customer" | "human" | "system";
  uploadedById?: string;
  status: "RECEIVED" | "UNDER_REVIEW" | "ACCEPTED" | "REJECTED";
  reviewedById?: string;
  reviewedAt?: string;
  rejectionReason?: string;
  createdAt: string;
}

export interface DocumentEvent {
  id: string;
  orgId: string;
  documentId: string;
  event: "RECEIVED" | "LINKED" | "REVIEW_STARTED" | "ACCEPTED" | "REJECTED" | "REPLACED" | "DOWNLOADED";
  actorId?: string;
  actorType: "customer" | "human" | "ai" | "system";
  detail?: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Follow-ups & escalation                                                     */
/* -------------------------------------------------------------------------- */

export type FollowUpKind =
  | "DOCUMENT_REQUEST"
  | "DOCUMENT_REMINDER"
  | "DOCUMENT_REJECTED"
  | "PROMISED_ACTION"
  | "SALES_NUDGE"
  | "NO_RESPONSE"
  | "OFFICER_REQUEST"
  /** A reply the 24h window blocked; carries `message` and retries when the window reopens. */
  | "TEMPLATE_REQUIRED";

export interface FollowUp {
  id: string;
  orgId: string;
  customerId: string;
  loanCaseId?: string;
  checklistItemId?: string;
  kind: FollowUpKind;
  lane: "SALES" | "LOAN";
  /** When the next attempt may be sent. Quiet hours shift this forward. */
  scheduledAt: string;
  attempts: number;
  maxAttempts: number;
  status: "SCHEDULED" | "SENT" | "COMPLETED" | "CANCELLED" | "ESCALATED" | "PAUSED";
  lastSentAt?: string;
  message?: string;
  /** Why this exists — shown in the UI so reminders are never mysterious. */
  reason: string;
  cancelledReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Escalation {
  id: string;
  orgId: string;
  customerId: string;
  ruleId: string;
  lane: "SALES" | "LOAN";
  severity: "LOW" | "MEDIUM" | "HIGH";
  reason: string;
  detail: string;
  assignedToId?: string;
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  createdAt: string;
  resolvedAt?: string;
  resolvedById?: string;
}

/* -------------------------------------------------------------------------- */
/* Notifications & audit                                                       */
/* -------------------------------------------------------------------------- */

export interface OpsNotification {
  id: string;
  orgId: string;
  /** Null = broadcast to every member holding the required role. */
  recipientId?: string;
  recipientRole?: Role;
  category: "SALES" | "LOAN" | "ADMIN";
  event: string;
  title: string;
  body: string;
  customerId?: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  read: boolean;
  createdAt: string;
  readAt?: string;
}

/** Append-only. Nothing in the app ever updates or deletes an audit row. */
export interface AuditEvent {
  id: string;
  orgId: string;
  actorId?: string;
  actorType: "ai" | "human" | "customer" | "system";
  action: string;
  entity: string;
  entityId: string;
  customerId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                               */
/* -------------------------------------------------------------------------- */

export interface ScoringRule {
  id: string;
  signal: string;
  label: string;
  points: number;
  enabled: boolean;
}

export interface FollowUpStep {
  /** Days after the previous step (step 0 is days after creation). */
  afterDays: number;
  template: string;
}

export interface FollowUpSchedule {
  id: string;
  kind: FollowUpKind;
  steps: FollowUpStep[];
  maxAttempts: number;
  /** Minimum hours between two messages to the same customer, any follow-up. */
  cooldownHours: number;
  escalateAfterAttempts: number;
}

export interface EscalationRule {
  id: string;
  label: string;
  condition: string;
  severity: "LOW" | "MEDIUM" | "HIGH";
  lane: "SALES" | "LOAN";
  enabled: boolean;
}

export interface SalesTriggerRule {
  id: string;
  label: string;
  condition: string;
  priority: SalesTask["priority"];
  enabled: boolean;
}

export interface WorkflowConfig {
  orgId: string;
  scoring: {
    rules: ScoringRule[];
    bands: { cold: number; warm: number; hot: number };
  };
  salesTriggers: SalesTriggerRule[];
  followUps: FollowUpSchedule[];
  escalations: EscalationRule[];
  assignment: {
    sales: AssignmentStrategy;
    loan: AssignmentStrategy;
  };
  messaging: {
    /** Local hours during which automation may send. Outside → deferred. */
    quietHoursStart: number;
    quietHoursEnd: number;
    timezone: string;
    maxAutomatedPerDay: number;
  };
  sla: {
    firstResponseMinutes: number;
    salesCallHours: number;
    documentReviewHours: number;
  };
  /** Checklist presets a loan officer can apply — never used by the AI directly. */
  checklistTemplates: Array<{
    id: string;
    name: string;
    items: Array<Pick<ChecklistItem, "documentType" | "customerLabel" | "description" | "required" | "acceptedFormats">>;
  }>;
  updatedAt: string;
}

/**
 * Rules for the FUTURE loan-analysis module. Stored and editable now so the
 * data model does not need to change when that module is built; nothing reads
 * these yet beyond the admin UI.
 */
export interface LoanRule {
  id: string;
  orgId: string;
  label: string;
  kind: "MIN_INCOME" | "MAX_LOAN_AMOUNT" | "MIN_EMPLOYMENT_MONTHS" | "MAX_DTI" | "REQUIRED_DOCUMENT" | "PROPERTY_RESTRICTION" | "CUSTOM";
  /** Comparator + threshold, kept generic so new rule kinds need no migration. */
  operator: "gte" | "lte" | "eq" | "in" | "exists";
  value: string;
  loanType?: string;
  severity: "BLOCKING" | "WARNING" | "INFO";
  enabled: boolean;
  notes?: string;
  createdAt: string;
}

/* -------------------------------------------------------------------------- */
/* Store slice                                                                 */
/* -------------------------------------------------------------------------- */

export interface OpsDatabase {
  teamMembers: TeamMember[];
  customers: Customer[];
  opsMessages: OpsMessage[];
  sentimentEvents: SentimentEvent[];
  conversationInsights: ConversationInsight[];
  scoreEvents: ScoreEvent[];
  salesTasks: SalesTask[];
  assignments: Assignment[];
  loanCases: LoanCase[];
  checklistItems: ChecklistItem[];
  documents: DocumentRecord[];
  documentEvents: DocumentEvent[];
  followUps: FollowUp[];
  escalations: Escalation[];
  opsNotifications: OpsNotification[];
  auditEvents: AuditEvent[];
  workflowConfigs: WorkflowConfig[];
  loanRules: LoanRule[];
  /** WhatsApp assistant knowledge base and the questions it could not answer. */
  kbEntries: KbEntry[];
  kbGaps: KbGap[];
}

/** Topics the intent router keys retrieval on. */
export type KbTopic =
  | "pricing" | "availability" | "location" | "amenities" | "approvals"
  | "payment" | "visit" | "contact" | "documents" | "general";

export interface KbEntry {
  id: string;
  brandId: string;
  topic: KbTopic;
  question: string;
  answer: string;
  keywords: string[];
  /**
   * Only a public entry may put a figure in front of a customer. Prices are
   * withheld unless the admin has explicitly marked the entry as quotable.
   */
  public?: boolean;
  /** How the row got here — placeholder rows are replaced once docs exist. */
  source?: "placeholder" | "docs" | "admin";
  updatedAt: string;
}

/** A customer question nothing in the knowledge base answered. */
export interface KbGap {
  id: string;
  brandId: string;
  customerId?: string;
  question: string;
  intent: string;
  count: number;
  createdAt: string;
  lastAskedAt: string;
}

export const EMPTY_OPS: OpsDatabase = {
  teamMembers: [],
  customers: [],
  opsMessages: [],
  sentimentEvents: [],
  conversationInsights: [],
  scoreEvents: [],
  salesTasks: [],
  assignments: [],
  loanCases: [],
  checklistItems: [],
  documents: [],
  documentEvents: [],
  followUps: [],
  escalations: [],
  opsNotifications: [],
  auditEvents: [],
  workflowConfigs: [],
  loanRules: [],
  kbEntries: [],
  kbGaps: [],
};
