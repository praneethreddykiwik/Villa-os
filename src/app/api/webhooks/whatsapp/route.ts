import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { fetchWhatsAppMedia, parseWebhook } from "@/lib/platforms/whatsapp";
import { handleInbound } from "@/lib/ops/agent";
import { ensureOpsSeed, resolveDefaultOrgId, syncTeamMembers } from "@/lib/ops/seed";

/**
 * Meta verifies a webhook by GETting it with a challenge and expects the raw
 * challenge string echoed back — not JSON. Returning JSON here is the classic
 * reason a WhatsApp webhook never activates.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";

  // Fail closed when unset. The old "dev-verify" fallback let anyone complete
  // Meta's subscription handshake against an unconfigured deployment, i.e.
  // point their own Meta app at this URL. Constant-time, like the POST check.
  const expected = process.env.WHATSAPP_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token) {
    const { timingSafeEqual } = await import("node:crypto");
    const a = Buffer.from(token);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
    }
  }
  return new Response("forbidden", { status: 403 });
}

/**
 * Meta's webhook bodies are a few KB. Anything larger is not Meta, and the body
 * is read in full before the signature can be checked, so the cap is the only
 * thing between an anonymous POST and an arbitrarily large allocation.
 */
const MAX_WEBHOOK_BYTES = 1024 * 1024;

/**
 * Inbound messages. Meta retries anything that is not answered quickly with a
 * 200, so we acknowledge first and keep the work minimal — and we key on the
 * platform message id so a retry cannot duplicate the conversation.
 */
/**
 * Signature verification.
 *
 * Meta signs every webhook with the app secret. Without this check, anyone who
 * learns the URL can inject messages into a customer's conversation and drive
 * the workflow. Enforced whenever META_APP_SECRET is configured.
 */
async function verifySignature(raw: string, header: string | null): Promise<boolean> {
  const secret = process.env.META_APP_SECRET;
  // Fail CLOSED. This previously returned true when META_APP_SECRET was unset,
  // which made an unconfigured deployment accept unsigned webhooks from anyone
  // who learned the URL — and the path is exempt from the session gate, so the
  // signature is the only authentication there is. An unconfigured webhook must
  // reject traffic, not trust it.
  if (!secret) return false;
  if (!header?.startsWith("sha256=")) return false;
  const { createHmac, timingSafeEqual } = await import("node:crypto");
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(header.slice(7));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  // Read the body once as text so the signature covers the exact bytes received.
  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ ok: false, error: "payload too large" }, { status: 413 });
  }
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256")))) {
    return NextResponse.json({ ok: false, error: "invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const messages = parseWebhook(payload);
  if (!messages.length) return NextResponse.json({ ok: true, ignored: "no messages in payload" });

  const db = read();
  const conn = db.connections.find((c) => c.channel === "whatsapp");
  const brandId = conn?.brandId ?? db.brands[0]?.id;
  if (!brandId) return NextResponse.json({ ok: true, ignored: "no brand" });

  const created = mutate((d) => {
    const seen = new Set(d.conversations.map((c) => c.id));
    let n = 0;
    for (const m of messages) {
      if (seen.has(m.id)) continue;
      n += 1;
      d.conversations.unshift({
        id: m.id,
        brandId,
        channel: "whatsapp",
        kind: "dm",
        author: m.name ? `${m.name} (${m.from})` : m.from,
        // `author` mixes the sender's self-chosen profile name into the same
        // string as the number, so it is a label and nothing more. The wa_id
        // Meta put in this signed payload is kept separately, because that is
        // the only value a reply may be addressed to.
        authorId: m.from,
        text: m.text,
        createdAt: m.timestamp,
        status: "open",
        sentiment: "neutral",
        isLead: /price|cost|how much|available|availability|book|quote/i.test(m.text),
      });
    }
    if (n) {
      d.activity.unshift({
        id: uid("act"),
        brandId,
        at: new Date().toISOString(),
        actor: "system",
        kind: "whatsapp",
        message: `${n} WhatsApp message(s) received`,
      });
    }
    return n;
  });

  // ---- Ops workflow ------------------------------------------------------
  // The existing social inbox behaviour above is untouched. Each message is now
  // additionally driven through the customer lifecycle agent. Failures here are
  // captured per message rather than failing the webhook: returning non-2xx to
  // Meta triggers redelivery, which would replay every message in the batch.
  const orgId = await resolveDefaultOrgId();
  ensureOpsSeed(orgId);
  await syncTeamMembers(orgId);

  const outcomes: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    try {
      // Media arrives as an id that must be downloaded from the Graph API.
      // The bytes are fetched here (the only place with the request context)
      // and everything else — storing, attributing to a checklist item,
      // acknowledging — happens in the agent, for every customer, case or not.
      // In mock mode there is nothing to fetch and the agent says so.
      const media =
        m.type === "image" || m.type === "document"
          ? await fetchWhatsAppMedia(m.mediaId, undefined, { mimeType: m.mimeType, filename: m.filename })
          : undefined;

      const outcome = await handleInbound({
        orgId,
        phone: m.from,
        name: m.name,
        body: m.text,
        externalId: m.id,
        receivedAt: m.timestamp,
        type: m.type,
        media: media ?? undefined,
        location: m.location,
        interactive: m.interactive,
      });
      outcomes.push({ id: m.id, customerId: outcome.customerId, replied: Boolean(outcome.reply), silent: outcome.silentReason });
    } catch (e) {
      console.error("[whatsapp/ops]", (e as Error).message);
      outcomes.push({ id: m.id, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: true, received: messages.length, created, ops: outcomes });
}
