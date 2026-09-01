import { NextResponse } from "next/server";
import { mutate, read, resolveBrandId } from "@/lib/db";
import { uid } from "@/lib/ids";
import { specFor } from "@/lib/platforms/oauth";
import { channelMeta } from "@/lib/platforms/registry";
import { logActivity } from "@/lib/engine/publisher";
import type { ChannelId } from "@/lib/types";
import { guard } from "@/lib/auth/guard";

/**
 * Connect / reconnect / disconnect a channel.
 *
 * In live mode this returns the provider's authorize URL for the browser to
 * follow; the callback would exchange the code and store the token server-side.
 * In mock mode it marks the channel connected immediately so the whole flow is
 * demonstrable without registering six developer apps.
 */
export async function POST(req: Request) {
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  const body = (await req.json()) as { brandId?: string; channel: ChannelId; handle?: string; action?: "connect" | "disconnect" | "reconnect" };
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
    logActivity(brandId, "connection", `${meta.label} disconnected`, "user");
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
    const redirect = `${new URL(req.url).origin}/api/connections/callback?channel=${body.channel}&brand=${brandId}`;
    return NextResponse.json({ ok: true, authorizeUrl: spec?.authorizeUrl(redirect), scopes: spec?.scopes });
  }

  // Mock: connect (or revive) the channel so the rest of the product is usable.
  const now = new Date().toISOString();
  mutate((d) => {
    const existing = d.connections.find((x) => x.brandId === brandId && x.channel === body.channel);
    if (existing) {
      existing.status = "connected";
      existing.accessToken = "mock-token";
      existing.lastError = undefined;
      existing.lastSyncedAt = now;
      existing.tokenExpiresAt = new Date(Date.now() + 60 * 864e5).toISOString();
      return;
    }
    d.connections.push({
      id: uid("conn"),
      brandId,
      channel: body.channel,
      handle: body.handle ?? `${meta.label} account`,
      externalId: `${body.channel}_${uid("ext")}`,
      status: "connected",
      accessToken: "mock-token",
      tokenExpiresAt: new Date(Date.now() + 60 * 864e5).toISOString(),
      scopes: spec?.scopes ?? [],
      avatarColor: meta.color,
      followers: 0,
      connectedAt: now,
      lastSyncedAt: now,
    });
  });

  logActivity(brandId, "connection", `${meta.label} connected`, "user");
  return NextResponse.json({ ok: true, status: "connected", scopes: spec?.scopes });
}
