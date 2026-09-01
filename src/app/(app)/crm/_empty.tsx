import Link from "next/link";
import { Card } from "@/components/ui";

/**
 * Shown when the active brand has no CRM data. Being explicit that the module is
 * per-brand beats rendering an ambiguous empty table that reads like a bug.
 */
export function CrmEmpty({ brandName, brandId }: { brandName: string; brandId: string }) {
  return (
    <Card className="mx-auto mt-10 max-w-lg text-center">
      <h3 className="text-[15px] font-semibold text-mist-100">No CRM records for {brandName}</h3>
      <p className="mx-auto mt-2 max-w-sm text-[12.5px] leading-relaxed text-mist-400">
        The CRM is per brand. Switch brands from the header, or start capturing leads
        for {brandName} and they will appear here.
      </p>
      <Link
        href={`/crm/leads?brand=${brandId}`}
        className="mt-4 inline-block rounded-lg border border-ink-700 px-3 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
      >
        Refresh
      </Link>
    </Card>
  );
}
