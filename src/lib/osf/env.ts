/**
 * Environment access.
 *
 * Values are read lazily so that an unconfigured `.env.local` produces a clear,
 * actionable message at the point of use rather than a crash at import time.
 * That matters here: the dashboard should still render and tell you what's
 * missing before you've pasted your keys in.
 */

/** Placeholders left in `.env.example` — treated as "not configured". */
function isPlaceholder(value: string): boolean {
  return value.startsWith("<") && value.endsWith(">");
}

function read(name: string): string | undefined {
  const raw = process.env[name];
  if (!raw || raw.trim() === "" || isPlaceholder(raw.trim())) return undefined;
  return raw.trim();
}

/** Throws with a pointer to the exact line of `.env.local` that's missing. */
export function required(name: string): string {
  const value = read(name);
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Open .env.local and set it — ` +
        `see .env.example for where to find the value.`,
    );
  }
  return value;
}

export function optional(name: string, fallback = ""): string {
  return read(name) ?? fallback;
}

export const env = {
  /** Which LLM actually answers customers. See .env.example section 1. */
  get llmProvider(): "anthropic" | "groq" {
    return optional("LLM_PROVIDER", "anthropic") === "groq" ? "groq" : "anthropic";
  },

  get anthropicApiKey() {
    return required("ANTHROPIC_API_KEY");
  },
  get model() {
    return optional("ANTHROPIC_MODEL", "claude-opus-4-8");
  },
  get effort(): "low" | "medium" | "high" {
    const e = optional("AGENT_EFFORT", "medium");
    return e === "low" || e === "high" ? e : "medium";
  },

  /** Free-tier test provider — see PHASE-2 doc for when to move off it. */
  get groqApiKey() {
    return required("GROQ_API_KEY");
  },
  /**
   * All Groq keys, primary first, then any fallbacks. The free tier caps each
   * key at 200K tokens/day; when the primary is exhausted the agent rotates to
   * the next key and keeps replying instead of dropping the message. Fallbacks
   * live in GROQ_API_KEY_FALLBACK as a comma-separated list.
   */
  get groqApiKeys(): string[] {
    const primary = required("GROQ_API_KEY");
    const fallbacks = (optional("GROQ_API_KEY_FALLBACK") ?? "")
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    // De-dupe so an accidental repeat doesn't waste a rotation slot.
    return [...new Set([primary, ...fallbacks])];
  },
  get groqModel() {
    return optional("GROQ_MODEL", "openai/gpt-oss-120b");
  },

  /**
   * WHERE THE `villa_*` TABLES ACTUALLY LIVE.
   *
   * This module was written when the WhatsApp console ran on its own Supabase
   * project, so it asked for OSF_SUPABASE_*. That is no longer where the data
   * is: the `villa_*` schema has been applied to the SAME project that holds
   * auth, and the live WhatsApp agent on the VPS writes every lead, message
   * and conversation into it.
   *
   * So the OSF_* names are now an override, not a requirement. Unset — which
   * is the normal case — these fall through to the main project's credentials
   * and the console reads the live data with no extra configuration.
   *
   * Falling back rather than renaming keeps a genuinely separate deployment
   * possible: set OSF_SUPABASE_URL and the console points elsewhere again.
   *
   * The service key is deliberate and not negotiable here. Every `villa_*`
   * table has RLS on with no policy and is revoked from anon/authenticated, so
   * the anon key returns zero rows. Reads happen server-side or not at all —
   * `browserClient()` in ./supabase-auth is for auth only and never for these
   * tables.
   */
  get supabaseUrl() {
    return optional("OSF_SUPABASE_URL") || required("NEXT_PUBLIC_SUPABASE_URL");
  },
  get supabaseServiceKey() {
    return optional("OSF_SUPABASE_SERVICE_ROLE_KEY") || required("SUPABASE_SERVICE_ROLE_KEY");
  },

  get whatsappPhoneNumberId() {
    return required("WHATSAPP_PHONE_NUMBER_ID");
  },
  /**
   * The token that calls the Cloud API.
   *
   * Falls back to META_SYSTEM_USER_TOKEN, because on a single-app deployment
   * they are the same credential: WhatsApp, Instagram and the ad accounts all
   * hang off one Meta app, and a system-user token issued for it carries
   * whatsapp_business_messaging alongside the rest. Requiring the value to be
   * pasted a second time under a different name is how an install ends up with
   * Meta fully configured and WhatsApp still refusing to start.
   *
   * Set WHATSAPP_ACCESS_TOKEN explicitly when WhatsApp lives on its own app, or
   * when you want a token scoped to messaging only.
   */
  get whatsappAccessToken() {
    return optional("WHATSAPP_ACCESS_TOKEN") || required("META_SYSTEM_USER_TOKEN");
  },
  get whatsappVerifyToken() {
    return required("WHATSAPP_VERIFY_TOKEN");
  },
  /**
   * Same reasoning, and it matters more here: this secret verifies the
   * X-Hub-Signature-256 on every inbound webhook. An app secret belongs to the
   * Meta *app*, not to a product within it, so META_APP_SECRET is the same
   * string — and `verifySignature` fails closed when it cannot be read, which
   * turns a naming mismatch into "the agent silently answers nobody".
   */
  get whatsappAppSecret() {
    return optional("WHATSAPP_APP_SECRET") || required("META_APP_SECRET");
  },
  get whatsappApiVersion() {
    return optional("WHATSAPP_API_VERSION", "v21.0");
  },

  /**
   * Which transport carries WhatsApp traffic.
   *
   * "meta"      — the official Cloud API (business-verified, template fees,
   *               ban-proof). The original path; nothing about it changed.
   * "evolution" — a self-hosted Evolution API server driving a normal
   *               WhatsApp account over the Web protocol (free, instant,
   *               unofficial). The interim path until business verification.
   *
   * Explicit WHATSAPP_PROVIDER always wins. Unset, it infers: Evolution vars
   * present and Meta's absent → evolution; anything else → meta, so existing
   * deployments keep their behaviour without editing anything.
   */
  get whatsappProvider(): "meta" | "evolution" {
    const explicit = optional("WHATSAPP_PROVIDER")?.toLowerCase();
    if (explicit === "evolution" || explicit === "meta") return explicit;
    const hasEvolution = Boolean(optional("EVOLUTION_API_URL"));
    const hasMeta = Boolean(optional("WHATSAPP_ACCESS_TOKEN") || optional("META_SYSTEM_USER_TOKEN"));
    return hasEvolution && !hasMeta ? "evolution" : "meta";
  },

  get evolutionApiUrl() {
    // Trailing slash stripped so path joins can't produce //double-slashes.
    return required("EVOLUTION_API_URL").replace(/\/+$/, "");
  },
  get evolutionApiKey() {
    return required("EVOLUTION_API_KEY");
  },
  get evolutionInstance() {
    return required("EVOLUTION_INSTANCE");
  },
  get evolutionWebhookToken() {
    return required("EVOLUTION_WEBHOOK_TOKEN");
  },
  /**
   * Personal-number guard rails, both optional.
   *
   * When the linked number is someone's real WhatsApp (testing on a personal
   * SIM), the agent must not answer friends and family. TRIGGER_WORD makes it
   * respond only to messages that start with that word; IGNORE_BEFORE drops
   * anything older than the given date, so a history sync on first connect
   * can never replay old chats into the CRM. Unset both for a dedicated
   * business SIM.
   */
  get evolutionTriggerWord() {
    return optional("EVOLUTION_TRIGGER_WORD")?.trim().toLowerCase() || null;
  },
  get evolutionIgnoreBefore(): number | null {
    const raw = optional("EVOLUTION_IGNORE_BEFORE");
    if (!raw) return null;
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : null;
  },
  /**
   * The linked WhatsApp number itself, digits only. Set this ONLY when you are
   * testing by messaging the linked number from itself (a "message yourself"
   * chat). It tells the webhook to treat fromMe messages in that self-chat as
   * real test input, while still ignoring the agent's own replies (matched by
   * message id). Leave unset in production, where the agent must never act on
   * any message it or a human sent from the business phone.
   */
  get evolutionSelfNumber(): string | null {
    const raw = optional("EVOLUTION_SELF_NUMBER");
    return raw ? raw.replace(/\D/g, "") : null;
  },

  // Instagram DMs run the same agent over Meta's Messenger transport. The
  // access token and app secret are usually the same app as WhatsApp, so both
  // fall back to the WhatsApp values rather than forcing a duplicate paste.
  get instagramAccountId() {
    return required("INSTAGRAM_ACCOUNT_ID");
  },
  get instagramAccessToken() {
    return optional("INSTAGRAM_ACCESS_TOKEN") || env.whatsappAccessToken;
  },
  get instagramVerifyToken() {
    return optional("INSTAGRAM_VERIFY_TOKEN") || env.whatsappVerifyToken;
  },
  get instagramAppSecret() {
    return optional("INSTAGRAM_APP_SECRET") || env.whatsappAppSecret;
  },

  // Facebook Messenger is the same Graph app as Instagram and WhatsApp — a
  // Page id instead of an IG account id, and the same secrets underneath. The
  // fallbacks mean one Meta app needs one paste, not three.
  get messengerPageId() {
    return required("MESSENGER_PAGE_ID");
  },
  get messengerAccessToken() {
    return (
      optional("MESSENGER_ACCESS_TOKEN") ||
      optional("META_SYSTEM_USER_TOKEN") ||
      env.whatsappAccessToken
    );
  },
  get messengerVerifyToken() {
    return optional("MESSENGER_VERIFY_TOKEN") || env.whatsappVerifyToken;
  },
  get messengerAppSecret() {
    return optional("MESSENGER_APP_SECRET") || env.whatsappAppSecret;
  },

  get salesTeamWhatsapp() {
    return optional("SALES_TEAM_WHATSAPP");
  },
  get salesTeamName() {
    return optional("SALES_TEAM_NAME", "our sales team");
  },

  get appUrl() {
    return optional("NEXT_PUBLIC_APP_URL", "http://localhost:3000");
  },
  get dashboardPassword() {
    return optional("DASHBOARD_PASSWORD");
  },
  get projectMapsUrl() {
    return optional("PROJECT_MAPS_URL");
  },
  get brochureUrl() {
    return optional("BROCHURE_URL");
  },

  /** Ad/social copy generation. Optional — degrades to a template when unset. */
  get geminiApiKey() {
    return optional("GEMINI_API_KEY");
  },
};

/** Which integrations are wired up — drives the dashboard's setup checklist. */
export function configStatus() {
  const llmProvider = optional("LLM_PROVIDER", "anthropic") === "groq" ? "groq" : "anthropic";
  const anthropic = Boolean(read("ANTHROPIC_API_KEY"));
  const groq = Boolean(read("GROQ_API_KEY"));

  return {
    llmProvider,
    anthropic,
    groq,
    /** Whichever provider is active actually has a key set. */
    aiConfigured: llmProvider === "groq" ? groq : anthropic,
    // Mirrors the getters above, which now fall back to the main project.
    // Reading only the OSF_* names here rendered a "connect your database"
    // checklist on every screen of a console that was already pointed at the
    // live data — the gate said unconfigured while the queries would have
    // worked.
    supabase:
      Boolean(read("OSF_SUPABASE_URL") ?? read("NEXT_PUBLIC_SUPABASE_URL")) &&
      Boolean(read("OSF_SUPABASE_SERVICE_ROLE_KEY") ?? read("SUPABASE_SERVICE_ROLE_KEY")),
    // Mirrors the getters above, which fall back to the Meta app's own
    // credentials. Reading only the WHATSAPP_* names here reported "not
    // configured" for a deployment that was configured, and sent people
    // hunting for a token they had already supplied under its Meta name.
    whatsapp:
      Boolean(read("WHATSAPP_PHONE_NUMBER_ID")) &&
      Boolean(read("WHATSAPP_ACCESS_TOKEN") ?? read("META_SYSTEM_USER_TOKEN")) &&
      Boolean(read("WHATSAPP_APP_SECRET") ?? read("META_APP_SECRET")) &&
      Boolean(read("WHATSAPP_VERIFY_TOKEN")),
    evolution:
      Boolean(read("EVOLUTION_API_URL")) &&
      Boolean(read("EVOLUTION_API_KEY")) &&
      Boolean(read("EVOLUTION_INSTANCE")),
    instagram:
      Boolean(read("INSTAGRAM_ACCOUNT_ID")) &&
      Boolean(read("INSTAGRAM_ACCESS_TOKEN") ?? read("WHATSAPP_ACCESS_TOKEN") ?? read("META_SYSTEM_USER_TOKEN")),
    messenger:
      Boolean(read("MESSENGER_PAGE_ID")) &&
      Boolean(read("MESSENGER_ACCESS_TOKEN") ?? read("META_SYSTEM_USER_TOKEN") ?? read("WHATSAPP_ACCESS_TOKEN")),
    salesHandoff: Boolean(read("SALES_TEAM_WHATSAPP")),
  };
}
