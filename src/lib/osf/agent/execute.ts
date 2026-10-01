import { db } from "../supabase";
import { env } from "../env";
import { assertSendableMediaUrl, UnsafeUrlError, type MediaUrlSource } from "../net/safe-url";
import {
  assertDeliverableFile,
  isDeliverableFile,
  isLinkOnlyUrl,
  UndeliverableMediaError,
} from "../net/deliverable";
import { sendPlainText } from "../whatsapp/outbound";
import { loadKb } from "./kb";
import type { AgentReply, AssetKind, Lead, Project, ReplyOption, VillaType } from "../types";
import type { ScoringSignals } from "./scoring";

/**
 * Tool execution.
 *
 * Every handler returns a plain object that is serialised straight back to the
 * model as the tool_result. Failures return `{ ok: false, error }` rather than
 * throwing, so the agent can tell the customer it will have someone check —
 * which is the behaviour the spec requires — instead of the turn dying.
 */

export interface ToolContext {
  lead: Lead;
  conversationId: string;
  /** Delivers an outbound message on whatever channel this conversation is on. */
  deliver: (reply: AgentReply) => Promise<void>;
  /** Mutated by handlers; read by the caller to rescore the lead. */
  signals: ScoringSignals;
}

type ToolResult = Record<string, unknown>;

const CRORE = 10000000;

function formatInr(v: number | null | undefined): string {
  if (v === null || v === undefined) {
    return "not recorded — you must tell the customer the sales team will confirm";
  }
  return `₹${(v / CRORE).toFixed(2)} Cr`;
}

// -----------------------------------------------------------------------------
// Argument hygiene
//
// Tool arguments are model output, and the model is reading a customer message
// that may be trying to steer it. Nothing below trusts a type or a length just
// because the tool schema declared one.
// -----------------------------------------------------------------------------

/** Trimmed, control-characters removed, hard length cap. */
function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  // Control characters have no place in a CRM field, and this text is replayed
  // into the sales rep's WhatsApp — they are how you smuggle fake structure in.
  let cleaned = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) as number;
    cleaned += code < 32 || code === 127 ? " " : ch;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned === "" ? undefined : cleaned.slice(0, max);
}

function cleanInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  return rounded < min || rounded > max ? undefined : rounded;
}

function cleanEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function cleanStringList(value: unknown, maxItems: number, maxLen: number): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const text = cleanText(item, maxLen);
    if (text) out.push(text);
    if (out.length >= maxItems) break;
  }
  return out.length ? out : undefined;
}

// -----------------------------------------------------------------------------
// Abuse limits
//
// Every tool here can be reached by a customer message that talks the model
// into calling it. The system prompt is not a boundary against that, so the
// ceilings live in code, ahead of the side effect. These are per process and
// therefore best-effort under multiple instances — the hard, durable limits are
// the per-tool database checks in requestHumanHandoff and optOut.
// -----------------------------------------------------------------------------

const BUDGET_WINDOW_MS = 60_000;

/**
 * Ceiling on tool calls one conversation may make in a window.
 *
 * The run loop caps round-trips at 8, but a single round-trip can carry any
 * number of parallel tool_use blocks, so that ceiling bounds nothing on its own.
 * A busy legitimate turn uses well under half of this.
 */
const CONVERSATION_TOOL_BUDGET = 30;

/** Tighter ceilings for the tools that reach outside the conversation. */
const PER_TOOL_BUDGET: Record<string, number> = {
  send_media: 6,
  send_options: 8,
  update_lead: 10,
  schedule_site_visit: 3,
  request_human_handoff: 1,
  opt_out: 2,
  log_objection: 6,
  log_unanswered_question: 6,
};

const budgets = new Map<string, { count: number; resetAt: number }>();

function takeBudget(key: string, limit: number): boolean {
  const now = Date.now();
  const entry = budgets.get(key);

  if (!entry || now >= entry.resetAt) {
    if (budgets.size > 5000) {
      for (const [k, v] of budgets) if (now >= v.resetAt) budgets.delete(k);
    }
    budgets.set(key, { count: 1, resetAt: now + BUDGET_WINDOW_MS });
    return true;
  }

  if (entry.count >= limit) return false;
  entry.count += 1;
  return true;
}

const THROTTLED =
  "That action is not available again right now. Do not retry it and do not mention " +
  "any limit to the customer — carry on with the conversation normally.";

function overBudget(conversationId: string, tool: string): boolean {
  if (!takeBudget(conversationId, CONVERSATION_TOOL_BUDGET)) return true;
  const perTool = PER_TOOL_BUDGET[tool];
  return perTool !== undefined && !takeBudget(`${conversationId}#${tool}`, perTool);
}

// -----------------------------------------------------------------------------
// Knowledge base search
// -----------------------------------------------------------------------------

interface Section {
  project: string;
  slug: string;
  heading: string;
  body: string;
}

function flattenValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => flattenValue(v, depth + 1)).join("; ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${flattenValue(v, depth + 1)}`)
      .join(". ");
  }
  return String(value);
}

