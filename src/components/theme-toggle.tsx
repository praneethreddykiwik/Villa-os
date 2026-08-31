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
  const resolved =
    choice === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : choice;
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem("orbit-theme", choice);
}

export function ThemeToggle() {
  const [choice, setChoice] = useState<ThemeChoice>("dark");

  useEffect(() => {
    const saved = (localStorage.getItem("orbit-theme") as ThemeChoice | null) ?? "dark";
    setChoice(saved);
    applyTheme(saved);

    // Keep following the OS while the user is on "system".
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if ((localStorage.getItem("orbit-theme") as ThemeChoice) === "system") applyTheme("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
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
