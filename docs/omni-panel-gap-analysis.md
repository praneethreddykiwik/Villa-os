# Omni Panel — feature extraction and gap analysis

**Source** · "How to Automate Customer Engagement & Business Operations | Platform Demo",
Demo Videos, 9 Jul 2026, 26:44. The product is branded **Omni Panel** (tagged #BOL7).

**How this was extracted** · The full caption transcript (17 chapters, 213 segments,
~31,000 characters) plus sampled UI frames at the chapters where the screen layout
matters. Chapter titles and timings below are the video's own.

---

## 1. What Omni Panel actually does, chapter by chapter

| # | Chapter | At | What the demo shows |
|---|---------|----|---------------------|
| 1 | Introduction / Inbox | 0:00 | One inbox merging WhatsApp, SMS, email, Telegram, Messenger, Instagram DMs. Conversations exportable. |
| 2 | AI chatbot and automation | 0:38 | Drag-and-drop chatbot builder. A *trigger* selects which channel the conversation arrives from; branches and a per-bot knowledge base follow. |
| 3 | Contacts and audience | 1:17 | Contact upload, segments, export to WhatsApp. Counts for opt-outs, bounced, blocked, duplicates. Separate **Audience Hub**: search B2B or B2C prospects by keyword, interest and city. |
| 4 | Calendar and scheduling | 2:02 | Meeting scheduling with Zoom, Teams and Google Meet integrations. |
| 5 | CDP | 2:31 | Ingests Meta Ads, Google Ads and website contact forms into one customer store. Libraries, segments, connection reports, identity resolution. Campaigns read the CDP directly — no export/re-import. |
| 6 | Drip campaigns and connections | 3:18 | Multi-step sequences across WhatsApp → SMS → voice → email → RCS, executed without manual steps. **Channels & Connections** grid: per-channel connect, health status, webhooks, verification. |
| 7 | Bulk messaging (Omni) | 4:15 | One place for SMS, RCS, WhatsApp, email and voice blasts. Template library with approval state. |
| 8 | AI Blaster and Social Blaster | 4:48 | *AI Blaster*: bulk messaging driven through Android apps (GB Chat, WhatsApp, SMS, RCS). *Social Blaster*: automated follow / like / comment / share on Facebook, Instagram, TikTok, Twitter, YouTube; bulk posting into WhatsApp groups. |
| 9 | AI Creative Studio | 8:01 | Generation of voice (incl. cloning), images, video and music, then a **Compose** editor to assemble them. Model picker, prompt enhancer, credit cost shown per generation, up to 4 samples. |
| 10 | Multi-AI Chat | 15:33 | Ask one question, several models answer in parallel, responses compared side by side. Models grouped by capability — coding, slides, image analysis. |
| 11 | Agent platform scrapers | 19:18 | An agent with connectors that extracts data from Instagram, Facebook (pages, posts, comments, **Ad Library** incl. spend and run dates), Google, Google Maps. Exports to Excel. |
| 12 | Survey forms | 20:52 | Form templates by sector, a builder with conditional logic, mobile preview, shareable link droppable into any campaign. |
| 13 | Integrations | 21:48 | HubSpot, Zoho, Facebook Ads analytics, LinkedIn. |
| 14 | Mobile call centre | 22:21 | Phone app for field agents; dashboard pushes them lead lists and tracks calls made, leads given, follow-ups. |
| 15 | Billing and usage | 22:50 | Plan, credit balance, dues, usage dashboard and a price book with per-message credit rates (email 0.32, RCS 1.60, WhatsApp marketing 10.97). Payment gateway and invoices. |
| 16 | Support and guides | 23:56 | Ticketing with category, service, priority and attachments; plus per-service setup guides. |
| 17 | User management | 25:39 | Invite users by email and phone; see device, IP, location, created date, last login, status; suspend. |

---

## 2. Where Glentree already stands

Verified against the current codebase, not assumed.

### Already built — no work needed

| Omni Panel module | Glentree equivalent |
|---|---|
| Contacts | `/crm/contacts`, `/crm/customers`, plus `villa_contacts` |
| Calendar | `/calendar` and the appointments engine |
| User management | **Stronger than the demo.** 7 roles, 20 permissions, 53 grants, enforced in the database, with a verified per-role access matrix. Omni Panel shows invite-and-suspend only. |
| Integrations | `/inbox/whatsapp/settings/integrations` |

### Partly built — the parts exist but are gated or thinner

| Module | What exists | What is missing |
|---|---|---|
| Omnichannel inbox | WhatsApp inbox and conversation store | Telegram, Messenger, Discord, SMS, email. **Blocked: the schema was never committed** (see §4) |
| Bot & flows | `automation/workflows`, `routing`, `notifications` | No visual drag-and-drop builder; flows are configured, not drawn |
| Drip campaigns | `sequences.ts`, `automations.ts` | No multi-channel sequencing UI; blocked by the same schema |
| Bulk messaging | `broadcasts.ts`, `campaigns.ts`, `villa_templates` | No template-approval view; blocked |
| CDP | Leads, customers, scoring, one shared record across voice and WhatsApp | No ad-platform or web-form ingestion; no identity resolution across sources |

### Not built at all

Audience Hub · AI Creative Studio · Multi-AI Chat · Agent scrapers · Survey forms ·
Mobile call centre · Billing and credits · Support tickets · Social Blaster · AI Blaster

### Channel coverage

Glentree publishes to Instagram, Facebook, LinkedIn, YouTube, TikTok, X, Google Business
and WhatsApp. **Missing:** SMS, RCS, email as messaging channels, plus Telegram,
Messenger, Discord and web chat.

---

## 3. Three modules to leave alone — and why

Two of the demo's headline features work by breaking the terms of the platforms
Glentree currently depends on. Building them puts the working Meta integration at risk.

**AI Blaster** drives bulk WhatsApp messaging through an Android app rather than the
Cloud API. That is explicitly outside WhatsApp's Business Terms. The usual outcome is
the number being banned — and Glentree's WhatsApp number is the one the sales agent runs on.

**Social Blaster** automates follows, likes, comments and posting into WhatsApp groups.
Automated engagement breaches Meta's and TikTok's platform terms, and the accounts at
risk are the Instagram Business account and Facebook Page we only just got connected.

**Agent scrapers** for Instagram and Facebook extract data Meta does not expose through
its API. Same exposure: the assets at risk are the ones the product runs on.

The compliant versions of each are worth having, and are smaller jobs:

- Bulk WhatsApp through the **Cloud API with approved templates** — supported, already half-built in `broadcasts.ts`.
- Scheduled **first-party publishing** to Instagram and Facebook — already built.
- **Meta Ad Library** data through its official public API rather than scraping.

---

## 4. The blocker that outranks everything here

The WhatsApp console's database schema has never been committed. The code expects
57 `villa_*` tables and points at `supabase/migrations/0001_schema.sql`, which does not
exist in the repository. No `.sql` file anywhere defines those tables, and the live
database has none of them.

**48 of the 87 screens sit behind that gate.** Inbox, drip campaigns, broadcasts,
templates, bookings, site visits and the whole WhatsApp CRM are all inert until it lands.

Moving to a new Supabase account does not change this. Building new modules on top of
it does not either — several of the gaps above are gated behind the same missing tables.

**This has to come from the co-developer before anything else is worth starting.**

---

## 5. Suggested order

Ranked by value to a villa business, not by the demo's running order.

| | Work | Why it comes here | Rough size |
|---|---|---|---|
| 1 | Commit the missing `villa_*` schema | Unblocks 48 screens already written and paid for | Hours, if the file exists |
| 2 | **Channels & Connections** screen | The thing you asked for: connect Instagram and WhatsApp yourself, see health, reconnect. Meta plumbing already exists | 2–3 days |
| 3 | Email + SMS as real channels | Completes the drip sequences already half-written | 3–4 days |
| 4 | Visual flow builder | Turns the existing routing engine into something staff can edit | 1–2 weeks |
| 5 | CDP ingestion from Meta / Google Ads | Closes the loop between ad spend and walk-ins | 1 week |
| 6 | Survey forms | Site-visit feedback and post-handover NPS | 4–5 days |
| 7 | Support tickets | Useful once there are more staff than you can overhear | 3–4 days |
| 8 | AI Creative Studio | Real value for listing content, but large, and partly covered by the video pipeline | 3+ weeks |
| 9 | Multi-AI Chat | Internal productivity, no customer impact | 1 week |
| 10 | Mobile call centre | Only worth it with a field team on phones | 3+ weeks |
| 11 | Billing and credits | Only if Glentree is resold to other builders | 2+ weeks |

---

## 6. Environment variables, by feature

Nothing new is needed for items 1–2. Listed here so they can be added when each is started.

| Feature | Variables |
|---|---|
| Email channel | `RESEND_API_KEY` or `SENDGRID_API_KEY`, `EMAIL_FROM_ADDRESS`, `EMAIL_FROM_NAME` |
| SMS / RCS | `MSG91_AUTH_KEY` or `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`, `SMS_SENDER_ID`, `DLT_ENTITY_ID`, `DLT_TEMPLATE_ID` (India DLT registration is mandatory) |
| CDP ad ingestion | `META_ADS_ACCOUNT_ID`, `GOOGLE_ADS_CUSTOMER_ID`, `GOOGLE_ADS_DEVELOPER_TOKEN`, `GOOGLE_ADS_REFRESH_TOKEN` |
| Meta Ad Library | `META_AD_LIBRARY_TOKEN` |
| AI Studio — images/video | `REPLICATE_API_TOKEN` or `FAL_KEY` |
| AI Studio — voice | `ELEVENLABS_API_KEY` |
| Multi-AI Chat | `OPENROUTER_API_KEY` (one key, many models) |
| Meeting scheduling | `GOOGLE_CALENDAR_CLIENT_ID` + `_SECRET`, `ZOOM_ACCOUNT_ID` + `_CLIENT_ID` + `_CLIENT_SECRET` |
| Billing | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` |

---

## 7. What is not in this analysis

The demo never shows the database, the API surface or how any module is built, so
nothing here describes Omni Panel's implementation — only its behaviour as demonstrated.
Sizing is judgement based on Glentree's existing code, not measurement.
