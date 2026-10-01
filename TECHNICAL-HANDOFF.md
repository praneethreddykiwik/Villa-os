# WEBSITE TECHNICAL HANDOFF

**Repository:** `Villa-os` (package name `glentree-social`)
**Audit date:** 2026-09-24 · **Commit:** `6f94a2c` · **Branch:** `main`
**Method:** static read of all 478 source files + live probes against production and third-party APIs. Read-only; nothing was modified.

Conventions used below: **CONFIRMED** = verified by reading the code or observing live behaviour. **NOT VERIFIED** = could not be established from available evidence; treated as unknown, not as absent.

---

## 1. Product Overview

**What it is.** An internal sales, marketing and operations platform for **Glentree Homes**, a villa developer in Hyderabad, India. It is staff-facing only — there is no public/customer surface and no self-signup.

**Problem it solves.** Property enquiries arrive across WhatsApp, Instagram DM, phone and web. The platform captures them into one pipeline, lets an AI voice agent call prospects, lets an AI WhatsApp agent converse with them, escalates to a human when needed, and tracks each lead from first contact to booking.

**Target users.** Seven provisioned staff accounts, one per function: `admin`, `sales`, `marketing`, `loan`, `construction`, `frontdesk`, `audit`.

**Core user journey.**
```
Lead list pasted into dashboard
  → AI voice agent calls (Bolna)
  → call ends, transcript analysed
  → requested material auto-sent on WhatsApp
  → AI WhatsApp agent handles the reply thread
  → human takes over when the lead is hot
  → lead advances through pipeline stages to booking
```

**Primary features.** Outbound voice calling queue · post-call transcript analysis and automatic WhatsApp follow-up · WhatsApp inbox with human takeover · cold-outreach opener sending · lead CRM with 10-stage pipeline · villa/inventory showcase · social publishing.

**Secondary features.** Ads analytics · review management · loan case tracking · appointment scheduling · internal staff messaging · content studio · knowledge base.

**Status.** Substantially complete and deployed. 87 pages, 101 API routes, 106,771 lines. Not a prototype — but it contains **two parallel implementations of the same product** (see §3), which is the dominant structural fact about this codebase.

| | |
|---|---|
| **Complete** | Auth/RBAC · WhatsApp console (live Supabase data) · voice queue · webhook ingestion · publishing engine · security headers |
| **Incomplete** | Bolna webhook not registered (loop open) · no `not-found.tsx` anywhere · one error boundary for 87 pages · delivery-status UI unbuilt |
| **Placeholder/demo** | `/board` first-visit seed (`src/lib/board/seed.ts:6`, self-labelled) · `/showcase` catalogue is source constants · **`src/lib/showcase/inventory.ts` fabricates available/held/sold per unit and serves it to prospects** |

---

## 2. Technology Stack

Verified by import, not by `package.json` presence.

| Layer | Technology | Where used |
|---|---|---|
| Framework | **Next.js 15.5.25** App Router | 87 pages, 101 route handlers; Turbopack dev only |
| UI | **React 19.1.1** | 194 `.tsx`; 80 carry `"use client"` (41%) |
| Language | **TypeScript 5.9.2**, `strict: true` | **0 source type errors** CONFIRMED |
| Styling | **Tailwind v4.1.13** + `@tailwindcss/postcss` | `src/app/globals.css`, two `@theme` blocks |
| Icons | **lucide-react** | 119 files |
| Charts | **recharts 3.2.1** | 3 files |
| Class utility | **clsx** | 36 files |
| Animation | **motion** | 2 files |
| Database A | **Supabase Postgres** (`@supabase/supabase-js`, `@supabase/ssr`) | 6 files; auth + `villa_*` schema |
| Database B | **JSON file store** | `src/lib/db.ts`, 53 collections, 365 KB |
| Auth | **Supabase Auth** (SSR cookies) | `src/lib/auth/session.ts` |
| LLM | **Groq** (primary), **Anthropic**, **Gemini** | `src/lib/ai/provider.ts` |
| Voice | **Bolna** | `src/lib/bolna/client.ts` |
| WhatsApp | **Evolution API** (active) / **Meta Cloud API** (alternate) | selected by `WHATSAPP_PROVIDER` |
| Publishing | **Upload-Post**, Meta Graph, LinkedIn, TikTok, X, YouTube, GBP | `src/lib/platforms/` |
| Hosting | **Vercel** (Hobby) | `vercel.json` |
| Tests | **`node:test`** | 61 files, 1540 tests |
| Package manager | **npm** | `package-lock.json` |

**Declared but unused — CONFIRMED zero imports in `src/`:** `date-fns`, `zod`, `sharp`. All three appear only in `next.config.ts:19` `optimizePackageImports`, which is a no-op for unimported packages. `sharp` is pulled in by Next's image optimiser transitively.

**No analytics and no payments integration exists.** Vercel Speed Insights/Analytics are not wired in code.

---

## 3. Architecture

```
                         Staff browser
                               |
                      Vercel Edge Middleware
              (default-deny session gate, CSP nonce, HSTS)
                               |
              +----------------+----------------+
              |                                 |
      Server Components                   Route Handlers
      (86 of 87 pages)                     (101 endpoints)
              |                                 |
    +---------+---------+             +---------+---------+
    |                   |             |                   |
JSON store          Supabase      guard(perm)        shared secret
src/lib/db.ts       villa_*       RBAC from DB       (webhooks/cron)
  /tmp on Vercel      |                                   |
  EPHEMERAL           |                          +--------+--------+
                      |                          |        |        |
                      |                        Bolna  Evolution  Meta
                      |                          |        |
                      +--------- voice-bridge ---+--------+
                                (call -> WhatsApp)
```

**The defining characteristic: two parallel product stacks that do not share data.**

| Concept | Stack A (JSON store) | Stack B (Supabase) |
|---|---|---|
| Leads | `/crm/leads` | `/inbox/whatsapp/crm/leads` |
| Contacts | `/crm/contacts` | `/inbox/whatsapp/crm/contacts` |
| Customers | `/crm/customers` | `/inbox/whatsapp/crm/customers` |
| Pipeline | `/crm/pipeline` | `/inbox/whatsapp/crm/pipeline` |
| Tasks | `/crm/tasks` | `/inbox/whatsapp/crm/tasks` |
| Follow-ups | `/crm/follow-ups` | `/inbox/whatsapp/crm/follow-ups` |
| Analytics | `/analytics`, `/dashboard` | `/inbox/whatsapp/analytics/*` |
| Activity | `/activity` | `/inbox/whatsapp/activity` |
| Agent engine | `src/lib/ops/agent.ts` (1437 L) | `src/lib/osf/agent/execute.ts` (1209 L) |
| WhatsApp | `src/lib/platforms/whatsapp.ts` | `src/lib/osf/whatsapp/outbound.ts` |
| Lead scorer | `src/lib/crm/rules.ts` | `src/lib/osf/agent/scoring.ts` |

A lead created in one stack is **invisible** in the other. Stack B is the live one (real customer data); Stack A holds seeded/demo data.

---

## 4. Project Structure

```
src/
  middleware.ts            Default-deny gate + CSP nonce + security headers. Entry point for all auth.
  app/
    (auth)/signin          Only public page. Password + magic link + Google OAuth.
    (auth)/setup           Config diagnostics. Session-required (deliberately not public).
    (app)/layout.tsx       THE page authorization gate — requiredPermissionFor(pathname)
    (app)/ops/*            7 pages — JSON store. Ops/CRM/loans/customers.
    (app)/crm/*            8 pages — JSON store. Stack A CRM.
    (app)/inbox/whatsapp/* 49 pages — Supabase. Stack B, the live console.
    (app)/{dashboard,analytics,...} 20 pages — JSON store via pageContext()
    api/                   101 route handlers
  lib/
    db.ts                  JSON store. read()/mutate(). NO LOCKING.
    auth/session.ts        Session resolution, requirePermission, guard
    auth/page-access.ts    Path -> permission map. Unmapped = DENY (fail-closed).
    osf/                   Stack B: Supabase queries, agent, WhatsApp, voice-bridge
    ops/                   Stack A: agent, customers, inbox, sales, loans
    voice/                 Call queue, ingestion, settings
    bolna/client.ts        Voice provider client
    platforms/             Social adapters + PLATFORM_DRIVER mock/live switch
supabase/                  7 migrations — NONE create villa_* tables (see §8)
scripts/                   9 admin scripts — 2 contain a hardcoded password
tests/                     61 files, 1540 tests
```

