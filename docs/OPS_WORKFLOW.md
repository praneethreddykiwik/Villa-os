# End-to-End Sales + Loan Processing Workflow

Extends the existing application. Nothing was rebuilt; the CRM, WhatsApp transport, LLM provider and dashboard shell are reused.

---

## 0. Blockers found during inspection — read this first

The brief assumed infrastructure that is not in this repository. Rather than fake it, each gap is stated and the correct abstraction implemented.

| Assumed | Reality | What was built instead |
|---|---|---|
| **Supabase / Postgres** | Persistence is a single JSON document behind `read()`/`mutate()` in `src/lib/db.ts` | Extended the same repository. **Also shipped `supabase/migrations/0001_ops_workflow.sql`** — the full schema with FKs, indexes, constraints and RLS policies. Porting = reimplementing two functions. |
| **Authentication / RLS** | None anywhere | **Password authentication** (scrypt, constant-time verify, rate limited) issuing HMAC-signed, expiring, revocable sessions; a permission matrix enforced by one `authorize()` guard on every route; row-level scoping. Members ship **without** passwords and claim their account on first use — no default credentials. Still no SSO/MFA/reset (see §10). |
| **"Existing WhatsApp AI agent"** | Transport only (`sendWhatsApp`, `parseWebhook`, 24h-window) | Built the agent: intake → extraction → scoring → triggers → escalation → grounded reply, on top of the existing adapter. |
| **Existing AI tools** | None | 15-tool registry with an `{ok,data}|{ok,error}` contract. |

Two further deliberate omissions: **no fake customers are seeded** (dashboards for a system holding real financial documents must not lie about what work exists — customers arrive via the webhook), and **no automated loan decisioning** was implemented, only the data model for it (§24).

---

## 1. Files changed

**New — engines (`src/lib/ops/`)**
`types.ts` · `config.ts` · `auth.ts` · `password.ts` · `ratelimit.ts` · `audit.ts` · `customers.ts` · `intelligence.ts` · `scoring.ts` · `assignment.ts` · `sales.ts` · `loan.ts` · `documents.ts` · `storage.ts` · `followups.ts` · `tools.ts` · `agent.ts` · `seed.ts` · `http.ts`

**New — API** `src/app/api/ops/{session,customers,sales,loan,documents,followups,admin}/route.ts`

**New — UI** `src/app/(app)/ops/{page,sales,loans,loans/[caseId],admin,customers/[id]}` · `src/components/ops/{sign-in,home,customer-controls,case-controls,checklist-editor,sales-actions}.tsx`

**New — other** `supabase/migrations/0001_ops_workflow.sql` · `tests/{helpers,workflow.test}.ts` · `tsconfig.test.json`

**Modified (additive only)**
- `src/lib/types.ts` — `Database extends OpsDatabase`
- `src/lib/db.ts` — ops slice in `EMPTY`; `OPS_DATA_DIR` override for test isolation
- `src/lib/seed.ts` — ops slice
- `src/lib/platforms/whatsapp.ts` — `WhatsAppMessage.mediaId/filename`
- `src/app/api/webhooks/whatsapp/route.ts` — **X-Hub signature verification**, media download, routes into the agent. Existing inbox behaviour untouched.
- `src/components/shell.tsx` — Operations nav group
- `package.json` — `npm test`

---

## 2. Database

Runtime: the JSON repository, extended with 18 collections.
Portable target: `supabase/migrations/0001_ops_workflow.sql` — 18 tables, enums for every workflow state, and constraints that encode the rules rather than trusting the app:

- `customers (org_id, phone)` unique — one WhatsApp number cannot fork into two profiles
- `sales_tasks` partial unique index — at most one live task per customer
- `loan_cases` partial unique index — one open case per customer
- `documents (customer_id, sha256)` unique — webhook media replays dedupe
- `documents` CHECK — a `REJECTED` document must carry a reason
- `followups` partial unique index — never chase the same item twice concurrently
- `audit_logs` — UPDATE/DELETE trigger raises; append-only at the database
- RLS on all 18 tables; the decisive policy is `documents_select`, which excludes sales roles

---

## 3. New APIs

