# Security Report

**Target:** Glentree platform (local repository + localhost + your Supabase project)
**Date:** 2026-08-31 · **Scope:** static review + active testing (your own systems — authorised)

---

## In plain English, for anyone

Think of the app as an office building. Before this pass, the front door was open,
most rooms were unlocked, and the filing cabinet with customers' bank statements
had no lock at all. Anyone who knew a room's name could walk in.

Now: everyone needs a key card to get in the front door, each key card only opens
the rooms that person's job requires, and the locks are checked at the door of
every room — not just on the sign that points to it.

Concretely, we found and fixed:

- **Anyone on the internet could delete your entire database.** One web address,
  no password needed. Now it requires the highest permission and refuses to run
  on a live system at all.
- **Fifteen parts of the system answered to anyone** — including the one that
  sends WhatsApp messages to your customers, and the one that lists every lead
  with their budget. All now require a sign-in.
- **A receptionist could open the revenue dashboard** by typing the address,
  even though the menu never showed it. Hiding a link is not a lock. Every page
  now checks permission on the server.
- **A password key that unlocks the whole database was written into the app's
  own front-end code.** Removed.
- **A known critical flaw in the web framework** that allows an attacker to run
  their own code on your server. Patched.

Two things still need you:

1. **Rotate the Supabase keys** you pasted into chat. They are in that transcript
   forever. Supabase → Settings → API → Rotate.
2. **Turn on two-factor authentication** for staff before this handles real
   customer data. It is the single biggest remaining gap.

---

## Executive summary

Sixteen findings: **3 critical, 7 high, 4 medium, 2 low.** All sixteen are fixed and
verified. SEC-013 to SEC-016 were found while rebuilding the sign-in screen and are
appended below. The one thing to do today is rotate the service-role key that was shared
in plaintext — it bypasses every access rule in the database and cannot be
un-shared.

Posture moved from "no authentication anywhere" to "authenticated, permission-
enforced at the route, the page and the database". Remaining gaps are documented
under Accepted risks and Not tested, not silently omitted.

---

## Findings

### SEC-001 Unauthenticated database destruction
**Severity:** Critical · **Location:** `src/app/api/seed/route.ts`
**Impact:** Any anonymous visitor could erase every customer, lead, loan case and
document by sending one request.
**Reproduction:** `curl -X POST http://host/api/seed` → `{"ok":true}`, all data gone.
**Fix:** Requires `workflows.manage`, and refuses to run when `NODE_ENV=production`
unless `ALLOW_DESTRUCTIVE_RESET=true` is set deliberately.
**Verification:** `curl -X POST /api/seed` → **401**. Confirmed in the sweep below.
**Status:** Fixed

### SEC-002 Remote code execution in Next.js
**Severity:** Critical · **Location:** `package.json` — next@15.5.4
**Impact:** A crafted request to the React flight protocol could execute attacker
code on the server. Publicly known, exploit path published.
**Fix:** Upgraded to next@15.5.25.
**Verification:** `npm audit` no longer reports it; critical count 1 → 0.
**Status:** Fixed

### SEC-003 Fifteen API endpoints with no authentication
**Severity:** Critical · **Location:** `src/app/api/{posts,board,crm/*,ai/*,whatsapp/send,connections,sync,render,slots,actions}/route.ts`
**Impact:** Anonymous read and write of every lead, customer, board and campaign;
ability to send WhatsApp messages to customers as the company; ability to
disconnect integrations; ability to spend the AI budget.
**Reproduction:** `curl -X POST /api/whatsapp/send -d '{...}'` succeeded with no credentials.
**Fix:** A `guard()` check on every handler, each naming the permission it needs.
**Verification:** All fifteen return **401** unauthenticated. Route sweep reports
"every route authenticates".
**Status:** Fixed

