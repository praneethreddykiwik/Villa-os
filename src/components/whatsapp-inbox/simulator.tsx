"use client";

import { useState } from "react";
import {
  Bot, Check, ChevronRight, FileText, FlaskConical, Loader2,
  MessageSquare, Send, Sparkles, User, X
} from "lucide-react";

interface SimulationResult {
  messageId: string;
  customerId: string;
  reply: string | null;
  replyTag?: string;
  salesTaskId?: string;
  documentId?: string;
  appointmentId?: string;
}

const PRESET_PROMPTS = [
  {
    category: "Villa Inquiries",
    items: [
      { label: "3BHK Price & Layout", text: "Hi, what is the price and layout for a 3BHK villa?" },
      { label: "Amenities & Parks", text: "What amenities do you have in the clubhouse and how many parks?" },
      { label: "Location & Schools", text: "Where is Glentree Serenity located and what schools are nearby?" },
    ],
  },
  {
    category: "Site Visit Booking",
    items: [
      { label: "Request Visit", text: "Can I schedule a site visit for this Saturday?" },
      { label: "Select Slot 1", text: "1" },
      { label: "Select Slot 2", text: "2" },
    ],
  },
  {
    category: "Home Loan & Documents",
    items: [
      { label: "Loan Inquiry", text: "I need a home loan for a villa. What documents do I need to send?" },
      { label: "Upload Aadhaar (Doc)", text: "Here is my Aadhaar card for the loan", isDoc: true, docType: "aadhaar", filename: "aadhaar_card.pdf" },
      { label: "Upload PAN Card (Doc)", text: "Sending my PAN card scan", isDoc: true, docType: "pan", filename: "pan_card.pdf" },
      { label: "Upload Bank Statement (Doc)", text: "Here is my 6 months bank statement", isDoc: true, docType: "bank_statements", filename: "bank_statement.pdf" },
    ],
  },
  {
    category: "Multilingual",
    items: [
      { label: "Telugu", text: "నమస్కారం, 3BHK విల్లా ధర మరియు విజిట్ వివరాలు చెప్పండి" },
      { label: "Hindi", text: "नमस्ते, क्या आप मुझे 3 BHK विला की कीमत और विज़िट के बारे में बता सकते हैं?" },
    ],
  },
];