function sectionsFor(p: Project): Section[] {
  const base = { project: p.name, slug: p.slug };
  const location = [p.survey_no, p.village, p.mandal, p.district, p.state, p.pincode]
    .filter(Boolean)
    .join(", ");

  return [
    {
      ...base,
      heading: "Project overview",
      body: `Status: ${p.status ?? "not recorded"}. Expected delivery: ${
        p.expected_delivery ?? "not recorded"
      }. Land area: ${p.total_land_acres ?? "not recorded"} acres. Total villas: ${
        p.total_units ?? "not recorded"
      }. Configurations: ${p.configurations?.join(", ") ?? "not recorded"}. ${p.positioning ?? ""}`,
    },
    {
      ...base,
      heading: "Location and address",
      body: `${location}. Maps: ${p.maps_url ?? "not recorded"}.`,
    },
    {
      ...base,
      heading: "Approvals and legal",
      body: `HMDA permit: ${p.hmda_permit_no ?? "not recorded"}${
        p.hmda_permit_date ? ` dated ${p.hmda_permit_date}` : ""
      }. RERA: ${p.rera_number ?? p.rera_status ?? "not recorded"}.`,
    },
    {
      ...base,
      heading: "Pricing",
      body: `Starting price: ${formatInr(p.starting_price_inr)}. ${p.price_note ?? ""}`,
    },
    { ...base, heading: "Key selling points", body: flattenValue(p.usps) },
    { ...base, heading: "Amenities, clubhouse and parks", body: flattenValue(p.amenities) },
    { ...base, heading: "Specifications and construction", body: flattenValue(p.specifications) },
    { ...base, heading: "Sustainability and certification", body: flattenValue(p.sustainability) },
    {
      ...base,
      heading: "Connectivity and distances",
      body: `${flattenValue(
        p.connectivity,
      )}. These are the developer's own published estimates — always add that actual travel time varies with traffic.`,
    },
    {
      ...base,
      heading: "Schools, hospitals and social infrastructure",
      body: flattenValue(p.social_infrastructure),
    },
    {
      ...base,
      heading: "Home loans and financing",
      body: `Assistance is offered through: ${
        p.financing_partners?.join(", ") ?? "not recorded"
      }. Loan approval is always at the bank's discretion and is never guaranteed.`,
    },
  ].filter((s) => s.body.trim().length > 0);
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "of", "in", "on", "at", "to",
  "for", "and", "or", "what", "how", "many", "much", "do", "does", "you",
  "have", "there", "it", "this", "that", "with", "me", "i", "we", "can",
  "tell", "about", "please", "your",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

async function searchKnowledgeBase(input: {
  query: string;
  project_slug?: string;
}): Promise<ToolResult> {
  const { projects, faqs } = await loadKb();
  const scoped = input.project_slug
    ? projects.filter((p) => p.slug === input.project_slug)
    : projects;

  if (scoped.length === 0) {
    return { ok: true, matches: [], note: "No matching project is loaded." };
  }

  const terms = tokenize(input.query);
  const candidates: Array<{ score: number; label: string; content: string }> = [];

  for (const p of scoped) {
    for (const s of sectionsFor(p)) {
      const hay = `${s.heading} ${s.body}`.toLowerCase();
      const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1 : 0), 0);
      if (score > 0) {
        candidates.push({
          score,
          label: `${s.project} — ${s.heading}`,
          content: s.body,
        });
      }
    }
  }

  for (const f of faqs) {
    const hay = `${f.question} ${f.answer} ${(f.tags ?? []).join(" ")}`.toLowerCase();
    const score = terms.reduce((acc, t) => acc + (hay.includes(t) ? 1.5 : 0), 0);
    if (score > 0) {
      candidates.push({ score, label: `FAQ — ${f.question}`, content: f.answer });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  // Top 3, each trimmed. On Groq's free tier the tool result stays in the
  // message array and is resent on every later turn, so 5 long sections was a
  // major, compounding token cost. 3 focused snippets answer the question
  // without pushing the turn past the per-minute budget.
  const matches = candidates.slice(0, 3).map(({ label, content }) => ({
    label,
    content: content.length > 600 ? content.slice(0, 600) + "…" : content,
  }));

  return {
    ok: true,
    matches,
    note: matches.length
      ? "Only state what appears above. Anything marked 'not recorded' is unconfirmed."
      : "Nothing in the approved knowledge base covers this. Tell the customer you will have the sales team confirm, and call log_unanswered_question.",
  };
}

// -----------------------------------------------------------------------------
// Inventory
// -----------------------------------------------------------------------------

async function getVillaTypes(input: {
  project_slug?: string;
  max_budget_inr?: number;
  bedrooms?: number;
}): Promise<ToolResult> {
  const { projects, villaTypes } = await loadKb();
  const scoped = input.project_slug
    ? projects.filter((p) => p.slug === input.project_slug)
    : projects;
  const ids = new Set(scoped.map((p) => p.id));
  const nameById = new Map(scoped.map((p) => [p.id, p.name]));

  let types = villaTypes.filter((t) => ids.has(t.project_id));

  if (input.bedrooms !== undefined) {
    // Keep unconfirmed rows: they might match once a human confirms.
    types = types.filter((t) => t.bedrooms === null || t.bedrooms === input.bedrooms);
  }
  if (input.max_budget_inr !== undefined) {
    types = types.filter((t) => t.price_inr === null || t.price_inr <= input.max_budget_inr!);
  }

  return {
    ok: true,
    villa_types: types.map((t) => ({
      project: nameById.get(t.project_id),
      name: t.name,
      plot_area_sqyd: t.plot_area_sqyd,
      built_up_sft: t.built_up_sft,
      facing: t.facing,
      bedrooms: t.bedrooms ?? "not recorded",
      floors: t.floors,
      has_home_theatre: t.has_home_theatre,
      price: formatInr(t.price_inr),
      unconfirmed: t.verification_note ?? null,
    })),
    note:
      "Where bedrooms or price read 'not recorded', that value is not approved for you to state. Offer to have the sales team confirm it.",
  };
}

async function checkAvailability(input: {
  project_slug?: string;
  villa_type?: string;
}): Promise<ToolResult> {
  const supabase = db();
  const { projects, villaTypes } = await loadKb();
  const scoped = input.project_slug
    ? projects.filter((p) => p.slug === input.project_slug)
    : projects;
  const ids = scoped.map((p) => p.id);

  if (ids.length === 0) return { ok: true, live_inventory_connected: false };

  let query = supabase.from("villa_units").select("*").in("project_id", ids);
  if (input.villa_type) {
    const match = villaTypes.find((t) => t.name === input.villa_type);
    if (match) query = query.eq("villa_type_id", match.id);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: "inventory lookup failed" };

  if (!data || data.length === 0) {
    return {
      ok: true,
      live_inventory_connected: false,
      note:
        "No live inventory is connected for this project. Tell the customer you can help identify the right villa type and that the sales team will confirm current availability. Do NOT state a count, a unit number, or that anything is 'selling fast'.",
    };
  }

  const available = data.filter((u) => u.status === "available");
  return {
    ok: true,
    live_inventory_connected: true,
    available_count: available.length,
    units: available.slice(0, 10).map((u) => ({
      unit_number: u.unit_number,
      facing: u.facing,
      is_corner: u.is_corner,
      price: formatInr(u.price_inr),
    })),
    note: "This is verified live inventory. You may quote these counts and unit numbers.",
  };
}

// -----------------------------------------------------------------------------
// Assets
// -----------------------------------------------------------------------------

async function getAssets(input: {
  kind: AssetKind;
  project_slug?: string;
  villa_type?: string;
}): Promise<ToolResult> {
  const supabase = db();
  const { projects, villaTypes } = await loadKb();
  const scoped = input.project_slug
    ? projects.filter((p) => p.slug === input.project_slug)
    : projects;
  const ids = scoped.map((p) => p.id);
  if (ids.length === 0) {
    // An unknown project_slug used to return a bare empty list with no guidance,
    // which is how the model ended up improvising a URL. Retry unscoped instead:
    // the operator's approved assets are the answer either way.
    ids.push(...projects.map((p) => p.id));
    if (ids.length === 0) return { ok: true, assets: [], note: NO_ASSET_NOTE };
  }

  // `shareable_by_ai` is the operator's per-asset kill switch on /admin. It
  // gates send_media too (see net/safe-url.ts) — filtering here as well keeps a
  // revoked asset out of the model's context instead of relying on it to not
  // try, and keeps what the model is offered identical to what it may send.
  let query = supabase
    .from("villa_assets")
    .select("*")
    .in("project_id", ids)
    .eq("kind", input.kind)
    .eq("is_current", true)
    .eq("shareable_by_ai", true);

  if (input.villa_type) {
    const match = villaTypes.find((t) => t.name === input.villa_type);
    if (match) query = query.eq("villa_type_id", match.id);
  }

  const { data, error } = await query;
  if (error) return { ok: false, error: "asset lookup failed" };

  const rows = data ?? [];

  // The location is a PLACE, not a file.
  //
  // PROJECT_MAPS_URL is a maps.app.goo.gl short link: a 224 KB web page. It was
  // being handed to send_media and arriving as `location-map.pdf`, an
  // unopenable document. It is returned here as a link to be typed into the
  // reply — never as something to attach — alongside the hosted site layout,
  // which IS a real PDF and is what a customer asking for "the map" usually
  // wants to see.
  if (input.kind === "location_map") {
    const out: ToolResult = { ok: true, assets: rows.map(shapeAsset) };
    if (env.projectMapsUrl) {
      out.map_link = env.projectMapsUrl;
      out.note =
        `Send this Google Maps link to the customer as plain text in your reply, copied EXACTLY: ${env.projectMapsUrl} — ` +
        "do NOT call send_media on it and do not retype or shorten it. " +
        "If they asked for a map, layout or site plan, also call get_assets with kind \"master_plan\" and send that PDF with send_media.";
    } else if (rows.length === 0) {
      out.note = NO_ASSET_NOTE;
    }
    return out;
  }

  if (rows.length === 0) {
    // Env fallbacks are a LAST resort, and only if they are really a file.
    // BROCHURE_URL is a Google Drive "view" page — 86 KB of HTML — so it is
    // rejected here rather than delivered as a broken brochure.
    if (input.kind === "brochure" && env.brochureUrl) {
      if (await isDeliverableFile(env.brochureUrl, false)) {
        return {
          ok: true,
          assets: [{ title: "Project brochure", url: env.brochureUrl, is_ai_generated: false }],
        };
      }
    }
    return { ok: true, assets: [], note: NO_ASSET_NOTE };
  }

  const notes = [
    "If is_ai_generated is true you must tell the customer the visual is an artist's impression, not a photograph of the built villa.",
    "Send ONLY these URLs, copied exactly. Never construct, guess or shorten an asset URL.",
  ];
  if (input.kind === "brochure" && rows.length > 1) {
    notes.unshift(
      `There are ${rows.length} approved brochures. When the customer asks for "the brochure", send ALL of them — ` +
        "one send_media call each, in the order listed.",
    );
  }

  return { ok: true, assets: rows.map(shapeAsset), note: notes.join(" ") };
}

const NO_ASSET_NOTE =
  "No approved asset of this kind is uploaded yet. Tell the customer you will have the sales team send it across, and call log_unanswered_question. Do not invent a link.";

function shapeAsset(a: Record<string, unknown>) {
  return {
    title: a.title,
    description: a.description,
    url: a.url,
    is_ai_generated: a.is_ai_generated,
  };
}

const ASSET_KINDS: readonly AssetKind[] = [
  "brochure", "floor_plan", "site_plan", "master_plan", "price_sheet",
  "image", "video", "virtual_tour", "location_map", "other",
];

/**
 * Sends a question with tappable answers.
 *
 * Shape is chosen from the count rather than asked of the model: WhatsApp caps
 * reply buttons at 3, and a model that picks "buttons" for five options would
 * get a 400 from Graph and the customer would get nothing. Four or more
 * silently becomes a list, which is the same interaction to the customer.
 */
async function sendOptions(
  ctx: ToolContext,
  input: {
    body: string;
    options?: Array<{ id?: string; title?: string; description?: string }>;
    list_button_label?: string;
    footer?: string;
  },
): Promise<ToolResult> {
  const body = cleanText(input.body, 1024);
  if (!body) return { ok: false, error: "send_options needs a body — the question to ask." };

  const seen = new Set<string>();
  const options: ReplyOption[] = [];
  for (const raw of input.options ?? []) {
    const title = cleanText(raw?.title, 24);
    if (!title) continue;
    // Fall back to the title when the model omits an id, so a tap still comes
    // back as something we can match rather than an empty string.
    const id = (cleanText(raw?.id, 200) ?? title).replace(/\s+/g, "_").toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    options.push({ id, title, description: cleanText(raw?.description, 72) ?? undefined });
    if (options.length === 10) break;
  }

  if (options.length < 2) {
    return {
      ok: false,
      error:
        "send_options needs at least 2 distinct choices. Ask the question as plain text instead.",
    };
  }

  try {
    await ctx.deliver({
      text: body,
      options,
      listButtonLabel:
        options.length > 3 ? (cleanText(input.list_button_label, 20) ?? "Choose") : undefined,
    });
  } catch {
    return {
      ok: false,
      error:
        "Those options could not be delivered. Ask the same question as plain text instead, and do not mention a fault.",
    };
  }

  // Recorded with the choices appended so the transcript, the shared inbox and
  // your own next turn all show what the customer was actually offered.
  await db()
    .from("villa_messages")
    .insert({
      conversation_id: ctx.conversationId,
      lead_id: ctx.lead.id,
      role: "agent",
      body: `${body}\n\n${options.map((o) => `[${o.title}]`).join(" ")}`,
    });

  return { ok: true, data: { sent: true, offered: options.map((o) => o.id) } };
}

/**
 * Delivers the current, shareable assets of `kind` for this lead's project.
 *
 * Two callers, one behaviour: send_media falls back to this when the URL the
 * model passed turned out not to be a file, and the inbound path uses it to
 * guarantee that "send me the brochure" delivers every approved brochure.
 *
 * These rows are the operator's own approved list, and each one is still put
 * through both gates — the allowlist and the is-it-really-a-file check — so
 * nothing here can widen what may be sent. It can only narrow it. Returns how
 * many actually went out.
 */
export async function deliverApprovedAssets(params: {
  lead: Lead;
  conversationId: string;
  kind: AssetKind;
  deliver: (reply: AgentReply) => Promise<void>;
  /** Caption for the first file. Later ones use the asset's own title. */
  caption?: string;
  /** Canonical hrefs already delivered this turn; never sent twice. */
  skip?: ReadonlySet<string>;
  limit?: number;
}): Promise<number> {
  const { lead, conversationId, kind, deliver, caption, skip } = params;
  const supabase = db();
  /**
   * One document, not the whole shelf.
   *
   * Somebody who asks for "the brochure" wants a brochure. There are two
   * flagged shareable here — a 12 MB full one and a 17 MB mini — and sending
   * both meant 30 MB of WhatsApp arriving unasked, the caption landing on
   * whichever row Postgres happened to return first, and both files saved on
   * the phone under the same generated name. Images are the one kind where
   * several genuinely answer the request.
   *
   * `created_at` descending makes the choice deterministic and gives the most
   * recently uploaded version, which is the one a human would have picked.
   */
  const fanOut = params.limit ?? (kind === "image" ? 3 : 1);

  const build = (scoped: boolean) => {
    let q = supabase
      .from("villa_assets")
      .select("url, title")
      .eq("kind", kind)
      .eq("is_current", true)
      .eq("shareable_by_ai", true)
      .order("created_at", { ascending: false })
      .limit(fanOut);
    if (scoped && lead.project_interest) q = q.eq("project_id", lead.project_interest);
    return q;
  };

  // Project-scoped first, then unscoped. A lead tagged to a project whose
  // assets carry a different or null project_id used to match zero rows, so
  // the customer was told the brochure was coming and then got nothing —
  // a filter meant to make the file *more* relevant made it disappear.
  let { data } = await build(true);
  if ((!data || data.length === 0) && lead.project_interest) {
    ({ data } = await build(false));
  }
  if (!data || data.length === 0) return 0;

  let sent = 0;
  for (const row of data) {
    try {
      const { href, source } = await assertSendableMediaUrl(row.url as string);
      if (skip?.has(href)) continue;
      await assertDeliverableFile(href, source === "app_origin");
      const text = (sent === 0 ? caption : undefined) ?? (row.title as string | null) ?? undefined;
      await deliver({ mediaUrl: href, mediaKind: kind, caption: text ?? undefined });
      await supabase.from("villa_messages").insert({
        conversation_id: conversationId,
        lead_id: lead.id,
        role: "agent",
        body: text ?? null,
        media_url: href,
        media_kind: kind,
      });
      sent += 1;
    } catch {
      /* one bad row must not stop the rest */
    }
  }
  return sent;
}

async function sendMedia(
  ctx: ToolContext,
  input: { url: string; kind: AssetKind; caption?: string },
): Promise<ToolResult> {
  const kind = cleanEnum(input.kind, ASSET_KINDS);
  if (!kind) return { ok: false, error: "that is not a kind of asset this agent can send" };

  // A location is a link, not an attachment. Refuse before anything else so the
  // model puts the maps URL in its reply text, where it belongs.
  if (kind === "location_map" || isLinkOnlyUrl(input.url)) {
    return {
      ok: false,
      error:
        "The location is a link, not a file — it cannot be attached. Put the Google Maps link from get_assets into your reply as plain text, copied exactly. If they want a map to look at, send the master_plan PDF with send_media instead.",
    };
  }

  const caption = cleanText(input.caption, 1024);

  // The model chose this URL, and the model is reading a customer message that
  // may be trying to choose it for them. Re-derive the allowlist from our own
  // data before anything leaves for Meta.
  let href: string;
  let source: MediaUrlSource;
  try {
    ({ href, source } = await assertSendableMediaUrl(input.url));
  } catch (e) {
    if (e instanceof UnsafeUrlError) {
      return {
        ok: false,
        error: `${e.message} Call get_assets and send only what it returns. Do not tell the customer anything was sent.`,
      };
    }
    throw e;
  }

  // Allowed is not the same as real. The app's own origin is allowlisted
  // wholesale, so a path the model invented (observed: `/brobros/???`) passed
  // and the customer was sent the 404 page as `brochure.pdf`. The env URLs are
  // allowlisted by value, and both of them are web pages. Confirm there are
  // file bytes behind this URL before WhatsApp fetches it.
  try {
    await assertDeliverableFile(href, source === "app_origin");
  } catch (e) {
    if (!(e instanceof UndeliverableMediaError)) throw e;
    // Rather than leave the customer with nothing — the run loop stops sending
    // after one failure, and the guarantee in run-groq only fires when
    // send_media was never called — deliver the operator-approved assets of
    // this kind, which is exactly what the model was told to send.
    const rescued = await deliverApprovedAssets({
      lead: ctx.lead,
      conversationId: ctx.conversationId,
      kind,
      deliver: ctx.deliver,
      caption,
    });
    if (rescued > 0) {
      return {
        ok: true,
        delivered: true,
        note:
          `${e.message} The ${rescued} approved ${kind} file(s) were sent instead. ` +
          "Confirm to the customer normally and do not mention any problem. Do not call send_media again for this kind.",
      };
    }
    return {
      ok: false,
      error: `${e.message} Call get_assets and send only what it returns. Do not tell the customer anything was sent.`,
    };
  }

  try {
    await ctx.deliver({ mediaUrl: href, mediaKind: kind, caption });
  } catch {
    return {
      ok: false,
      error:
        "Delivery failed. Tell the customer you are having trouble sending it right now and that the sales team will follow up. Do not claim it was sent.",
    };
  }

  const supabase = db();
  await supabase.from("villa_messages").insert({
    conversation_id: ctx.conversationId,
    lead_id: ctx.lead.id,
    role: "agent",
    body: caption ?? null,
    media_url: href,
    media_kind: kind,
  });

  const flags: Record<string, boolean> = {};
  if (kind === "brochure") flags.brochure_sent = true;
  if (kind === "floor_plan") flags.floor_plan_sent = true;
  if (kind === "price_sheet") flags.price_sheet_sent = true;
  if (kind === "video" || kind === "virtual_tour") flags.video_sent = true;
  if (Object.keys(flags).length) {
    await supabase.from("villa_leads").update(flags).eq("id", ctx.lead.id);
  }

  ctx.signals.requestedMaterial = true;
  return { ok: true, delivered: true };
}

// -----------------------------------------------------------------------------
// CRM writes
// -----------------------------------------------------------------------------

const BUYER_PURPOSES = [
  "self_use", "family", "investment", "second_home", "vacation_home",
  "rental_income", "nri_purchase", "undecided",
] as const;

const TIMELINES = [
  "immediate", "within_1_month", "1_3_months", "3_6_months",
  "6_12_months", "researching", "unknown",
] as const;

const FINANCING = ["cash", "home_loan", "combination", "undecided"] as const;

/** One crore crore — far above any real villa, low enough to stop nonsense. */
const MAX_BUDGET_INR = 1_000_000_000_000;

async function updateLead(
  ctx: ToolContext,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const supabase = db();
  const patch: Record<string, unknown> = {};

  // Each field is coerced to its column's shape and capped. The tool schema
  // already declares these types, but a schema is a hint to the model, not a
  // guarantee — and the sales team reads these fields verbatim.
  const fields: Record<string, unknown> = {
    name: cleanText(input.name, 120),
    email: cleanText(input.email, 254),
    city: cleanText(input.city, 80),
    country: cleanText(input.country, 80),
    is_nri: typeof input.is_nri === "boolean" ? input.is_nri : undefined,
    bedrooms: cleanInt(input.bedrooms, 1, 20),
    budget_min_inr: cleanInt(input.budget_min_inr, 0, MAX_BUDGET_INR),
    budget_max_inr: cleanInt(input.budget_max_inr, 0, MAX_BUDGET_INR),
    buyer_purpose: cleanEnum(input.buyer_purpose, BUYER_PURPOSES),
    purchase_timeline: cleanEnum(input.purchase_timeline, TIMELINES),
    financing_preference: cleanEnum(input.financing_preference, FINANCING),
    facing_preference: cleanText(input.facing_preference, 60),
    preferred_location: cleanText(input.preferred_location, 120),
    amenities_of_interest: cleanStringList(input.amenities_of_interest, 20, 60),
    requirements_notes: cleanText(input.requirements_notes, 2000),
    preferred_language: cleanText(input.preferred_language, 16),
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) patch[key] = value;
  }

  if (typeof input.project_slug === "string") {
    const { projects } = await loadKb();
    const project = projects.find((p) => p.slug === input.project_slug);
    if (project) patch.project_interest = project.id;
  }
  if (typeof input.villa_type === "string") {
    const { villaTypes } = await loadKb();
    const t = villaTypes.find((v) => v.name === input.villa_type);
    if (t) patch.villa_type_interest = t.id;
  }

  if (Object.keys(patch).length === 0) return { ok: true, updated: [] };

  const { error } = await supabase.from("villa_leads").update(patch).eq("id", ctx.lead.id);
  if (error) return { ok: false, error: "could not save to CRM" };

  Object.assign(ctx.lead, patch);
  return { ok: true, updated: Object.keys(patch) };
}

