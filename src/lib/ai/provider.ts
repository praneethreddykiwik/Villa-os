/**
 * Thin Anthropic client.
 *
 * The whole product is designed so that this is *optional*: every AI feature has
 * a deterministic fallback built from the account's own data. With a key set you
 * get better prose; without one you still get working copy, replies and
 * strategy — you never get a blank screen or an error toast.
 */

const API = "https://api.anthropic.com/v1/messages";

export function hasLLM(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** When set, we ask for JSON and parse it, retrying once on malformed output. */
  json?: boolean;
}

export async function complete(opts: CompleteOptions): Promise<string | null> {
  if (!hasLLM()) return null;
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5",
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.7,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { content: Array<{ type: string; text?: string }> };
    return json.content.find((c) => c.type === "text")?.text ?? null;
  } catch {
    return null;
  }
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
