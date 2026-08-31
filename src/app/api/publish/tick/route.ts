import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine/publisher";

/**
 * The publish tick. Point a cron at this (every 5 minutes is plenty) or hit the
 * "Run queue now" button in the calendar. Protected by a shared secret so a
 * public deployment cannot have its queue driven by strangers.
 */
export async function POST(req: Request) {
  const secret = req.headers.get("x-worker-secret") ?? new URL(req.url).searchParams.get("secret");
  if (process.env.WORKER_SECRET && secret !== process.env.WORKER_SECRET) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const result = await runTick();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = POST;
