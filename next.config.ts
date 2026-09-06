import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the build self-contained: this project lives inside a larger folder that
  // may hold other lockfiles, and Next otherwise guesses the wrong workspace root.
  // On Vercel, allow the standard build environment to manage outputFileTracingRoot.
  ...(process.env.VERCEL ? {} : { outputFileTracingRoot: __dirname }),

  experimental: {
    /**
     * These three are barrel packages: `import { Gauge } from "lucide-react"`
     * nominally reaches for one icon but resolves a module that re-exports about
     * fifteen hundred of them, and the bundler has to walk all of them before it
     * can prove the rest are unused. Rewriting each named import to its own deep
     * path removes that work from every compile and drops what actually ships.
     */
    optimizePackageImports: ["lucide-react", "recharts", "date-fns"],
  },
};

export default nextConfig;
