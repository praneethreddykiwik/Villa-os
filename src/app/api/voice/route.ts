import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { getSession, hasPermission } from "@/lib/auth/session";
import { apiError, apiOk } from "@/lib/auth/http";
import { loadVoiceOverview } from "@/lib/voice/overview";

export const dynamic = "force-dynamic";

/**
 * VOICE AGENT — read surface.
 *
 * Calls, transcripts, extracted fields and the funnel for one brand. This is
 * customer information — who called and what they said — so it takes
 * `customers.read`. Provider diagnostics (vendor, balance, spend) are attached
 * only for `users.manage`; everything else is white-labelled.
 */
const RANGES = new Set([7, 30, 90]);

export async function GET(req: Request) {
  const denied = await guard("customers.read");
  if (denied) return denied;

  try {
    const url = new URL(req.url);
    const brandId = resolveBrandId(read(), url.searchParams.get("brand") ?? url.searchParams.get("brandId"));
    const requested = Number(url.searchParams.get("range") ?? 30);
    const days = RANGES.has(requested) ? requested : 30;
    const session = await getSession();
    const overview = await loadVoiceOverview(brandId, { days, diagnostics: hasPermission(session, "users.manage") });
    return apiOk({ overview });
  } catch (e) {
    return apiError(e);
  }
}
