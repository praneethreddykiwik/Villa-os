import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the build self-contained: this project lives inside a larger folder that
  // may hold other lockfiles, and Next otherwise guesses the wrong workspace root.
  // On Vercel, allow the standard build environment to manage outputFileTracingRoot.
  ...(process.env.VERCEL ? {} : { outputFileTracingRoot: __dirname }),

  experimental: {
    middlewareClientMaxBodySize: "500mb",
    serverActions: {
      bodySizeLimit: "500mb",
    },
    optimizePackageImports: ["lucide-react", "recharts", "date-fns"],
  },
};

export default nextConfig;