async function scheduleSiteVisit(
  ctx: ToolContext,
  input: {
    preferred_date?: string;
    preferred_time?: string;
    visitor_count?: number;
    visit_type: string;
    special_requirements?: string;
  },
): Promise<ToolResult> {
  const supabase = db();

  // `preferred_date` lands in a `date` column — anything but ISO makes Postgres
  // reject the whole insert, so drop a malformed one rather than lose the row.
  const date = cleanText(input.preferred_date, 10);
  const isoDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;

  const { error } = await supabase.from("villa_site_visits").insert({
    lead_id: ctx.lead.id,
    project_id: ctx.lead.project_interest,
    preferred_date: isoDate,
    preferred_time: cleanText(input.preferred_time, 60) ?? null,
    visitor_count: cleanInt(input.visitor_count, 1, 50) ?? null,
    visit_type: cleanEnum(input.visit_type, ["site", "virtual"] as const) ?? "site",
    special_requirements: cleanText(input.special_requirements, 500) ?? null,
    status: "requested",
  });

  if (error) return { ok: false, error: "could not log the visit request" };

  ctx.signals.requestedSiteVisit = true;
  return {
    ok: true,
    status: "requested",
    note:
      "Logged as a REQUEST. Tell the customer the sales team will confirm the slot shortly. Do not tell them it is already booked or confirmed.",
  };
}

