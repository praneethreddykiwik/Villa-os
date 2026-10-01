import { NextResponse } from "next/server";
import { readPost, respond } from "@/lib/osf/form-post";
import { db } from "@/lib/osf/supabase";
import { prepareBroadcast, sendBroadcastBatch, resolveAudience, type AudienceFilter } from "@/lib/osf/broadcasts";
import { guard } from "@/lib/auth/guard";
import { errorRef } from "@/lib/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Serverless-safe send budget: leave headroom under a typical 60s limit. */
const SEND_DEADLINE_MS = 40_000;

function parseAudience(raw: string | undefined): AudienceFilter {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as AudienceFilter;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;
  const body = await readPost(request);
  const action = body.get("action") ?? "create";
  const supabase = db();

  if (action === "preview_audience") {
    const leads = await resolveAudience(parseAudience(body.get("audience")));
    return NextResponse.json({ count: leads.length });
  }

  if (action === "send" || action === "resume") {
    const id = body.get("id");
    if (!id) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "id required" });

    if (action === "send") await prepareBroadcast(id);

    // Send batches until done or the request runs out of road. A cron picks up
    // whatever is left, so a huge audience just takes more invocations.
    const deadline = Date.now() + SEND_DEADLINE_MS;
    let last = await sendBroadcastBatch(id);
    while (!last.done && last.remaining > 0 && Date.now() < deadline) {
      last = await sendBroadcastBatch(id);
    }

    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: true, ...last });
  }

  if (action === "pause" || action === "cancel") {
    const id = body.get("id");
    if (!id) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "id required" });
    const { error } = await supabase
      .from("villa_broadcasts")
      .update({ status: action === "pause" ? "paused" : "cancelled" })
      .eq("id", id);
    if (error) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: `That did not work. Reference ${errorRef(error, "osf:marketing")}` });
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: true });
  }

  // create
  const name = body.get("name");
  const templateId = body.get("template_id");
  if (!name || !templateId) {
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "name and template_id are required" });
  }

  const { data: template } = await supabase
    .from("villa_templates")
    .select("id, status, variables")
    .eq("id", templateId)
    .maybeSingle();
  if (!template) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "template not found" });
  if (template.status !== "approved") {
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "That template is not approved yet. Meta rejects sends of unapproved templates." });
  }

  let variables: string[] = [];
  const rawVars = body.get("variables");
  if (rawVars) {
    try {
      const parsed = JSON.parse(rawVars);
      if (Array.isArray(parsed)) variables = parsed.map(String);
    } catch {
      // Comma-separated fallback for the plain form path.
      variables = rawVars.split(",").map((v) => v.trim());
    }
  }
  if (variables.length !== (template.variables ?? 0)) {
    return NextResponse.json(
      {
        error: `This template needs exactly ${template.variables} variable(s), got ${variables.length}.`,
      },
      { status: 400 },
    );
  }

  const scheduledFor = body.get("scheduled_for");
  const { data, error } = await supabase
    .from("villa_broadcasts")
    .insert({
      name,
      template_id: templateId,
      audience: parseAudience(body.get("audience")),
      variables,
      ...(scheduledFor ? { scheduled_for: scheduledFor, status: "scheduled" } : {}),
    })
    .select("id")
    .single();
  if (error) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: `That did not work. Reference ${errorRef(error, "osf:marketing")}` });

  return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: true, id: data.id });
}
