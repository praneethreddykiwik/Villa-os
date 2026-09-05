/**
 * BOLNA VOICE AGENTS — HTTP client.
 *
 * Bolna runs the outbound calling agent ("Sarah", Hindi/Hinglish/Telugu). This
 * module is the only place in the application that talks to api.bolna.ai.
 *
 * Two rules shape everything below.
 *
 * 1. NOTHING THROWS. Every exported call returns a discriminated result. A
 *    voice-agent tab is a side panel of the business, not the business: when
 *    Bolna is down, mid-deploy, or answering 502, the page must render the
 *    agents it cannot reach and say so, rather than turning a provider outage
 *    into a 500 on our own screen.
 *
 * 2. NOTHING IS ASSUMED ABOUT THE SHAPE. These endpoints were implemented from
 *    documentation against an account we cannot call — no key is configured
 *    here — so every field is read through a guard and every absent field
 *    becomes `null`, never a crash and never a made-up default. `agent_config`
 *    in particular is a nested provider structure that has changed shape
 *    between API versions; the normalisers below accept the variants that are
 *    documented and ignore anything they do not recognise.
 *
 * The key never leaves this file: it is not logged, not returned in any result,
 * and scrubbed out of provider error text before that text is surfaced.
 */

const BASE_URL = "https://api.bolna.ai";

/**
 * A call that has not answered in 20 seconds is not going to. The bound matters
 * more than the number: without it a stalled provider socket holds a Next.js
 * server-component render open until the platform kills the whole request.
 */
const TIMEOUT_MS = 20_000;

export type BolnaFailureReason =
  /** No BOLNA_API_KEY. Not an error — the operator has not connected it yet. */
  | "unconfigured"
  /** Bolna answered, with a status we cannot use. `status` carries which. */
  | "http"
  /** Never reached Bolna: DNS, TLS, timeout. */
  | "network"
  /** Reached Bolna, got something that is not the JSON we can read. */
  | "shape";

export interface BolnaFailure {
  ok: false;
  reason: BolnaFailureReason;
  /** Safe to show a human. Carries the provider's own words where it gave any. */
  error: string;
  status?: number;
}

export type BolnaResult<T> = { ok: true; data: T } | BolnaFailure;

export interface BolnaAgent {
  id: string;
  name: string;
  status: string | null;
  type: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Synthesizer — who the caller actually hears. */
  voice: { provider: string | null; voice: string | null; model: string | null } | null;
  /** Every language the agent is configured to hear or speak, de-duplicated. */
  languages: string[];
  llm: { provider: string | null; model: string | null } | null;
  transcriber: { provider: string | null; model: string | null; language: string | null } | null;
  welcomeMessage: string | null;
  prompt: string | null;
  /**
   * Only set when Bolna itself reports a per-minute price on this payload. It
   * is left null rather than estimated: a wrong number next to "cost" is worse
   * than no number, because somebody will budget against it.
   */
  costPerMinute: number | null;
}

export interface BolnaTranscriptTurn {
  role: string;
  text: string;
}

export interface BolnaExecution {
  id: string;
  agentId: string | null;
  batchId: string | null;
  status: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  durationSeconds: number | null;
  cost: number | null;
  currency: string | null;
  toNumber: string | null;
  fromNumber: string | null;
  callType: string | null;
  hangupBy: string | null;
  hangupReason: string | null;
  answeredByVoicemail: boolean | null;
  recordingUrl: string | null;
  /** Free-text transcript, when Bolna returned one string. */
  transcript: string | null;
  /** Turn-by-turn transcript, when Bolna returned a structured one. */
  turns: BolnaTranscriptTurn[] | null;
  /** Whatever the agent's extraction task pulled out of the conversation. */
  extractedData: Record<string, unknown> | null;
}

export interface BolnaCallStart {
  executionId: string | null;
  status: string | null;
  message: string | null;
}

export interface BolnaAccount {
  balance: number | null;
  currency: string | null;
  plan: string | null;
  email: string | null;
}

/* -------------------------------------------------------------------------- */
/* Guards. Every provider field goes through one of these.                     */
/* -------------------------------------------------------------------------- */

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Non-empty trimmed string, or null. Numbers are accepted because provider ids
 *  and durations arrive as either, depending on the endpoint. */
