"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Loader2, ShieldOff, UserPlus } from "lucide-react";
import clsx from "clsx";
import { Badge, Card, SectionTitle } from "../ui";

interface StaffUser {
  id: string;
  fullName: string;
  email: string;
  active: boolean;
  lastLoginAt: string | null;
  roles: string[];
}
interface Role {
  id: string;
  key: string;
  name: string;
  description: string;
}

/**
 * Team management.
 *
 * Creating an account returns a one-time password. It is shown here once and
 * never stored anywhere we can read it back, so it has to be handed over now.
 * The new person is forced to replace it the first time they sign in.
 */
export function TeamManager() {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [roleKey, setRoleKey] = useState("");

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/ops/users");
      const json = await res.json();
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setUsers(json.users);
      setRoles(json.roles);
      if (!roleKey && json.roles.length) setRoleKey(json.roles[0].key);
      setError(json.warning ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy("create");
    setError(null);
    try {
      const res = await fetch("/api/ops/users", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, fullName, roleKey }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error);
        return;
      }
      setIssued({ email: json.email, password: json.temporaryPassword });
      setEmail("");
      setFullName("");
      setAdding(false);
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function update(userId: string, patch: { active?: boolean; roleKey?: string }) {
    setBusy(userId);
    setError(null);
    try {
      const res = await fetch("/api/ops/users", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId, ...patch }),
      });
      const json = await res.json();
      if (!json.ok) setError(json.error);
      else await load();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      {issued && (
        <Card className="border-good-500/40 bg-good-500/[0.06]">
          <SectionTitle
            title="Account created"
            hint="This password is shown once. Give it to them now — it cannot be retrieved later."
          />
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-lg bg-ink-850 px-3 py-2 text-[13px] text-mist-100">{issued.email}</code>
            <code className="rounded-lg bg-ink-850 px-3 py-2 text-[13px] font-semibold text-mist-100">{issued.password}</code>
            <button
              onClick={async () => {
                await navigator.clipboard.writeText(`${issued.email} / ${issued.password}`);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
            >
              {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={() => setIssued(null)} className="ml-auto text-[12px] text-mist-400 hover:text-mist-100">
              Done
            </button>
          </div>
          <p className="mt-2 text-[11.5px] text-mist-400">
            They will be asked to choose their own password the first time they sign in.
          </p>
        </Card>
      )}

      <Card>
        <SectionTitle
          title="Team"
          hint="Who can sign in, and what each person is allowed to see"
          action={
            <button
              onClick={() => setAdding((v) => !v)}
              className="flex items-center gap-1.5 rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600"
            >
              <UserPlus size={13} /> Add person
            </button>
          }
        />

        {error && <p className="mb-3 rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>}

        {adding && (
          <form onSubmit={create} className="mb-4 grid gap-2 rounded-xl border border-brand-500/40 p-3 md:grid-cols-4">
            <label className="text-[11px] text-mist-400 md:col-span-1">
              Full name
              <input
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12.5px] text-mist-100 outline-none"
              />
            </label>
            <label className="text-[11px] text-mist-400 md:col-span-1">
              Work email
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12.5px] text-mist-100 outline-none"
              />
            </label>
            <label className="text-[11px] text-mist-400 md:col-span-1">
              Role
              <select
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-850 px-2 py-1.5 text-[12.5px] text-mist-100 outline-none"
              >
                {roles.map((r) => (
                  <option key={r.key} value={r.key}>{r.name}</option>
                ))}
              </select>
            </label>
            <div className="flex items-end gap-2">
              <button
                type="submit"
                disabled={busy === "create"}
                className="flex-1 rounded-lg bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-[var(--a-on)] hover:bg-brand-600 disabled:opacity-50"
              >
                {busy === "create" ? <Loader2 size={13} className="mx-auto animate-spin" /> : "Create"}
              </button>
              <button type="button" onClick={() => setAdding(false)} className="rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-300">
                Cancel
              </button>
            </div>
            <p className="md:col-span-4 text-[11px] text-mist-500">
              The role decides what they can see. Pick the narrowest one that lets them do their job — you can change it later.
            </p>
          </form>
        )}

        {loading ? (
          <div className="py-8 text-center"><Loader2 size={18} className="mx-auto animate-spin text-mist-400" /></div>
        ) : (
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-ink-700 text-left text-[10px] uppercase tracking-wider text-mist-400">
                <th className="py-2 font-medium">Person</th>
                <th className="py-2 font-medium">Role</th>
                <th className="py-2 font-medium">Status</th>
                <th className="py-2 font-medium">Last signed in</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={clsx("border-b border-ink-700/60 last:border-0", !u.active && "opacity-50")}>
                  <td className="py-2.5">
                    <div className="font-medium text-mist-100">{u.fullName}</div>
                    <div className="text-[10.5px] text-mist-400">{u.email}</div>
                  </td>
                  <td className="py-2.5">
                    <select
                      value={u.roles[0] ?? ""}
                      onChange={(e) => update(u.id, { roleKey: e.target.value })}
                      disabled={busy === u.id}
                      className="rounded-md border border-ink-700 bg-ink-850 px-1.5 py-1 text-[11.5px] text-mist-100 outline-none"
                    >
                      <option value="">No role</option>
                      {roles.map((r) => (
                        <option key={r.key} value={r.key}>{r.name}</option>
                      ))}
                    </select>
                  </td>
                  <td className="py-2.5">
                    <Badge tone={u.active ? "good" : "bad"}>{u.active ? "active" : "disabled"}</Badge>
                  </td>
                  <td className="tnum py-2.5 text-mist-400">
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "never"}
                  </td>
                  <td className="py-2.5 text-right">
                    <button
                      onClick={() => update(u.id, { active: !u.active })}
                      disabled={busy === u.id}
                      className="inline-flex items-center gap-1 rounded-lg border border-ink-700 px-2 py-1 text-[11px] text-mist-300 hover:border-ink-600 disabled:opacity-50"
                    >
                      {busy === u.id ? <Loader2 size={11} className="animate-spin" /> : <ShieldOff size={11} />}
                      {u.active ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-3 text-[11px] leading-relaxed text-mist-500">
          Disabling someone signs them out everywhere immediately — it does not wait for their session to expire.
        </p>
      </Card>
    </div>
  );
}
