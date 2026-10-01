import Link from "next/link";
import { notFound } from "next/navigation";
import {
  ArrowLeft,
  Banknote,
  Grid3X3,
  Landmark,
  Leaf,
  MapPin,
  Ruler,
  ShieldCheck,
  Sparkles,
  Route as RouteIcon,
} from "lucide-react";
import {
  Badge,
  Card,
  Empty,
  Meter,
  PageHeader,
  SetupNotice,
  Stat,
  formatDate,
  formatInr,
  formatNumber,
  formatPercent,
} from "@/components/osf/ui";
import { gatedLoad } from "@/lib/osf/queries";
import {
  UNIT_STATUSES,
  UNIT_STATUS_DOT,
  UNIT_STATUS_LABELS,
  absorption,
  assetExtension,
  countJsonLeaves,
  cssUrl,
  isImageAsset,
  projectDossier,
  projectLocation,
  toJsonNode,
  type AssetRow,
  type TypeInventory,
  type VillaTypeRow,
} from "@/lib/osf/properties";
import { JsonTree } from "../../JsonTree";

export const dynamic = "force-dynamic";

const PLACEHOLDER =
  "repeating-linear-gradient(135deg, color-mix(in oklab, var(--a-500) 5%, transparent) 0 14px, transparent 14px 28px), " +
  "linear-gradient(150deg, color-mix(in oklab, var(--a-500) 20%, transparent) 0%, color-mix(in oklab, var(--a-500) 5%, transparent) 45%, var(--color-void) 100%)";