function str(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Finite number, including one delivered as a numeric string. */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function bool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

/** First key present across the given records. */
function pickStr(sources: Array<Record<string, unknown> | null>, ...keys: string[]): string | null {
  for (const source of sources) {
    if (!source) continue;
    for (const k of keys) {
      const hit = str(source[k]);
      if (hit) return hit;
    }
  }
  return null;
}

function pickNum(sources: Array<Record<string, unknown> | null>, ...keys: string[]): number | null {
  for (const source of sources) {
    if (!source) continue;
    for (const k of keys) {
      const hit = num(source[k]);
      if (hit !== null) return hit;
    }
  }
  return null;
}

/**
 * A URL we are willing to put in an href.
 *
 * The recording link comes from a third party and is rendered as an anchor. A
 * `javascript:` or `data:` value in that field would execute in the operator's
 * session, so the scheme is checked here rather than trusted at the JSX.
 */
function safeUrl(v: unknown): string | null {
  const raw = str(v);
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

function apiKey(): string | null {
  return process.env.BOLNA_API_KEY?.trim() || null;
}

export function isConfigured(): boolean {
  return apiKey() !== null;
}

/**
 * Remove the key from anything on its way to a screen or a log.
 *
 * Providers do echo request context back in error bodies. One that echoed the
 * Authorization header would otherwise put the account's only credential into
 * an error banner and the browser's DOM.
 */
function redact(text: string): string {
  const key = apiKey();
  return key ? text.split(key).join("[redacted]") : text;
}

/** The provider's own explanation, dug out of whatever envelope it used. */
function providerMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const r = rec(parsed);
    if (r) {
      const direct = pickStr([r], "detail", "message", "error", "error_message");
      if (direct) return redact(direct.slice(0, 300));
      // FastAPI validation errors arrive as detail: [{ loc, msg, type }].
      const first = rec(list(r.detail)[0]);
      const msg = first ? pickStr([first], "msg", "message") : null;
      if (msg) return redact(msg.slice(0, 300));
    }
    if (typeof parsed === "string" && parsed.trim()) return redact(parsed.slice(0, 300));
  } catch {
    /* not JSON — fall through to the raw text */
  }
  return redact(trimmed.slice(0, 300));
}

async function request(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<BolnaResult<unknown>> {
  const key = apiKey();
  if (!key) {
    return {
      ok: false,
      reason: "unconfigured",
      error: "Bolna is not connected — BOLNA_API_KEY is not set on this deployment.",
    };
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${key}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A 30x would re-send the Authorization header to whichever host the
      // redirect names. The key is the whole account: it goes to api.bolna.ai
      // or it goes nowhere.
      redirect: "manual",
      // These are live operational figures — a cached call list is a wrong one.
      cache: "no-store",
    });
  } catch (e) {
    // Covers the abort on timeout as well as DNS and TLS failure. The message
    // is kept because it is the only thing that separates "Bolna is down" from
    // "this host has no egress".
    return {
      ok: false,
      reason: "network",
      error: redact(e instanceof Error ? e.message : "Could not reach Bolna."),
    };
  }

  const text = await res.text().catch(() => "");

  if (res.status >= 300 && res.status < 400) {
    return {
      ok: false,
      reason: "http",
      status: res.status,
      error: `Bolna redirected the request (HTTP ${res.status}). The API key was not followed to another host.`,
    };
  }

  if (!res.ok) {
    const detail = providerMessage(text);
    return {
      ok: false,
      reason: "http",
      status: res.status,
      error: detail ? `Bolna answered HTTP ${res.status}: ${detail}` : `Bolna answered HTTP ${res.status}.`,
    };
  }

  if (!text.trim()) return { ok: true, data: null };

  try {
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "shape", error: "Bolna returned a body that is not JSON." };
  }
}

/**
 * Collections have come back both bare and wrapped over the life of this API,
 * so read either without caring which.
 */
function collection(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  const r = rec(data);
  if (!r) return [];
  for (const key of ["data", "agents", "executions", "results", "items"]) {
    if (Array.isArray(r[key])) return r[key] as unknown[];
  }
  return [];
}

/* -------------------------------------------------------------------------- */
/* Normalisers — exported so they can be tested without a network             */
/* -------------------------------------------------------------------------- */

/** Every language string this configuration mentions, in first-seen order. */
function languagesFrom(sources: Array<Record<string, unknown> | null>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    const s = str(v);
    if (s && !out.includes(s)) out.push(s);
  };
  for (const source of sources) {
    if (!source) continue;
    add(source.language);
    for (const item of list(source.languages)) add(item);
  }
  return out;
}

