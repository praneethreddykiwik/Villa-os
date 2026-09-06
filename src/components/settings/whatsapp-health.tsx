import { Badge, Card, SectionTitle } from "@/components/ui";
import type { WhatsAppHealth } from "@/lib/platforms/whatsapp-health";

/** Admin-only (users.manage) WhatsApp readiness card. The page checks; this draws. */
export function WhatsAppHealthCard({ h }: { h: WhatsAppHealth }) {
  const p = h.phone;
  const rows: Array<{ label: string; value: string; ok: boolean; hint: string }> = [
    {
      label: "Phone number",
      value: !h.phoneNumberId ? "unset" : !h.tokenSet ? "no token" : p?.error ? "error" : p?.displayNumber ?? "resolving",
      ok: Boolean(p?.displayNumber),
      hint: !h.phoneNumberId
        ? "WHATSAPP_PHONE_NUMBER_ID is empty"
        : p?.error
          ? p.error
          : p
            ? `${p.verifiedName ?? "no display name"} · name ${p.nameStatus ?? "?"} · id ${h.phoneNumberId}`
            : "Set META_SYSTEM_USER_TOKEN to resolve the number",
    },
    {
      label: "Quality rating",
      value: p?.qualityRating ?? "unknown",
      ok: p?.qualityRating === "GREEN",
      hint: "GREEN is healthy; YELLOW/RED lowers the daily messaging limit",
    },
    { label: "Verify token", value: h.verifyTokenSet ? "set" : "unset", ok: h.verifyTokenSet, hint: "WHATSAPP_VERIFY_TOKEN — webhook subscription handshake fails without it" },
    { label: "Webhook signature", value: h.appSecretSet ? "set" : "unset", ok: h.appSecretSet, hint: "META_APP_SECRET — inbound webhooks are rejected (401) until set" },
    { label: "Public URL", value: h.publicBaseUrl || "unset", ok: Boolean(h.publicBaseUrl), hint: h.publicBaseUrl ? `Webhook: ${h.publicBaseUrl.replace(/\/$/, "")}/api/webhooks/whatsapp` : "PUBLIC_BASE_URL — needed for the webhook callback and media links" },
    {
      label: "Last inbound message",
      value: h.lastInboundAt ? new Date(h.lastInboundAt).toLocaleString() : "never",
      ok: Boolean(h.lastInboundAt),
      hint: h.lastInboundAt ? "The webhook has delivered at least once" : "No customer message has reached the webhook yet",
    },
    { label: "AI writer", value: h.aiWriterReady ? "ready" : "not configured", ok: h.aiWriterReady, hint: h.aiWriterReady ? "Replies are drafted by the AI writer" : "Deterministic replies only until an AI writer is connected" },
  ];
  return (
    <Card>
      <SectionTitle title="WhatsApp health" hint="Read-only checks for the business number and webhook (admins only)" />
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-start gap-3 rounded-lg border border-ink-700 p-3">
            <Badge tone={r.ok ? "good" : "warn"}>{r.value}</Badge>
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-mist-100">{r.label}</div>
              <div className="break-all text-[11px] text-mist-400">{r.hint}</div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
