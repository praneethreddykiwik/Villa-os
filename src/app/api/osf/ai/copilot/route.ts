import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { operatorText } from "@/lib/whitelabel";
import { answerQuestion, gatherContext } from "@/lib/osf/ai/copilot";
import { configStatus } from "@/lib/osf/env";
import { guard } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * One question, answered over a fixed aggregate context.
 *
 * The model gets no tools and never writes SQL. That is the whole security
 * design: this process holds the service_role key, so a model able to compose
 * its own reads would turn any typed question — or any sentence a lead typed
 * into WhatsApp that ends up inside the context — into a query against every
 * table. Instead `gatherContext` runs a closed set of aggregates and the model
 * sees only their output. The worst a poisoned context string can do is make
 * the answer wrong, which is why the context is returned alongside the answer
 * and rendered next to it.
 */

/** Long enough for a real question, short enough that the prompt stays bounded. */
const MAX_QUESTION_CHARS = 500;

export async function POST(request: Request) {
  const denied = await guard("analytics.view");
  if (denied) return denied;
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const question = typeof body.question === "string" ? body.question.trim() : "";

  if (!question) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }
  if (question.length > MAX_QUESTION_CHARS) {
    return NextResponse.json(
      { error: `Questions are capped at ${MAX_QUESTION_CHARS} characters.` },
      { status: 400 },
    );
  }

  const status = configStatus();
  if (!status.aiConfigured) {
    const key = status.llmProvider === "groq" ? "GROQ_API_KEY" : "ANTHROPIC_API_KEY";
    return NextResponse.json(
      // Surfaced verbatim in the copilot panel, so it carries no key name for a client.
      { error: operatorText(`${key} is not set, so no model can answer. Add it to .env.local.`) },
      { status: 503 },
    );
  }

  let context;
  try {
    context = await gatherContext();
  } catch (e) {
    // The upstream message here is a PostgREST/Postgres error — it names
    // tables, columns and constraints. Auditors hold analytics.view too, so
    // this is not an admin-only surface; the detail goes to the server log
    // under a reference the operator can quote instead.
    const ref = crypto.randomUUID();
    console.error(`[osf:copilot:${ref}]`, e instanceof Error ? e.stack : e);
    return NextResponse.json(
      { error: "Could not read the data context. Quote this reference if you report it.", ref },
      { status: 500 },
    );
  }

  try {
    const result = await answerQuestion(question, context);
    if (!result.answer) {
      return NextResponse.json(
        { error: "The model returned an empty answer. Try rephrasing the question." },
        { status: 502 },
      );
    }
    // The context travels back with the answer so the UI can show exactly what
    // the model was allowed to see when it said what it said.
    return NextResponse.json({ ...result, context });
  } catch (e) {
    // Same reasoning as the context failure above: an LLM-provider error can
    // carry the request body or the key prefix back with it.
    const ref = crypto.randomUUID();
    console.error(`[osf:copilot:${ref}]`, e instanceof Error ? e.stack : e);
    return NextResponse.json(
      { error: "The assistant could not answer. Quote this reference if you report it.", ref },
      { status: 502 },
    );
  }
}
