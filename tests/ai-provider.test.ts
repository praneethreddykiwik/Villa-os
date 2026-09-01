import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";
/**
 * Provider selection is configuration, not code, so it is exactly the kind of
 * thing that breaks silently: a pinned provider quietly answering from a
 * different vendor, or a blank key reading as configured, both look fine on the
 * status screen and produce the wrong bill.
 */
const dir = isolate("prov"); after(() => cleanup(dir));
const P = require("../src/lib/ai/provider") as typeof import("../src/lib/ai/provider");

function env(o: Record<string, string | undefined>) {
  for (const k of ["AI_PROVIDER","GROQ_API_KEY","GEMINI_API_KEY","ANTHROPIC_API_KEY","GROQ_MODEL","GEMINI_MODEL"]) delete process.env[k];
  for (const [k,v] of Object.entries(o)) if (v !== undefined) process.env[k] = v;
}

describe("AI provider selection", () => {
  test("no keys -> disabled, complete() returns null", async () => {
    env({});
    assert.equal(P.hasLLM(), false);
    assert.equal(P.activeProvider(), null);
    assert.equal(await P.complete({ system: "s", prompt: "p" }), null);
  });
  test("auto prefers Groq when both Groq and Gemini are keyed", () => {
    env({ GROQ_API_KEY: "gk", GEMINI_API_KEY: "gm" });
    assert.equal(P.activeProvider()?.id, "groq");
    assert.equal(P.activeProvider()?.model, "openai/gpt-oss-120b");
  });
  test("auto falls to Gemini when only Gemini is keyed", () => {
    env({ GEMINI_API_KEY: "gm" });
    assert.equal(P.activeProvider()?.id, "gemini");
    assert.equal(P.activeProvider()?.model, "gemini-3.6-flash");
  });
  test("AI_PROVIDER pins a provider even when another is keyed first", () => {
    env({ AI_PROVIDER: "gemini", GROQ_API_KEY: "gk", GEMINI_API_KEY: "gm" });
    assert.equal(P.activeProvider()?.id, "gemini");
  });
  test("a pinned provider with no key is disabled, not silently swapped", () => {
    env({ AI_PROVIDER: "gemini", GROQ_API_KEY: "gk" });
    assert.equal(P.hasLLM(), false, "must not quietly use Groq when Gemini was demanded");
  });
  test("model override is honoured", () => {
    env({ GROQ_API_KEY: "gk", GROQ_MODEL: "openai/gpt-oss-120b" });
    assert.equal(P.activeProvider()?.model, "openai/gpt-oss-120b");
  });
  test("blank key is treated as unset", () => {
    env({ GROQ_API_KEY: "   " });
    assert.equal(P.hasLLM(), false);
  });
  test("bad key falls through the chain and still returns null, never throws", async () => {
    env({ GROQ_API_KEY: "sk-invalid", GEMINI_API_KEY: "also-invalid" });
    const out = await P.complete({ system: "s", prompt: "p" });
    assert.equal(out, null, "callers rely on null to use the deterministic path");
  });
});

describe("reasoning models do not silently return nothing", () => {
  test("a small maxTokens is raised to a floor that survives hidden thinking", () => {
    // Current models on all three providers reason before answering, and those
    // tokens are charged against the same budget. A caller asking for 40 got 40
    // tokens of thinking, an empty body and finishReason MAX_TOKENS — which is
    // indistinguishable from an outage at the call site.
    const src = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "src/lib/ai/provider.ts"), "utf8");
    assert.match(src, /MIN_OUTPUT_TOKENS\s*=\s*(\d+)/);
    const floor = Number(/MIN_OUTPUT_TOKENS\s*=\s*(\d+)/.exec(src)![1]);
    assert.ok(floor >= 256, "the floor must clear a typical thinking preamble");
    // Every provider call must go through budget(), never opts.maxTokens raw.
    assert.ok(!/max_tokens:\s*opts\.maxTokens/.test(src), "Groq/Anthropic must use budget()");
    assert.ok(!/maxOutputTokens:\s*opts\.maxTokens/.test(src), "Gemini must use budget()");
    assert.equal((src.match(/budget\(opts\.maxTokens\)/g) ?? []).length, 3, "all three providers");
  });

  test("Groq strict JSON mode is not used, because it rejects top-level arrays", () => {
    const src = require("node:fs").readFileSync(
      require("node:path").join(process.cwd(), "src/lib/ai/provider.ts"), "utf8")
      .replace(/\/\/.*$/gm, "");
    assert.ok(!/response_format/.test(src),
      "this codebase asks for JSON arrays; json_object mode 400s on them");
  });
});
