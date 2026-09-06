import fs from "node:fs";
import path from "node:path";
import { mutate, read } from "../db";
import { uid } from "../ids";
import type { KbEntry, KbGap, KbTopic } from "./types";

/**
 * WHATSAPP KNOWLEDGE BASE
 *
 * A structured FAQ store the assistant answers from. No embeddings: retrieval
 * is keyword hits plus token overlap, which is transparent (an admin can see
 * exactly why an entry matched) and free. Three sources, in priority order:
 *
 *   admin       — rows edited on /settings; never touched by seeding
 *   docs        — parsed from docs/glentree-facts.md on first use per process
 *   placeholder — a minimal honest set used only while no facts file exists
 *
 * Every question the assistant could not answer is logged as a gap, so the
 * admin sees what to add rather than guessing from transcripts.
 */

export const KB_TOPICS: KbTopic[] = ["pricing", "availability", "location", "amenities", "approvals", "payment", "visit", "contact", "documents", "general"];

/** Set to "" to disable file seeding (tests); otherwise a path to a markdown facts file. */
function factsPath(): string | null {
  const env = process.env.KB_FACTS_PATH;
  if (env !== undefined) return env.trim() ? path.resolve(env) : null;
  return path.join(process.cwd(), "docs", "glentree-facts.md");
}

/* -------------------------------------------------------------------------- */
/* Tokenising                                                                  */
/* -------------------------------------------------------------------------- */

const STOP = new Set([
  "the", "a", "an", "is", "are", "of", "to", "in", "on", "for", "and", "or", "it", "this", "that", "what", "which", "how", "do", "does",
  "you", "your", "i", "me", "my", "we", "can", "could", "would", "any", "there", "with", "about", "from", "at", "be", "have", "has",
  "please", "pls", "tell", "know", "want", "like", "also", "so", "if", "hi", "hello", "hey", "kya", "hai", "hain", "ka", "ki", "ke", "ko",
  "se", "mein", "main", "aap", "ap", "ji", "bhai", "ye", "yeh", "wo", "woh", "toh", "bhi", "aur", "ha", "haan",
  "by", "as", "us", "up", "its", "was", "will", "not", "am", "than", "then", "them", "they", "he", "she", "his", "her", "our",
  "who", "were", "been", "being", "get", "got", "just", "very", "some", "more", "most", "much", "many", "all", "one", "yes", "ok",
  "okay", "when", "where", "why", "here", "close", "near", "nearby", "far", "away", "hi", "hello",
]);

/**
 * Common Hindi/Telugu words mapped to the English tokens the entries use, so a
 * question in another script still lands on the right row. Not a translator —
 * just the nouns customers actually ask about.
 */
const CROSS_SCRIPT: Array<[RegExp, string]> = [
  [/स्कूल|స్కూల్|పాఠశాల/, "school"],
  [/अस्पताल|हॉस्पिटल|ఆసుపత్రి|హాస్పిటల్/, "hospital"],
  [/एयरपोर्ट|हवाई ?अड्डा|విమానాశ్రయం|ఎయిర్‌?పోర్ట్/, "airport"],
  [/कीमत|दाम|रेट|ధర|రేటు/, "price"],
  [/लोन|कर्ज|రుణం|లోన్/, "loan"],
  [/ईएमआई|కిస్తీ/, "emi"],
  [/दूर|दूरी|दूरी|దూరం/, "distance"],
  [/कहाँ|कहां|लोकेशन|ఎక్కడ|లొకేషన్/, "location"],
  [/सुविधा|సౌకర్య/, "amenity"],
  [/रेरा|రెరా/, "rera"],
  [/मेट्रो|మెట్రో/, "metro"],
  [/ऑफिस|दफ्तर|ఆఫీస్/, "office"],
  [/दस्तावेज़|दस्तावेज|కాగితాలు|దస్తావేజు/, "document"],
  [/बैंक|బ్యాంక్/, "bank"],
  [/विला|విల్లా/, "villa"],
  [/बीएचके|బీహెచ్‌?కే/, "bhk"],
];

