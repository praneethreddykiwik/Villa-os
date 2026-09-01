import { NextResponse } from "next/server";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { parseWebhook } from "@/lib/platforms/whatsapp";
import { handleInbound } from "@/lib/ops/agent";
import { ensureOpsSeed, defaultOrgId } from "@/lib/ops/seed";
import { receiveDocument } from "@/lib/ops/documents";
import { activeCase, caseProgress } from "@/lib/ops/loan";
import { findByPhone } from "@/lib/ops/customers";

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

  if (mode === "subscribe" && token === (process.env.WHATSAPP_VERIFY_TOKEN ?? "dev-verify")) {
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

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
  // Read the body once as text so the signature covers the exact bytes received.
  const raw = await req.text();
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
  const orgId = defaultOrgId();
  ensureOpsSeed(orgId);

  const outcomes: Array<Record<string, unknown>> = [];
  for (const m of messages) {
    try {
      let documentId: string | undefined;

      // Media arrives as an id that must be downloaded from the Graph API. In
      // mock mode there is no media to fetch, so the message is handled as text
      // and the document path is exercised by the upload endpoint and tests.
      if (m.type !== "text" && m.type !== "interactive") {
        const customer = findByPhone(orgId, m.from);
        const loanCase = customer ? activeCase(customer.id) : undefined;
        const media = await fetchWhatsAppMedia(m.mediaId);
        if (media && customer && loanCase) {
          const progress = caseProgress(loanCase.id);
          // Attribute to the item we most recently asked for; if a rejected item
          // is outstanding it takes precedence, since that is what we chased.
          const target = progress.rejected[0] ?? progress.missing[0];
          const stored = await receiveDocument({
            orgId,
            customerId: customer.id,
            filename: media.filename,
            mimeType: media.mimeType,
            data: media.data,
            checklistItemId: target?.id,
            loanCaseId: loanCase.id,
            uploadedBy: "customer",
          });
          if (stored.ok) documentId = stored.document.id;
        }
      }

      const outcome = await handleInbound({
        orgId,
        phone: m.from,
        name: m.name,
        body: m.text,
        externalId: m.id,
        documentId,
        receivedAt: m.timestamp,
      });
      outcomes.push({ id: m.id, customerId: outcome.customerId, replied: Boolean(outcome.reply), silent: outcome.silentReason });
    } catch (e) {
      console.error("[whatsapp/ops]", (e as Error).message);
      outcomes.push({ id: m.id, error: (e as Error).message });
    }
  }

  return NextResponse.json({ ok: true, received: messages.length, created, ops: outcomes });
}

/** Media download. Returns null in mock mode or when no token is configured. */
async function fetchWhatsAppMedia(
  mediaId?: string,
): Promise<{ data: Buffer; mimeType: string; filename: string } | null> {
  const token = process.env.META_SYSTEM_USER_TOKEN;
  if (!mediaId || !token || process.env.PLATFORM_DRIVER !== "live") return null;
  const version = process.env.META_GRAPH_VERSION ?? "v23.0";
  try {
    const meta = await fetch(`https://graph.facebook.com/${version}/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!meta.ok) return null;
    const info = (await meta.json()) as { url?: string; mime_type?: string };
    if (!info.url) return null;
    const bin = await fetch(info.url, { headers: { Authorization: `Bearer ${token}` } });
    if (!bin.ok) return null;
    const mimeType = info.mime_type ?? "application/octet-stream";
    const ext = mimeType === "application/pdf" ? "pdf" : (mimeType.split("/")[1] ?? "bin");
    return {
      data: Buffer.from(await bin.arrayBuffer()),
      mimeType,
      filename: `whatsapp-${mediaId}.${ext}`,
    };
  } catch {
    return null;
  }
}
