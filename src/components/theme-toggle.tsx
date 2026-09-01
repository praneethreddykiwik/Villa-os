"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import clsx from "clsx";

export type ThemeChoice = "light" | "dark" | "system";

/**
 * Theme switch.
 *
 * "system" is a real third state rather than a default — it keeps following the
 * OS after the user picks it, which a two-way toggle cannot do. The resolved
 * value is written to <html data-theme>, which is the only thing the CSS reads.
 */
export function applyTheme(choice: ThemeChoice): void {
  // "system" removes the attribute entirely and lets the media query decide,
  // which keeps the server-rendered markup and the client in agreement.
  if (choice === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = choice;

  // A cookie, not localStorage, so the server can render the correct theme on
  // the first response instead of flashing the wrong one.
  document.cookie = `orbit-theme=${choice}; path=/; max-age=31536000; samesite=lax`;
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("dark");

  useEffect(() => {
    const saved = (document.cookie.match(/(?:^|;\s*)orbit-theme=([^;]+)/)?.[1] as ThemeChoice | null) ?? "system";
    setChoice(saved);
  }, []);

  const options: Array<{ value: ThemeChoice; icon: typeof Sun; label: string }> = [
    { value: "light", icon: Sun, label: "Light" },
    { value: "dark", icon: Moon, label: "Dark" },
    { value: "system", icon: Monitor, label: "System" },
  ];

  return (
    <div className="flex overflow-hidden rounded-lg border border-ink-700" role="group" aria-label="Theme">
      {options.map((o) => {
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            title={o.label}
            aria-pressed={choice === o.value}
            onClick={() => {
              setChoice(o.value);
              applyTheme(o.value);
            }}
            className={clsx(
              "grid h-[30px] w-[30px] place-items-center transition-colors",
              choice === o.value ? "bg-ink-700 text-mist-100" : "text-mist-400 hover:text-mist-200",
            )}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );
}
