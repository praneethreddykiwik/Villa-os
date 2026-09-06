# Voice agent setup

The voice module is white-labelled. Client-facing screens say "Voice agent" and
show calls, transcripts, extracted fields and leads — never the provider, model,
voice or per-call cost. Only the admin-only "Provider diagnostics" panel
(`users.manage`) names the underlying provider (Bolna).

## Environment

| Variable | Required for | Notes |
| --- | --- | --- |
| `BOLNA_API_KEY` | everything provider-side | Already documented in `.env.example`. Without it the module runs on the local call log only. |
| `BOLNA_AGENT_ID` | pushing `/voice/settings` to the provider | The id of the one agent this deployment edits. Copy it from the agent's URL in the provider dashboard once the Agent Studio draft is saved. Without it, saving settings persists locally and reports "not synced". |
| `VOICE_WEBHOOK_SECRET` | inbound call updates | Shared secret the provider must send in the `x-voice-secret` header. Unset ⇒ the webhook answers **503** and nothing is ingested (fail closed). Generate with `openssl rand -hex 32`. |

Add the two new variables to `.env.local` (this repo does not edit `.env` files
for you).

## Inbound webhook

`POST /api/webhooks/bolna` — listed in `SELF_AUTHENTICATING` in
`src/middleware.ts`, so no session is needed; the secret header is the only gate.

In the provider dashboard, open the agent → **Extractions** tab → *Push all
execution data to webhook* and enter:

```
https://<your-host>/api/webhooks/bolna
```

The provider does not add custom headers from the dashboard. Put a reverse
proxy (or an n8n "HTTP Request" node) in front that forwards the payload and
adds `x-voice-secret: <VOICE_WEBHOOK_SECRET>`.

**The hop must be locked down — this is not optional.** Whatever reaches the
hop gets the secret attached, so an open hop lets anyone on the internet
bypass the header check and, via `?brand=`, create customers, leads and
notifications for any brand. Do both of:

- Restrict the hop to the provider's documented source IPs (`13.203.39.153`,
  `13.126.9.249`, `13.202.133.53`) — nginx `allow`/`deny`, a firewall rule, or
  n8n webhook-node IP allowlisting — **or** put an n8n-side auth on it (a
  webhook-node header/basic-auth credential the provider can be configured to
  send). One of these is mandatory.
- Treat the hop's URL as a secret, equal in sensitivity to
  `VOICE_WEBHOOK_SECRET`: unguessable path, never in docs, chat or client
  screens, rotated together with the secret.

Behaviour:

- Every status update is upserted into `db.voiceCalls` by execution id
  (replays are harmless).
- On a terminal status (`completed`, `no-answer`, `busy`, `failed`,
  `canceled`, `stopped`, `error`, `balance-low`), and only once per execution:
  - the caller is upserted as a customer (source `voice`),
  - the transcript is stored as an `opsMessages` entry on channel `voice`,
  - a CRM lead (source `voice`) is created when the extraction or transcript
    shows buying intent or a callback request,
  - a sales notification is raised.
- `call-disconnected` is soft-terminal (duration/recording still null) and is
  stored but not finalised; `completed` follows.

## Client settings → provider

`/voice/settings` (`workflows.manage`) edits plain-text fields only: business
name, greeting, office hours, location, offerings, pricing guidance, languages
(Hindi / English / Telugu), transfer-to number, do-not-say list. `PUT
/api/voice/settings` persists `db.voiceAgentConfigs` per brand, then — when
`BOLNA_API_KEY` **and** `BOLNA_AGENT_ID` are set — sends a `PATCH
/v2/agent/{id}` with `agent_welcome_message` and a system prompt built from a
fixed template (`src/lib/voice/settings.ts`, `buildSystemPrompt`). Nothing about
the voice, model or telephony is sent. When either variable is missing the
response says `synced: false` with a reason and the settings are still saved.

## Notification hooks

`src/lib/notify/index.ts` is owned by another workstream. The webhook imports it
dynamically and calls `notifyVoiceLead(...)` if that export exists; otherwise
only the in-app `opsNotifications` entry is written.
