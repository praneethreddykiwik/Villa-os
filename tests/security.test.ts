import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { after, describe } from "node:test";
import { cleanup, isolate } from "./helpers";

/**
 * Security regressions.
 *
 * Each test here pins a defect found by the audit. They are deliberately a mix
 * of behavioural checks and source assertions: a permission gate on a Next.js
 * route handler cannot be invoked without a request context, but the constant it
 * guards on can be read, and reading it catches the regression that matters —
 * someone loosening the permission back to a read scope.
 */

const dir = isolate("security");
after(() => cleanup(dir));

// The suite is compiled into .test-build/ before it runs, so __dirname points
// there rather than at the repo. npm test always runs from the project root.
const ROOT = process.cwd();
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

const { requireWorkerSecret, AuthError, readMustChangePassword } =
  require("../src/lib/auth/session") as typeof import("../src/lib/auth/session");

describe("secrets never ship in tracked files", () => {
  test(".env.example contains no live credential", () => {
    const text = read(".env.example");
    const live = text
      .split("\n")
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => l.split("=").slice(1).join("=").trim())
      // An obvious placeholder is not a leak. Only flag a password that is not
      // one of the words a template uses to mean "put yours here".
      .filter((v) => /^(eyJ[\w-]{20,}|sk-[\w-]{20,}|gsk_[\w-]{20,}|AIza[\w-]{20,})$/.test(v)
        || (/^postgres(ql)?:\/\/[^:]+:([^@]{4,})@/.exec(v)?.[2] !== undefined
            && !/^(PASSWORD|YOUR[-_]?PASSWORD|CHANGE[-_]?ME|password)$/i.test(
                 /^postgres(ql)?:\/\/[^:]+:([^@]{4,})@/.exec(v)![2])));
    assert.deepEqual(live, [], "a real key or password is sitting in the tracked template");
  });

  test("no plaintext staff password sits anywhere in the repo tree", () => {
    // The audit found a scratch script at the repo root holding all seven
    // account passwords, un-gitignored.
    const suspects = fs
      .readdirSync(ROOT)
      .filter((f) => /\.(mjs|js|ts|json|txt|env.*)$/.test(f) && !f.startsWith("."));
    for (const f of suspects) {
      const body = fs.readFileSync(path.join(ROOT, f), "utf8");
      assert.ok(
        !/@glentree\.com["'\s,]+["'][A-Za-z0-9]{16,}["']/.test(body),
        `${f} appears to pair a staff address with a plaintext password`,
      );
    }
  });
});

describe("shared secrets are not published", () => {
  test("no tracked file ships a working WORKER_SECRET default", () => {
    // package.json, README.md and docs/OPS_WORKFLOW.md all carried the literal
    // "dev-secret", which was also the value actually in use — so the only
    // authentication on two unauthenticated cron endpoints was public.
    for (const f of ["package.json", "README.md", "docs/OPS_WORKFLOW.md", ".env.example"]) {
      assert.ok(!read(f).includes("dev-secret"), `${f} publishes a working shared secret`);
    }
  });
});

describe("secrets at rest are not world-readable", () => {
  test("the JSON store is written 0600, not the default 0644", () => {
    // It holds plaintext OAuth access and refresh tokens plus customer PII.
    const src = read("src/lib/db.ts");
    // Match to the end of the statement rather than the first ")", which lands
    // inside JSON.stringify() and hides the options object.
    const writes = [...src.matchAll(/fs\.writeFileSync\(.*?\);/gs)].map((m) => m[0]);
    assert.ok(writes.length > 0, "expected the store to write files");
    for (const w of writes) {
      assert.match(w, /mode:\s*0o600/, `write without an explicit mode: ${w.slice(0, 90)}`);
    }
    assert.match(src, /mkdirSync\([^)]*mode:\s*0o700/s, "the data directory must not be traversable by others");
  });
});

describe("redirects cannot leave the application", () => {
  test("safeNext rejects backslash and protocol-relative targets", () => {
    const src = read("src/app/(auth)/signin/actions.ts");
    // "/\\evil.example" resolves as protocol-relative in browsers, exactly like "//".
    assert.match(src, /startsWith\("\/\\\\"\)/, "backslash-prefixed targets must be rejected");
  });
});

describe("errors do not leak internals", () => {
  test("the ops error helper returns a reference, not the raw message", () => {
    const src = read("src/lib/ops/http.ts");
    assert.ok(!/error:\s*message\s*\}/.test(src), "raw Error.message must not reach the client");
    assert.match(src, /ref/, "a correlation id should replace the internal detail");
  });
});