**Redundant / obsolete — CONFIRMED zero importers:**

| File | Lines | Superseded by |
|---|---|---|
| `src/components/osf/shell/Sidebar.tsx` | 144 | `src/components/shell.tsx:101` |
| `src/components/osf/shell/Topbar.tsx` | 89 | — |
| `src/components/osf/shell/CommandPalette.tsx` | 301 | — |
| `src/components/channels/facebook-posts.tsx` | 353 | `facebook-studio.tsx` |
| `src/lib/pricing/nl.ts` | — | `pricing/engine.ts` |

(`src/components/osf/shell/nav-config.ts` in the same directory **is** live — do not delete the folder wholesale.)

---

## 5. Pages & Routes

**87 pages.** 86 are Server Components; the sole client page is `inbox/whatsapp/simulator/page.tsx`. Nearly all set `dynamic = "force-dynamic"`.

**Authorization is centralised, not per-page.** Only 7 pages call `getSession()` themselves. Protection comes from two layers:
1. `src/middleware.ts:358` — matcher covers everything; `PUBLIC_PATHS = ["/signin"]` only.
2. `src/app/(app)/layout.tsx:18-30` — resolves the required permission and renders `<NoAccess>` instead of the page. `src/lib/auth/page-access.ts:87` returns `null` (deny) for unmapped paths — **fail-closed**.

**Route groups.** `/ops/*` (7, JSON) · `/crm/*` (8, JSON) · root analytics/marketing (20, JSON) · `/voice` + `/voice/settings` (2, JSON) · `/inbox/whatsapp/*` (49, Supabase).

**Largest pages:** `inbox/whatsapp/crm/leads/[id]` (817 L), `properties/inventory` (575), `automation/routing` (535), `properties/projects/[id]` (524).

**State coverage — a real gap.** Only 13 special files exist for 87 routes:
- **Error:** exactly **one** `error.tsx` (`src/app/(app)/error.tsx`). The entire 49-page Supabase tree has no local boundary; `(auth)` has none; there is **no `global-error.tsx`**. Partly mitigated by `src/lib/osf/queries.ts:6-10`, which returns a `ready` flag instead of throwing.
- **Not-found:** **zero** `not-found.tsx` files. All five dynamic routes fall through to the framework default on a bad ID.
- **Loading:** `(app)/loading.tsx` is a catch-all; 6 segments add tailored skeletons.

**Unreachable:** `/inbox/whatsapp/activity` — real 69-line Supabase page, zero inbound links, absent from every nav registry. Reachable only by typing the URL. CONFIRMED by grep.

**Duplicate:** `/inbox/whatsapp` re-exports `/inbox/whatsapp/overview` (`page.tsx:10`) — identical render at two URLs, deliberate and documented.

---

## 6. User Flows

### Flow 1 — Outbound call → WhatsApp follow-up (the flagship feature)
```
Rep pastes numbers   /voice  →  POST /api/voice/queue  (requirePermission customers.write)
  → entries queued in JSON store, brand-scoped
  → pumpQueue() claims one entry inside a single mutate()
  → calling hours 09:00-20:00 Asia/Kolkata, MAX_CONCURRENT_CALLS = 1
  → Bolna POST /call
  → [call happens]
  → Bolna POST /api/webhooks/bolna?secret=...
  → constant-time secret check (header preferred, query accepted)
  → ingestExecution()  → JSON: customer + transcript + lead + notification
  → bridgeCallToWhatsApp()  → LLM extracts signals → Supabase villa_leads
                            → sends requested brochure/floor plan/location
  → settleQueueEntry() then pumpQueue() dials the next number
```
**Failure points:** ① Bolna's `webhook_url` is `null` — the loop is open today. ② Dual-write with no reconciliation (§8). ③ Retry race in the follow-up (BUG #4). ④ On Vercel the queue lives in per-instance `/tmp` (BUG #1).

### Flow 2 — Inbound WhatsApp
```
Customer message → VPS app (outside this repo) owns the Evolution webhook and auto-replies
                 → writes to Supabase villa_*
This dashboard   → reads villa_conversations / villa_messages, human reply only
                 → POST /api/osf/communication  (guard customers.write)
                 → sets ai_paused so the agent stops replying over the human
/api/osf/evolution returns 410 unless EVOLUTION_INBOUND=enabled  (prevents double-replies)
```

### Flow 3 — Cold outreach
```
Rep pastes numbers → StartChat.tsx → POST /api/osf/outreach?preview=1
  → parse, reject bad lines, render sample messages
  → rep must preview before Send is enabled; any edit invalidates the preview
  → max 25 recipients, 4s spacing; skips opted_out and existing threads
```

### Flow 4 — Sign-in
```
/signin → server action signInWithPassword → Supabase → SSR cookies
  → 3-bucket rate limit (source / source+email / account)
  → mustChangePassword forces rotation (>=12 chars)
  → middleware verifies on every request (10s verdict cache)
```

---

## 7. Backend & APIs

**101 route handlers. Zero are fully unauthenticated at file level** — every file contains at least one of `guard()` / `requirePermission()` / `authorize()` / `requireWorkerSecret()` / `verifySignature()` / constant-time secret compare. `tests/security.test.ts:877-926` enforces this per file.

Auth mechanisms: `guard("perm")` (majority) · `authorize()` with org + per-record scoping (`/api/ops/*`) · Meta HMAC (`/api/webhooks/whatsapp`, `/api/osf/instagram`, `/api/osf/whatsapp`) · constant-time shared secret (`/api/webhooks/bolna`, `/api/webhooks/n8n`, `/api/osf/evolution`) · `Bearer CRON_SECRET` (3 cron routes) · worker secret (`/api/publish/tick`).

### Flagged

**Per-method auth gap — CONFIRMED.** `src/app/api/automation/workflow-url/route.ts:9-13` — `GET` has **no permission check**; `POST` calls `requirePermission("marketing.publish")` at `:18`. Any signed-in account can read the n8n workflow webhook URL, which is itself a capability token for the publishing pipeline. The security sweep greps the file, not the method, so this passes CI.

**Middleware matcher excludes two routes — CONFIRMED.** `src/middleware.ts:358` excludes `api/automation/post-video` and `api/automation/v2/post-video` from the session gate *and* from security headers. Both do call `requirePermission` in-route, so they are not open — but they are the only routes whose entire defence is one in-route line, the exclusion is undocumented, and it is a **prefix** match, so a future `post-video-anything` would inherit the hole.

**Hand-rolled rate limiter — CONFIRMED.** `src/app/api/ops/session/route.ts:15-28` uses a private unbounded `Map` and reads `x-forwarded-for` raw (leftmost, caller-controlled) at `:30`. These are precisely the two defects `tests/security.test.ts:516,562` forbid everywhere else, and no test covers this file.

**No schema validation anywhere.** Zero uses of `zod`/`safeParse` under `src/app/api`. Every handler does `await req.json() as {...}` — a compile-time cast with no runtime effect. Highest exposure: `/api/ops/loan`, `/api/ops/customers` (`:70-81`, `body.patch` spread), `/api/osf/settings`, `/api/ops/users` (service-role account creation).

**Upstream error text leaked to client** (~14 routes bypass the `ref`-returning helpers): `connections/route.ts:157,196` · `osf/team/route.ts:45` · `osf/ai/copilot/route.ts:57,75` · `osf/marketing/{broadcasts,templates,mark-ready}` · `osf/simulate/route.ts:76` · `channels/linkedin/posts/route.ts:149` · `automation/test/route.ts:41` (exposes the n8n host). No full stack traces reach clients.

