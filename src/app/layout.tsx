import type { Metadata } from "next";
import { cookies } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Glentree — Social & Ads Command Center",
  description: "Publish everywhere, run Meta and Google ads, and get AI recommendations in one place.",
};

/**
 * The theme is stamped onto <html> on the server from a cookie.
 *
 * The previous approach ran an inline script before paint. That worked, but it
 * required allowing an inline script in the Content-Security-Policy and it
 * produced a hydration mismatch once the nonce was added, because React strips
 * the nonce attribute client-side. Reading a cookie server-side removes the
 * script, the nonce problem and the flash of the wrong theme in one go.
 *
 * "system" is represented by the absence of the attribute, and resolved by a
 * prefers-color-scheme media query in globals.css.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const choice = (await cookies()).get("glentree-theme")?.value;
  const explicit = choice === "light" || choice === "dark" ? choice : undefined;

  return (
    <html lang="en" {...(explicit ? { "data-theme": explicit } : {})} suppressHydrationWarning>
      <body className="min-h-screen bg-ink-950">{children}</body>
    </html>
  );
}
