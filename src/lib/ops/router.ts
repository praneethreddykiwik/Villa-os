import type { KbEntry, KbTopic } from "./types";

/**
 * INTENT ROUTER + LANGUAGE MIRRORING
 *
 * Deterministic first: a regex table decides what the customer asked before
 * any model is consulted, so the reply path (and the escalation it may
 * trigger) is the same with or without Groq. The LLM only rephrases within
 * the intent's facts; when it is down, `deterministicReply` is the answer.
 */

export type RoutedIntent =
  | "pricing" | "availability" | "location" | "amenities" | "approvals" | "payment"
  | "visit" | "callback" | "human" | "documents" | "opt_out" | "greeting" | "thanks" | "unknown";

export type Lang = "en" | "hi" | "te" | "hinglish";

/** Ordered most-specific first: one message often trips several. */
const ROUTES: Array<[RoutedIntent, RegExp]> = [
  ["opt_out", /\b(stop|unsubscribe|do not (contact|message)|opt.?out)\b/i],
  ["human", /\b(sales ?(man|person|manager|executive|rep|team member)|connect (me )?(to|with)|speak (to|with)|talk (to|with)|human|agent|representative|real person|someone from (the )?(sales )?team|kisi se baat|baat kar(na|ni|o)|ఎవరైనా|మాట్లాడ)|किसी से बात|बात कर/i],
  ["callback", /\b(call ?back|call me|schedule a call|arrange a call|book a call|phone me|ring me|give me a call|call kar(o|na|ke|iye)|call (me )?(tomorrow|today|later|at|in the))\b|कॉल|కాల్/i],
  ["visit", /\b(site visit|visit|viewing|walk ?through|see it|show me around|come and see|come to (the )?site|see the (site|villa|property|flat|unit)|dekhn[ae]|dekhna hai|milne aa)\b|विज़िट|विजिट|देखना|చూడ/i],
  ["documents", /\b(documents?|paperwork|upload|kyc|aadha?ar|pan card|salary slips?|bank statements?|itr|form 16)\b|दस्तावेज़|దస్తావేజు/i],
  ["approvals", /\b(rera|approved by|approvals?|hmda|dtcp|bbmp|bda|khata|occupancy certificate|\boc\b|clearance|sanctioned plan|title (is )?clear|clear title|bank approved)\b|अनुमोदन|మంజూరు/i],
  ["payment", /\b(emi|payment plans?|payment schedule|instal?ments?|down ?payment|loan|financ\w*|mortgage|interest rate|home loan|construction[- ]linked|booking amount|token amount|how (do|to) (i )?pay)\b|ईएमआई|लोन|కిస్తీ|రుణం/i],
  ["location", /\b(location|located|where is|address|nearby|near ?by|close by|schools?|hospitals?|airport|it park|tech park|offices?|commute|distance|metro|highway|how far|kaha[an]?|directions?|landmark|connectivity|railway|bus stand|kitni door)\b|कहाँ|कहां|स्कूल|अस्पताल|एयरपोर्ट|ఎక్కడ|స్కూల్|ఆసుపత్రి/i],
  ["amenities", /\b(amenit\w*|facilit\w*|club ?house|gym|swimming|pool|park|play ?area|security|garden|power backup|lifts?|parking|ev charging|jogging|sports|community hall|kids)\b|सुविधा|సౌకర్య/i],
  ["availability", /\b(available|availability|configurations?|configs?|bhk|units?|floor plans?|sq\.? ?ft|sqft|size|possession|ready to move|inventory|carpet area|towers?|plots?|villas?|options)\b|उपलब्ध|అందుబాటు/i],
  ["pricing", /\b(price|pricing|prices|cost|how much|rates?|budget|kitn[ae]|quote|quotation|lakh|crore|starting (at|from))\b|₹|कीमत|दाम|ధర|ఎంత/i],
  // Script words sit outside the `\b` group: `\b` never matches after a non-ASCII letter.
  ["thanks", /^\s*(thanks?|thank you|thx|ty|dhanyavad|dhanyawad|shukriya)\b|^\s*(धन्यवाद|ధన్యవాదాలు)/i],
  ["greeting", /^\s*(hi|hello|hey|hii+|good (morning|afternoon|evening)|namaste|namaskar|namaskaram|ok(ay)?|sure|yes|no|great|fine)\b|^\s*(नमस्ते|హలో|నమస్కారం)/i],
];

export function routeIntent(text: string): RoutedIntent {
  for (const [intent, re] of ROUTES) if (re.test(text)) return intent;
  return "unknown";
}

