"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  LogOut,
  Maximize2,
  Minimize2,
  Monitor,
  Moon,
  Settings2,
  Sun,
  X,
} from "lucide-react";
import clsx from "clsx";
import { signOut } from "@/app/(auth)/signin/actions";
import { applyTheme, type ThemeChoice } from "@/lib/theme";

/**
 * QUICK SETTINGS — the controls that belong to the person, not the page.
 *
 * Appearance, full screen and sign-out used to live in places that only some
 * screens and some roles ever rendered: the theme switch sat inside TopBar,
 * which 36 of the 65 app pages never mount, and /ops — where everyone without
 * `analytics.view` lands at sign-in — is one of them. So a sales or marketing
 * account had no way to leave dark mode, and no way to sign out at all.
 *
 * Mounting this from the app layout instead of from a page is the whole point:
 * it is present for every role, on every screen, including the "no access"
 * branch. Nothing here needs a permission, because none of it reads company
 * data — it changes how this one person's browser looks and who they are
 * signed in as.
 */

interface Props {
  /** Resolved on the server from the cookie, so the right option is lit on the
   *  first paint rather than flicking across after hydration. */
  initialTheme: ThemeChoice;
  person: { name: string; email: string; role?: string };
}

/* Safari exposes the fullscreen API under a webkit prefix and never adopted the
   standard names, so both spellings have to be tried and both change events
   listened for. The casts are the price of describing a vendor API that is not
   in the DOM lib. */
interface WebkitDoc extends Document {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
}
interface WebkitEl extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

function fullscreenElement(): Element | null {
  const d = document as WebkitDoc;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
}

function fullscreenSupported(): boolean {
  const d = document as WebkitDoc;
  // iOS Safari defines the method on elements but reports it disabled for
  // anything that is not a <video>. Offering a button that cannot work is
  // worse than not offering one, so the flag decides.
  return Boolean(d.fullscreenEnabled ?? d.webkitFullscreenEnabled ?? false);
}

