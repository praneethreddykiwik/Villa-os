import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { apiError, apiOk } from "@/lib/auth/http";
import { loadVoiceOverview } from "@/lib/bolna/overview";

export const dynamic = "force-dynamic";

/**
 * VOICE AGENTS — read surface.
 *
 * Agents, their configuration, and recent call history matched to CRM leads.
 * This is customer information — who was called, what was said, what it cost —
 * so it takes `customers.read` and nothing looser.
 *
 * A Bolna outage answers 200 with `problems` populated rather than 5xx. The
 * distinction is deliberate: this request succeeded, and the panel needs the
 * lead list and the provider's error text to render something honest. A 500
 * here would give the operator a broken tab and no explanation.
 */
export async function GET(req: Request) {
  const denied = await guard("customers.read");
  if (denied) return denied;

  try {
    const brandId = resolveBrandId(read(), new URL(req.url).searchParams.get("brand") ?? undefined);
    const overview = await loadVoiceOverview(brandId);
    return apiOk({ ...overview, brandId });
  } catch (e) {
    return apiError(e);
  }
}