/** Cheap stemming — "schools" ↔ "school", "pricing" ↔ "price". */
function stem(w: string): string {
  return w.replace(/(ing|ies|es|s)$/u, (m) => (m === "ies" ? "y" : "")).replace(/^pric$/, "price");
}

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map(stem);
}

/** Query expansion so "school" also finds "education" and "IT park" finds "office". */
const SYNONYMS: Record<string, string[]> = {
  school: ["education", "college"],
  hospital: ["medical", "clinic", "healthcare"],
  price: ["cost", "rate", "budget", "quote"],
  cost: ["price"],
  emi: ["loan", "payment", "instalment"],
  loan: ["emi", "bank", "finance", "payment"],
  airport: ["commute", "connectivity"],
  office: ["it", "tech", "park", "commute"],
  commute: ["distance", "connectivity", "metro", "highway"],
  amenity: ["facility", "clubhouse", "gym", "pool"],
  facility: ["amenity"],
  bhk: ["configuration", "unit", "size"],
  possession: ["handover", "ready", "completion"],
  rera: ["approval", "registration"],
  approval: ["rera", "approved", "sanction"],
  document: ["kyc", "paperwork", "pan", "aadhaar"],
  visit: ["viewing", "tour"],
};

function expand(ts: string[], raw = ""): string[] {
  const out = new Set(ts);
  for (const [re, en] of CROSS_SCRIPT) if (re.test(raw)) out.add(stem(en));
  for (const t of [...out]) for (const s of SYNONYMS[t] ?? []) out.add(stem(s));
  return [...out];
}

/* -------------------------------------------------------------------------- */
/* Retrieval                                                                   */
/* -------------------------------------------------------------------------- */

export interface Retrieved extends KbEntry { score: number }

/** Lowest score before the topic bonus that counts as a match: one question-token hit (2) or one keyword (3). */
const MIN_SCORE = 2;
/** Entries scoring under this fraction of the best entry are dropped. */
const RELATIVE_FLOOR = 0.5;

/**
 * Top-k entries for a question. Keyword hits weigh most (the admin chose them
 * deliberately), question overlap next, answer overlap least. A topic hint
 * from the intent router nudges ties toward the right section.
 */
export function retrieve(brandId: string, query: string, opts: { topic?: KbTopic; k?: number } = {}): Retrieved[] {
  const q = expand(tokens(query), query);
  if (!q.length) return [];
  const qset = new Set(q);
  const scored: Retrieved[] = [];
  for (const e of read().kbEntries) {
    if (e.brandId !== brandId) continue;
    let score = 0;
    for (const k of e.keywords) if (qset.has(stem(k.toLowerCase()))) score += 3;
    for (const t of new Set(tokens(e.question))) if (qset.has(t)) score += 2;
    for (const t of new Set(tokens(e.answer))) if (qset.has(t)) score += 1;
    // A lone answer-token overlap is noise, not a fact worth quoting; require a keyword/question hit.
    if (score < MIN_SCORE) continue;
    if (opts.topic && e.topic === opts.topic) score += 2;
    scored.push({ ...e, score });
  }
  scored.sort((a, b) => b.score - a.score || a.updatedAt.localeCompare(b.updatedAt));
  // Weak trailing matches ride along with a strong one and get quoted as if equally relevant.
  const floor = (scored[0]?.score ?? 0) * RELATIVE_FLOOR;
  return scored.filter((e) => e.score >= floor).slice(0, opts.k ?? 3);
}