export function normaliseAgent(input: unknown): BolnaAgent | null {
  const r = rec(input);
  if (!r) return null;

  const config = rec(r.agent_config);
  const id = pickStr([r, config], "id", "agent_id");
  // An agent we cannot address is an agent we cannot call or list. Dropping it
  // is better than rendering a row whose every button would fail.
  if (!id) return null;

  const tasks = list(config?.tasks ?? r.tasks);
  const tools = rec(rec(tasks[0])?.tools_config);
  const synth = rec(tools?.synthesizer);
  const synthConfig = rec(synth?.provider_config);
  const transcriber = rec(tools?.transcriber);
  const llmAgent = rec(tools?.llm_agent);
  // Newer configs nest the model under llm_config; older ones put it on the
  // agent itself. Read both, prefer the nested one.
  const llmConfig = rec(llmAgent?.llm_config) ?? llmAgent;

  const prompts = rec(r.agent_prompts) ?? rec(config?.agent_prompts);
  const firstPrompt = rec(prompts?.task_1) ?? rec(list(Object.values(prompts ?? {}))[0]);

  const voiceProvider = pickStr([synth], "provider", "name");
  const voiceName = pickStr([synthConfig], "voice", "voice_id", "name");
  const voiceModel = pickStr([synthConfig], "model", "engine");

  return {
    id,
    name: pickStr([r, config], "agent_name", "name") ?? id,
    status: pickStr([r, config], "agent_status", "status"),
    type: pickStr([r, config], "agent_type", "type"),
    createdAt: pickStr([r, config], "created_at", "createdAt"),
    updatedAt: pickStr([r, config], "updated_at", "updatedAt"),
    voice:
      voiceProvider || voiceName || voiceModel
        ? { provider: voiceProvider, voice: voiceName, model: voiceModel }
        : null,
    languages: languagesFrom([transcriber, synthConfig, config, r]),
    llm: llmConfig
      ? { provider: pickStr([llmConfig], "provider", "family"), model: pickStr([llmConfig], "model", "model_name") }
      : null,
    transcriber: transcriber
      ? {
          provider: pickStr([transcriber], "provider"),
          model: pickStr([transcriber], "model", "name"),
          language: pickStr([transcriber], "language"),
        }
      : null,
    welcomeMessage: pickStr([config, r], "agent_welcome_message", "welcome_message"),
    prompt: pickStr([firstPrompt], "system_prompt", "prompt"),
    costPerMinute: pickNum([r, config], "cost_per_minute", "price_per_minute", "per_minute_cost"),
  };
}

function turnsFrom(input: unknown): BolnaTranscriptTurn[] | null {
  const raw = list(input);
  if (!raw.length) return null;
  const turns: BolnaTranscriptTurn[] = [];
  for (const entry of raw) {
    const t = rec(entry);
    if (!t) continue;
    const text = pickStr([t], "content", "text", "message", "transcript");
    if (!text) continue;
    turns.push({ role: pickStr([t], "role", "speaker", "from") ?? "unknown", text });
  }
  return turns.length ? turns : null;
}