// -----------------------------------------------------------------------------
// Handoff
// -----------------------------------------------------------------------------

function buildHandoffPayload(lead: Lead, project: Project | undefined, villaType: VillaType | undefined, input: { reason: string; summary: string; urgency?: string }): string {
  const budget =
    lead.budget_min_inr || lead.budget_max_inr
      ? `${formatInr(lead.budget_min_inr)} – ${formatInr(lead.budget_max_inr)}`
      : "not disclosed";

  const assets = [
    lead.brochure_sent ? "brochure" : null,
    lead.floor_plan_sent ? "floor plan" : null,
    lead.price_sheet_sent ? "price sheet" : null,
    lead.video_sent ? "video" : null,
  ].filter(Boolean);

  return [
    `🔥 ${lead.lead_temperature.toUpperCase()} LEAD — score ${lead.lead_score}/100`,
    ``,
    `Name: ${lead.name ?? "not given"}`,
    lead.phone ? `Phone: +${lead.phone}` : `Instagram: ${lead.instagram_id ?? "unknown"}`,
    `Email: ${lead.email ?? "not given"}`,
    `Location: ${[lead.city, lead.country].filter(Boolean).join(", ") || "not given"}${lead.is_nri ? " (NRI)" : ""}`,
    ``,
    `Source: ${lead.source}${lead.campaign ? ` / ${lead.campaign}` : ""}`,
    `Project: ${project?.name ?? "not specified"}`,
    `Villa type: ${villaType?.name ?? "not specified"}`,
    `Bedrooms: ${lead.bedrooms ?? "not specified"}`,
    `Budget: ${budget}`,
    `Purpose: ${lead.buyer_purpose ?? "not specified"}`,
    `Timeline: ${lead.purchase_timeline}`,
    `Financing: ${lead.financing_preference ?? "not specified"}`,
    ``,
    `Requirements: ${lead.requirements_notes ?? "none recorded"}`,
    `Material already sent: ${assets.length ? assets.join(", ") : "none"}`,
    ``,
    `Handoff reason: ${input.reason.replace(/_/g, " ")}`,
    `Urgency: ${input.urgency ?? "today"}`,
    ``,
    `Summary: ${input.summary}`,
  ].join("\n");
}

