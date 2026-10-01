import { NextResponse } from "next/server";
import { actorLabel, getSession } from "@/lib/auth/session";
import { guard } from "@/lib/auth/guard";
import { clientKey, rateLimit } from "@/lib/ops/ratelimit";
import { readPost, safePath } from "@/lib/osf/form-post";
import {
  MAX_RECIPIENTS,
  parseRecipients,
  renderOpener,
  screenRecipients,
  startConversations,
} from "@/lib/osf/outreach";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** Paced sends: 25 recipients at 4s apart is comfortably inside this. */
export const maxDuration = 300;

/**
 * Opens WhatsApp conversations with a pasted list of numbers.
 *
 * The strictest write surface in this app, and deliberately so. It messages
 * people who have not contacted us, from a number whose loss would take every
 * conversation with it, so it carries more locks than anything else here:
 *
 *  - `customers.write`, not a read scope. Reaching a customer is contact, and
 *    marketing/analytics roles have no business initiating it.
 *  - Rate limited per user AND per source. A leaned-on button or a retry loop
 *    would otherwise become a burst, which is the exact pattern that gets a
 *    number flagged.
 *  - `preview` mode returns what WOULD be sent without sending anything, so
 *    the desk can check the list and the wording before anybody's phone buzzes.
 */

/** Two runs in ten minutes is a busy desk. More than that is a mistake. */
const LIMIT = { max: 2, windowSeconds: 600 } as const;

export async function POST(request: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;

  const body = await readPost(request);
  const preview = body.get("preview") === "1";
  const raw = body.get("recipients") ?? "";
  const template = (body.get("template") ?? "").trim();
  const next = safePath(body.get("next"), "/inbox/whatsapp/communication/whatsapp");

  if (!template) {
    return NextResponse.json({ ok: false, error: "Write the opening message first." }, { status: 400 });
  }
  if (template.length > 4096) {
    return NextResponse.json(
      { ok: false, error: "WhatsApp caps a text message at 4096 characters." },
      { status: 400 },
    );
  }

  const { recipients, rejected } = parseRecipients(raw);

  if (recipients.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No usable numbers in that list.", rejected },
      { status: 400 },
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    return NextResponse.json(
      {
        ok: false,
        error: `That is ${recipients.length} numbers. Send at most ${MAX_RECIPIENTS} at a time — ` +
          "unsolicited bursts are what get a WhatsApp number banned.",
        rejected,
      },
      { status: 400 },
    );
  }

  // Preview costs nothing and sends nothing, so it is not rate limited: the
  // whole point is that somebody checks twice before the first message goes.
  if (preview) {
    // Ask the same questions the send will ask, so the count on the button is
    // the number of people who will actually be messaged — not the number of
    // lines that happened to parse.
    const { sendable, blocked } = await screenRecipients(recipients);
    return NextResponse.json({
      ok: true,
      preview: true,
      count: sendable.length,
      rejected: [
        ...rejected,
        ...blocked.map((b) => ({ line: `${b.phone}${b.name ? `, ${b.name}` : ""}`, reason: b.reason })),
      ],
      samples: sendable.slice(0, 5).map((r) => ({
        phone: r.phone,
        name: r.name,
        message: renderOpener(template, r.name),
      })),
    });
  }

  const session = await getSession();
  const limit = rateLimit(`osf:outreach:${session?.userId ?? clientKey(request)}`, LIMIT);
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: `Too many outreach runs. Try again in ${limit.retryAfterSeconds ?? LIMIT.windowSeconds}s.`,
      },
      { status: 429 },
    );
  }

  const result = await startConversations({
    recipients,
    template,
    actor: actorLabel(session),
  });

  const accepts = request.headers.get("accept") ?? "";
  if (accepts.includes("application/json")) {
    return NextResponse.json({ ok: true, ...result, rejected });
  }

  // A plain form post lands back on the console with a summary in the URL, so
  // the page can say what happened without needing client-side state.
  const url = new URL(next, "http://local.invalid");
  url.searchParams.set("sent", String(result.sent));
  if (result.skipped) url.searchParams.set("skipped", String(result.skipped));
  if (result.failed) url.searchParams.set("failed", String(result.failed));
  return NextResponse.redirect(
    new URL(`${url.pathname}${url.search}`, request.url),
    { status: 303 },
  );
}
