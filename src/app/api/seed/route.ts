import { NextResponse } from "next/server";
import { resetToBootstrap } from "@/lib/db";
import { guard } from "@/lib/auth/guard";

/**
 * Clears every business record, returning the store to the tenant shell.
 *
 * Previously this was an unauthenticated POST that wiped every record —
 * anyone who found the URL could destroy the workspace. It now requires the
 * highest-privilege permission AND refuses to run in production at all, because
 * there is no legitimate reason to reset a live business database over HTTP.
 */
export async function POST() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json(
      { ok: false, error: "Destructive reset is disabled in production." },
      { status: 403 },
    );
  }
  const denied = await guard("workflows.manage");
  if (denied) return denied;

  const db = resetToBootstrap();
  return NextResponse.json({ ok: true, brands: db.brands.length, posts: db.posts.length });
}
