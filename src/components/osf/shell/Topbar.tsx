"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { Bell, Menu, Search, Sparkles } from "lucide-react";
import DateRangePicker from "./DateRangePicker";

/** Falls back to the ⌘ glyph on the server so the first paint never mismatches. */
function useShortcutHint() {
  const [hint, setHint] = useState("⌘K");
  useEffect(() => {
    if (!/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)) setHint("Ctrl K");
  }, []);
  return hint;
}

export default function Topbar({
  onOpenPalette,
  onOpenDrawer,
}: {
  onOpenPalette: () => void;
  onOpenDrawer: () => void;
}) {
  const hint = useShortcutHint();

  return (
    <header className="sticky top-0 z-30 border-b border-[var(--color-line)] bg-[var(--color-void)]/85 backdrop-blur-xl">
      <div className="flex h-16 items-center gap-3 px-4 lg:px-8">
        <button
          type="button"
          onClick={onOpenDrawer}
          aria-label="Open navigation"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] transition hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)] lg:hidden"
        >
          <Menu size={16} strokeWidth={1.75} aria-hidden />
        </button>

        {/*
          A button, not an <input>. Typing happens inside the palette, and a real
          field here would need its value handed across on open for no gain.
        */}
        <button
          type="button"
          onClick={onOpenPalette}
          className="group flex h-9 min-w-0 flex-1 items-center gap-2.5 rounded-xl border border-[var(--color-line)] bg-[var(--color-void)] px-3 text-left transition hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface)] sm:max-w-sm"
        >
          <Search
            size={14}
            strokeWidth={1.75}
            aria-hidden
            className="shrink-0 text-[var(--color-faint)] transition-colors group-hover:text-[var(--color-muted)]"
          />
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--color-faint)]">Search pages…</span>
          <kbd className="hidden shrink-0 rounded-md border border-[var(--color-line)] bg-[var(--color-surface)] px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-[var(--color-faint)] sm:block">
            {hint}
          </kbd>
        </button>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/*
            useSearchParams() suspends during prerender; without this boundary a
            statically rendered route would fail the build rather than degrade.
          */}
          <Suspense
            fallback={<div className="h-9 w-[92px] rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] sm:w-[150px]" />}
          >
            <DateRangePicker />
          </Suspense>

          <Link
            href="/inbox/whatsapp/crm/follow-ups"
            aria-label="Notifications"
            className="grid h-9 w-9 place-items-center rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] transition hover:bg-[var(--color-raised)] hover:text-[var(--color-ink)]"
          >
            <Bell size={15} strokeWidth={1.75} aria-hidden />
          </Link>
        </div>
      </div>

      {/* Sits exactly on the border so the gold reads as the edge itself, not a second line. */}
      <div className="hairline-gold absolute inset-x-0 -bottom-px h-px" aria-hidden />
    </header>
  );
}
