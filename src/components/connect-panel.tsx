"use client";

import { useState } from "react";
import { Check, Link2, Loader2, Plug, RefreshCw, Unplug, X } from "lucide-react";
import clsx from "clsx";
import type { ChannelId } from "@/lib/types";
import { Badge, Card, SectionTitle } from "./ui";

interface SyncSource {
  channel: ChannelId;
  handle: string;
  status: "synced" | "skipped" | "error";
  fetched: number;
  detail?: string;
  error?: string;
}

export interface ConnectRow {
  channel: ChannelId;
  label: string;
  color: string;
  connected: boolean;
  status?: string;
  handle?: string;
  scopes: string[];
  unlocks: string[];
  notes?: string[];
  envVars: string[];
}

/**
 * The connect surface.
 *
 * Every row states, before you click, exactly what the connection unlocks and
 * which permissions it asks for. "Why does this app want that scope?" is a
 * question clients ask, and burying the answer costs you the connection.
 */
export function ConnectPanel({ rows, brandId }: { rows: ConnectRow[]; brandId: string }) {
  const [state, setState] = useState(rows);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  // Per-channel outcome of the last "Retrieve everything", so the operator sees
  // which channels actually synced and why the rest did not — one summary line
  // hid that the Upload-Post rows never sync at all.
  const [syncSources, setSyncSources] = useState<SyncSource[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function toggle(channel: ChannelId, connected: boolean) {
    setBusy(channel);
    setError(null);
    try {
      const res = await fetch("/api/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId, channel, action: connected ? "disconnect" : "connect" }),
      });
      const json = await res.json();
      if (!json.ok) {
        setError(json.error ?? "Could not connect");
        return;
      }
      // Live mode hands back an authorize URL for the browser to follow.
      if (json.authorizeUrl) {
        window.location.href = json.authorizeUrl;
        return;
      }
      setState((s) => s.map((r) => (r.channel === channel ? { ...r, connected: !connected, status: json.status } : r)));
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setSyncing(true);
    setSyncResult(null);
    setSyncSources([]);
    setError(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      const json = await res.json();
      // Without the status check a refusal fell through to the summary line
      // below and read as "0 new message(s) across 0 channel(s)" — a clean
      // sync that never happened, rather than "you were not allowed to run it".
      if (!res.ok || !json.ok) {
        setError(json.error ?? "Could not retrieve — nothing was fetched.");
        return;
      }
      const sources: SyncSource[] = json.sources ?? [];
      const t = json.totals;
      setSyncResult(
        `${t.conversations} new message(s), ${t.reviews} review(s) · ${t.synced ?? 0} synced, ${t.skipped ?? 0} skipped, ${t.errored ?? 0} errored`,
      );
      setSyncSources(sources);
    } finally {
      setSyncing(false);
    }
  }

  const connectedCount = state.filter((r) => r.connected).length;

  return (
    <Card>
      <SectionTitle
        title="Channels"
        hint={`${connectedCount} of ${state.length} connected · tokens are stored server-side and never reach the browser`}
        action={
          <button
            onClick={sync}
            disabled={syncing}
            className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600 disabled:opacity-50"
          >
            {syncing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Retrieve everything
          </button>
        }
      />

      {syncResult && <p className="mb-3 rounded-lg bg-good-500/10 px-3 py-2 text-[12px] text-good-400">{syncResult}</p>}
      {syncSources.length > 0 && (
        <ul className="mb-3 space-y-1 rounded-lg border border-ink-700 px-3 py-2 text-[11.5px]">
          {syncSources.map((s) => (
            <li key={s.channel + s.handle} className="flex flex-wrap items-baseline gap-2">
              <Badge tone={s.status === "synced" ? "good" : s.status === "error" ? "bad" : "neutral"}>{s.status}</Badge>
              <span className="font-medium text-mist-200">{s.channel}</span>
              <span className="text-mist-400">{s.handle}</span>
              <span className="text-mist-400">{s.error ?? s.detail ?? (s.status === "synced" ? `${s.fetched} item(s) fetched` : "")}</span>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mb-3 rounded-lg bg-bad-500/10 px-3 py-2 text-[12px] text-bad-400">{error}</p>}

      <div className="space-y-2">
        {state.map((r) => {
          const open = expanded === r.channel;
          return (
            <div key={r.channel} className="rounded-xl border border-ink-700">
              <div className="flex flex-wrap items-center gap-3 p-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-[12px] font-bold text-white" style={{ background: r.color }}>
                  {r.label[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-mist-100">{r.label}</span>
                    {r.connected ? (
                      <Badge tone={r.status === "expired" || r.status === "error" ? "bad" : "good"}>{r.status ?? "connected"}</Badge>
                    ) : (
                      <Badge tone="neutral">not connected</Badge>
                    )}
                  </div>
                  <div className="truncate text-[11px] text-mist-400">{r.handle ?? r.unlocks[0]}</div>
                </div>

                <button onClick={() => setExpanded(open ? null : r.channel)} className="text-[11.5px] text-mist-400 hover:text-mist-200">
                  {open ? "Hide" : "What it unlocks"}
                </button>

                <button
                  onClick={() => toggle(r.channel, r.connected)}
                  disabled={busy === r.channel}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors disabled:opacity-50",
                    r.connected
                      ? "border border-ink-700 text-mist-300 hover:border-bad-500/50 hover:text-bad-400"
                      : "bg-brand-500 text-[var(--a-on)] hover:bg-brand-600",
                  )}
                >
                  {busy === r.channel ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : r.connected ? (
                    <Unplug size={12} />
                  ) : (
                    <Plug size={12} />
                  )}
                  {r.connected ? "Disconnect" : r.status === "expired" ? "Reconnect" : "Connect"}
                </button>
              </div>

              {open && (
                <div className="space-y-3 border-t border-ink-800 px-3 py-3 text-[11.5px]">
                  <div>
                    <div className="mb-1 font-medium text-mist-200">Unlocks</div>
                    <ul className="space-y-0.5 text-mist-400">
                      {r.unlocks.map((u) => (
                        <li key={u} className="flex gap-1.5">
                          <Check size={12} className="mt-0.5 shrink-0 text-good-400" /> {u}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <div className="mb-1 font-medium text-mist-200">Permissions requested</div>
                    <div className="flex flex-wrap gap-1">
                      {r.scopes.map((s) => (
                        <code key={s} className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-mist-300">{s}</code>
                      ))}
                    </div>
                  </div>
                  {r.notes?.length ? (
                    <div>
                      <div className="mb-1 font-medium text-mist-200">Before you connect</div>
                      <ul className="space-y-0.5 text-mist-400">
                        {r.notes.map((n) => <li key={n}>· {n}</li>)}
                      </ul>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-1.5 text-mist-500">
                    <Link2 size={11} /> Env: {r.envVars.map((v) => <code key={v} className="mx-0.5 rounded bg-ink-800 px-1 py-0.5 text-[10px]">{v}</code>)}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
