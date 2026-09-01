import { LogOut } from "lucide-react";
import { signOut } from "@/app/(auth)/signin/actions";

/**
 * Shown when Supabase recognises the credential but this organisation has no
 * active profile for it.
 *
 * Without this the person was sent straight back to the sign-in form they had
 * just completed successfully, which reads as "wrong password" when the real
 * answer is "an administrator has not added you yet". Signing out is a server
 * action, so this stays a server component and ships no JavaScript at all.
 */
export function SignedOutNotice({
  email,
  reason,
}: {
  email: string;
  reason: "unprovisioned" | "disabled";
}) {
  return (
    <div>
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-mist-100">
        {reason === "disabled" ? "This account is switched off" : "You are not on this workspace yet"}
      </h1>
      <p className="mt-2 text-[13px] leading-relaxed text-mist-400">
        {reason === "disabled" ? (
          <>
            <span className="text-mist-200">{email}</span> signed in correctly, but an administrator
            has disabled the account. Nothing is lost — it can be switched back on.
          </>
        ) : (
          <>
            <span className="text-mist-200">{email}</span> signed in correctly, but it has not been
            given a role here yet. Access to customer records is granted deliberately, one person at
            a time, rather than to anyone who can sign in.
          </>
        )}
      </p>
      <p className="mt-3 text-[13px] leading-relaxed text-mist-400">
        Ask an administrator to open{" "}
        <span className="text-mist-200">Control centre → People &amp; access</span> and add you.
      </p>
      <form action={signOut}>
        <button
          type="submit"
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] font-medium text-mist-100 transition-colors hover:border-ink-600 hover:bg-ink-800"
        >
          <LogOut size={14} />
          Sign out and try another account
        </button>
      </form>
    </div>
  );
}