export function normaliseExecution(input: unknown): BolnaExecution | null {
  const r = rec(input);
  if (!r) return null;

  const id = pickStr([r], "id", "execution_id");
  if (!id) return null;

  const telephony = rec(r.telephony_data);
  const transcriptRecord = rec(r.transcript);

  return {
    id,
    agentId: pickStr([r], "agent_id"),
    batchId: pickStr([r], "batch_id"),
    status: pickStr([r, telephony], "status", "call_status"),
    createdAt: pickStr([r], "created_at", "createdAt"),
    updatedAt: pickStr([r], "updated_at", "updatedAt"),
    // conversation_time is the agent's own measure; telephony duration is the
    // carrier's. They disagree by the ring time, and the agent's is the one the
    // cost is computed against, so it wins where both are present.
    durationSeconds: pickNum([r], "conversation_time", "duration") ?? pickNum([telephony], "duration"),
    cost: pickNum([r], "total_cost", "cost"),
    currency: pickStr([r], "currency"),
    toNumber: pickStr([telephony, r], "to_number", "recipient_phone_number"),
    fromNumber: pickStr([telephony, r], "from_number"),
    callType: pickStr([telephony, r], "call_type", "direction"),
    hangupBy: pickStr([telephony], "hangup_by"),
    hangupReason: pickStr([telephony], "hangup_reason", "hangup_provider_reason"),
    answeredByVoicemail: bool(r.answered_by_voice_mail ?? r.answered_by_voicemail),
    recordingUrl: safeUrl(telephony?.recording_url ?? r.recording_url),
    transcript: str(r.transcript) ?? pickStr([transcriptRecord], "text", "content"),
    turns: turnsFrom(r.transcript) ?? turnsFrom(transcriptRecord?.turns) ?? turnsFrom(r.messages),
    extractedData: rec(r.extracted_data),
  };
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

/** GET /v2/agent/all */
export async function listAgents(): Promise<BolnaResult<BolnaAgent[]>> {
  const res = await request("/v2/agent/all");
  if (!res.ok) return res;
  const agents = collection(res.data)
    .map(normaliseAgent)
    .filter((a): a is BolnaAgent => a !== null);
  return { ok: true, data: agents };
}

/** GET /agent/{agent_id} — prompt, voice, languages, model. */
export async function getAgent(agentId: string): Promise<BolnaResult<BolnaAgent>> {
  const res = await request(`/agent/${encodeURIComponent(agentId)}`);
  if (!res.ok) return res;
  // The detail payload describes an agent without necessarily repeating its id,
  // so the id we asked with is supplied as the fallback.
  const agent = normaliseAgent({ id: agentId, ...(rec(res.data) ?? {}) });
  if (!agent) return { ok: false, reason: "shape", error: "Bolna returned no readable agent for that id." };
  return { ok: true, data: agent };
}

export interface StartCallInput {
  agentId: string;
  /** E.164, validated by the caller — this client does not guess a country code. */
  phone: string;
  /** Interpolated into the agent's prompt placeholders, e.g. {lead_name}. */
  userData?: Record<string, string>;
}

/** POST /call */
export async function startCall(input: StartCallInput): Promise<BolnaResult<BolnaCallStart>> {
  const res = await request("/call", {
    method: "POST",
    body: {
      agent_id: input.agentId,
      recipient_phone_number: input.phone,
      ...(input.userData && Object.keys(input.userData).length ? { user_data: input.userData } : {}),
    },
  });
  if (!res.ok) return res;
  const r = rec(res.data);
  return {
    ok: true,
    data: {
      executionId: pickStr([r], "execution_id", "id"),
      status: pickStr([r], "status"),
      message: pickStr([r], "message", "detail"),
    },
  };
}

/** GET /call/{execution_id} — status, duration, cost, transcript, recording. */
export async function getExecution(executionId: string): Promise<BolnaResult<BolnaExecution>> {
  const res = await request(`/call/${encodeURIComponent(executionId)}`);
  if (!res.ok) return res;
  const execution = normaliseExecution({ id: executionId, ...(rec(res.data) ?? {}) });
  if (!execution) return { ok: false, reason: "shape", error: "Bolna returned no readable execution for that id." };
  return { ok: true, data: execution };
}

/** GET /agent/{agent_id}/executions — call history for one agent. */
export async function listExecutions(agentId: string): Promise<BolnaResult<BolnaExecution[]>> {
  const res = await request(`/agent/${encodeURIComponent(agentId)}/executions`);
  if (!res.ok) return res;
  const executions = collection(res.data)
    .map(normaliseExecution)
    .filter((e): e is BolnaExecution => e !== null)
    // The agent id is not repeated on every execution shape, and the history
    // is merged across agents upstream, so it is stamped from the request.
    .map((e) => ({ ...e, agentId: e.agentId ?? agentId }));
  return { ok: true, data: executions };
}

/**
 * Account balance and plan.
 *
 * This is the one call here that is NOT in the documented set this module was
 * built against — it is a probe, not a promise. A 404 or 405 therefore means
 * "this account does not expose it", which is a normal answer and not a
 * failure; only a real fault is reported as one. Nothing is invented when it
 * comes back empty: the tab says the API did not report a balance.
 */
export async function getAccount(): Promise<BolnaResult<BolnaAccount | null>> {
  const res = await request("/user/details");
  if (!res.ok) {
    if (res.reason === "http" && (res.status === 404 || res.status === 405 || res.status === 403)) {
      return { ok: true, data: null };
    }
    return res;
  }
  const r = rec(res.data);
  if (!r) return { ok: true, data: null };
  const account: BolnaAccount = {
    balance: pickNum([r], "balance", "wallet_balance", "credits", "remaining_credits"),
    currency: pickStr([r], "currency"),
    plan: pickStr([r], "plan", "plan_name", "subscription", "tier"),
    email: pickStr([r], "email"),
  };
  const empty =
    account.balance === null && account.currency === null && account.plan === null && account.email === null;
  return { ok: true, data: empty ? null : account };
}

/**
 * The number Bolna will accept, or null.
 *
 * Bolna dials E.164, so a number with no country code is not dialable. We
 * refuse those with an explanation instead of prepending a country code on the
 * caller's behalf: guessing +91 because the office is in Hyderabad would
 * eventually dial a stranger in another country at the operator's expense.
 */
export function toE164(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("+")) return null;
  const digits = trimmed.slice(1).replace(/[^\d]/g, "");
  // E.164 allows at most 15 digits; below 8 nothing is a routable subscriber
  // number with a country code in front of it.
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}
