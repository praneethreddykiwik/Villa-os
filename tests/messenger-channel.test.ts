import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { autoReplyEnabled, autoReplyStatus, AUTOREPLY_CHANNELS } from "../src/lib/osf/autoreply";
import {
  MESSENGER_ID_PREFIX,
  isMessengerLeadKey,
  messengerLeadKey,
  messengerPsid,
} from "../src/lib/osf/conversation";
import { splitForMessenger, MESSENGER_CHANNEL } from "../src/lib/osf/messenger/client";
import { CHANNELS, canReplyOn, channelTextLimit, replyableChannels } from "../src/lib/osf/communication";

/**
 * Instagram and Messenger DMs, and the rule that keeps them quiet.
 *
 * The expensive failures on this feature are not crashes. They are a second
 * program answering the same customer, and a channel value Postgres rejects —
 * both of which look fine in review and only show up against a live inbox.
 * These pin both.
 */

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the sources these assertions read.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

describe("auto-reply is opt-in per channel", () => {
  const withEnv = (value: string | undefined, fn: () => void) => {
    const before = process.env.MESSAGING_AUTOREPLY_CHANNELS;
    if (value === undefined) delete process.env.MESSAGING_AUTOREPLY_CHANNELS;
    else process.env.MESSAGING_AUTOREPLY_CHANNELS = value;
    try {
      fn();
    } finally {
      if (before === undefined) delete process.env.MESSAGING_AUTOREPLY_CHANNELS;
      else process.env.MESSAGING_AUTOREPLY_CHANNELS = before;
    }
  };

  test("unset means silent on every channel", () => {
    withEnv(undefined, () => {
      for (const channel of AUTOREPLY_CHANNELS) {
        assert.equal(autoReplyEnabled(channel), false, `${channel} must not answer by default`);
      }
    });
  });

  test("empty and whitespace are silent, not permissive", () => {
    for (const value of ["", "   ", ",", " , , "]) {
      withEnv(value, () => {
        assert.equal(autoReplyEnabled("instagram"), false);
        assert.equal(autoReplyEnabled("messenger"), false);
      });
    }
  });

  test("opting one channel in does not opt the others in", () => {
    withEnv("instagram", () => {
      assert.equal(autoReplyEnabled("instagram"), true);
      assert.equal(autoReplyEnabled("messenger"), false);
    });
  });

  test("'all' is not a wildcard", () => {
    withEnv("all", () => {
      assert.equal(autoReplyEnabled("instagram"), false);
      assert.equal(autoReplyEnabled("messenger"), false);
    });
  });

  test("a misspelling fails closed rather than matching loosely", () => {
    withEnv("instgram,messengr", () => {
      assert.equal(autoReplyEnabled("instagram"), false);
      assert.equal(autoReplyEnabled("messenger"), false);
    });
  });

  test("the enum spelling and the transport spelling are the same switch", () => {
    // The database calls it `facebook`, Meta calls it Messenger. An operator
    // should not have to know which one this file wanted.
    withEnv("facebook", () => {
      assert.equal(autoReplyEnabled("messenger"), true);
      assert.equal(autoReplyEnabled("facebook"), true);
    });
    withEnv("messenger", () => {
      assert.equal(autoReplyEnabled("facebook"), true);
    });
  });

  test("case and padding do not defeat the switch", () => {
    withEnv(" Instagram , MESSENGER ", () => {
      assert.equal(autoReplyEnabled("instagram"), true);
      assert.equal(autoReplyEnabled("messenger"), true);
    });
  });

  test("the status line says what to set", () => {
    withEnv(undefined, () => {
      assert.match(autoReplyStatus("instagram"), /MESSAGING_AUTOREPLY_CHANNELS/);
    });
  });

  test("WhatsApp is governed by EVOLUTION_INBOUND, not by this switch", () => {
    // Two mechanisms would be a bug; the Evolution route refuses inbound
    // outright because another program already records those messages.
    assert.ok(!(AUTOREPLY_CHANNELS as readonly string[]).includes("whatsapp"));
    const route = read("src/app/api/osf/evolution/route.ts");
    assert.match(route, /EVOLUTION_INBOUND/);
    assert.match(route, /status:\s*410/);
  });
});