| Route | Methods | Permission |
|---|---|---|
| `/api/ops/session` | POST (login / claim), GET (whoami), DELETE (sign out) | none — rate limited |
| `/api/ops/customers` | GET (list / 360), PATCH (profile, stage, takeover) | `customer:read` / `customer:write` |
| `/api/ops/sales` | GET workspace, POST `updateTask` `logCall` `markQualified` `markNotInterested` `markFinancingRequired` `reassign` | `sales:read` / `sales:write` |
| `/api/ops/loan` | GET workspace/case, POST `addItems` `applyTemplate` `updateItem` `removeItem` `setStatus` `requestDocuments` `reassign` `addNote` | `loan:read` / `loan:write` |
| `/api/ops/documents` | GET (metadata / signed download), POST upload, PATCH review | `document:read` / `document:review` |
| `/api/ops/followups` | POST tick (`?dryRun=true`), GET, PATCH resolve/cancel | worker secret or `admin:read` |
| `/api/ops/admin` | GET overview + workload/SLA, PATCH config | `admin:read` / `config:write` |
| `/api/webhooks/whatsapp` | GET verify, POST inbound | signature-verified |

---

## 4. AI tools (§31)

`get_customer_profile` `get_lead_status` `update_customer_profile` `get_sentiment` `create_sales_task` `get_conversation_summary` `get_loan_case` `get_assigned_loan_officer` `get_document_checklist` `get_missing_documents` `get_document_status` `record_document_received` `create_followup` `pause_followups` `escalate_to_human`

**There is deliberately no tool to add a checklist item, accept a document, or set a loan status.** A test asserts those names do not exist. `record_document_received` returns `ok:false` unless a file was genuinely stored.

---

## 5. New dashboard pages

`/ops` (sign-in / claim, then role-aware entry) · `/ops/sales` · `/ops/loans` · **`/ops/loans/[caseId]`** (case workspace: checklist editor, document review, status/ownership, notes, follow-up log) · `/ops/admin` · `/ops/customers/[id]` (Customer 360, including the sales call flow)

Every screen leads with what needs attention — overdue calls, documents awaiting review, open escalations — before raw lists. AI / human / customer / system activity is badge-distinguished throughout.

---

## 6. Environment variables

```
OPS_SESSION_SECRET       required in production (session signing)
OPS_DOCUMENT_SECRET      download-link signing (falls back to session secret)
WORKER_SECRET            protects the follow-up tick
META_APP_SECRET          enables WhatsApp webhook signature verification
WHATSAPP_VERIFY_TOKEN    webhook handshake
WHATSAPP_PHONE_NUMBER_ID, META_SYSTEM_USER_TOKEN, PLATFORM_DRIVER=live
ANTHROPIC_API_KEY        optional — extraction degrades to the deterministic engine
OPS_DATA_DIR, OPS_DOCUMENT_DIR   test isolation
```

---

## 7. Security

- **Authentication**: scrypt (memory-hard, parameters stored so cost can be raised without a migration), constant-time verification, NFKC normalisation. Login failures are uniform — an unknown email spends comparable work so timing does not disclose which accounts exist.
- **Rate limiting**: asymmetric by design. Strict per account (8 / 5 min, 15 min lockout) because attempts on one account are almost always an attack; permissive per source address (60 / 5 min) because an office behind one NAT shares an address and a tight IP lockout is a self-inflicted outage. Probing an unclaimed account does not consume the account budget, or an account could be locked before anyone claims it.
- **RBAC**: one `authorize()` guard, throwing rather than returning a boolean, so a forgotten `if` cannot grant access. Sales holds `loan:read` (case status) but **not** `document:read`, which is what the download path requires as well — there is no separate `download` permission, and the handler no longer pretends to check one.
- **Row-level scoping**: non-admins reach only customers they own — verified 403 in tests and over HTTP.
- **Revocation is immediate**: `verifyToken` re-checks the member row; disabling a member kills live tokens.
- **Documents**: stored under `.private/` (never `public/`), mode `0600`, path traversal rejected. Downloads need a short-lived HMAC signature **bound to the requesting member** *and* a fresh permission check. Served `attachment` + `nosniff` + `no-store`.
- **Webhooks**: X-Hub-Signature-256 verified over the exact received bytes, constant-time compare.
- **Audit**: append-only by construction, and by trigger in SQL.
- **No sensitive data client-side**: the Customer-360 payload omits documents entirely for sales rather than hiding them in the browser.

---

