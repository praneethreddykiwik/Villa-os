# WhatsApp go-live runbook

How to move the WhatsApp assistant from Meta's test number to the business number and keep it running 24×7. Every path and env name below matches the code (`src/app/api/webhooks/whatsapp/route.ts`, `src/lib/platforms/whatsapp.ts`, `src/lib/ops/agent.ts`). The admin card **Settings → WhatsApp health** (`users.manage` only) shows the live state of each step.

Env keys involved (never commit values):

| Key | Used for |
|---|---|
| `WHATSAPP_PHONE_NUMBER_ID` | Sender. Currently `1372518445937587` = Meta **test** number `+1 555-197-1740` (max 5 verified recipients, no display-name, cannot be used for customers). |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | WABA id. Not read by the app today; keep it in `.env` for template/API scripts below. |
| `WHATSAPP_VERIFY_TOKEN` | Webhook handshake (`GET /api/webhooks/whatsapp`). Fails closed when unset. |
| `META_APP_SECRET` | HMAC check of every webhook POST (`x-hub-signature-256`). Unset ⇒ every POST is **401**. |
| `META_SYSTEM_USER_TOKEN` | Sending, media download, health card. Permanent System User token with `whatsapp_business_messaging` + `whatsapp_business_management`. |
| `META_GRAPH_VERSION` | Defaults to `v23.0`. |
| `PLATFORM_DRIVER` | Must be `live`; with `mock` every send returns an error (nothing is faked). |
| `PUBLIC_BASE_URL` | Public HTTPS origin. Currently empty. |
| `WORKER_SECRET` | Cron auth for `/api/ops/followups` and `/api/publish/tick`. |

---

## (a) The business number

1. **Meta Business Manager → WhatsApp Accounts → (your WABA) → WhatsApp Manager → Phone numbers → Add phone number.**
   The number must not be registered on the WhatsApp/WhatsApp Business app (delete that account first, or use a fresh SIM/landline).
2. Enter display name (see 4), category, description; choose SMS or voice verification; enter the 6-digit code.
3. Copy the ids:
   - **Phone number ID**: WhatsApp Manager → Phone numbers → click the number → "Phone number ID". Or via API:
     ```bash
     curl -s "https://graph.facebook.com/v23.0/$WHATSAPP_BUSINESS_ACCOUNT_ID/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,name_status" \
       -H "Authorization: Bearer $META_SYSTEM_USER_TOKEN"
     ```
   - **WABA ID**: Business settings → Accounts → WhatsApp accounts → the account → "WhatsApp Business Account ID".
   - Set in `.env`:
     ```
     WHATSAPP_PHONE_NUMBER_ID=<phone number id>
     WHATSAPP_BUSINESS_ACCOUNT_ID=<waba id>
     ```
4. **Display-name approval.** Meta reviews the name (must match the business, no generic words). Status is `name_status` (`APPROVED` / `PENDING_REVIEW` / `DECLINED`) on the health card. Messages can be sent while pending, but the name is not shown to customers until approved.
5. Register the number for Cloud API (once, sets the 2-step PIN):
   ```bash
   curl -s -X POST "https://graph.facebook.com/v23.0/$WHATSAPP_PHONE_NUMBER_ID/register" \
     -H "Authorization: Bearer $META_SYSTEM_USER_TOKEN" -H "Content-Type: application/json" \
     -d '{"messaging_product":"whatsapp","pin":"123456"}'
   ```
6. Make sure the System User is assigned to the WABA (Business settings → Users → System users → Assign assets → WhatsApp accounts → full control) and the app is added to the WABA.
7. Restart the app. Health card should show the display number and `verified_name`.

## (b) Public URL

`PUBLIC_BASE_URL` must be a public HTTPS origin (no trailing slash). Meta refuses http and self-signed certs.