export function WhatsAppSimulator({
  onSelectCustomer,
  onClose,
}: {
  onSelectCustomer?: (customerId: string) => void;
  onClose: () => void;
}) {
  const [phone, setPhone] = useState("+91 98765 43210");
  const [name, setName] = useState("Koushik");
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<Array<{ sender: "user" | "ai"; text: string; tag?: string; meta?: any }>>([
    {
      sender: "ai",
      text: "Namaste! Welcome to Glentree Serenity WhatsApp assistant. How can I help you find your dream villa today?",
      tag: "welcome",
    },
  ]);
  const [lastResult, setLastResult] = useState<SimulationResult | null>(null);

  const handleSend = async (messageText?: string, docMeta?: { isDoc?: boolean; docType?: string; filename?: string }) => {
    const textToSend = messageText ?? input;
    if (!textToSend.trim() && !docMeta?.isDoc) return;

    const userEntry = {
      sender: "user" as const,
      text: docMeta?.isDoc ? `[Document: ${docMeta.filename}] ${textToSend}` : textToSend,
    };
    setHistory((prev) => [...prev, userEntry]);
    if (!messageText) setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/whatsapp/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone,
          name,
          body: textToSend,
          type: docMeta?.isDoc ? "document" : "text",
          documentType: docMeta?.docType,
          filename: docMeta?.filename,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setLastResult(data);
        if (data.reply) {
          setHistory((prev) => [
            ...prev,
            {
              sender: "ai",
              text: data.reply,
              tag: data.replyTag,
              meta: {
                salesTask: data.salesTaskId,
                document: data.documentId,
                appointment: data.appointmentId,
              },
            },
          ]);
        }
      } else {
        setHistory((prev) => [
          ...prev,
          { sender: "ai", text: `[Error: ${data.error || "Simulation failed"}]` },
        ]);
      }
    } catch (e) {
      setHistory((prev) => [
        ...prev,
        { sender: "ai", text: `[Network error: ${e instanceof Error ? e.message : String(e)}]` },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex h-[90vh] max-h-[820px] w-full max-w-4xl overflow-hidden rounded-2xl border border-ink-800 bg-ink-950 shadow-2xl">
        
        {/* Left column: Controls & Scenarios */}
        <div className="flex w-1/2 flex-col border-r border-ink-800 bg-ink-900/60 p-5">
          <div className="flex items-center justify-between pb-4 border-b border-ink-800">
            <div className="flex items-center gap-2.5">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                <FlaskConical size={18} />
              </div>
              <div>
                <h3 className="text-[14px] font-bold text-mist-100">WhatsApp Agent Simulator</h3>
                <p className="text-[11px] text-mist-400">Test autonomous qualification, loan docs & site visits</p>
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-mist-400 mb-1">
                Your Phone
              </label>
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-emerald-500"
                placeholder="+91..."
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase tracking-wider text-mist-400 mb-1">
                Your Name
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full rounded-lg border border-ink-700 bg-ink-900 px-2.5 py-1.5 text-[12px] text-mist-100 outline-none focus:border-emerald-500"
                placeholder="Name"
              />
            </div>
          </div>

          {/* Quick Test Scenarios */}
          <div className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1">
            <p className="text-[11px] font-bold uppercase tracking-wider text-mist-400">Click to Test Scenarios</p>
            {PRESET_PROMPTS.map((cat) => (
              <div key={cat.category} className="space-y-1.5">
                <div className="text-[10.5px] font-semibold text-emerald-400">{cat.category}</div>
                <div className="flex flex-wrap gap-1.5">
                  {cat.items.map((item) => (
                    <button
                      key={item.label}
                      type="button"
                      disabled={sending}
                      onClick={() => handleSend(item.text, item as any)}
                      className="inline-flex items-center gap-1 rounded-lg border border-ink-700 bg-ink-800/80 px-2.5 py-1 text-[11px] text-mist-200 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/10 hover:text-emerald-300 disabled:opacity-50"
                    >
                      {item.isDoc ? <FileText size={11} className="text-amber-400" /> : null}
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {lastResult && (
            <div className="mt-3 rounded-xl border border-ink-800 bg-ink-900/80 p-3 text-[11.5px] space-y-1">
              <div className="flex items-center justify-between text-mist-300 font-semibold">
                <span>Agent Status</span>
                <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] text-emerald-300">
                  {lastResult.replyTag || "responded"}
                </span>
              </div>
              {lastResult.salesTaskId && (
                <div className="text-mist-400">📋 Created CRM Sales Task: <span className="text-mist-200 font-mono text-[10px]">{lastResult.salesTaskId}</span></div>
              )}
              {lastResult.documentId && (
                <div className="text-mist-400">📑 Saved Document: <span className="text-amber-300 font-mono text-[10px]">{lastResult.documentId}</span></div>
              )}
              {lastResult.appointmentId && (
                <div className="text-mist-400">📅 Confirmed Visit: <span className="text-emerald-400 font-mono text-[10px]">{lastResult.appointmentId}</span></div>
              )}
              {onSelectCustomer && lastResult.customerId && (
                <button
                  type="button"
                  onClick={() => {
                    onSelectCustomer(lastResult.customerId);
                    onClose();
                  }}
                  className="mt-2 text-emerald-400 hover:underline flex items-center gap-1 text-[11.5px] font-semibold"
                >
                  Open Thread in Inbox <ChevronRight size={12} />
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right column: Phone simulation chat feed */}
        <div className="flex w-1/2 flex-col bg-[#0b141a]">
          {/* WhatsApp Phone Header */}
          <div className="flex items-center justify-between border-b border-ink-800/80 bg-[#1f2c34] px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="grid h-8 w-8 place-items-center rounded-full bg-emerald-600 text-white font-bold text-[12px]">
                GT
              </div>
              <div>
                <div className="text-[13px] font-semibold text-mist-100">Glentree AI Assistant</div>
                <div className="text-[10.5px] text-emerald-400">Online · Instant replies 24/7</div>
              </div>
            </div>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-mist-400 hover:bg-ink-800 hover:text-mist-100"
            >
              <X size={18} />
            </button>
          </div>

          {/* Chat Bubble Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3">
            {history.map((h, i) => (
              <div
                key={i}
                className={`flex flex-col ${h.sender === "user" ? "items-end" : "items-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[12.5px] leading-relaxed shadow-sm ${
                    h.sender === "user"
                      ? "rounded-tr-none bg-[#005c4b] text-white"
                      : "rounded-tl-none bg-[#202c33] text-mist-100"
                  }`}
                >
                  <p className="whitespace-pre-wrap break-words">{h.text}</p>
                  <div className="mt-1 flex items-center justify-end gap-1 text-[9.5px] text-mist-400">
                    {h.sender === "ai" && h.tag && (
                      <span className="rounded bg-ink-900/60 px-1 py-0.2 text-emerald-400 font-mono">
                        {h.tag}
                      </span>
                    )}
                    <span>Just now</span>
                    {h.sender === "user" && <Check size={11} className="text-sky-400" />}
                  </div>
                </div>
              </div>
            ))}
            {sending && (
              <div className="flex items-center gap-2 text-[12px] text-mist-400">
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:0.2s]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-emerald-400 [animation-delay:0.4s]" />
                </div>
                <span>Glentree AI is typing…</span>
              </div>
            )}
          </div>

          {/* Input Bar */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSend();
            }}
            className="flex items-center gap-2 border-t border-ink-800/80 bg-[#1f2c34] p-3"
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message as a buyer..."
              disabled={sending}
              className="flex-1 rounded-xl border border-ink-700/80 bg-[#2a3942] px-3 py-2 text-[12.5px] text-mist-100 placeholder:text-mist-500 outline-none focus:border-emerald-500"
            />
            <button
              type="submit"
              disabled={sending || !input.trim()}
              className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-600 text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors shadow-sm"
            >
              {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