**Dead APIs — no caller in `src/`:** `/api/appointments/availability`, `/api/channels/[channel]/live`, `/api/channels/[channel]/overview`, `/api/integrations/sheets`, `/api/integrations/upload-post`, `/api/ops/admin`, `/api/osf/admin/toggle`, `/api/osf/automations`, `/api/osf/bookings`, `/api/osf/insights`, `/api/osf/inventory`, `/api/osf/kanban/move`, `/api/osf/marketing/mark-ready`, `/api/osf/notifications`, `/api/osf/tasks`, `/api/seed`, `/api/slots`. Several may be `<form action>` targets — **NOT VERIFIED**, do not delete without checking.

---

## 8. Database

### Two stores, no reconciliation

**A. JSON file store** — `src/lib/db.ts`
- Path: `OPS_DATA_DIR` → else `/tmp/.data` on Vercel/Lambda → else `./.data` (`db.ts:19-24`). Modes `0o700`/`0o600`.
- 53 collections; **27 non-empty locally**: `inventoryUnits` 427, `dailyStats` 34, `voiceCalls` 31, `activity` 26, `leads` 14, `customers` 14, `opsMessages` 12.
- **No locking of any kind.** `mutate()` (`db.ts:120-131`) is read → modify whole document → `writeFileSync(tmp)` → `rename`. Atomic against truncation, but no lock, no CAS, no mtime check on write. Across processes/instances it is a straight lost update.
- On a read-only FS that is not Vercel/Lambda, `ensureFile()` (`db.ts:66-88`) throws `EROFS` **on reads too**, since `read()` calls it first.
- Contrast: Supabase writes **do** have a real mutex (`src/lib/osf/locks.ts`, `villa_locks` lease rows). Nothing equivalent guards `db.json`.

**B. Supabase Postgres** — `src/lib/osf/`
- Single memoised **service-role** client (`src/lib/osf/supabase.ts:13-20`), RLS-bypassing, server-only.
- Tables read: `villa_leads`, `villa_messages`, `villa_conversations`, `villa_projects`, `villa_types`, `villa_activities`, `villa_handoffs`, `villa_site_visits`, `villa_questions`, `villa_content_drafts`, `villa_locks`; views `villa_funnel`, `villa_objection_summary`, `villa_source_summary`. RPCs: `villa_upsert_lead`, `villa_upsert_lead_instagram`, `villa_acquire_lock`, `villa_release_lock`.
- **CONFIRMED: no browser code reads `villa_*` with the anon key.** The three client components importing `browserClient` use it for sign-out or the non-villa messaging schema only.

> **CONFIRMED AND IMPORTANT: the `villa_*` schema does not exist in this repository.** All 7 files in `supabase/migrations/` plus `glentree_complete.sql` contain **zero** occurrences of the string `villa_`. They define a different schema (`organizations`, `profiles`, `roles`, `customers`, `loan_cases`, `workflow_*`, `messages`, …). Numbering also starts at `0002` — there is no `0001`. Error messages in `src/lib/osf/queries.ts:44` instruct the operator to run `supabase/migrations/0001_schema.sql`, **a file that does not exist**. The live schema the entire WhatsApp console depends on is maintained outside this codebase, with no DDL, no migration history and no rollback path in version control.

### The seam
One finished call writes the same buyer to **both** stores with different IDs and no foreign key: `ingestExecution()` → JSON (`src/lib/voice/calls.ts:290`), `bridgeCallToWhatsApp()` → Supabase (`src/lib/osf/voice-bridge.ts:433-479`). If the JSON write succeeds and the Supabase write fails, the route still returns **200**, Bolna does not retry, and the divergence is permanent with nothing scanning for it.

### Phone normalisation — five functions, three different answers
| Function | File:line | Output for `"9876543210"` |
|---|---|---|
| `normalisePhone` | `src/lib/ops/customers.ts:21` | `9876543210` |
| `queueKey` | `src/lib/voice/queue.ts:83` | `9876543210` |
| `toE164` | `src/lib/bolna/client.ts:629` | **`null`** |
| inline strip | `src/lib/osf/voice-bridge.ts:414` | `9876543210` |
| `findPhoneNumber` | `src/lib/osf/phone-capture.ts:65` | `+919876543210` |

They diverge on country-coded input: `"+91 98765 43210"` → `normalisePhone` = `919876543210`, `queueKey` = `9876543210`. Since `queueKey` decides "already called" and `normalisePhone` matches the call back to a lead, the same person can be simultaneously spoken-for and not-found. `toE164` accepts only `+`-prefixed input, so feeding it a `normalisePhone` output always yields `null` and the number is rejected as undialable. **The two stores are keyed by two different normalisations of the same string** — which recreates the duplicate identity `voice-bridge.ts:14-27` was written to fix.

---

## 9. Authentication

**Signup: none.** No `auth.signUp` anywhere. Accounts are provisioned by admin scripts; magic link uses `shouldCreateUser: false` (`signin/actions.ts:190`).

**Sign-in** (`src/app/(auth)/signin/actions.ts`): password, magic link, Google OAuth. Generic error for all failures; 3-bucket rate limiting; open-redirect hardening in `safeNext` (`:54-65`).

**Sessions:** Supabase SSR cookies. `getUser()` (not `getSession()`) re-validates against Supabase (`session.ts:171`). Three caches: React per-request; in-process 30 s (`session-cache.ts:47`); middleware verdict 10 s (`middleware.ts:190`).

**RBAC is DB-driven.** `roles` / `role_permissions` / `user_roles` / `permissions`, 53 grant rows, mirrored in RLS via `app_has()`. `requirePermission` **throws** rather than returning a boolean, so a forgotten `if` cannot grant access. `mustChangePassword` reads `app_metadata` first, falling back to client-writable `user_metadata` only when absent — correct ordering.

### Vulnerabilities

**`assertBrandAccess` is a no-op — CONFIRMED** (`src/lib/auth/session.ts:313-318`). It looks the brand up, then only asserts `session.orgId` is truthy. It **never compares the brand's org to the session's org**. Any signed-in user passes for any `brandId`. Used by `/api/voice/queue`, `/api/voice/queue/leads` and the Bolna webhook — so brand isolation on the calling queue is not enforced.

**`assertCustomerAccess` blanket-bypasses on `analytics.view` — CONFIRMED** (`session.ts:301`): `if (session.permissions.has("analytics.view")) return;` before any ownership check. That permission is held by admin, audit and every dashboard-class role, so record-level ownership scoping does not apply to them.

**Password trim widens the credential space** (`signin/actions.ts:136-141`): on failure, sign-in retries with `password.trim()`, accepting two variants where one was set.

**Stale-permission window:** disabling an account or narrowing a role takes up to 30 s, and cache invalidation is process-local — on multi-instance deploys other instances keep serving stale grants.

**`/auth/callback` redirect validation is weaker than sign-in's** (`callback/route.ts:28`): rejects `//` but not `/\`, which `safeNext` treats as an equivalent protocol-relative redirect.

**Network-failure fallback is cookie-presence** (`middleware.ts:293`): if Supabase is unreachable, `signedIn` falls back to "a `sb-*-auth-token` cookie longer than 20 chars exists". Outer fence only — `requirePermission` still verifies — but it is a deliberate default-allow at that layer.

### Live account state — CONFIRMED against production
| Account | Last sign-in | must_change_password |
|---|---|---|
| admin@glentree.com | 2026-09-24 | **false** |
| sales@glentree.com | 2026-09-12 | **false** |
| audit / construction / loan / marketing / frontdesk | 2026-09-06 | **false** |

All 7 still hold provisioning passwords with rotation not enforced. Five have not signed in since the day they were created.

---

## 10. External Integrations

