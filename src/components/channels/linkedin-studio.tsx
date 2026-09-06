"use client";

import { useEffect, useState } from "react";
import {
  Linkedin,
  ExternalLink,
  Info,
  CheckCircle2,
  RefreshCw,
  Share2,
  Building2,
  UserCheck,
} from "lucide-react";
import { Card, SectionTitle, Badge } from "@/components/ui";

export function LinkedInStudio({ brandId }: { brandId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/analytics/uploadpost")
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) {
          setData(json.platforms?.linkedin);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <Card>
      <SectionTitle
        title="LinkedIn Studio"
        hint="Publishing connector & profile status"
        action={
          <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
            Active
          </span>
        }
      />

      <div className="space-y-6">
        {/* Profile Card */}
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-ink-800 bg-ink-900/60 p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-[#0077b5] text-white shadow-md">
              <Linkedin size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-[14.5px] font-semibold text-mist-100">
                  {data?.displayName || "Kiwik.One 1"}
                </h3>
                <Badge tone="good">Connected</Badge>
              </div>
              <p className="text-[12px] text-mist-400">
                Managed through the publishing connector
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-3 py-1 text-[11px] font-medium text-sky-300">
              Personal Profile
            </span>
          </div>
        </div>

        {/* API Limitation & Advice Banner */}
        <div className="rounded-xl border border-sky-500/20 bg-sky-500/[0.04] p-4 text-[12px] leading-relaxed text-mist-300">
          <div className="flex items-start gap-3">
            <Info size={16} className="mt-0.5 shrink-0 text-sky-400" />
            <div className="space-y-1.5">
              <p className="font-semibold text-mist-100">LinkedIn Analytics Information</p>
              <p>
                LinkedIn&apos;s official API permits organic publishing to personal profiles, but restricts post reach and impressions timeseries metrics to <strong>Company / Organization Pages</strong> you administer.
              </p>
              <p className="text-mist-400">
                You can publish updates, carousels, and announcements to this profile directly from the Villa-OS Composer. If you manage a Company Page for your brand, connect it via the publishing connector to enable follower growth and engagement charts.
              </p>
            </div>
          </div>
        </div>

        {/* Quick Actions */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-mist-200">
              <Share2 size={14} className="text-sky-400" />
              Publishing Ready
            </div>
            <p className="mt-1 text-[11.5px] text-mist-400">
              Post text, photos, and carousels directly to LinkedIn from Composer or Version 2.
            </p>
          </div>

          <div className="rounded-xl border border-ink-800 bg-ink-900/40 p-4">
            <div className="flex items-center gap-2 text-[12.5px] font-semibold text-mist-200">
              <Building2 size={14} className="text-indigo-400" />
              Connect Company Page
            </div>
            <p className="mt-1 text-[11.5px] text-mist-400">
              Link your organization page to unlock comprehensive analytics and engagement stats.
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}
