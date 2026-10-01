"use client";

import { useState } from "react";
import { Check, Loader2, Pencil } from "lucide-react";
import {
  categoryLabel,
  isProtectedRole,
  orderedCategories,
  roleDisplayName,
  type AccessArea,
} from "@/lib/osf/access-areas";

/**
 * ACCESS CONTROL — who can see and do what.
 *
 * Pick a role, then read down the page: a green tick means that role can open
 * the area, a filled pencil means it can change things there. Both are one
 * click, and each click is a write to villa_role_permissions — the same table
 * villa_can() consults inside Postgres. There is no separate copy of the rules
 * to drift out of step.
 *
 * WHY THE STATE IS OPTIMISTIC
 *
 * A permission grid where every click waits on a round trip feels broken, and
 * an owner setting up a role makes twenty clicks in a row. So the square
 * flips immediately and reverts if the server refuses — and the refusal is
 * shown, because silently reverting would read as the click not registering.
 */

interface Props {
  areas: AccessArea[];
  /** role -> granted permission keys */
  byRole: Record<string, string[]>;
  roles: string[];
  canEdit: boolean;
}

export function AccessControl({ areas, byRole, roles, canEdit }: Props) {
  const firstEditable = roles.find((r) => !isProtectedRole(r)) ?? roles[0] ?? "";
  const [role, setRole] = useState(firstEditable);
  const [grants, setGrants] = useState<Record<string, string[]>>(byRole);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");

  const held = new Set(grants[role] ?? []);
  const locked = isProtectedRole(role);

  async function toggle(permission: string, next: boolean) {
    if (!canEdit || locked) return;
    setError("");
    setBusy(permission);

    // Flip first; the grid has to keep up with a person setting up a role.
    setGrants((g) => {
      const current = new Set(g[role] ?? []);
      if (next) current.add(permission);
      else current.delete(permission);
      return { ...g, [role]: [...current] };
    });

    try {
      const res = await fetch("/api/osf/access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, permission, allowed: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "That change was not saved.");
    } catch (e) {
      setError((e as Error).message);
      setGrants((g) => {
        const current = new Set(g[role] ?? []);
        if (next) current.delete(permission);
        else current.add(permission);
        return { ...g, [role]: [...current] };
      });
    } finally {
      setBusy(null);
    }
  }

  const square = (permission: string | null, kind: "view" | "edit") => {
    if (!permission) {
      return (
        <span
          className="grid h-7 w-7 place-items-center rounded-lg border border-dashed border-ink-700 text-[10px] text-mist-500"
          title={kind === "view" ? "This area has nothing to view" : "This area cannot be edited"}
        >
          —
        </span>
      );
    }
    const on = held.has(permission);
    const working = busy === permission;
    const base = "grid h-7 w-7 place-items-center rounded-lg border transition disabled:cursor-not-allowed";

    return (
      <button
        type="button"
        onClick={() => void toggle(permission, !on)}
        disabled={!canEdit || locked || working}
        aria-pressed={on}
        title={`${on ? "Remove" : "Give"} ${permission} ${on ? "from" : "to"} ${roleDisplayName(role)}`}
        className={
          base +
          " " +
          (on
            ? kind === "view"
              ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-400"
              : "border-[var(--color-gold-300)]/60 bg-[var(--color-gold-300)]/15 text-[var(--color-gold-300)]"
            : "border-ink-700 bg-ink-900 text-mist-500 hover:border-ink-600 hover:text-mist-300")
        }
      >
        {working ? (
          <Loader2 size={13} className="animate-spin" aria-hidden />
        ) : kind === "view" ? (
          <Check size={14} strokeWidth={on ? 3 : 2} aria-hidden />
        ) : (
          <Pencil size={12} strokeWidth={on ? 2.5 : 2} aria-hidden />
        )}
      </button>
    );
  };

  return (
    <div className="space-y-5">
      <div>
        <p className="text-[12px] text-mist-400">
          Pick a role, then give it access area by area. A tick means they can open it; a pencil means they can
          change things there. Saved the moment you click.
        </p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {roles.map((r) => {
            const active = r === role;
            const count = (grants[r] ?? []).length;
            return (
              <button
                key={r}
                type="button"
                onClick={() => { setRole(r); setError(""); }}
                aria-pressed={active}
                className={
                  "rounded-full border px-3 py-1.5 text-[12px] transition " +
                  (active
                    ? "border-[var(--color-gold-300)] bg-[var(--color-gold-300)]/15 text-mist-100"
                    : "border-ink-700 bg-ink-900 text-mist-400 hover:text-mist-200")
                }
              >
                {roleDisplayName(r)}
                <span className="ml-1.5 text-[10px] text-mist-500">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {locked && (
        <p className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] text-mist-400">
          <strong className="text-mist-200">{roleDisplayName(role)}</strong> always has full access. It is the
          account that can repair the others, so it cannot be limited from here.
        </p>
      )}

      {!canEdit && (
        <p className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-[12px] text-mist-400">
          You can see who has what, but changing it needs an administrator.
        </p>
      )}

      {error && <p className="text-[12px] text-red-400">{error}</p>}

      {orderedCategories(areas).map((cat) => (
        <section key={cat}>
          <h3 className="mb-2 text-[11px] uppercase tracking-wider text-[var(--color-faint)]">
            {categoryLabel(cat)}
          </h3>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {areas
              .filter((a) => a.category === cat)
              .map((area) => {
                const visible = area.view ? held.has(area.view) : held.has(area.edit ?? "");
                return (
                  <div
                    key={area.key}
                    className={
                      "rounded-xl border p-3 transition " +
                      (visible ? "border-emerald-500/40 bg-emerald-500/[0.06]" : "border-ink-700 bg-ink-900/60")
                    }
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-[12.5px] font-medium text-mist-100">{area.label}</span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {square(area.edit, "edit")}
                        {square(area.view, "view")}
                      </div>
                    </div>

                    {area.extras.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1">
                        {area.extras.map((x) => {
                          const on = held.has(x.key);
                          return (
                            <button
                              key={x.key}
                              type="button"
                              onClick={() => void toggle(x.key, !on)}
                              disabled={!canEdit || locked || busy === x.key}
                              aria-pressed={on}
                              className={
                                "rounded-full border px-2 py-0.5 text-[10.5px] transition " +
                                (on
                                  ? "border-emerald-500/50 bg-emerald-500/15 text-emerald-300"
                                  : "border-ink-700 bg-ink-950 text-mist-500 hover:text-mist-300")
                              }
                            >
                              {x.label}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </section>
      ))}
    </div>
  );
}
