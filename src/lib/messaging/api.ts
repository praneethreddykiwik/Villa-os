import type { SupabaseClient } from "@supabase/supabase-js";
import type { Message, MessageProfile, RecipientType } from "./types";

/**
 * Messaging data access.
 *
 * Everything here runs through the *anon* client carrying the user's session, so
 * RLS is the security boundary. Nothing in this file uses the service role — if
 * a query needs it, that is a missing policy, not a reason to escalate.
 */

const MEDIA_BUCKET = "message-media";
export const PAGE_SIZE = 50;

interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string;
  departments?: { key: string } | { key: string }[] | null;
}

function toProfile(r: ProfileRow): MessageProfile {
  const dept = Array.isArray(r.departments) ? r.departments[0] : r.departments;
  return {
    id: r.id,
    fullName: r.full_name?.trim() || r.email.split("@")[0],
    email: r.email,
    department: dept?.key ?? null,
  };
}

export async function fetchProfiles(sb: SupabaseClient): Promise<MessageProfile[]> {
  const { data, error } = await sb
    .from("profiles")
    .select("id, full_name, email, departments(key)")
    .eq("active", true)
    .order("full_name");
  if (error) throw error;
  return (data as ProfileRow[]).map(toProfile);
}

interface MessageRow {
  id: string;
  org_id: string;
  sender_id: string;
  recipient_type: RecipientType;
  recipient_id: string | null;
  body: string;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export function toMessage(r: MessageRow, byId: Map<string, MessageProfile>): Message {
  return {
    id: r.id,
    orgId: r.org_id,
    senderId: r.sender_id,
    recipientType: r.recipient_type,
    recipientId: r.recipient_id,
    body: r.body,
    createdAt: r.created_at,
    editedAt: r.edited_at,
    deletedAt: r.deleted_at,
    sender: byId.get(r.sender_id),
    recipient: r.recipient_id ? byId.get(r.recipient_id) : undefined,
  };
}

/**
 * Newest-first from the database, reversed to chronological for rendering.
 * Paginating on `created_at` rather than an offset keeps the window stable while
 * new messages arrive underneath.
 */
export async function fetchMessages(
  sb: SupabaseClient,
  profiles: Map<string, MessageProfile>,
  opts: { limit?: number; beforeCreatedAt?: string } = {},
): Promise<{ messages: Message[]; hasMore: boolean }> {
  const limit = opts.limit ?? PAGE_SIZE;
  let q = sb
    .from("messages")
    .select("id, org_id, sender_id, recipient_type, recipient_id, body, created_at, edited_at, deleted_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(limit + 1);
  if (opts.beforeCreatedAt) q = q.lt("created_at", opts.beforeCreatedAt);

  const { data, error } = await q;
  if (error) throw error;

  const rows = data as MessageRow[];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { messages: page.reverse().map((r) => toMessage(r, profiles)), hasMore };
}

/** Which of these message ids the current user has already read. */
export async function fetchReadIds(sb: SupabaseClient, profileId: string, messageIds: string[]): Promise<Set<string>> {
  if (!messageIds.length) return new Set();
  const { data, error } = await sb
    .from("message_reads")
    .select("message_id")
    .eq("profile_id", profileId)
    .in("message_id", messageIds);
  if (error) throw error;
  return new Set((data as { message_id: string }[]).map((r) => r.message_id));
}

export async function markRead(sb: SupabaseClient, profileId: string, messageIds: string[]): Promise<void> {
  if (!messageIds.length) return;
  // Upsert so a re-read is a no-op rather than a duplicate-key error.
  const { error } = await sb
    .from("message_reads")
    .upsert(messageIds.map((message_id) => ({ message_id, profile_id: profileId })), {
      onConflict: "message_id,profile_id",
      ignoreDuplicates: true,
    });
  if (error) throw error;
}

export async function sendMessage(
  sb: SupabaseClient,
  input: { orgId: string; senderId: string; recipientType: RecipientType; recipientId: string | null; body: string },
): Promise<Message> {
  const { data, error } = await sb
    .from("messages")
    .insert({
      org_id: input.orgId,
      sender_id: input.senderId,
      recipient_type: input.recipientType,
      // The CHECK constraint requires this to be null for a broadcast.
      recipient_id: input.recipientType === "everyone" ? null : input.recipientId,
      body: input.body,
    })
    .select("id, org_id, sender_id, recipient_type, recipient_id, body, created_at, edited_at, deleted_at")
    .single();
  if (error) throw error;
  return toMessage(data as MessageRow, new Map());
}

/**
 * Toggling a reaction rewrites someone else's row, so it goes through the
 * definer function rather than a broad UPDATE policy.
 */
export async function toggleReaction(sb: SupabaseClient, messageId: string, emoji: string): Promise<void> {
  const { error } = await sb.rpc("toggle_message_reaction", { p_message_id: messageId, p_emoji: emoji });
  if (error) throw error;
}

export async function editMessage(sb: SupabaseClient, messageId: string, body: string): Promise<void> {
  const { error } = await sb.from("messages").update({ body, edited_at: new Date().toISOString() }).eq("id", messageId);
  if (error) throw error;
}

/** Soft delete, so a reply that quotes it still renders. */
export async function deleteMessage(sb: SupabaseClient, messageId: string): Promise<void> {
  const { error } = await sb.from("messages").update({ deleted_at: new Date().toISOString() }).eq("id", messageId);
  if (error) throw error;
}

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export async function uploadMedia(sb: SupabaseClient, orgId: string, file: Blob, filename: string): Promise<string> {
  if (file.size > MAX_MEDIA_BYTES) throw new Error("File is larger than 15MB");
  const ext = (filename.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  const path = `${orgId}/${crypto.randomUUID()}.${ext || "bin"}`;
  const { error } = await sb.storage.from(MEDIA_BUCKET).upload(path, file, {
    contentType: file.type || "application/octet-stream",
    upsert: false,
  });
  if (error) throw error;
  return path;
}

/** Short-lived signed URL. The bucket is private; nothing is ever public. */
export async function mediaUrl(sb: SupabaseClient, path: string): Promise<string | null> {
  if (path.startsWith("data:")) return path; // legacy inline payload
  const { data, error } = await sb.storage.from(MEDIA_BUCKET).createSignedUrl(path, 300);
  if (error) return null;
  return data.signedUrl;
}
