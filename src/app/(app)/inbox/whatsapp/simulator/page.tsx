"use client";

import { useRef, useState } from "react";

interface Bubble {
  from: "customer" | "agent";
  text?: string;
  mediaUrl?: string;
  mediaKind?: string;
}

interface Meta {
  leadScore: number;
  temperature: string;
  toolsUsed: string[];
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const OPENERS = [
  "Hi",
  "What's the price?",
  "I'm looking for a 4 BHK around ₹2.5 crore for my family",
  "How far is it from the airport?",
  "Can you send me the brochure?",
  "I want to buy this month. What's the final price?",
  "Is it RERA approved?",
  "What guaranteed returns will I get?",
];

export default function SimulatorPage() {
  const [phone, setPhone] = useState("000000000001");
  const [input, setInput] = useState("");
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  async function send(text: string) {
    if (!text.trim() || busy) return;

    setBubbles((b) => [...b, { from: "customer", text }]);
    setInput("");
    setBusy(true);
    setError(null);

    try {
      const res = await fetch("/api/osf/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Request failed");
      } else if (data.skipped) {
        setError(data.note);
      } else {
        setBubbles((b) => [
          ...b,
          ...(data.replies as Array<{ text?: string; mediaUrl?: string; mediaKind?: string }>).map(
            (r) => ({ from: "agent" as const, ...r }),
          ),
        ]);
        setMeta({
          leadScore: data.leadScore,
          temperature: data.temperature,
          toolsUsed: data.toolsUsed ?? [],
          // toolsUsed is already defended; usage was not, and the card below
          // reads four counters straight off it. A provider path that reports
          // no token counts would throw during render rather than show zeroes.
          usage: data.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  }

  return (
    <>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Simulator</h1>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Talk to the agent exactly as a WhatsApp customer would. Same prompt, same tools, same
          CRM writes — nothing is sent to Meta. Everything here shows up as a real lead.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <div className="card flex h-[560px] flex-col p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-line)] px-4 py-3">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-[var(--color-muted)]">Test number</span>
                <input
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  className="w-40 rounded-md border border-[var(--color-line)] px-2 py-1 font-mono text-xs"
                />
              </div>
              <button
                onClick={() => {
                  setBubbles([]);
                  setMeta(null);
                  setError(null);
                }}
                className="text-xs text-[var(--color-muted)] hover:underline"
              >
                Clear view
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {bubbles.length === 0 && (
                <p className="pt-16 text-center text-sm text-[var(--color-muted)]">
                  Send a message to start.
                </p>
              )}
              {bubbles.map((b, i) => (
                <div
                  key={i}
                  className={`flex ${b.from === "customer" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[78%] rounded-2xl px-4 py-2.5 ${
                      b.from === "customer"
                        ? "rounded-tr-sm bg-[var(--color-gold-soft)]"
                        : "rounded-tl-sm bg-[var(--color-canvas)]"
                    }`}
                  >
                    {b.text && <p className="whitespace-pre-wrap text-sm">{b.text}</p>}
                    {b.mediaUrl && (
                      <a
                        href={b.mediaUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs underline"
                      >
                        📎 {b.mediaKind?.replace(/_/g, " ")}
                      </a>
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <p className="text-xs text-[var(--color-muted)]">agent is typing…</p>
              )}
              {error && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
                  {error}
                </div>
              )}
              <div ref={endRef} />
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send(input);
              }}
              className="flex gap-2 border-t border-[var(--color-line)] p-3"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type as the customer…"
                className="flex-1 rounded-lg border border-[var(--color-line)] px-3 py-2 text-sm"
                disabled={busy}
              />
              <button
                type="submit"
                disabled={busy || !input.trim()}
                className="rounded-lg bg-[var(--color-gold-500)] px-4 py-2 text-sm font-medium text-[var(--a-on)] disabled:opacity-40"
              >
                Send
              </button>
            </form>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <p className="label">Try these</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {OPENERS.map((o) => (
                <button
                  key={o}
                  onClick={() => void send(o)}
                  disabled={busy}
                  className="rounded-full border border-[var(--color-line)] px-3 py-1 text-left text-xs hover:bg-[var(--color-raised)] disabled:opacity-40"
                >
                  {o}
                </button>
              ))}
            </div>
            <p className="mt-3 text-xs text-[var(--color-muted)]">
              The last two are the important ones — they test that the agent refuses to invent a
              &ldquo;final price&rdquo; or promise returns.
            </p>
          </div>

          {meta && (
            <div className="card">
              <p className="label">Behind the scenes</p>
              <dl className="mt-3 space-y-2 text-sm">
                <Row k="Lead score" v={`${meta.leadScore}/100`} />
                <Row k="Temperature" v={meta.temperature} />
                <Row k="Tools called" v={meta.toolsUsed.length ? meta.toolsUsed.join(", ") : "none"} />
                <Row k="Input tokens" v={meta.usage.input.toLocaleString()} />
                <Row k="Output tokens" v={meta.usage.output.toLocaleString()} />
                <Row k="Cache read" v={meta.usage.cacheRead.toLocaleString()} />
                <Row k="Cache write" v={meta.usage.cacheWrite.toLocaleString()} />
              </dl>
              <p className="mt-3 border-t border-[var(--color-line)] pt-3 text-xs text-[var(--color-muted)]">
                Cache read should climb after the first message. If it stays at zero, the prompt
                prefix is changing between calls.
              </p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-muted)]">{k}</dt>
      <dd className="text-right font-medium">{v}</dd>
    </div>
  );
}