describe("the setup page is not public", () => {
  test("/setup is not in PUBLIC_PATHS", () => {
    const src = read("src/middleware.ts");
    const block = src
      .split("const PUBLIC_PATHS")[1]
      .split("]")[0]
      .replace(/\/\/.*$/gm, ""); // the explanation names the path; the array must not
    assert.ok(!/"\/setup"/.test(block), "it enumerates which secrets are unset — that is a target list");
  });
});

describe("workspace scoping comes from the session, not the query string", () => {
  for (const [file, param] of [
    ["src/app/api/ops/loan/route.ts", "officerId"],
    ["src/app/api/ops/sales/route.ts", "memberId"],
  ] as const) {
    test(`${param} cannot be chosen by a non-admin caller`, () => {
      const code = read(file).replace(/\/\/.*$/gm, "");
      // The broken shape read the parameter FIRST — `get(param) ?? (isAdmin ? ...)`
      // — so the session fallback never ran and any role could name a colleague.
      // The parameter read must sit INSIDE the admin branch, i.e. after it.
      const roleAt = code.indexOf('session.role === "ADMIN"');
      const paramAt = code.indexOf(`searchParams.get("${param}")`);
      assert.ok(roleAt !== -1, "the role check must be present");
      assert.ok(paramAt !== -1, "the parameter is still read for admins");
      assert.ok(paramAt > roleAt, "the query parameter must be read only after the role check");
    });
  }
});

