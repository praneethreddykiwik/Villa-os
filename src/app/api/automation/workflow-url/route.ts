import { NextResponse } from "next/server";
import { read, mutate } from "@/lib/db";
import { AuthError, requirePermission } from "@/lib/auth/session";
import { checkWebhookUrl } from "@/lib/events/bus";

export const dynamic = "force-dynamic";

/**
 * GET /api/automation/workflow-url — returns the currently active workflow URL
 *
 * This reads a capability, not a setting. The workflow URL carries its own
 * embedded token, so anyone holding it can post into the publishing pipeline
 * without ever authenticating to this app. It therefore needs a permission of
 * its own — being signed in is not enough, or every account in the building
 * could copy it out.
 *
 * `marketing.read` rather than `marketing.publish`: the studio screens display
 * the configured URL to explain where posts go, and those are read-only surfaces.
 * Changing it still requires `marketing.publish` on POST below.
 */
export async function GET() {
  try {
    await requirePermission("marketing.read");
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Not allowed." },
      { status: e instanceof AuthError ? e.status : 403 },
    );
  }
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
