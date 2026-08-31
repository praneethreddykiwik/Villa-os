import type { Brand, ChannelId, PostFormat } from "../types";
import { complete, extractJson, hasLLM } from "./provider";
import { adapterFor } from "../platforms/registry";

/**
 * Caption + hashtag generation, per network.
 *
 * The important bit is the *per-network rewrite*: the same idea posted verbatim
 * to Instagram, LinkedIn and X performs badly on at least two of them. So we
 * generate one master idea and then constrain each variant to that network's
 * limits, tone and hashtag conventions, which come from the adapter capabilities
 * rather than being hardcoded here.
 */

export interface CopyRequest {
  brand: Brand;
  topic: string;
  format: PostFormat;
  channels: ChannelId[];
  /** e.g. "book a stay", "visit today", "comment WEEKEND". */
  cta?: string;
  tone?: "warm" | "punchy" | "luxury" | "playful" | "informative";
}

export interface CopyVariant {
  channel: ChannelId;
  caption: string;
  hashtags: string[];
  firstComment?: string;
  hook: string;
  /** Length check against the adapter's real limit. */
  withinLimit: boolean;
}

const TONE_HINTS: Record<string, string> = {
  warm: "Warm and personal. Speak to one reader, not an audience.",
  punchy: "Short sentences. Front-load the payoff. No throat-clearing.",
  luxury: "Restrained and sensory. Confidence, never hype. No exclamation marks.",
  playful: "Light, a little cheeky, never try-hard.",
  informative: "Concrete and useful. Lead with the fact, not the feeling.",
};

const CHANNEL_STYLE: Partial<Record<ChannelId, string>> = {
  instagram: "Conversational. Line breaks between thoughts. Hashtags go in the first comment, not the caption.",
  facebook: "Slightly longer, more context. Hashtags are near-useless here — use at most two.",
  linkedin: "Professional but human. Lead with an insight or a number. No emoji walls, no hashtag spam.",
  x: "One tight thought under 280 characters including the link. At most two hashtags.",
  tiktok: "Native and casual. The caption exists to set up the video, not to replace it.",
  youtube: "Searchable: put the actual subject in the first line, because it is a search engine.",
  google_business: "Factual and local. Name the place, the offer and the action. No hashtags at all.",
};

export async function generateCopy(req: CopyRequest): Promise<CopyVariant[]> {
  const llm = hasLLM() ? await llmCopy(req) : null;
  if (llm?.length) return llm.map((v) => withLimitCheck(v));
  return req.channels.map((channel) => withLimitCheck(templateCopy(req, channel)));
}

function withLimitCheck(v: CopyVariant): CopyVariant {
  const caps = adapterFor(v.channel)?.capabilities;
  const len = [v.caption, v.hashtags.map((h) => `#${h}`).join(" ")].join(" ").length;
  return { ...v, withinLimit: !caps || len <= caps.captionLimit };
}

async function llmCopy(req: CopyRequest): Promise<CopyVariant[] | null> {
  const constraints = req.channels
    .map((c) => {
      const caps = adapterFor(c)?.capabilities;
      return `- ${c}: max ${caps?.captionLimit ?? 2200} chars, max ${caps?.hashtagLimit ?? 10} hashtags. ${CHANNEL_STYLE[c] ?? ""}`;
    })
    .join("\n");

  const text = await complete({
    system:
      "You are a senior social copywriter. You write copy that sounds like a person, not a brand deck. " +
      "You never use the words 'elevate', 'unlock', 'dive in', 'game-changer', or 'in today's world'. " +
      "You return only JSON.",
    prompt: `Brand: ${req.brand.name} (${req.brand.industry})
Voice: ${req.brand.voice}
Audience: ${req.brand.audience}
Offerings: ${req.brand.offerings.join(", ")}
Post topic: ${req.topic}
Format: ${req.format}
Call to action: ${req.cta ?? "soft — invite, do not demand"}
Tone: ${TONE_HINTS[req.tone ?? "warm"]}

Write one variant per channel:
${constraints}

Return a JSON array. Each item: {"channel": string, "hook": "the first line, must earn the second", "caption": string, "hashtags": string[] (no # prefix), "firstComment": string or null}`,
    maxTokens: 2000,
    temperature: 0.85,
  });
  return extractJson<CopyVariant[]>(text);
}

/**
 * Deterministic fallback. Not a placeholder — it composes a real, postable
 * caption from the brand brief using the same per-channel rules the LLM is given.
 */
function templateCopy(req: CopyRequest, channel: ChannelId): CopyVariant {
  const caps = adapterFor(channel)?.capabilities;
  const offering = req.brand.offerings[0] ?? req.brand.name;
  const hooks: Record<string, string> = {
    reel: `The part of ${req.topic} nobody films.`,
    story: `Today at ${req.brand.name} →`,
    feed: `${req.topic}.`,
    carousel: `${req.topic} — the short version.`,
    short: `${req.topic} in 30 seconds.`,
    text: `${req.topic}.`,
  };
  const hook = hooks[req.format] ?? `${req.topic}.`;
  const cta = req.cta ?? `Ask us about ${offering.toLowerCase()}`;

  const body =
    channel === "linkedin"
      ? `${hook}\n\nWe get asked about ${offering.toLowerCase()} more than anything else. Here is what actually matters to ${req.brand.audience.toLowerCase()}, and what we changed because of it.\n\n${cta}.`
      : channel === "x"
        ? `${hook} ${cta}.`
        : channel === "google_business"
          ? `${hook} ${req.brand.name} — ${offering}. ${cta}.`
          : `${hook}\n\n${req.brand.voice.split(".")[0]}.\n\n${cta} 👇`;

  const pool = [
    req.brand.industry.toLowerCase().replace(/\s+/g, ""),
    ...req.brand.offerings.slice(0, 3).map((o) => o.toLowerCase().replace(/[^a-z0-9]/g, "")),
    req.topic.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 20),
  ].filter(Boolean);

  const limit = Math.min(caps?.hashtagLimit ?? 10, channel === "instagram" ? 12 : channel === "facebook" ? 2 : 5);
  const hashtags = pool.slice(0, limit);

  return {
    channel,
    hook,
    caption: body.slice(0, caps?.captionLimit ?? 2200),
    hashtags: caps?.hashtagLimit === 0 ? [] : hashtags,
    firstComment: channel === "instagram" ? hashtags.map((h) => `#${h}`).join(" ") : undefined,
    withinLimit: true,
  };
}

/** Rewrite the opening seconds of an underperforming video. */
export async function generateHooks(brand: Brand, topic: string, weakHook: string): Promise<string[]> {
  const text = await complete({
    system: "You write video hooks. A hook is one spoken line under 8 words that makes stopping cheaper than scrolling. Return only a JSON array of strings.",
    prompt: `Brand: ${brand.name} (${brand.industry}). Audience: ${brand.audience}.
Video subject: ${topic}
Current opening line (underperforming): "${weakHook}"
Write 5 replacement hooks. Vary the mechanism: curiosity gap, direct benefit, contradiction, question, number.`,
    temperature: 0.95,
  });
  const parsed = extractJson<string[]>(text);
  if (parsed?.length) return parsed;
  return [
    `Nobody tells you this about ${topic}.`,
    `We got ${topic} wrong for two years.`,
    `Three things ${brand.audience.toLowerCase()} always ask.`,
    `This is what ${topic} actually costs.`,
    `Stop scrolling if you care about ${topic}.`,
  ];
}
