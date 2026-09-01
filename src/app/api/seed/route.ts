import { NextResponse } from "next/server";
import { resetToSeed } from "@/lib/db";
import { guard } from "@/lib/auth/guard";

/**
 * Destroys and regenerates the local demo dataset.
 *
 * Previously this was an unauthenticated POST that wiped every record —
 * anyone who found the URL could destroy the workspace. It now requires the
 * highest-privilege permission AND refuses to run in production at all, because
 * there is no legitimate reason to reset a live business database over HTTP.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DESTRUCTIVE_RESET !== "true") {
    return NextResponse.json(
      { ok: false, error: "Destructive reset is disabled in production." },
      { status: 403 },
    );
  }
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  const db = resetToSeed();
  return NextResponse.json({ ok: true, brands: db.brands.length, posts: db.posts.length });
}