/** The FACTS block for the LLM prompt. Prices are withheld unless the entry is public. */
export function factsBlock(entries: KbEntry[]): string {
  return entries
    .filter((e) => e.topic !== "pricing" || e.public)
    .map((e) => `- ${e.question} ${e.answer}`.replace(/\s+/g, " ").slice(0, 400))
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* Gaps                                                                        */
/* -------------------------------------------------------------------------- */

const GAP_CAP = 500;

/** Record a question nothing answered. Repeats bump the count instead of piling up rows. */
export function logGap(input: { brandId: string; question: string; intent: string; customerId?: string }): KbGap {
  const question = input.question.replace(/\s+/g, " ").trim().slice(0, 200);
  const norm = question.toLowerCase();
  const now = new Date().toISOString();
  return mutate((db) => {
    const existing = db.kbGaps.find((g) => g.brandId === input.brandId && g.question.toLowerCase() === norm);
    if (existing) {
      existing.count += 1;
      existing.lastAskedAt = now;
      return existing;
    }
    const gap: KbGap = { id: uid("gap"), brandId: input.brandId, customerId: input.customerId, question, intent: input.intent, count: 1, createdAt: now, lastAskedAt: now };
    db.kbGaps.push(gap);
    const mine = db.kbGaps.filter((g) => g.brandId === input.brandId);
    if (mine.length > GAP_CAP) {
      const drop = new Set(mine.sort((a, b) => a.lastAskedAt.localeCompare(b.lastAskedAt)).slice(0, mine.length - GAP_CAP).map((g) => g.id));
      db.kbGaps = db.kbGaps.filter((g) => !drop.has(g.id));
    }
    return gap;
  });
}

export function listGaps(brandId: string): KbGap[] {
  return read().kbGaps.filter((g) => g.brandId === brandId).sort((a, b) => b.lastAskedAt.localeCompare(a.lastAskedAt));
}

export function resolveGap(id: string): boolean {
  return mutate((db) => {
    const before = db.kbGaps.length;
    db.kbGaps = db.kbGaps.filter((g) => g.id !== id);
    return db.kbGaps.length !== before;
  });
}

/* -------------------------------------------------------------------------- */
/* CRUD                                                                        */
/* -------------------------------------------------------------------------- */

export function listEntries(brandId: string): KbEntry[] {
  return read().kbEntries.filter((e) => e.brandId === brandId).sort((a, b) => a.topic.localeCompare(b.topic) || a.question.localeCompare(b.question));
}

export interface EntryInput {
  id?: string;
  brandId: string;
  topic?: string;
  question: string;
  answer: string;
  keywords?: string[] | string;
  public?: boolean;
  source?: KbEntry["source"];
}

function asTopic(t: unknown): KbTopic {
  const v = String(t ?? "").toLowerCase() as KbTopic;
  return KB_TOPICS.includes(v) ? v : "general";
}

function asKeywords(k: EntryInput["keywords"], question: string): string[] {
  const raw = Array.isArray(k) ? k : typeof k === "string" ? k.split(/[,\n]/) : [];
  const cleaned = raw.map((s) => s.trim().toLowerCase()).filter(Boolean);
  // Keywords fall back to the question's own tokens so an admin never has to fill them in.
  return [...new Set(cleaned.length ? cleaned : tokens(question))].slice(0, 20);
}

export function upsertEntry(input: EntryInput): KbEntry {
  const question = input.question.trim().slice(0, 300);
  const answer = input.answer.trim().slice(0, 1500);
  if (!question || !answer) throw new Error("question and answer are required");
  const now = new Date().toISOString();
  return mutate((db) => {
    const existing = input.id ? db.kbEntries.find((e) => e.id === input.id && e.brandId === input.brandId) : undefined;
    const entry: KbEntry = {
      id: existing?.id ?? uid("kb"),
      brandId: input.brandId,
      topic: asTopic(input.topic ?? existing?.topic),
      question,
      answer,
      keywords: asKeywords(input.keywords ?? existing?.keywords, question),
      public: input.public ?? existing?.public ?? false,
      source: input.source ?? "admin",
      updatedAt: now,
    };
    if (existing) Object.assign(existing, entry);
    else db.kbEntries.push(entry);
    return entry;
  });
}

export function deleteEntry(brandId: string, id: string): boolean {
  return mutate((db) => {
    const before = db.kbEntries.length;
    db.kbEntries = db.kbEntries.filter((e) => !(e.id === id && e.brandId === brandId));
    return db.kbEntries.length !== before;
  });
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                     */
/* -------------------------------------------------------------------------- */

const TOPIC_HINTS: Array<[RegExp, KbTopic]> = [
  [/\b(pric\w*|cost\w*|rates?|budget|quote)\b/i, "pricing"],
  [/\b(payment\w*|emi|loans?|bank\w*|financ\w*|instal\w*|mortgage)\b/i, "payment"],
  [/\b(approv\w*|rera|hmda|dtcp|bbmp|sanction\w*|clearance|permit|title)\b/i, "approvals"],
  [/\b(document\w*|kyc|paperwork)\b/i, "documents"],
  [/\b(locat\w*|near\w*|schools?|hospitals?|airport|connectiv\w*|commute|distance|metro|address|landmark|drive)\b/i, "location"],
  [/\b(amenit\w*|facilit\w*|club\w*|lifestyle|parks?|gym|pool)\b/i, "amenities"],
  [/\b(avail\w*|config\w*|units?|bhk|floor plans?|possession|sizes?|towers?|inventory|villas?|plots?|layout|delivery)\b/i, "availability"],
  [/\b(visit\w*|viewing|tour)\b/i, "visit"],
  [/\b(contact\w*|team|sales|office|hours?|phone|reach|builder)\b/i, "contact"],
];

export function topicFor(text: string): KbTopic {
  for (const [re, topic] of TOPIC_HINTS) if (re.test(text)) return topic;
  return "general";
}

/** The row's own key decides its topic; the section heading only breaks a tie. */
function topicForRow(key: string, heading: string): KbTopic {
  const own = topicFor(key);
  return own === "general" ? topicFor(heading) : own;
}

const PUBLIC_TAG = /[([]\s*public\s*[)\]]/i;
/** The fact sheet's own uncertainty marker; the customer hears "to be confirmed", never the tag. */
const CONFIRM_TAG = /`?\[CONFIRM[^\]]*\]`?/gi;
/** Brochure page references such as "(Mini p6, Full p6)" carry nothing for a customer. */
const SOURCE_REF = /\((?:[A-Za-z]+ p\d+[^)]*)\)|\b(?:Mini|Full|Pres|Layout) p\d+(?:[–-]\d+)?\b/g;
/** Sections that describe the file rather than the property. */
const SKIP_SECTION = /^(gaps?|source|sources|source key|todo|open questions)\b/i;

function clean(text: string): string {
  return text
    .replace(CONFIRM_TAG, "(to be confirmed by the sales team)")
    .replace(SOURCE_REF, "")
    .replace(/\*+/g, "")
    .replace(/`/g, "")
    .replace(/\s+([,.;)])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cells(line: string): string[] {
  return line.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/**
 * Parse a loosely structured markdown facts file. Understood shapes:
 *   `## Heading`              → topic + section for what follows
 *   markdown tables           → one entry per row (first column is the key,
 *                               a "Source" column is dropped)
 *   `Q: … / A: …` pairs       → one entry each
 *   `- Key: value` bullets    → one entry each (question = key)
 *   other bullets/paragraphs  → one entry per section (question = heading)
 * "(public)" on a heading, row or line marks the entry quotable, prices
 * included. "[CONFIRM …]" tags become "to be confirmed by the sales team".
 * Sections headed Gaps/Source are skipped, as is prose directly under an H1.
 */
export function parseFacts(markdown: string): Array<Omit<EntryInput, "brandId">> {
  const out: Array<Omit<EntryInput, "brandId">> = [];
  let heading = "General";
  let level = 1;
  let headingPublic = false;
  let skipping = false;
  let topic: KbTopic = "general";
  let loose: string[] = [];
  let pendingQ: string | null = null;
  let tableHeader: string[] | null = null;

  const section = () => heading.replace(PUBLIC_TAG, "").trim();
  const flushLoose = () => {
    if (!loose.length) return;
    const answer = clean(loose.join(" "));
    // Prose under the title is the file describing itself, not a fact.
    if (answer && level > 1) out.push({ topic, question: section(), answer, keywords: tokens(heading), public: headingPublic });
    loose = [];
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { tableHeader = null; continue; }
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushLoose();
      level = h[1].length;
      heading = h[2].replace(/^\d+[.)]\s*/, "").replace(SOURCE_REF, "").trim();
      headingPublic = PUBLIC_TAG.test(heading);
      skipping = SKIP_SECTION.test(heading);
      topic = topicFor(heading);
      pendingQ = null;
      tableHeader = null;
      continue;
    }
    if (skipping) continue;

    if (/^\|.*\|$/.test(line)) {
      const row = cells(line);
      if (row.every((c) => /^:?-{2,}:?$/.test(c))) continue; // separator
      if (!tableHeader) { tableHeader = row; continue; }
      const key = clean(row[0]);
      if (!key) continue;
      const parts: string[] = [];
      for (let i = 1; i < row.length; i += 1) {
        const name = tableHeader[i] ?? "";
        if (/^source/i.test(name)) continue;
        const value = clean(row[i] ?? "");
        if (!value) continue;
        parts.push(row.length > 3 && name ? `${name} ${value}` : value);
      }
      if (!parts.length) continue;
      const pub = headingPublic || PUBLIC_TAG.test(line);
      out.push({ topic: topicForRow(key, heading), question: `${key} (${section()})`, answer: `${key}: ${parts.join("; ")}`, keywords: [...tokens(key), ...tokens(heading)], public: pub });
      continue;
    }
    tableHeader = null;

    const q = line.match(/^\*{0,2}Q\s*[:.]\*{0,2}\s*(.+)$/i);
    if (q) { flushLoose(); pendingQ = clean(q[1]); continue; }
    const a = line.match(/^\*{0,2}A\s*[:.]\*{0,2}\s*(.+)$/i);
    if (a && pendingQ) {
      const answer = clean(a[1]);
      const pub = headingPublic || PUBLIC_TAG.test(pendingQ) || PUBLIC_TAG.test(a[1]);
      out.push({ topic: topicForRow(pendingQ, heading), question: pendingQ.replace(PUBLIC_TAG, "").trim(), answer: answer.replace(PUBLIC_TAG, "").trim(), keywords: [...tokens(pendingQ), ...tokens(heading)], public: pub });
      pendingQ = null;
      continue;
    }
    const kv = line.match(/^[-*•]\s*\*{0,2}([^:*]{2,80})\*{0,2}\s*:\s*(.+)$/);
    if (kv) {
      const key = clean(kv[1]).replace(PUBLIC_TAG, "").trim();
      const value = clean(kv[2]).replace(PUBLIC_TAG, "").trim();
      if (key && value) {
        out.push({ topic: topicForRow(key, heading), question: `${key} (${section()})`, answer: `${key}: ${value}`, keywords: [...tokens(key), ...tokens(heading)], public: headingPublic || PUBLIC_TAG.test(line) });
      }
      continue;
    }
    loose.push(line.replace(/^[-*•]\s*/, ""));
  }
  flushLoose();
  return out.filter((e) => e.question && e.answer);
}

/** Honest defaults for a brand with no facts file yet: process, not property claims. */
function placeholders(brand: { name: string; offerings: string[]; website?: string }): Array<Omit<EntryInput, "brandId">> {
  const listed = brand.offerings.filter(Boolean).slice(0, 5);
  return [
    { topic: "availability", question: "What configurations are available?", answer: listed.length ? `We currently offer ${listed.join(", ")}. The sales team will confirm live availability for you.` : "The sales team will confirm the current configurations and availability for you.", keywords: ["configuration", "bhk", "unit", "available", "villa"] },
    { topic: "visit", question: "How do I book a site visit?", answer: "Site visits are free and can be booked right here on WhatsApp — tell me a day that suits you and I'll offer times.", keywords: ["visit", "viewing", "book", "tour"] },
    { topic: "payment", question: "Do you help with home loans and EMI?", answer: "Yes — our loan desk works with leading banks and helps with the application end to end. Exact EMI depends on the bank, tenure and amount, which the loan desk will work out with you.", keywords: ["emi", "loan", "bank", "finance", "payment"] },
    { topic: "documents", question: "What documents are needed for a loan?", answer: "Typically identity and address proof (PAN, Aadhaar), income proof (salary slips or ITR) and recent bank statements. You can send them here as photos or PDFs and we keep them on your file.", keywords: ["document", "kyc", "pan", "aadhaar", "salary", "upload"] },
    { topic: "contact", question: "How do I reach the sales team?", answer: `A sales manager from ${brand.name} can call you back — just say when suits you.${brand.website ? ` More at ${brand.website}.` : ""}`, keywords: ["contact", "call", "sales", "manager", "phone"] },
  ].map((e) => ({ ...e, source: "placeholder" as const }));
}

const checkedThisProcess = new Set<string>();

/**
 * Make sure a brand has entries, re-reading the facts file once per process so
 * a file written after boot is picked up on first use. Admin rows survive;
 * docs and placeholder rows are replaced by a fresh parse of the file.
 */
export function ensureKnowledge(brandId: string): { seeded: number; from: "docs" | "placeholder" | "existing" } {
  const db = read();
  const brand = db.brands.find((b) => b.id === brandId);
  if (!brand) return { seeded: 0, from: "existing" };
  const mine = db.kbEntries.filter((e) => e.brandId === brandId);
  const hasReal = mine.some((e) => e.source !== "placeholder");
  if (hasReal && checkedThisProcess.has(brandId)) return { seeded: 0, from: "existing" };
  checkedThisProcess.add(brandId);

  const file = factsPath();
  let parsed: Array<Omit<EntryInput, "brandId">> = [];
  if (file) {
    try {
      if (fs.existsSync(file)) parsed = parseFacts(fs.readFileSync(file, "utf8"));
    } catch (e) {
      console.warn(`[kb] could not read ${file}: ${(e as Error).message}`);
    }
  }
  if (parsed.length) {
    const now = new Date().toISOString();
    mutate((d) => {
      d.kbEntries = d.kbEntries.filter((e) => !(e.brandId === brandId && (e.source === "docs" || e.source === "placeholder")));
      const seen = new Set(d.kbEntries.filter((e) => e.brandId === brandId).map((e) => e.question.toLowerCase()));
      for (const p of parsed) {
        const key = p.question.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        d.kbEntries.push({ id: uid("kb"), brandId, topic: asTopic(p.topic), question: p.question.slice(0, 300), answer: p.answer.slice(0, 1500), keywords: asKeywords(p.keywords, p.question), public: p.public ?? false, source: "docs", updatedAt: now });
      }
    });
    return { seeded: parsed.length, from: "docs" };
  }
  if (mine.length) return { seeded: 0, from: "existing" };
  const now = new Date().toISOString();
  const rows = placeholders(brand);
  mutate((d) => {
    for (const p of rows) d.kbEntries.push({ id: uid("kb"), brandId, topic: asTopic(p.topic), question: p.question, answer: p.answer, keywords: asKeywords(p.keywords, p.question), public: false, source: "placeholder", updatedAt: now });
  });
  return { seeded: rows.length, from: "placeholder" };
}

/** Tests and the admin "re-sync" button: forget the per-process check. */
export function forgetKnowledgeCache(): void {
  checkedThisProcess.clear();
}