| Service | Purpose | Env | State |
|---|---|---|---|
| **Bolna** | Outbound voice | `BOLNA_API_KEY`, `BOLNA_AGENT_ID`, `VOICE_WEBHOOK_SECRET` | Agent resolves (HTTP 200). **`webhook_url` is `null` — return path not registered** |
| **Evolution API** | WhatsApp transport | `EVOLUTION_API_URL/_KEY/_INSTANCE` | **Live — instance `Glentree` state `open`** CONFIRMED |
| **Meta Cloud API** | Alternate WhatsApp + IG DM | `WHATSAPP_PHONE_NUMBER_ID`, `META_*` | Implemented, not the active provider |
| **Groq** | Primary LLM | `GROQ_API_KEY` (+ fallback list) | Functional, multi-key rotation |
| **Anthropic / Gemini** | Alternate LLM / copy | `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Functional |
| **Upload-Post** | Unified publishing | `UPLOAD_POST_API_KEY`, `_USER` | **Live test FAILS — token rejected** |
| **Google Sheets** | Lead import | `GOOGLE_SHEETS_API_KEY` | **Live test FAILS — key rejected** |
| **n8n** | Video workflow | `N8N_WEBHOOK_SECRET`, `N8N_VIDEO_FORM_URL` | Functional, fails closed |
| **LinkedIn / TikTok / X / YouTube / GBP / Meta** | Publishing | per-platform OAuth | Behind `PLATFORM_DRIVER`; **all credentials empty** |

**`PLATFORM_DRIVER` mechanism is sound** (`src/lib/platforms/types.ts:81`): `=== "live"` exact match, anything else degrades to mock, and `mockPublish` always returns `ok:false` — it never fabricates a published state.

**X/Twitter PKCE is stubbed** (`src/lib/platforms/oauth.ts:102`): `code_challenge=challenge&code_challenge_method=plain` — a literal string, not a derived verifier. PKCE provides no protection as written.

**Canned fallback data served as live** (`api/channels/instagram/posts/route.ts:47-60,123-128` and `facebook/posts/route.ts:133-137,271-276`): specific handles, follower counts, reel IDs and signed Meta CDN URLs are hardcoded as fallbacks, so an API failure shows plausible fake metrics instead of an error.

---

## 11. UI/UX

**Two parallel design systems**, both live. System A (`globals.css:39-91`) for the main app; System B (`:1049-1104`) for the ported OSF module, aliased onto A so they stay in sync — the right call.

**Component duplication:** two `Card`s, two `Stat`s (delta glyphs `↑/↓` vs `▲/▼`), two `Badge`s with non-overlapping tone vocabularies, two `Empty`s with different props.

**The `Button` component is effectively dead:** `<Button>` is used in **5 files**, `.btn-gold`/`.btn-ghost` in 28/36, and **90 files hand-roll a raw `<button>`** with inline Tailwind. This matters for accessibility — `ui.tsx:188` is the only one with a correct `focus-visible` ring.

**Ad-hoc colours bypassing tokens:** `local/page.tsx:102-104` uses raw hex for rank-grid heat cells that duplicate `--c-good/warn/bad` and will not follow a theme switch. `--color-viz-1…6` (`globals.css:83-88`) are raw hex with no light-mode variant, so charts keep dark-tuned hues on white.

**Conflicting classes:** `inbox/whatsapp/layout.tsx:28` contains `sm:px-6` twice and both `lg:px-4` and `lg:px-7` — source order decides the winner, not the author.

### Accessibility
**Done well:** global focus ring for form controls (`globals.css:1035-1040`), `aria-current="page"` on nav, `prefers-reduced-motion` and `prefers-reduced-transparency` respected, status colours retuned for AA in both themes.

**Findings:**
- **No focus-visible fallback for `<button>`/`<a>`.** The rule covers only `input, select, textarea`. Buttons that clear the outline have no visible keyboard focus: `shell.tsx:332` (range toggle), `ui.tsx:227`, sidebar links (`shell.tsx:229-234`), dock links (`:396-401`).
- **331 `<input>` and 83 `<select>` against 138 `<label>` and only 32 `htmlFor`.** Concrete: `crm/leads-grid.tsx:152` (sort select, name empty until a value is read), `:201` (label is a `<span>`, visual association only), `:283` (per-row status select — N identical unnamed comboboxes).
- **Icon-only button with no name:** `voice/start-call.tsx:62-67`.
- **Only 1 of 6 modals traps focus.** `CommandPalette.tsx:200` is the model. `board-settings.tsx:82`, `simulator.tsx:142`, `onyx-showcase.tsx:686`, `serenity-master-plan.tsx:904,929` have correct ARIA but no trap. `voice/start-call.tsx:59` has **no `role="dialog"`, no `aria-modal`, no label, no trap**. None restores focus to the trigger on close.

---

## 12. Responsiveness

**App shell is handled well.** `(app)/layout.tsx` uses `min-w-0 flex-1`, `pt-16 lg:pt-0`, and `Sidebar` (`shell.tsx:176-183`) is a proper off-canvas drawer with scrim, Escape handler, body-scroll lock and auto-close on navigation. 39 of 41 table files have overflow wrappers.

**Will break on mobile:**
1. `whatsapp-inbox/inbox.tsx:106-108` — `w-[300px] shrink-0` conversation list with **no mobile variant**; at 375 px the thread pane gets ~75 px. A third pane at `:405` *is* gated `xl:block`, so the pattern was known but not applied to the primary list.
2. `messaging/conversation-sidebar.tsx:37` — `w-[280px] shrink-0`, unconditional, no back-to-list state.
3. `ops/team-manager.tsx` and `analytics/youtube-section.tsx` — the only two `<table>` files with **no** overflow wrapper.
4. Non-responsive grids: `local/page.tsx:86` (`grid-cols-5`), `:125`, `:142` (`grid-cols-3`); `ads/page.tsx:149` (`grid-cols-4`), `:107`; `reports/page.tsx:176`; `calendar-view.tsx:199` (`grid-cols-7`).
5. Wide tables (wrapped, but severe phone scroll): `min-w-[1180px]` campaigns, `min-w-[1080px]` leads/customers, `min-w-[900px]` team/bookings/follow-ups. No card-stack fallback.
6. Kanban columns 286–308 px `shrink-0` — wider than a 375 px viewport. Touch drag-and-drop **NOT VERIFIED**.
7. `TopBar` (`shell.tsx:310-360`) — single non-wrapping row with title + link + slot + toggle + 3-button pill + brand select; only the link hides below `sm`.

---

## 13. Performance

**P0 — Every request synchronously re-parses a 365 KB JSON file.** `src/lib/db.ts:91-113`. `read()` is `statSync` + `readFileSync` + `JSON.parse`, called from **84 sites** under `src/app/`. An mtime cache exists, but **every mutation invalidates it globally** — a chat-heavy inbox that writes per message makes the cache useless. Blocking sync I/O on the event loop serialises all concurrent requests on that instance. `read()` can also perform a synchronous **write** on the read path (`:108`).

**P1 — `router.refresh()` polling.** `LiveRefresh.tsx:44`, 8 s default, re-runs the entire route's server render each tick. Correctly pauses on hidden tab and offers a Live/Paused toggle — the cost is per-tick, not the scheduling.

**P1 — Polling with no hidden-tab guard.** `voice/call-queue.tsx:86` — `setInterval(15_000)` firing `fetch`, no `visibilityState` check, no failure backoff. A backgrounded tab with a live call polls all night. The fix already exists unused in `src/hooks/use-interval.ts:39-48`.

**P2 — N+1 inside a send loop.** `src/lib/osf/broadcasts.ts:221-228` — one `select("*").eq("id", …).single()` per recipient inside `for (const recipient of batch)`. The batch is already claimed in one RPC; a single `.in("id", ids)` before the loop would preserve the opt-out freshness the per-read is there for. `routing.ts:314-322` already does it correctly.

**P2 — No `next/image` anywhere.** 0 imports against 13 raw `<img>`. Worst: thumbnail grids in `youtube-videos.tsx:249,536,674`, `instagram-studio.tsx:218,366`; `onyx-showcase.tsx:69` is a full-bleed hero with no dimensions and no lazy hint.

**P3 — Unlazied recharts.** `src/components/charts.tsx` lazy-loads correctly with `next/dynamic`, but `src/components/osf/charts.tsx:1-19` imports 16 recharts symbols **statically**, defeating it for any route using the OSF charts.

**P3 — Low-value timers:** `cinematic-stage.tsx:52` (6 s, no pause), `onyx-tour.tsx:75` (1 s, no pause), `message-composer.tsx:46` (**500 ms** for a seconds-resolution readout).

---

## 14. Security

### Strong
Live headers CONFIRMED on production: per-request CSP nonce, `strict-transport-security: max-age=63072000; includeSubDomains; preload`, `x-frame-options: DENY`, `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`. Middleware is default-deny. All webhook secrets are constant-time and fail closed. `tests/security.test.ts` is 1,081 lines of genuine invariants (prompt-injection sanitisation, rate-limiter bounds, XFF handling, board approval gates, forced password rotation, PII kept out of client props).

### Findings

| # | Severity | Finding |
|---|---|---|
| S1 | **Critical** | **Both GitHub repos are PUBLIC** — CONFIRMED HTTP 200 on `koushik1133/glen-villa-final` and `praneethreddykiwik/Villa-os` |
| S2 | **Critical** | Hardcoded staff password in `scripts/recreate-all-users.mjs:6,37` and `scripts/set-simple-passwords.mjs:5,12`, applied to all 7 accounts with `must_change_password: false` (`:90-91`), printed to stdout at `:145`. **These files are tracked in the public repos.** |
| S3 | High | `EVOLUTION_API_KEY` was transmitted in chat and remains live (instance state `open`) |
| S4 | High | `assertBrandAccess` never compares orgs — brand isolation not enforced (§9) |
| S5 | High | `assertCustomerAccess` blanket-bypasses on `analytics.view` (§9) |
| S6 | Medium | `GET /api/automation/workflow-url` ungated — any signed-in user reads the n8n webhook URL |
| S7 | Medium | No runtime schema validation on any of 101 routes |
| S8 | Medium | `/api/ops/session` unbounded rate-limit Map keyed on raw leftmost XFF |
| S9 | Medium | Two routes excluded from the middleware matcher — no session gate, no security headers |
| S10 | Medium | X/Twitter PKCE stubbed with a literal (`oauth.ts:102`) |
| S11 | Medium | `npm audit`: 3 vulnerabilities — 1 high (`postcss` via `next`), 2 moderate (`@anthropic-ai/sdk`) |
| S12 | Low | PII in logs — phone/sender IDs at `osf/evolution/route.ts:302`, `osf/instagram/route.ts:127`, `osf/whatsapp/route.ts:136,175` |
| S13 | Low | Upstream error text leaked by ~14 routes, including the n8n hostname |
| S14 | Low | Bolna webhook secret travels in the query string (documented trade-off — the provider cannot set headers) |

**`.env` was never committed — CONFIRMED** via `git log --all -- .env`. Only `.env.example` is tracked. `.gitignore` covers `.env`, `.env.*`, `.env.bak.*`, `.env.recovered`.

---

## 15. Code Quality

**Strengths.** `strict: true` with 0 errors across 106k lines. 1,540 tests. Comments explain *why*, not *what*, and record rejected alternatives — unusually good. Fail-closed is the consistent default. `Promise.all` used at 78 sites.

**Weaknesses.** The duplicate-stack problem (§3) means every behaviour fix must be made twice or silently diverges. Type lies: `ThreadLead.phone: string` (`communication.ts:61`) against `Lead.phone: string | null` (`types.ts:149`) — the interface defeats the compiler at exactly the point BUG #3 occurs.

**Five files most needing refactoring:**
1. `src/lib/ops/agent.ts` — 1,437 L, 37 functions, 11 exports. Half of a duplicated pair with `osf/agent/execute.ts` (1,209 L). Two 1,200+ line agent engines with near-zero shared code is the single biggest liability.
2. `src/lib/osf/sales.ts` — 1,328 L, **89 exports**. A namespace, not a module; mixes date helpers, enums and DB queries.
3. `src/lib/osf/analytics.ts` — 1,281 L, 48 exports. Nothing is unit-testable without a Supabase client.
4. `src/lib/osf/crm.ts` — 1,078 L, 73 exports (tied with `properties.ts`, 1,007 L).
5. `src/lib/osf/communication.ts` — 605 L. Shortest but worst-mixed: inbox read models + time arithmetic + env presentation + send path + an unrelated email model (`:574-605`). BUGs #3 and #5 both live here.

Component side: `serenity-master-plan.tsx` (1,014), `n8n-panel.tsx` (894), `v2-form.tsx` (884).

---

## 16. Confirmed Bugs

### BUG #1 — Voice queue state is unreliable on Vercel
**Severity:** Critical · **Location:** `src/lib/db.ts:19-24,120-131`; `src/lib/voice/queue.ts:221-227`
**Problem:** `queue.ts` claims "two pumps racing cannot both take the same entry". That holds only inside one Node process. On Vercel `DATA_DIR` is `/tmp/.data` — per-instance and ephemeral — and `mutate()` has no lock.
**Why:** Read-modify-write of the whole file with no lock or CAS; each lambda instance has its own file.
**Impact:** The same customer dialled twice by two instances; `MAX_CONCURRENT_CALLS = 1` unenforceable; entries stuck in `calling` in an instance that never warms again; queue contents vanish on redeploy.
**Fix:** Move `voiceCallQueue` to Supabase and claim with the existing `villa_locks` lease (`src/lib/osf/locks.ts`).

### BUG #2 — Bolna webhook not registered
**Severity:** Critical · **Location:** Bolna dashboard, agent `05f458ae-c249-4f44-9ae1-1ae60481cf2e`
**Problem:** `webhook_url` is `null`. CONFIRMED via live API.
**Impact:** Every completed call ends in silence — no transcript, no lead, no follow-up, and the queue never advances. The flagship feature is inert.
**Fix:** Set `https://<host>/api/webhooks/bolna?secret=<VOICE_WEBHOOK_SECRET>`. The endpoint is verified working (401 without secret, 400 on a valid secret with an empty payload).

