import { NextResponse } from "next/server";
import { readPost, respond } from "@/lib/osf/form-post";
import { db } from "@/lib/osf/supabase";
import { guard } from "@/lib/auth/guard";
import { errorRef } from "@/lib/auth/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Template CRUD.
 *
 * A row here is the local draft and mirror of a Meta template. Its `status`
 * follows Meta's review: only a human flips it to `approved`, after Meta
 * actually approves it in Business Manager — the app never invents approval,
 * because sending an unapproved name gets the number flagged.
 */
export async function POST(request: Request) {
  const denied = await guard("marketing.publish");
  if (denied) return denied;
  const body = await readPost(request);

  const action = body.get("action") ?? "create";
  const supabase = db();

  if (action === "set_status") {
    const id = body.get("id");
    const status = body.get("status");
    const allowed = ["draft", "pending", "approved", "rejected", "paused", "disabled"];
    if (!id || !status || !allowed.includes(status)) {
      return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "id and a valid status are required" });
    }
    const { error } = await supabase
      .from("villa_templates")
      .update({ status, ...(body.get("meta_id") ? { meta_id: body.get("meta_id") } : {}) })
      .eq("id", id);
    if (error) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: `That did not work. Reference ${errorRef(error, "osf:marketing")}` });
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: true });
  }

  if (action === "delete") {
    const id = body.get("id");
    if (!id) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "id required" });
    const { error } = await supabase.from("villa_templates").delete().eq("id", id);
    if (error) {
      // A template a broadcast references is restrict'd — surface that plainly.
      return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "This template is used by a broadcast and cannot be deleted." });
    }
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: true });
  }

  const name = body.get("name");
  const templateBody = body.get("body");
  if (!name || !templateBody) {
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "name and body are required" });
  }
  if (!/^[a-z0-9_]+$/.test(name)) {
    return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: "Template names must be lowercase letters, digits and underscores — Meta's rule." });
  }

  // {{1}}, {{2}}… count defines how many variables a broadcast must supply.
  const variables = new Set(templateBody.match(/\{\{(\d+)\}\}/g) ?? []).size;

  const { error } = await supabase.from("villa_templates").upsert(
    {
      name,
      language: body.get("language") ?? "en",
      category: body.get("category") ?? "marketing",
      body: templateBody,
      footer: body.get("footer") ?? null,
      header_kind: body.get("header_kind") ?? "none",
      header_text: body.get("header_text") ?? null,
      variables,
    },
    { onConflict: "name,language" },
  );
  if (error) return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: false, error: `That did not work. Reference ${errorRef(error, "osf:marketing")}` });

  return respond(request, body, "/inbox/whatsapp/marketing/broadcasts", { ok: true, variables });
}
