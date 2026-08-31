import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep the build self-contained: this project lives inside a larger folder that
  // may hold other lockfiles, and Next otherwise guesses the wrong workspace root.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
