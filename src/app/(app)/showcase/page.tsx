import { pageContext, qs } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Orion3dShowcase } from "@/components/showcase/orion-3d-showcase";
import { Card, SectionTitle, Badge } from "@/components/ui";
import {
  Building2, MapPin, Sparkles, Compass, ShieldCheck,
  CheckCircle2, Trees, Trophy, Waves, Car, ExternalLink
} from "lucide-react";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function ShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);
  const link = qs(sp);

  return (
    <>
      <TopBar
        brands={db.brands}
        brandId={brandId}
        title="3D Virtual Showcase"
        subtitle={`Interactive Master Plan · Ramky One Orion (Uppal - Pocharam, Hyderabad)`}
        right={
          <div className="flex items-center gap-2">
            <Badge tone="good">
              <span className="beacon-dot bg-good-400 mr-1" />
              Unreal Engine 5.5 Path Tracer
            </Badge>
            <a
              href="https://ramkyoneorion.com/"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-ink-700 bg-ink-800/80 px-3 py-1.5 text-xs font-medium text-mist-200 hover:border-ink-600 hover:text-white transition"
            >
              <span>Official Site</span>
              <ExternalLink size={11} />
            </a>
          </div>
        }
      />

      <div className="space-y-6 p-7">
        {/* Main 3D Canvas Showcase */}
        <Orion3dShowcase />

        {/* Project Key Metrics Row */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-4 transition hover:border-ink-700">
            <div className="flex items-center gap-2 text-amber-400">
              <Building2 size={16} />
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-mist-400">Towers</span>
            </div>
            <p className="tnum mt-2 text-2xl font-bold text-white">6 Towers</p>
            <p className="text-[11px] text-mist-400">G + 16 High-Rise</p>
          </div>

          <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-4 transition hover:border-ink-700">
            <div className="flex items-center gap-2 text-emerald-400">
              <Trees size={16} />
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-mist-400">Project Area</span>
            </div>
            <p className="tnum mt-2 text-2xl font-bold text-white">8.5 Acres</p>
            <p className="text-[11px] text-mist-400">70% Open Green Space</p>
          </div>

          <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-4 transition hover:border-ink-700">
            <div className="flex items-center gap-2 text-blue-400">
              <Waves size={16} />
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-mist-400">Clubhouse</span>
            </div>
            <p className="tnum mt-2 text-2xl font-bold text-white">25,000 <span className="text-xs font-normal">sq.ft</span></p>
            <p className="text-[11px] text-mist-400">Rooftop Infinity Pool</p>
          </div>

          <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-4 transition hover:border-ink-700">
            <div className="flex items-center gap-2 text-purple-400">
              <Compass size={16} />
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-mist-400">Vastu</span>
            </div>
            <p className="tnum mt-2 text-2xl font-bold text-white">100%</p>
            <p className="text-[11px] text-mist-400">East & West Facing</p>
          </div>

          <div className="rounded-2xl border border-ink-800 bg-ink-900/40 p-4 transition hover:border-ink-700">
            <div className="flex items-center gap-2 text-orange-400">
              <ShieldCheck size={16} />
              <span className="text-[10.5px] font-bold uppercase tracking-wider text-mist-400">RERA Status</span>
            </div>
            <p className="tnum mt-2 text-2xl font-bold text-white">Approved</p>
            <p className="text-[11px] text-mist-400">P02200004523</p>
          </div>
        </div>

        {/* Master Amenities & Location Section */}
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <SectionTitle
              title="Master Plan & Community Features"
              hint="Designed for luxury living with multi-tiered tropical landscaping"
            />

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="flex items-start gap-3 rounded-xl border border-ink-800/80 bg-ink-900/50 p-3.5">
                <div className="rounded-lg bg-amber-400/10 p-2 text-amber-400">
                  <Waves size={16} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white">Skyline Infinity Pool</h4>
                  <p className="mt-0.5 text-[11px] text-mist-400">
                    Rooftop infinity swimming pool with separate kids splash pool and sun lounge deck.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-ink-800/80 bg-ink-900/50 p-3.5">
                <div className="rounded-lg bg-emerald-400/10 p-2 text-emerald-400">
                  <Trophy size={16} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white">Outdoor Sports Arena</h4>
                  <p className="mt-0.5 text-[11px] text-mist-400">
                    Floodlit regulation tennis and basketball courts, outdoor fitness gym and skating ring.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-ink-800/80 bg-ink-900/50 p-3.5">
                <div className="rounded-lg bg-purple-400/10 p-2 text-purple-400">
                  <Trees size={16} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white">Central Botanical Park</h4>
                  <p className="mt-0.5 text-[11px] text-mist-400">
                    Continuous 1.2km jogging trail, meditation gazebos, aroma garden, and reflexology path.
                  </p>
                </div>
              </div>

              <div className="flex items-start gap-3 rounded-xl border border-ink-800/80 bg-ink-900/50 p-3.5">
                <div className="rounded-lg bg-blue-400/10 p-2 text-blue-400">
                  <Car size={16} />
                </div>
                <div>
                  <h4 className="text-xs font-bold text-white">Vehicular Free Podium</h4>
                  <p className="mt-0.5 text-[11px] text-mist-400">
                    100% vehicle-free central pedestrian zone with dedicated basement parking access.
                  </p>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionTitle
              title="Location Advantage"
              hint="Uppal - Pocharam Growth Corridor"
            />

            <div className="mt-4 space-y-3 text-xs">
              <div className="flex items-center justify-between rounded-lg border border-ink-800/60 bg-ink-900/40 px-3 py-2.5">
                <span className="text-mist-300 font-medium">Infosys SEZ Pocharam</span>
                <span className="tnum font-bold text-amber-400">2 Mins</span>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-ink-800/60 bg-ink-900/40 px-3 py-2.5">
                <span className="text-mist-300 font-medium">Raheja Mindspace IT Park</span>
                <span className="tnum font-bold text-amber-400">5 Mins</span>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-ink-800/60 bg-ink-900/40 px-3 py-2.5">
                <span className="text-mist-300 font-medium">Outer Ring Road (ORR Exit 9)</span>
                <span className="tnum font-bold text-amber-400">3 Mins</span>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-ink-800/60 bg-ink-900/40 px-3 py-2.5">
                <span className="text-mist-300 font-medium">Uppal Metro Station</span>
                <span className="tnum font-bold text-amber-400">15 Mins</span>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-ink-800/60 bg-ink-900/40 px-3 py-2.5">
                <span className="text-mist-300 font-medium">Secunderabad Railway Station</span>
                <span className="tnum font-bold text-amber-400">25 Mins</span>
              </div>
            </div>

            <div className="mt-5 border-t border-ink-800 pt-4">
              <Link
                href={`/composer${link}`}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 py-2.5 text-xs font-bold text-black shadow-lg shadow-orange-500/20 transition hover:brightness-110"
              >
                <Sparkles size={14} />
                Create Social Campaign from 3D Renders
              </Link>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
