import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { configuredAgentId, configuredAgentIds, inboundAgentId } from "../src/lib/bolna/client";

/**
 * Inbound and outbound are different conversations.
 *
 * Bolna speaks one `agent_welcome_message` per agent before the model gets a
 * turn, so the greeting cannot branch inside a prompt. Two agents, two
 * greetings — and the app has to know about both without ever dialling out
 * from the one meant to answer.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const withEnv = (vars: Record<string, string | undefined>, fn: () => void) => {
  const before: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    before[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe("the two agents", () => {
  test("one agent still handles everything when no inbound agent is set", () => {
    withEnv({ BOLNA_AGENT_ID: "out-1", BOLNA_INBOUND_AGENT_ID: undefined }, () => {
      assert.equal(inboundAgentId(), null);
      assert.deepEqual(configuredAgentIds(), ["out-1"]);
    });
  });

  test("both agents are polled once an inbound one exists", () => {
    // An inbound-only agent's calls would otherwise never appear in the history.
    withEnv({ BOLNA_AGENT_ID: "out-1", BOLNA_INBOUND_AGENT_ID: "in-1" }, () => {
      assert.deepEqual(configuredAgentIds(), ["out-1", "in-1"]);
    });
  });

  test("outbound comes first", () => {
    withEnv({ BOLNA_AGENT_ID: "out-1", BOLNA_INBOUND_AGENT_ID: "in-1" }, () => {
      assert.equal(configuredAgentIds()[0], "out-1");
    });
  });

  test("pointing both at one agent does not double the call history", () => {
    withEnv({ BOLNA_AGENT_ID: "same", BOLNA_INBOUND_AGENT_ID: "same" }, () => {
      assert.deepEqual(configuredAgentIds(), ["same"]);
    });
  });

  test("blank and whitespace are treated as unset", () => {
    withEnv({ BOLNA_AGENT_ID: "out-1", BOLNA_INBOUND_AGENT_ID: "   " }, () => {
      assert.equal(inboundAgentId(), null);
      assert.deepEqual(configuredAgentIds(), ["out-1"]);
    });
  });

  test("an inbound agent with no outbound one still yields a list", () => {
    withEnv({ BOLNA_AGENT_ID: undefined, BOLNA_INBOUND_AGENT_ID: "in-1" }, () => {
      assert.equal(configuredAgentId(), null);
      assert.deepEqual(configuredAgentIds(), ["in-1"]);
    });
  });
});

describe("the inbound agent is never used to dial out", () => {
  test("the queue dials with the outbound agent only", () => {
    // Dialling a list from the agent whose greeting is written for somebody
    // who called US would open every call with the wrong sentence.
    const src = read("src/app/api/voice/queue/route.ts");
    assert.match(src, /configuredAgentId\(\)/);
    assert.doesNotMatch(src, /inboundAgentId\(/);
  });

  test("call history reads both agents", () => {
    const src = read("src/lib/voice/overview.ts");
    assert.match(src, /configuredAgentIds\(\)/);
  });
});

describe("the variable is documented where someone will find it", () => {
  for (const f of [".env.example", ".env"]) {
    test(`${f} explains why a second agent exists`, () => {
      const src = read(f);
      assert.match(src, /BOLNA_INBOUND_AGENT_ID=/);
      assert.match(src, /welcome message|greet both directions|dialled us/i);
    });
  }
});
