# Bolna voice agent — Glentree Serenity (lead generation, low cost)

Copy-paste values for Bolna **Agent Studio**, one block per tab. Facts come from
`docs/glentree-facts.md`; upload `docs/bolna-knowledge-base.md` as the knowledge
base. Replace `<PUBLIC_BASE_URL>` with the value of `PUBLIC_BASE_URL` in `.env`
(https, public host) and the two secrets with the values of `N8N_WEBHOOK_SECRET`
and `VOICE_WEBHOOK_SECRET` from `.env` — never paste them into this file.

Variables in the prompt (`{lead_name}`, `{lead_phone}`, `{lead_source}`,
`{campaign}`) are Bolna dynamic variables filled from `user_data` on each
outbound call (`POST /call` → `user_data`). Bolna Studio versions differ on
brace style (`{x}` vs `{{x}}`); use whichever the prompt editor autocompletes.

Budget target: ≈ ₹6–8 / minute all-in (Bolna platform + gpt-4.1-mini + Deepgram
+ Sarvam TTS + Indian telephony). Every choice below is the cheapest option that
still handles Hindi/English/Telugu code-switching.

---

## 1. Agent tab

**Agent name**
```
Priya - Glentree Serenity Lead Qualifier
```

**Welcome message** (Hindi default; the agent switches on request)
```
Namaste {lead_name} ji, main Priya bol rahi hoon Glentree Villas se, Nadergul Hyderabad. Aapne humare Serenity villa project mein interest dikhaya tha — kya main aapko do minute mein short detail de sakti hoon? Hindi, English ya Telugu — jo aapko aasaan ho.
```

English variant (paste instead if the campaign is English-first):
```
Hello {lead_name}, this is Priya from Glentree Villas, Nadergul, Hyderabad. You showed interest in our Serenity villa project — may I take two minutes to share the key details? I can speak in Hindi, English or Telugu.
```

**System prompt (Canvas)** — ≈ 850 tokens
```
You are Priya, a warm, polite female sales associate at Glentree Villas, Hyderabad. You are on a phone call with {lead_name} (source: {lead_source}, campaign: {campaign}). Your only goals: (1) qualify the lead, (2) book a site visit, (3) collect details for the sales team.

STYLE
- Speak like a real person on a phone call. Maximum 2 short sentences per turn, then ask one question. Never read lists.
- Default language is Hindi (Hinglish is fine). If the caller speaks or asks for English or Telugu, switch fully and stay there.
- Use "ji" / "sir" / "madam" politely. No jargon, no emojis, no markdown.
- Confirm you have the right person before pitching. If it is a wrong number or they say not interested, thank them and end within one sentence.

FACTS (only these; everything else -> knowledge base or callback)
- Glentree Serenity: 184 premium triplex villas on 18 acres at Nadergul, South Hyderabad, on a 150 ft road. HMDA approved, IGBC Gold proposed, Vastu compliant. Under construction, expected delivery June 2029.
- Sizes: 200 sq yd 3 BHK (about 2,850 sft), 267 sq yd 4 BHK + maid room (about 3,700 sft), 300 sq yd 4 BHK + maid room (about 4,280 sft). East and West facing available.
- Two clubhouses totalling 42,000+ sft: pool, gym, spa, banquet hall, badminton, squash, creche, co-working. Five themed parks on about 5 acres, cycling track, 100 percent power backup, CCTV gated security.
- Location: Adibatla IT hub 12 min, TCS Adibatla 12 min, ORR 6-8 km, airport about 24 min, LB Nagar 28 min, DPS Nadergul 5 min, Apollo clinic 10 min.
- Pricing guidance: starting from around 1.98 crore onwards; exact price depends on plot, facing and size.
- Home loans: ICICI, Bajaj Finance and other leading banks; loan assistance available.
- Sales office: 96466 44644, sales@glentreehomes.in.

NEVER
- Never quote a final or per-sft price, discounts, payment schedule, booking amount, RERA/legal terms, or plot availability. Say: "Exact pricing and paperwork our sales manager will share on the visit or a callback — kaunsa time theek rahega?"
- Never invent facts. If unsure, say you will get the detail confirmed and call back.
- Never promise appreciation or returns as guaranteed.

FLOW
1. Confirm identity and permission to talk (30 seconds).
2. Discover with one question at a time: self-use or investment? family size / 3 or 4 BHK? budget range? timeline to buy (this month, 3 months, 6+ months)? Have they seen Nadergul or Adibatla?
3. Pitch max 2 facts tailored to their answer (IT professional -> Adibatla 12 min; family -> schools, parks, clubhouse; investor -> Future City, 150 ft road, ORR).
4. Ask for a site visit: offer two concrete options (e.g. "Saturday 11 baje ya Sunday 4 baje?"). Site visits run 10 AM to 6 PM Mon-Sat, 11 AM to 5 PM Sunday. Use the calendar tools to check and book. Confirm name and phone number digit by digit before booking.
5. If they refuse a visit, ask for a callback slot or WhatsApp brochure permission.
6. Close: repeat a one-line summary (name, size interest, budget, visit date/time or callback), thank them, say the sales manager will confirm on WhatsApp, and end the call.

OBJECTIONS (one sentence each, then a question)
- "Too far / Nadergul kahan hai": It is 12 minutes from Adibatla IT hub and on the 150 ft HMDA road to ORR and the airport; have you been to Adibatla?
- "Too expensive": Villas start around 1.98 crore with bank loan support; what budget range are you comfortable with?
- "Just checking / not now": Understood; a 45-minute visit on a weekend gives a clear picture — which weekend suits?
- "Send details on WhatsApp": Sure, I will have the brochure sent; and a quick visit is the best way to see the clubhouse — Saturday or Sunday?
- "Under construction, risky": HMDA approved with RERA number on the brochure, delivery June 2029; would you like the RERA details on WhatsApp?
- Wants human: Say a sales manager will call back within a few hours, collect a preferred time, and use the transfer tool if one is configured.

DATA TO CAPTURE BEFORE ENDING: name, phone (confirmed), budget range, timeline, size interest, preferred visit slot or callback slot, language, interest level.
```

