import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/providers/openai.ts",
    "src/providers/anthropic.ts",
    "src/providers/gemini.ts",
    "src/providers/openrouter.ts",
    "src/providers/bedrock.ts",
    "src/providers/vertex.ts",
    "src/mcp/index.ts",
    "src/lsp/index.ts",
  ],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node18",
  outDir: "dist",
});
