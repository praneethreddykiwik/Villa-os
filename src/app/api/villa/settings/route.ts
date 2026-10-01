import { read, resolveBrandId } from "@/lib/db";
import { actorLabel, assertBrandAccess, requirePermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { rateLimit } from "@/lib/ops/ratelimit";
import { BOUNDS, loadSettings, saveSettings, validateSettings } from "@/lib/villa/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * THE OPERATIONAL SETTINGS BEHIND THE VILLA BUSINESS.
 *
 * Reading them is a read scope: the desk needs to know when calls run before
 * it queues two hundred numbers.
 *
 * Writing them is `workflows.manage`, not `customers.write`, and deliberately
 * a step above the queue itself. Queueing decides who gets called; this
 * decides when anybody does, how many phones ring at once, and how often
 * somebody who did not answer is tried again. Getting it wrong does not
 * inconvenience one lead — it either silences the whole queue or turns it into
 * a nuisance caller.
 */

export async function GET(req: Request) {
  try {
    const session = await requirePermission("customers.read");
    const brandId = resolveBrandId(read(), new URL(req.url).searchParams.get("brand") ?? undefined);
    assertBrandAccess(session, brandId);
    const settings = await loadSettings(brandId);
    // The bounds travel with the values so the form cannot drift from the
    // rules the server enforces.
    return apiOk({ settings, bounds: BOUNDS });
  } catch (e) {
    return apiError(e);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requirePermission("workflows.manage");

    const limit = rateLimit(`villa:settings:${session.userId}`, { max: 20, windowSeconds: 300 });
    if (!limit.allowed) {
      return apiFail(`Too many changes. Try again in ${limit.retryAfterSeconds ?? 300}s.`, 429);
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return apiFail("Send a JSON object.");
      body = parsed as Record<string, unknown>;
    } catch {
      return apiFail("Send a JSON object.");
    }

    const brandId = resolveBrandId(read(), typeof body.brandId === "string" ? body.brandId : undefined);
    assertBrandAccess(session, brandId);

    const checked = validateSettings(brandId, body);
    if (!checked.ok) return apiFail(checked.error);

    await saveSettings(checked.settings, actorLabel(session));
    return apiOk({ settings: checked.settings });
  } catch (e) {
    return apiError(e);
  }
}
