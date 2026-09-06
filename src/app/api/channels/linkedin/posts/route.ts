import { NextResponse } from "next/server";
import { read, resolveBrandId } from "@/lib/db";
import { guard } from "@/lib/auth/guard";
import { getSession, assertBrandAccess } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const denied = await guard("analytics.view");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brandId"));

  // Validate the authenticated user belongs to this brand
  const session = await getSession();
  if (session) {
    try {
      assertBrandAccess(session, brandId);
    } catch {
      return NextResponse.json({ ok: false, error: "Brand not found or access denied." }, { status: 403 });
    }
  }
  
  const conn = db.connections.find(
    (c) => c.brandId === brandId && c.channel === "linkedin" && c.status !== "disconnected"
  );

  if (!conn || !conn.accessToken) {
    return NextResponse.json({
      ok: false,
      error: "No LinkedIn connection with access token found",
      code: "no_token",
      handle: conn?.handle || "LinkedIn",
    });
  }

  const token = conn.accessToken;
  const authorUrn = conn.externalId?.startsWith("urn:li:") 
    ? conn.externalId 
    : process.env.LINKEDIN_ORG_URN;

  if (!authorUrn) {
    return NextResponse.json({
      ok: false,
      error: "No valid LinkedIn URN found. Please configure your Organization or Author URN.",
      code: "no_urn",
      handle: conn.handle,
    });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": "202510",
    "X-Restli-Protocol-Version": "2.0.0",
  };

  try {
    const postsUrl = `https://api.linkedin.com/rest/posts?author=${encodeURIComponent(authorUrn)}&q=author&count=20&fields=id,commentary,createdAt,lastModifiedAt,visibility`;
    const postsRes = await fetch(postsUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!postsRes.ok) {
      const errText = await postsRes.text().catch(() => "");
      return NextResponse.json({
        ok: false,
        error: `LinkedIn API error (${postsRes.status}): ${errText || postsRes.statusText}`,
        code: "api_error",
        handle: conn.handle,
      });
    }

    const postsData = await postsRes.json();
    const elements = postsData.elements || [];

    const posts = await Promise.all(elements.map(async (post: any) => {
      let likes = 0;
      let comments = 0;
      let shares = 0;
      
      try {
        const actionsUrl = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(post.id)}`;
        const actionsRes = await fetch(actionsUrl, { headers, cache: "no-store", signal: AbortSignal.timeout(5000) });
        if (actionsRes.ok) {
          const actionsData = await actionsRes.json();
          likes = actionsData.likesSummary?.totalLikes || 0;
          comments = actionsData.commentsSummary?.totalFirstDegreeComments || 0;
          shares = actionsData.sharesSummary?.totalShares || 0;
        }
      } catch {
        // Ignore social action fetch errors per post
      }

      return {
        id: post.id,
        text: post.commentary || "",
        publishedAt: new Date(post.createdAt).toISOString(),
        visibility: post.visibility || "PUBLIC",
        metrics: {
          likes,
          comments,
          shares,
          impressions: 0,
        }
      };
    }));

    return NextResponse.json({
      ok: true,
      posts,
      handle: conn.handle,
      authorUrn,
      connectionId: conn.id,
    });
  } catch (e) {
    return NextResponse.json({
      ok: false,
      error: e instanceof Error ? e.message : "Failed to connect to LinkedIn API",
      code: "network_error",
      handle: conn.handle,
    });
  }
}

export async function POST(req: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;

  const url = new URL(req.url);
  const db = read();
  const brandId = resolveBrandId(db, url.searchParams.get("brandId"));

  const session = await getSession();
  if (session) {
    try {
      assertBrandAccess(session, brandId);
    } catch {
      return NextResponse.json({ ok: false, error: "Brand not found or access denied." }, { status: 403 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const { accessToken, authorUrn, handle } = body;

  if (!accessToken && !authorUrn) {
    return NextResponse.json({ ok: false, error: "Please provide an Access Token or Author/Page URN." }, { status: 400 });
  }

  const { mutate } = await import("@/lib/db");
  mutate((draft) => {
    let conn = draft.connections.find(
      (c) => c.brandId === brandId && c.channel === "linkedin"
    );
    if (!conn) {
      const newConn: import("@/lib/types").Connection = {
        id: `con_${Date.now()}`,
        brandId,
        channel: "linkedin",
        handle: handle?.trim() || "LinkedIn Account",
        externalId: authorUrn?.trim() || `urn:li:organization:${Date.now()}`,
        status: "connected",
        followers: 0,
        scopes: ["w_organization_social", "r_organization_social"],
        avatarColor: "#0077b5",
        connectedAt: new Date().toISOString(),
      };
      draft.connections.push(newConn);
      conn = newConn;
    }
    if (accessToken) conn.accessToken = accessToken.trim();
    if (authorUrn) conn.externalId = authorUrn.trim();
    if (handle) conn.handle = handle.trim();
    conn.status = "connected";
    conn.lastSyncedAt = new Date().toISOString();
  });

  return NextResponse.json({ ok: true });
}
