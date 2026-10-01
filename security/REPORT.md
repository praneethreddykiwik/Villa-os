# Security Report
Target: Villa-os (`glentree-social`) · Date: 2026-09-24 · Scope: static review + remediation, plus live probes against the owner's own production and Supabase project

## Executive summary

Eight code-level defects were fixed and each is pinned by a regression test that fails when the fix is reverted (verified by reverting three of them and observing the failures). The application's security foundations are genuinely strong — default-deny middleware, DB-driven RBAC that throws rather than returns, constant-time webhook secrets that fail closed, a per-request CSP nonce, and zero `dangerouslySetInnerHTML` anywhere in 106k lines. **The one thing to fix today is not in the code: both GitHub repositories are public and, until this pass, contained a 7-character password that was set on all seven staff accounts with rotation disabled. The scripts are fixed, but the password is still live and still in git history.**

## Findings

### SEC-001 Default staff password committed to two public repositories
Severity: **Critical**
Location: `scripts/recreate-all-users.mjs:6,37`, `scripts/set-simple-passwords.mjs:5,12`
Impact: The literal `tree123` was the password for all seven staff accounts, including `admin@glentree.com`, with `must_change_password: false`. Both `koushik1133/glen-villa-final` and `praneethreddykiwik/Villa-os` return HTTP 200 unauthenticated, so anyone who found either repo had working admin credentials for the platform — which holds real customer names, phone numbers and conversation history.
Reproduction: Clone either public repo, read the literal, sign in at `/signin`.
Fix: Both scripts now take `STAFF_PASSWORD` from the environment or generate 20 random characters from a `crypto.randomBytes` alphabet, refuse anything under 12 characters, set `must_change_password: true`, and write the credential to the gitignored `.provisioned-credentials.txt` (mode 600) instead of printing it to stdout.
Verification: `tests/security.test.ts` — "provisioning scripts carry no credential" asserts no default literal, no `must_change_password: false`, and that `STAFF_PASSWORD` is honoured.
Status: **Code fixed. Operationally still OPEN** — see *Actions still required*.

### SEC-002 `GET /api/automation/workflow-url` had no permission check
Severity: **Medium**
Location: `src/app/api/automation/workflow-url/route.ts:9`
Impact: The n8n workflow URL carries its own embedded token: anyone holding it can post into the publishing pipeline without authenticating to this app. `POST` required `marketing.publish`; `GET` required nothing beyond a session, so every provisioned account — front desk, contractor, intern — could read it out.
Root cause worth noting: the security sweep at `tests/security.test.ts:877` greps the whole file, so the correctly-gated `POST` satisfied the check for the ungated `GET`. **The test was green the entire time.**
Fix: `GET` now calls `requirePermission("marketing.read")`.
Verification: Reverted the guard → `GET requires a permission, not merely a session` fails, and the new per-method sweep fails it by name.
Status: Fixed

### SEC-003 File-level permission sweep could not see a missing per-method check
Severity: **Medium** (this is what allowed SEC-002 to ship)
Location: `tests/security.test.ts:877-926`
Impact: Any route that guards one method and forgets another passes CI.
Fix: Added a per-method sweep that splits each route file at its exported handlers and requires each to carry its own check. This added 71 new assertions and immediately flagged two more routes — `osf/instagram` and `osf/whatsapp` `GET`. Both were investigated and are **legitimate**: they are the Meta webhook subscription handshake, authenticated by `verifyChallenge` (`src/lib/osf/whatsapp/verify.ts:58`), which compares the verify token in constant time and returns 403 when it is absent, wrong or unconfigured. `verifyChallenge` was added to the recognised-mechanism list because it *is* an authentication mechanism, not to make a test pass.
Status: Fixed

### SEC-004 `assertBrandAccess` performed no scoping
Severity: **Medium** (rated High in the initial audit; lowered — see note)
Location: `src/lib/auth/session.ts:313`
Impact: The function looked the brand up, then only asserted `session.orgId` was truthy. It never related the two, so any signed-in user passed for any brand id.
Why the fix is not a one-line comparison: `Brand.workspaceId` is a local JSON-store id and `session.orgId` is a Supabase `organizations.id`. They are deliberately different namespaces (documented at `src/lib/ops/seed.ts:60-66`). Comparing them directly *looks* like scoping but denies every request and breaks the application.
Fix: The brand's workspace must exist in this deployment, and a deployment with more than one workspace now throws rather than waving everyone through — so whoever adds the second workspace is forced to add the org→workspace mapping instead of silently inheriting an open door.
Severity note: this deployment has exactly one workspace and one brand, so there is no second tenant to cross into today. The defect was that the function claimed an invariant it did not enforce.
Verification: `tests/security.test.ts` — "brand access is scoped, and refuses when it cannot be", including an assertion that the naive namespace comparison is *not* used.
Status: Fixed