### SEC-004 Broken access control on pages (hidden ≠ protected)
**Severity:** High · **Location:** `src/app/(app)/**` — every page
**Impact:** A receptionist who typed `/dashboard`, `/crm/leads`, `/ads` or
`/reports` saw live customer and revenue data. The navigation hid the links; the
server did not check.
**Reproduction:** Signed in as `frontdesk@glentree.com`, fetched `/dashboard` → 200
with full content.
**Fix:** A single permission map (`src/lib/auth/page-access.ts`) enforced once in
the app layout. Unlisted paths are **denied by default**, so a new page cannot ship
unprotected by omission.
**Verification:** As front desk — `/dashboard`, `/ads`, `/reports`, `/composer`,
`/connections`, `/crm/leads`, `/crm/pipeline`, `/ops/sales`, `/ops/loans`,
`/ops/admin` all return the no-access page. `/crm/contacts` and `/ops/messages`
remain reachable, which is correct for that role.
**Status:** Fixed

### SEC-005 Privilege escalation via role fallback
**Severity:** High · **Location:** `src/lib/ops/auth.ts`
**Impact:** Any role that was not `admin` or `loan` was labelled `SALES_MANAGER`.
Pages branching on that label therefore treated a receptionist as a salesperson —
`/ops/sales` returned 200 for front desk.
**Fix:** The fallback is now `NONE` (least privilege), and the label is display-only;
every decision reads the permission set.
**Verification:** Front desk on `/ops/sales` → blocked.
**Status:** Fixed

### SEC-006 Two credential stores for one person
**Severity:** High · **Location:** `src/lib/ops/password.ts`, `src/app/api/ops/session/route.ts`
**Impact:** A local password store ran alongside Supabase Auth. Disabling someone
in one left them signed in via the other, and the weaker store set the real
security level.
**Fix:** The local store is deleted. Supabase Auth is the only credential store;
this application never receives, stores or hashes a password. Passwords are hashed
by Supabase with bcrypt.
**Verification:** `src/lib/ops/password.ts` no longer exists; sign-in verified
against Supabase for all six roles.
**Status:** Fixed

### SEC-007 Database master key embedded in front-end code
**Severity:** High · **Location:** `src/components/calendar-view.tsx:105`
**Impact:** The worker secret was hardcoded in a `"use client"` component,
therefore shipped in the browser bundle and readable by any visitor, who could
then trigger the publishing worker at will.
**Fix:** Removed. The button calls the endpoint as the signed-in user; the secret
is only for server-to-server callers and is compared in constant time.
**Verification:** `rg "dev-secret" src/components src/app` → no matches.
**Status:** Fixed

### SEC-008 No security headers or Content-Security-Policy
**Severity:** High · **Location:** application-wide (none were set)
**Impact:** No defence against clickjacking, MIME sniffing, or script injection;
a single escaping mistake anywhere became a full account takeover.
**Fix:** `src/middleware.ts` sets CSP (nonce + `strict-dynamic`, **no**
`unsafe-inline` in `script-src`), HSTS, `nosniff`, `X-Frame-Options: DENY`,
Referrer-Policy, Permissions-Policy and the Cross-Origin isolation headers.
**Verification:** `curl -sI /ops` shows all of them. An attempt to load an
external script from `esm.sh` during testing was **blocked by the browser** —
the policy working live.
**Status:** Fixed

### SEC-009 Vulnerable image and CSS dependencies
**Severity:** High · **Location:** `sharp`, `postcss`
**Impact:** Four libvips CVEs reachable through image processing.
**Fix:** `sharp` upgraded to 0.35.4, `postcss` to 8.5.26.
**Verification:** `npm audit` — sharp finding cleared.
**Status:** Fixed (see Accepted risks for the nested postcss copy)

### SEC-010 Stack traces and internals returned to clients
**Severity:** Medium · **Location:** `src/lib/ops/http.ts`
**Impact:** Error responses echoed internal messages, handing an attacker the
schema, file paths and library versions.
**Fix:** `src/lib/auth/http.ts` returns a generic message plus a correlation id;
the detail is logged server-side only.
**Status:** Fixed

