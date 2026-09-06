import { mutate, read } from "../db";
import { configuredAgentId, isConfigured, updateAgent } from "../bolna/client";
import { VOICE_LANGUAGES, type VoiceAgentConfig, type VoiceLanguage } from "./types";

/**
 * VOICE AGENT SETTINGS — what the client may change, and how it reaches the
 * provider.
 *
 * The client edits wording only. Everything else about the agent (voice,
 * model, telephony, tools) is configured by the operator in the provider's
 * own console and is never represented here, so there is nothing on this
 * screen that can break a live agent.
 */

const LIMITS = {
  businessName: 80,
  greeting: 400,
  officeHours: 200,
  location: 300,
  pricingGuidance: 1500,
  transferTo: 20,
  listItem: 160,
  listLength: 30,
} as const;

export function defaultConfig(brandId: string, businessName: string): VoiceAgentConfig {
  return {
    brandId,
    businessName,
    greeting: `Hello, thank you for calling ${businessName}. How can I help you today?`,
    officeHours: "",
    location: "",
    offerings: [],
    pricingGuidance: "",
    languages: ["English", "Hindi"],
    transferTo: "",
    doNotSay: [],
    updatedAt: "",
    updatedBy: "",
    lastSync: null,
  };
}

export function getConfig(brandId: string, businessName: string): VoiceAgentConfig {
  return read().voiceAgentConfigs.find((c) => c.brandId === brandId) ?? defaultConfig(brandId, businessName);
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function lines(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
  return raw
    .map((x) => text(x, LIMITS.listItem))
    .filter(Boolean)
    .slice(0, LIMITS.listLength);
}

export type ConfigValidation = { ok: true; config: VoiceAgentConfig } | { ok: false; error: string };

/** Body → config, or the first thing wrong with it. Unknown keys are dropped. */
export function validateConfig(
  body: unknown,
  ctx: { brandId: string; businessName: string; actor: string },
): ConfigValidation {
  const b = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const current = getConfig(ctx.brandId, ctx.businessName);

  const businessName = text(b.businessName, LIMITS.businessName);
  if (!businessName) return { ok: false, error: "Business name is required." };
  const greeting = text(b.greeting, LIMITS.greeting);
  if (!greeting) return { ok: false, error: "A greeting is required — it is the first thing callers hear." };

  const langsRaw = Array.isArray(b.languages) ? b.languages : [];
  const languages = (VOICE_LANGUAGES as readonly string[]).filter((l) => langsRaw.includes(l)) as VoiceLanguage[];
  if (!languages.length) return { ok: false, error: "Choose at least one language." };

  const transferTo = text(b.transferTo, LIMITS.transferTo).replace(/[^\d+]/g, "");
  if (transferTo && !/^\+\d{8,15}$/.test(transferTo)) {
    return { ok: false, error: "Transfer number must include the country code, e.g. +91 98450 12345." };
  }

  return {
    ok: true,
    config: {
      brandId: ctx.brandId,
      businessName,
      greeting,
      officeHours: text(b.officeHours, LIMITS.officeHours),
      location: text(b.location, LIMITS.location),
      offerings: lines(b.offerings),
      pricingGuidance: text(b.pricingGuidance, LIMITS.pricingGuidance),
      languages,
      transferTo,
      doNotSay: lines(b.doNotSay),
      updatedAt: new Date().toISOString(),
      updatedBy: ctx.actor,
      lastSync: current.lastSync,
    },
  };
}

export function saveConfig(config: VoiceAgentConfig): void {
  mutate((db) => {
    const i = db.voiceAgentConfigs.findIndex((c) => c.brandId === config.brandId);
    if (i === -1) db.voiceAgentConfigs.push(config);
    else db.voiceAgentConfigs[i] = config;
  });
}

/**
 * The system prompt, from a fixed template plus the client's fields.
 *
 * Stable on purpose: the template carries the behavioural rules (be brief,
 * do not invent prices, hand off politely) and the client's text fills the
 * facts. A client cannot edit the rules, so a typo in "pricing guidance"
 * cannot turn the agent into something that promises discounts.
 */
export function buildSystemPrompt(c: VoiceAgentConfig): string {
  const langs = c.languages.join(", ");
  const offerings = c.offerings.length ? c.offerings.map((o) => `- ${o}`).join("\n") : "- (ask the caller what they are looking for)";
  const doNotSay = c.doNotSay.length ? c.doNotSay.map((o) => `- ${o}`).join("\n") : "- (none)";
  return [
    `You are the phone assistant for ${c.businessName}, a real-estate business.`,
    `Speak naturally in ${langs}; switch to whichever of these the caller uses. Keep each reply to one or two short sentences — this is a phone call.`,
    "",
    "## Your job",
    "1. Greet the caller and find out what they are looking for.",
    "2. Answer questions about the projects and offerings below.",
    "3. Collect the caller's name, the project they are interested in, their budget range, and a good time for a site visit or callback.",
    "4. Offer to book a site visit. Confirm the day and time back to them.",
    "",
    "## Business facts",
    c.officeHours ? `Office hours: ${c.officeHours}` : "Office hours: not specified — offer to have someone call back.",
    c.location ? `Location / address: ${c.location}` : "",
    "",
    "## Projects and offerings",
    offerings,
    "",
    "## Pricing guidance",
    c.pricingGuidance || "Do not quote prices. Say the sales team will share current pricing and offers.",
    "Never invent a price, discount, availability, or completion date that is not stated above.",
    "",
    "## Handing over",
    c.transferTo
      ? `If the caller asks for a person, or asks something you cannot answer, offer to transfer the call to ${c.transferTo} or arrange a callback.`
      : "If the caller asks for a person, or asks something you cannot answer, take their number and promise a callback from the team.",
    "",
    "## Never say",
    doNotSay,
    "",
    "## Style",
    "Be warm and concise. Do not mention that you are an AI unless asked directly; if asked, say so honestly. Do not read out lists longer than three items — summarise and offer to send details.",
  ]
    .filter((line) => line !== "")
    .join("\n")
    // Blank separators were filtered above; restore one before each heading.
    .replace(/\n## /g, "\n\n## ");
}

export interface SyncResult {
  synced: boolean;
  /** Human-readable, safe to show the client — names no provider. */
  message: string;
  /** Operator detail for the admin diagnostics panel. */
  detail?: string;
}

/**
 * Push the wording to the provider agent. Missing configuration is a
 * documented no-op, not an error: the settings are saved either way and the
 * banner says exactly which step is pending.
 */
export async function syncConfig(config: VoiceAgentConfig): Promise<SyncResult> {
  if (!isConfigured()) {
    return { synced: false, message: "Saved. The voice agent is not connected yet, so nothing was pushed live.", detail: "BOLNA_API_KEY is unset." };
  }
  const agentId = configuredAgentId();
  if (!agentId) {
    return {
      synced: false,
      message: "Saved. The live agent is not linked yet — an administrator needs to finish setup.",
      detail: "BOLNA_AGENT_ID is unset; see docs/voice-setup.md.",
    };
  }
  const res = await updateAgent(agentId, {
    name: config.businessName,
    welcomeMessage: config.greeting,
    systemPrompt: buildSystemPrompt(config),
  });
  if (!res.ok) {
    return { synced: false, message: "Saved, but the live agent could not be updated. Try again in a minute.", detail: res.error };
  }
  return { synced: true, message: "Saved and live on the voice agent.", detail: res.data.state ?? undefined };
}

export function recordSync(brandId: string, result: SyncResult): void {
  mutate((db) => {
    const c = db.voiceAgentConfigs.find((x) => x.brandId === brandId);
    if (c) c.lastSync = { at: new Date().toISOString(), ok: result.synced, message: result.message };
  });
}