**Option 1 — Vercel**
```bash
npm i -g vercel && vercel link && vercel env pull   # then add every key from .env in the dashboard (Production)
vercel --prod
```
Set `PUBLIC_BASE_URL=https://<project>.vercel.app` (or the custom domain). Note: `.data/db.json` is not durable on Vercel's filesystem — use the Supabase store before going live there, or prefer option 2.

**Option 2 — Hostinger VPS (pm2 + nginx + HTTPS)**
```bash
# on the VPS (Ubuntu)
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs
sudo npm i -g pm2
git clone <repo> /srv/villa-os && cd /srv/villa-os && cp .env.example .env   # fill .env
npm ci && npm run build
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```
`/etc/nginx/sites-available/villa-os`:
```nginx
server {
  server_name app.example.com;
  client_max_body_size 20m;
  location / {
    proxy_pass http://127.0.0.1:4321;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 60s;
  }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/villa-os /etc/nginx/sites-enabled/ && sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d app.example.com
```
`.env`: `PUBLIC_BASE_URL=https://app.example.com`

**Option 3 — tunnel (testing only; URL changes on restart unless you use a named tunnel)**
```bash
# cloudflared (free, no account needed for quick tunnels)
brew install cloudflared && cloudflared tunnel --url http://localhost:4321
# ngrok
brew install ngrok && ngrok http 4321
```
Copy the `https://…trycloudflare.com` / `https://….ngrok-free.app` origin into `PUBLIC_BASE_URL`, restart the dev server, redo step (c) every time the URL changes.

## (c) Webhook subscription

1. Choose a verify token (any random string, e.g. `openssl rand -hex 24`) and put it in `.env` as `WHATSAPP_VERIFY_TOKEN`. `META_APP_SECRET` = developers.facebook.com → App → App settings → Basic → App secret.
2. Restart the app, then confirm the handshake locally before involving Meta:
   ```bash
   curl -i "$PUBLIC_BASE_URL/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=$WHATSAPP_VERIFY_TOKEN&hub.challenge=12345"
   # expect: 200 with body exactly `12345`
   ```
3. developers.facebook.com → your app → **WhatsApp → Configuration → Webhook → Edit**:
   - Callback URL: `https://<host>/api/webhooks/whatsapp`
   - Verify token: the value of `WHATSAPP_VERIFY_TOKEN`
   - Verify and save.
4. **Webhook fields → Manage**: subscribe `messages` and `message_status` (the app ignores status callbacks but you need them for delivery debugging in the Meta logs).
5. Subscribe the app to the WABA (required in production, easy to forget):
   ```bash
   curl -s -X POST "https://graph.facebook.com/v23.0/$WHATSAPP_BUSINESS_ACCOUNT_ID/subscribed_apps" \
     -H "Authorization: Bearer $META_SYSTEM_USER_TOKEN"
   ```
6. App must be in **Live** mode (App settings → Basic) with `whatsapp_business_messaging` granted, otherwise only test-app admins can message.

## (d) 24×7 operation

`ecosystem.config.cjs` (pm2):
```js
module.exports = {
  apps: [{
    name: "villa-os",
    cwd: "/srv/villa-os",
    script: "node_modules/next/dist/bin/next",
    args: "start -p 4321",
    env: { NODE_ENV: "production" },
    max_memory_restart: "800M",
    autorestart: true,
    time: true,
  }],
};
```
pm2 reads `.env` only via the app (Next loads `.env` itself) — keep `.env` in `cwd`.

systemd alternative `/etc/systemd/system/villa-os.service`:
```ini
[Unit]
Description=Villa OS
After=network.target

[Service]
WorkingDirectory=/srv/villa-os
EnvironmentFile=/srv/villa-os/.env
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -p 4321
Restart=always
RestartSec=5
User=www-data

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl daemon-reload && sudo systemctl enable --now villa-os
```

