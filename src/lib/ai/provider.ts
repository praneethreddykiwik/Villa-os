/**
 * LLM PROVIDER — Groq, Gemini, Anthropic.
 *
 * The whole product is designed so that this is *optional*: every AI feature has
 * a deterministic fallback built from the account's own data. With a key set you
 * get better prose; without one you still get working copy, replies and
 * strategy — you never get a blank screen or an error toast.
 *
 * Three providers behind one function, because the callers do not care which
 * model answered and should never have to. Selection is by configuration, not by
 * code change:
 *
 *   AI_PROVIDER=auto     (default) use the first provider that has a key,
 *                        in the order below, and fall through on failure
 *   AI_PROVIDER=groq     force Groq
 *   AI_PROVIDER=gemini   force Gemini
 *   AI_PROVIDER=anthropic force Anthropic
 *
 * `auto` tries Groq first because it is the fastest of the three by a wide
 * margin and these calls sit in front of a person waiting for a caption, then
 * Gemini, then Anthropic. Falling through on failure matters more than the
 * order: a provider having an outage should cost a retry, not the feature.
 *
 * Every call is server-side. No key is ever exposed to the browser, which is why
 * none of these hosts appear in the CSP.
 */

export type ProviderId = "groq" | "gemini" | "anthropic";

interface ProviderSpec {
  id: ProviderId;
  keyVar: string;
  modelVar: string;
  /**
   * Model IDs churn — providers retire them on weeks of notice, especially Groq.
   * These are defaults, not commitments: set the model env var to pin one, and
   * check the provider's own model list if a call starts returning nothing.
   */
  defaultModel: string;
  label: string;
}

const PROVIDERS: ProviderSpec[] = [
  { id: "groq", keyVar: "GROQ_API_KEY", modelVar: "GROQ_MODEL", defaultModel: "openai/gpt-oss-120b", label: "Groq" },
  { id: "gemini", keyVar: "GEMINI_API_KEY", modelVar: "GEMINI_MODEL", defaultModel: "gemini-3.6-flash", label: "Gemini" },
  { id: "anthropic", keyVar: "ANTHROPIC_API_KEY", modelVar: "ANTHROPIC_MODEL", defaultModel: "claude-sonnet-5", label: "Anthropic" },
];

function keyed(spec: ProviderSpec): boolean {
  return Boolean(process.env[spec.keyVar]?.trim());
}

/** The providers to try, in order, for this configuration. */
function chain(): ProviderSpec[] {
  const forced = process.env.AI_PROVIDER?.trim().toLowerCase();
  if (forced && forced !== "auto") {
    const hit = PROVIDERS.find((p) => p.id === forced);
    // A forced provider with no key is a misconfiguration, not a reason to
    // silently use a different one — the operator asked for that model.
    return hit && keyed(hit) ? [hit] : [];
  }
  return PROVIDERS.filter(keyed);
}

export function hasLLM(): boolean {
  return chain().length > 0;
}

/** Which provider will answer, for status screens. Null when none is configured. */
export function activeProvider(): { id: ProviderId; label: string; model: string } | null {
  const first = chain()[0];
  if (!first) return null;
  return {
    id: first.id,
    label: first.label,
    model: process.env[first.modelVar]?.trim() || first.defaultModel,
  };
}

export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** Ask the provider for strict JSON rather than hoping the prose parses. */
  json?: boolean;
  /**
   * Per-call deadline. The default suits a person waiting on a caption; a
   * customer waiting on WhatsApp needs a much shorter one, and a slow answer
   * must degrade to the deterministic reply rather than stall the webhook.
   */
  timeoutMs?: number;
}

const TIMEOUT_MS = 30_000;

/**
 * Floor on the output budget.
 *
 * Current models on all three providers reason before answering, and those
 * hidden tokens are charged against the same budget as the reply. A caller
 * asking for 40 tokens got 40 tokens of thinking, an empty `content`, and
 * `finishReason: MAX_TOKENS` — which looked exactly like an outage. Gemini has
 * thinking disabled below, but the floor protects the other two, where it
 * cannot be turned off.
 */
const MIN_OUTPUT_TOKENS = 512;
function budget(requested?: number): number {
  return Math.max(requested ?? 1024, MIN_OUTPUT_TOKENS);
}

/* -------------------------------------------------------------------------- */
/* Per-provider calls. Each returns text, or throws so the chain can move on.  */
/* -------------------------------------------------------------------------- */