### BUG #3 — Template send to a null phone
**Severity:** High · **Location:** `src/lib/osf/communication.ts:535`
**Problem:** `sendWhatsAppTemplate` passes `target.lead.phone` straight to `sendReengagement(to: string)`. The text path at `:478-486` guards for phone → Instagram → explicit error; the template path has no guard.
**Why:** `ThreadLead.phone` is declared `string` (`:61`) while the column is `string | null` (`types.ts:149`), so TypeScript cannot catch it.
**Impact:** For an Instagram-only lead, a rep gets an opaque provider error — or a POST addressed to `null` — instead of "this lead has no phone number".
**Fix:** Mirror the text path's guard; correct `ThreadLead.phone` to `string | null`.

### BUG #4 — Duplicate follow-up race
**Severity:** High · **Location:** `src/lib/osf/voice-bridge.ts:421-429` vs `:471-478`
**Problem:** The dedup check reads for a `voice_followup` activity, but the marker is only written ~20 s later, after an LLM call (`timeoutMs: 20_000`, `:222`).
**Why:** Check-then-act with a long gap; Bolna retries on non-2xx and the webhook awaits the whole chain.
**Impact:** A retry arriving during the LLM call passes the check — the customer receives the brochure twice. Compounded by `:478`, where the marker write is `.catch(() => {})`: if it fails, **every** subsequent retry re-messages them.
**Fix:** Wrap in `withLock` (`src/lib/osf/locks.ts`, already used by `conversation.ts:331`); write the marker before sending.

### BUG #5 — Cold caller told a template was sent when nothing is sent
**Severity:** High · **Location:** `src/lib/osf/voice-bridge.ts:350-351` and `:542-551`
**Problem:** The deferred branch sets the literal "sent the approved template instead". But `FOLLOW_UP_TEMPLATE.cold` is `null` (`:257`), so `bridgeCallToWhatsApp` returns `{messaged: false, skipped: "cold call — recorded, not messaged"}` at `:544-551` without sending.
**Impact:** A cold-scored caller who asked for the brochure outside the 24-hour window receives **nothing**, while the activity log tells staff a template went out. Failure recorded as success. CONFIRMED by reading both branches.
**Fix:** Derive the deferred message from what was actually sent.

### BUG #6 — Brochure promised before delivery is attempted
**Severity:** High · **Location:** `src/lib/osf/voice-bridge.ts:365` vs `:367-384`
**Problem:** "As promised on the call, here is the brochure" is sent first with `.catch(() => {})`, then delivery is attempted. If no approved asset exists — an explicitly expected case (`:280-281`) — the customer is told a file is attached and gets none. `anythingSent` is then false, so a **second** generic template follows, which `:536-537` calls spam.
**Fix:** Deliver first, then send copy describing what actually went.

