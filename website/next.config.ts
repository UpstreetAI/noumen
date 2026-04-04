import type { NextConfig } from "next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX({ outDir: "docs/.source" });

const config: NextConfig = {
  turbopack: {
    root: __dirname,
  },
};

export default withMDX(config);
