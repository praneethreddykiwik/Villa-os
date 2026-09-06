# n8n setup

Villa-os talks to n8n in three independent directions. Each one is "connected"
only when its own checklist below is complete — there is no single toggle.

| Direction | What it is | Configured by | Status today |
|---|---|---|---|
| **Inbound** — n8n → Villa-os | `POST /api/webhooks/n8n` with `x-n8n-secret`. Creates leads, books visits, queues WhatsApp drafts. | `N8N_WEBHOOK_SECRET` in `.env` | **Working.** Secret is set; all three actions verified locally. |
| **Outbound** — Villa-os → n8n | Signed JSON POSTs to every registered subscriber URL when an event fires. | Automation page → "Register subscriber" (stored in `db.webhookSubscribers`) | **Not connected.** No subscribers registered. |
| **Video hand-off** — Villa-os → n8n Form | Multipart forward of a video + thumbnail material to your existing posting workflow. | `N8N_VIDEO_FORM_URL` in `.env` (or "Configure Endpoint" on the Automation page) | **Connected.** Form is active (GET 200). The last real submission got 499 — see §3 "Reading the result". |

Everything below assumes your n8n is reachable over **https** on a public host.
The app refuses `http://`, `localhost`, and private/link-local addresses for
every outbound URL (`checkWebhookUrl` in `src/lib/events/bus.ts`).

---

## 1. Inbound: n8n calls Villa-os

### What the app expects

- **URL:** `https://<your-villa-os-host>/api/webhooks/n8n` (the Automation page
  shows the exact URL for the host it is served from).
- **Method:** `POST`. `GET` answers 405.
- **Headers:**
  - `content-type: application/json`
  - `x-n8n-secret: <value of N8N_WEBHOOK_SECRET>` — header only; a query string
    is ignored.
- **Body:**

```json
{
  "action": "create_lead | book_appointment | send_message",
  "idempotencyKey": "optional, up to 200 chars, unique per intended action",
  "payload": { }
}
```

- **Auth behaviour:** constant-time compare, fails closed (503) when the env var
  is unset, 401 on a missing/wrong header. Rate limit: 120 req / 60 s per
  source address, 5-minute lockout.
- **Idempotency:** if `idempotencyKey` is present and was already used
  successfully within 24 h, the first response is replayed with
  `idempotent: true`. A key reused for a *different* action gets 409. Failed
  calls are not recorded, so you may retry the same key after fixing the body.

### n8n checklist

1. **Store the secret as a credential, not in a node field.**
   n8n → *Credentials* → *Create* → **Header Auth**.
   - Name: `x-n8n-secret`
   - Value: paste `N8N_WEBHOOK_SECRET` from Villa-os `.env` (64 chars).
2. **Add an HTTP Request node** wherever your workflow decides to act:
   - Method `POST`
   - URL `https://<your-villa-os-host>/api/webhooks/n8n`
   - Authentication: *Generic Credential Type* → *Header Auth* → the credential above
   - Send Body: on, *Body Content Type* = JSON, *Specify Body* = *Using JSON*
   - Paste one of the bodies below, replacing values with expressions
     (`{{ $json.name }}` etc.).
   - Options → *Response* → keep JSON. On a 4xx/5xx n8n throws; use
     *Continue On Fail* if you want to branch on `error`.
3. **Set an `idempotencyKey`** built from the upstream event id
   (`{{ $json.messageId }}`, calendar event id, …) so a re-run of the workflow
   does not create a second lead or second site visit.

### Sample bodies

**create_lead** — `name`, `phone` required; `source` must be one of
`instagram, facebook, whatsapp, meta_ads, google_ads, portal_99acres,
portal_magicbricks, portal_housing, referral, broker, walk_in, website`.

```json
{
  "action": "create_lead",
  "idempotencyKey": "wa-{{ $json.messageId }}",
  "payload": {
    "name": "Priya Sharma",
    "phone": "+91 98765 43210",
    "source": "whatsapp",
    "notes": "Asked about 3BHK villas, budget ~2 Cr",
    "brandId": "optional — defaults to the first brand"
  }
}
```

Response `200`: `{ "ok": true, "action": "create_lead", "lead": { "id": "lead_…", … } }`.
`400` for a missing name/phone or unknown source; `409` if no brand exists.

**book_appointment** — `startsAt` (ISO 8601), `customerName`, `customerPhone`
required. The slot must be open in the brand's availability (default: Mon–Sat
10:00–18:00, Sun 11:00–17:00 in server local time, 60-min slots, ≥2 h notice,
≤45 days ahead, 2 concurrent). `channel` is one of
`whatsapp, phone, walk_in, website, instagram, staff` (default `website`).

```json
{
  "action": "book_appointment",
  "idempotencyKey": "gcal-{{ $json.id }}",
  "payload": {
    "startsAt": "2026-09-08T04:30:00.000Z",
    "customerName": "Priya Sharma",
    "customerPhone": "+919876543210",
    "customerEmail": "priya@example.com",
    "channel": "whatsapp",
    "leadId": "lead_… (optional — links the visit to the lead)",
    "projectId": "optional",
    "assignedTo": "optional staff name",
    "notes": "optional, ≤1000 chars"
  }
}
```

