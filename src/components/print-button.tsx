"use client";

import { Printer } from "lucide-react";

/** Print-to-PDF is the export path clients actually use. */
export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1.5 text-[12px] text-mist-200 hover:border-ink-600"
    >
      <Printer size={13} /> Export PDF
    </button>
  );
}