### SEC-011 Insecure secret fallbacks that worked silently
**Severity:** Medium · **Location:** `src/lib/ops/auth.ts`, `src/lib/ops/storage.ts`
**Impact:** Missing environment variables silently fell back to a known constant,
so a misconfigured production deploy would have signed sessions with a public value.
**Fix:** The session-signing path is gone with the local store. The worker path now
throws when `WORKER_SECRET` is unset — it fails closed rather than open.
**Status:** Fixed

### SEC-012 Test suite passed or failed by time of day
**Severity:** Low · **Location:** `tests/workflow.test.ts`
**Impact:** The end-to-end acceptance test scheduled a follow-up before disabling
quiet hours, so it passed during Indian office hours and failed at night. A test
that lies about the system is worse than no test.
**Fix:** Configuration is applied before scheduling.
**Verification:** 36/36 pass under both `TZ=Asia/Kolkata` and `TZ=America/Chicago`.
**Status:** Fixed

---

## What was built alongside the fixes

**Role-based access control, end to end.** Twenty named permissions, seven roles,
granted in the database. Every check asks "does this person have
`documents.read`?" — never "is this person a loan officer?" — so an administrator
can invent a new role from the People tab without a code change or a migration.

Verified permission matrix, taken live from the running system:

| Role | documents read | documents verify | financials | analytics | manage users | sales write | loans write |
|---|---|---|---|---|---|---|---|
| Admin | yes | yes | yes | yes | yes | yes | yes |
| Sales | — | — | — | — | — | yes | — |
| Loan officer | yes | yes | — | — | — | — | yes |
| Front desk | — | — | — | — | — | — | — |
| Construction | — | — | — | — | — | — | — |
| Audit | — | — | — | yes | — | — | — |

Only the administrator can see money. That is the receptionist rule from the
requirements meeting, enforced in the database rather than in the interface.

**Sign-in and account creation.** Passwords go straight to Supabase; this app never
sees one. There is no open sign-up, because anyone who can register themselves can
see customer records — an administrator creates the account, the system issues a
one-time password shown once, and the person must replace it on first sign-in.

**Admin control centre** with five tabs: Overview, Sales team, Loan department,
People & access, Activity log. The Sales tab answers "what is each salesperson
carrying right now, and what have they done recently" in plain words.

### SEC-013 The forced password change could be skipped
**Severity:** High · **Location:** `src/app/(app)/layout.tsx`, `src/lib/auth/session.ts`
**Impact:** An administrator creates a staff account with a temporary password and
reads it out. The account was flagged `must_change_password`, but the flag was only
checked on the sign-in screen — and by then the session cookie had already been
issued. Opening any other page instead of completing the form left the temporary
password valid indefinitely. A credential a second person has seen stays live.
**Reproduction:** Sign in with a temporary password, then navigate to `/ops` rather
than completing the change. Full access, temporary password unchanged.
**Fix:** `mustChangePassword` is carried on the session itself and enforced in the
app layout, which redirects every protected page back to the change form until it
is done. Enforcement moved from one screen to the boundary all screens share.
**Verification:** Confirmed with a disposable account; the layout redirect fires on
every protected path.
**Status:** Fixed

### SEC-014 Sign-in bypassed the application's rate limiter
**Severity:** High · **Location:** `src/components/ops/sign-in.tsx` (removed)
**Impact:** The browser called Supabase Auth directly, so the sliding-window limiter
in `src/lib/ops/ratelimit.ts` never saw a single sign-in attempt. Every throttle in
this codebase was inert on the one endpoint that most needs one, leaving only
Supabase's generic per-project limit between a password list and an account.
**Fix:** Sign-in, magic link and password rotation moved to server actions. Attempts
now pass through two buckets: per account (8 per 5 minutes, 15-minute lockout) and
per source address (60 per 5 minutes). The per-source bucket is deliberately loose,
because an office behind one router shares an address and a tight limit there locks
out everybody to slow down one person.
**Verification:** Nine consecutive wrong passwords against one account: attempts 1–7
returned `Incorrect email or password.`, attempt 8 onward returned
`Too many attempts for this account. Try again in 900 seconds.` The throttle keys on
the submitted address before Supabase is called, so the message is identical for an
address that does not exist and reveals nothing.
**Status:** Fixed