export function QuickSettings({ initialTheme, person }: Props) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeChoice>(initialTheme);
  const [isFull, setIsFull] = useState(false);
  const [canFull, setCanFull] = useState(false);
  const [fullError, setFullError] = useState("");

  const panel = useRef<HTMLDivElement>(null);
  const launcher = useRef<HTMLButtonElement>(null);

  /* Fullscreen can also be entered and left by F11 and by Escape, which never
     tell this component anything. Without tracking the real document state the
     label would invite you to "Enter full screen" while you already were. */
  useEffect(() => {
    setCanFull(fullscreenSupported());
    const sync = () => setIsFull(Boolean(fullscreenElement()));
    sync();
    document.addEventListener("fullscreenchange", sync);
    document.addEventListener("webkitfullscreenchange", sync);
    return () => {
      document.removeEventListener("fullscreenchange", sync);
      document.removeEventListener("webkitfullscreenchange", sync);
    };
  }, []);

  // Escape closes, and focus goes back to the button that opened it — losing
  // focus to the top of the document is the usual way a keyboard user gets
  // stranded by a popover.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        launcher.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !launcher.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const toggleFullscreen = useCallback(async () => {
    setFullError("");
    try {
      if (fullscreenElement()) {
        const d = document as WebkitDoc;
        await (d.exitFullscreen?.() ?? d.webkitExitFullscreen?.());
      } else {
        const el = document.documentElement as WebkitEl;
        await (el.requestFullscreen?.() ?? el.webkitRequestFullscreen?.());
      }
    } catch {
      // The request is rejected outright when the browser does not consider
      // this a user gesture, or when an extension or kiosk policy forbids it.
      // Saying so is better than a button that looks broken.
      setFullError("Your browser refused full screen. Try F11.");
    }
  }, []);

  function pickTheme(next: ThemeChoice) {
    setTheme(next);
    applyTheme(next);
  }

  const themes: Array<{ value: ThemeChoice; icon: typeof Sun; label: string }> = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "Auto" },
  ];

  return (
    /* print:hidden — a floating control has no meaning on paper, and the demo
       decks for this app are printed from the reports screens. */
    <div className="print:hidden">
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-modal="false"
          aria-label="Quick settings"
          className="fixed bottom-[76px] right-4 z-40 w-[268px] overflow-hidden rounded-2xl border border-ink-700/80 bg-ink-900/95 shadow-[0_24px_48px_-16px_rgba(0,0,0,0.55)] backdrop-blur-3xl sm:right-6"
        >
          <div className="flex items-center justify-between border-b border-ink-800/70 px-3.5 py-2.5">
            <span className="text-[12.5px] font-semibold text-mist-100">Settings</span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                launcher.current?.focus();
              }}
              aria-label="Close settings"
              className="grid h-6 w-6 place-items-center rounded-lg text-mist-400 transition hover:bg-ink-800 hover:text-mist-100"
            >
              <X size={13} aria-hidden />
            </button>
          </div>

          <div className="space-y-3.5 p-3.5">
            <section>
              <h3 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-mist-500">
                Appearance
              </h3>
              <div
                className="grid grid-cols-3 gap-1 rounded-xl border border-ink-700/80 bg-ink-950/60 p-1"
                role="radiogroup"
                aria-label="Appearance"
              >
                {themes.map((t) => {
                  const Icon = t.icon;
                  const on = theme === t.value;
                  return (
                    <button
                      key={t.value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => pickTheme(t.value)}
                      className={clsx(
                        "flex flex-col items-center gap-1 rounded-lg px-1 py-1.5 text-[10.5px] font-medium transition",
                        on
                          ? "bg-ink-700 text-mist-100 shadow-sm"
                          : "text-mist-400 hover:bg-ink-800/70 hover:text-mist-200",
                      )}
                    >
                      <Icon size={14} aria-hidden />
                      {t.label}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[10.5px] text-mist-500">
                {theme === "system"
                  ? "Following your device setting."
                  : `Always ${theme}, on every device you sign in from.`}
              </p>
            </section>

            {canFull && (
              <section>
                <h3 className="mb-1.5 text-[10.5px] font-medium uppercase tracking-wider text-mist-500">
                  Display
                </h3>
                <button
                  type="button"
                  onClick={() => void toggleFullscreen()}
                  aria-pressed={isFull}
                  className="flex w-full items-center gap-2.5 rounded-xl border border-ink-700/80 bg-ink-950/60 px-3 py-2 text-left text-[12px] text-mist-200 transition hover:border-ink-600 hover:text-mist-100"
                >
                  {isFull ? (
                    <Minimize2 size={14} className="shrink-0 text-mist-400" aria-hidden />
                  ) : (
                    <Maximize2 size={14} className="shrink-0 text-mist-400" aria-hidden />
                  )}
                  <span className="flex-1">{isFull ? "Exit full screen" : "Full screen"}</span>
                  {isFull && <Check size={13} className="shrink-0 text-good-400" aria-hidden />}
                </button>
                {fullError && <p className="mt-1.5 text-[10.5px] text-bad-400">{fullError}</p>}
              </section>
            )}

            <section className="border-t border-ink-800/70 pt-3">
              <div className="flex items-center gap-2.5">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl border border-brand-500/30 bg-gradient-to-br from-brand-500/20 to-brand-400/10 text-[12px] font-bold uppercase text-mist-100">
                  {person.name ? person.name.charAt(0) : "U"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-mist-100">
                    {person.name || "Signed in"}
                  </div>
                  <div className="truncate text-[10.5px] capitalize text-mist-400">
                    {person.role ? person.role.replace(/_/g, " ") : "Staff"}
                  </div>
                  {person.email && (
                    <div className="truncate text-[10px] lowercase text-mist-500" title={person.email}>
                      {person.email}
                    </div>
                  )}
                </div>
              </div>
              {/* A server action, so the session is revoked on the server and
                  the cookie cleared there. A client-side cookie wipe would
                  leave the token valid for anyone who kept a copy. */}
              <form action={signOut} className="mt-2.5">
                <button
                  type="submit"
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-ink-700/80 bg-ink-950/60 px-3 py-2 text-[12px] font-medium text-mist-300 transition hover:border-bad-400/50 hover:text-bad-400"
                >
                  <LogOut size={13} aria-hidden />
                  Sign out
                </button>
              </form>
            </section>
          </div>
        </div>
      )}

      <button
        ref={launcher}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label="Settings, appearance and account"
        title="Settings"
        className={clsx(
          "fixed bottom-4 right-4 z-40 grid h-11 w-11 place-items-center rounded-full border shadow-[0_8px_24px_-8px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all sm:right-6",
          "motion-safe:hover:scale-105",
          open
            ? "border-brand-500/55 bg-ink-800 text-mist-100"
            : "border-ink-700/80 bg-ink-900/85 text-mist-300 hover:border-ink-600 hover:text-mist-100",
        )}
      >
        <Settings2 size={17} className={clsx("transition-transform", open && "rotate-90")} aria-hidden />
      </button>
    </div>
  );
}
