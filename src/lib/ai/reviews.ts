import type { Brand, Review } from "../types";
import { complete } from "./provider";

/**
 * Review reply drafting.
 *
 * Rules encoded here matter more than the model: never argue in public, never
 * repeat the complaint back verbatim (it gets indexed), always name one specific
 * detail from the review so it cannot read as a template, and move anything
 * unresolved to a private channel.
 */

const SYSTEM = `You write review replies for local businesses. Hard rules:
- 2 to 4 sentences. Never longer.
- Mention one specific detail from the review so it cannot read as a template.
- Never repeat the complaint wording back — that text gets indexed against the business.
- Never argue, never blame the customer, never offer compensation publicly.
- For 3 stars or below, apologise once, state what changes, and move it off the public thread.
- No "we value your feedback", no "we strive to", no corporate filler.
- Sign off with the business name only if it reads naturally.`;

export async function draftReply(brand: Brand, review: Review): Promise<string> {
  const text = await complete({
    system: SYSTEM,
    prompt: `Business: ${brand.name} — ${brand.industry}
Brand voice: ${brand.voice}
Reviewer: ${review.author}
Rating: ${review.rating}/5
Review: "${review.text}"
Detected themes: ${review.topics.join(", ") || "none"}

Write the reply only. No preamble.`,
    maxTokens: 400,
    temperature: 0.7,
  });
  return text?.trim() ?? fallbackReply(brand, review);
}

/**
 * Deterministic fallback. Built from the review's own detected topics so it is
 * still specific — the single thing that separates a usable reply from spam.
 */
export function fallbackReply(brand: Brand, review: Review): string {
  const detail = review.topics[0];
  const name = review.author.split(" ")[0];

  if (review.rating >= 4) {
    return (
      `Thank you, ${name} — this genuinely made our week. ` +
      (detail ? `Glad the ${detail} landed the way we hoped it would. ` : "") +
      `We'll pass this on to the team. See you again soon at ${brand.name}.`
    );
  }
  if (review.rating === 3) {
    return (
      `Thanks for being straight with us, ${name}. ` +
      (detail ? `You're right that the ${detail} should have been better, and we're already on it. ` : "We should have done better, and we're on it. ") +
      `If you're open to it, drop us a line directly — we'd like to make the next visit the one you expected.`
    );
  }
  return (
    `${name}, I'm sorry — this isn't the standard we hold ourselves to. ` +
    (detail ? `We've taken the ${detail} issue to the team this week. ` : "We've taken this to the team this week. ") +
    `Please contact us directly so we can put it right properly rather than in a review thread. — ${brand.name}`
  );
}

/** Lightweight lexicon sentiment + topic tagging, used when ingesting reviews. */
const NEGATIVE = ["dirty", "rude", "slow", "wait", "cold", "expensive", "broken", "noisy", "disappointed", "never", "worst", "poor"];
const POSITIVE = ["amazing", "perfect", "lovely", "great", "helpful", "beautiful", "excellent", "friendly", "stunning", "best", "incredible", "fantastic"];

const TOPIC_LEXICON: Record<string, string[]> = {
  "check-in": ["check in", "check-in", "reception", "front desk", "arrival"],
  cleanliness: ["clean", "dirty", "spotless", "dust", "housekeeping"],
  staff: ["staff", "team", "host", "owner", "service", "manager"],
  value: ["price", "expensive", "value", "worth", "cheap", "overpriced"],
  location: ["location", "view", "beach", "walk", "central", "quiet"],
  food: ["breakfast", "food", "dinner", "restaurant", "coffee", "menu"],
  amenities: ["pool", "wifi", "spa", "gym", "parking", "aircon", "air con"],
  noise: ["noise", "noisy", "loud", "quiet"],
  booking: ["booking", "reservation", "cancel", "refund"],
};

export function analyseReview(text: string, rating: number): { sentiment: Review["sentiment"]; topics: string[] } {
  const lower = text.toLowerCase();
  const neg = NEGATIVE.filter((w) => lower.includes(w)).length;
  const pos = POSITIVE.filter((w) => lower.includes(w)).length;
  // Rating dominates; the lexicon only breaks ties on 3★.
  const sentiment: Review["sentiment"] =
    rating >= 4 ? "positive" : rating <= 2 ? "negative" : pos > neg ? "positive" : neg > pos ? "negative" : "neutral";
  const topics = Object.entries(TOPIC_LEXICON)
    .filter(([, words]) => words.some((w) => lower.includes(w)))
    .map(([topic]) => topic);
  return { sentiment, topics };
}