export default async function ProjectDossierPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const page = await gatedLoad({ table: "villa_projects", migration: "001_schema.sql" }, () =>
    projectDossier(decodeURIComponent(id)),
  );

  if (!page.ok) {
    return (
      <>
        <PageHeader title="Project" />
        <SetupNotice missing={page.missing} detail={page.error} />
      </>
    );
  }
  if (!page.data) notFound();

  const dossier = page.data;
  const { project, villaTypes, inventory, counts, total, assets, schemaError } = dossier;
  const location = projectLocation(project);

  const amenities = toJsonNode(project.amenities);
  const specifications = toJsonNode(project.specifications);
  const sustainability = toJsonNode(project.sustainability);
  const connectivity = toJsonNode(project.connectivity);
  const social = toJsonNode(project.social_infrastructure);
  const usps = toJsonNode(project.usps);
  const gallery = galleryImages(project.gallery);

  const pct = absorption(counts);
  const absorbed = counts.sold + counts.reserved + counts.under_booking;

  return (
    <>
      <Link
        href="/inbox/whatsapp/properties/projects"
        className="mb-4 inline-flex items-center gap-1.5 text-xs text-[var(--color-muted)] transition hover:text-[var(--color-ink)]"
      >
        <ArrowLeft size={13} strokeWidth={2} aria-hidden />
        All projects
      </Link>

      <section
        className="relative mb-6 overflow-hidden rounded-2xl border border-[var(--color-line)]"
        style={{
          backgroundImage: project.cover_image
            ? `${cssUrl(project.cover_image)}, ${PLACEHOLDER}`
            : PLACEHOLDER,
          backgroundSize: "cover",
          backgroundPosition: "center",
        }}
      >
        <div className="bg-gradient-to-t from-[var(--color-void)] via-[color-mix(in_oklab,var(--color-void)_82%,transparent)] to-[color-mix(in_oklab,var(--color-void)_35%,transparent)] px-6 pb-6 pt-28 sm:pt-40">
          <div className="flex flex-wrap items-center gap-2">
            {project.status && <Badge tone="gold">{project.status}</Badge>}
            {project.phase && <Badge>{project.phase}</Badge>}
            {project.developer && <Badge>{project.developer}</Badge>}
          </div>
          <h1 className="mt-2.5 font-[family-name:var(--font-display)] text-[32px] leading-tight tracking-tight text-[var(--color-ink)]">
            {project.name}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-[var(--color-muted)]">
            <MapPin size={13} strokeWidth={1.75} className="text-[var(--color-gold-300)]" aria-hidden />
            {location ?? "Location not recorded"}
            {project.survey_no && <span className="text-[var(--color-faint)]">· Survey {project.survey_no}</span>}
            {project.maps_url && (
              <a
                href={project.maps_url}
                target="_blank"
                rel="noreferrer noopener"
                className="text-[var(--color-gold-300)] underline underline-offset-2"
              >
                Map
              </a>
            )}
          </p>
          {project.positioning && (
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--color-ink)]/85">
              {project.positioning}
            </p>
          )}
        </div>
      </section>

      {/* The project itself loaded — the gap is in the villa types, units or
          assets hanging off it, so the dossier still renders and says which
          part of it the database could not answer for. */}
      {schemaError && <SetupNotice missing={[]} detail={schemaError} />}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Starting price"
          value={project.starting_price_inr ? formatInr(project.starting_price_inr) : "On request"}
          sub={project.price_note ?? undefined}
          gold
        />
        <Stat
          label="Land"
          value={project.total_land_acres ? `${project.total_land_acres} ac` : "—"}
          sub={project.total_units ? `${formatNumber(project.total_units)} units planned` : undefined}
        />
        <Stat
          label="Live inventory"
          value={total > 0 ? formatNumber(counts.available) : "—"}
          sub={total > 0 ? `available of ${formatNumber(total)} loaded` : "No units loaded"}
        />
        <Stat
          label="Absorption"
          value={pct === null ? "—" : formatPercent(pct, 0)}
          sub={pct === null ? "Needs units in villa_units" : `${formatNumber(absorbed)} off the market`}
        />
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Card
            title="Villa types & live inventory"
            hint="Counts come straight from villa_units. A type with nothing loaded is one the agent will not quote availability for."
          >
            {villaTypes.length === 0 ? (
              <Empty>
                No active villa type on this project, so there is no configuration for the agent to
                describe.
              </Empty>
            ) : (
              <div className="-mx-5 overflow-x-auto">
                <table className="w-full min-w-[820px]">
                  <thead className="border-b border-[var(--color-line)]">
                    <tr>
                      <th className="th">Type</th>
                      <th className="th">Plot</th>
                      <th className="th">Built-up</th>
                      <th className="th">Config</th>
                      <th className="th">Price</th>
                      <th className="th">Stock</th>
                      <th className="th text-right">Available</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--color-line)]">
                    {villaTypes.map((type) => (
                      <TypeRow
                        key={type.id}
                        type={type}
                        stock={inventory.find((row) => row.villaTypeId === type.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {total > 0 && (
              <div className="mt-4 border-t border-[var(--color-line)] pt-4">
                <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
                  {UNIT_STATUSES.map((status) => (
                    <span key={status} className="flex items-center gap-1.5 text-[11px] text-[var(--color-muted)]">
                      <span className={`h-2 w-2 rounded-sm ${UNIT_STATUS_DOT[status]}`} aria-hidden />
                      {UNIT_STATUS_LABELS[status]}
                      <span className="tabular-nums text-[var(--color-faint)]">{counts[status]}</span>
                    </span>
                  ))}
                </div>
                <Meter value={absorbed} max={total} />
                <Link
                  href="/inbox/whatsapp/properties/inventory"
                  className="mt-3 inline-flex items-center gap-1.5 text-xs text-[var(--color-gold-300)] underline underline-offset-2"
                >
                  <Grid3X3 size={12} strokeWidth={2} aria-hidden />
                  Open the availability board
                </Link>
              </div>
            )}
          </Card>

          {amenities && (
            <Card
              title="Amenities"
              hint={`${countJsonLeaves(amenities)} recorded, exactly as transcribed from the developer's collateral.`}
              actions={<Sparkles size={15} strokeWidth={1.75} className="text-[var(--color-gold-300)]" aria-hidden />}
            >
              <JsonTree node={amenities} />
            </Card>
          )}

          {specifications && (
            <Card
              title="Specifications"
              hint="What is actually contracted to be built. The agent quotes these verbatim and never rounds them up."
              actions={<Ruler size={15} strokeWidth={1.75} className="text-[var(--color-gold-300)]" aria-hidden />}
            >
              <JsonTree node={specifications} />
            </Card>
          )}

          {sustainability && (
            <Card
              title="Sustainability"
              actions={<Leaf size={15} strokeWidth={1.75} className="text-[var(--color-success)]" aria-hidden />}
            >
              <JsonTree node={sustainability} />
            </Card>
          )}

          {assets.length > 0 && (
            <Card title="Collateral" hint="Files the console holds for this project.">
              <ul className="grid gap-2 sm:grid-cols-2">
                {assets.map((asset) => (
                  <AssetCard key={asset.id} asset={asset} />
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card
            title="Approvals"
            hint="Quoted verbatim. A permit number is a legal fact — it is never reformatted, abbreviated or inferred."
            gold
            actions={<ShieldCheck size={15} strokeWidth={1.75} className="text-[var(--color-gold-300)]" aria-hidden />}
          >
            <dl className="space-y-3">
              <Approval label="RERA number" value={project.rera_number} />
              <Approval label="RERA status" value={project.rera_status} />
              <Approval label="HMDA permit no." value={project.hmda_permit_no} />
              <Approval label="HMDA permit date" value={project.hmda_permit_date} />
            </dl>
            {!project.rera_number && !project.hmda_permit_no && (
              <p className="mt-3 border-t border-[var(--color-gold-line)] pt-3 text-xs leading-relaxed text-[var(--color-muted)]">
                Nothing is on record. The agent will say the approval is not published rather than
                imply one exists.
              </p>
            )}
          </Card>

          <Card title="Land & delivery" actions={<Landmark size={15} strokeWidth={1.75} className="text-[var(--color-muted)]" aria-hidden />}>
            <dl className="space-y-3">
              <Approval label="Total land" value={project.total_land_acres ? `${project.total_land_acres} acres` : null} mono={false} />
              <Approval label="Units planned" value={project.total_units ? formatNumber(project.total_units) : null} mono={false} />
              <Approval label="Expected delivery" value={project.expected_delivery} mono={false} />
              <Approval
                label="Launched"
                value={project.launch_date ? formatDate(project.launch_date) : null}
                mono={false}
              />
              <Approval label="Address" value={project.address_line} mono={false} />
              <Approval label="Pincode" value={project.pincode} />
            </dl>
            {project.configurations && project.configurations.length > 0 && (
              <div className="mt-4 border-t border-[var(--color-line)] pt-3">
                <p className="label mb-2">Configurations</p>
                <div className="flex flex-wrap gap-1.5">
                  {project.configurations.map((config) => (
                    <Badge key={config} tone="gold">
                      {config}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {connectivity && (
            <Card
              title="Connectivity"
              actions={<RouteIcon size={15} strokeWidth={1.75} className="text-[var(--color-muted)]" aria-hidden />}
            >
              <JsonTree node={connectivity} />
            </Card>
          )}

          {social && (
            <Card title="Social infrastructure">
              <JsonTree node={social} />
            </Card>
          )}

          {usps && (
            <Card title="Positioning points">
              <JsonTree node={usps} />
            </Card>
          )}

          {project.financing_partners && project.financing_partners.length > 0 && (
            <Card
              title="Financing partners"
              hint="Lenders that have approved the project. The agent names only these."
              actions={<Banknote size={15} strokeWidth={1.75} className="text-[var(--color-muted)]" aria-hidden />}
            >
              <ul className="flex flex-wrap gap-1.5">
                {project.financing_partners.map((partner) => (
                  <li
                    key={partner}
                    className="rounded-lg border border-[var(--color-line)] bg-[var(--color-void)]/50 px-2.5 py-1 text-xs text-[var(--color-ink)]"
                  >
                    {partner}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {gallery.length > 0 && (
            <Card title="Gallery" hint={`${gallery.length} image${gallery.length === 1 ? "" : "s"} on record.`}>
              <ul className="grid grid-cols-2 gap-2">
                {gallery.map((image) => (
                  <li key={image.url}>
                    <a href={image.url} target="_blank" rel="noreferrer noopener" className="block">
                      <span
                        className="block h-24 rounded-lg border border-[var(--color-line)]"
                        style={{
                          backgroundImage: cssUrl(image.url),
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                        }}
                        role="img"
                        aria-label={image.caption ?? "Project image"}
                      />
                      {image.caption && (
                        <span className="mt-1 block truncate text-[11px] text-[var(--color-muted)]">
                          {image.caption}
                        </span>
                      )}
                    </a>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Approval({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd
        className={`mt-1 text-sm ${mono ? "font-mono text-[13px]" : ""} ${
          value ? "text-[var(--color-ink)]" : "text-[var(--color-faint)]"
        }`}
      >
        {value ?? "Not on record"}
      </dd>
    </div>
  );
}

function TypeRow({ type, stock }: { type: VillaTypeRow; stock?: TypeInventory }) {
  const config = [
    type.bedrooms ? `${type.bedrooms} BHK` : null,
    type.bathrooms ? `${type.bathrooms} bath` : null,
    type.floors ? `${type.floors} floors` : null,
  ].filter(Boolean);

  return (
    <tr className="row-hover">
      <td className="td">
        <span className="font-medium">{type.name}</span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-muted)]">
          {type.facing && <span>{type.facing} facing</span>}
          {type.private_pool && <span className="text-[var(--color-gold-300)]">Private pool</span>}
          {type.has_home_theatre && <span>Home theatre</span>}
          {type.has_maid_room && <span>Maid room</span>}
        </span>
      </td>
      <td className="td whitespace-nowrap text-xs tabular-nums">
        {type.plot_area_sqyd ? `${formatNumber(type.plot_area_sqyd)} sq yd` : "—"}
      </td>
      <td className="td whitespace-nowrap text-xs tabular-nums">
        {type.built_up_sft ? `${formatNumber(type.built_up_sft)} sft` : "—"}
      </td>
      <td className="td text-xs">{config.length ? config.join(" · ") : <span className="text-[var(--color-faint)]">Not confirmed</span>}</td>
      <td className="td whitespace-nowrap text-xs tabular-nums">
        {type.price_inr ? (
          formatInr(type.price_inr)
        ) : (
          <span className="text-[var(--color-warm)]">Confirm with sales</span>
        )}
      </td>
      <td className="td text-xs tabular-nums">
        {stock && stock.total > 0 ? formatNumber(stock.total) : <span className="text-[var(--color-faint)]">None loaded</span>}
      </td>
      <td className="td text-right text-xs tabular-nums">
        {stock && stock.total > 0 ? (
          <span className={stock.counts.available > 0 ? "text-[var(--color-success)]" : "text-[var(--color-muted)]"}>
            {formatNumber(stock.counts.available)}
          </span>
        ) : (
          <span className="text-[var(--color-faint)]">—</span>
        )}
      </td>
    </tr>
  );
}

function AssetCard({ asset }: { asset: AssetRow }) {
  return (
    <li className="rounded-xl border border-[var(--color-line)] bg-[var(--color-void)]/40 px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <a
          href={asset.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm text-[var(--color-ink)] underline-offset-2 hover:text-[var(--color-gold-300)] hover:underline"
        >
          {asset.title}
        </a>
        <span className="pill bg-[var(--color-raised)] text-[10px] text-[var(--color-muted)]">
          {isImageAsset(asset) ? "IMG" : assetExtension(asset)}
        </span>
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-[var(--color-faint)]">
        <span className="capitalize">{asset.kind.replace(/_/g, " ")}</span>
        {asset.is_ai_generated && (
          <span className="text-[var(--color-warm)]">Artist&rsquo;s impression</span>
        )}
        {!asset.shareable_by_ai && <span>Not shareable by the agent</span>}
      </p>
    </li>
  );
}

interface GalleryImage {
  url: string;
  caption: string | null;
}

/**
 * `gallery` is free-form jsonb — some projects store bare URL strings, others
 * objects with a caption. Anything that doesn't yield a URL is skipped rather
 * than rendered as a broken tile.
 */
function galleryImages(value: unknown): GalleryImage[] {
  if (!Array.isArray(value)) return [];
  const images: GalleryImage[] = [];

  for (const entry of value) {
    if (typeof entry === "string" && entry.trim()) {
      images.push({ url: entry.trim(), caption: null });
      continue;
    }
    if (!entry || typeof entry !== "object") continue;

    const record = entry as Record<string, unknown>;
    const url = ["url", "src", "image", "href"]
      .map((key) => record[key])
      .find((v): v is string => typeof v === "string" && v.trim() !== "");
    if (!url) continue;

    const caption = ["caption", "title", "label", "alt"]
      .map((key) => record[key])
      .find((v): v is string => typeof v === "string" && v.trim() !== "");
    images.push({ url: url.trim(), caption: caption?.trim() ?? null });
  }

  return images;
}
