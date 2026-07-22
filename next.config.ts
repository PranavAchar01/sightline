import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the workspace root — there are stray lockfiles above this directory and
  // Turbopack otherwise infers the wrong one.
  turbopack: { root: path.resolve(__dirname) },
};

export default nextConfig;
