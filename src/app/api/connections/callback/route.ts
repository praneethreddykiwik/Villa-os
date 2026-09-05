import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { mutate, read } from "@/lib/db";
import { uid } from "@/lib/ids";
import { exchangeCode, ExchangeError } from "@/lib/platforms/exchange";
import { channelMeta } from "@/lib/platforms/registry";
import { specFor } from "@/lib/platforms/oauth";
import { logActivity } from "@/lib/engine/publisher";
import { actorLabel, requirePermission } from "@/lib/auth/session";
import type { ChannelId } from "@/lib/types";

/**
 * OAUTH CALLBACK
 *
 * The provider redirects here with a single-use code. This exchanges it for a
 * token, resolves which account that token acts for, and writes the connection.
 *
 * The route existed only as a URL before: `/api/connections` handed the browser
 * an authorize URL pointing at this path, and nothing served it — so the connect
 * flow left the app and never came back. Every channel was therefore
 * unconnectable, which in turn made publishing unreachable.
 *
 * Three things this has to get right:
 *
 *  - **CSRF.** The `state` parameter is generated at authorize time, stored in
 *    an HttpOnly cookie, and compared here in constant time. Without it, anyone
 *    can hand a signed-in operator a link that attaches *their* social account
 *    to the operator's workspace.
 *  - **Single use.** The state cookie is cleared whatever the outcome, so a
 *    replayed callback cannot re-run the exchange.
 *  - **Never leak the token.** The access token is written server-side and never
 *    put in a redirect URL, where it would land in browser history and any
 *    intermediary's logs.
 */

export const STATE_COOKIE = "glentree_oauth_state";

/** Redirect back to the Connections screen with a short, safe status message. */
function back(origin: string, params: Record<string, string>): NextResponse {
  const url = new URL("/connections", origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.set(STATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const origin = url.origin;
  const channel = url.searchParams.get("channel") as ChannelId | null;
  const brandId = url.searchParams.get("brand") ?? "";
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state") ?? "";

  // The provider reports a user-facing refusal ("cancelled") this way rather
  // than by failing the redirect, so surface it as-is instead of as an error.
  const providerError = url.searchParams.get("error_description") ?? url.searchParams.get("error");

  if (!channel) return back(origin, { connect: "error", reason: "Missing channel." });

  // Connecting a channel writes a credential that can publish publicly, so it
  // needs the same permission as initiating the flow did. The session is kept
  // rather than discarded so the activity entry below can name the person who
  // attached the account, which is the whole point of recording it.
  const session = await requirePermission("workflows.manage").catch(() => null);
  if (!session) {
    return back(origin, { connect: "error", channel, reason: "You do not have permission to connect channels." });
  }

  if (providerError) {
    return back(origin, { connect: "error", channel, reason: providerError.slice(0, 200) });
  }
  if (!code) {
    return back(origin, { connect: "error", channel, reason: "No authorization code was returned." });
  }

  const jar = await cookies();
  const expected = jar.get(STATE_COOKIE)?.value ?? "";
  if (!expected || !state || !safeEqual(expected, state)) {
    return back(origin, {
      connect: "error",
      channel,
      reason: "This sign-in could not be verified. Start the connection again from this page.",
    });
  }

  // Must match the redirect_uri sent at authorize time byte for byte, or the
  // provider rejects the exchange.
  const redirectUri = `${origin}/api/connections/callback?channel=${channel}&brand=${brandId}`;

  try {
    const grant = await exchangeCode(channel, code, redirectUri);
    const meta = channelMeta(channel);
    const db = read();
    const resolvedBrand = db.brands.some((b) => b.id === brandId) ? brandId : (db.brands[0]?.id ?? "");
    const expiresAt = grant.expiresIn
      ? new Date(Date.now() + grant.expiresIn * 1000).toISOString()
      : undefined;

    mutate((d) => {
      const existing = d.connections.find((c) => c.brandId === resolvedBrand && c.channel === channel);
      if (existing) {
        existing.status = "connected";
        existing.accessToken = grant.accessToken;
        existing.refreshToken = grant.refreshToken;
        existing.externalId = grant.externalId;
        existing.handle = grant.handle;
        existing.tokenExpiresAt = expiresAt;
        existing.lastError = undefined;
        existing.connectedAt = new Date().toISOString();
        return;
      }
      d.connections.push({
        id: uid("con"),
        brandId: resolvedBrand,
        channel,
        handle: grant.handle,
        externalId: grant.externalId,
        status: "connected",
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        tokenExpiresAt: expiresAt,
        scopes: specFor(channel)?.scopes ?? [],
        avatarColor: meta.color,
        // Real follower counts arrive from the platform on the first metrics
        // sync. Zero here means "not yet retrieved", not "no audience".
        followers: 0,
        connectedAt: new Date().toISOString(),
      });
    });

    logActivity(resolvedBrand, "connection", `${meta.label} connected as ${grant.handle}`, actorLabel(session));
    return back(origin, { connect: "ok", channel, handle: grant.handle });
  } catch (e) {
    const reason =
      e instanceof ExchangeError
        ? e.message
        : "The provider rejected the connection. Check the app credentials and try again.";
    if (!(e instanceof ExchangeError)) {
      const ref = crypto.randomUUID();
      console.error(`[connect:${ref}]`, e instanceof Error ? e.stack : e);
    }
    return back(origin, { connect: "error", channel, reason: reason.slice(0, 200) });
  }
}
