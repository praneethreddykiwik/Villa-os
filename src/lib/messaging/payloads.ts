/**
 * MESSAGE WIRE FORMAT
 *
 * Everything travels in one `body` text column, tagged by prefix:
 *
 *   [IMAGE_MSG]:{json}     photo, optional caption
 *   [VOICE_NOTE]:{json}    voice note with duration
 *   [MSG_PAYLOAD]:{json}   text carrying a reply and/or reactions
 *   plain text             a bare message with neither
 *
 * A plain message stays plain on the wire, so the common case costs nothing and
 * older rows keep rendering.
 *
 * Two deliberate changes from the reference implementation:
 *
 *  1. `media` holds a Storage object path, not a base64 data URL. Inline base64
 *     inflates the row ~35% over the raw file and exceeds the Realtime payload
 *     ceiling, so a photo would save but never broadcast to the other person.
 *     The parser still reads legacy `data:` URLs, so old rows are unaffected.
 *  2. Reactions are keyed by profile id rather than display name. Names are not
 *     unique and change; ids do not.
 */

export interface QuotedReply {
  id: string;
  senderName: string;
  snippet: string;
  isMedia?: boolean;
}

/** emoji → profile ids who reacted */
export type Reactions = Record<string, string[]>;

export interface MediaPayload {
  kind: "image" | "voice";
  /** Storage object path, or a legacy `data:` URL. */
  media: string;
  caption?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  replyTo?: QuotedReply;
  reactions?: Reactions;
}

export interface TextPayload {
  text: string;
  replyTo?: QuotedReply;
  reactions?: Reactions;
}

export type ParsedMessage =
  | ({ type: "text" } & TextPayload)
  | ({ type: "image" | "voice" } & MediaPayload);

const IMAGE = "[IMAGE_MSG]:";
const VOICE = "[VOICE_NOTE]:";
const STRUCTURED = "[MSG_PAYLOAD]:";

function safeParse<T>(json: string): T | null {
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/** Single entry point. Never throws — a malformed body degrades to plain text. */
export function parseMessage(body: string | null | undefined): ParsedMessage {
  const target = (body ?? "").trim();
  if (!target) return { type: "text", text: "" };

  if (target.startsWith(IMAGE)) {
    const p = safeParse<MediaPayload>(target.slice(IMAGE.length));
    if (p?.media) return { type: "image", ...p, kind: "image" };
    return { type: "text", text: target };
  }

  if (target.startsWith(VOICE)) {
    const p = safeParse<MediaPayload>(target.slice(VOICE.length));
    if (p?.media) return { type: "voice", ...p, kind: "voice" };
    return { type: "text", text: target };
  }

  if (target.startsWith(STRUCTURED)) {
    const p = safeParse<TextPayload>(target.slice(STRUCTURED.length));
    if (!p) return { type: "text", text: target };
    // A structured wrapper can itself contain a media message — the reference
    // produced these when reacting to a photo.
    if (typeof p.text === "string" && (p.text.startsWith(IMAGE) || p.text.startsWith(VOICE))) {
      const inner = parseMessage(p.text);
      if (inner.type !== "text") {
        return { ...inner, reactions: inner.reactions ?? p.reactions, replyTo: inner.replyTo ?? p.replyTo };
      }
    }
    return { type: "text", text: p.text ?? "", replyTo: p.replyTo, reactions: p.reactions };
  }

  return { type: "text", text: target };
}

export function formatText(text: string, replyTo?: QuotedReply, reactions?: Reactions): string {
  const hasExtras = Boolean(replyTo) || Boolean(reactions && Object.keys(reactions).length);
  if (!hasExtras) return text.trim();
  const payload: TextPayload = { text: text.trim(), replyTo, reactions };
  return `${STRUCTURED}${JSON.stringify(payload)}`;
}

export function formatMedia(p: MediaPayload): string {
  const prefix = p.kind === "image" ? IMAGE : VOICE;
  return `${prefix}${JSON.stringify(p)}`;
}

/** One-line preview for the sidebar, notifications and quoted replies. */
export function summarise(body: string | null | undefined, senderName?: string): string {
  const parsed = parseMessage(body);
  if (parsed.type === "image") return parsed.caption ? `📷 ${parsed.caption}` : `📷 Photo${senderName ? ` from ${senderName}` : ""}`;
  if (parsed.type === "voice") {
    const d = parsed.durationSec ? ` (${Math.round(parsed.durationSec)}s)` : "";
    return `🎤 Voice note${d}`;
  }
  const text = parsed.type === "text" ? parsed.text.trim() : "";
  if (!text) return "No messages yet";
  // Defensive: never leak a raw data URL into a preview if one slipped through.
  if (text.includes("data:image/")) return "📷 Photo";
  if (text.includes("data:audio/")) return "🎤 Voice note";
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

/** Build the quoted-reply stub stored alongside a reply. */
export function quoteOf(message: { id: string; body: string }, senderName: string): QuotedReply {
  const parsed = parseMessage(message.body);
  return {
    id: message.id,
    senderName,
    snippet: summarise(message.body),
    isMedia: parsed.type !== "text",
  };
}

export function isLegacyDataUrl(media: string): boolean {
  return media.startsWith("data:");
}