## 8. Tests — 40, all passing (`npm test`)

Customer identity & idempotency · scoring determinism/configurability/clamping · deterministic extraction · sentiment trend · all four assignment strategies · permission matrix · token tampering & revocation · **password hashing (salting, unicode normalisation, wrong-password rejection)** · **password policy** · **rate-limit lockout and reset** · signed-URL binding and expiry · upload validation · path traversal · quiet hours · human takeover/release · opt-out · follow-up and escalation dedupe · human-only acceptance · rejection-reason requirement · content dedupe · **failed storage creates no row** · tool contract · absence of forbidden tools · completion maths · rejection recovery · webhook idempotency · **no two consecutive identical replies** · **replies answer the current message** · **the full §38 acceptance scenario (25 steps)**.

---

## 9. Bugs found and fixed while testing

1. **Conversational replies were counted as automated outreach**, so a customer's own conversation blocked the reminders that conversation was about. Added `OpsMessage.automated`; cooldown and daily cap now count proactive sends only.
2. **A document decision the customer was never told about looked successful.** When delivery fails (typically the closed 24h window), the decision stands but an escalation is now raised so a human knows.
3. Officer-authored labels were lowercased ("Photo ID" → "photo id") and descriptions concatenated without punctuation.
4. **The assistant sent the identical sentence twice in a row** — replies keyed off cumulative intent, so "is anything available in March?" and "could I see it in person?" produced one answer. Replies now match the message in front of them, with a guard against consecutive duplicates.
5. **A symmetric IP rate limit would have locked out a whole office** behind one NAT. Caught when the test run locked itself out; limits are now asymmetric.

---

## 10. Remaining TODOs

1. **SSO / MFA / password reset** — password auth is real, but there is no OIDC, no second factor, and no reset flow (no mailer is configured, and a reset without out-of-band delivery is an account-takeover hole). An admin resets by clearing `passwordHash`, returning the account to the claim flow.
2. **Distributed rate limiting** — the limiter is in-process. Move to Redis before running more than one instance.
3. **Move to Postgres** — apply the migration, reimplement `read()`/`mutate()`, RLS becomes active.
4. **Object storage** — implement `DocumentStore` for S3/Supabase (interface is ready).
5. Admin CRUD UI for team members, config and loan rules (APIs exist; only the read view is built).
6. Virus scanning on upload, and OCR/legibility pre-checks.
7. WhatsApp template registration for out-of-window sends.
8. `LoanRule` evaluation — schema and admin storage exist; **decisioning intentionally not implemented**.

---

## 11. Running it locally

```bash
npm install
npm test                 # 40 tests incl. the full acceptance scenario
npm run build && WORKER_SECRET=$(openssl rand -hex 32) OPS_SESSION_SECRET=$(openssl rand -hex 32) npm start
```

Then, end to end:

1. Open `http://localhost:4321/ops`. The seeded accounts have no passwords — sign in as `admin@example.com` and set one to claim the account (12+ characters).
2. Simulate a customer (three messages: pricing → site visit + budget → "please have someone call me"):
   ```bash
   curl -X POST localhost:4321/api/webhooks/whatsapp -H 'content-type: application/json' \
     -d '{"entry":[{"changes":[{"value":{"contacts":[{"wa_id":"919876500001","profile":{"name":"Test Customer"}}],
         "messages":[{"id":"m1","from":"919876500001","timestamp":"1788000000","type":"text",
         "text":{"body":"Please have someone call me, budget around 5 Cr"}}]}}]}]}'
   ```
3. `/ops/sales` — the lead appears, scored, with an AI briefing and an assigned manager.
4. Sign in as that manager → open the customer → log the call and hit **Mark financing required** in the call-flow panel.
5. Sign in as the assigned loan officer → `/ops/loans` → open the case → apply a checklist template → **Request from customer**.
6. Run the worker: `curl -X POST "localhost:4321/api/ops/followups?secret=$WORKER_SECRET"` — the customer receives a request naming one real checklist item.
7. Upload a document on the case page, then **Reject** it with a reason — the customer receives that exact reason and the case returns to `DOCUMENTS_INCOMPLETE`. **Accept** instead and completion advances.
8. Accept every required document → the case flips to `READY_FOR_ANALYSIS`, the officer is notified, and `/ops/customers/<id>` shows the complete audit timeline.
