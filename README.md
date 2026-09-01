# Orbit — Social, Ads & Local Command Center

One dashboard to **create and edit video, publish everywhere, run Meta + Google ads, manage reviews and local visibility, and get ranked AI recommendations** — built multi-tenant from the first line so you point it at Villa today and at 50 other businesses tomorrow.

```bash
npm install
npm run dev          # http://localhost:4321
```

No API keys, no database, no Docker. It boots with a fully populated 3-brand demo workspace on first request.

---

## Table of contents

1. [What it does](#1-what-it-does)
2. [The 22 screens](#2-the-22-screens)
2d. [Sign-in](#2d-sign-in)
3. [Architecture](#3-architecture)
4. [Publishing engine — how it actually works](#4-publishing-engine)
5. [The AI insight engine — all 12 analysers](#5-the-ai-insight-engine)
6. [Video studio & render pipeline](#6-video-studio--render-pipeline)
7. [Ads: Meta + Google in one place](#7-ads-meta--google-in-one-place)
8. [Going live](#8-going-live)
9. [Adding a new brand or network](#9-extending)
10. [File map](#10-file-map)
11. [What is real vs. simulated](#11-what-is-real-vs-simulated)

---

## 1. What it does

| Capability | Where |
|---|---|
| Write one post → per-network variants → validated → scheduled | Composer |
| Publish to Instagram (feed/reel/**story**/carousel), Facebook, TikTok, YouTube, LinkedIn, X, Google Business | Publish engine |
| Edit video once, render per aspect ratio (9:16 / 4:5 / 1:1 / 16:9), burn captions, add hooks | Video Studio |
| Month / week / day calendar, drag to reschedule, "best slot" ghosts | Calendar |
| Meta Ads + Google Ads normalised into one table, one ROAS, one chart | Ads |
| 12 analysers producing ranked, **one-click executable** recommendations | AI Insights |
| Google review management with AI-drafted replies + auto-reply toggle | Reviews |
| Local rank grid (5×5 geo-grid per keyword) + GBP insights + competitors | Local |
| Unified comment/DM/mention inbox with lead detection | Engagement |
| Client-ready report with executive summary, print-to-PDF | Reports |
| Fully customizable board — columns, colors, HITL gates, card fields, 6 templates | Board |
| WhatsApp Business two-way chat with 24-hour-window enforcement | Engagement |
| One-click connect for 10 channels, with scopes explained up front | Connections |
| Light / dark / follow-system theme, monochrome accent | Everywhere |
| Real-estate CRM: leads, pipeline, contacts, customers, tasks, follow-ups | `/crm/*` |

---

## 2. The 22 screens

**Overview** — Dashboard (AI summary + 6 KPIs + organic and paid charts + top recommendations + queue), AI Insights, Analytics (day×hour engagement heatmap, format performance, top content with 3-second hook scores).

**Create & publish** — Composer, Video Studio, **Board**, Calendar, Post ideas.

**CRM** — Leads, Pipeline, Contacts, Customers, Tasks, Follow-ups.

**Grow** — Ads, Engagement inbox, Reviews, Local visibility.

**Deliver** — Reports, Activity audit log, Connections, Settings.

Every page shares one brand switcher and one 7/30/90-day range control (`?brand=…&range=…`).

---

## 2b. The Board

A Monday-style work surface where the *board itself* is data, not code. One component renders a content calendar, a sales pipeline or a support queue.

**Customisation** (all in the settings drawer, all persisted):
- Rename the board.
- Six templates — Default, Content Calendar, Software Dev, Sales Pipeline, Agency, Support.
- Columns: add, rename, delete, drag to reorder, click the dot to cycle colour, click the shield to toggle HITL, optional WIP limits.
- Card fields: toggle description / priority / due date / tags / assignee / automation label / linked post. Cards and the add form both follow the toggles.

**Three things that make it more than a toy kanban:**

1. **HITL approval gates.** A column marked HITL means cards there are awaiting a human. A card *cannot leave* until someone approves it — the API returns 409 with the reason, and the UI offers Approve or an explicit, logged Override. This is the safety valve on the AI content pipeline: the agent can draft and queue, but a person releases.

2. **Deleted columns never delete cards.** Cards left pointing at a removed column become *orphans* and surface in a banner with one-click rehoming. Destroying someone's work to apply a layout is not a trade worth making silently.

3. **Template changes remap by position.** Template columns get fresh ids, so a naive implementation orphans every card on every template switch — technically non-destructive, practically unusable. Cards are remapped column-1→column-1, and only cards beyond the new template's column count orphan.

---

## 2b-2. The CRM

Built for high-ticket residential real estate: a lead is worth ₹1.2 Cr to ₹25 Cr+, the cycle runs months, and money arrives in tranches. Three modelling decisions follow from that and everything else depends on them.

**Budget is a range, not a number.** Buyers state a band. The grid filter therefore tests **range overlap** — a lead at ₹4–7 Cr *does* match a ₹5–10 Cr filter. Filtering on a midpoint silently hides half the qualifying pipeline.

**Contacts and leads are separate records.** One HNWI buys three units over four years; KYC status, net-worth band, documents on file and payment history belong to the person, not to any single enquiry.

**Follow-ups are generated from state.** A site visit or a paid token implies a known sequence of obligations. Deals in this market are rarely lost on price — they're lost because a visit was never confirmed or an agreement date slipped.

### `/crm/leads` — unified grid
Filter by status (7 stages), budget band (₹1.2–3 / 3–5 / 5–10 / 10–25 / 25 Cr+), source channel (12, from Instagram and WhatsApp through 99acres/MagicBricks/Housing to broker and walk-in), broker, and HNWI-only. Every row shows the lead score, KYC state, owner and last touch; status is editable inline. Closed deals sink to the bottom regardless of sort — a won lead scores 100 and would otherwise permanently occupy the top of a list whose job is showing what to work on next.

**Lead score (0–100)** weights stage, budget, channel quality (a referral converts far better than a portal), HNWI status and verified KYC — then applies a **staleness penalty**, so a fat stale lead cannot outrank a live one.

### `/crm/pipeline` — deal board
Drag between the 7 stages; milestone dates and follow-ups update automatically. Each column header shows the **weighted** value, not the raw sum: a ₹100 Cr column of brand-new enquiries is not worth ₹100 Cr, and showing it that way is how forecasts become fiction. Stage probabilities run 3% (new) → 85% (token paid).

### `/crm/contacts` and `/crm/customers`
Contacts carry HNWI tier (Standard / Affluent / HNWI / UHNWI), net-worth band, relationship manager, language, and **KYC with the actual documents on file** — PAN, Aadhaar, address proof, bank statement — because "KYC pending" without knowing *which* document is missing is not actionable.

Customers add the money view: the Indian residential payment ladder — booking token → agreement + stamp duty → construction-linked installments → registration → final payment — with collected vs. contract value, and overdue payments surfaced at the top.

### `/crm/tasks` and `/crm/follow-ups`
Nine rules generate reminders from lead state:

| Rule | Fires | Why |
|---|---|---|
| `first_response` | New lead, +24h | After a day a portal lead has spoken to three other developers |
| `site_visit_confirm` | 24h before a visit | Unconfirmed visits are the largest source of no-shows |
| `post_visit_call` | +1 day, only if the visit was within 7 days | Objections are still specific and answerable |
| `negotiation_nudge` | Every 3 quiet days | A negotiation that goes quiet is one happening elsewhere |
| `agreement_draft` / `agreement_sign` / `registration` | Token +7d / +21d / +45d | Stamp duty and registration timelines run from the agreement date |
| `kyc_chase` | KYC pending 7 days | The most common silent blocker on payment and registration |
| `reengage` | Contacted, 7 quiet days | Going cold while still counted as active pipeline |

Two properties make this safe to run on every load and on a cron:
- **Deterministic ids** (`auto_{rule}_{leadId}`) — a cron, the button and a page load converge on the same set. (Verified: second run creates 0.)
- **Completed tasks stay completed.** Regenerating something a person deliberately closed is the fastest way to make them ignore the whole list.

`evaluate()` is pure and returns what *should* exist; the caller diffs it against what does. Every generated task shows which rule created it and why.

---

## 2c. Theme

Tailwind v4 emits every `@theme` entry as a real CSS variable, so the whole theme switch is a re-declaration of those variables under `:root[data-theme="light"]` — no `dark:` prefix on thousands of class names.

- Three states: **light**, **dark**, **system** (keeps following the OS after you pick it).
- The accent is **monochrome**: near-black in light mode, inverting to near-white in dark. A black accent on a black background is an invisible button, so `--a-on` carries the label colour with it — same token, both themes, always legible. Chart series 1 is graphite to match; the remaining series keep hue, because separating five series without it is not possible.
- The choice is stored in a cookie and stamped onto `<html>` **on the server**, so there is no flash of the wrong theme and no inline script. The earlier boot script had to be dropped when the Content-Security-Policy moved to a nonce — React strips the nonce attribute on the client, which produced a hydration mismatch. Reading a cookie server-side removed the script, the mismatch and the flash together, and let the policy stay strict. "System" is the *absence* of the attribute, resolved by a `prefers-color-scheme` media query with no JavaScript at all.
- Status colours (`good`/`warn`/`bad`) are theme-driven too, and darkened in light mode — a green tuned for near-black is unreadable on white, and status text is exactly where poor contrast costs someone real information.

---

## 2d. Sign-in

`/signin` is the only screen a signed-out visitor can reach, and it lives in its own
route group with **no navigation, no sidebar and no app chrome**. That is a security
property before it is a design one: the form used to render inside the application
layout, which showed every module and route name in the product to people who had
not yet proved who they were.

**The whole submission runs on the server.** `<form action={serverAction}>` posts to
`src/app/(auth)/signin/actions.ts`. Three things follow, and all three are the reason:

| | Before | Now |
|---|---|---|
| Rate limiting | Browser called Supabase directly, so this app's limiter never saw an attempt | 8 per account / 5 min with a 15-minute lockout, 60 per source address |
| JS on the page | Supabase client shipped to the browser — ~70 kB | None. First load **220 kB → 151 kB** |
| No JavaScript | Dead button | Works — a plain form POST is the fallback, not an error |

**Two real ways in, and no third.** Password, and a one-time email link that sets
`shouldCreateUser: false` so a link request can never mint an account. There is no
"Create account" tab: anyone who can register themselves can read customer records,
so accounts are created by an administrator. A door that will never open is worse
than no door, so it is absent rather than present-and-disabled. The Google button
renders only when `NEXT_PUBLIC_GOOGLE_AUTH_ENABLED=true`, so it is never decorative.

**Every failure says the same sentence.** "Incorrect email or password", whether the
address exists, the password is wrong, or the account is disabled — distinct errors
let anyone assemble a list of real accounts by trying addresses. The magic-link
confirmation is identical for the same reason. The one case that *does* get its own
message is signing in successfully to an account with no role here yet, because that
person did nothing wrong and needs to be told to ask an administrator.

**The motion is deliberate about what it costs.** The drifting aurora, the dot grid,
the sliding method pill and the button sheen are pure CSS on `transform` and
`opacity`, so the compositor runs them on the GPU without touching the main thread —
zero JavaScript on the page where someone is waiting to get in. Framer Motion covers
only what CSS cannot do well: the entrance stagger and the crossfade between the two
methods. It is loaded through `LazyMotion` with the feature bundle in a deferred
chunk, so the form is on screen and usable before the animation engine arrives.
Everything is disabled under `prefers-reduced-motion`.

**Small things that prevent support calls:** a Caps Lock warning in the password
label row (in the label, so nothing moves on screen while you are typing), a
show/hide toggle, autofocus on the first field, and a focus *ring* rather than a
colour change, because a colour change alone is invisible to a lot of people.

---

## 3. Architecture

```
Next.js 15 (App Router) · React 19 · TypeScript strict · Tailwind v4 · Recharts 3

src/lib/
  types.ts              One domain model. Workspace → Brand → Connection → Post → Target.
  db.ts                 Repository: read() / mutate(). Atomic JSON store.
  seed.ts               Deterministic 200-day demo dataset.
  page-context.ts       Every page resolves brand + range identically.

  platforms/            ── ONE INTERFACE PER NETWORK ──
    types.ts            PlatformAdapter: capabilities, validate(), publish(), rateLimit()
    meta.ts             Instagram + Facebook (real Graph API calls)
    whatsapp.ts         WhatsApp Cloud API: send, 24h window, webhook parsing
    others.ts           TikTok, YouTube, LinkedIn, X, Google Business
    ads.ts              Meta Insights + Google Ads GAQL → one AdStat row shape
    oauth.ts            Connect specs: scopes, authorize URLs, what each unlocks
    registry.ts         Lookup + display metadata

  board/templates.ts    Board templates, colour ramp, orphan detection

  crm/
    types.ts            Leads, brokers, contacts, transactions, tasks
    rules.ts            ★ 9 follow-up rules (pure) + lead scoring
    format.ts           Indian currency: ₹4.5 Cr, ₹85 L, 2-2-3 grouping
    seed.ts             61-lead pipeline engineered to exercise every rule

  engine/
    publisher.ts        The publish worker: per-target state, backoff, quota checks
    sync.ts             Inbound retrieval from every channel, idempotent by platform id
    besttime.ts         Shrinkage-based best-time-to-post engine

  ai/
    signals.ts          ★ The 12 analysers. Pure functions, no LLM required.
    copy.ts             Per-network caption generation + hook rewriting
    reviews.ts          Review reply drafting + sentiment/topic tagging
    narrative.ts        Executive summary
    provider.ts         Anthropic client (optional — everything degrades gracefully)

  metrics/
    aggregate.ts        Rollups, timeseries, period-over-period
    stats.ts            Robust z-score, MAD, Wilson bound, trend slope

  media/render.ts       MediaEdit recipe → ffmpeg filtergraph → cached renders
```

### Why a JSON store

Storage sits behind exactly two functions — `read()` and `mutate()`. That makes the whole product runnable with `npm run dev` and nothing else, while keeping the swap to Postgres/Drizzle a single-file change. No page, engine or analyser touches storage directly. Writes are atomic (temp file + rename), so a crash mid-write cannot truncate the database.

### Multi-tenancy

`Workspace → Brand → Connection`. Every record carries a `brandId`; every query filters on it; the brand switcher is a query param. Adding a client is one entry in `BRAND_BLUEPRINTS` (or one `POST` once you wire a form) — no code changes anywhere else.

---

## 4. Publishing engine

`src/lib/engine/publisher.ts` — the part that has to survive production.

**Per-target state, not per-post.** A post fans out to one *target* per account. If Instagram succeeds and TikTok fails, the post is partially published and only TikTok retries. A target that already has an `externalId` is skipped, so re-running the tick **can never double-post** (verified: second tick publishes 0).

**Quota checks before the call.** The worker asks each adapter how much publishing quota the account has left rather than hardcoding a number. Instagram's published limits are inconsistent across Meta's own docs (25 / 50 / 100 per rolling 24h, depending on the page) and differ per account, so the only correct source is the account's own `GET /{ig-user-id}/content_publishing_limit` edge. Out of quota → defer, don't burn an API error.

**Retry classification comes from the adapter, not from string matching.** 429 / 5xx / Graph codes 4, 17, 2, 9007 (media still transcoding) are retryable with 2 → 10 → 45-minute backoff. A 400 like "caption too long" or "wrong aspect ratio" stops immediately and surfaces in the calendar in red.

**Expired connections defer, they don't fail.** The demo ships with an intentionally expired TikTok token so you can see this path.

**Instagram publishing is genuinely two-step** (`meta.ts`):
1. `POST /{ig-user-id}/media` → container id (carousels create children first, then a `CAROUSEL` parent)
2. poll `GET /{container-id}?fields=status_code` until `FINISHED` (video transcode is 5–60s)
3. `POST /{ig-user-id}/media_publish`
4. first comment posted separately — which is where hashtags belong on IG

Stories use `media_type=STORIES` and carry no caption. Facebook uses `published=false` + `scheduled_publish_time` so the *platform* holds the post — more reliable than our worker holding it.

**Run it:**
```bash
curl -X POST "http://localhost:4321/api/publish/tick?secret=dev-secret"
```
or the **Run queue now** button in the calendar. Point a 5-minute cron at that endpoint in production.

**Validation runs twice, from one source.** Adapter capabilities (caption limits, hashtag caps, media counts, supported formats, aspect ratios) drive both the live client-side warnings in the composer and the server-side rejection in `POST /api/posts`. You cannot schedule something that will fail at 6am.

---

## 5. The AI insight engine

`src/lib/ai/signals.ts` — the reason this is more than a chart wall.

**Two design rules:**

1. **No LLM is required to produce a recommendation.** Every number, threshold and projected impact is computed from the account's own data. The LLM only *rewrites* findings in nicer prose. It never invents a number, and with no API key you still get every recommendation.
2. **Every suggestion carries a projected impact in a comparable unit**, so a Meta fatigue finding can be ranked against an Instagram timing finding instead of twelve unranked cards.

| # | Analyser | Fires when | Action |
|---|---|---|---|
| 1 | **Creative fatigue** | frequency > 2.8x **and** CTR trending down > 1.5%/day (both required, so a healthy small-audience ad isn't paused). CPM drift confirms and raises severity | Generate fresh hooks |
| 2 | **Budget reallocation** | ROAS gap > 1.4x between ad sets in one campaign, ranked by **Wilson lower bound** so 3 lucky conversions can't win. Moves capped at 30% — bigger jumps re-trigger the learning phase | Shift $X/day |
| 3 | **Boost organic** | A recent post is a >1.5σ engagement outlier **vs. the account's own history** (not an industry benchmark), not already boosted. Paid reach estimated from your own blended CPM | Boost for $150 |
| 4 | **Posting time** | A day×hour cell beats the account average by >25% on ≥2 posts | Re-time the queue |
| 5 | **Format mix** | Best format out-reaches worst by >1.5x while being <55% of output | Plan 4 more |
| 6 | **Hook quality** | ≥30% of reels hold <45% at 3 seconds; quantifies the reach gap vs. strong openers | Rewrite 5 hooks |
| 7 | **Anomaly detection** | Yesterday is >2.5σ from the 30-day **median** using MAD — one viral day can't blind the detector for a month | — |
| 8 | **Budget pacing** | Projected flight spend deviates >15% from plan | Set daily cap |
| 9 | **Review response** | Unanswered negatives, or reply rate <70% | Draft replies |
| 10 | **Local visibility** | Top-3 grid coverage <60% for a keyword | — |
| 11 | **Competitor cadence** | Competitors publish >1.5x more often | — |
| 12 | **Queue health** | <7 days of runway, or any failed post | — |

**Ranking:** severity first, then confidence-weighted impact **normalised within each unit** — you cannot compare "$4,200" to "18%", so scores are normalised per unit and interleaved.

**Statistics that matter** (`metrics/stats.ts`):
- **Robust z-score** (median + MAD, not mean + stdev) — one viral day would inflate mean/stdev enough to hide every other anomaly for a month.
- **Wilson lower bound** — ranks a 10% CTR on 40 impressions below 4% on 40,000.
- **James–Stein style shrinkage** in the timing engine — a 1-post time slot barely moves off the account average; a 12-post slot is trusted. The heatmap outlines cells with 3+ posts so you can see which recommendations are evidence and which are extrapolation.

**Every card is executable.** `POST /api/actions` applies the change locally *and* calls the platform write API (`setMetaBudget`, `setAdStatus`, boost creation, queue re-timing, bulk review drafting).

---

## 6. Video Studio & render pipeline

The Studio is a **declarative editor**: every control writes into a `MediaEdit` recipe, and the server turns that recipe into an ffmpeg filtergraph. Nothing is destructive — the master file is never touched.

Controls: trim, focal-point crop, speed ramp, brightness/saturation, music volume, burned-in captions (3 styles), timed text/CTA overlays, and **AI hook suggestions** that drop straight in as overlays.

**Filter order matters** and is deliberate: trim → speed → colour → scale/crop around the focal point → overlays → subtitles. Cropping last would discard the pixels the overlays were positioned against.

**One render per aspect ratio.** A 9:16 reel and a 4:5 feed post need genuinely different crops — you cannot post one master to both without letterboxing or a bad crop. Renders are cached by a hash of `(assetId + recipe + aspect)`, so publishing the same edit to a second network is free. `-movflags +faststart` puts the moov atom first, which measurably speeds up Instagram's container processing.

**No ffmpeg installed?** The Studio still works: it returns the exact command it *would* have run, marked `simulated`, and shows it in the UI. Auditable rather than a black box.

---

## 7. Ads: Meta + Google in one place

Meta and Google model campaigns completely differently. Both are normalised **at the edge** into one `AdStat` row (`platforms/ads.ts`):

- **Meta** — `GET /{ad_account}/insights`, `level=ad`, `time_increment=1`. Conversions and revenue are pulled out of the `actions` / `action_values` arrays by action type (purchase, lead, messaging conversation), with cursor pagination.
- **Google** — GAQL over `searchStream`, with `cost_micros` converted so nothing downstream needs to know Google stores money in millionths.

Because both land in the same shape, every chart, every analyser and the whole Ads page work on one grain — which is what makes "both platforms in one place" true rather than two dashboards side by side. Blended ROAS, blended CPA and cross-platform budget comparison all fall out for free.

---

## 7b. WhatsApp & retrieving everything

**WhatsApp Cloud API** (`platforms/whatsapp.ts`) — the integration is dominated by one rule, so the code enforces it rather than letting Meta reject the call:

> **The 24-hour customer service window.** Free-form messages deliver only within 24 hours of the customer's last message. Outside it, only a pre-approved *template* delivers.

`sendWhatsApp` checks the window first and returns `requiresTemplate: true` with a plain-English reason. The inbox shows `"7h left to reply freely"` or `"template required"` on the thread **before** you type.

**Webhook** — `GET /api/webhooks/whatsapp` echoes `hub.challenge` as **plain text** (returning JSON is the classic reason a WhatsApp webhook never activates). `POST` filters out status callbacks (sent/read arrive on the same endpoint) and keys on the platform message id, so Meta's retries can't duplicate a conversation.

**Retrieval** (`engine/sync.ts`) — `POST /api/sync` pulls comments, mentions, DMs, WhatsApp messages and reviews from every connected channel into the `conversations` and `reviews` models. Two guarantees:
- **Idempotent** — every item is keyed by its platform id, so a cron, a button and a webhook replay converge on the same state. (Verified: a second sync creates 0.)
- **Partial success** — each source is caught independently, so one dead token can't abort the others; failures are reported per channel.

**Connecting** — `/connections` lists all 10 channels. Each row states what the connection unlocks and every scope it requests *before* you click, because "why does this app want that permission?" is a question clients actually ask. In live mode the button returns the provider's authorize URL; in mock mode it connects immediately so the whole product is demonstrable without registering six developer apps.

---

## 8. Going live

```bash
cp .env.example .env
```

| Variable | Effect |
|---|---|
| `PLATFORM_DRIVER=live` | Switches every adapter from simulated to real HTTP |
| `META_SYSTEM_USER_TOKEN`, `META_AD_ACCOUNT_ID`, `META_GRAPH_VERSION` | Instagram, Facebook Pages, Meta Ads |
| `GOOGLE_ADS_*` | Google Ads (developer token + OAuth refresh token) |
| `ANTHROPIC_API_KEY` | **Optional.** Better prose. Without it the deterministic engines run |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_VERIFY_TOKEN` | WhatsApp send + webhook verification |
| `GOOGLE_CLIENT_ID`, `TIKTOK_CLIENT_KEY`, `LINKEDIN_CLIENT_ID`, `X_CLIENT_ID` (+ secrets) | The Connect flow for each network |
| `WORKER_SECRET` | Protects the publish tick endpoint |

Instagram scopes needed: `instagram_basic`, `instagram_content_publish`, `instagram_manage_insights`, `instagram_manage_comments`. Media must be at a **publicly reachable URL** — Meta pulls from a URL, it does not accept uploads.

Settings → System status shows exactly what is wired up on the current install.

---

## 9. Extending

**A new brand:** add to `BRAND_BLUEPRINTS` in `seed.ts` (or POST once you wire a form). Everything else — dashboards, analysers, reports, calendar — works immediately, because nothing anywhere assumes one business.

**A new network (Pinterest, Threads, Bluesky):** one file in `src/lib/platforms/` implementing `PlatformAdapter`, plus one line in `registry.ts`. The composer picks up its limits, the validator enforces them, the publisher routes to it, the calendar colours it. Zero changes anywhere else.

**A real database:** reimplement `read()` and `mutate()` in `db.ts`.

---

## 10. File map

```
src/app/(app)/        15 pages — signed in; the sidebar and the page-permission guard
src/app/(auth)/       signin · setup — signed out; no navigation, no guard to loop on
src/app/auth/callback code exchange for magic links and OAuth
src/app/api/          actions · ai/copy · ai/reply · board · board/cards · connections
                      crm/leads · crm/tasks · crm/followups
                      posts · publish/tick · render · seed · slots · sync
                      webhooks/whatsapp · whatsapp/send
src/components/       auth/ (sign-in form · brand panel · mark) · messaging/
                      shell · ui · charts · theme-toggle · composer · studio · calendar-view
                      board-view · board-settings · connect-panel · inbox
                      crm/leads-grid · crm/pipeline · crm/tasks-list
                      reviews-panel · suggestion-card
src/lib/              types · db · seed · page-context · platforms/ · engine/ · ai/ · metrics/ · media/
```

**Commands**
```bash
npm run dev         # dev server on :4321 (Turbopack)
npm run dev:webpack # same, on webpack — fallback if Turbopack misbehaves
npm run build       # production build
npm run typecheck   # tsc --noEmit
npm run tick        # run the publish queue once
npm run reseed      # wipe the demo database (rebuilds on next request)
```

---

## 11. What is real vs. simulated

**Real, production-shaped code:**
- Instagram/Facebook Graph API publishing — container → poll → publish, carousels, stories, first comments, scheduled publishing
- Meta Insights and Google Ads GAQL fetch + normalisation, including `actions`/`action_values` parsing and micros conversion
- Budget and ad-status write-backs
- Rate-limit reads from `content_publishing_limit`
- WhatsApp Cloud API send, 24-hour window enforcement, webhook verification and payload parsing
- Inbound retrieval with idempotency by platform id and per-channel error isolation
- The whole board: HITL gates, orphan recovery, template remapping, field configuration
- The whole CRM: range-overlap budget filtering, lead scoring, weighted pipeline forecasting, the 9-rule follow-up engine and its idempotency
- Retry/backoff, per-target state, quota deferral
- ffmpeg filtergraph construction and rendering
- **All 12 analysers and all statistics** — these run on whatever data you give them
- Every platform capability set (caption limits, hashtag caps, formats, aspect ratios) and the validation built on it

**Simulated until you add keys:**
- `PLATFORM_DRIVER=mock` returns deterministic publish results (with a ~4% retryable failure rate, so the retry path is exercised in demo mode rather than for the first time in production)
- TikTok / YouTube / LinkedIn / X / Google Business `publish()` are wired to the mock driver; each one's live call shape is documented inline at the call site
- The 200-day dataset in `seed.ts`

The CRM seed is engineered the same way: a realistic funnel (16 new → 5 won), leads deliberately left stale so `reengage` fires, site visits both upcoming and just-past so both visit rules fire, tokens paid so the agreement→registration chain appears, and an overdue installment so the payment-chase path has a subject.

The seed is **deliberately engineered, not random**: it contains a fatigued ad, a ROAS imbalance, a viral organic post, a genuinely better posting slot, a cluster of weak video hooks, unanswered negative reviews, a patchy rank grid, a broken link-click day, an expired token and a permanently-failed post — so **every analyser has something real to find on first load**. Pure noise would produce an empty insights page.
