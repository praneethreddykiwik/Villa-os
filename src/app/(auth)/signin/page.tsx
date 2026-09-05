import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { resolveSession } from "@/lib/auth/session";
import { isSupabaseConfigured } from "@/lib/supabase/client";
import { BrandPanel } from "@/components/auth/brand-panel";
import { RotatePasswordForm, SignInForm } from "@/components/auth/sign-in-form";
import { SignedOutNotice } from "@/components/auth/signed-out-notice";
import { GlentreeMark } from "@/components/auth/mark";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Sign in · Glentree",
  description: "Sign in to your workspace.",
};

/**
 * The only screen a signed-out visitor can reach.
 *
 * Two columns above 1024px — what the product is, and the way in — collapsing
 * to the form alone on narrower viewports, where the marketing half would only
 * push the fields below the fold.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const raw = typeof sp.next === "string" ? sp.next : undefined;
  // Only ever an internal path: "//evil.example" is a protocol-relative URL and
  // would send someone straight off this site after they signed in.
  const next = raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : undefined;

  // The callback route redirects here with a reason when a link fails. Each
  // message is generic on purpose: "expired" and "already used" and "forged"
  // are the same sentence, so a probe learns nothing from the difference.
  const CALLBACK_ERRORS: Record<string, string> = {
    "link-expired": "That sign-in link has expired or was already used. Request a new one.",
    "link-invalid": "That sign-in link was incomplete. Request a new one.",
    "auth-not-configured": "Sign-in is not configured on this deployment.",
  };
  const initialError = typeof sp.error === "string" ? CALLBACK_ERRORS[sp.error] : undefined;

  const result = await resolveSession();
  // A live session goes straight through — unless it is still carrying the
  // temporary password an administrator issued, in which case this screen is
  // where it gets replaced.
  if (result.status === "active" && !result.session.mustChangePassword) {
    redirect(next && next !== "/signin" ? next : "/ops");
  }
  const rotating = result.status === "active" && result.session.mustChangePassword;

  return (
    // Capped and centred rather than edge-to-edge: on a wide monitor an
    // unconstrained two-column split leaves a void down the middle and the two
    // halves stop reading as one composition.
    <div className="mx-auto grid w-full max-w-[1180px] flex-1 items-center lg:grid-cols-[1fr_minmax(0,404px)] lg:gap-16 xl:gap-20">
      <BrandPanel />

      <div className="flex items-center justify-center px-5 py-12 sm:px-8 lg:px-0">
        <div className="w-full max-w-[404px]">
          {/* The mark repeats here only where the brand panel is hidden, so the
              wide layout never shows it twice. */}
          <div className="mb-7 flex flex-col items-center gap-3 text-center lg:hidden">
            <GlentreeMark size={54} />
            <div>
              <div className="text-[19px] font-semibold tracking-tight text-mist-100">Glentree</div>
              <div className="text-[12px] text-mist-500">Social · Ads · CRM · Operations</div>
            </div>
          </div>

          <div className="auth-card p-7 sm:p-8">
            {!isSupabaseConfigured() ? (
              <NotConfigured />
            ) : rotating ? (
              <RotatePasswordForm nextPath={next} />
            ) : result.status === "anonymous" ? (
              <SignInForm
                nextPath={next}
                initialError={initialError}
                googleEnabled={process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === "true"}
              />
            ) : result.status === "unprovisioned" || result.status === "disabled" ? (
              <SignedOutNotice email={result.email} reason={result.status} />
            ) : null}
          </div>

          <p className="mt-5 text-center text-[11.5px] leading-relaxed text-mist-500">
            Accounts are created by an administrator, so that only people who should see customer
            information can. Ask your admin to add you.
          </p>
          <p className="mt-2.5 text-center text-[11.5px] text-mist-500">
            <Link href="/setup" className="underline decoration-ink-600 underline-offset-4 hover:text-mist-300">
              Check connection status
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}

function NotConfigured() {
  return (
    <div>
      <span className="grid h-10 w-10 place-items-center rounded-xl bg-warn-500/12 text-warn-400">
        <AlertTriangle size={18} />
      </span>
      <h1 className="mt-4 text-[20px] font-semibold tracking-tight text-mist-100">Not configured yet</h1>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">
        Sign-in needs a Supabase project. Nothing here is broken — the credentials simply have not
        been added to this deployment.
      </p>
      <Link
        href="/setup"
        className="mt-6 flex w-full items-center justify-center rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] font-medium text-mist-100 transition-colors hover:border-ink-600 hover:bg-ink-800"
      >
        See what is missing
      </Link>
    </div>
  );
}
