import { NextResponse } from "next/server";
import { read, mutate } from "@/lib/db";
import { requirePermission } from "@/lib/auth/session";
import { checkWebhookUrl } from "@/lib/events/bus";

export const dynamic = "force-dynamic";

/** GET /api/automation/workflow-url — returns the currently active workflow URL */
export async function GET() {
  const db = read() as unknown as Record<string, unknown>;
  const url = (db.workflowFormUrl as string) || process.env.N8N_VIDEO_FORM_URL || "";
  return NextResponse.json({ ok: true, url });
}

/** POST /api/automation/workflow-url — updates the active workflow URL */
export async function POST(req: Request) {
  try {
    await requirePermission("marketing.publish");
    const body = (await req.json()) as { url?: string };
    const url = body.url?.trim() ?? "";

    if (url) {
      const problem = checkWebhookUrl(url);
      if (problem) {
        return NextResponse.json({ ok: false, error: `Invalid URL: ${problem}` }, { status: 400 });
      }
    }

    mutate((db) => {
      (db as unknown as Record<string, unknown>).workflowFormUrl = url;
    });

    return NextResponse.json({ ok: true, url });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "An internal error occurred." },
      { status: 500 },
    );
  }
}
