import type { ReactNode } from "react";
import { VillaTabs } from "@/components/settings/villa-tabs";

/**
 * VILLA PROFILE — one place for everything about how this business behaves.
 *
 * Before this, the three things an operator actually tunes lived in three
 * unrelated corners: calling hours were constants in the source, what the
 * voice agent says was under /voice/settings, and WhatsApp readiness was
 * buried in the System group of a nested workspace nav. Nobody could answer
 * "where do I change that?" without being told.
 */
export default function VillaSettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <VillaTabs />
      {children}
    </>
  );
}