### BUG #7 — Bookkeeping failure hidden, AI can reply over a human
**Severity:** High · **Location:** `src/lib/osf/communication.ts:414-449`
**Problem:** `Promise.allSettled` swallows all four post-send writes; only the message insert is logged. If the `villa_leads` update fails, `ai_paused` stays false.
**Impact:** The AI agent replies on top of the human rep — which `:386-389` calls "the failure mode this whole console exists to prevent". The rep sees `{ok:true}`.
**Fix:** Keep the parallel writes, but surface a partial-failure warning; retry the `ai_paused` write specifically.

### BUG #8 — Fabricated inventory status shown to prospects
**Severity:** High · **Location:** `src/lib/showcase/inventory.ts:52,78,145,153,167,174`
**Problem:** `seededRandom` → `demoStatus(key)` assigns each unit a pseudo-random `available`/`held`/`sold`, stamped `notes: DEMO_NOTE`. This is not a seed file — it feeds `listUnits`, served by `/api/showcase/inventory` and rendered by `onyx-showcase.tsx:203` and `serenity-master-plan.tsx:276`.
**Impact:** A prospect can be shown a fabricated "sold" flag on a real villa. Commercial and reputational risk.
**Fix:** Serve real inventory or render an explicit "availability on request" state.

### BUG #9 — Concurrency cap not enforced across brands
**Severity:** Medium · **Location:** `src/lib/voice/queue.ts:244-246`
**Problem:** `all` is filtered by `brandId` **before** `inFlight` is counted. The webhook pumps brand-scoped (`webhooks/bolna/route.ts:154`).
**Impact:** Two brands sharing one outbound number each hold a `calling` entry — the busy tone and double billing the constant's comment (`:37-41`) forbids.

### BUG #10 — Calling hours hardcoded to Asia/Kolkata
**Severity:** Medium · **Location:** `src/lib/voice/queue.ts:52-58`
**Problem:** The comment promises "in the brand's local time"; `CALLING_HOURS.timeZone` is a module constant and no brand record is consulted.
**Impact:** Any non-IST brand dials at the wrong hours. Also `localHour()` (`:61-68`) returns **24** at midnight, not 0 (`en-GB` h24 clock) — harmless for the current 9–20 window, wrong for any window touching midnight.

### BUG #11 — n8n webhook idempotency is check-then-act
**Severity:** Medium · **Location:** `src/app/api/webhooks/n8n/route.ts:299-310` vs `:334`
**Impact:** Two concurrent retries with the same key create two site visits and one receipt — the outcome the comment at `:300-302` claims to prevent.

### BUG #12 — Re-finalisation re-notifies sales
**Severity:** Low · **Location:** `src/lib/voice/calls.ts:308-324`
**Problem:** The `upgraded` path re-runs `finalise`. Transcript and lead creation are guarded; `notify(...)` at `:310` is not.
**Impact:** Duplicate "Voice call with X" notifications for one call.

### BUG #13 — `assertBrandAccess` called before the empty check
**Severity:** Low · **Location:** `src/app/api/webhooks/bolna/route.ts:94-100`
**Problem:** `resolveBrandId` returns `""` when no brands exist; `assertBrandAccess(session, "")` runs at `:98` before the `if (!brandId)` guard at `:100`.

### BUG #14 — Two live-credential tests failing
**Severity:** Low (config, not code) · **Location:** `tests/sheets.test.ts:96`, `tests/uploadpost.test.ts:84`
**Evidence:** `1536/1540 pass, 2 fail, 2 skipped`. Both failures are live-API auth: "Google Cloud accepts and validates the API key" → false; "authenticates token with upload-post.com" → false.
**Impact:** Sheets import and Upload-Post publishing are both non-functional with current credentials.

---

## 17. Missing Functionality

**Definitely missing**
- Reconciliation between the two datastores — no outbox, no transaction, no divergence scan.
- `not-found.tsx` at any level; `global-error.tsx`; error boundaries for the 49-page Supabase tree.
- Runtime request validation on all 101 routes.
- Delivery-status UI — `DeliveryStatus` is typed and stored, but all live messages have `delivery_status = NULL` and nothing renders ticks.
- `villa_*` DDL in version control.
- Mobile layouts for the two chat sidebars.

**Probably missing**
- Password rotation enforcement (all 7 accounts have `must_change_password: false`).
- Consent/opt-out audit trail — `opted_out` is honoured on send, but there is no record of when or how consent was captured.
- Per-brand calling-hours configuration (the comment implies it exists).
- Retry/dead-letter handling for failed Supabase writes after a successful JSON write.

**Unclear / needs confirmation**
- Whether the VPS app that owns the Evolution webhook is in scope for this handoff — **NOT VERIFIED**, it is outside this repo.
- Whether the 17 "dead" APIs are `<form action>` targets — **NOT VERIFIED**.
- Whether touch drag-and-drop on Kanban boards is required — **NOT VERIFIED**.

---

## 18. Dead/Unused Code

**Safe to remove — CONFIRMED zero references:**
`src/components/osf/shell/Sidebar.tsx` (144 L) · `Topbar.tsx` (89 L) · `CommandPalette.tsx` (301 L, referenced only as a string key in `tests/theme-contrast.test.ts:80`) · `src/components/channels/facebook-posts.tsx` (353 L) · `src/lib/pricing/nl.ts` (all 4 exports).
Keep `src/components/osf/shell/nav-config.ts` — imported by ~10 pages.

**Unused dependencies:** `date-fns`, `zod`, `sharp` (remove from `package.json` and from `next.config.ts:19`).

**Verify before removing:** 190 exported names in `src/lib/**` have zero out-of-file references. Largest clusters: `osf/queries.ts` (9), `ops/tools.ts` (9 — an entire LLM tool surface; **check for dynamic dispatch first**), `osf/rbac.ts` (8). The detection method counts comment mentions as usage, so false positives are unlikely, but string-keyed access would not be caught.

**Debug/temporary:** 4 `console.log` in live routes logging PII (§14 S12). Exactly one TODO in all of `src/` (`voice/calls.ts:326`).

**Build artifacts:** 41 macOS `* 2.*` duplicate files under `.next/` (e.g. `routes.d 2.ts`). They pollute `tsc --noEmit` output with phantom errors. None are in source. Delete `.next/` and add a cleanup step.

---

## 19. Deployment & Environment

**Platform:** Vercel Hobby. `vercel.json` declares one cron: `/api/voice/queue/run` at `0 4 * * *`.

> **Known deployment trap, already hit and fixed.** Hobby allows **one cron execution per day**. A `*/5 * * * *` schedule is rejected at deploy time and **fails the entire deployment**, not just the cron. Commit `6f94a2c` changed it to daily. Do not restore a sub-daily schedule without upgrading the plan.

**Environment:** 54 variables set in Vercel (production + preview).

**Must never be set on Vercel:**
- `OPS_DATA_DIR` / `OPS_DOCUMENT_DIR` — on Vercel these resolve to a read-only path; `ensureFile()` (`db.ts:66-88`) throws `EROFS` unguarded and **every JSON-backed page 500s**. Unset, it falls back to `/tmp/.data`.

**Must be exact:**
- `NEXT_PUBLIC_APP_URL` — **no trailing slash.** Only one of six consumers strips it (`inbox/whatsapp/whatsapp/page.tsx:80`); `net/safe-url.ts:278`, `net/deliverable.ts:100`, `whatsapp/readiness.ts:318` and `whitelabel.ts` concatenate directly.
- `PUBLIC_BASE_URL` — a **different** variable, used by `engine/publisher.ts:41`, `ops/loan.ts:338`, `platforms/whatsapp-health.ts:89`. No trailing slash (`whatsapp-health.ts` does not strip one).
- `WHATSAPP_PROVIDER=evolution` — otherwise sends route to Meta and fail.
- `PLATFORM_DRIVER` — set to `mock` while social credentials are empty, or publishing attempts real calls and errors.