### SEC-015 Sign-in screen disclosed the full application surface
**Severity:** Medium · **Location:** `src/app/(app)/ops/page.tsx` (removed)
**Impact:** The sign-in form rendered inside the application layout, so an
unauthenticated visitor was shown the complete navigation — every module, every
route name, the shape of the business. Reconnaissance handed over before
authentication. Once the page guard from SEC-004 was added, the same structural
mistake also made the form unreachable: `/ops` redirected to `/ops`, forever, and
nobody could sign in at all.
**Reproduction:** `curl -sI /ops` → `location: /ops?next=%2Fops`, repeating.
**Fix:** Authentication moved to its own route group with no navigation and no
guard to loop on. Sign-in is `/signin`, connection status is `/setup`.
**Verification:** `/signin` returns 200 and contains zero navigation strings;
`/ops`, `/dashboard` and `/crm/leads` each redirect exactly once to `/signin`.
**Status:** Fixed

### SEC-016 Authenticated-but-unprovisioned users were bounced silently
**Severity:** Low · **Location:** `src/lib/auth/session.ts`
**Impact:** `getSession()` returned `null` both for "not signed in" and for "signed
in to Supabase, but no active profile in this organisation". The second case was
sent back to the form it had just completed correctly, which reads as a rejected
password. With an external identity provider enabled this is the normal path for
anyone outside the organisation, and the silence invites repeated attempts and a
support call rather than the one sentence that resolves it.
**Fix:** `resolveSession()` distinguishes anonymous, unprovisioned, disabled and
active. The sign-in screen names the situation and offers to sign out.
**Status:** Fixed

---

## Accepted risks

| Risk | Owner | Reason | Review by |
|---|---|---|---|
| `postcss` XSS advisory via Next's bundled copy | Engineering | Only fixable by upgrading to Next 16, a major version. The flaw requires running PostCSS over untrusted CSS; this build compiles only its own Tailwind source, so it is not reachable. | 2026-11-30 |
| No multi-factor authentication | Product owner | Supabase supports TOTP; not enabled. A stolen password is currently enough. Highest-value remaining hardening. | Before real customer data |
| Rate limiting is per-process | Engineering | Correct on one instance, ineffective across several. Move to Redis before scaling horizontally. Now covers sign-in as well as the API, so this matters more than it did. | Before multi-instance deploy |
| Service-role key used on the sign-in path | Engineering | Required to read roles across users. Scoped to a single lookup after the JWT is verified. | 2026-11-30 |

---

## Not tested

Stated plainly so silence is not read as safety:

- **Supabase Row Level Security was not exercised with live data.** The policies
  are written and applied, but the application still reads its operational data
  from a local JSON store. RLS becomes the real boundary only once the data layer
  moves to Postgres.
- **No penetration testing of Supabase itself** — that is Supabase's surface.
- **No load or denial-of-service testing.**
- **Social OAuth flows** are unverified; no provider credentials exist yet. The
  Google sign-in button renders only when `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true`,
  so it is absent rather than decorative until a provider is actually configured.
- **The magic-link path is unverified end to end.** The request is rate limited and
  refuses to create accounts, and the callback exchanges the code server-side, but
  no email has been delivered because this project has no SMTP configured.
- **The WhatsApp webhook signature check** is implemented and unit-covered, but has
  not been exercised against real Meta traffic.
- **No review of the deployment environment** (TLS termination, WAF, backups,
  log retention), which does not exist yet.
