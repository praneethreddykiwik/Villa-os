"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";

/**
 * Site-visit requests waiting on somebody.
 *
 * A customer who asks for a slot is waiting for an answer, and the cost of not
 * noticing is that they go quiet and book elsewhere. So the count lives in the
 * header on every screen rather than only on the page that answers it.
 *
 * It polls rather than streams: this is a number that may be a minute stale
 * without anybody being worse off, and a socket per open tab is not worth it.
 */
export function VisitRequestsBell() {
  const [pending, setPending] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch("/api/osf/site-visits/pending", { cache: "no-store" });
        const json = await res.json();
        if (alive && json?.ok) setPending(json.pending as number);
      } catch {
        /* keep whatever was last shown rather than flashing an error */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const count = pending ?? 0;
  const waiting = count > 0;

  return (
    <Link
      href="/inbox/whatsapp/sales/site-visits"
      aria-label={waiting ? `${count} site visit request${count === 1 ? "" : "s"} waiting` : "Site visit requests"}
      title={waiting ? `${count} waiting for an answer` : "No requests waiting"}
      className="relative grid h-9 w-9 place-items-center rounded-xl border border-ink-700/80 bg-ink-900/60 text-mist-400 transition hover:text-mist-100"
    >
      <Bell size={15} strokeWidth={1.75} aria-hidden />
      {waiting && (
        <span className="absolute -right-1 -top-1 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--color-gold-300)] px-1 text-[10px] font-bold text-ink-950">
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