### SEC-005 Mass assignment on customer profile edits
Severity: **Medium**
Location: `src/app/api/ops/customers/route.ts` (PATCH), `src/lib/ops/customers.ts:119`
Impact: `body.patch` — an arbitrary object from the network — was forwarded whole into `updateCustomer`, which stripped three fields and `Object.assign`ed the rest. Every field not named was writable, including `optedOut` (a profile edit could un-opt-out someone who asked to be left alone, which is a consent violation as well as a security one), both AI control lanes (handing a paused thread back to the AI mid-conversation), and `leadScore`. It also failed open over time: each new field added to `Customer` became remotely writable the moment it was declared.
Fix: An explicit allowlist at the request boundary. Deliberately kept the denylist inside `updateCustomer` as defence in depth rather than moving the allowlist there — `setStage()` and `setControl()` are internal callers that legitimately pass exactly the restricted fields, so an allowlist inside that function would have broken stage transitions.
Verification: Reverted to `body.patch` → "the patch is filtered before it reaches updateCustomer" fails. A second test asserts the six dangerous fields are absent from the allowlist.
Status: Fixed

### SEC-006 Hand-rolled rate limiter with spoofable, unbounded key
Severity: **Medium**
Location: `src/app/api/ops/session/route.ts:15-30`
Impact: A private `Map` keyed on the raw leftmost `x-forwarded-for` value. The header is caller-written, so the key was attacker-chosen: rotating it walked straight past the limit, and the map had no bound, so a flood of invented values grew it until the instance ran out of memory. These are the exact two defects `tests/security.test.ts:516,562` forbid everywhere else — this route simply had its own copy those tests never looked at.
Fix: Replaced with the shared `rateLimit()` + `clientKey()`, which reads the trusted proxy hop, bounds the key to address characters, evicts rotated keys and preserves active lockouts under load.
Verification: `tests/security.test.ts` — "session introspection uses the shared rate limiter", asserting both the absence of a private Map and the absence of a raw header read.
Status: Fixed

### SEC-007 Customer phone numbers written to production logs
Severity: **Low**
Location: `src/app/api/osf/evolution/route.ts:302`, `src/app/api/osf/instagram/route.ts:127`, `src/app/api/osf/whatsapp/route.ts:136,175`
Impact: Full E.164 phone numbers and Instagram sender ids in stdout. Vercel ships and retains logs, so these are customer contact details accumulating in a system nobody is treating as a customer database — and log access is broader than database access.
Fix: New `src/lib/osf/redact.ts` with `maskPhone`/`maskId`, keeping the country code and last four digits so a skipped reply can still be matched to a thread. Debuggability was the reason the numbers were there; removing them outright would have traded one problem for another.
Verification: `tests/security.test.ts` — "customer identifiers are masked in logs" scans every `console.log` in the three routes for raw interpolations, plus a unit test that `maskPhone("919876543210")` ends in `3210` and does not contain `98765`.
Status: Fixed

### SEC-008 Upstream error detail returned to non-admin roles
Severity: **Low**
Location: `src/app/api/osf/ai/copilot/route.ts:57,75`; `osf/marketing/{broadcasts,templates,mark-ready}/route.ts`
Impact: Raw PostgREST/Postgres messages naming tables, columns and constraints, plus LLM-provider errors that can echo the request body.
Scope correction: The initial audit listed ~14 routes. On checking the live `role_permissions` table, most are reachable only by `admin` (`workflows.manage` is granted to `admin` alone), and an administrator already knows their own infrastructure. Only the copilot (`analytics.view` → `admin`, `audit`) and marketing routes (`marketing.publish` → `admin`, `marketing`) reach a non-admin role. Those were fixed; the admin-only diagnostics keep their detail deliberately, because that detail is the feature.
Fix: New `errorRef()` helper in `src/lib/auth/http.ts` logs the stack server-side and returns only a correlation id.
Status: Fixed (scoped)

