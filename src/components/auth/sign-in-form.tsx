"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { AnimatePresence, LazyMotion, m, useReducedMotion } from "motion/react";
import { ArrowRight, Check, Eye, EyeOff, Loader2, Lock, Mail, TriangleAlert } from "lucide-react";
import {
  rotatePassword as rotate,
  sendMagicLink,
  signInWithPassword,
  startGoogle,
  type AuthState,
} from "@/app/(auth)/signin/actions";

type Mode = "password" | "link";

/** One shared easing so every transition on this screen feels like one system. */
const EASE = [0.22, 0.7, 0.25, 1] as const;

/**
 * Motion covers exactly one thing on this screen: animating the outgoing method
 * panel *out* while the incoming one comes in. React unmounts the old subtree
 * immediately, so no amount of CSS can animate it — that is the single job CSS
 * genuinely cannot do here, and the only reason an animation library is on this
 * page at all.
 *
 * Everything else — the entrance, the sliding pill, the ambient background, the
 * button sheen — is CSS, so none of it waits on a bundle and none of it breaks
 * if the bundle never arrives. The features below load in a deferred chunk for
 * the same reason: the form is on screen and usable first.
 */
const loadMotionFeatures = () => import("./motion-features").then((mod) => mod.default);

const EMPTY: AuthState = {};

/**
 * Sign in.
 *
 * Every submission goes to a server action, not to Supabase from the browser.
 * That keeps the attempt inside this application's rate limiter, keeps the
 * Supabase client out of the bundle, and — because a server action is reached
 * by an ordinary form POST — means these forms still work while the JavaScript
 * is still downloading, or if it never arrives at all.
 *
 * Accounts are created by an administrator, not self-registered. Anyone able to
 * sign themselves up would be able to see customer records, so the reference
 * design's "Create account" tab is intentionally absent rather than present and
 * disabled — offering a door that will never open is worse than no door.
 */
export function SignInForm({
  nextPath,
  initialError,
  googleEnabled = false,
}: {
  nextPath?: string;
  /** A failure carried over from the magic-link / OAuth callback. */
  initialError?: string;
  googleEnabled?: boolean;
}) {
  const [mode, setMode] = useState<Mode>("password");
  const [reveal, setReveal] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [dismissedInitial, setDismissedInitial] = useState(false);

  const [pwState, pwSubmit, pwPending] = useActionState(signInWithPassword, EMPTY);
  const [linkState, linkSubmit, linkPending] = useActionState(sendMagicLink, EMPTY);
  const [googleState, googleSubmit, googlePending] = useActionState(startGoogle, EMPTY);

  const emailRef = useRef<HTMLInputElement>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    emailRef.current?.focus();
  }, []);

  function watchCaps(e: React.KeyboardEvent<HTMLInputElement>) {
    setCapsLock(e.getModifierState?.("CapsLock") ?? false);
  }

  const active = mode === "password" ? pwState : linkState;
  const error = active.error ?? googleState.error ?? (dismissedInitial ? undefined : initialError);
  const notice = active.notice;

  return (
    <LazyMotion features={loadMotionFeatures} strict>
      <div className="auth-enter w-full">
        <Header title="Welcome back" subtitle="Sign in with your work email address." />

        {/* Two real ways in. The pill slides rather than cuts, so the eye tracks
            which one is active without re-reading both labels. It is a CSS
            transform between two fixed positions — a shared-layout animation
            would need the projection engine for a movement the compositor
            already does for free. */}
        <div role="tablist" aria-label="Sign-in method" className="auth-tabs mt-6">
          <span className="auth-tab-pill" data-index={mode === "password" ? 0 : 1} aria-hidden="true" />
          {(
            [
              { id: "password", label: "Password", icon: Lock },
              { id: "link", label: "Email link", icon: Mail },
            ] as const
          ).map((t) => {
            const on = mode === t.id;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                role="tab"
                type="button"
                aria-selected={on}
                onClick={() => {
                  setMode(t.id);
                  setDismissedInitial(true);
                }}
                className={`relative z-10 flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-medium transition-colors ${
                  on ? "text-mist-100" : "text-mist-400 hover:text-mist-200"
                }`}
              >
                <Icon size={13} />
                {t.label}
              </button>
            );
          })}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={mode}
            initial={reduced ? false : { opacity: 0, x: mode === "password" ? -8 : 8 }}
            animate={{ opacity: 1, x: 0 }}
            exit={reduced ? undefined : { opacity: 0, x: mode === "password" ? 8 : -8 }}
            transition={{ duration: 0.18, ease: EASE }}
          >
            {mode === "password" ? (
              <form action={pwSubmit} className="mt-5 space-y-4">
                <input type="hidden" name="next" value={nextPath ?? ""} />
                <Field label="Email">
                  <input
                    ref={emailRef}
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="username"
                    required
                    placeholder="you@company.com"
                    aria-invalid={Boolean(error)}
                    className="auth-field"
                  />
                </Field>

                <Field
                  label="Password"
                  // Caps Lock silently causes most "my password stopped working"
                  // reports. Warning in the label row costs one line and, unlike
                  // a message under the field, moves nothing on screen while
                  // someone is part-way through typing.
                  hint={
                    capsLock ? (
                      <span className="flex items-center gap-1 text-warn-400">
                        <TriangleAlert size={11} /> Caps Lock
                      </span>
                    ) : null
                  }
                >
                  <div className="relative">
                    <input
                      name="password"
                      type={reveal ? "text" : "password"}
                      autoComplete="current-password"
                      required
                      onKeyUp={watchCaps}
                      onKeyDown={watchCaps}
                      aria-invalid={Boolean(error)}
                      className="auth-field pr-11"
                    />
                    <button
                      type="button"
                      onClick={() => setReveal((v) => !v)}
                      aria-label={reveal ? "Hide password" : "Show password"}
                      className="absolute right-1.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-lg text-mist-500 transition-colors hover:bg-ink-800 hover:text-mist-200"
                    >
                      {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </Field>

                <Message error={error} notice={notice} />
                <Submit busy={pwPending} icon={<ArrowRight size={15} />} label="Sign in" />
              </form>
            ) : (
              <form action={linkSubmit} className="mt-5 space-y-4">
                <input type="hidden" name="next" value={nextPath ?? ""} />
                <Field label="Email">
                  <input
                    name="email"
                    type="email"
                    inputMode="email"
                    autoComplete="username"
                    required
                    placeholder="you@company.com"
                    className="auth-field"
                  />
                  <p className="mt-1.5 text-[11.5px] leading-relaxed text-mist-500">
                    We email a one-time link instead of asking for a password. It works only for
                    accounts that already exist — a link request never creates one.
                  </p>
                </Field>
                <Message error={error} notice={notice} />
                <Submit busy={linkPending} icon={<Mail size={15} />} label="Email me a link" />
              </form>
            )}
          </m.div>
        </AnimatePresence>

        {googleEnabled && (
          <>
            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-ink-700" />
              <span className="text-[10.5px] font-medium uppercase tracking-[0.14em] text-mist-500">or</span>
              <span className="h-px flex-1 bg-ink-700" />
            </div>
            <form action={googleSubmit}>
              <input type="hidden" name="next" value={nextPath ?? ""} />
              <button
                type="submit"
                disabled={googlePending}
                className="flex w-full items-center justify-center gap-2.5 rounded-xl border border-ink-700 bg-ink-850 px-3 py-2.5 text-[13px] font-medium text-mist-100 transition-colors hover:border-ink-600 hover:bg-ink-800 disabled:opacity-50"
              >
                {googlePending ? <Loader2 size={15} className="animate-spin" /> : <GoogleGlyph />}
                Continue with Google
              </button>
            </form>
          </>
        )}
      </div>
    </LazyMotion>
  );
}

