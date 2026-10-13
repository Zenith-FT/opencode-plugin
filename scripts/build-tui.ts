// Builds dist/tui.js (OpenTUI/Solid JSX -> plain JS). Usage: bun scripts/build-tui.ts
import solidTransformPlugin from "@opentui/solid/bun-plugin"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
const result = await Bun.build({
  entrypoints: [path.join(root, "src", "tui.tsx")],
  outdir: path.join(root, "dist"),
  naming: { entry: "tui.js" },
  format: "esm",
  target: "node",
  external: ["@opentui/core", "@opentui/solid", "@opentui/solid/jsx-runtime", "solid-js", "solid-js/web", "@opencode/plugin", "@opencode/plugin/*", "effect"],
  plugins: [solidTransformPlugin],
  minify: false,
  splitting: false,
})
if (!result.success) {
  console.error("TUI build failed", result.logs)
  process.exit(1)
}
console.log("OK dist/tui.js")
