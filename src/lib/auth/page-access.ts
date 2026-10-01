import type { Permission } from "./session";

/**
 * PAGE-LEVEL ACCESS MAP
 *
 * Every screen states the one permission it requires. Enforced once, in the app
 * layout, so a new page cannot ship without a decision — an unlisted path is
 * denied, not allowed.
 *
 * This exists because hiding a link is not access control. Before this map, a
 * receptionist who typed /dashboard directly reached live customer and revenue
 * data, even though the navigation never offered it.
 */
const RULES: Array<[RegExp, Permission]> = [
  // Operations
  [/^\/ops\/admin/, "analytics.view"],
  [/^\/ops\/sales/, "sales.read"],
  [/^\/ops\/loans/, "loans.read"],
  [/^\/ops\/customers/, "customers.read"],
  [/^\/ops\/messages/, "customers.read"],
  // The WhatsApp workspace. Its screens moved under /inbox/whatsapp when the
  // ported console was folded into that tab, and they must keep the permission
  // their SUBJECT deserves rather than inheriting the inbox's customers.read —
  // revenue, pipeline and integration settings are not front-desk data.
  // Listed before the general /inbox/whatsapp rule because first match wins.
  [/^\/inbox\/whatsapp\/(settings|whatsapp|simulator|automation|training)/, "workflows.manage"],
  [/^\/inbox\/whatsapp\/(marketing|properties)/, "marketing.read"],
  [/^\/inbox\/whatsapp\/(analytics|activity|ai|overview)/, "analytics.view"],
  [/^\/inbox\/whatsapp\/communication/, "customers.read"],
  // The directory is a front-desk tool — "have we spoken to this number
  // before?" — and it carried customers.read when it lived at /crm/contacts.
  // Listed before the general crm rule so repointing the sidebar at the
  // Supabase page does not quietly take it away from the front desk.
  [/^\/inbox\/whatsapp\/crm\/contacts/, "customers.read"],
  [/^\/inbox\/whatsapp\/(crm|sales)/, "sales.read"],
  // Fallback: the inbox itself, which IS front-desk work.
  [/^\/inbox\/whatsapp/, "customers.read"],

  // Analytics and reporting — business performance, not everyone's business.
  [/^\/(dashboard|analytics|insights|reports|ads|activity)/, "analytics.view"],

  // Customer records. The contact directory is a lookup tool the front desk
  // genuinely needs; the pipeline, deal values and follow-up queue are sales
  // work and carry commercial information, so they need sales.read.
  [/^\/crm\/contacts/, "customers.read"],
  [/^\/crm\//, "sales.read"],
  [/^\/(engagement|reviews)/, "customers.read"],
  // The voice tab shows who was called, what was said and what it cost — that
  // is customer information, so it sits with the other customer surfaces.
  // Starting a call needs customers.write, enforced at the route, not here.
  // Editing what the agent says is configuration, so it sits with the other
  // config screens. Listed before the general /voice rule because first match wins.
  [/^\/voice\/settings/, "workflows.manage"],
  // Same reasoning, same answer: /voice/whatsapp-training edits the instruction
  // block the WhatsApp assistant runs on when it answers buyers. It sat under
  // the general /voice rule, so anybody with `customers.read` could open it —
  // and the API behind it had no permission check at all, which made the pair a
  // way for the front desk to rewrite what the company tells its customers.
  [/^\/voice\/whatsapp-training/, "workflows.manage"],
  [/^\/voice/, "customers.read"],

  // Marketing surfaces
  [/^\/(studio|ideas|calendar|board|local|showcase)/, "marketing.read"],
  // The per-channel tabs read the brand's own organic performance and write
  // nothing, so they take the marketing read permission. Listed explicitly
  // because an unmapped path is denied: without this line the Channels group
  // would render for nobody.
  [/^\/channels/, "marketing.read"],
  // The "Publish video" screen (still /automation — the path never changed) is
  // `marketing.read` rather than `workflows.manage`
  // because its everyday half is the video-posting form, and the people who
  // post videos are not the people who administer integrations. Nothing is
  // weakened by that: the webhook registry it displays is fetched from an API
  // gated on `workflows.manage` and renders that refusal when it comes, and
  // submitting a video needs `marketing.publish` at the route. One gate per
  // capability, each on the data rather than on the door.
  [/^\/automation/, "marketing.read"],
  [/^\/publish-v2/, "marketing.read"],

  // Configuration
  [/^\/(connections|settings)/, "workflows.manage"],
];

/**
 * Paths any signed-in person may open. The sign-in and setup screens are not
 * listed because they no longer live under this layout at all — they are in the
 * `(auth)` route group, which has no navigation to leak and no guard to loop on.
 */
const ALWAYS_ALLOWED = [/^\/ops$/, /^\/$/];

export function requiredPermissionFor(pathname: string): Permission | null | "allow" {
  if (ALWAYS_ALLOWED.some((r) => r.test(pathname))) return "allow";
  for (const [pattern, permission] of RULES) {
    if (pattern.test(pathname)) return permission;
  }
  // Unlisted paths are denied by default rather than quietly permitted.
  return null;
}