Response `200`: `{ "ok": true, "action": "book_appointment", "appointment": { "id": "apt_…", "startsAt": …, "status": "confirmed" } }`.
`409` with the engine's message when the slot is taken or outside hours (the
workflow should offer another time); `400` for an invalid date/channel.
Booking also fires the outbound `appointment.booked` event to any subscriber.

**send_message** — queues a WhatsApp *draft* on an existing inbox
conversation. Nothing is sent to the customer until a staff member releases it
in the inbox (that is where the 24-hour window rules live).

```json
{
  "action": "send_message",
  "idempotencyKey": "reply-{{ $json.messageId }}",
  "payload": {
    "conversationId": "wamid.HBgL…  (the inbound WhatsApp message id = conversation id)",
    "text": "Hi Priya, thanks for reaching out — would Sunday 12:00 work for a site visit?"
  }
}
```

Response `200`: `{ "ok": true, "action": "send_message", "conversationId": "…", "queued": true, "awaiting": "staff release" }`.
`404` if the conversation id is unknown; `409` if the conversation has no
verified sender number.

### Verified locally (2026-09-05)

Against the running dev server with the secret from `.env`:

| Call | Result |
|---|---|
| no header | 401 |
| wrong header | 401 `Invalid webhook credentials.` |
| unknown action | 400 listing the three actions |
| `create_lead` (valid) | 200, lead row written |
| same `idempotencyKey` again | 200 with `idempotent: true`, same lead id |
| `book_appointment` (tomorrow 12:00 local) | 200, appointment `confirmed`, `createdBy: n8n` |
| `send_message` unknown conversation | 404 |
| `send_message` missing text | 400 |
| `GET` | 405 |

One bug fixed while verifying: the replayed answer omitted `action`, and a key
reused for a different action replayed the wrong result. Replays now include
`action`, and a cross-action reuse is refused with 409.

---

## 2. Outbound: Villa-os calls n8n

### Events that actually fire today

Only these have an `emit()` call site:

- `lead.created`, `lead.stage_changed` — `/api/crm/leads`
- `appointment.booked`, `appointment.rescheduled`, `appointment.cancelled` — booking engine

`appointment.reminder_due`, `post.published`, `post.failed`, `review.received`,
`message.received` are in the catalogue but **nothing emits them yet**; subscribing
to them delivers nothing.

### Payload

```json
{
  "id": "uuid — same as the x-glentree-delivery header",
  "event": "appointment.booked",
  "at": "2026-09-05T22:34:50.688Z",
  "data": {
    "appointmentId": "apt_…", "brandId": "brd_…", "leadId": "lead_…",
    "startsAt": "…", "durationMinutes": 60, "status": "confirmed",
    "channel": "whatsapp", "customerName": "…", "customerPhone": "…", "customerEmail": "…"
  }
}
```

Lead events carry `leadId, brandId, name, phone, email, city, status, source,
score, assignedTo, projectInterest` (+ `previousStatus`, `changedBy` on
`lead.stage_changed`). Reschedule adds `previousStartsAt`; cancel adds `reason`.

Headers on every delivery: `x-glentree-event`, `x-glentree-delivery`,
`x-glentree-signature: sha256=<hex HMAC-SHA256 of the raw body>`,
`user-agent: orbit-events/1`. Retries: 3 attempts (0 / 0.5 s / 2 s) on 408, 425,
429 and 5xx only; 10 s timeout; redirects are not followed.

### n8n checklist

1. **Webhook node** (trigger):
   - HTTP Method `POST`, choose a path, e.g. `villa-os-events`.
   - *Respond*: "Immediately" (the bus only needs a 2xx).
   - Options → **Raw Body: ON** — required; the HMAC is over the exact bytes.
   - Copy the **Production** URL (`https://<n8n-host>/webhook/villa-os-events`).
2. **Generate a signing secret** — at least 24 characters (32 random hex is
   fine: `openssl rand -hex 16`). Store it in n8n as a credential or an
   environment variable (`N8N_VILLA_SIGNING_SECRET`), never in the node code.
3. **Code node** right after the Webhook node, to verify before anything else:

   ```js
   const crypto = require('crypto');
   const SECRET = $env.N8N_VILLA_SIGNING_SECRET;
   const raw = $input.first().binary?.data
     ? Buffer.from($input.first().binary.data.data, 'base64')
     : Buffer.from($input.first().json.rawBody ?? '');
   const header = $input.first().json.headers['x-glentree-signature'] ?? '';
   const mac = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
   const a = Buffer.from(mac), b = Buffer.from(header);
   if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad signature');
   const event = JSON.parse(raw.toString('utf8'));
   if (event.data?.test === true) return [];      // the "Send test" probe — do nothing
   return [{ json: event }];
   ```

   (Where the raw body lands depends on the n8n version: with Raw Body on it is
   the binary `data` property; older builds expose `rawBody`. The snippet
   handles both.) Optionally dedupe on `event.id` — a retry after a timeout
   reuses it.