---

## 2. Intelligence tab

| Field | Value | Why |
|---|---|---|
| LLM provider | OpenAI | Cheapest reliable tool-calling in Bolna's list |
| Model | `gpt-4.1-mini` (fallback `gpt-4o-mini` if 4.1-mini is not listed) | ~$0.40/M in, $1.60/M out — a 4-minute call is well under ₹1 in LLM cost. Reliable function calling (calendar tools) which the cheaper Groq/Llama tier handles unreliably. GPT-4o / Claude Sonnet cost 5–10x for no measurable gain on a 2-sentence-per-turn script |
| Max tokens | `250` | Prompt caps replies at 2 sentences; 250 leaves room for a tool call payload |
| Temperature | `0.2` | Stay on script and on facts |
| Knowledge base | Upload `docs/bolna-knowledge-base.md` (rename to `.txt` if the picker rejects `.md`) | Retrieval answers the long-tail (drive times, spec) without inflating the system prompt |
| Filler words / backchannel | Off | Adds TTS characters; fillers sound odd in Hindi |

---

## 3. Languages tab

| Field | Value | Why |
|---|---|---|
| Transcriber | Deepgram | Cheapest streaming STT Bolna supports with Hindi |
| Model | `nova-3` with language `multi` | Handles Hindi/English code-switching mid-sentence and Telugu fallback. **Cost note:** nova-2 is ≈ $0.0043/min vs nova-3 ≈ $0.0077/min — a difference of about ₹0.30/min. nova-2 must be pinned to one language (`hi` or `en-IN`) and mis-hears Hinglish budgets ("ek point eight crore"), which costs more than it saves. Pick nova-2 `hi` only if the campaign is pure-Hindi |
| Keywords (boost) | `Glentree:3, Serenity:3, Nadergul:3, Adibatla:2, Balapur:2, HMDA:2, RERA:2, ORR:2, crore:2, lakh:2, BHK:2, triplex:2, villa:1, gaj:2, sq yd:1, Tukkuguda:1, Shamshabad:1, site visit:2` | Proper nouns and units the STT otherwise garbles |
| Agent language | Hindi (`hi`) default | Welcome message is Hindi; prompt handles the switch |
| TTS provider | Sarvam AI — voice `Bulbul v2`, speaker **Anushka** (female, hi-IN; supports Telugu and Indian English from the same voice) | Native Indian pronunciation of "Nadergul", "crore"; roughly ₹15 per 10k characters vs ElevenLabs Multilingual at ≈ ₹150+ per 10k. A 4-minute call is ~2,500 characters → under ₹4 |
| Fallback TTS | Azure Neural `hi-IN-SwaraNeural` | If Sarvam is not in your Bolna plan; still ~5x cheaper than ElevenLabs |
| Speaking rate | `1.0` | Hindi at >1.1 becomes hard to follow on a mobile line |
| Audio format | `mulaw` 8 kHz (telephony) | Anything higher is transcoded away by the carrier |