/** KB topic the intent should prefer when retrieving facts. */
export function topicForIntent(intent: RoutedIntent): KbTopic | undefined {
  const map: Partial<Record<RoutedIntent, KbTopic>> = {
    pricing: "pricing", availability: "availability", location: "location", amenities: "amenities",
    approvals: "approvals", payment: "payment", visit: "visit", callback: "contact", human: "contact", documents: "documents",
  };
  return map[intent];
}

/* -------------------------------------------------------------------------- */
/* Language                                                                    */
/* -------------------------------------------------------------------------- */

const HINGLISH = /\b(kya|hai|hain|kitna|kitni|kitne|kab|kaise|kahan|kaha|mujhe|chahiye|batao|bataye|bataiye|karna|karo|nahi|nahin|haan|acha|accha|kal|aaj|dekhna|milega|hoga|kaunsa|konsa|paise|paisa|ghar|kripya|bhai|ji)\b/i;

/** Script first (unambiguous), then romanised Hindi by vocabulary, else English. */
export function detectLanguage(text: string): Lang {
  if (/[ఀ-౿]/.test(text)) return "te";
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  if (HINGLISH.test(text)) return "hinglish";
  return "en";
}

export const LANGUAGE_NAME: Record<Lang, string> = {
  en: "English",
  hi: "Hindi (Devanagari script)",
  te: "Telugu (Telugu script)",
  hinglish: "Hinglish (Hindi written in Latin letters, casual)",
};

/** The one next-step question every reply ends with. */
export function nextStep(lang: Lang, mode: "visit" | "callback" | "either" = "either"): string {
  const t: Record<Lang, Record<typeof mode, string>> = {
    en: {
      either: "Would you like to book a site visit, or shall I arrange a callback?",
      visit: "Which day would suit you for a site visit?",
      callback: "Shall I arrange a callback from the sales team?",
    },
    hi: {
      either: "क्या आप साइट विज़िट बुक करना चाहेंगे, या मैं कॉलबैक अरेंज करूँ?",
      visit: "साइट विज़िट के लिए कौन सा दिन आपके लिए ठीक रहेगा?",
      callback: "क्या मैं सेल्स टीम से कॉलबैक अरेंज करूँ?",
    },
    hinglish: {
      either: "Kya aap site visit book karna chahenge, ya main callback arrange karun?",
      visit: "Site visit ke liye kaunsa din aapko suit karega?",
      callback: "Kya main sales team se callback arrange karun?",
    },
    te: {
      either: "మీరు సైట్ విజిట్ బుక్ చేయాలనుకుంటున్నారా, లేదా కాల్‌బ్యాక్ ఏర్పాటు చేయమంటారా?",
      visit: "సైట్ విజిట్ కోసం మీకు ఏ రోజు అనుకూలం?",
      callback: "సేల్స్ టీమ్ నుండి కాల్‌బ్యాక్ ఏర్పాటు చేయమంటారా?",
    },
  };
  return t[lang][mode];
}

/** Append the next-step question unless the text already asks one. */
export function withNextStep(text: string, lang: Lang, mode: "visit" | "callback" | "either" = "either"): string {
  const t = text.trim();
  if (/\?\s*$/.test(t)) return t;
  return `${t} ${nextStep(lang, mode)}`;
}

/* -------------------------------------------------------------------------- */
/* Callback window                                                             */
/* -------------------------------------------------------------------------- */

/** When a human will realistically call: inside working hours "within 2 hours", otherwise next morning. */
export function callbackWindow(now = new Date(), timeZone = "Asia/Kolkata"): string {
  let hour = now.getUTCHours();
  try {
    hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone, hour: "numeric", hour12: false }).format(now));
  } catch { /* fall back to UTC */ }
  return hour >= 9 && hour < 19 ? "within the next 2 hours" : "by 10am tomorrow";
}

/* -------------------------------------------------------------------------- */
/* Deterministic replies                                                       */
/* -------------------------------------------------------------------------- */

