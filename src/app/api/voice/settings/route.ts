import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession, hasPermission } from "@/lib/auth/session";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { logActivity } from "@/lib/engine/publisher";
import { getConfig, recordSync, saveConfig, syncConfig, validateConfig } from "@/lib/voice/settings";

export const dynamic = "force-dynamic";

/**
 * VOICE AGENT SETTINGS — the client's wording, persisted per brand and pushed
 * to the live agent.
 *
 * `workflows.manage` on both verbs: what the agent says to callers is
 * configuration, and reading it back reveals the transfer number.
 */
export async function GET(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  try {
    const db = read();
    const brandId = resolveBrandId(db, new URL(req.url).searchParams.get("brand"));
    const brand = db.brands.find((b) => b.id === brandId);
    if (!brand) return apiFail("No brand is configured.", 409);
    return apiOk({ config: getConfig(brandId, brand.name) });
  } catch (e) {
    return apiError(e);
  }
}

export async function PUT(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;
  try {
    const session = await getSession();
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiFail("Send a JSON object.");
    }
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};

    const db = read();
    const brandId = resolveBrandId(db, typeof b.brandId === "string" ? b.brandId : null);
    const brand = db.brands.find((x) => x.id === brandId);
    if (!brand) return apiFail("No brand is configured.", 409);

    const validated = validateConfig(b, { brandId, businessName: brand.name, actor: actorLabel(session) });
    if (!validated.ok) return apiFail(validated.error);

    saveConfig(validated.config);
    const sync = await syncConfig(validated.config);
    recordSync(brandId, sync);
    logActivity(brandId, "voice_settings", `Voice agent wording updated${sync.synced ? " and pushed live" : ""}`, actorLabel(session));

    // The provider's own error text names the vendor; only administrators see it.
    const admin = hasPermission(session, "users.manage");
    return apiOk({
      config: getConfig(brandId, brand.name),
      synced: sync.synced,
      message: sync.message,
      ...(admin && sync.detail ? { detail: sync.detail } : {}),
    });
  } catch (e) {
    return apiError(e);
  }
}