Cron (`crontab -e`, replace secret from `.env`; the header name is `x-worker-secret`, `?secret=` also works):
```cron
0 * * * *   curl -sf -X POST -H "x-worker-secret: $WORKER_SECRET" https://app.example.com/api/ops/followups >> /var/log/villa-followups.log 2>&1
*/5 * * * * curl -sf -X POST -H "x-worker-secret: $WORKER_SECRET" https://app.example.com/api/publish/tick   >> /var/log/villa-tick.log 2>&1
```
Follow-ups still respect quiet hours, cooldown, daily cap, opt-out and human control. Preview without sending: `POST /api/ops/followups?dryRun=true`.

Health check for uptime monitors (there is no dedicated `/api/health` route): use the webhook handshake, which needs no secret in the response and proves env + routing:
`GET https://app.example.com/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=ok` → expect `200 ok`. If you prefer a no-secret probe, monitor `GET /login` for 200.

## (e) Templates and the 24-hour window

Meta only delivers free-form text within 24 h of the customer's last inbound message. `sendWhatsApp()` enforces this: outside the window a free-text send returns `requiresTemplate: true` and is not attempted; the agent then creates a sales task "Send an approved template or call the customer" (automated follow-ups are dropped silently with a notification).

**Create a UTILITY template** (WhatsApp Manager → Message templates → Create, or API):
```bash
curl -s -X POST "https://graph.facebook.com/v23.0/$WHATSAPP_BUSINESS_ACCOUNT_ID/message_templates" \
  -H "Authorization: Bearer $META_SYSTEM_USER_TOKEN" -H "Content-Type: application/json" -d '{
  "name": "reengage_followup", "category": "UTILITY", "language": "en",
  "components": [
    {"type":"BODY","text":"Hi {{1}}, this is Glentree following up on your enquiry. Reply here and we will continue where we left off.",
     "example":{"body_text":[["Priya"]]}},
    {"type":"FOOTER","text":"Reply STOP to opt out"}
  ]}'
```
Approval is usually minutes to 24 h; status in WhatsApp Manager. UTILITY must reference an existing interaction; promotional wording gets reclassified as MARKETING (paid, and blocked for opted-out users).

**Where the app expects the template name:** nowhere yet. `sendWhatsApp` accepts `template: {name, language, params}` and `POST /api/whatsapp/send` forwards a `template` object from its body, but the ops agent (`deliver()` in `src/lib/ops/agent.ts`) never passes one, so re-engagement after 24 h is manual (the send API with an explicit template, or a call).

**Needed change (not implemented):** add `WHATSAPP_TEMPLATE_REENGAGE=reengage_followup` (+ optional `WHATSAPP_TEMPLATE_LANG=en`) to `.env.example`, and in `deliver()` when `res.requiresTemplate` and the env is set, retry once with `template: { name, language, params: [customer.name] }` and record the outbound as `tag: "template_reengage"`. Until then, follow-up templates in `src/lib/ops/config.ts` (`document_reminder_1` etc.) are internal copy keys, not Meta template names.

## (f) Compliance

- **Opt-in**: collect consent before the first business-initiated message (web form checkbox, missed-call, or the customer messaging first). Suggested wording: "I agree to receive updates about my enquiry from Glentree on WhatsApp. Reply STOP any time to opt out." Keep the timestamp/source on the customer record.
- **STOP / START** — implemented in `src/lib/ops/agent.ts`: `stop|unsubscribe|do not contact|opt out` sets `optedOut`, cancels follow-ups, confirms once; `start|resume|continue|unstop|opt in|subscribe` clears it. Opted-out customers get no automated messages; humans can still be assigned.
- **Retention**: `.data/db.json` keeps full threads and downloaded documents (cap 15 MB each). Define a retention period (e.g. 24 months after case close) and purge documents/messages; also purge on a deletion request. Media is stored on the app server, not with Meta.
- **DND / quiet hours**: quiet hours, cooldown and daily cap are in the workflow config (`src/lib/ops/config.ts`) and enforced for every automated send. TRAI DND lists do not apply to WhatsApp, but opt-in still does.
- **Business verification**: Business settings → Security centre → Start verification (registration document + proof of address). Unverified WABAs are capped at 250 business-initiated conversations/24 h and cannot get the display name shown; verified accounts scale to 1k → 10k → 100k based on quality rating.
- Keep quality rating GREEN: blocks/reports lower it and the limit; the health card shows it.