const T = {
  handoff: {
    en: (who: string, when: string) => `of course — I've passed this to ${who}, who will call you ${when}. If there's a time that suits you better, tell me and I'll note it.`,
    hi: (who: string, when: string) => `ज़रूर — मैंने यह ${who} को भेज दिया है, वे आपको ${when} कॉल करेंगे। अगर कोई और समय बेहतर हो तो बताइए, मैं नोट कर लूँगा।`,
    hinglish: (who: string, when: string) => `bilkul — maine yeh ${who} ko bhej diya hai, woh aapko ${when} call karenge. Agar koi aur time better ho toh bataiye, main note kar lunga.`,
    te: (who: string, when: string) => `తప్పకుండా — దీన్ని ${who}కి పంపాను, వారు మీకు ${when} కాల్ చేస్తారు. వేరే సమయం అనుకూలమైతే చెప్పండి, నోట్ చేస్తాను.`,
  },
  callback: {
    en: (when: string) => `done — I've asked the sales team to call you ${when}. Is there a particular time that works best for you?`,
    hi: (when: string) => `ठीक है — मैंने सेल्स टीम से कहा है कि वे आपको ${when} कॉल करें। क्या कोई खास समय आपके लिए बेहतर रहेगा?`,
    hinglish: (when: string) => `theek hai — maine sales team ko bola hai ki woh aapko ${when} call karein. Koi khaas time aapke liye best rahega?`,
    te: (when: string) => `సరే — సేల్స్ టీమ్ మీకు ${when} కాల్ చేయమని చెప్పాను. మీకు ఏ సమయం బాగా అనుకూలం?`,
  },
  thanks: {
    en: "you're welcome — happy to help.",
    hi: "आपका स्वागत है — मदद करके खुशी हुई।",
    hinglish: "koi baat nahi — help karke khushi hui.",
    te: "పర్వాలేదు — సహాయం చేయడం సంతోషం.",
  },
  noFacts: {
    en: "I don't have the exact details on that to hand, so I've noted it for the team to confirm with you.",
    hi: "इसकी सटीक जानकारी अभी मेरे पास नहीं है, मैंने टीम को नोट कर दिया है ताकि वे आपसे पुष्टि करें।",
    hinglish: "Iski exact details abhi mere paas nahi hain, maine team ko note kar diya hai taaki woh aapse confirm karein.",
    te: "దీని ఖచ్చితమైన వివరాలు ప్రస్తుతం నా వద్ద లేవు, టీమ్ మీతో ధృవీకరించేలా నోట్ చేశాను.",
  },
  priceWithheld: {
    en: "the sales team will confirm current pricing for you",
    hi: "सेल्स टीम आपको वर्तमान कीमत की पुष्टि करेगी",
    hinglish: "sales team aapko current pricing confirm karegi",
    te: "ప్రస్తుత ధరను సేల్స్ టీమ్ మీకు ధృవీకరిస్తుంది",
  },
  when: {
    en: (w: string) => w,
    hi: (w: string) => (w.startsWith("within") ? "अगले 2 घंटे में" : "कल सुबह 10 बजे तक"),
    hinglish: (w: string) => (w.startsWith("within") ? "agle 2 ghante mein" : "kal subah 10 baje tak"),
    te: (w: string) => (w.startsWith("within") ? "రాబోయే 2 గంటల్లో" : "రేపు ఉదయం 10 గంటలలోపు"),
  },
};

const MAX_FACT_CHARS = 520;

/** Two or three KB answers joined into one readable paragraph. */
export function factsSentence(entries: KbEntry[], opts: { withholdPrices?: boolean } = {}): string {
  const usable = entries.filter((e) => !(opts.withholdPrices && e.topic === "pricing" && !e.public));
  let out = "";
  for (const e of usable) {
    const a = e.answer.replace(/\s+/g, " ").trim();
    const s = /[.!?]$/.test(a) ? a : `${a}.`;
    if (out.length + s.length > MAX_FACT_CHARS && out) break;
    out = out ? `${out} ${s}` : s;
  }
  return out;
}

export interface ReplyContext {
  greeting: string;
  lang: Lang;
  entries: KbEntry[];
  /** Who will call back, for the human handoff. */
  handoffTo?: string;
  window?: string;
}

/**
 * The grounded reply for an intent when no model is available (or its answer
 * was rejected). Facts come only from KB entries; prices only from public ones.
 */
