# Appointment notifications

Every site-visit event — booked, confirmed, rescheduled, cancelled, no-show, and
the 24h-before reminder — goes through one door, `src/lib/notify/index.ts`,
whatever booked it (the CRM desk, the n8n `book_appointment` action, or the
WhatsApp assistant). Each event fans out to three channels and every outcome is
written to `notificationLog` in the store, which the `/crm/appointments` page
shows under **Details** on each visit.

| Channel | Who | Needs |
|---|---|---|
| In-app | The assigned host (matched by name/email against the team) or every sales manager | nothing |
| Email (+ `.ics` attachment) | `NOTIFY_EMAILS` plus the assigned host's email | `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` |
| WhatsApp | The customer, via the existing `deliver()` send path | an existing WhatsApp connection |

Nothing here can break a booking: the engine writes the visit first and
notifies fire-and-forget, and a channel that is not configured reports a
"not configured" outcome instead of throwing.

## Environment

Add these to `.env` (see `.env.example` for the rest):

```
# Resend — https://resend.com/api-keys
RESEND_API_KEY=re_xxxxxxxxx
# Must be an address on a domain you have verified in Resend, or every send is refused.
NOTIFY_FROM_EMAIL=Villa OS <visits@yourdomain.com>
# Comma-separated. Receives every appointment email in addition to the assigned host.
NOTIFY_EMAILS=sales@yourdomain.com,ops@yourdomain.com
```

- `RESEND_API_KEY` and `NOTIFY_FROM_EMAIL` are both required before any email
  is attempted. With either missing, the log shows
  `not configured: set RESEND_API_KEY and NOTIFY_FROM_EMAIL` and everything
  else still runs.
- `NOTIFY_FROM_EMAIL` must use a domain verified in Resend (Domains → Add
  domain → add the DNS records). A free `onboarding@resend.dev` sender only
  delivers to the Resend account's own address.
- `NOTIFY_EMAILS` is optional; with it unset, only the assigned host (when the
  host has an email on the team) is emailed. With no recipients at all the log
  shows `no recipients`.

Restart `npm run dev` after changing `.env`.

## Reminders

Reminders ride on the follow-up worker: `POST /api/ops/followups` (worker
secret or an admin session) now also sends a reminder for every confirmed or
rescheduled visit starting inside the next 24 hours that has not been reminded.
The visit is marked reminded before the send, so overlapping ticks cannot
double-message a buyer; cancelled, completed and no-show visits are never
reminded. Point a cron at the tick at least hourly.

## WhatsApp to the customer

Customer messages go only through `deliver()`, so the 24-hour window, opt-out,
cooldown and daily cap all apply. Outside the window the log shows
`outside the 24h window — needs a template or a call`. A visit booked by the
WhatsApp assistant skips the extra confirmation — the assistant's own reply was
it. A phone with no customer record (e.g. a walk-in typed at the desk who has
never messaged) is logged as skipped.

## Calendar files

`GET /api/appointments/<id>/ics` (needs `sales.read`) returns the same
`.ics` the email attaches, with times in `Asia/Kolkata`. The **Details** panel
on `/crm/appointments` links to it.
