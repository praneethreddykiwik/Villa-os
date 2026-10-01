"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, SectionTitle, Badge, Button } from "./ui";

/**
 * CHANNELS & CONNECTIONS — live health.
 *
 * The page renders the stored state on the server so the grid is readable the
 * instant it loads. This component then replaces each card with the answer the
 * platform itself gave. The distinction matters: a stored "connected" has been
 * wrong here before, and an operator deciding whether to launch a campaign
 * needs to know which of the two they are looking at.
 */

export type HealthState = "live" | "degraded" | "down" | "absent" | "unchecked";

export interface ChannelHealthRow {
  channel: string;
  label: string;
  color: string;
  state: HealthState;
  detail: string;
  identity?: string;
  handle?: string;
  tokenExpiresAt?: string;
  lastSyncedAt?: string;
  checkedAt?: string;
}

export interface WebhookRow {
  name: string;
  path: string;
  carries: string;
  configured: boolean;
  detail: string;
}

const TONE: Record<HealthState, "good" | "warn" | "bad" | "neutral"> = {
  live: "good",
  degraded: "warn",
  down: "bad",
  absent: "bad",
  unchecked: "neutral",
};

const WORD: Record<HealthState, string> = {
  live: "Working",
  degraded: "Needs attention",
  down: "Not working",
  absent: "Not connected",
  unchecked: "Not checked",
};

function when(iso?: string): string {
  if (!iso) return "never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "never";
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function ChannelHealthPanel({
  brandId,
  initial,
  initialWebhooks,
}: {
  brandId: string;
  initial: ChannelHealthRow[];
  initialWebhooks: WebhookRow[];
}) {
  const [rows, setRows] = useState<ChannelHealthRow[]>(initial);
  const [hooks, setHooks] = useState<WebhookRow[]>(initialWebhooks);
  const [busy, setBusy] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(
    async (fresh: boolean) => {
      setBusy(true);
      setNote(null);
      try {
        const res = await fetch(`/api/channels/health?brand=${encodeURIComponent(brandId)}`, {
          method: fresh ? "POST" : "GET",
          cache: "no-store",
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          throttled?: boolean;
          retryAfterSeconds?: number;
          channels?: ChannelHealthRow[];
          webhooks?: WebhookRow[];
        };
        if (!res.ok || !json.ok) {
          setNote(json.error ?? "Could not reach the health check.");
          return;
        }
        if (json.throttled) {
          setNote(`Checked too often. Try again in ${json.retryAfterSeconds ?? 60} seconds.`);
          if (json.webhooks) setHooks(json.webhooks);
          return;
        }
        if (json.channels) setRows(json.channels);
        if (json.webhooks) setHooks(json.webhooks);
        setCheckedAt(new Date().toISOString());
      } catch (e) {
        setNote((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [brandId],
  );

  // One cached read on mount replaces the stored guesses with real answers
  // without costing the operator a click. It does not force a fresh probe.
  useEffect(() => {
    void load(false);
  }, [load]);

  const broken = rows.filter((r) => r.state === "down" || r.state === "absent").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle
          title="Does each one actually work?"
          hint={
            checkedAt
              ? `Answered by the platforms themselves, ${when(checkedAt)}`
              : "Showing the last saved state \u2014 asking each platform now"
          }
        />
        <Button onClick={() => void load(true)} disabled={busy}>
          {busy ? "Checking…" : "Check again"}
        </Button>
      </div>

      {note && (
        <Card className="border-warn-500/30 bg-warn-500/[0.05]">
          <div className="text-[12.5px] text-warn-400">{note}</div>
        </Card>
      )}

      {broken > 0 && (
        <Card className="border-bad-500/30 bg-bad-500/[0.04]">
          <div className="text-[12.5px] font-medium text-bad-400">
            {broken} channel{broken === 1 ? "" : "s"} cannot be used right now. Anything scheduled for
            {broken === 1 ? " it" : " them"} will wait rather than fail.
          </div>
        </Card>
      )}

      {rows.length === 0 ? (
        <Card>
          <div className="text-[12.5px] text-mist-400">
            No channels are connected yet. Use the panel above to connect one.
          </div>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <Card key={r.channel + r.handle} className="card-hover">
              <div className="flex items-start gap-3">
                <span
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[13px] font-bold text-white"
                  style={{ background: r.color }}
                >
                  {r.label[0]}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13px] font-medium text-mist-100">{r.label}</span>
                    <Badge tone={TONE[r.state]}>{WORD[r.state]}</Badge>
                  </div>
                  {r.handle && <div className="truncate text-[11px] text-mist-400">{r.handle}</div>}
                </div>
              </div>

              <p className="mt-2.5 text-[11.5px] leading-relaxed text-mist-300">{r.detail}</p>

              <div className="mt-2.5 space-y-0.5 border-t border-ink-800 pt-2 text-[10.5px] text-mist-400">
                {r.identity && (
                  <div>
                    Confirmed id <span className="text-mist-300">{r.identity}</span>
                  </div>
                )}
                <div>Last synced {when(r.lastSyncedAt)}</div>
                {r.tokenExpiresAt && (
                  <div
                    className={
                      new Date(r.tokenExpiresAt).getTime() - Date.now() < 14 * 864e5 ? "text-warn-400" : ""
                    }
                  >
                    Access expires {new Date(r.tokenExpiresAt).toLocaleDateString()}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <div>
        <SectionTitle
          title="Incoming"
          hint="What the outside world can send you. A channel can publish fine and still receive nothing."
        />
        <div className="grid gap-3 md:grid-cols-3">
          {hooks.map((h) => (
            <Card key={h.path}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium text-mist-100">{h.name}</span>
                <Badge tone={h.configured ? "good" : "warn"}>{h.configured ? "Ready" : "Not set up"}</Badge>
              </div>
              <p className="mt-1.5 text-[11px] text-mist-400">{h.carries}</p>
              <p className="mt-2 break-words text-[10.5px] leading-relaxed text-mist-300">{h.detail}</p>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
