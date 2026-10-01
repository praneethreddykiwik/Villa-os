"use client";

import { useState } from "react";
import { Loader2, Lock } from "lucide-react";
import clsx from "clsx";
import type { Permission } from "@/lib/auth/session";
import type { TabRow } from "@/lib/access/tab-catalogue";

/**
 * ACCESS CONTROL — the sidebar, as switches.
 *
 * Every row here is a tab the person will see, named exactly as the sidebar
 * names it, because that is the question actually being asked: "should sales be
 * able to open Leads?" The previous version listed capability keys — Walk-ins,
 * Documents, Pricing — that matched no tab in the product, so there was no way
 * to tell what a switch had done.
 *
 * Several tabs share one permission, so they are drawn as one row listing all
 * of them. Four separate switches that always flip together would read as three
 * broken ones.
 *
 * A switch writes to role_permissions, which is where `getSession()` reads a
 * person's permissions from, and therefore what both the page gate and every
 * API `guard()` consult. Turning a tab off does not hide a link — it removes
 * the permission, so typing the URL and calling the endpoint directly fail too.
 */

interface Props {
  rows: TabRow[];
  actions: Array<{ key: Permission; label: string; hint: string }>;
  byRole: Record<string, Permission[]>;
  roles: Array<{ key: string; name: string; description: string | null }>;
  protectedRoles: string[];
  canEdit: boolean;
}

export function AccessControl({ rows, actions, byRole, roles, protectedRoles, canEdit }: Props) {
  const isProtected = (key: string) => protectedRoles.includes(key);
  const firstEditable = roles.find((r) => !isProtected(r.key)) ?? roles[0];
  const [role, setRole] = useState(firstEditable?.key ?? "");
  const [grants, setGrants] = useState<Record<string, Permission[]>>(byRole);
  const [busy, setBusy] = useState<Permission | null>(null);
  const [error, setError] = useState("");

  const held = new Set(grants[role] ?? []);
  const locked = isProtected(role);
  const current = roles.find((r) => r.key === role);

  async function toggle(permission: Permission, next: boolean) {
    if (!canEdit || locked) return;
    setError("");
    setBusy(permission);

    // Flip first; somebody setting up a role makes twenty of these in a row.
    setGrants((g) => {
      const held = new Set(g[role] ?? []);
      if (next) held.add(permission);
      else held.delete(permission);
      return { ...g, [role]: [...held] };
    });

    try {
      const res = await fetch("/api/osf/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, permission, allowed: next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.ok) throw new Error(json.error || "That change was not saved.");
    } catch (e) {
      // Reverting without saying why reads as the click not registering.
      setError((e as Error).message);
      setGrants((g) => {
        const held = new Set(g[role] ?? []);
        if (next) held.delete(permission);
        else held.add(permission);
        return { ...g, [role]: [...held] };
      });
    } finally {
      setBusy(null);
    }
  }

  function Switch({ permission }: { permission: Permission }) {
    const on = held.has(permission);
    const working = busy === permission;
    return (
      <button
        type="button"
        role="switch"
        aria-checked={on}
        disabled={!canEdit || locked || working}
        onClick={() => void toggle(permission, !on)}
        className={clsx(
          "relative h-[22px] w-[38px] shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-60",
          on ? "border-emerald-500/60 bg-emerald-500/80" : "border-ink-600 bg-ink-600",
        )}
      >
        <span
          className={clsx(
            "absolute top-[2px] grid h-[16px] w-[16px] place-items-center rounded-full bg-white shadow transition-all",
            on ? "left-[18px]" : "left-[2px]",
          )}
        >
          {working && <Loader2 size={10} className="animate-spin text-ink-800" aria-hidden />}
        </span>
      </button>
    );
  }

  const groups = [...new Set(rows.map((r) => r.group))];

  return (
    <div className="space-y-5">
      <div>
        <div className="flex flex-wrap gap-1.5">
          {roles.map((r) => {
            const active = r.key === role;
            const count = (grants[r.key] ?? []).length;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => {
                  setRole(r.key);
                  setError("");
                }}
                aria-pressed={active}
                className={clsx(
                  "rounded-full border px-3 py-1.5 text-[12px] transition",
                  active
                    ? "border-[var(--color-gold-300)] bg-[var(--color-gold-300)]/15 text-mist-100"
                    : "border-ink-700 bg-ink-900 text-mist-400 hover:text-mist-200",
                )}
              >
                {r.name}
                {isProtected(r.key) && <Lock size={10} className="ml-1 inline-block" aria-hidden />}
                <span className="ml-1.5 text-[10px] text-mist-500">{count}</span>
              </button>
            );
          })}
        </div>
        {current?.description && (
          <p className="mt-2 text-[12px] text-mist-400">{current.description}</p>
        )}
      </div>

      {locked && (
        <p className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] text-mist-400">
          <strong className="text-mist-200">{current?.name}</strong> always has full access. It is the account
          that can repair the others, so it cannot be limited from here.
        </p>
      )}

      {!canEdit && (
        <p className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] text-mist-400">
          You can see who has what, but changing it needs an administrator.
        </p>
      )}

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      <section>
        <h3 className="mb-1 text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
          Tabs this role can open
        </h3>
        <p className="mb-3 text-[11.5px] text-mist-500">
          Turning a tab off removes it from their sidebar and refuses the page and its data if they type the
          address directly. Some tabs open together — those are listed on one row.
        </p>

        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group}>
              <h4 className="mb-1.5 text-[11.5px] font-medium text-mist-300">{group}</h4>
              <div className="overflow-hidden rounded-xl border border-ink-700/80">
                {rows
                  .filter((r) => r.group === group)
                  .map((row) => (
                    <div
                      key={`${group}:${row.permission}`}
                      className="flex items-center gap-3 border-b border-ink-800/70 bg-ink-900/40 px-3 py-2.5 last:border-0"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[12.5px] text-mist-100">
                          {row.tabs.map((t) => t.label).join(" · ")}
                        </div>
                        {row.tabs.length > 1 && (
                          <div className="text-[10.5px] text-mist-500">
                            {row.tabs.length} tabs — one decision
                          </div>
                        )}
                      </div>
                      <Switch permission={row.permission} />
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1 text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
          What they can change
        </h3>
        <p className="mb-3 text-[11.5px] text-mist-500">
          Seeing a screen and being able to act on it are separate. These are checked by the endpoints behind
          the buttons, so turning one off disables the action rather than only hiding it.
        </p>
        <div className="overflow-hidden rounded-xl border border-ink-700/80">
          {actions.map((a) => (
            <div
              key={a.key}
              className="flex items-center gap-3 border-b border-ink-800/70 bg-ink-900/40 px-3 py-2.5 last:border-0"
            >
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12.5px] text-mist-100">{a.label}</div>
                <div className="truncate text-[10.5px] text-mist-500">{a.hint}</div>
              </div>
              <Switch permission={a.key} />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
