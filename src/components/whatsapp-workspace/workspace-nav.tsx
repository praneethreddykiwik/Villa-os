"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import clsx from "clsx";
import { NAV_GROUPS, activeHref } from "@/components/osf/shell/nav-config";
import { requiredPermissionFor } from "@/lib/auth/page-access";

/**
 * Second-level navigation for the WhatsApp workspace.
 *
 * Two rows rather than one: the workspace carries around forty screens, which
 * is far too many for a single strip, and a vertical rail would be a second
 * sidebar beside the app's own. The first row picks a section, the second
 * lists that section's screens — the same shape as the tab strip used
 * elsewhere in the dashboard, so it reads as part of this product rather than
 * as something bolted on.
 */
export function WorkspaceNav({ permissions = [] }: { permissions?: string[] }) {
  const pathname = usePathname();
  const active = useMemo(() => activeHref(pathname), [pathname]);

  /**
   * Filtered by exactly the rule the page gate applies, so a tab is offered
   * only where it can actually be opened. Previously every group and every
   * item rendered for everyone: a customers.read-only account was shown the
   * Overview and System tabs and got the no-access screen for its trouble.
   */
  const groups = useMemo(() => {
    const allowed = new Set(permissions);
    return NAV_GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => {
        const required = requiredPermissionFor(i.href);
        if (required === "allow") return true;
        if (required === null) return false;
        return allowed.has(required);
      }),
    })).filter((g) => g.items.length > 0);
  }, [permissions]);

  // The group holding the current page, so the second row is never empty and
  // never shows a section the reader is not in.
  const group = groups.find((g) => g.items.some((i) => i.href === active)) ?? groups[0];

  // Nothing in this workspace is reachable for this account. The gate renders
  // its own explanation; a strip of zero tabs would only add a stray border.
  if (!group) return null;

  return (
    <div className="border-b border-ink-700/70 bg-ink-900/40">
      {/* Scrolls sideways on a phone rather than wrapping. Thirteen sections
          wrapped onto four rows pushed the page itself off the bottom of the
          screen before any content appeared. */}
      <div className="flex items-center gap-1 overflow-x-auto px-4 pt-3 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:px-6 sm:pt-4 [&::-webkit-scrollbar]:hidden">
        {groups.map((g) => {
          const current = g.label === group.label;
          // Link to the group's first screen — a group is a heading, not a page.
          const target = g.items[0]?.href ?? "/inbox/whatsapp";
          return (
            <Link
              key={g.label}
              href={target}
              aria-current={current ? "page" : undefined}
              className={clsx(
                "shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition",
                current
                  ? "bg-ink-700 text-mist-100"
                  : "text-mist-400 hover:bg-ink-800 hover:text-mist-200",
              )}
            >
              {g.label}
            </Link>
          );
        })}
      </div>

      {/* A group with one screen needs no second row: the tab above already
          IS that screen, and a lone chip repeating its name reads as a choice
          when there is nothing to choose. */}
      {group.items.length > 1 && (
      <div className="flex items-center gap-x-1 gap-y-0.5 overflow-x-auto px-4 pb-3 pt-2 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:px-6 [&::-webkit-scrollbar]:hidden">
        {group.items.map((item) => {
          const current = item.href === active;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={clsx(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition",
                current
                  ? "bg-ink-800 text-mist-100"
                  : "text-mist-400 hover:bg-ink-800/60 hover:text-mist-200",
              )}
            >
              <Icon size={13} strokeWidth={1.75} aria-hidden />
              {item.label}
            </Link>
          );
        })}
      </div>
      )}
    </div>
  );
}