## (g) Test plan

1. `curl` handshake (c.2) → 200 with challenge echoed.
2. Signature: `curl -X POST $PUBLIC_BASE_URL/api/webhooks/whatsapp -d '{}'` → **401** (unsigned). Meta "Test" button in Configuration → 200.
3. From a phone, message the business number "Hi" → Engagement inbox shows the conversation, the ops customer is created, an AI/deterministic reply arrives on the phone. Health card "Last inbound message" updates.
4. Send "price?" → flagged as lead; check assignment/sales task.
5. Send an image and a PDF → stored as documents (cap 15 MB; larger gets an explanatory reply).
6. Reply from the inbox within 24 h → delivered. Wait 24 h (or set a customer's last inbound in the past) and reply → task "Send an approved template or call".
7. `POST /api/whatsapp/send` with `template: {name:"reengage_followup", language:"en", params:["Test"]}` → delivered to a phone that has not messaged in 24 h.
8. Send STOP → confirmation, no more automated messages; send START → resumed.
9. Cron: `curl -X POST -H "x-worker-secret: …" /api/ops/followups?dryRun=true` → JSON preview; without the header → 401; with `WORKER_SECRET` unset → 503.
10. Restart the server (pm2 restart) → messages sent during the restart are redelivered by Meta and deduplicated by message id.

## (h) Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Meta "The callback URL or verify token couldn't be validated" | Token mismatch, app not restarted, URL not https, or handler returned JSON | Check (c.2) curl returns plain `12345`; restart after editing `.env`. |
| Webhook POST returns 401 `invalid signature` | `META_APP_SECRET` wrong/unset, or a proxy rewrote the body | Use the App secret of the same app that owns the webhook; nginx must not buffer/alter the body. |
| 403 on GET | `WHATSAPP_VERIFY_TOKEN` unset | Set it; there is no fallback. |
| Send returns `WhatsApp is running with PLATFORM_DRIVER="mock"` | Driver not live | `PLATFORM_DRIVER=live`. |
| Error 131030 "Recipient phone number not in allowed list" | Still on the test number | Add recipient in App → WhatsApp → API setup, or switch to the business number (a). |
| Error 131047 / `requiresTemplate` | 24 h window closed | Send an approved template (e). |
| Error 190 / 401 from Graph | Token expired or lacks permissions | Generate a permanent System User token with both whatsapp permissions and WABA asset access. |
| Error 100 "Unsupported post request" on `/messages` | Wrong `WHATSAPP_PHONE_NUMBER_ID` or app not added to the WABA | Re-copy the id; Business settings → Accounts → WhatsApp accounts → Assigned apps. |
| Error 133010 "Account not registered" | Number not registered for Cloud API | Run the register call (a.5). |
| Messages accepted but no reply | AI writer unset (deterministic still replies), customer opted out, human control, or quiet hours | Check health card, customer flags, audit events. |
| Health card "Phone number: no token" | `META_SYSTEM_USER_TOKEN` unset | Set it; card caches Graph for 5 min. |
| Reply in inbox but not delivered; status `sent` only | Customer blocked the number or number unreachable | Check `message_status` in Meta webhook logs; quality rating. |
| Media reply "could not retrieve the file" | Token missing `whatsapp_business_messaging`, or download > 15 MB | Fix token; ask for a smaller file. |
| Duplicate conversations after restart | none — dedup is by `wamid` | If seen, check the store was not reset between deliveries. |
