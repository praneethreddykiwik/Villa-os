import fs from "node:fs";
import Link from "next/link";
import path from "node:path";
import { AlertTriangle, ArrowLeft, Check, Circle, X } from "lucide-react";
import { activeProvider } from "@/lib/ai/provider";
import { checkSupabase, hasServiceRole, isSupabaseConfigured, supabaseUrl } from "@/lib/supabase/client";
import { Badge, Card, SectionTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * Setup & connection status.
 *
 * Exists so nobody has to guess whether an integration is genuinely wired.
 * Every row is a live probe, not a stored flag — a page that says "connected"
 * because a boolean was set once is exactly the fake-integration problem this
 * platform is supposed to avoid.
 */

interface Row {
  label: string;
  state: "ok" | "missing" | "partial";
  detail: string;
  action?: string;
}

/**
 * The AI row is "any of these", not "all of these".
 *
 * `envRow` reports partial when some keys are missing, which is right for a
 * provider that needs both an id and a secret. Three interchangeable LLM
 * providers are the opposite case: one key is a complete configuration and
 * demanding all three would report a healthy install as broken.
 */
function aiRow(): Row {
  const active = activeProvider();
  return {
    label: "AI provider (copy, replies, extraction)",
    state: active ? "ok" : "missing",
    detail: active ? `${active.label} · ${active.model}` : "no GROQ_API_KEY, GEMINI_API_KEY or ANTHROPIC_API_KEY set",
    action: active
      ? "AI_PROVIDER pins one; auto falls through to the next on an outage"
      : "console.groq.com or aistudio.google.com — optional; engines fall back to deterministic",
  };
}

function envRow(label: string, keys: string[], action: string): Row {
  const present = keys.filter((k) => Boolean(process.env[k]));
  return {
    label,
    state: present.length === keys.length ? "ok" : present.length ? "partial" : "missing",
    detail: present.length === keys.length
      ? "configured"
      : `missing ${keys.filter((k) => !process.env[k]).join(", ")}`,
    action,
  };
}

export default async function SetupPage() {
  const supabase = await checkSupabase();

  const migrationsDir = path.join(process.cwd(), "supabase", "migrations");
  // Only live migrations; superseded ones live in supabase/superseded/ and must
  // not be applied — they overlap with 0002 and would conflict.
  const migrations = fs.existsSync(migrationsDir)
    ? fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()
    : [];

  const rows: Row[] = [
    {
      label: "Supabase project",
      state: supabase.configured ? (supabase.reachable ? "ok" : "partial") : "missing",
      detail: supabase.configured ? `${supabaseUrl()} — ${supabase.detail}` : "NEXT_PUBLIC_SUPABASE_URL / _ANON_KEY not set",
      action: "Project Settings → API",
    },
    {
      label: "Database schema",
      state: supabase.schemaApplied ? "ok" : "missing",
      detail: supabase.schemaApplied
        ? "tables present"
        : `not applied — run ${migrations.join(", ")} in the SQL editor`,
      action: "SQL Editor → paste each migration in order",
    },
    {
      label: "Service role key",
      state: hasServiceRole() ? "ok" : "missing",
      detail: hasServiceRole()
        ? "set — staff provisioning and background jobs available"
        : "needed to create staff accounts with confirmed emails and to run background jobs",
      action: "Project Settings → API → service_role → paste into .env.local",
    },
    envRow("WhatsApp Cloud API", ["WHATSAPP_PHONE_NUMBER_ID", "META_SYSTEM_USER_TOKEN", "WHATSAPP_VERIFY_TOKEN", "META_APP_SECRET"], "Meta App → WhatsApp → API setup"),
    envRow("Meta (Instagram + Facebook)", ["META_APP_ID", "META_APP_SECRET"], "developers.facebook.com → App → Settings"),
    envRow("Google (YouTube / Business Profile)", ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"], "Google Cloud → Credentials → OAuth client"),
    envRow("LinkedIn", ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"], "linkedin.com/developers → App → Auth"),
    aiRow(),
  ];

  const blocking = rows.filter((r) => r.state !== "ok");

  return (
    // Reachable without signing in, on purpose: when authentication itself is
    // misconfigured, a diagnostic page behind authentication is useless.
    <div className="mx-auto w-full max-w-3xl space-y-5 px-5 py-10 sm:px-8">
      <Link
        href="/signin"
        className="inline-flex items-center gap-1.5 text-[12px] text-mist-400 transition-colors hover:text-mist-200"
      >
        <ArrowLeft size={13} /> Back to sign in
      </Link>
      <div>
        <h1 className="text-[21px] font-semibold tracking-tight">Setup &amp; connections</h1>
        <p className="mt-1 text-[12.5px] text-mist-400">
          Every row below is a live check. Nothing here reports &ldquo;connected&rdquo; from a stored flag.
        </p>
      </div>

      {blocking.length > 0 && (
        <Card className="border-warn-500/30 bg-warn-500/[0.05]">
          <div className="flex gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn-400" />
            <div className="text-[12.5px] leading-relaxed text-mist-300">
              <strong className="text-mist-100">{blocking.length} item(s) still need configuration.</strong> Until they
              are set, the affected features are inert by design rather than pretending to work — publishing will not
              call an API it has no token for, and the AI will not message a customer through a channel that is not
              connected.
            </div>
          </div>
        </Card>
      )}

      <Card>
        <SectionTitle title="Status" hint="Probed on every page load" />
        <div className="space-y-2">
          {rows.map((r) => (
            <div key={r.label} className="flex flex-wrap items-start gap-3 rounded-xl border border-ink-700 p-3">
              <span className="mt-0.5">
                {r.state === "ok" ? (
                  <Check size={15} className="text-good-400" />
                ) : r.state === "partial" ? (
                  <Circle size={15} className="text-warn-400" />
                ) : (
                  <X size={15} className="text-bad-400" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-mist-100">{r.label}</span>
                <span className="block text-[11.5px] text-mist-400">{r.detail}</span>
              </span>
              <Badge tone={r.state === "ok" ? "good" : r.state === "partial" ? "warn" : "bad"}>
                {r.state === "ok" ? "ready" : r.state === "partial" ? "partial" : "not set"}
              </Badge>
              {r.action && <span className="w-full text-[10.5px] text-mist-500 sm:w-auto">{r.action}</span>}
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle title="Applying the schema" hint="Two files, in order, in the Supabase SQL editor" />
        <ol className="space-y-2 text-[12.5px] leading-relaxed text-mist-300">
          <li>
            <span className="font-medium text-mist-100">1.</span> Open your project → <em>SQL Editor</em> → New query.
          </li>
          <li>
            <span className="font-medium text-mist-100">2.</span> Paste{" "}
            <code className="rounded bg-ink-800 px-1">supabase/migrations/0002_glentree_platform.sql</code> and run it.
            This creates the tables, the permission catalogue and every RLS policy.
          </li>
          <li>
            <span className="font-medium text-mist-100">3.</span> Paste{" "}
            <code className="rounded bg-ink-800 px-1">supabase/migrations/0003_glentree_bootstrap.sql</code> and run it.
            This creates the Glentree organization, seven roles with their permission grants, the workflow stages and a
            starter pricing sheet. It creates no users and no passwords.
          </li>
          <li>
            <span className="font-medium text-mist-100">4.</span> Add the service-role key to{" "}
            <code className="rounded bg-ink-800 px-1">.env.local</code>, then provision staff with{" "}
            <code className="rounded bg-ink-800 px-1">npm run provision-users</code>.
          </li>
        </ol>
        <p className="mt-3 text-[11.5px] text-mist-400">
          Both files are idempotent — re-running them is safe.
        </p>
      </Card>
    </div>
  );
}
