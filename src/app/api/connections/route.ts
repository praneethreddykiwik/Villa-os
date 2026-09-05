import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { specFor } from "@/lib/platforms/oauth";
import { channelMeta } from "@/lib/platforms/registry";
import { logActivity } from "@/lib/engine/publisher";
import type { ChannelId } from "@/lib/types";
import { guard } from "@/lib/auth/guard";
import { actorLabel, getSession } from "@/lib/auth/session";
import { STATE_COOKIE } from "./callback/route";

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

  const body = (await req.json()) as { brandId?: string; channel: ChannelId; action?: "connect" | "disconnect" | "reconnect" };
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