/**
 * The forced password change, shown when an administrator issued a temporary
 * password. The app layout redirects here until it is done, so it cannot be
 * skipped by navigating somewhere else with the temporary password still live.
 */
export function RotatePasswordForm({ nextPath }: { nextPath?: string }) {
  const [state, submit, pending] = useActionState(rotate, EMPTY);

  return (
    <div className="auth-enter w-full">
      <Header
        title="Choose a new password"
        subtitle="Your account was created with a temporary password. Replace it to continue."
      />
      <form action={submit} className="mt-6 space-y-4">
        <input type="hidden" name="next" value={nextPath ?? ""} />
        <Field label="New password">
          <input
            name="password"
            type="password"
            autoComplete="new-password"
            required
            autoFocus
            className="auth-field"
            aria-describedby="pw-hint"
          />
          <p id="pw-hint" className="mt-1.5 text-[11.5px] leading-relaxed text-mist-500">
            At least 12 characters. A short phrase you will actually remember beats a short jumble
            you will write on a sticky note.
          </p>
        </Field>
        <Field label="Confirm new password">
          <input name="confirm" type="password" autoComplete="new-password" required className="auth-field" />
        </Field>
        <Message error={state.error} notice={null} />
        <Submit busy={pending} icon={<Check size={15} />} label="Save and continue" />
      </form>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div>
      <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-mist-100">{title}</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-mist-400">{subtitle}</p>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-[0.1em] text-mist-400">
        {label}
        {hint && <span className="text-[10.5px] normal-case tracking-normal">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

function Submit({ busy, icon, label }: { busy: boolean; icon: React.ReactNode; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="auth-submit flex w-full items-center justify-center gap-2 px-3 py-3 text-[13.5px]"
    >
      <span className="relative z-10 flex items-center gap-2">
        {busy ? <Loader2 size={15} className="animate-spin" /> : icon}
        {busy ? "One moment…" : label}
      </span>
    </button>
  );
}

/** Errors and confirmations share one region so the form never jumps twice. */
function Message({ error, notice }: { error?: string | null; notice?: string | null }) {
  const text = error ?? notice;
  if (!text) return null;
  return (
    <p
      role={error ? "alert" : "status"}
      className={
        error
          ? "flex items-start gap-2 rounded-xl border border-bad-500/25 bg-bad-500/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-bad-400"
          : "flex items-start gap-2 rounded-xl border border-good-500/25 bg-good-500/10 px-3 py-2.5 text-[12.5px] leading-relaxed text-good-400"
      }
    >
      {error ? (
        <TriangleAlert size={14} className="mt-px shrink-0" />
      ) : (
        <Check size={14} className="mt-px shrink-0" />
      )}
      {text}
    </p>
  );
}

function GoogleGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.6l6.7-6.7C35.6 2.6 30.2 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.8 6.1C12.3 13.2 17.6 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.6 5.9c4.4-4.1 6.7-10.1 6.7-17.4z" />
      <path fill="#FBBC05" d="M10.4 28.7a14.5 14.5 0 0 1 0-9.4l-7.8-6.1a24 24 0 0 0 0 21.6l7.8-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.8 2.3-8.3 2.3-6.4 0-11.7-3.7-13.6-9.8l-7.8 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}
