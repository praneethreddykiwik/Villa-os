import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { specFor } from "@/lib/platforms/oauth";
import { CHANNEL_ORDER, channelMeta } from "@/lib/platforms/registry";
import { logActivity } from "@/lib/engine/publisher";
import type { ChannelId } from "@/lib/types";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";
import { STATE_COOKIE } from "./callback/route";
import { uid } from "@/lib/ids";
import { isUploadPostConfigured } from "@/lib/uploadpost/client";
import { UPLOAD_POST_PLATFORM, uploadPostExternalId, uploadPostLinkedAccount } from "@/lib/uploadpost/connections";

/**
 * Connect / reconnect / disconnect a channel.
 *
 * In live mode this returns the provider's authorize URL for the browser to
 * follow; the callback exchanges the code and stores the token server-side.
 * There is no second path: a connection can only come from a real OAuth grant,
 * so an unconfigured deployment is told what it is missing rather than being
 * handed an account that does not exist.
 */
export async function POST(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  // Disconnecting a channel destroys a credential that can publish publicly.
  // "user" did it was never an acceptable record of that.
  const actor = actorLabel(await getSession());

  let body: { brandId?: string; channel: ChannelId; action?: "connect" | "disconnect" | "reconnect" };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "The request body must be JSON." }, { status: 400 });
  }
  // `channel` indexes UPLOAD_POST_PLATFORM and the adapter registry, both plain
  // objects: an unknown or prototype key ("__proto__", "constructor") must be
  // refused before it can look up a function and be treated as a platform.
  if (!CHANNEL_ORDER.includes(body.channel)) {
    return NextResponse.json({ ok: false, error: "Unknown channel." }, { status: 400 });
  }
  const db = read();
  const brandId = resolveBrandId(db, body.brandId);
  const spec = specFor(body.channel);
  const meta = channelMeta(body.channel);

  if (body.action === "disconnect") {
    mutate((d) => {
      const c = d.connections.find((x) => x.brandId === brandId && x.channel === body.channel);
      if (c) {
        c.status = "disconnected";
        c.accessToken = undefined;
        c.lastError = undefined;
      }
    });
    logActivity(brandId, "connection", `${meta.label} disconnected`, actor);
    return NextResponse.json({ ok: true, status: "disconnected" });
  }

  const missingEnv = (spec?.envVars ?? []).filter((v) => !process.env[v]);

  /**
   * Upload-Post first.
   *
   * When the network is linked on the Upload-Post account, connecting is a
   * bookkeeping step rather than an OAuth dance: record a row the publisher
   * routes through Upload-Post. The native OAuth path below still runs for
   * networks that are not linked there, so a deployment can mix the two.
   */
  if (UPLOAD_POST_PLATFORM[body.channel] && isUploadPostConfigured()) {
    const linked = await uploadPostLinkedAccount(body.channel);
    if (linked) {
      // Usernames get the @; a display name with spaces is shown as-is.
      const raw = linked.handle || linked.display_name || body.channel;
      const handle = raw.startsWith("@") || /\s/.test(raw) ? raw : `@${raw}`;
      const externalId = uploadPostExternalId(body.channel);
      const now = new Date().toISOString();
      mutate((d) => {
        const existing = d.connections.find((x) => x.brandId === brandId && x.channel === body.channel);
        if (existing) {
          Object.assign(existing, { status: "connected", externalId, handle, accessToken: undefined, refreshToken: undefined, tokenExpiresAt: undefined, lastError: undefined, connectedAt: now, scopes: ["upload-post"] });
        } else {
          d.connections.push({
            id: uid("con"),
            brandId,
            channel: body.channel,
            handle,
            externalId,
            status: "connected",
            scopes: ["upload-post"],
            avatarColor: meta.color,
            followers: 0,
            connectedAt: now,
          });
        }
      });
      logActivity(brandId, "connection", `${meta.label} connected via the publishing connector (${handle})`, actor);
      return NextResponse.json({ ok: true, status: "connected", via: "upload_post", handle });
    }
    if (missingEnv.length) {
      return NextResponse.json(
        {
          ok: false,
          error: `${meta.label} is not linked on your Upload-Post account (profile "${process.env.UPLOAD_POST_USER ?? "default"}"). Link it at upload-post.com and connect again, or set ${missingEnv.join(", ")} for the native sign-in.`,
          missingEnv,
        },
        { status: 400 },
      );
    }
  }

  if (process.env.PLATFORM_DRIVER === "live") {
    if (missingEnv.length) {
      return NextResponse.json(
        { ok: false, error: `Missing environment variables: ${missingEnv.join(", ")}`, missingEnv },
        { status: 400 },
      );
    }
    if (!spec) {
      return NextResponse.json(
        { ok: false, error: `${meta.label} has no connect flow in this build yet.` },
        { status: 400 },
      );
    }

    const redirect = `${new URL(req.url).origin}/api/connections/callback?channel=${body.channel}&brand=${brandId}`;

    /**
     * CSRF state.
     *
     * Generated here, echoed by the provider, and compared in the callback. It
     * is what stops someone handing a signed-in operator a crafted callback URL
     * that attaches the attacker's social account to this workspace. HttpOnly so
     * page scripts cannot read it; SameSite=lax so it survives the provider's
     * top-level redirect back, which `strict` would drop.
     */
    const state = crypto.randomBytes(32).toString("base64url");
    const res = NextResponse.json({
      ok: true,
      authorizeUrl: `${spec.authorizeUrl(redirect)}&state=${state}`,
      scopes: spec.scopes,
    });
    res.cookies.set(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600,
    });
    return res;
  }

  /**
   * Not live: refuse, and say exactly what is missing.
   *
   * The alternative — writing a "connected" row with a placeholder token — is
   * the expensive kind of convenience. Every screen that reads `connections`
   * would then state that an account is live, the composer would offer it as a
   * publish target, and the first person to trust that screen finds out at
   * publish time that no account was ever linked. A refusal here costs a click;
   * a fabricated connection costs the user's trust in every other number we show.
   */
  const setup = !spec
    ? `${meta.label} has no connect flow in this build yet.`
    : missingEnv.length
      ? `${meta.label} is not configured. Set ${missingEnv.join(", ")} and PLATFORM_DRIVER=live in .env, then connect again.`
      : `${meta.label} credentials are set, but PLATFORM_DRIVER is "${process.env.PLATFORM_DRIVER ?? "mock"}". Set PLATFORM_DRIVER=live to run the real sign-in.`;

  return NextResponse.json({ ok: false, error: setup, missingEnv }, { status: 400 });
}

export async function GET(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brand"));

  // Allowlist public connection fields only — never tokens
  const connections = db.connections
    .filter((c) => !brandId || c.brandId === brandId)
    .map((c) => ({
      id: c.id,
      brandId: c.brandId,
      channel: c.channel,
      handle: c.handle,
      externalId: c.externalId,
      status: c.status,
      scopes: c.scopes,
      avatarColor: c.avatarColor,
      followers: c.followers,
      connectedAt: c.connectedAt,
      lastSyncedAt: c.lastSyncedAt,
      lastError: c.lastError,
    }));

  return NextResponse.json({ ok: true, connections });
}


