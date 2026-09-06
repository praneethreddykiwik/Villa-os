"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BookOpen, Building2, Check, HelpCircle, Loader2, MapPin, MessageCircle,
  Save, Users, Calendar, Sparkles,
} from "lucide-react";
import { Card, SectionTitle, LiquidSegmentedControl } from "@/components/ui";

type Tab = "property" | "local" | "team" | "booking" | "faqs" | "preview";

interface TrainingData {
  propertyInfo: string;
  localKnowledge: string;
  salesTeam: string;
  bookingFlow: string;
  faqs: string;
  customPrompt: string;
}

const DEFAULT_DATA: TrainingData = {
  propertyInfo: `Project: Glentree Meadows
Location: North Bangalore (Devanahalli)
Configuration: 2BHK (1,050 sq ft), 3BHK (1,450 sq ft), 4BHK (2,100 sq ft)
Price: 2BHK from ₹85L, 3BHK from ₹1.15Cr, 4BHK from ₹1.65Cr
Amenities: Swimming pool, gym, clubhouse, 24/7 security, EV charging
Possession: Q3 2026
EMI: Starting from ₹45,000/month (90% loan eligible)`,

  localKnowledge: `Schools nearby:
- Devanahalli Public School — 1.2 km
- Ryan International School — 3.5 km
- Presidency School — 4 km

Hospitals:
- Columbia Asia Hospital — 5 km
- Manipal Hospital — 8 km

Transport:
- Kempegowda International Airport — 12 km
- NH 44 highway — 2 km
- Proposed Metro Line (by 2027) — 3 km`,

  salesTeam: `Sales Manager: Rajesh Kumar
Phone: +91 98765 43210
Availability: Mon–Sat, 9am–7pm

Senior Advisor: Priya Sharma
Phone: +91 98765 43211
Availability: Mon–Sun, 10am–6pm

To schedule a call, say 'I want to talk to a salesman' or 'Schedule a call'`,

  bookingFlow: `Step 1: Site Visit
- Schedule a free site visit by providing your name, phone and preferred date
- Our team will confirm within 2 hours

Step 2: Expression of Interest
- Pay a refundable EOI of ₹1,00,000 to block your unit

Step 3: Loan & Documents
- Our loan desk will help with home loan applications (90% funding available)
- Required: Aadhar, PAN, 6-month bank statement, salary slips

Step 4: Agreement
- Sale agreement signed within 30 days of EOI

To book now, say 'I want to schedule a site visit'`,

  faqs: `Q: What is the total project size?
A: 12 acres with 800 units across 8 towers.

Q: Is it RERA approved?
A: Yes, RERA number: PRM/KA/RERA/1251/446/PR/170520/002234

Q: Do you offer flexible payment plans?
A: Yes — construction-linked plans and down-payment plans available.

Q: Is the area flood-prone?
A: No, the project is on elevated land with proper drainage systems.

Q: What is the maintenance charge?
A: ₹3/sq ft per month.`,

  customPrompt: "",
};

const TABS: { id: Tab; label: string; icon: typeof BookOpen }[] = [
  { id: "property", label: "Properties", icon: Building2 },
  { id: "local", label: "Local Area", icon: MapPin },
  { id: "team", label: "Sales Team", icon: Users },
  { id: "booking", label: "Booking", icon: Calendar },
  { id: "faqs", label: "FAQs", icon: HelpCircle },
  { id: "preview", label: "Preview", icon: Sparkles },
];