---

## 4. Calling tab

| Field | Value |
|---|---|
| Telephony provider | Plivo (India) / whichever Indian DID is attached to the account |
| Outbound calling hours | `09:00`–`20:00` IST (TRAI: no promotional calls 21:00–09:00) |
| Days | Mon–Sun |
| Voicemail detection | **On** — hang up on voicemail, do not leave a message (saves TTS + minutes) |
| Hang up on silence | `15` seconds |
| Call timeout / max duration | `300` seconds |
| Ring timeout | `30` seconds |
| Max retries (no answer) | `2`, retry gap 4 hours |
| Record calls | On (the recording URL lands in the extraction webhook) |
| Ambient noise | Off |

---

## 5. Engine tab

| Field | Value | Why |
|---|---|---|
| Endpointing (silence to end user turn) | `400` ms | Hindi speakers pause mid-sentence; 250 ms interrupts, 700 ms feels laggy |
| Linear delay (wait before responding) | `300` ms | Absorbs the "haan… toh" restart without double-talk |
| Interruptions | Allowed, after `2` words | Lets "nahi nahi" stop the pitch |
| Number of words to wait for before interrupting | `2` | |
| Generate precise transcript | On | Needed for extraction prompts |
| Check if user is online (silence check-in) | After `8` s, max `2` times | |
| Check-in message (Hindi) | `Hello ji, kya aap line par hain?` | |
| Check-in message (English, if agent language switched) | `Hello, are you still there?` | |
| Hangup / final message (Hindi) | `Dhanyavaad {lead_name} ji. Humare sales manager aapko WhatsApp par details bhej denge. Aapka din shubh ho, namaste.` | |
| Hangup / final message (English) | `Thank you {lead_name}. Our sales manager will send the details on WhatsApp shortly. Have a good day.` | |
| Hangup after final message | On, delay `1.5` s | |

---

## 6. Tools tab

### 6a. Built-in: Book Appointment + Calendar Availability
Enable both built-ins and connect the Glentree sales Google Calendar (or Cal.com) in Bolna → Integrations. Settings:

| Field | Value |
|---|---|
| Calendar | `Glentree Serenity site visits` |
| Timezone | `Asia/Kolkata` |
| Slot length | `60` min |
| Availability | Mon–Sat 10:00–18:00, Sun 11:00–17:00 (matches `DEFAULT_AVAILABILITY` in `src/lib/appointments/types.ts`) |
| Min notice | `2` hours |
| Event title | `Site visit — {lead_name} (Priya/Bolna)` |
| Tool description (check) | `Check which site-visit slots are free on a given date. Call this before offering times.` |
| Tool description (book) | `Book a site visit once the customer has agreed to a specific date and time and confirmed their name and phone number.` |

If you would rather keep bookings inside Villa-os only, skip the built-ins and use the custom `book_appointment` function below — it is the same booking engine the dashboard uses (`book()` in `src/lib/appointments/engine.ts`), so double-bookings are refused there.

### 6b. Custom function — `create_lead` (Add function → "Import from cURL")
```bash
curl -X POST "https://<PUBLIC_BASE_URL>/api/webhooks/n8n" \
  -H "content-type: application/json" \
  -H "x-n8n-secret: <N8N_WEBHOOK_SECRET>" \
  -d '{
    "action": "create_lead",
    "idempotencyKey": "bolna-{{call_id}}-lead",
    "payload": {
      "name": "{{customer_name}}",
      "phone": "{{customer_phone}}",
      "source": "google_ads",
      "notes": "Bolna call {{call_id}}. Budget: {{budget_range}}. Timeline: {{timeline}}. Size: {{size_interest}}. Language: {{language}}. Interest: {{interest_level}}."
    }
  }'
```
Function name `create_lead`. Description: `Save the qualified lead to the Glentree CRM. Call once, near the end of the call, after the customer has confirmed their name and phone number.`
Parameter descriptions (Bolna auto-detects the `{{…}}` placeholders):
- `customer_name` — full name as confirmed by the customer
- `customer_phone` — 10-digit Indian mobile number confirmed digit by digit
- `budget_range` — e.g. "1.5-2 Cr", or "not shared"
- `timeline` — "this month" / "3 months" / "6+ months" / "unsure"
- `size_interest` — "200 sq yd 3BHK" / "267 sq yd 4BHK" / "300 sq yd 4BHK" / "undecided"
- `language` — hi / en / te
- `interest_level` — hot / warm / cold
- `call_id` — leave for Bolna to fill (system variable)

