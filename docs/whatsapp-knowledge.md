# WhatsApp assistant — knowledge base and intent routing

The WhatsApp agent (`src/lib/ops/agent.ts`) answers customer questions from a
structured knowledge base rather than from the model's memory. This note covers
where the facts live, how they get there, how a message is routed, and the
Groq budget.

## Where the facts live

- Store: `kbEntries` in `.data/db.json` — `{ id, brandId, topic, question, answer, keywords[], public, source, updatedAt }`.
- Unanswered questions: `kbGaps` — `{ question, intent, count, lastAskedAt }`, one row per distinct question, capped at 500 per brand.
- Code: `src/lib/ops/knowledge.ts` (store, retrieval, seeding), `src/lib/ops/router.ts` (intents, language, deterministic replies, slot filling).

Topics: `pricing availability location amenities approvals payment visit contact documents general`.

## Seeding from `docs/glentree-facts.md`

On the first customer message per process the brand's KB is (re)seeded from the
facts file. Rows whose `source` is `admin` are never touched; `docs` and
`placeholder` rows are replaced by a fresh parse. If the file is missing, a
minimal placeholder set (process facts only, no property claims) is seeded so
the assistant still works.

Understood markdown shapes:

| Shape | Becomes |
|---|---|
| `## Heading` | topic + section for the lines under it |
| Markdown table | one entry per row; first column is the key, a `Source` column is dropped |
| `Q: … / A: …` | one entry each |
| `- Key: value` | one entry (question = key) |
| Other bullets / paragraphs | one entry per section (question = heading) |

Markers:

- `(public)` on a heading, row or line marks the entry quotable. **A price
  reaches a customer only from a public entry**; every other price entry is
  withheld and the reply says the sales team will confirm pricing.
- `[CONFIRM WITH GLENTREE]` becomes "(to be confirmed by the sales team)".
- Sections headed `Gaps`/`Source` are skipped, as is prose directly under the H1.

Environment:

- `KB_FACTS_PATH` — optional. Path to the facts file (default `docs/glentree-facts.md`); set to an empty string to disable file seeding (the test helpers do this).

## Admin

- `/settings` → "WhatsApp knowledge base" card (`src/components/knowledge-editor.tsx`): add, edit, delete entries; mark public; see unanswered questions and turn one into an entry; "Re-sync facts" re-reads the file.
- API (`workflows.manage`): `GET/POST/PATCH/DELETE /api/ops/knowledge?brand=<id>`; `GET …&q=<text>` previews retrieval; `DELETE …&gap=<id>` dismisses a gap; `POST {resync:true}` re-seeds.

## Retrieval

No embeddings. Query tokens (stemmed, stopwords removed, a small synonym map)
are scored against each entry: keyword hit 3, question-token overlap 2,
answer-token overlap 1, +2 when the entry's topic matches the routed intent.
Top 3 are injected into the model prompt as `Knowledge base:` facts and are the
only source for the deterministic reply.

## Intent router

Deterministic regex table first (`routeIntent`), most specific first:
`opt_out, human, callback, visit, documents, approvals, payment, location,
amenities, availability, pricing, thanks, greeting`, else `unknown`. Hindi and
Telugu script keywords are included. The existing hard boundaries in the agent
still run first: loan-approval questions, price negotiation, legal terms, an
active loan case's document checklist.

| Intent | Path |
|---|---|
| human | escalation `requested_human` (HIGH) to the assigned sales manager — one is assigned if nobody owns the lead — plus an ops notification; the customer is told who calls and by when (`callbackWindow`: within 2 hours in 09–19 IST, else by 10am tomorrow) |
| callback | escalation `callback_requested` (MEDIUM) + notification; same promise |
| visit | slots from `src/lib/appointments`; a stated day/time ("Saturday morning", "kal shaam", "11am") narrows the offer; a numbered reply books and calls `notifyAppointment` from `src/lib/notify` when that module exists |
| location, amenities, approvals, payment, documents | top-3 KB entries → reply; no match logs a gap and says so honestly |
| pricing, availability | existing replies, with KB facts appended (prices only if public) |
| thanks, greeting | bounded replies |
| unknown | clarify once (gap logged), escalate on the second miss |

Every reply ends with exactly one next-step question (site visit or callback),
in the customer's language: English, Hindi, Telugu or Hinglish, detected by
script or romanised-Hindi vocabulary.

## Groq budget

One completion per inbound reply: `max_tokens 300, temperature 0.2, 8s
timeout`, retried once after 1.5s only on a 429, then the deterministic reply
goes out. The prompt carries the brand facts, the top-3 KB entries, a rolling
summary of the last six turns (intents asked, profile facts, whether slots are
pending) and the detected language. Model output is discarded if it contains
approval/negotiation/asserted-action vocabulary; figures are allowed only when
a public price entry was in the prompt.

## Tests

`tests/whatsapp-training.test.ts` — seeding from a fixture file, each intent
with a stubbed provider, Hindi/Hinglish mirroring, slot filling, gap logging,
and the 429 retry.
