import { NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import {
  sendWhatsAppTemplate,
  sendWhatsAppText,
  setAiPaused,
} from "@/lib/osf/communication";
import { readPost, respond, safePath, type ActionResult } from "@/lib/osf/form-post";
import { guard } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Outbound WhatsApp and thread ownership, behind one endpoint.
 *
 * The composer submits a plain form, so every action has to work with no client
 * JS; `readPost` also accepts JSON so a script can drive the same handlers.
 *
 * Meta's 24-hour rule is enforced in `sendWhatsAppText`, not here and not in the
 * composer. The composer hiding the free-text box is a courtesy for the rep; a
 * stale tab still has it, and only the server refusing keeps a doomed send from
 * costing the customer their reply.
 */

const COMM_PATHS = ["/inbox/whatsapp/communication/whatsapp"];

/** "Ravi | Saturday 11am" → ["Ravi", "Saturday 11am"]. */
function splitParams(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split("|")
    .map((value) => value.trim())
    .filter(Boolean);
}

export async function POST(request: Request) {
  const denied = await guard("customers.write");
  if (denied) return denied;
  const body = await readPost(request);
  const action = body.get("action");
  const redirectTo = safePath(body.get("next"), "/inbox/whatsapp/communication/whatsapp");

  let result: ActionResult;
  let leadId: string | undefined;

  switch (action) {
    case "send_text": {
      const sent = await sendWhatsAppText({
        conversationId: body.get("conversationId") ?? "",
        text: body.get("text") ?? "",
      });
      result = sent.ok ? { ok: true, messageId: sent.messageId } : sent;
      break;
    }

    case "send_template": {
      const sent = await sendWhatsAppTemplate({
        conversationId: body.get("conversationId") ?? "",
        templateName: body.get("templateName") ?? "",
        language: body.get("language") ?? null,
        params: splitParams(body.get("params")),
      });
      result = sent.ok ? { ok: true, messageId: sent.messageId } : sent;
      break;
    }

    case "set_ai_paused":
      leadId = body.get("leadId");
      result = await setAiPaused(leadId ?? "", body.bool("paused"));
      break;

    default:
      return NextResponse.json(
        { error: "action must be one of send_text, send_template, set_ai_paused" },
        { status: 400 },
      );
  }

  if (result.ok) {
    for (const path of COMM_PATHS) revalidatePath(path);
    // Sending pauses the AI on the lead, which the lead's own page renders.
    if (leadId) revalidatePath(`/inbox/whatsapp/crm/leads/${leadId}`);
  }

  return respond(request, body, redirectTo, result);
}
