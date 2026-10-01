import { revalidatePath } from "next/cache";
import { readPost, respond, safePath, type ActionResult } from "@/lib/osf/form-post";
import {
  addMember,
  saveTenant,
  setChannelEnabled,
  setMemberRole,
  syncIntegrationRecords,
  type WriteResult,
} from "@/lib/osf/settings";
import { guard } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Writes for the three settings pages.
 *
 * Note what is NOT here: nothing writes an API key, a token or any credential.
 * Every secret this app uses lives in the environment and is read from there on
 * each request, so a settings screen that let someone type one in would either
 * be storing a secret in a table the service-role key can read, or lying about
 * having applied it. Integration state on /settings/integrations is derived
 * from the environment for the same reason.
 */

/** Which page each action came from, so a failed write lands back on it. */
const RETURN_TO: Record<string, string> = {
  tenant: "/inbox/whatsapp/settings",
  "add-member": "/inbox/whatsapp/settings/team",
  "set-role": "/inbox/whatsapp/settings/team",
  "set-channel": "/inbox/whatsapp/settings/integrations",
  "sync-integrations": "/inbox/whatsapp/settings/integrations",
};

export async function POST(request: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  const body = await readPost(request);
  const action = body.get("action") ?? "";

  let result: WriteResult;

  switch (action) {
    case "tenant":
      result = await saveTenant({
        orgName: body.get("orgName"),
        legalEntity: body.get("legalEntity") ?? "",
        logoUrl: body.get("logoUrl") ?? "",
        currency: body.get("currency"),
        timezone: body.get("timezone"),
        primaryPhone: body.get("primaryPhone") ?? "",
        primaryEmail: body.get("primaryEmail") ?? "",
        address: body.get("address") ?? "",
        website: body.get("website") ?? "",
      });
      break;

    case "add-member":
      result = await addMember({
        name: body.get("name"),
        email: body.get("email"),
        phone: body.get("phone"),
        role: body.get("role"),
        department: body.get("department"),
        acceptsLeads: body.bool("acceptsLeads"),
      });
      break;

    case "set-role":
      result = await setMemberRole(body.get("id") ?? "", body.get("role") ?? "");
      break;

    case "set-channel":
      // The desired end state is posted explicitly rather than read from a
      // checkbox: an unchecked box submits nothing, so a toggle built on one
      // can never turn a channel off.
      result = await setChannelEnabled(body.get("channel") ?? "", body.get("enabled") === "true");
      break;

    case "sync-integrations":
      result = await syncIntegrationRecords();
      break;

    default:
      result = { ok: false, error: `Unknown action: ${action}` };
  }

  const fallback = RETURN_TO[action] ?? "/inbox/whatsapp/settings";

  if (result.ok) {
    revalidatePath(fallback);
    // The tenant name and logo are rendered into the studio's device mockups.
  }

  // safePath is applied here rather than left to respond(), whose own fallback
  // is "/inbox/whatsapp" — a tampered `next` should still land the browser back on the page
  // the form was submitted from.
  const outcome: ActionResult = result.ok ? { ok: true, id: result.id } : result;
  return respond(request, body, safePath(body.get("next"), fallback), outcome);
}
