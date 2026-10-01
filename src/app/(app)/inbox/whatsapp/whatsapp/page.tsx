import { Badge, Card, PageHeader, type BadgeTone } from "@/components/osf/ui";
import { redirect } from "next/navigation";
import { whatsappReadiness, type Check } from "@/lib/osf/whatsapp/readiness";
import { operatorNote, operatorText, showOperatorDetail } from "@/lib/whitelabel";
import { VoiceTester } from "./VoiceTester";

export const dynamic = "force-dynamic";

const TONE: Record<string, BadgeTone> = {
  ok: "success",
  missing: "warning",
  error: "danger",
  checking: "neutral",
};

const LABEL: Record<string, string> = {
  ok: "Ready",
  missing: "Not set",
  error: "Error",
  checking: "…",
};

function CheckRow({ check }: { check: Check }) {
  return (
    <li className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] py-3.5 last:border-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{check.label}</span>
          {check.blocking && check.state !== "ok" && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--color-danger)]">
              blocks go-live
            </span>
          )}
        </div>
        {/* Readiness text is written for an operator; it is rewritten in plain
            language before a client sees it. */}
        <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted)]">{operatorText(check.detail)}</p>
        {check.fix && check.state !== "ok" && (
          <p className="mt-1 text-xs text-[var(--color-gold-300)]">→ {operatorText(check.fix)}</p>
        )}
      </div>
      <Badge tone={TONE[check.state]}>{LABEL[check.state]}</Badge>
    </li>
  );
}

/**
 * The go-live checklist is an operator's screen, not the client's.
 *
 * Its rows name the messaging vendor, the AI vendor and the hosting
 * arrangement, and they print raw API error bodies with their status codes —
 * "Evolution server connected", "Meta rejected the credentials (401)". It used
 * to be reachable by anyone holding `workflows.manage`, which the client's own
 * administrator holds, so the permission was never the right gate for it.
 *
 * SHOW_VENDOR_DIAGNOSTICS is set on the operator's own deployments and not on
 * the client's, which is the same switch the rest of the vendor-facing
 * surfaces already use.
 */
export default async function WhatsAppPage() {
  if (!showOperatorDetail()) redirect("/settings/whatsapp");

  const { checks, ready, blockingCount } = await whatsappReadiness();

  return (
    <>
      <PageHeader
        title="WhatsApp"
        sub="Everything the agent needs to answer real customers on WhatsApp — chat and voice notes. Each row is checked live, not read from a saved setting."
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          gold={ready}
          title={ready ? "Ready to go live" : `${blockingCount} thing${blockingCount === 1 ? "" : "s"} left`}
          hint={
            ready
              ? "Point the Meta webhook at your deployed /api/osf/whatsapp and messages will start flowing."
              : "Rows marked as blocking must be resolved before real customers can reach the agent."
          }
        >
          <ul>
            {checks.map((c) => (
              <CheckRow key={c.id} check={c} />
            ))}
          </ul>
        </Card>

        <div className="space-y-4">
          <Card title="Webhook settings" hint="Paste these into Meta → WhatsApp → Configuration.">
            <dl className="space-y-3 text-sm">
              <div>
                <dt className="label">Callback URL</dt>
                <dd className="mt-1 break-all rounded-lg bg-[var(--color-void)] px-3 py-2 font-mono text-xs">
                  {(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "")}
                  /api/osf/whatsapp
                </dd>
              </div>
              <div>
                <dt className="label">Verify token</dt>
                <dd className="mt-1 text-xs text-[var(--color-muted)]">
                  {operatorNote(
                    "whatsappVerifyToken",
                    "The verification word an administrator chose when this console was set up — type the same string into Meta.",
                  )}
                </dd>
              </div>
              <div>
                <dt className="label">Subscribe to</dt>
                <dd className="mt-1 text-xs text-[var(--color-muted)]">
                  The <code className="text-[var(--color-gold-300)]">messages</code> field. That one
                  covers text, voice notes, images and button replies.
                </dd>
              </div>
            </dl>
          </Card>

          {/* Tunnelling instructions are for whoever deploys the console, not
              for the business using it. */}
          {showOperatorDetail() && (
            <Card title="Testing locally" hint="Meta cannot call localhost.">
              <p className="text-xs leading-relaxed text-[var(--color-muted)]">
                Expose this machine with a tunnel, then use the https URL it prints as the callback:
              </p>
              <code className="mt-2 block rounded-lg bg-[var(--color-void)] px-3 py-2 font-mono text-xs">
                npx ngrok http 3000
              </code>
              <p className="mt-3 text-xs leading-relaxed text-[var(--color-muted)]">
                {operatorNote(
                  "whatsappPublicUrl",
                  "Point the console's public web address at that same https URL, or brochure links the agent sends will point at this machine and fail when WhatsApp tries to fetch them.",
                )}
              </p>
            </Card>
          )}
        </div>
      </div>

      <div className="mt-4">
        <VoiceTester />
      </div>
    </>
  );
}
