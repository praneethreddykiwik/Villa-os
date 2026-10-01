import Link from "next/link";
import { pageContext } from "@/lib/page-context";
import { TopBar } from "@/components/shell";
import { Card, SectionTitle } from "@/components/ui";
import { loadKb } from "@/lib/osf/agent/kb";

export const dynamic = "force-dynamic";

/**
 * The villas themselves, as a tab of Settings.
 *
 * These records are not a reference table — they are what both agents say on
 * the phone and in a chat. A wrong price here is quoted to a customer, so the
 * counts are shown up front: an empty project list is the difference between
 * "the agent is vague" and "the agent has nothing to say".
 */

const SECTIONS = [
  {
    href: "/inbox/whatsapp/properties/projects",
    label: "Projects",
    detail: "Add a project, or change its developer, approvals, possession date and headline price.",
  },
  {
    href: "/inbox/whatsapp/properties/villas",
    label: "Villa types",
    detail: "Each plot size and facing, with its built-up area — and the price the agents quote for it.",
  },
  {
    href: "/inbox/whatsapp/properties/inventory",
    label: "Inventory",
    detail: "Which units are available, held or sold.",
  },
  {
    href: "/inbox/whatsapp/properties/floor-plans",
    label: "Floor plans",
    detail: "Layouts and drawings the agent can send on request.",
  },
  {
    href: "/inbox/whatsapp/properties/amenities",
    label: "Amenities",
    detail: "Clubhouses, parks and facilities, as the agent describes them.",
  },
] as const;

export default async function VillaPropertiesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const { db, brand, brandId } = pageContext(sp);

  // The same bundle the agents read, so the counts here are the agents' view
  // rather than a second query that could disagree with it.
  const kb = await loadKb().catch(() => null);

  return (
    <>
      <TopBar brands={db.brands} brandId={brandId} title="Settings" subtitle={`${brand.name} · properties`} />
      <div className="space-y-6 p-4 sm:p-6 lg:p-7">
        <Card>
          <SectionTitle
            title="What the agents know"
            hint="Edited once here, quoted by both the voice agent and the WhatsApp assistant"
          />
          {kb ? (
            <div className="grid gap-2 sm:grid-cols-3">
              {[
                { label: "Projects", n: kb.projects.length },
                { label: "Villa types", n: kb.villaTypes.length },
                { label: "FAQs", n: kb.faqs.length },
              ].map((c) => (
                <div key={c.label} className="rounded-lg border border-ink-700 p-3">
                  <div className="text-[20px] font-medium text-mist-100">{c.n}</div>
                  <div className="text-[11.5px] text-mist-400">{c.label}</div>
                  {c.n === 0 && (
                    <div className="mt-1 text-[11px] text-amber-400">
                      Nothing here — the agents cannot answer questions about this.
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[12px] text-amber-400">
              The property records could not be read just now. The agents fall back to their written instructions
              until this recovers.
            </p>
          )}
        </Card>

        <Card>
          <SectionTitle title="Edit the records" hint="Each opens the full editor for that part" />
          <ul className="divide-y divide-ink-700">
            {SECTIONS.map((s) => (
              <li key={s.href}>
                <Link href={s.href} className="flex items-start justify-between gap-4 py-3 hover:opacity-80">
                  <div className="min-w-0">
                    <div className="text-[12.5px] font-medium text-mist-100">{s.label}</div>
                    <div className="mt-0.5 text-[11.5px] text-mist-400">{s.detail}</div>
                  </div>
                  <span className="shrink-0 text-[11.5px] text-[var(--color-gold-300)]">Open</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <SectionTitle title="The assistant's own wording" hint="Tone and phrasing, as opposed to the facts above" />
          <Link href="/inbox/whatsapp/training" className="btn-ghost !py-2 text-xs">
            Open training
          </Link>
        </Card>
      </div>
    </>
  );
}
