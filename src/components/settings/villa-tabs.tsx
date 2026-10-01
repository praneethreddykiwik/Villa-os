"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The Villa profile tab strip.
 *
 * A client component only so it can mark the current tab. Each panel behind it
 * stays a server component, and the tabs stay real links — so a deep link,
 * a middle-click and the back button all behave.
 */

const TABS = [
  { href: "/settings/villa", label: "General" },
  { href: "/settings/villa/properties", label: "Properties" },
  { href: "/settings/villa/whatsapp", label: "WhatsApp" },
  { href: "/settings/villa/voice", label: "Voice agent" },
] as const;

export function VillaTabs() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Villa profile sections"
      className="flex flex-wrap gap-1 border-b border-ink-800 px-4 pt-3 sm:px-6 lg:px-7"
    >
      {TABS.map((t) => {
        // Exact match only: "/settings/villa" is a prefix of every other tab,
        // so a startsWith test would light up General on all of them.
        const active = pathname === t.href;
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={
              "rounded-t-lg border-b-2 px-3 py-2 text-[12.5px] transition-colors " +
              (active
                ? "border-[var(--color-gold-300)] text-mist-100"
                : "border-transparent text-mist-400 hover:bg-ink-900 hover:text-mist-100")
            }
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