const ALREADY_HANDED_OFF =
  "The sales team already has this lead's briefing for this conversation. " +
  "Tell the customer someone will be in touch shortly. Do not create another handoff.";

async function requestHumanHandoff(
  ctx: ToolContext,
  input: { reason: string; summary: string; urgency?: string },
): Promise<ToolResult> {
  const supabase = db();

  // Once per conversation, enforced against the row rather than the prompt.
  //
  // The gate is the handoff row for THIS conversation, not the lead-level
  // handoff_status: a lead who comes back months later opens a new conversation
  // and has earned a fresh briefing even if the old one was never marked
  // accepted. Tool calls are awaited one at a time, so this row is committed
  // before a second call in the same turn can read it.
  const { count, error: countError } = await supabase
    .from("villa_handoffs")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", ctx.conversationId);

  if (countError) return { ok: false, error: "could not create the handoff" };
  if ((count ?? 0) > 0) return { ok: false, error: ALREADY_HANDED_OFF };

  const { projects, villaTypes } = await loadKb();

  const project = projects.find((p) => p.id === ctx.lead.project_interest);
  const villaType = villaTypes.find((t) => t.id === ctx.lead.villa_type_interest);

  // This text is relayed verbatim into the sales rep's WhatsApp, so it is
  // bounded here: the model composed it while reading a customer message.
  const safeInput = {
    reason: cleanText(input.reason, 60) ?? "other",
    summary: cleanText(input.summary, 1200) ?? "no summary provided",
    urgency: cleanText(input.urgency, 40),
  };
  const payload = buildHandoffPayload(ctx.lead, project, villaType, safeInput);

  const { data, error } = await supabase
    .from("villa_handoffs")
    .insert({
      lead_id: ctx.lead.id,
      conversation_id: ctx.conversationId,
      reason: safeInput.reason,
      payload,
    })
    .select("id")
    .single();

  if (error) return { ok: false, error: "could not create the handoff" };

  await supabase
    .from("villa_leads")
    .update({
      handoff_status: "requested",
      // The bounded copy, not the model's raw string — this column is read back
      // into the CRM UI, and villa_handoffs.reason already stores the same value.
      handoff_reason: safeInput.reason,
      handoff_at: new Date().toISOString(),
    })
    .eq("id", ctx.lead.id);

  ctx.lead.handoff_status = "requested";
  ctx.signals.requestedHandoff = true;

  // Notify the rep. A failure here must not make the agent claim success.
  let notified = false;
  if (env.salesTeamWhatsapp) {
    try {
      const { sendText } = await import("../whatsapp/client");
      await sendPlainText(env.salesTeamWhatsapp, payload);
      notified = true;
      await supabase
        .from("villa_handoffs")
        .update({ notified: true, notified_at: new Date().toISOString() })
        .eq("id", data.id);
      await supabase.from("villa_leads").update({ handoff_status: "notified" }).eq("id", ctx.lead.id);
    } catch {
      notified = false;
    }
  }

  return {
    ok: true,
    handoff_created: true,
    sales_team_notified: notified,
    note: notified
      ? "The sales team has the full briefing. Tell the customer someone will reach out shortly."
      : "The handoff is queued in the CRM but the live alert did not go out. Still tell the customer the team will get in touch — do not mention any technical problem.",
  };
}

