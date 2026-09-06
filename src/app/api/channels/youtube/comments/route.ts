import { NextResponse } from "next/server";
import { guard } from "@/lib/auth/guard";
import { fetchYouTubeComments } from "@/lib/youtube/public";

export const dynamic = "force-dynamic";

/** GET /api/channels/youtube/comments?videoId= → public top-level comment threads. */
export async function GET(req: Request) {
  const denied = await guard("analytics.view");
  if (denied) return denied;

  const videoId = new URL(req.url).searchParams.get("videoId")?.trim() ?? "";
  // Video ids are 11 url-safe chars; rejecting anything else keeps a crafted
  // query from being forwarded to Google verbatim.
  if (!/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ ok: false, error: "videoId is required." }, { status: 400 });
  }

  const result = await fetchYouTubeComments(videoId, 50);
  if (!result.ok) return NextResponse.json({ ok: false, code: result.code, error: result.error });
  return NextResponse.json({ ok: true, videoId, threads: result.threads });
}