4. **Register the subscriber in Villa-os** — Automation page → *Outbound* →
   URL = the Production webhook URL, tick the events, paste the same secret.
   Needs the `workflows.manage` permission. The secret is write-only: it is never
   shown again, so keep the n8n copy.
5. **Click "Send test"** on the row. The delivery record shows status/attempts/
   error; the probe body is `{ "test": true }`, which the Code node above ignores.
6. Watch **Recent deliveries** on the same page after the first real booking.

---

## 3. Video hand-off: Villa-os → your n8n Form workflow

The app's "Post a video" form (`/automation`) validates and forwards a
multipart submission to your existing n8n **Form Trigger** workflow, using the
form's own field labels verbatim (`Video File`, `Final Thumbnail`, `Thumbnail
Reference Photos`, `Video Title`, `Video Description`, `Thumbnail Text`, `Extra
Thumbnail Instructions`, `Which Platforms to Post To`, `Google Drive Folder
Name`, `Create the folder if it does not exist?`, `Enable Anyone with link can
view on the Drive folder?`, `Telegram Chat ID for thumbnail review`).

### Checklist

1. In n8n open the posting workflow → Form Trigger node → copy the
   **Production** form URL (`https://<n8n-host>/form/<id>`). Make sure the
   field labels match the list above exactly (case and punctuation).
2. **Add one hidden field to the form:** label `Submission ID`, type *Hidden*
   (or a plain text field — it is filled by the app, not by a person). The app
   sends its own submission id in it so the workflow can report back (§3
   "Reporting the result"). A form without the field simply ignores the part.
3. In Villa-os `.env` set `N8N_VIDEO_FORM_URL=https://<n8n-host>/form/<id>` and
   restart the app, or paste it under **Configure Endpoint** on `/automation`.
   https and a public host are required.
4. Press **Test connection** on `/automation` (needs `workflows.manage`). It
   GETs the form URL through the server and reports *active* / *inactive* —
   nothing is submitted, so nothing runs.
5. Submit from `/automation` with a user holding `marketing.publish`. Limit: 12
   submissions per hour per user, 576 MB total, 3 reference photos. Every label
   is sent exactly once (an earlier build also sent `field-0`/`videoFile`
   aliases, which tripled the upload).

### Reading the result

The row on `/automation` shows a timeline: **queued → forwarded → per-platform
result**, plus the HTTP status the form answered and the elapsed time.

| Form answered | Recorded as | Meaning |
|---|---|---|
| 2xx / 3xx | `forwarded` | The workflow accepted the upload. Publishing happens later inside n8n. |
| 404, or a page saying "Problem loading form" | `failed` | The form is not active or the URL is wrong. Fix the URL / switch the workflow on; nothing was received. |
| **499** or 5xx *after* the upload completed | `received_workflow_error` | The Form trigger only answers after it has run the workflow, so this means **n8n received the video and a later node threw** — almost always a Google Drive / YouTube credential, or a node that failed on this input. Open the workflow's **Executions** tab, find the errored run, and repair that node. Do not re-upload until it is fixed: the video is already in the workflow's hands. |
| nothing (timeout, DNS, TLS) | `failed` | Transport problem; the error text is the fetch error. |

Nothing is retried automatically.

### Reporting the result (post_result)

Publishing takes minutes and happens inside n8n, so the hand-off alone cannot
say whether a video went live. Add an **HTTP Request** node after each
platform's upload node (and on its error branch) that calls back:

- Method `POST`, URL `https://<your-villa-os-host>/api/webhooks/n8n`
- Authentication: the same **Header Auth** credential as §1 (`x-n8n-secret`)
- Send Body: JSON:

```json
{
  "action": "post_result",
  "payload": {
    "submissionId": "{{ $('On form submission').item.json['Submission ID'] }}",
    "platform": "YouTube",
    "status": "published",
    "externalUrl": "https://youtu.be/{{ $json.id }}"
  }
}
```

On the error branch send `"status": "failed"` and `"error": "{{ $json.error.message }}"`.

- `platform` is one of the form's checkbox labels: `YouTube`, `Instagram`,
  `Facebook`, `X (Twitter)`. A platform the submission did not ask for is
  refused with 409.
- `submissionId` is the value of the hidden **Submission ID** field (`n8nsub_…`).
  An unknown id answers 404.
- A repeat for the same platform overwrites the earlier result, so a retried
  node does not duplicate. No `idempotencyKey` is needed.
- The row moves to `forwarded` on the first callback even if the form had
  answered 499 — a callback proves the workflow ran.

Response `200`: `{ "ok": true, "action": "post_result", "submission": { … "results": [ { "platform": "YouTube", "status": "published", "externalUrl": "…", "at": "…" } ] } }`.

No secret is exchanged on the form path itself — the form URL is the
credential, which is why it lives server-side and is never sent to the browser.