// -----------------------------------------------------------------------------
// Intelligence + consent
// -----------------------------------------------------------------------------

async function logObjection(
  ctx: ToolContext,
  input: { category: string; verbatim?: string },
): Promise<ToolResult> {
  await db().from("villa_objections").insert({
    lead_id: ctx.lead.id,
    conversation_id: ctx.conversationId,
    category: cleanText(input.category, 60) ?? "other",
    verbatim: cleanText(input.verbatim, 1000) ?? null,
  });
  return { ok: true, logged: true };
}

async function logUnansweredQuestion(
  ctx: ToolContext,
  input: { topic: string; verbatim?: string },
): Promise<ToolResult> {
  await db().from("villa_questions").insert({
    lead_id: ctx.lead.id,
    conversation_id: ctx.conversationId,
    topic: cleanText(input.topic, 120) ?? "other",
    verbatim: cleanText(input.verbatim, 1000) ?? null,
    unanswered: true,
  });
  return {
    ok: true,
    logged: true,
    note: "A human will follow up on this. You may tell the customer the team will come back to them.",
  };
}

/**
 * Phrases that mean "stop messaging me", across the languages this agent is
 * actually used in.
 *
 * Deliberately broad. The asymmetry matters: wrongly refusing a real opt-out is
 * a consent-law failure, wrongly accepting one costs a single lead. Anything
 * this list misses still has a deterministic route through — the refusal below
 * asks the customer to reply STOP, which matches in any language.
 */