### SEC-009 Middleware carve-out was a prefix, not an exact path
Severity: **Low**
Location: `src/middleware.ts:358`
Impact: Two video upload routes are excluded from the session gate and security headers for streaming latency. Unanchored, the exclusion was a prefix match, so a future `post-video-callback` or `post-video/debug` would silently inherit it and ship with no session gate — and nothing in the suite inspects the matcher, so CI would stay green.
Fix: Anchored both exclusions with `$`, and documented why the carve-out exists and why the anchor matters. The routes themselves were left excluded — both call `requirePermission("marketing.publish")` in-route, and folding multi-megabyte uploads through an edge session round-trip was a deliberate performance decision.
Verification: Removed the anchors → "each excluded path is anchored" fails.
Status: Fixed

## Withdrawn finding

### SEC-010 `assertCustomerAccess` "bypass" — NOT A VULNERABILITY
The initial audit reported that `assertCustomerAccess` (`src/lib/auth/session.ts:301`) returning early on `analytics.view` was a blanket authorization bypass, on the stated basis that the permission is "held by admin, audit and every dashboard-class role".

That premise was wrong. Queried against the live `role_permissions` table, `analytics.view` is granted to exactly two roles: **`admin` and `audit`**. The seed defines audit as "broad read, no write, no publishing" — broad customer read is its designed purpose — and the code comment `// managers and admins` is accurate.

No change made. Reported here rather than quietly dropped, because a withdrawn finding is as much a part of an honest audit as a confirmed one.

## Accepted risks

| Risk | Owner | Reason | Review date |
|---|---|---|---|
| `postcss` ≤8.5.22 (**high**) via Next's bundled copy (8.4.31) | Eng | Not reachable. The CVEs require attacker-controlled CSS (`sourceMappingURL` in comments, unescaped `</style>` in stringify output). This app compiles only its own Tailwind at build time; there is no user-supplied CSS, no runtime CSS processing, and **zero `dangerouslySetInnerHTML` in the codebase**. The direct dependency is already patched at 8.5.26. The only fix is Next 16, a major migration that must not be bundled into a security pass untested. | 2026-12-24 |
| `@anthropic-ai/sdk` 0.79–0.91 (moderate) | Eng | Not reachable. The advisory is insecure default file permissions in the **Local Filesystem Memory Tool**; the app uses `messages.create` only and never instantiates that tool (`grep` for `memory_20`/`LocalFilesystem` returns nothing). Fix is 0.128, a breaking change. | 2026-12-24 |
| Bolna webhook secret travels in the query string | Eng | The provider's dashboard offers a URL field and no way to set a header. The alternative was a reverse proxy standing up purely to inject one, and until somebody did, every completed call was silently dropped. Documented at `src/app/api/webhooks/bolna/route.ts:30-46`; header is still preferred and read first. | 2027-03-24 |
| Two video upload routes outside the middleware matcher | Eng | Deliberate: multi-megabyte streaming bodies. Both authenticate in-route. Exclusion now anchored so it cannot widen silently. | 2026-12-24 |

## Actions still required — these cannot be done from the codebase

1. **Make both repositories private.** `koushik1133/glen-villa-final` and `praneethreddykiwik/Villa-os` both return HTTP 200 unauthenticated.
2. **Rotate all seven staff passwords.** The scripts no longer contain a default, but `tree123` is still the live password on every account and remains in git history — fixing the file does not unpublish it. Run `node scripts/set-simple-passwords.mjs`, which now generates a strong password, forces rotation and writes it to the gitignored credentials file.
3. **Rotate `EVOLUTION_API_KEY`.** It was transmitted in chat and the instance is live (`state: open`).
4. **Purge the password from git history** in both remotes after rotating. Removing it from HEAD is not a fix; every clone and fork still has it.
5. **Schedule the Next 16 upgrade** to clear the postcss advisory, with a full regression run.

## Not tested

- The external VPS application that owns the Evolution inbound webhook — outside this repository.
- The `villa_*` Supabase schema's own RLS policies. **No DDL for these tables exists anywhere in this repo** (all seven files under `supabase/migrations/` contain zero occurrences of `villa_`), so the policies protecting live customer data could not be reviewed from source. This is itself a finding: the schema holding real customer conversations has no version control, no migration history and no review trail.
- Active penetration testing against the running host. Only read-only behavioural probes were made.
- The `.env.bak.*` and `.env.recovered` files on disk. Gitignored and never committed; not opened.

## Verification summary

```
Typecheck   0 source errors
Tests       1627 total · 1623 pass · 2 fail · 2 skipped
            Both failures pre-date this pass and are expired third-party
            credentials (Google Sheets API key, Upload-Post token), not code.
Build       Compiled successfully
Regression  3 fixes reverted individually; each failed its own test; restored.
```