describe("authentication fails closed", () => {
  test("requireWorkerSecret refuses when WORKER_SECRET is unset", async () => {
    const saved = process.env.WORKER_SECRET;
    delete process.env.WORKER_SECRET;
    await assert.rejects(
      () => requireWorkerSecret(new Request("http://local/api/publish/tick?secret=anything")),
      (e: unknown) => e instanceof AuthError && e.status === 503,
      "a missing worker secret must fail closed, not skip the check",
    );
    if (saved !== undefined) process.env.WORKER_SECRET = saved;
  });

  test("requireWorkerSecret rejects a wrong secret", async () => {
    process.env.WORKER_SECRET = "correct-horse-battery-staple";
    await assert.rejects(
      () => requireWorkerSecret(new Request("http://local/x?secret=wrong")),
      (e: unknown) => e instanceof AuthError && e.status === 401,
    );
  });

  test("the publish tick uses requireWorkerSecret, not an inline conditional", () => {
    const src = read("src/app/api/publish/tick/route.ts");
    assert.ok(src.includes("requireWorkerSecret"), "tick must use the fail-closed helper");
    assert.ok(
      !/if\s*\(\s*process\.env\.WORKER_SECRET\s*&&/.test(src),
      "the inline check skipped verification entirely when the env var was absent",
    );
  });

  test("the WhatsApp webhook rejects unsigned traffic when the app secret is absent", () => {
    const src = read("src/app/api/webhooks/whatsapp/route.ts");
    assert.ok(
      !/if\s*\(!secret\)\s*return true/.test(src),
      "an unconfigured webhook must reject, not trust — the path is exempt from the session gate",
    );
    assert.ok(/if\s*\(!secret\)\s*return false/.test(src));
  });
});

describe("write routes require write permissions", () => {
  const gate = (file: string) =>
    [...read(file).matchAll(/guard\("([a-z.]+)"\)/g)].map((m) => m[1]);

  test("/api/actions cannot be driven with a read-only permission", () => {
    // It pauses live ads, moves Meta budget and boosts posts.
    const perms = gate("src/app/api/actions/route.ts");
    assert.ok(!perms.includes("analytics.view"), "analytics.view is the read-only reporting scope");
    assert.ok(perms.includes("marketing.publish"));
  });

  test("/api/crm/leads writes require customers.write", () => {
    const src = read("src/app/api/crm/leads/route.ts");
    for (const method of ["PATCH", "POST"]) {
      const body = src.split(`export async function ${method}`)[1]?.slice(0, 200) ?? "";
      assert.match(body, /guard\("customers\.write"\)/, `${method} must require a write permission`);
    }
    const get = src.split("export async function GET")[1]?.slice(0, 200) ?? "";
    assert.match(get, /guard\("customers\.read"\)/, "GET should stay on the read permission");
  });

  test("/api/render requires the same permission as the library it writes to", () => {
    assert.ok(gate("src/app/api/render/route.ts").includes("marketing.publish"));
  });
});

describe("credentials never reach the browser", () => {
  test("the composer page allowlists connection fields instead of stripping them", () => {
    const src = read("src/app/(app)/composer/page.tsx");
    assert.ok(
      !/\.\.\.c,\s*\n\s*accessToken: undefined/.test(src),
      "spread-and-strip leaks every field added to Connection later — refreshToken did exactly that",
    );
    // Strip comments first — the explanation of the bug names the field.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/refreshToken/.test(code), "no token field may be serialised into client props");
    assert.ok(!/accessToken/.test(code), "no token field may be serialised into client props");
  });

  test("the composer's prop type cannot accept a full Connection", () => {
    const src = read("src/components/composer.tsx");
    assert.ok(
      !/connections:\s*Array<Connection\s*&/.test(src),
      "requiring the full Connection forces the server to hand over the secrets too",
    );
    assert.match(src, /Pick<Connection,/);
  });
});

describe("a reply is addressed to the verified sender, not a display string", () => {
  test("the WhatsApp send route never derives the recipient from conv.author", () => {
    // conv.author is "profile name (wa_id)" and the profile name is chosen by
    // the customer. A customer whose WhatsApp name was another phone number put
    // that number first in the string, so the old digit scan addressed the
    // reply to them instead of to the sender.
    const code = read("src/app/api/whatsapp/send/route.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, ""); // the explanation quotes the defect it forbids
    assert.ok(
      !/conv\.author\b/.test(code),
      "the recipient must not be read out of the attacker-controlled display string",
    );
    assert.match(code, /conv\.authorId/, "the reply goes to the stored verified sender id");
  });

  test("the webhook records the verified wa_id alongside the display string", () => {
    const code = read("src/app/api/webhooks/whatsapp/route.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.match(
      code,
      /authorId:\s*m\.from/,
      "the sender id must be stored at ingest — it is only trustworthy inside the signed payload",
    );
  });

  test("a conversation with no verified sender id is refused, not guessed at", () => {
    const code = read("src/app/api/whatsapp/send/route.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(
      !/\?\?\s*conv\.author/.test(code),
      "falling back to the display string reinstates the redirect for every older row",
    );
    assert.match(code, /status:\s*409/, "a missing sender id must fail closed");
  });
});

describe("the rate limiter cannot be turned into a memory or evasion primitive", () => {
  const { rateLimit, clientKey } =
    require("../src/lib/ops/ratelimit") as typeof import("../src/lib/ops/ratelimit");

  const declaredCap = (): number => {
    const m = /const MAX_WINDOWS\s*=\s*([\d_]+)/.exec(read("src/lib/ops/ratelimit.ts"));
    assert.ok(m, "the window map must declare a hard entry cap");
    return Number(m![1].replace(/_/g, ""));
  };

  test("the entry cap is a real bound, not a nominal one", () => {
    const cap = declaredCap();
    assert.ok(cap > 0 && cap <= 100_000, `an entry cap of ${cap} is not a bound`);
  });

  test("rotating the key evicts old windows instead of growing the map forever", () => {
    // The old sweep only reclaimed entries whose hit array was already empty,
    // and hits are pruned only when that same key is seen again — so a key that
    // is never repeated was never reclaimed. One entry per request, forever.
    const cap = declaredCap();
    const opts = { max: 2, windowSeconds: 3600 };

    assert.equal(rateLimit("evict:victim", opts).remaining, 1, "expected one attempt on record");

    for (let i = 0; i < cap + 50; i++) rateLimit(`evict:rotated:${i}`, opts);

    // The victim's window has been evicted by the flood, so its counter starts
    // over — that is the accepted cost of a bounded map. A surviving entry
    // would report no attempts left, and would prove nothing was reclaimed.
    assert.equal(
      rateLimit("evict:victim", opts).remaining,
      1,
      "the map kept every rotated key — it is still unbounded",
    );
  });

  test("an active lockout survives a flood of fresh keys", () => {
    const opts = { max: 1, windowSeconds: 3600, lockoutSeconds: 3600 };
    rateLimit("lock:held", opts);
    assert.equal(rateLimit("lock:held", opts).allowed, false, "expected the lockout to be set");

    for (let i = 0; i < declaredCap() + 50; i++) rateLimit(`lock:noise:${i}`, opts);

    assert.equal(
      rateLimit("lock:held", opts).allowed,
      false,
      "flooding the map must not be a way out of a lockout already earned",
    );
  });

  const withXff = (value: string) =>
    clientKey(new Request("http://local", { headers: { "x-forwarded-for": value } }));

  test("clientKey ignores the caller-supplied head of X-Forwarded-For", () => {
    // Only the hops our own proxy appended are trustworthy. Taking [0] took the
    // one entry the caller fully controls.
    assert.equal(withXff("9.9.9.9, 203.0.113.7"), "203.0.113.7");
    assert.equal(
      withXff("1.1.1.1, 203.0.113.7"),
      withXff("2.2.2.2, 203.0.113.7"),
      "rotating the forged head must not mint a fresh bucket",
    );
    assert.notEqual(
      withXff("198.51.100.4, 203.0.113.7"),
      withXff("198.51.100.4, 203.0.113.9"),
      "the trusted hop must still separate genuinely different clients",
    );
  });

  test("clientKey does not read the leftmost entry", () => {
    const code = read("src/lib/ops/ratelimit.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    assert.ok(
      !/split\(","\)\[0\]/.test(code),
      "the leftmost hop is whatever the caller typed",
    );
    assert.match(code, /TRUSTED_PROXY_HOPS/, "the proxy assumption must be stated, not implied");
  });

  test("a header cannot decide how large one map key is", () => {
    const key = withXff(`${"a".repeat(9000)}, ${"7".repeat(9000)}`);
    assert.ok(key.length <= 45, `a ${key.length}-character key came straight from a header`);
  });

  test("no forwarding header at all still yields a usable key", () => {
    assert.equal(clientKey(new Request("http://local")), "unknown");
  });
});

/**
 * Source assertions below strip comments first. The fixes they pin are
 * explained in comments that name the exact construct being forbidden, so an
 * un-stripped read would match the explanation and pass a reverted file.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the approval gate cannot be cleared by the person it gates", () => {
  const routeCode = () => stripComments(read("src/app/api/board/cards/route.ts"));

  test("a card records its author from the session, not from the payload", () => {
    const post = routeCode().split("export async function POST")[1].split("export async function")[0];
    assert.match(post, /createdBy:\s*session\.userId/, "the author must come off the session");
    assert.ok(!/createdBy:\s*body\./.test(post), "an author the caller nominates for itself is not an author");
  });

  test("the approval record is built from the session, never spread from the body", () => {
    const code = routeCode();
    assert.ok(
      !/\.\.\.body\.approval/.test(code),
      "spreading the request object let the caller set `state`, the one field the gate reads",
    );
    assert.match(code, /by:\s*session\.fullName/);
    assert.match(code, /byId:\s*session\.userId/, "the check must rest on an id, not on a display name");
    assert.match(
      code,
      /state\s*!==\s*"approved"\s*&&\s*state\s*!==\s*"rejected"/,
      "only a real decision may be asserted — 'pending' is the server's to set, on entering a gate",
    );
  });

  test("the author of a card can neither approve nor override it", () => {
    const code = routeCode();
    assert.match(
      code,
      /card\.createdBy\s*===\s*session\.userId/,
      "a sign-off its own subject can grant is not a control",
    );
    assert.match(
      code,
      /body\.force\s*===\s*true/,
      "the override is the same sign-off by another name and needs the same check",
    );
  });

  test("the free-form patch cannot write approval, authorship or the column", () => {
    const code = routeCode();
    assert.ok(
      !/Object\.assign\(card,\s*body\.patch\)/.test(code),
      "a blanket assign made `patch` a second, unguarded way into the approval record",
    );
    const block = code.split("if (body.patch)")[1].split("card.updatedAt")[0];
    for (const field of ["approval", "createdBy", "columnId", "boardId", "id"]) {
      assert.ok(
        !new RegExp(`card\\.${field}\\s*=[^=]`).test(block),
        `the patch channel must not write ${field}`,
      );
    }
  });
});

describe("a temporary password locks the API too, not only the pages", () => {
  test("requirePermission refuses a session that still holds one", () => {
    const body = stripComments(read("src/lib/auth/session.ts"))
      .split("export async function requirePermission")[1]
      .split("export async function")[0];
    assert.match(
      body,
      /session\.mustChangePassword/,
      "the layout gate only runs for pages; every API route came through here and accepted the locked session",
    );
    assert.match(body, /throw new AuthError/);
  });

  test("the two ways out of the lock are not themselves gated by it", () => {
    // Gating these would leave the account with no way to replace the password.
    for (const f of ["src/app/(auth)/signin/actions.ts", "src/app/(auth)/signin/page.tsx"]) {
      assert.ok(
        !/require(Permission|Session)\s*\(/.test(stripComments(read(f))),
        `${f} must stay reachable while the account is locked`,
      );
    }
  });
});

describe("the forced-rotation flag is not writable by the account it locks", () => {
  test("app_metadata outranks a user_metadata value the account set for itself", () => {
    // auth.updateUser({ data: ... }) writes user_metadata from the browser, so a
    // flag read from there is one the locked account can clear for itself.
    assert.equal(
      readMustChangePassword({
        app_metadata: { must_change_password: true },
        user_metadata: { must_change_password: false },
      }),
      true,
      "a self-written false must not clear an administrator's lock",
    );
    assert.equal(
      readMustChangePassword({
        app_metadata: { must_change_password: false },
        user_metadata: { must_change_password: true },
      }),
      false,
    );
  });

  test("an account provisioned before the move still falls back to the old location", () => {
    assert.equal(readMustChangePassword({ user_metadata: { must_change_password: true } }), true);
    assert.equal(readMustChangePassword({ app_metadata: {}, user_metadata: {} }), false);
    assert.equal(readMustChangePassword({}), false);
  });

  test("the account-creation route writes the flag where only the service role can", () => {
    const create = stripComments(read("src/app/api/ops/users/route.ts"))
      .split("admin.auth.admin.createUser(")[1]
      .split("});")[0];
    assert.match(create, /app_metadata:\s*\{\s*must_change_password:\s*true/);
    assert.ok(
      !/user_metadata:[^}]*must_change_password/.test(create),
      "the client-writable half of the record cannot hold a lock the client is subject to",
    );
  });

  test("resolveSession reads the flag through the one helper", () => {
    const resolve = stripComments(read("src/lib/auth/session.ts"))
      .split("export const resolveSession")[1]
      .split("export async function getSession")[0];
    assert.match(resolve, /readMustChangePassword\(data\.user\)/);
    assert.ok(!/user_metadata/.test(resolve), "only the helper's fallback may look at the client-writable copy");
  });

  test("rotating the password clears the authoritative flag, not just the legacy one", () => {
    const rotate = stripComments(read("src/app/(auth)/signin/actions.ts"))
      .split("export async function rotatePassword")[1]
      .split("export async function")[0];
    assert.match(rotate, /updateUserById/, "clearing app_metadata takes the service role");
    assert.match(
      rotate,
      /app_metadata:\s*\{\s*must_change_password:\s*false/,
      "without this the lock has no exit and the account can never sign in again",
    );
  });
});

/**
 * A handler body, comments stripped, from the first line of `function <name>(`
 * to the next top-level member of the component. Client components cannot be
 * rendered from this suite, but the branch that decides whether the screen is
 * allowed to change is right there in the source and is the thing that regressed.
 */
const handlerBody = (file: string, name: string): string => {
  const code = stripComments(read(file));
  const start = code.indexOf(`function ${name}(`);
  assert.ok(start > 0, `${name}() not found in ${file}`);
  const rest = code.slice(start);
  const end = rest.slice(1).search(/\n {2}(async function|function|const|return)\b/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

describe("the screen never reports a write the server refused", () => {
  /**
   * Each of these mutates local state after a fetch(). `guard()` answers a
   * denied write with a 401/403 whose body says `ok: false`, and fetch() treats
   * that as a perfectly ordinary resolved response — so a handler that does not
   * read it paints the success state over the refusal. The operator is then
   * looking at a reply that was never sent, a card that was never deleted or a
   * post that was never rescheduled, with nothing on screen to contradict it.
   */
  const gated: Array<[file: string, fn: string]> = [
    ["src/components/reviews-panel.tsx", "publish"],
    ["src/components/reviews-panel.tsx", "draft"],
    ["src/components/reviews-panel.tsx", "bulkDraft"],
    ["src/components/suggestion-card.tsx", "act"],
    ["src/components/calendar-view.tsx", "drop"],
    ["src/components/board-view.tsx", "removeCard"],
    ["src/components/board-view.tsx", "addColumn"],
    ["src/components/inbox.tsx", "sync"],
    ["src/components/connect-panel.tsx", "sync"],
    ["src/components/crm/tasks-list.tsx", "generate"],
  ];

  for (const [file, fn] of gated) {
    test(`${file.split("/").pop()} ${fn}() checks the response before it changes the UI`, () => {
      const body = handlerBody(file, fn);
      assert.match(
        body,
        /!res\.ok\s*\|\|\s*!json\.ok/,
        "both halves matter: the status catches a redirect or an empty error page, and ok:false catches a refusal that still returned 200",
      );
      const refused = body.slice(body.search(/!res\.ok\s*\|\|\s*!json\.ok/));
      assert.ok(
        /return;/.test(refused) || /\(previous\)/.test(refused),
        "the refused path must stop before the success state, or put back what it changed optimistically",
      );
    });
  }

  test("publishing a review reply only marks the row replied after the server confirms it", () => {
    const body = handlerBody("src/components/reviews-panel.tsx", "publish");
    const guard = body.search(/!res\.ok\s*\|\|\s*!json\.ok/);
    const claim = body.indexOf("replied: true");
    assert.ok(claim > guard && guard > 0, "the green 'Replied' badge must sit behind the check, not in front of it");
  });

  test("an optimistic move is rolled back when the server refuses it", () => {
    // These two change the screen before the request goes out, so the check has
    // to restore the previous state as well as report the failure — otherwise
    // the card stays deleted and the column stays added until a reload.
    for (const [file, fn, restore] of [
      ["src/components/calendar-view.tsx", "drop", "setLocal(previous)"],
      ["src/components/board-view.tsx", "removeCard", "setCards(previous)"],
      ["src/components/board-view.tsx", "addColumn", "setBoard(previous)"],
    ] as Array<[string, string, string]>) {
      assert.ok(handlerBody(file, fn).includes(restore), `${fn}() must roll back with ${restore}`);
    }
  });
});

describe("a refusal is never dressed as a success by the API helper", () => {
  /** Every `ok(...)` call in a file, with the status it was given, if any. */
  const okCallStatuses = (code: string): number[] => {
    const found: number[] = [];
    for (const m of code.matchAll(/ok\(/g)) {
      const before = code[m.index! - 1] ?? " ";
      if (/[A-Za-z0-9_.]/.test(before)) continue; // apiOk(, json.ok, result.ok
      let depth = 0;
      let i = m.index! + m[0].length - 1;
      for (; i < code.length; i++) {
        if (code[i] === "(") depth++;
        else if (code[i] === ")" && --depth === 0) break;
      }
      const status = /,\s*(\d{3})\s*$/.exec(code.slice(m.index! + m[0].length, i));
      if (status) found.push(Number(status[1]));
    }
    return found;
  };

  test("ok() has a counterpart that sets ok:false", () => {
    const src = read("src/lib/ops/http.ts");
    assert.match(src, /export function fail\(/, "a 4xx needs a helper of its own, or callers reach for ok()");
    assert.match(src, /\{\s*ok:\s*false,\s*error\s*\}/, "the body has to disagree with success, not just the status line");
  });

  test("no ops route returns a 4xx or 5xx through ok()", () => {
    // `ok({ error: "Missing permission" }, 403)` emits { ok: true, error: ... }.
    // Every client in this app decides success by reading json.ok, so the
    // checklist editor, the case controls and the customer controls all showed
    // a permission denial as a completed write.
    const dir = path.join(ROOT, "src/app/api/ops");
    const routes = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => `src/app/api/ops/${e.name}/route.ts`)
      .filter((p) => fs.existsSync(path.join(ROOT, p)));
    assert.ok(routes.length > 0, "expected the ops routes to be there");
    for (const route of routes) {
      for (const status of okCallStatuses(stripComments(read(route)))) {
        assert.ok(status < 300, `${route} returns ${status} through ok(), which flags it ok: true`);
      }
    }
  });
});

describe("client props carry no more than the screen draws", () => {
  test("the pipeline board is handed named lead fields, not the lead record", () => {
    const component = stripComments(read("src/components/crm/pipeline.tsx"));
    assert.ok(
      !/leads:\s*Lead\[\]/.test(component),
      "asking for Lead makes the server serialise the buyer's phone, email and notes into a board that renders none of them",
    );
    assert.match(component, /Pick<\s*[\s\S]*?Lead,/, "name the columns the board draws");

    // The prop type alone cannot stop this: Lead satisfies PipelineLead, so a
    // page handing over the whole row still compiles. The page has to rebuild
    // the object field by field, which is what actually leaves the PII behind.
    const page = stripComments(read("src/app/(app)/crm/pipeline/page.tsx"));
    assert.match(page, /PipelineLead\[\]/, "the page must state the narrowed shape it is handing over");
    assert.match(page, /\.map\(\(l\) => \(\{/, "the row has to be rebuilt, not passed through");
    for (const field of ["phone", "email", "notes"]) {
      assert.ok(!new RegExp(`\\b${field}\\b`).test(page), `${field} must not reach the client props`);
    }
  });
});

describe("a sign-in lockout cannot be aimed at somebody else's account", () => {
  const buckets = () =>
    [...stripComments(read("src/app/(auth)/signin/actions.ts")).matchAll(
      /rateLimit\(\s*`([^`]+)`\s*,\s*\{([^}]*)\}/g,
    )].map((m) => ({
      key: m[1],
      max: Number(/max:\s*(\d+)/.exec(m[2])?.[1] ?? 0),
      lockout: Number(/lockoutSeconds:\s*(\d+)/.exec(m[2])?.[1] ?? 0),
    }));

  test("the tight bucket is keyed on the account *and* the source", () => {
    const account = buckets().filter((b) => b.key.includes("${email}"));
    assert.ok(account.length > 0, "the fix is not to stop counting failed attempts per account");
    assert.ok(
      account.some((b) => b.key.includes("${source}")),
      "a tight lock an unauthenticated caller fills by typing a colleague's address is a denial of service with a lock on it",
    );
  });

  test("no account-wide bucket can hold a named account shut", () => {
    const wide = buckets().filter((b) => b.key.includes("${email}") && !b.key.includes("${source}"));
    for (const b of wide) {
      assert.ok(b.lockout > 0, `${b.key} falls back to windowSeconds for its lockout, which is far longer`);
      assert.ok(
        b.lockout <= 120,
        `${b.key} locks for ${b.lockout}s — long enough to be worth aiming at somebody by name`,
      );
    }
  });

  test("the account-wide ceiling is still a ceiling", () => {
    // Raising max until nobody ever trips it is the same as deleting the bucket,
    // and deleting it lets a spray rotate source addresses without limit.
    const wide = buckets().filter((b) => b.key.includes("${email}") && !b.key.includes("${source}"));
    assert.ok(wide.length > 0, "something must still count attempts across all sources");
    for (const b of wide) assert.ok(b.max > 0 && b.max <= 200, `max: ${b.max} is not a limit`);
  });
});

describe("authentication events are recorded", () => {
  const { logAuthEvent } = require("../src/lib/auth/audit") as typeof import("../src/lib/auth/audit");

  const capture = (fn: () => void): string[] => {
    const lines: string[] = [];
    const info = console.info;
    const warn = console.warn;
    console.info = (...a: unknown[]) => void lines.push(a.join(" "));
    console.warn = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      fn();
    } finally {
      console.info = info;
      console.warn = warn;
    }
    return lines;
  };

  test("the event line carries the address, the outcome and the source key", () => {
    const [line] = capture(() =>
      logAuthEvent({ method: "password", outcome: "failure", email: "kiran@glentree.com", source: "203.0.113.7" }),
    );
    assert.match(line, /outcome=failure/);
    assert.match(line, /kiran@glentree\.com/);
    assert.match(line, /203\.0\.113\.7/);
  });

  test("a crafted address cannot forge a second entry", () => {
    const [line] = capture(() =>
      logAuthEvent({
        method: "password",
        outcome: "failure",
        email: 'x@y.z"\noutcome=success email="admin@glentree.com',
        source: "203.0.113.7",
      }),
    );
    assert.equal(line.split("\n").length, 1, "an address with a newline in it wrote its own audit entry");
  });

  test("sign-in records every outcome, and never the credential", () => {
    const body = stripComments(read("src/app/(auth)/signin/actions.ts"))
      .split("export async function signInWithPassword")[1]
      .split("\nexport async function")[0];
    for (const outcome of ["throttled", "failure", "success"]) {
      assert.ok(
        new RegExp(`outcome: "${outcome}"`).test(body),
        `a ${outcome} sign-in leaves no record at all`,
      );
    }
    for (const call of body.match(/logAuthEvent\([^;]*;/g) ?? []) {
      // Drop string literals first: "password" is the name of the method here,
      // not a value being logged.
      assert.ok(
        !/\bpassword\b/.test(call.replace(/"[^"]*"/g, '""')),
        `a credential reached the log: ${call.slice(0, 80)}`,
      );
    }
  });

  test("a successful sign-in stamps the column the team screen renders", () => {
    const body = stripComments(read("src/app/(auth)/signin/actions.ts"))
      .split("export async function signInWithPassword")[1]
      .split("\nexport async function")[0];
    assert.match(body, /stampLastLogin\(/, "profiles.last_login_at was displayed as 'never' for every account");
    assert.match(stripComments(read("src/lib/auth/audit.ts")), /last_login_at/);
  });
});

describe("activity entries name the person who caused them", () => {
  const callers = [
    "src/app/api/actions/route.ts",
    "src/app/api/posts/route.ts",
    "src/app/api/board/route.ts",
    "src/app/api/board/cards/route.ts",
    "src/app/api/crm/leads/route.ts",
    "src/app/api/connections/route.ts",
    "src/app/api/connections/callback/route.ts",
  ];

  test("no write route files its entry under an anonymous actor", () => {
    for (const file of callers) {
      const calls = stripComments(read(file)).match(/logActivity\([^;]*;/g) ?? [];
      assert.ok(calls.length > 0, `${file} no longer logs activity — has the call moved?`);
      for (const call of calls) {
        assert.ok(
          !/,\s*"user"\s*\);$/.test(call),
          `${file} still records the literal "user", which answers nothing: ${call.slice(0, 70)}`,
        );
        assert.match(
          call,
          /actor/,
          `${file} logs an entry nobody can be asked about: ${call.slice(0, 70)}`,
        );
      }
    }
  });

  test("the actor label is an identifier, not a display name", () => {
    const { actorLabel } = require("../src/lib/auth/session") as typeof import("../src/lib/auth/session");
    const person: import("../src/lib/auth/session").Session = {
      userId: "profile-1",
      email: "kiran@glentree.com",
      fullName: "Kiran Rao",
      orgId: "org-1",
      roles: [],
      permissions: new Set(),
      mustChangePassword: false,
    };
    assert.equal(actorLabel(person), "kiran@glentree.com", "two people can share a display name");
    assert.notEqual(actorLabel(null), "system", "a person's action must not be filed as the machine's");
  });
});

describe("a control that cannot fail is not a control", () => {
  const { MAP_FOR_TEST } =
    require("../src/lib/auth/permissions-test-view") as { MAP_FOR_TEST: Record<string, string> };

  test("no two legacy permission names collapse onto one real permission", () => {
    // document:download mapped to documents.read, exactly as document:read did,
    // so the download handler's advertised "second lock" could never deny anyone.
    const seen = new Map<string, string>();
    for (const [legacy, mapped] of Object.entries(MAP_FOR_TEST)) {
      const first = seen.get(mapped);
      assert.equal(first, undefined, `${legacy} and ${first} are one permission wearing two names`);
      seen.set(mapped, legacy);
    }
  });

  test("the test view still describes the table the application uses", () => {
    const shipped = stripComments(read("src/lib/ops/auth.ts"));
    const real = [...shipped.matchAll(/"([a-z]+:[a-z]+)":\s*"([a-z.]+)"/g)].map((m) => m[1]);
    assert.deepEqual(
      real.sort(),
      Object.keys(MAP_FOR_TEST).sort(),
      "the assertions above are worthless if the view has drifted from the real map",
    );
  });

  test("the download handler no longer makes a check that cannot fail", () => {
    const code = stripComments(read("src/app/api/ops/documents/route.ts"));
    assert.ok(
      !/can\(session,\s*"document:download"\)/.test(code),
      "it re-tested the permission authorize() had already required on the line above",
    );
    assert.match(
      code,
      /verifyDocumentRef\(id,\s*session\.memberId,/,
      "the lock that is real — a member-bound signature that expires — must stay",
    );
  });
});

describe("records are filed under a real brand", () => {
  test("a post cannot be created orphaned", () => {
    // /api/posts took body.brandId verbatim. A caller omitting it wrote
    // brandId: undefined — a record matching no brand, so invisible on the
    // calendar, the queue and every analytics screen — while the response
    // still said ok:true. Direct API callers and n8n both hit this path.
    const src = read("src/app/api/posts/route.ts").replace(/\/\/.*$/gm, "");
    assert.match(src, /resolveBrandId\(/, "the brand must be resolved, not trusted from the body");
    assert.ok(
      !/brandId:\s*body\.brandId/.test(src),
      "the unresolved body value must not be written onto the record",
    );
  });
});
