import { NextResponse } from "next/server";
import { resetToSeed } from "@/lib/db";

/** Reset the demo database. Handy when showing the product to a new client. */
export async function POST() {
  const db = resetToSeed();
  return NextResponse.json({ ok: true, brands: db.brands.length, posts: db.posts.length });
}