/** Groq speaks the OpenAI chat-completions dialect. */
async function callGroq(spec: ProviderSpec, opts: CompleteOptions): Promise<string | null> {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env[spec.keyVar]!.trim()}`,
    },
    body: JSON.stringify({
      model: process.env[spec.modelVar]?.trim() || spec.defaultModel,
      max_tokens: budget(opts.maxTokens),
      temperature: opts.temperature ?? 0.7,
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      // Deliberately NOT response_format: { type: "json_object" }. Groq enforces
      // that strictly and fails the whole request when the model returns a
      // top-level ARRAY — which is exactly what this codebase asks for ("return
      // only a JSON array of strings"). The prompt carries the instruction and
      // extractJson() recovers the value; a hard 400 on the common case is worse
      // than parsing prose on the rare one.
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? null;
}

/**
 * Gemini takes the system prompt as a separate `systemInstruction` rather than a
 * message, and the key goes in a header — passing it as a query parameter would
 * put it in every proxy and access log between here and Google.
 */
async function callGemini(spec: ProviderSpec, opts: CompleteOptions): Promise<string | null> {
  const model = process.env[spec.modelVar]?.trim() || spec.defaultModel;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": process.env[spec.keyVar]!.trim(),
      },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
        generationConfig: {
          maxOutputTokens: budget(opts.maxTokens),
          temperature: opts.temperature ?? 0.7,
          // No thinkingConfig on purpose. gemini-3.x rejects `thinkingBudget: 0`
          // with 400 INVALID_ARGUMENT, and `thinkingLevel` does not exist on the
          // 2.5 generation — either one couples this file to a model era. The
          // MIN_OUTPUT_TOKENS floor already prevents thinking from eating the
          // whole budget, and it works on every generation.
          ...(opts.json ? { responseMimeType: "application/json" } : {}),
        },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
  };
  // Parts can be split across several entries; joining them is not optional.
  const cand = json.candidates?.[0];
  const parts = cand?.content?.parts ?? [];
  const text = parts.map((p) => p.text ?? "").join("").trim();
  if (!text && cand?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini hit the output limit before emitting text (thinking consumed the budget)");
  }
  if (!text && cand?.finishReason && cand.finishReason !== "STOP") {
    throw new Error(`Gemini stopped early: ${cand.finishReason}`);
  }
  return text || null;
}

async function callAnthropic(spec: ProviderSpec, opts: CompleteOptions): Promise<string | null> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env[spec.keyVar]!.trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env[spec.modelVar]?.trim() || spec.defaultModel,
      max_tokens: budget(opts.maxTokens),
      temperature: opts.temperature ?? 0.7,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  return json.content?.find((c) => c.type === "text")?.text ?? null;
}

const CALLS: Record<ProviderId, (s: ProviderSpec, o: CompleteOptions) => Promise<string | null>> = {
  groq: callGroq,
  gemini: callGemini,
  anthropic: callAnthropic,
};

/**
 * Ask whichever provider is configured, falling through on failure.
 *
 * Returns null rather than throwing when every provider is exhausted, because
 * that is the contract every caller is written against: null means "use the
 * deterministic path", and an AI outage must degrade the prose, never the page.
 * Failures are logged once per provider so a wrong key or a retired model is
 * diagnosable instead of silently looking like "the AI is just off".
 */
export async function complete(opts: CompleteOptions): Promise<string | null> {
  const providers = chain();
  if (!providers.length) return null;

  for (const spec of providers) {
    try {
      const text = await CALLS[spec.id](spec, opts);
      if (text && text.trim()) return text;
      console.warn(`[ai] ${spec.label} returned an empty completion; trying the next provider.`);
    } catch (e) {
      const message = (e as Error).message;
      // complete() swallows errors by contract, so a caller that wants to retry
      // a rate limit (and only a rate limit) reads the status from here.
      lastFailure = { status: Number(message.match(/HTTP (\d{3})/)?.[1]) || undefined, at: Date.now() };
      console.warn(`[ai] ${spec.label} failed: ${message}`);
    }
  }
  return null;
}

/** The most recent provider failure, for callers deciding whether to retry. */
export let lastFailure: { status?: number; at: number } | null = null;

/** True when the last completion failed with a 429 within the last few seconds. */
export function rateLimitedRecently(withinMs = 5_000): boolean {
  return lastFailure?.status === 429 && Date.now() - lastFailure.at < withinMs;
}

/** Parse a JSON array out of a model response that may be fenced or chatty. */
export function extractJson<T>(text: string | null): T | null {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start === -1) return null;
  try {
    return JSON.parse(body.slice(start)) as T;
  } catch {
    return null;
  }
}