export function deterministicReply(intent: RoutedIntent, ctx: ReplyContext): string {
  const { greeting, lang } = ctx;
  const when = T.when[lang](ctx.window ?? callbackWindow());
  switch (intent) {
    case "human":
      return `${greeting}${T.handoff[lang](ctx.handoffTo ?? (lang === "en" ? "a sales manager" : lang === "te" ? "సేల్స్ మేనేజర్" : lang === "hi" ? "सेल्स मैनेजर" : "sales manager"), when)}`;
    case "callback":
      return `${greeting}${T.callback[lang](when)}`;
    case "thanks":
      return withNextStep(`${greeting}${T.thanks[lang]}`, lang);
    case "pricing": {
      const pub = ctx.entries.filter((e) => e.public);
      const body = pub.length ? factsSentence(pub) : `${T.priceWithheld[lang]}.`;
      return withNextStep(`${greeting}${body}`, lang, "visit");
    }
    default: {
      const facts = factsSentence(ctx.entries, { withholdPrices: true });
      const body = facts || T.noFacts[lang];
      return withNextStep(`${greeting}${body}`, lang, intent === "payment" || intent === "documents" ? "callback" : "either");
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Site-visit slot filling                                                     */
/* -------------------------------------------------------------------------- */

export interface VisitPreference {
  /** 0 = Sunday … 6 = Saturday. */
  weekday?: number;
  /** Days from today: 0 today, 1 tomorrow. */
  dayOffset?: number;
  weekend?: boolean;
  period?: "morning" | "afternoon" | "evening";
  /** 24h hour when the customer named a time. */
  hour?: number;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** Pull a day/time preference out of free text ("Saturday 11am", "kal shaam", "this weekend"). */
export function parseVisitPreference(text: string): VisitPreference | null {
  const t = text.toLowerCase();
  const p: VisitPreference = {};
  const wd = t.match(/\b(sun|mon|tue|wed|thu|fri|sat)(day|nesday|rsday|urday|sday)?\b/);
  if (wd) p.weekday = WEEKDAYS.indexOf(wd[1]);
  if (/\b(tomorrow|kal|రేపు)\b|कल/.test(t)) p.dayOffset = 1;
  else if (/\b(today|aaj|ఈరోజు)\b|आज/.test(t)) p.dayOffset = 0;
  else if (/\bday after\b|parso|परसों/.test(t)) p.dayOffset = 2;
  if (/\bweekend\b/.test(t)) p.weekend = true;
  if (/\b(morning|subah|ఉదయం)\b|सुबह/.test(t)) p.period = "morning";
  else if (/\b(afternoon|dopahar|మధ్యాహ్నం)\b|दोपहर/.test(t)) p.period = "afternoon";
  else if (/\b(evening|shaam|sham|సాయంత్రం)\b|शाम/.test(t)) p.period = "evening";
  const hm = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|baje|o'?clock)?\b/);
  if (hm && (hm[3] || hm[2])) {
    let h = Number(hm[1]);
    if (h >= 0 && h <= 23) {
      if (hm[3] === "pm" && h < 12) h += 12;
      if (hm[3] === "am" && h === 12) h = 0;
      // "4 baje" with no am/pm: a showroom visit at 04:00 is not what anyone means.
      if (!/am|pm/.test(hm[3] ?? "") && h >= 1 && h <= 7) h += 12;
      p.hour = h;
    }
  }
  return Object.keys(p).length ? p : null;
}

/** Local weekday/hour of an ISO instant, for matching against a preference. */
function localParts(iso: string, timeZone: string): { weekday: number; hour: number; ymd: string } {
  const d = new Date(iso);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "numeric", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const get = (k: string) => parts.find((x) => x.type === k)?.value ?? "";
    return { weekday: WEEKDAYS.indexOf(get("weekday").toLowerCase().slice(0, 3)), hour: Number(get("hour")) % 24, ymd: `${get("year")}-${get("month")}-${get("day")}` };
  } catch {
    return { weekday: d.getUTCDay(), hour: d.getUTCHours(), ymd: d.toISOString().slice(0, 10) };
  }
}

/** Filter bookable slots to the customer's stated day/time. Empty when nothing fits. */
export function matchSlots<S extends { startsAt: string }>(all: S[], pref: VisitPreference, timeZone: string, now = new Date()): S[] {
  const target = pref.dayOffset !== undefined ? localParts(new Date(now.getTime() + pref.dayOffset * 86_400_000).toISOString(), timeZone).ymd : undefined;
  return all.filter((s) => {
    const lp = localParts(s.startsAt, timeZone);
    if (target && lp.ymd !== target) return false;
    if (pref.weekday !== undefined && lp.weekday !== pref.weekday) return false;
    if (pref.weekend && lp.weekday !== 0 && lp.weekday !== 6) return false;
    if (pref.hour !== undefined && Math.abs(lp.hour - pref.hour) > 1) return false;
    if (pref.period === "morning" && lp.hour >= 12) return false;
    if (pref.period === "afternoon" && (lp.hour < 12 || lp.hour >= 17)) return false;
    if (pref.period === "evening" && lp.hour < 17) return false;
    return true;
  });
}