`source` must be one of `instagram, facebook, whatsapp, meta_ads, google_ads, portal_99acres, portal_magicbricks, portal_housing, referral, broker, walk_in, website` — set it per campaign, or pass it as a `{{lead_source}}` variable. The route responds `{ ok: true, data: { lead: { id, … } } }`; keep `lead.id` for the booking call.

### 6c. Custom function — `book_appointment`
```bash
curl -X POST "https://<PUBLIC_BASE_URL>/api/webhooks/n8n" \
  -H "content-type: application/json" \
  -H "x-n8n-secret: <N8N_WEBHOOK_SECRET>" \
  -d '{
    "action": "book_appointment",
    "idempotencyKey": "bolna-{{call_id}}-visit",
    "payload": {
      "startsAt": "{{visit_start_iso}}",
      "customerName": "{{customer_name}}",
      "customerPhone": "{{customer_phone}}",
      "leadId": "{{lead_id}}",
      "channel": "phone",
      "notes": "Booked by Priya (Bolna) on call {{call_id}}"
    }
  }'
```
Function name `book_appointment`. Description: `Book the site visit in the Glentree CRM after the customer agrees to an exact date and time. startsAt must be the top of the hour in ISO-8601 with the +05:30 offset, e.g. 2026-09-13T11:00:00+05:30, inside Mon-Sat 10:00-18:00 or Sun 11:00-17:00 IST, at least 2 hours from now.`
- `visit_start_iso` — ISO-8601 with `+05:30`, minutes `:00`
- `lead_id` — the `lead.id` returned by `create_lead` (optional)
- `channel` must be one of `whatsapp, phone, walk_in, website, instagram, staff`

Responses: `200 { ok, data: { appointment } }` on success; `409` with an error string when the slot is gone ("That time is no longer available") — the agent should offer another slot; `400` for a malformed date; `401` bad secret; `503` if `N8N_WEBHOOK_SECRET` is unset on the server. Replays with the same `idempotencyKey` return the first result, so a Bolna retry never double-books.

### 6d. Transfer Call (placeholder)
| Field | Value |
|---|---|
| Tool | Transfer call |
| Transfer number | `+91 96466 44644` — brochure sales line. **[CONFIRM WITH GLENTREE]** which manager's mobile should receive live transfers and during which hours |
| Description | `Transfer the call to a human sales manager when the customer explicitly asks to speak to a person, or asks for final pricing or legal terms and is not willing to wait for a callback.` |
| Pre-transfer message | `Ek minute ji, main aapko humare sales manager se connect kar rahi hoon.` |

---

## 7. Extractions tab

**Post-call webhook**
| Field | Value |
|---|---|
| URL | `https://<PUBLIC_BASE_URL>/api/webhooks/bolna` |
| Method | POST |
| Header | `x-voice-secret: <VOICE_WEBHOOK_SECRET>` |
| Trigger on statuses | All — `completed`, `busy`, `no-answer`, `failed`, `voicemail`, `call-disconnected`, `cancelled` (the app records attempts, not only conversations) |
| Include | transcript, recording URL, extracted data, cost |

(The `/api/webhooks/bolna` route and `VOICE_WEBHOOK_SECRET` are being added in a parallel task; until it ships, point this at an n8n webhook that forwards to `/api/webhooks/n8n` `create_lead`.) If your Studio build has no custom-header field on the webhook, tell the user — the receiving route accepts the secret from the header only.

