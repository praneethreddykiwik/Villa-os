import assert from "node:assert/strict";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * Bolna client — parsing and configuration.
 *
 * These endpoints were built from documentation against an account this repo
 * cannot call, so the risk is not "does the request work" but "what happens
 * when the payload is not the shape we expected". Every case below is a payload
 * that must degrade to a null field instead of throwing inside a server render.
 */

const dir = isolate("bolna");
after(() => cleanup(dir));

const {
  isConfigured, normaliseAgent, normaliseExecution, toE164,
} = require("../src/lib/bolna/client") as typeof import("../src/lib/bolna/client");

describe("configuration", () => {
  test("an unset or blank key is not configured", () => {
    delete process.env.BOLNA_API_KEY;
    assert.equal(isConfigured(), false);
    process.env.BOLNA_API_KEY = "   ";
    assert.equal(isConfigured(), false);
    process.env.BOLNA_API_KEY = "bn-test";
    assert.equal(isConfigured(), true);
    delete process.env.BOLNA_API_KEY;
  });
});

describe("agent parsing", () => {
  test("reads a full nested agent config", () => {
    const agent = normaliseAgent({
      id: "agt_1",
      agent_status: "active",
      agent_config: {
        agent_name: "Sarah",
        tasks: [
          {
            tools_config: {
              synthesizer: { provider: "elevenlabs", provider_config: { voice: "Kanika", model: "eleven_turbo_v2_5" } },
              transcriber: { provider: "deepgram", model: "nova-2", language: "hi" },
              llm_agent: { llm_config: { provider: "openai", model: "gpt-4o-mini" } },
            },
          },
        ],
        agent_welcome_message: "Namaste!",
      },
      agent_prompts: { task_1: { system_prompt: "You are Sarah." } },
    });

    assert.ok(agent);
    assert.equal(agent.name, "Sarah");
    assert.equal(agent.voice?.voice, "Kanika");
    assert.equal(agent.llm?.model, "gpt-4o-mini");
    assert.equal(agent.transcriber?.model, "nova-2");
    assert.equal(agent.prompt, "You are Sarah.");
    assert.deepEqual(agent.languages, ["hi"]);
    // Never invented: Bolna reported no price on this payload.
    assert.equal(agent.costPerMinute, null);
  });

  test("an agent with nothing but an id still renders", () => {
    const agent = normaliseAgent({ id: "agt_2" });
    assert.ok(agent);
    assert.equal(agent.name, "agt_2");
    assert.equal(agent.voice, null);
    assert.equal(agent.llm, null);
    assert.deepEqual(agent.languages, []);
  });

  test("junk and id-less payloads are dropped rather than half-rendered", () => {
    for (const junk of [null, undefined, "agent", 7, [], {}, { agent_config: { agent_name: "Sarah" } }]) {
      assert.equal(normaliseAgent(junk), null);
    }
  });
});

describe("execution parsing", () => {
  test("reads telephony, cost and a structured transcript", () => {
    const call = normaliseExecution({
      id: "exe_1",
      agent_id: "agt_1",
      status: "completed",
      conversation_time: 96,
      total_cost: 3.4,
      transcript: [
        { role: "assistant", content: "Namaste Ravi ji" },
        { role: "user", content: "Haan boliye" },
      ],
      telephony_data: {
        to_number: "+919876543210",
        from_number: "+911140000000",
        recording_url: "https://recordings.example.com/a.wav",
        hangup_by: "user",
      },
    });

    assert.ok(call);
    assert.equal(call.durationSeconds, 96);
    assert.equal(call.cost, 3.4);
    assert.equal(call.toNumber, "+919876543210");
    assert.equal(call.recordingUrl, "https://recordings.example.com/a.wav");
    assert.equal(call.turns?.length, 2);
    assert.equal(call.transcript, null);
  });

  test("a plain-string transcript and a numeric-string duration still read", () => {
    const call = normaliseExecution({
      execution_id: "exe_2",
      transcript: "assistant: hello\nuser: hi",
      telephony_data: { duration: "42" },
    });
    assert.ok(call);
    assert.equal(call.transcript, "assistant: hello\nuser: hi");
    assert.equal(call.turns, null);
    assert.equal(call.durationSeconds, 42);
    assert.equal(call.cost, null);
  });

  test("a recording URL that is not http(s) never reaches an href", () => {
    const call = normaliseExecution({
      id: "exe_3",
      telephony_data: { recording_url: "javascript:alert(document.cookie)" },
    });
    assert.ok(call);
    assert.equal(call.recordingUrl, null);
  });

  test("an execution with no id is dropped", () => {
    assert.equal(normaliseExecution({ status: "completed" }), null);
    assert.equal(normaliseExecution("exe_4"), null);
  });
});

describe("dialable numbers", () => {
  test("keeps a well-formed E.164 number, punctuation and all", () => {
    assert.equal(toE164("+91 98765-43210"), "+919876543210");
    assert.equal(toE164("  +14155550123 "), "+14155550123");
  });

  test("refuses anything without a country code rather than guessing one", () => {
    assert.equal(toE164("9876543210"), null);
    assert.equal(toE164("098765 43210"), null);
    assert.equal(toE164(""), null);
    assert.equal(toE164("+123"), null);
    assert.equal(toE164(`+${"9".repeat(16)}`), null);
  });
});
