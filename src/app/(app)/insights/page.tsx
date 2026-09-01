import { pageContext } from "@/lib/page-context";
import { generateSuggestions } from "@/lib/ai/signals";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle, Badge, fmt } from "@/components/ui";
import { SuggestionCard } from "@/components/suggestion-card";
import { activeProvider, hasLLM } from "@/lib/ai/provider";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  creative_fatigue: "Creative fatigue",
  budget_shift: "Budget allocation",
  boost_organic: "Boost organic",
  posting_time: "Timing",
  format_mix: "Format mix",
  hook_quality: "Video hooks",
  hashtag: "Hashtags",
  anomaly: "Anomalies",
  pacing: "Budget pacing",
  review_response: "Reputation",
  local_visibility: "Local SEO",
  competitor: "Competitors",
  cadence: "Cadence",
};

export default async function InsightsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId, range } = pageContext(sp);
  const suggestions = generateSuggestions(db, brandId, range);

  const critical = suggestions.filter((s) => s.severity === "critical");
  const opportunities = suggestions.filter((s) => s.severity === "opportunity");
  const info = suggestions.filter((s) => s.severity === "info");

  // Impact totals are grouped by unit — adding "$" to "%" would be nonsense.
  const byUnit = new Map<string, number>();
  for (const s of suggestions) byUnit.set(s.projectedImpact.unit, (byUnit.get(s.projectedImpact.unit) ?? 0) + s.projectedImpact.value);

  const kinds = [...new Set(suggestions.map((s) => s.kind))];

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="AI Insights" subtitle={`${suggestions.length} recommendations for ${brand.name}`} />

      <div className="space-y-6 p-7">
        <div className="grid gap-3 md:grid-cols-4">
          <Card>
            <div className="text-[11px] uppercase tracking-wider text-mist-400">Needs attention</div>
            <div className="tnum mt-1 text-2xl font-semibold text-bad-400">{critical.length}</div>
            <p className="mt-1 text-[11px] text-mist-400">Losing money or reach right now</p>
          </Card>
          <Card>
            <div className="text-[11px] uppercase tracking-wider text-mist-400">Opportunities</div>
            <div className="tnum mt-1 text-2xl font-semibold text-brand-400">{opportunities.length}</div>
            <p className="mt-1 text-[11px] text-mist-400">Upside available at current spend</p>
          </Card>
          <Card>
            <div className="text-[11px] uppercase tracking-wider text-mist-400">Revenue at stake</div>
            <div className="tnum mt-1 text-2xl font-semibold text-good-400">
              {fmt.money((byUnit.get("$/30d") ?? 0) + (byUnit.get("$") ?? 0))}
            </div>
            <p className="mt-1 text-[11px] text-mist-400">Sum of monetary projections</p>
          </Card>
          <Card>
            <div className="text-[11px] uppercase tracking-wider text-mist-400">Reach at stake</div>
            <div className="tnum mt-1 text-2xl font-semibold text-mist-100">{fmt.n(byUnit.get("people") ?? 0)}</div>
            <p className="mt-1 text-[11px] text-mist-400">Extra people reachable this month</p>
          </Card>
        </div>

        <Card className="border-ink-700/60">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-medium text-mist-400">Analysers that fired:</span>
            {kinds.map((k) => (
              <Badge key={k} tone="neutral">{KIND_LABEL[k] ?? k}</Badge>
            ))}
            <span className="ml-auto text-[11px] text-mist-400">
              {hasLLM()
                ? `Narratives written by ${activeProvider()!.label} · numbers computed locally`
                : "Running on the deterministic engine — set GROQ_API_KEY or GEMINI_API_KEY for written narratives"}
            </span>
          </div>
        </Card>

        {[
          ["Needs attention", critical],
          ["Opportunities", opportunities],
          ["Worth knowing", info],
        ].map(([label, list]) => {
          const items = list as typeof suggestions;
          if (!items.length) return null;
          return (
            <div key={label as string}>
              <SectionTitle title={label as string} hint={`${items.length} item${items.length === 1 ? "" : "s"}`} />
              <div className="space-y-2.5">
                {items.map((s) => (
                  <SuggestionCard key={s.id} s={s} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
