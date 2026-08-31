import { Suspense } from "react";
import { read } from "@/lib/db";
import { Sidebar } from "@/components/shell";

/**
 * App shell. The sidebar badge counts are computed server-side across *all*
 * brands' open items for the active brand, so the nav tells you where work is
 * waiting without opening every page.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const db = read();
  const brandId = db.brands[0]?.id ?? "";
  const counts = {
    inbox: db.conversations.filter((c) => c.brandId === brandId && c.status === "open").length,
    reviews: db.reviews.filter((r) => r.brandId === brandId && !r.replied).length,
    suggestions: 0,
  };

  return (
    <div className="flex min-h-screen">
      <Suspense fallback={<div className="w-[228px] shrink-0 border-r border-ink-800" />}>
        <Sidebar counts={counts} />
      </Suspense>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