const OPT_OUT_SIGNALS: RegExp[] = [
  /\bstop\b/,
  /\bunsubscribe\b/,
  /\bopt[\s-]?out\b/,
  /\bremove me\b/,
  /\bremove my (number|name|details)\b/,
  /\bdelete my (number|data|details)\b/,
  /\b(do ?n[o']?t|dont|never) (contact|message|msg|text|call|disturb|bother)\b/,
  /\bno more (messages|msgs|texts|calls)\b/,
  /\bleave me alone\b/,
  /\bnot interested\b.*\b(stop|again|anymore|any more)\b/,
  /\bband kar/, // Hindi/Urdu, roman
  /\bmat (bhejo|karo|bhejna)\b/,
  /\bnahi chahiye\b/,
  /\bhata (do|dijiye)\b/,
  /बंद कर/,
  /मत भेज/,
  /नहीं चाहिए/,
  /हटा (दो|दीजिए)/,
  /\bvaddu\b/, // Telugu, roman
  /\bapandi\b|\baapandi\b/,
  /ఆపండి/,
  /వద్దు/,
  /తీసివేయ/,
];

const NOT_A_REAL_OPT_OUT =
  "Nothing in what the customer actually said reads as an opt-out request, so they " +
  "have NOT been opted out. Never opt someone out on your own initiative. If you " +
  "believe they want to stop hearing from us, ask them to reply STOP to confirm, " +
  "and call opt_out again only after they do.";

/**
 * The customer's own words for this turn.
 *
 * Read from the database rather than from the tool argument on purpose: the
 * model supplies `verbatim`, so a model that has been talked into opting a lead
 * out would happily supply a convincing quote to go with it. The inbound
 * message is written by handleInbound before the agent runs, so the newest
 * customer row is this turn's message.
 */
async function latestCustomerMessage(conversationId: string): Promise<string> {
  const { data } = await db()
    .from("villa_messages")
    .select("body")
    .eq("conversation_id", conversationId)
    .eq("role", "customer")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return typeof data?.body === "string" ? data.body : "";
}

function readsAsOptOut(text: string): boolean {
  const normalized = text.toLowerCase();
  return OPT_OUT_SIGNALS.some((pattern) => pattern.test(normalized));
}

async function optOut(ctx: ToolContext, input: { verbatim?: string }): Promise<ToolResult> {
  if (!readsAsOptOut(await latestCustomerMessage(ctx.conversationId))) {
    return { ok: false, error: NOT_A_REAL_OPT_OUT };
  }

  const supabase = db();
  await supabase
    .from("villa_leads")
    .update({
      opted_out: true,
      opted_out_at: new Date().toISOString(),
      consent_status: "opted_out",
      handoff_status: "closed",
    })
    .eq("id", ctx.lead.id);

  ctx.lead.opted_out = true;

  await supabase.from("villa_conversations").update({ status: "closed" }).eq("id", ctx.conversationId);

  return {
    ok: true,
    opted_out: true,
    note:
      "Send one short, polite acknowledgement confirming they will not be contacted again, then stop. " +
      (input.verbatim ? "" : ""),
  };
}

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

export async function executeTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const started = Date.now();
  let result: ToolResult;

  // Checked before dispatch, but inside the audited region, so a throttled call
  // still shows up in villa_tool_calls for whoever reviews the conversation.
  if (overBudget(ctx.conversationId, name)) {
    result = { ok: false, error: THROTTLED };
  } else {
    try {
      switch (name) {
        case "search_knowledge_base":
          result = await searchKnowledgeBase(input as never);
          break;
        case "get_villa_types":
          result = await getVillaTypes(input as never);
          break;
        case "check_availability":
          result = await checkAvailability(input as never);
          break;
        case "get_assets":
          result = await getAssets(input as never);
          break;
        case "send_options":
          result = await sendOptions(ctx, input as never);
          break;
        case "send_media":
          result = await sendMedia(ctx, input as never);
          break;
        case "update_lead":
          result = await updateLead(ctx, input);
          break;
        case "schedule_site_visit":
          result = await scheduleSiteVisit(ctx, input as never);
          break;
        case "request_human_handoff":
          result = await requestHumanHandoff(ctx, input as never);
          break;
        case "log_objection":
          result = await logObjection(ctx, input as never);
          break;
        case "log_unanswered_question":
          result = await logUnansweredQuestion(ctx, input as never);
          break;
        case "opt_out":
          result = await optOut(ctx, input as never);
          break;
        default:
          result = { ok: false, error: `unknown tool ${name}` };
      }
    } catch (e) {
      result = {
        ok: false,
        error:
          "This lookup is temporarily unavailable. Tell the customer you will have the sales team confirm, and do not mention a technical fault.",
      };
      console.error(`[tool:${name}]`, e);
    }
  }

  // Audit trail — section 44 requires we never claim a failed action succeeded.
  void db()
    .from("villa_tool_calls")
    .insert({
      conversation_id: ctx.conversationId,
      lead_id: ctx.lead.id,
      tool_name: name,
      input,
      output: result,
      ok: result.ok !== false,
      error: typeof result.error === "string" ? result.error : null,
      duration_ms: Date.now() - started,
    })
    .then(undefined, () => {});

  return result;
}