**Current production state — CONFIRMED by live probe:**
| Check | Result |
|---|---|
| `POST /api/webhooks/bolna` (no secret) | `401 Invalid webhook credentials` ✅ |
| `POST /api/webhooks/bolna?secret=…` | passes auth → `400 no execution id` ✅ |
| `x-voice-secret` header | passes auth ✅ |
| `GET /api/voice/queue/run` + `CRON_SECRET` | `200 {"ok":true,"brands":0}` ✅ |
| `POST /api/osf/evolution` | `410` — inbound correctly disabled ✅ |
| `/` and `/inbox/whatsapp` unauthenticated | `307 → /signin` ✅ |
| Security headers | CSP nonce, HSTS preload, `X-Frame-Options: DENY`, nosniff ✅ |

**Build:** `next build`, no Docker, no CORS config (same-origin only). `tsconfig.test.json` compiles only `src/lib/**` and `tests/**` — route handlers and components are excluded from the test build, which is why route-level tests assert against file **source text** rather than executing handlers.

---

## 20. Feature Status Matrix

| Feature | Implemented | Working | Partial | Broken | Mocked | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Authentication + RBAC | ✅ | ✅ | | | | DB-driven, fail-closed; 2 scoping bypasses (§9) |
| WhatsApp inbox (read) | ✅ | ✅ | | | | Live Supabase data |
| WhatsApp human reply | ✅ | ✅ | | | | BUG #7 hides bookkeeping failures |
| WhatsApp template send | ✅ | | ✅ | | | BUG #3 — null phone unguarded |
| Cold outreach | ✅ | ✅ | | | | Preview-gated, 25 max, 4 s spacing |
| Inbound WhatsApp webhook | ✅ | ✅ | | | | Correctly disabled (410); VPS owns it |
| Voice queue | ✅ | | ✅ | | | Works single-instance; BUG #1 on Vercel |
| Voice call → Bolna | ✅ | ✅ | | | | Agent resolves |
| Call → WhatsApp follow-up | ✅ | | | ❌ | | **BUG #2 — webhook URL null; loop open** |
| Transcript ingestion | ✅ | ✅ | | | | Idempotent per execution id |
| Phone capture from DMs | ✅ | ✅ | | | | Refuses ambiguous input |
| Lead CRM (Supabase) | ✅ | ✅ | | | | 10 pipeline stages |
| Lead CRM (JSON) | ✅ | | ✅ | | | Parallel stack, separate data |
| Villa showcase | ✅ | | ✅ | | ⚠️ | **BUG #8 — fabricated availability** |
| Social publishing | ✅ | | | | ⚠️ | All credentials empty; `PLATFORM_DRIVER` |
| Upload-Post | ✅ | | | ❌ | | Live token rejected |
| Google Sheets import | ✅ | | | ❌ | | Live key rejected |
| Instagram/Facebook metrics | ✅ | | ✅ | | ⚠️ | Hardcoded fallback data |
| Loan cases | ✅ | ✅ | | | | JSON store |
| Appointments | ✅ | ✅ | | | | JSON store |
| Internal messaging | ✅ | ✅ | | | | Separate Supabase schema |
| Delivery ticks UI | | | | | | Typed + stored, not rendered |
| Cron heartbeat | ✅ | | ✅ | | | Daily only (Hobby cap) |

---

## 21. Issue Priority Matrix

| Pri | Issue | Location | Impact | Action |
|---|---|---|---|---|
| **P0** | Both GitHub repos public with committed password scripts | `scripts/recreate-all-users.mjs:6,37`; `set-simple-passwords.mjs:5,12` | Anyone can read the default staff password for 7 accounts | Make repos private; rotate all 7; purge from history |
| **P0** | All 7 accounts `must_change_password: false` | Supabase Auth | Provisioning passwords still valid | Force rotation |
| **P0** | Bolna `webhook_url` null | Bolna dashboard | Flagship feature inert | Register the URL |
| **P0** | Voice queue in per-instance `/tmp` | `db.ts:19-24`; `queue.ts:221` | Double-dials, stuck entries, loss on redeploy | Move to Supabase + `villa_locks` |
| **P0** | `villa_*` schema absent from version control | `supabase/` | No migration path, no rollback, no review | Export DDL into `supabase/migrations/` |
| **P1** | `EVOLUTION_API_KEY` exposed in chat | — | Live instance (`state: open`) controllable | Rotate |
| **P1** | `assertBrandAccess` no-op | `session.ts:313-318` | No brand isolation on the calling queue | Compare `brand.orgId` to `session.orgId` |
| **P1** | `assertCustomerAccess` bypass on `analytics.view` | `session.ts:301` | Ownership scoping void for most roles | Narrow to an explicit manager permission |
| **P1** | Fabricated inventory shown to prospects | `showcase/inventory.ts:52` | Commercial/reputational | Serve real data or an explicit unknown state |
| **P1** | Follow-up duplicate race + swallowed marker | `voice-bridge.ts:421-429,478` | Customer messaged twice, repeatedly | `withLock`; write marker before sending |
| **P1** | Cold caller told a template was sent | `voice-bridge.ts:350` | Failure logged as success | Derive from actual sends |
| **P1** | Brochure promised before delivery | `voice-bridge.ts:365` | Customer told a file is attached, gets none | Deliver first, then describe |
| **P1** | Template send to null phone | `communication.ts:535` | Opaque error / send to `null` | Mirror the text-path guard; fix the type |
| **P1** | 365 KB sync JSON parse per request | `db.ts:91-113` | Blocks the event loop on 84 call sites | Migrate hot paths to Supabase |
| **P2** | `GET /api/automation/workflow-url` ungated | `route.ts:9-13` | Any user reads the n8n webhook URL | Add `requirePermission` |
| **P2** | No runtime validation on 101 routes | `src/app/api/**` | Malformed input reaches privileged writes | `zod` is already a dependency |
| **P2** | Two routes outside the middleware matcher | `middleware.ts:358` | No session gate, no headers | Re-include or document |
| **P2** | `/api/ops/session` unbounded map + raw XFF | `route.ts:15-30` | Memory growth, spoofable key | Use `src/lib/ops/ratelimit` |
| **P2** | Five disagreeing phone normalisers | §8 | Duplicate identities across stores | One canonical E.164 function |
| **P2** | Dual-write with no reconciliation | `webhooks/bolna/route.ts:103,125` | Permanent silent divergence | Outbox or single store |
| **P2** | `npm audit` 3 vulns (1 high) | `postcss` via `next` | Known CVEs | Upgrade Next |
| **P2** | Two mobile-broken chat sidebars | `inbox.tsx:106`; `conversation-sidebar.tsx:37` | Unusable on phones | `hidden md:flex` + back-to-list |
| **P2** | X/Twitter PKCE stubbed | `oauth.ts:102` | PKCE ineffective | Real verifier/challenge |
| **P3** | One error boundary, zero not-found | `src/app/` | Whole-segment blowouts, no 404 | Add per-segment boundaries |
| **P3** | 90 hand-rolled buttons, no focus ring | `shell.tsx:332` et al | Keyboard users lose focus | Route through `<Button>` |
| **P3** | 331 inputs / 32 `htmlFor` | `crm/leads-grid.tsx:152,201,283` | Screen readers announce unnamed controls | Associate labels |
| **P3** | 5 of 6 modals lack focus traps | §11 | Keyboard escape from modal | Follow `CommandPalette.tsx:200` |
| **P3** | PII in production logs | 4 route files | Phone numbers in stdout | Redact |
| **P3** | Dead components + unused deps | §18 | ~900 lines, 3 packages | Delete |

---

## 22. Final Summary

### What this product is
An internal staff platform for a Hyderabad villa developer that unifies AI voice calling, AI WhatsApp conversation, lead CRM, property showcase and social publishing into one dashboard.

### Current architecture
Next.js 15 App Router on Vercel. Edge middleware provides default-deny auth and per-request CSP. Server Components read from **two separate datastores** — a JSON file (`src/lib/db.ts`, ephemeral on Vercel) and Supabase Postgres (`villa_*`) — which hold overlapping concepts and do not reconcile. External work goes out to Bolna (voice) and Evolution (WhatsApp); both call back through constant-time-authenticated webhooks.

