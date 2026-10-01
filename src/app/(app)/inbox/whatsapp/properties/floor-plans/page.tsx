import Link from "next/link";
import { ExternalLink, FileText, Ruler, Wand2 } from "lucide-react";
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  SetupNotice,
  Stat,
  formatNumber,
} from "@/components/osf/ui";
import { gatedLoad } from "@/lib/osf/queries";
import {
  PLAN_KINDS,
  PLAN_KIND_LABELS,
  assetExtension,
  cssUrl,
  isImageAsset,
  planAssets,
  type AssetRow,
  type PlanGroup,
} from "@/lib/osf/properties";

export const dynamic = "force-dynamic";

const BASE = "/inbox/whatsapp/properties/floor-plans";

/**
 * Drawings: floor plans, site plans, master plans.
 *
 * The `is_ai_generated` badge is the reason this page is not just a file list.
 * Section 14 of the agent spec — and Indian advertising rules on property
 * imagery — require a render to be labelled as one. A render that reaches a
 * buyer looking like a photograph of a finished villa is a misrepresentation,
 * so the badge is rendered on the tile itself, not tucked into a tooltip.
 */
export default async function FloorPlansPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind } = await searchParams;

  const page = await gatedLoad({ table: "villa_assets", migration: "001_schema.sql" }, planAssets);

  if (!page.ok) {
    return (
      <>
        <PageHeader title="Floor plans" />
        <SetupNotice missing={page.missing} detail={page.error} />
      </>
    );
  }

  const { groups, total, schemaError } = page.data;
  const activeKind = (PLAN_KINDS as readonly string[]).includes(kind ?? "") ? kind : undefined;
  const visible = activeKind ? filterByKind(groups, activeKind) : groups;

  const all = groups.flatMap((group) => group.sections.flatMap((section) => section.assets));
  const renders = all.filter((asset) => asset.is_ai_generated).length;
  const drawings = all.filter((asset) => !isImageAsset(asset)).length;
  const kindCounts = new Map(
    PLAN_KINDS.map((k) => [k as string, all.filter((asset) => asset.kind === k).length]),
  );

  return (
    <>
      <PageHeader
        title="Floor plans"
        sub="Every drawing the console holds, grouped by project and villa type. Anything produced by an image model carries an artist's-impression badge — a render must never leave here looking like a photograph."
      />

      {schemaError ? (
        <SetupNotice missing={[]} detail={schemaError} />
      ) : total === 0 ? (
        <Card>
          <Empty
            action={
              <Link href="/inbox/whatsapp/properties/projects" className="btn-ghost">
                Open projects
              </Link>
            }
          >
            No floor, site or master plan is on record.{" "}
            <code className="rounded bg-[var(--color-canvas)] px-1.5 py-0.5 text-xs">villa_assets</code>{" "}
            holds nothing of those kinds, so the agent has no layout to send when a buyer asks for one.
          </Empty>
        </Card>
      ) : (
        <>
          <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Drawings" value={formatNumber(total)} sub={`Across ${groups.length} project${groups.length === 1 ? "" : "s"}`} />
            <Stat label="Documents" value={formatNumber(drawings)} sub="PDFs and other non-image files" />
            <Stat label="Images" value={formatNumber(all.length - drawings)} />
            <Stat
              label="Artist's impressions"
              value={formatNumber(renders)}
              sub={renders ? "Labelled wherever they appear" : "No AI-generated drawing on record"}
              gold={renders > 0}
            />
          </div>

          <div className="mb-5 flex flex-wrap items-center gap-2">
            <span className="label mr-1">Kind</span>
            <KindPill href={BASE} active={!activeKind} label="All" count={all.length} />
            {PLAN_KINDS.map((value) => (
              <KindPill
                key={value}
                href={`${BASE}?kind=${value}`}
                active={activeKind === value}
                label={PLAN_KIND_LABELS[value] ?? value}
                count={kindCounts.get(value) ?? 0}
              />
            ))}
          </div>

          {visible.length === 0 ? (
            <Card>
              <Empty
                action={
                  <Link href={BASE} className="btn-ghost">
                    Clear filter
                  </Link>
                }
              >
                No drawing of that kind.
              </Empty>
            </Card>
          ) : (
            <div className="space-y-5">
              {visible.map((group) => (
                <Card
                  key={group.projectId}
                  title={group.projectName}
                  hint={`${formatNumber(group.total)} drawing${group.total === 1 ? "" : "s"}`}
                  actions={
                    <Link
                      href={`/inbox/whatsapp/properties/projects/${group.slug}`}
                      className="text-xs text-[var(--color-gold-300)] underline underline-offset-2"
                    >
                      Dossier
                    </Link>
                  }
                >
                  <div className="space-y-5">
                    {group.sections.map((section) => (
                      <section key={section.key}>
                        <h3 className="mb-2.5 flex items-center gap-2 border-b border-[var(--color-line)] pb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--color-gold-300)]">
                          <Ruler size={12} strokeWidth={2} aria-hidden />
                          {section.label}
                          <span className="ml-auto font-normal normal-case tracking-normal text-[var(--color-faint)]">
                            {formatNumber(section.assets.length)}
                          </span>
                        </h3>
                        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                          {section.assets.map((asset) => (
                            <PlanCard key={asset.id} asset={asset} />
                          ))}
                        </ul>
                      </section>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** Drops assets of other kinds, then any section or group left with nothing. */
function filterByKind(groups: PlanGroup[], kind: string): PlanGroup[] {
  return groups
    .map((group) => {
      const sections = group.sections
        .map((section) => ({
          ...section,
          assets: section.assets.filter((asset) => asset.kind === kind),
        }))
        .filter((section) => section.assets.length > 0);
      const total = sections.reduce((sum, section) => sum + section.assets.length, 0);
      return { ...group, sections, total };
    })
    .filter((group) => group.total > 0);
}

function KindPill({
  href,
  active,
  label,
  count,
}: {
  href: string;
  active: boolean;
  label: string;
  count: number;
}) {
  return (
    <Link
      href={href}
      className={`pill border transition ${
        active
          ? "border-[var(--color-gold-line)] bg-[var(--color-gold-soft)] text-[var(--color-gold-100)]"
          : "border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
      }`}
    >
      {label}
      <span className="tabular-nums text-[var(--color-faint)]">{count}</span>
    </Link>
  );
}

function PlanCard({ asset }: { asset: AssetRow }) {
  const image = isImageAsset(asset);

  return (
    <li className="overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-void)]/40 transition hover:border-[var(--color-line-strong)]">
      <a href={asset.url} target="_blank" rel="noreferrer noopener" className="block">
        <div
          className="relative flex h-36 items-center justify-center border-b border-[var(--color-line)] bg-[var(--color-canvas)]"
          style={
            image
              ? {
                  backgroundImage: cssUrl(asset.url),
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                }
              : undefined
          }
        >
          {!image && (
            <div className="flex flex-col items-center gap-1.5 text-[var(--color-muted)]">
              <FileText size={26} strokeWidth={1.4} aria-hidden />
              <span className="text-[11px] font-semibold tracking-wide">{assetExtension(asset)}</span>
            </div>
          )}

          {asset.is_ai_generated && (
            <span className="absolute left-2 top-2 inline-flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--color-void)_85%,transparent)] px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-warm)] ring-1 ring-[color-mix(in_oklab,var(--c-warn)_45%,transparent)]">
              <Wand2 size={10} strokeWidth={2.2} aria-hidden />
              Artist&rsquo;s impression
            </span>
          )}
        </div>

        <div className="p-3.5">
          <p className="flex items-start justify-between gap-2 text-sm leading-snug text-[var(--color-ink)]">
            <span className="min-w-0 flex-1">{asset.title}</span>
            <ExternalLink size={13} strokeWidth={1.75} className="mt-0.5 shrink-0 text-[var(--color-faint)]" aria-hidden />
          </p>
          {asset.description && (
            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[var(--color-muted)]">
              {asset.description}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <Badge>{PLAN_KIND_LABELS[asset.kind] ?? asset.kind.replace(/_/g, " ")}</Badge>
            {asset.version > 1 && <Badge>v{asset.version}</Badge>}
            {asset.shareable_by_ai ? (
              <Badge tone="success">Agent may send</Badge>
            ) : (
              <Badge tone="warning">Withheld from agent</Badge>
            )}
          </div>
        </div>
      </a>

      {asset.is_ai_generated && (
        <p className="border-t border-[color-mix(in_oklab,var(--c-warn)_25%,transparent)] bg-[color-mix(in_oklab,var(--c-warn)_6%,transparent)] px-3.5 py-2 text-[11px] leading-relaxed text-[var(--color-warm)]">
          Computer-generated. It depicts an intended design, not a built villa, and must be described
          that way to a buyer.
        </p>
      )}
    </li>
  );
}