export function WhatsAppTrainingPanel({ brandId }: { brandId: string }) {
  const [tab, setTab] = useState<Tab>("property");
  const [data, setData] = useState<TrainingData>(DEFAULT_DATA);
  const [preview, setPreview] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testMessage, setTestMessage] = useState("");
  const [testResponse, setTestResponse] = useState("");
  const [testing, setTesting] = useState(false);

  // Load existing config
  useEffect(() => {
    fetch(`/api/whatsapp/train?brandId=${encodeURIComponent(brandId)}`)
      .then((r) => r.json())
      .then((r) => {
        if (r.ok && r.config) {
          setData({
            propertyInfo: r.config.propertyInfo ?? DEFAULT_DATA.propertyInfo,
            localKnowledge: r.config.localKnowledge ?? DEFAULT_DATA.localKnowledge,
            salesTeam: r.config.salesTeam ?? DEFAULT_DATA.salesTeam,
            bookingFlow: r.config.bookingFlow ?? DEFAULT_DATA.bookingFlow,
            faqs: r.config.faqs ?? DEFAULT_DATA.faqs,
            customPrompt: r.config.customPrompt ?? "",
          });
          if (r.config.systemPrompt) setPreview(r.config.systemPrompt);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [brandId]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      const res = await fetch("/api/whatsapp/train", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId, ...data }),
      });
      const json = await res.json();
      if (json.ok) {
        setSaved(true);
        setPreview(json.systemPrompt);
        setTimeout(() => setSaved(false), 3000);
      }
    } catch {}
    setSaving(false);
  }, [brandId, data]);

  const handleTest = useCallback(async () => {
    if (!testMessage.trim()) return;
    setTesting(true);
    setTestResponse("");
    try {
      // Simulate a test by showing what the AI would be prompted with
      const lines = preview.split("\n");
      const relevant = lines.filter((l) =>
        l.toLowerCase().includes(testMessage.toLowerCase().split(" ")[0])
      ).join("\n");
      setTestResponse(
        relevant
          ? `Based on the knowledge base:\n\n${relevant}`
          : "I'd be happy to help! Could you please provide more details so I can assist you better? Alternatively, I can connect you with one of our sales advisors."
      );
    } catch {}
    setTesting(false);
  }, [testMessage, preview]);

  const update = (field: keyof TrainingData) => (e: React.ChangeEvent<HTMLTextAreaElement>) =>
    setData((prev) => ({ ...prev, [field]: e.target.value }));

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-mist-400">
        <Loader2 size={16} className="animate-spin mr-2" /> Loading training data…
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <Card>
        <div className="flex items-start gap-4">
          <div className="grid h-11 w-11 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500/20 to-teal-500/20 border border-emerald-500/30 text-emerald-400">
            <MessageCircle size={20} />
          </div>
          <div className="flex-1">
            <h2 className="text-[15px] font-bold text-mist-100">WhatsApp AI Training</h2>
            <p className="mt-1 text-[12.5px] text-mist-400">
              Train the WhatsApp assistant with your property details, pricing, local knowledge, and sales team
              contacts. The AI uses this to answer buyer questions 24/7.
            </p>
          </div>
          <button
            onClick={handleSave}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-full border border-brand-500/30 bg-brand-500/15 px-4 py-1.5 text-[12px] font-semibold text-brand-300 hover:bg-brand-500/25 transition-all disabled:opacity-50"
          >
            {saving ? (
              <Loader2 size={12} className="animate-spin" />
            ) : saved ? (
              <Check size={12} className="text-good-400" />
            ) : (
              <Save size={12} />
            )}
            {saved ? "Saved!" : saving ? "Saving…" : "Save & Train"}
          </button>
        </div>
      </Card>

      {/* Tab selector */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-all ${
                active
                  ? "border-brand-500/40 bg-brand-500/15 text-brand-300"
                  : "border-ink-700 text-mist-400 hover:text-mist-100 hover:border-ink-600"
              }`}
            >
              <Icon size={12} />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      {tab === "property" && (
        <TrainingSection
          title="Properties & Pricing"
          hint="List project names, configurations (2BHK, 3BHK), prices, amenities, and possession dates. One item per line."
          value={data.propertyInfo}
          onChange={update("propertyInfo")}
        />
      )}
      {tab === "local" && (
        <TrainingSection
          title="Local Area Knowledge"
          hint="Nearby schools with distances, hospitals, transport links, market access. Buyers ask about schools most often."
          value={data.localKnowledge}
          onChange={update("localKnowledge")}
        />
      )}
      {tab === "team" && (
        <TrainingSection
          title="Sales Team Contacts"
          hint="List salesman names, phone numbers, and availability. The AI will share these when a buyer asks to speak to someone."
          value={data.salesTeam}
          onChange={update("salesTeam")}
        />
      )}
      {tab === "booking" && (
        <TrainingSection
          title="Booking & Site Visit Flow"
          hint="Step-by-step process: how to schedule a site visit, token deposit amounts, loan assistance process."
          value={data.bookingFlow}
          onChange={update("bookingFlow")}
        />
      )}
      {tab === "faqs" && (
        <TrainingSection
          title="Frequently Asked Questions"
          hint="Q&A format. The AI will use exact answers from here when buyers ask similar questions."
          value={data.faqs}
          onChange={update("faqs")}
        />
      )}
      {tab === "preview" && (
        <Card>
          <SectionTitle
            title="System Prompt Preview"
            hint="This is the full instruction sent to the AI for every WhatsApp conversation. Save to update it."
          />
          {preview ? (
            <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-lg border border-ink-800 bg-ink-900/60 p-4 text-[11px] leading-relaxed text-mist-300">
              {preview}
            </pre>
          ) : (
            <p className="py-6 text-center text-[12.5px] text-mist-400">
              Save the training data first to generate the system prompt preview.
            </p>
          )}

          {/* Test the bot */}
          <div className="mt-5 space-y-3">
            <p className="text-[12px] font-semibold text-mist-300">Test a question</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={testMessage}
                onChange={(e) => setTestMessage(e.target.value)}
                placeholder="e.g. What schools are nearby? What is the price?"
                className="flex-1 rounded-xl border border-ink-700 bg-ink-900 px-3 py-2 text-[12.5px] text-mist-100 outline-none placeholder:text-mist-500 focus:border-brand-500/50"
                onKeyDown={(e) => e.key === "Enter" && handleTest()}
              />
              <button
                onClick={handleTest}
                disabled={testing || !testMessage.trim()}
                className="inline-flex items-center gap-1.5 rounded-xl border border-ink-700 bg-ink-800 px-4 py-2 text-[12px] text-mist-200 hover:bg-ink-700 disabled:opacity-50"
              >
                {testing ? <Loader2 size={12} className="animate-spin" /> : "Test"}
              </button>
            </div>
            {testResponse && (
              <div className="rounded-lg border border-ink-800 bg-ink-900/60 px-3 py-2.5 text-[12px] text-mist-300 whitespace-pre-wrap">
                {testResponse}
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}

function TrainingSection({
  title, hint, value, onChange,
}: {
  title: string;
  hint: string;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <Card>
      <SectionTitle title={title} hint={hint} />
      <textarea
        value={value}
        onChange={onChange}
        rows={14}
        className="w-full rounded-xl border border-ink-700 bg-ink-900/60 px-4 py-3 text-[12.5px] leading-relaxed text-mist-200 outline-none placeholder:text-mist-500 focus:border-brand-500/50 resize-y"
        placeholder={`Enter ${title.toLowerCase()} here…`}
      />
    </Card>
  );
}
