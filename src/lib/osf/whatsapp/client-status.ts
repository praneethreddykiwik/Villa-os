import "server-only";
import { whatsappReadiness } from "./readiness";

/**
 * WHATSAPP STATUS, IN THE CLIENT'S OWN TERMS.
 *
 * The readiness checks underneath this are an operator's tool. Their labels and
 * details name the messaging vendor, the AI vendor and the hosting arrangement,
 * print raw API error bodies with their status codes, and tell the reader which
 * environment variables are unset. That is the right amount of detail for
 * whoever has to fix it, and the wrong thing to put in front of the business
 * that bought the product.
 *
 * So this reads the same checks and throws every string away. Only the state is
 * taken — ok or not — and the wording below is written fresh, in terms of what
 * the business can actually do about it. Nothing from `check.label`,
 * `check.detail` or `check.fix` reaches a screen through this module, which is
 * what makes it safe to show without a permission gate.
 */

export interface StatusRow {
  label: string;
  ready: boolean;
  detail: string;
}

/**
 * Each row answers one question an owner would actually ask. The checks behind
 * them are matched by id, and any check not listed here is deliberately not
 * surfaced: transport selection, webhook secrets, database functions and the
 * public URL are all real concerns, and none of them are this reader's.
 */
const ROWS: Array<{ ids: string[]; label: string; ready: string; pending: string }> = [
  {
    ids: ["phone", "evolution"],
    label: "WhatsApp number",
    ready: "Connected — the assistant can send and receive.",
    pending: "Not connected yet. Your administrator needs to finish setting it up.",
  },
  {
    ids: ["kb"],
    label: "Villa information",
    ready: "The assistant has projects and prices it can quote.",
    pending: "Nothing to quote yet — add a project under Properties.",
  },
  {
    ids: ["voice"],
    label: "Voice notes",
    ready: "Customers can send voice notes in any language.",
    pending: "Not available yet — customers are asked to type instead.",
  },
  {
    ids: ["handoff"],
    label: "Hot-lead alerts",
    ready: "A rep is notified the moment a buyer is ready to talk.",
    pending: "No rep number set — handoffs are recorded, but nobody is notified.",
  },
];

export async function whatsappClientStatus(): Promise<{ rows: StatusRow[]; allReady: boolean } | null> {
  const readiness = await whatsappReadiness().catch(() => null);
  if (!readiness) return null;

  const stateById = new Map(readiness.checks.map((c) => [c.id, c.state]));

  const rows: StatusRow[] = [];
  for (const row of ROWS) {
    // A row backed by several checks is ready when ANY of them is: the number
    // is reachable one way or another, and which way is not the reader's
    // business.
    const states = row.ids.map((id) => stateById.get(id)).filter(Boolean);
    if (states.length === 0) continue;
    const ready = states.some((s) => s === "ok");
    rows.push({ label: row.label, ready, detail: ready ? row.ready : row.pending });
  }

  return { rows, allReady: rows.every((r) => r.ready) };
}