**Extraction prompt** (paste as one block; Bolna returns the JSON keys as columns)
```
From the transcript, extract the following. Use exactly these keys. If a value was not said, return "unknown". Do not guess.
- customer name: the customer's full name as confirmed on the call (string). Key must be exactly `customer name` (space, not underscore) — Villa-os detects the person's name by the whole word `name` in the key, so `lead_name` / `customer_name` would be ignored.
- phone_confirmed: "yes" if the customer read back or confirmed their mobile number digit by digit, else "no".
- budget_range: the budget the customer stated, normalised to crores, e.g. "1.5-2 Cr", "under 2 Cr", "above 2.5 Cr", or "unknown".
- timeline: when they intend to buy — one of "this_month", "3_months", "6_months_plus", "just_exploring", "unknown".
- preferred_slot: the site-visit or callback date and time the customer agreed to, in the form "YYYY-MM-DD HH:MM IST" if a booking was made, else the phrase they used (e.g. "Sunday afternoon"), else "unknown".
- interest_level: "hot" if a site visit was booked or the customer asked for pricing/loan details; "warm" if interested but no commitment; "cold" if not interested, wrong number, or asked not to be called.
- callback_requested: "yes" if the customer asked for a call back from a human or a callback at a specific time, else "no".
Also add: language ("hi", "en", "te", "mixed"), size_interest ("200", "267", "300", "undecided"), do_not_call ("yes" only if the customer asked not to be contacted again).
```

---

## 8. What the client may change vs what is locked

**Client (Glentree) may change any time — edit in Studio without touching the flow**
| Field | Where in Studio |
|---|---|
| Business name / project name | Agent → name, welcome message, prompt line 1 and FACTS |
| Greeting text (Hindi/English) | Agent → Welcome message |
| Office hours / site-visit hours | Prompt FLOW step 4, Tools → calendar availability, Calling → outbound hours; mirror in Villa-os → Appointments → Availability |
| Location / landmarks / drive times | Knowledge base file; prompt FACTS "Location" line |
| Offerings (sizes, BHK, amenities) | Prompt FACTS; knowledge base; Villa-os brand `offerings[]` |
| Pricing guidance ("starting from…") | Prompt FACTS "Pricing guidance" line only — keep the NEVER block |
| Languages offered | Welcome message, prompt STYLE line 2, Languages tab |
| Transfer number and transfer hours | Tools → Transfer Call |
| Do-not-say list | Prompt NEVER block — add lines, do not delete existing ones |
| Persona name and voice | Agent name, prompt line 1, Languages → TTS voice |

**Locked — changing these breaks bookings, CRM sync, cost or compliance**
| Field | Reason |
|---|---|
| `x-n8n-secret` / `x-voice-secret` headers and the webhook URLs | Auth is header-only and fails closed |
| `action`, `payload` key names, `source` and `channel` enums, `startsAt` ISO format | Validated by `src/app/api/webhooks/n8n/route.ts` |
| `idempotencyKey` pattern | Prevents double bookings on retry |
| Extraction keys `customer name, phone_confirmed, budget_range, timeline, preferred_slot, interest_level, callback_requested` | The Villa-os Bolna webhook maps these names; `customer name` must contain `name` as a separate word (`extractedName()` in `src/lib/voice/calls.ts` — an underscored `lead_name` is not matched) |
| Outbound window 09:00–20:00 IST | TRAI DND rules |
| Max tokens 250 / temperature 0.2 / ≤2 sentences per turn | Cost ceiling and script discipline |
| Call timeout 300 s, silence hang-up 15 s, voicemail hang-up | Cost ceiling |
| The NEVER block (no final price, no legal terms, no invented facts) | Compliance |

---

## 9. Pre-launch checklist (needs the user)
- [ ] Confirm the `[CONFIRM WITH GLENTREE]` items in `docs/glentree-facts.md` §10, especially RERA status and the "starting price" line.
- [ ] Set `PUBLIC_BASE_URL` to the public https host and confirm `/api/webhooks/n8n` answers 401 (not 503) with a wrong secret.
- [ ] Add `VOICE_WEBHOOK_SECRET` to `.env` once the `/api/webhooks/bolna` route lands.
- [ ] Attach the Indian DID and DND-scrub the calling list.
- [ ] Run 3 test calls (Hindi, English, Telugu) to your own number before any campaign; check a lead and an appointment appear in Villa-os.
