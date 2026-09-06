import { Badge, Card, SectionTitle } from "@/components/ui";

/**
 * ADMIN DIAGNOSTICS — the one place vendor names are allowed on screen.
 *
 * Everyone else sees neutral product wording ("AI writer", "Voice agent",
 * "Publishing connector"); the person who administers the install needs the
 * real names to know which dashboard to open when something is down. Rendered
 * only behind `users.manage` — the caller checks, this file just draws. It is
 * excluded by name from tests/whitelabel.test.ts, so nothing in it may be
 * imported into a non-admin surface.
 */
export interface DiagnosticRow {
  product: string;
  vendor: string;
  configured: boolean;
  detail?: string;
}

export function vendorDiagnostics(aiProvider: { label: string; model: string } | null): DiagnosticRow[] {
  const set = (k: string) => Boolean(process.env[k]?.trim());
  return [
    { product: "AI writer", vendor: aiProvider?.label ?? "Groq / Gemini / Anthropic", configured: Boolean(aiProvider), detail: aiProvider ? aiProvider.model : "GROQ_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY" },
    { product: "Voice agent", vendor: "Bolna", configured: set("BOLNA_API_KEY"), detail: "BOLNA_API_KEY" },
    { product: "Publishing connector", vendor: "Upload-Post", configured: set("UPLOAD_POST_API_KEY"), detail: "UPLOAD_POST_API_KEY · UPLOAD_POST_USER" },
    { product: "Publishing workflow", vendor: "n8n", configured: set("N8N_VIDEO_FORM_URL") && set("N8N_WEBHOOK_SECRET"), detail: "N8N_VIDEO_FORM_URL · N8N_WEBHOOK_SECRET" },
    { product: "Database & sign-in", vendor: "Supabase", configured: set("NEXT_PUBLIC_SUPABASE_URL") && set("NEXT_PUBLIC_SUPABASE_ANON_KEY"), detail: set("SUPABASE_SERVICE_ROLE_KEY") ? "service role set" : "SUPABASE_SERVICE_ROLE_KEY unset — accounts cannot be created" },
  ];
}

export function AdminDiagnostics({ rows }: { rows: DiagnosticRow[] }) {
  return (
    <Card>
      <SectionTitle title="Vendor diagnostics" hint="Administrators only — which service sits behind each product name" />
      <div className="grid gap-2 md:grid-cols-2">
        {rows.map((r) => (
          <div key={r.product} className="flex items-start gap-3 rounded-lg border border-ink-700 p-3">
            <Badge tone={r.configured ? "good" : "warn"}>{r.configured ? "configured" : "not set"}</Badge>
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-mist-100">{r.product} <span className="text-mist-400">· {r.vendor}</span></div>
              {r.detail && <div className="font-mono text-[10.5px] text-mist-400">{r.detail}</div>}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
