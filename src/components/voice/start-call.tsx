"use client";

import { useState } from "react";
import { Phone, Loader2, X } from "lucide-react";

export function StartCallDialog({
  brandId,
  agentId,
  onComplete,
}: {
  brandId: string;
  agentId?: string | null;
  onComplete?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startCall(e: React.FormEvent) {
    e.preventDefault();
    if (!agentId) {
      setError("No agent configured for this brand.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/voice/call", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId, agentId, phone }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || "Failed to start call");
      setOpen(false);
      setPhone("");
      onComplete?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 rounded-full bg-brand-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-brand-600"
      >
        <Phone size={13} /> Start AI Call
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-sm rounded-2xl border border-ink-800 bg-ink-950 p-6 shadow-2xl">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute right-4 top-4 text-mist-400 hover:text-mist-100"
        >
          <X size={16} />
        </button>
        <h3 className="mb-1 text-lg font-bold text-mist-100">Start an AI Call</h3>
        <p className="mb-5 text-sm text-mist-400">The agent will call this number immediately.</p>
        <form onSubmit={startCall} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-mist-400">
              Phone Number
            </label>
            <input
              type="text"
              required
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-mist-100 placeholder-ink-600 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          {error && <p className="text-[12.5px] text-warn-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !phone}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand-500 py-2.5 text-sm font-medium text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Phone size={16} />}
            {loading ? "Calling..." : "Start Call"}
          </button>
        </form>
      </div>
    </div>
  );
}
