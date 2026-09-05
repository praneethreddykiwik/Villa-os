import { guard } from "@/lib/auth/guard";
import { apiError, apiFail, apiOk } from "@/lib/auth/http";
import { actorLabel, getSession } from "@/lib/auth/session";
import { logActivity } from "@/lib/engine/publisher";
import { read } from "@/lib/db";
import {
  ALL_EVENTS,
  ORBIT_EVENTS,
  addSubscriber,
  checkWebhookUrl,
  isOrbitEvent,
  publicSubscribers,
  recentDeliveries,
  removeSubscriber,
  subscribers,
  type OrbitEvent,
} from "@/lib/events/bus";

/**
 * SUBSCRIBER CONFIGURATION — where outbound events go.
 *
 * Gated on `workflows.manage` throughout, including the read. The list is not
 * innocuous: it names every external system wired into this business and the
 * exact events each one watches, which is a map of the automation surface.
 *
 * The secret is write-only. It goes in on POST and is never returned by
 * anything here — a leaked signing key lets an attacker forge deliveries that
 * n8n will verify and act on, so "show it once so the operator can copy it"
 * would trade the whole point of signing for a small convenience. An operator
 * who loses it deletes the subscriber and registers a new one.
 */

/** Enough entropy that a signature is not brute-forceable. 32 hex chars ≈ 128 bits. */
const MIN_SECRET_CHARS = 24;

/** Ceiling on registered endpoints — each one is a fetch on every matching event. */
const MAX_SUBSCRIBERS = 25;

export async function GET() {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  try {
    return apiOk({
      subscribers: publicSubscribers(),
      deliveries: recentDeliveries(50),
      /** The catalogue, so the UI does not hard-code a second copy of it. */
      events: ORBIT_EVENTS,
    });
  } catch (e) {
    return apiError(e);
  }
}

export async function POST(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  try {
    const actor = actorLabel(await getSession());

    let body: { url?: unknown; events?: unknown; secret?: unknown };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return apiFail("The request body must be JSON.", 400);
    }

    const url = typeof body.url === "string" ? body.url.trim() : "";
    // https-only, no credentials, no loopback/link-local/private literal. The
    // same function runs again at delivery time, because a rule that only ran
    // when the row was written does not protect rows written before it existed.
    const urlProblem = checkWebhookUrl(url);
    if (urlProblem) return apiFail(urlProblem, 400);

    const raw = Array.isArray(body.events) ? body.events : [];
    if (!raw.length) {
      return apiFail(`Choose at least one event, or "${ALL_EVENTS}" for all of them.`, 400);
    }
    const events: Array<OrbitEvent | typeof ALL_EVENTS> = [];
    for (const e of raw) {
      if (e === ALL_EVENTS) {
        events.push(ALL_EVENTS);
        continue;
      }
      if (!isOrbitEvent(e)) {
        return apiFail(`Unknown event "${String(e).slice(0, 60)}". Known events: ${ORBIT_EVENTS.join(", ")}.`, 400);
      }
      events.push(e);
    }

    const secret = typeof body.secret === "string" ? body.secret : "";
    if (secret.length < MIN_SECRET_CHARS) {
      return apiFail(`The signing secret must be at least ${MIN_SECRET_CHARS} characters.`, 400);
    }

    const existing = subscribers();
    if (existing.length >= MAX_SUBSCRIBERS) {
      return apiFail(`At most ${MAX_SUBSCRIBERS} subscribers can be registered.`, 409);
    }
    // Two rows for one URL means every event is delivered twice, which looks
    // like a bug in the receiving workflow rather than a duplicate here.
    if (existing.some((s) => s.url === url)) {
      return apiFail("That URL is already registered. Delete it first to change its events or secret.", 409);
    }

    const sub = addSubscriber({ url, events, secret, createdBy: actor });
    const brandId = read().brands[0]?.id;
    if (brandId) logActivity(brandId, "integrations", `n8n subscriber registered for ${new URL(url).host}`, actor);

    const { secret: _secret, ...safe } = sub;
    return apiOk({ subscriber: safe }, 201);
  } catch (e) {
    return apiError(e);
  }
}

export async function DELETE(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  try {
    const actor = actorLabel(await getSession());
    const id = new URL(req.url).searchParams.get("id") ?? "";
    if (!id) return apiFail("Which subscriber? Pass ?id=.", 400);

    const target = subscribers().find((s) => s.id === id);
    if (!removeSubscriber(id)) return apiFail("That subscriber does not exist.", 404);

    const brandId = read().brands[0]?.id;
    if (brandId && target) {
      logActivity(brandId, "integrations", `n8n subscriber removed for ${new URL(target.url).host}`, actor);
    }
    return apiOk({ removed: id });
  } catch (e) {
    return apiError(e);
  }
}
