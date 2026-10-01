import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  Badge,
  Card,
  Empty,
  Meter,
  PageHeader,
  SetupNotice,
  Stat,
  formatInr,
  formatNumber,
  formatPercent,
} from "@/components/osf/ui";
import { gatedLoad } from "@/lib/osf/queries";
import {
  absorption,
  cssUrl,
  projectLocation,
  projectPortfolio,
  type ProjectCardRow,
  type ProjectStats,
} from "@/lib/osf/properties";

export const dynamic = "force-dynamic";

/**
 * A stock photograph would be a lie about a project that is still under
 * construction, so an absent cover falls back to a monogram on brand gold
 * rather than to someone else's villa.
 */
const PLACEHOLDER =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--a-500) 5%, transparent) 0 14px, transparent 14px 28px), " +
  "linear-gradient(150deg, color-mix(in oklab, var(--a-500) 20%, transparent) 0%, color-mix(in oklab, var(--a-500) 5%, transparent) 45%, var(--color-void) 100%)";

function statusTone(status: string | null) {
  const value = (status ?? "").toLowerCase();
  if (value.includes("ready") || value.includes("complete")) return "success" as const;
  if (value.includes("launch") || value.includes("pre")) return "gold" as const;
  if (value.includes("sold")) return "danger" as const;
  return "info" as const;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="label">{label}</p>
      <p className="mt-1 text-sm tabular-nums text-[var(--color-ink)]">{value}</p>
    </div>
  );
}

export default async function ProjectsPage() {
  const page = await gatedLoad({ table: "villa_projects", migration: "001_schema.sql" }, projectPortfolio);
  if (!page.ok) {
    return (
      <>
        <PageHeader title="Projects" />
        <SetupNotice missing={page.missing} detail={page.error} />
      </>
    );
  }

  const { projects, stats, schemaError } = page.data;
  const totalUnits = projects.reduce((sum, p) => sum + (p.total_units ?? 0), 0);
  const totalLand = projects.reduce((sum, p) => sum + (p.total_land_acres ?? 0), 0);
  const entryPrices = projects
    .map((p) => p.starting_price_inr)
    .filter((price): price is number => price !== null);

  return (
    <>
      <PageHeader
        title="Projects"
        sub="The developments in the knowledge base. Approvals, land area and pricing here are what the AI agent is permitted to quote — nothing is inferred."
      />

      {/* A refused query is a setup problem, not an empty portfolio. Saying
          "no active projects" about a database the read never reached would be
          the console inventing a fact about the business. */}
      {schemaError ? (
        <SetupNotice missing={[]} detail={schemaError} />
      ) : projects.length === 0 ? (
        <Empty>
          <p className="font-medium text-[var(--color-ink)]">No active projects.</p>
          <p className="mx-auto mt-2 max-w-lg">
            <code className="rounded bg-[var(--color-canvas)] px-1.5 py-0.5 text-xs">villa_projects</code>{" "}
            holds no active row, so every downstream page — villas, inventory, floor plans, amenities —
            has nothing to describe, and the agent has no project to talk about.
          </p>
        </Empty>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Active projects" value={projects.length} />
            <Stat label="Units planned" value={totalUnits > 0 ? formatNumber(totalUnits) : "—"} />
            <Stat
              label="Land under development"
              value={totalLand > 0 ? `${totalLand.toLocaleString("en-IN")} ac` : "—"}
            />
            <Stat
              label="Entry price"
              value={entryPrices.length ? formatInr(Math.min(...entryPrices)) : "—"}
              sub={entryPrices.length < projects.length ? "Not published for every project" : undefined}
              gold
            />
          </div>

          <div className="grid gap-5 lg:grid-cols-2 2xl:grid-cols-3">
            {projects.map((project) => (
              <ProjectCard key={project.id} project={project} stats={stats[project.id]} />
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function ProjectCard({ project, stats }: { project: ProjectCardRow; stats?: ProjectStats }) {
  const location = projectLocation(project);
  const sold = stats ? stats.counts.sold + stats.counts.reserved + stats.counts.under_booking : 0;
  const pct = stats ? absorption(stats.counts) : null;

  return (
    <Card className="flex flex-col gap-4 p-0">
      <div
        className="relative flex h-44 items-end overflow-hidden rounded-t-2xl border-b border-[var(--color-line)]"
        style={{
          backgroundImage: project.cover_image
            ? `${cssUrl(project.cover_image)}, ${PLACEHOLDER}`
            : PLACEHOLDER,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        {!project.cover_image && (
          <span className="absolute right-5 top-3 font-[family-name:var(--font-display)] text-[76px] leading-none text-[var(--color-gold-500)] opacity-25">
            {project.name.charAt(0)}
          </span>
        )}
        <div className="relative w-full bg-gradient-to-t from-[var(--color-void)] via-[color-mix(in_oklab,var(--color-void)_75%,transparent)] to-transparent p-4 pt-10">
          <div className="flex flex-wrap items-center gap-2">
            {project.status && <Badge tone={statusTone(project.status)}>{project.status}</Badge>}
            {project.phase && <Badge>{project.phase}</Badge>}
          </div>
          <h2 className="mt-2 font-[family-name:var(--font-display)] text-xl leading-tight text-[var(--color-ink)]">
            {project.name}
          </h2>
          <p className="mt-0.5 text-xs text-[var(--color-muted)]">{location ?? "Location not recorded"}</p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 px-5 pb-5">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact
            label="Starting price"
            value={project.starting_price_inr ? formatInr(project.starting_price_inr) : "On request"}
          />
          <Fact label="Total units" value={project.total_units ? formatNumber(project.total_units) : "—"} />
          <Fact
            label="Land"
            value={project.total_land_acres ? `${project.total_land_acres} acres` : "—"}
          />
          <Fact label="Delivery" value={project.expected_delivery ?? "—"} />
        </div>

        <div className="rounded-xl border border-[var(--color-line)] bg-[var(--color-void)]/40 px-3.5 py-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="label">RERA</p>
            <p className="font-mono text-[11px] text-[var(--color-ink)]">{project.rera_number ?? "Not issued"}</p>
          </div>
          <div className="mt-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <p className="label">HMDA permit</p>
            <p className="font-mono text-[11px] text-[var(--color-ink)]">
              {project.hmda_permit_no ?? "Not recorded"}
            </p>
          </div>
          {project.rera_status && (
            <p className="mt-2 text-[11px] text-[var(--color-muted)]">RERA status: {project.rera_status}</p>
          )}
        </div>

        {project.configurations && project.configurations.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {project.configurations.map((config) => (
              <Badge key={config} tone="gold">
                {config}
              </Badge>
            ))}
          </div>
        )}

        {stats && stats.total > 0 ? (
          <div>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="text-[var(--color-muted)]">
                {formatNumber(stats.counts.available)} available of {formatNumber(stats.total)} loaded
              </span>
              <span className="tabular-nums text-[var(--color-gold-300)]">{formatPercent(pct, 0)} absorbed</span>
            </div>
            <Meter value={sold} max={stats.total} />
          </div>
        ) : (
          <p className="text-xs text-[var(--color-faint)]">
            No live units loaded — the agent will not quote availability for this project.
          </p>
        )}

        <Link
          href={`/inbox/whatsapp/properties/projects/${project.slug}`}
          className="btn-ghost mt-auto w-full justify-center"
        >
          Open dossier
          <ArrowUpRight className="h-4 w-4" />
        </Link>
      </div>
    </Card>
  );
}