describe("both Meta webhooks pass the gate into handleInbound", () => {
  for (const [channel, file] of [
    ["instagram", "src/app/api/osf/instagram/route.ts"],
    ["messenger", "src/app/api/osf/messenger/route.ts"],
  ] as const) {
    test(`${channel} records the message but only replies when enabled`, () => {
      const src = read(file);
      assert.match(src, /autoReplyEnabled\(/, `${channel} must consult the gate`);
      assert.match(src, /reply:\s*mayReply/, `${channel} must pass the gate into handleInbound`);
      // Recording is not conditional — a silent channel still fills the inbox.
      assert.match(src, /handleInbound\(/);
    });

    test(`${channel} verifies Meta's signature before reading the body`, () => {
      const src = read(file);
      assert.match(src, /verifySignature\(/);
      assert.match(src, /status:\s*401/);
    });

    test(`${channel} ignores its own echoes`, () => {
      assert.match(read(file), /is_echo/);
    });
  }
});

describe("the channel value written to Postgres is a member of the enum", () => {
  test("Messenger writes `facebook`, which villa_comm_channel actually has", () => {
    // villa_comm_channel has no `messenger` member. Writing the transport's
    // own name would throw on the enum for every single DM.
    assert.equal(MESSENGER_CHANNEL, "facebook");
    assert.ok((CHANNELS as readonly string[]).includes(MESSENGER_CHANNEL));
  });

  test("no code path writes the literal 'messenger' as a channel", () => {
    for (const file of [
      "src/app/api/osf/messenger/route.ts",
      "src/lib/osf/conversation.ts",
      "src/lib/osf/communication.ts",
    ]) {
      assert.doesNotMatch(
        read(file),
        /channel:\s*"messenger"/,
        `${file} writes a channel value the database will reject`,
      );
    }
  });
});

describe("Messenger ids cannot be confused with Instagram ids", () => {
  test("a PSID is stored prefixed", () => {
    const key = messengerLeadKey("1234567890");
    assert.ok(key.startsWith(MESSENGER_ID_PREFIX));
    assert.notEqual(key, "1234567890");
  });

  test("the PSID survives the round trip", () => {
    assert.equal(messengerPsid(messengerLeadKey("987654321")), "987654321");
  });

  test("a bare IGSID is not mistaken for a Messenger id", () => {
    // Meta mints both as bare digit strings from overlapping ranges, so an
    // unprefixed collision would silently merge two different people.
    assert.equal(isMessengerLeadKey("1234567890"), false);
    assert.equal(messengerPsid("1234567890"), null);
    assert.equal(messengerPsid(null), null);
  });
});

describe("replying from the console", () => {
  test("Instagram and Messenger threads are replyable, email is not", () => {
    assert.ok(canReplyOn("whatsapp"));
    assert.ok(canReplyOn("instagram"));
    assert.ok(canReplyOn("facebook"));
    assert.equal(canReplyOn("email"), false);
    assert.equal(canReplyOn("web_form"), false);
  });

  test("every replyable channel is a real enum member", () => {
    for (const channel of replyableChannels()) {
      assert.ok((CHANNELS as readonly string[]).includes(channel), `${channel} is not in villa_comm_channel`);
    }
  });

  test("each transport carries its own character cap", () => {
    // Instagram truncates at 1000 server-side; a shared 4096 would let a rep
    // write a reply the customer never fully receives.
    assert.equal(channelTextLimit("whatsapp"), 4096);
    assert.equal(channelTextLimit("instagram"), 1000);
    assert.equal(channelTextLimit("facebook"), 2000);
  });

  test("templates are refused on channels that have none", () => {
    const src = read("src/lib/osf/communication.ts");
    assert.match(src, /has no message templates/);
  });

  test("the transport is chosen by the thread, not by which id is populated", () => {
    // One person can reach us on WhatsApp and Instagram and end up with both a
    // phone and an IGSID; answering the Instagram DM over WhatsApp would be a
    // reply on a channel they did not use.
    const src = read("src/lib/osf/communication.ts");
    assert.match(src, /target\.conversation\.channel === "facebook"/);
    assert.match(src, /target\.conversation\.channel === "instagram"/);
  });

  test("readiness is judged per channel", () => {
    const src = read("src/lib/osf/communication.ts");
    assert.match(src, /function sendTransportReady\(channel/);
    assert.match(src, /Instagram isn't connected/);
    assert.match(src, /Messenger isn't connected/);
  });
});

describe("Messenger text is split rather than truncated", () => {
  test("short text goes out as one message", () => {
    assert.deepEqual(splitForMessenger("hello"), ["hello"]);
  });

  test("a long reply is split, and nothing is lost", () => {
    const body = `${"a".repeat(1500)}. ${"b".repeat(1200)}`;
    const parts = splitForMessenger(body);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.ok(part.length <= 2000);
    assert.equal(parts.join("").replace(/\s/g, "").length, body.replace(/\s/g, "").length);
  });

  test("it breaks on a boundary, not mid-word", () => {
    const sentence = `${"word ".repeat(500)}\n\nsecond paragraph here`;
    const parts = splitForMessenger(sentence, 600);
    assert.ok(parts.length > 1);
    for (const part of parts) assert.equal(part, part.trim());
  });
});

describe("the webhook is reachable", () => {
  test("Messenger is exempt from the session gate, like the other webhooks", () => {
    // Meta POSTs with no cookie. Without this the verification GET is
    // redirected to /signin and Meta marks the subscription broken.
    const mw = read("src/middleware.ts");
    assert.match(mw, /"\/api\/osf\/messenger"/);
  });

  test("an unconfigured channel answers 403, never 500", () => {
    // A run of 5xxs makes Meta disable the whole subscription.
    const src = read("src/app/api/osf/messenger/route.ts");
    assert.match(src, /status:\s*403/);
    assert.match(src, /catch\s*\{\s*\n?\s*return null;/);
  });
});
