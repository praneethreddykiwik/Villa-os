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
    });
  }

  const token = conn.accessToken;
  const authorUrn = conn.externalId?.startsWith("urn:li:") 
    ? conn.externalId 
    : process.env.LINKEDIN_ORG_URN;

  if (!authorUrn) {
    return NextResponse.json({
      ok: false,
      error: "No valid LinkedIn URN found. Set LINKEDIN_ORG_URN.",
    });
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    "LinkedIn-Version": "202510",
    "X-Restli-Protocol-Version": "2.0.0",
  };

  const postsUrl = `https://api.linkedin.com/rest/posts?author=${encodeURIComponent(authorUrn)}&q=author&count=20&fields=id,commentary,createdAt,lastModifiedAt,visibility`;
  const postsRes = await fetch(postsUrl, { headers, cache: "no-store" });
  if (!postsRes.ok) {
    return NextResponse.json({
      ok: false,
      error: `Failed to fetch LinkedIn posts: ${postsRes.status}`,
    });
  }

  const postsData = await postsRes.json();
  const elements = postsData.elements || [];

  const posts = await Promise.all(elements.map(async (post: any) => {
    let likes = 0;
    let comments = 0;
    let shares = 0;
    
    // Fetch social actions for each post
    try {
      const actionsUrl = `https://api.linkedin.com/rest/socialActions/${encodeURIComponent(post.id)}`;
      const actionsRes = await fetch(actionsUrl, { headers, cache: "no-store" });
      if (actionsRes.ok) {
        const actionsData = await actionsRes.json();
        likes = actionsData.likesSummary?.totalLikes || 0;
        comments = actionsData.commentsSummary?.totalFirstDegreeComments || 0;
        shares = actionsData.sharesSummary?.totalShares || 0;
      }
    } catch (e) {
      // Ignore
    }

    return {
      id: post.id,
      text: post.commentary || "",
      publishedAt: new Date(post.createdAt).toISOString(),
      visibility: post.visibility,
      metrics: {
        likes,
        comments,
        shares,
        impressions: 0, // Not available through standard basic API easily without organizationalEntityShareStatistics
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
}
