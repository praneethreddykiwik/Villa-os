import { NextResponse } from "next/server";
import { runTick } from "@/lib/engine/publisher";
import { requireWorkerSecret } from "@/lib/auth/session";
import { apiError } from "@/lib/auth/http";

/**
 * The publish tick. Point a cron at this (every 5 minutes is plenty) or hit the
 * "Run queue now" button in the calendar. Protected by a shared secret so a
 * public deployment cannot have its queue driven by strangers.
 */
export async function POST(req: Request) {
  // requireWorkerSecret throws 503 when WORKER_SECRET is unset and compares in
  // constant time. The previous inline check skipped verification entirely when
  // the variable was missing, so forgetting one env var left the publish queue
  // open to anonymous callers.
  try {
    await requireWorkerSecret(req);
  } catch (e) {
    return apiError(e);
  }
  const result = await runTick();
  return NextResponse.json({ ok: true, ...result });
}

export const GET = POST;