### What is working
Authentication and DB-driven RBAC · the WhatsApp console on live data · human takeover with AI pause · cold outreach with preview gating · inbound webhook correctly disabled to prevent double-replies · voice queue within a single instance · transcript ingestion, idempotent per execution id · phone capture from DMs · security headers and webhook authentication, all verified live · 1,536 of 1,540 tests · clean typecheck.

### What is broken
Bolna webhook not registered — the call→WhatsApp loop is open · voice queue unreliable across Vercel instances · Upload-Post and Google Sheets credentials rejected · fabricated inventory availability shown to prospects · two authorization scoping functions that do not scope.

### What is incomplete
Reconciliation between stores · `villa_*` schema in version control · runtime request validation · error boundaries and 404s · delivery-status UI · mobile layouts for two chat sidebars · password rotation enforcement.

### Biggest technical risks
1. **Public repos containing password scripts**, with all 7 accounts still on provisioning passwords.
2. **The dual-stack split.** Two agent engines, two WhatsApp stacks, three lead scorers, five phone normalisers. Every fix must land twice or diverge.
3. **The `villa_*` schema exists only in production** — no DDL, no migration history, no rollback, no review.
4. **JSON store on serverless.** Per-instance, ephemeral, unlocked, holding the call queue.
5. **Silent divergence.** A Supabase write can fail after a JSON commit; the response is still 200 and nothing ever notices.

### Biggest UX problems
1. Two chat sidebars unusable on mobile.
2. Keyboard focus invisible on ~90 hand-rolled buttons.
3. 331 inputs against 32 label associations.
4. One error boundary for 87 pages; no 404 anywhere.
5. Six near-duplicate CRM page pairs — staff cannot tell which "Leads" page is authoritative.

### Recommended next steps
1. Make both repos private; rotate all 7 staff passwords and the Evolution key; purge `scripts/*password*.mjs` from history.
2. Force `must_change_password` on all accounts.
3. Register the Bolna webhook — this alone activates the flagship feature.
4. Move `voiceCallQueue` to Supabase with `villa_locks` claiming.
5. Export the `villa_*` DDL into `supabase/migrations/`.
6. Fix the four follow-up correctness bugs (#3, #4, #5, #6) — they all touch customers directly.
7. Fix `assertBrandAccess` and `assertCustomerAccess`.
8. Replace fabricated inventory status with real data or an explicit unknown state.
9. Unify phone normalisation to one E.164 function.
10. Decide the datastore strategy — the dual-stack split is the root cause of items 4, 5, 9 and the divergence risk.
11. Add `zod` validation (already a dependency) starting with `/api/ops/*`.
12. Add error boundaries and a `not-found.tsx`; fix the two mobile sidebars.

---

# HANDOFF FOR ANOTHER AI

**Project:** Villa-os / Glentree Homes internal sales-ops platform. Next.js 15.5.25 App Router, React 19, TypeScript strict (0 errors), Tailwind v4, npm, deployed on **Vercel Hobby**. 478 source files, 106,771 LOC, 87 pages, 101 API routes, 61 test files (1,536/1,540 passing — the 2 failures are expired Google Sheets and Upload-Post credentials, not code).

**Read this first: there are TWO parallel stacks.** Stack A uses a JSON file store (`src/lib/db.ts`, 53 collections) and serves `/crm/*`, `/ops/*` and root analytics. Stack B uses Supabase Postgres (`villa_*`) and serves the 49 pages under `/inbox/whatsapp/*`. They hold overlapping concepts (leads, contacts, customers, pipeline, tasks, follow-ups — six duplicate page pairs), do not share data, and there are two agent engines (`ops/agent.ts` 1437 L, `osf/agent/execute.ts` 1209 L), two WhatsApp stacks, three lead scorers and five phone normalisers. Stack B is the live one.

**Critical context that is not in the repo:**
- The `villa_*` schema has **no DDL anywhere in this codebase**. All 7 files in `supabase/migrations/` contain zero occurrences of `villa_`. Error messages reference `0001_schema.sql`, which does not exist. Do not trust `supabase/` to describe the live database.
- An external VPS app owns the Evolution WhatsApp webhook and auto-replies. **This dashboard must never enable an inbound webhook** — two responders on one number means double replies. `/api/osf/evolution` returns 410 unless `EVOLUTION_INBOUND=enabled`. Leave it that way.
- On Vercel, `src/lib/db.ts` writes to `/tmp/.data` — per-instance and ephemeral. **Never set `OPS_DATA_DIR` or `OPS_DOCUMENT_DIR` in Vercel**; those paths are read-only and `ensureFile()` throws `EROFS` unguarded, 500-ing every JSON-backed page.
- **Never set a sub-daily cron in `vercel.json`.** Hobby caps at one execution per day and rejects the deployment outright — it fails the whole build, not just the cron. This already happened once (fixed in `6f94a2c`).

**Key files**
| File | Role |
|---|---|
| `src/middleware.ts` | Default-deny gate, CSP nonce, `SELF_AUTHENTICATING` list. `PUBLIC_PATHS = ["/signin"]` |
| `src/app/(app)/layout.tsx` | The page authorization gate |
| `src/lib/auth/session.ts` | `requirePermission` (throws), `assertBrandAccess` (**broken**), `assertCustomerAccess` (**bypass**) |
| `src/lib/auth/page-access.ts` | Path→permission map; unmapped = deny |
| `src/lib/db.ts` | JSON store. `read()`/`mutate()`. **No locking.** |
| `src/lib/osf/supabase.ts` | Service-role client, server-only |
| `src/lib/osf/queries.ts` | All `villa_*` reads; returns a `ready` flag instead of throwing |
| `src/lib/osf/voice-bridge.ts` | Call transcript → WhatsApp follow-up. **BUGs #4, #5, #6** |
| `src/lib/osf/communication.ts` | WhatsApp send path. **BUGs #3, #7** |
| `src/lib/voice/queue.ts` | Call queue. **BUGs #1, #9, #10** |
| `src/app/api/webhooks/bolna/route.ts` | Voice webhook; header-preferred, query-secret accepted |
| `tests/security.test.ts` | 1,081 lines of real invariants — read before touching auth |

**Integrations:** Bolna voice (agent `05f458ae-c249-4f44-9ae1-1ae60481cf2e`, **`webhook_url` is null — the loop is open**) · Evolution API WhatsApp (instance `Glentree`, state `open`, live) · Groq/Anthropic/Gemini LLMs · Upload-Post + Meta + LinkedIn + TikTok + X + YouTube + GBP publishing (all credentials empty; gated by `PLATFORM_DRIVER`, which must equal the exact string `live` or it degrades to mock).

**Known issues, ranked:** ① both GitHub repos public with committed password scripts, all 7 accounts on provisioning passwords with rotation disabled ② Bolna webhook unregistered ③ voice queue in per-instance `/tmp` ④ `villa_*` schema unversioned ⑤ `assertBrandAccess` never compares orgs; `assertCustomerAccess` returns early on `analytics.view` ⑥ four customer-facing follow-up bugs in `voice-bridge.ts`/`communication.ts` ⑦ fabricated inventory availability served to prospects (`showcase/inventory.ts:52`) ⑧ no runtime validation on any route ⑨ dual-write with no reconciliation ⑩ 365 KB synchronous JSON parse on 84 request paths.

**Conventions to preserve:** comments explain *why* and record rejected alternatives — keep that style. Auth fails closed everywhere; do not introduce a default-allow. `requirePermission` throws by design. Webhook secrets are constant-time compared over a SHA-256 fixed width. The preview-before-send gate in outreach is deliberate friction — do not remove it.

**Verified live production state (2026-09-24):** `/api/webhooks/bolna` 401 without a secret and 400 with a valid one · `/api/voice/queue/run` 200 with `CRON_SECRET` · `/api/osf/evolution` 410 · unauthenticated pages 307→`/signin` · CSP nonce, HSTS preload, `X-Frame-Options: DENY`, nosniff all present.
