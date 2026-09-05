import fs from "node:fs";
import Link from "next/link";
import path from "node:path";
import { AlertTriangle, ArrowLeft, Check, Circle, X } from "lucide-react";
import { activeProvider } from "@/lib/ai/provider";
import { checkSupabase, hasServiceRole, isSupabaseConfigured, supabaseUrl } from "@/lib/supabase/client";
import { checkUploadPostStatus } from "@/lib/uploadpost/client";
import { checkGoogleSheetsStatus } from "@/lib/sheets/client";
import { checkBolnaStatus } from "@/lib/bolna/client";
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
  const [supabase, uploadPost, sheets, bolna] = await Promise.all([
    checkSupabase(),
    checkUploadPostStatus(),
    checkGoogleSheetsStatus(),
    checkBolnaStatus(),
  ]);

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
    {
      label: "Upload-Post (Instagram & YouTube)",
      state: uploadPost.configured ? (uploadPost.valid ? "ok" : "partial") : "missing",
      detail: uploadPost.valid
        ? `${uploadPost.email ?? "connected"} · IG: ${uploadPost.connectedAccounts.instagram?.handle ?? "linked"} · YT: ${uploadPost.connectedAccounts.youtube?.handle ?? "linked"}`
        : uploadPost.error ?? "UPLOAD_POST_API_KEY not set in .env.local",
      action: "upload-post.com → API key in .env.local",
    },
    {
      label: "Google Sheets API",
      state: sheets.configured ? (sheets.valid ? "ok" : "partial") : "missing",
      detail: sheets.message,
      action: "Google Cloud → Credentials → API Key in .env.local",
    },
    {
      label: "Bolna AI Voice Agents",
      state: bolna.configured ? (bolna.valid ? "ok" : "partial") : "missing",
      detail: bolna.message,
      action: "bolna.ai → API Keys → BOLNA_API_KEY in .env.local",
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
    <div className="relative min-h-screen app-ambient px-5 py-10 sm:px-8">
      <div className="app-ambient-glow" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-3xl space-y-6">
        <Link
          href="/signin"
          className="inline-flex items-center gap-1.5 text-[12px] text-mist-400 transition-colors hover:text-mist-200"
        >
          <ArrowLeft size={13} /> Back to sign in
        </Link>
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight gradient-heading">Setup &amp; connections</h1>
          <p className="mt-1 text-[13px] text-mist-400">
            Live infrastructure probe across database, storage, AI, telephony, and social APIs.
          </p>
        </div>

        {blocking.length > 0 && (
          <Card variant="liquid" className="border-warn-500/30 bg-warn-500/[0.06] backdrop-blur-2xl">
            <div className="flex gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-warn-400" />
              <div className="text-[13px] leading-relaxed text-mist-300">
                <strong className="text-mist-100">{blocking.length} integration(s) require configuration.</strong> Until they
                are set, affected sub-systems remain gracefully inert — live calls won't fail with raw errors.
              </div>
            </div>
          </Card>
        )}

        <Card variant="liquid">
          <SectionTitle title="Live Integration Matrix" hint="Probed live on every page load" />
          <div className="space-y-3">
            {rows.map((r) => (
              <div
                key={r.label}
                className="liquid-glass-card liquid-glass-interactive flex flex-wrap items-start gap-3.5 rounded-2xl p-4 border border-white/15 dark:border-white/10"
              >
                <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-full bg-ink-800/90 shadow-inner">
                  {r.state === "ok" ? (
                    <Check size={14} className="text-good-400" />
                  ) : r.state === "partial" ? (
                    <Circle size={14} className="text-warn-400" />
                  ) : (
                    <X size={14} className="text-bad-400" />
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13.5px] font-bold text-mist-100">{r.label}</span>
                  <span className="block text-[12px] text-mist-400 mt-0.5">{r.detail}</span>
                </span>
                <Badge
                  tone={r.state === "ok" ? "good" : r.state === "partial" ? "warn" : "bad"}
                  pulse={r.state === "ok"}
                >
                  {r.state === "ok" ? "ready" : r.state === "partial" ? "partial" : "not set"}
                </Badge>
                {r.action && <span className="w-full text-[11px] text-mist-500 sm:w-auto font-mono">{r.action}</span>}
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
    </div>
  );
}
