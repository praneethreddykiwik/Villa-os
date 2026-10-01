import { revalidatePath } from "next/cache";
import { logActivity } from "@/lib/osf/activities";
import { readPost, respond, safePath, type ActionResult } from "@/lib/osf/form-post";
import {
  UNIT_STATUS_LABELS,
  createProject,
  createUnit,
  isUnitStatus,
  updateProjectPricing,
  updateUnitStatus,
  updateVillaTypePrice,
} from "@/lib/osf/properties";
import { guard } from "@/lib/auth/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Inventory writes behind the availability board.
 *
 * Accepts a plain form POST — the board submits real forms so it works with no
 * client JS — or the same field names as JSON, for a script loading an approved
 * inventory sheet.
 *
 * Every write here changes what the AI agent is willing to say out loud: an
 * empty villa_units makes it refuse to quote availability, and a row added here
 * makes it start quoting unit numbers. So both actions are logged to the
 * activity feed — an availability claim made to a customer has to be traceable
 * back to whoever entered the stock.
 */
export async function POST(request: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;
  const body = await readPost(request);
  const back = safePath(body.get("next"), "/inbox/whatsapp/properties/inventory");
  const action = body.get("action") ?? "create-unit";

  const finish = (result: ActionResult) => {
    if (result.ok) {
      // Every Properties screen reads the same records, and so do both agents.
      // Revalidating only the board left the catalogue showing the old price.
      for (const path of [
        "/inbox/whatsapp/properties/inventory",
        "/inbox/whatsapp/properties/projects",
        "/inbox/whatsapp/properties/villas",
        "/settings/properties",
      ]) {
        revalidatePath(path);
      }
    }
    return respond(request, body, back, result);
  };

  /** A rupee amount from a form field: absent is absent, not zero. */
  const money = (name: string): number | null | { error: string } => {
    const raw = body.get(name);
    if (raw === undefined) return null;
    const value = Number(String(raw).replace(/[,\s₹]/g, ""));
    if (!Number.isFinite(value) || value < 0) return { error: `${name} must be a positive number` };
    return value;
  };

  if (action === "create-project") {
    const starting = money("startingPriceInr");
    if (starting !== null && typeof starting === "object") return finish({ ok: false, error: starting.error });
    const perSft = money("pricePerSftInr");
    if (perSft !== null && typeof perSft === "object") return finish({ ok: false, error: perSft.error });

    const result = await createProject({
      name: body.get("name") ?? "",
      developer: body.get("developer") ?? null,
      phase: body.get("phase") ?? null,
      status: body.get("status") ?? null,
      expectedDelivery: body.get("expectedDelivery") ?? null,
      village: body.get("village") ?? null,
      district: body.get("district") ?? null,
      startingPriceInr: starting,
      pricePerSftInr: perSft,
    });
    if (!result.ok) return finish(result);

    // A new project changes what the agent will talk about at all, so it is
    // traceable to whoever added it.
    await logActivity({
      type: "inventory_updated",
      description: `Project "${result.name}" added`,
      actorName: "Console",
      metadata: { project_id: result.id },
    });
    return finish({ ok: true, id: result.id });
  }

  if (action === "update-project-pricing") {
    const starting = money("startingPriceInr");
    if (starting !== null && typeof starting === "object") return finish({ ok: false, error: starting.error });
    const perSft = money("pricePerSftInr");
    if (perSft !== null && typeof perSft === "object") return finish({ ok: false, error: perSft.error });

    const result = await updateProjectPricing(body.get("projectId") ?? "", {
      startingPriceInr: starting,
      pricePerSftInr: perSft,
      clear: body.bool("clear"),
    });
    if (!result.ok) return finish(result);

    await logActivity({
      type: "inventory_updated",
      description: `Pricing updated for "${result.name}"`,
      actorName: "Console",
      metadata: { project_id: body.get("projectId") ?? "" },
    });
    return finish({ ok: true });
  }

  if (action === "update-villa-price") {
    const clear = body.bool("clear");
    const price = money("priceInr");
    if (price !== null && typeof price === "object") return finish({ ok: false, error: price.error });

    const result = await updateVillaTypePrice(body.get("villaTypeId") ?? "", price, { clear });
    if (!result.ok) return finish(result);

    // The number the agent quotes. If this is wrong a customer is told the
    // wrong price, so it is logged with both the villa type and the new value.
    await logActivity({
      type: "inventory_updated",
      description: result.price === null
        ? `${result.name} price cleared — the agent will stop quoting it`
        : `${result.name} priced at ₹${result.price.toLocaleString("en-IN")}`,
      actorName: "Console",
      metadata: { villa_type_id: body.get("villaTypeId") ?? "", price_inr: result.price },
    });
    return finish({ ok: true });
  }

  if (action === "unit-status") {
    const status = body.get("status") ?? "";
    if (!isUnitStatus(status)) return finish({ ok: false, error: `invalid status: ${status}` });

    const result = await updateUnitStatus(body.get("unitId") ?? "", status);
    if (!result.ok) return finish(result);

    await logActivity({
      type: "inventory_updated",
      description: `Unit ${result.unit.unit_number} marked ${UNIT_STATUS_LABELS[status].toLowerCase()}`,
      actorName: "Console",
      metadata: { unit_id: result.unit.id, project_id: result.unit.project_id, status },
    });

    return finish({ ok: true, unit: result.unit });
  }

  if (action !== "create-unit") {
    return finish({ ok: false, error: `unknown action: ${action}` });
  }

  const numeric = (name: string): number | null | { error: string } => {
    const raw = body.get(name);
    if (raw === undefined) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return { error: `${name} must be a positive number` };
    return value;
  };

  const priceInr = numeric("priceInr");
  if (priceInr !== null && typeof priceInr === "object") return finish({ ok: false, error: priceInr.error });
  const plotAreaSqyd = numeric("plotAreaSqyd");
  if (plotAreaSqyd !== null && typeof plotAreaSqyd === "object") {
    return finish({ ok: false, error: plotAreaSqyd.error });
  }

  const status = body.get("status") ?? "available";
  if (!isUnitStatus(status)) return finish({ ok: false, error: `invalid status: ${status}` });

  const result = await createUnit({
    projectId: body.get("projectId") ?? "",
    unitNumber: body.get("unitNumber") ?? "",
    villaTypeId: body.get("villaTypeId") ?? null,
    facing: body.get("facing") ?? null,
    isCorner: body.bool("isCorner"),
    plotAreaSqyd,
    priceInr,
    status,
  });
  if (!result.ok) return finish(result);

  await logActivity({
    type: "inventory_updated",
    description: `Unit ${result.unit.unit_number} added to live inventory as ${UNIT_STATUS_LABELS[status].toLowerCase()}`,
    actorName: "Console",
    metadata: { unit_id: result.unit.id, project_id: result.unit.project_id, status },
  });

  return finish({ ok: true, unit: result.unit });
}
