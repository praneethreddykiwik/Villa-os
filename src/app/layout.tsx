import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Orbit — Social & Ads Command Center",
  description: "Publish everywhere, run Meta and Google ads, and get AI recommendations in one place.",
};

/**
 * Applied before first paint so a light-mode user never sees a dark flash. It
 * has to be inline and synchronous — any deferred script paints too late.
 */
const THEME_BOOT = `(function(){try{var c=localStorage.getItem('orbit-theme')||'dark';var r=c==='system'?(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'):c;document.documentElement.dataset.theme=r;}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT }} />
      </head>
      <body className="min-h-screen bg-ink-950">{children}</body>
    </html>
  );
}
