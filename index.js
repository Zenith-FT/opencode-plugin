// Root entry. OpenCode 2.0.x loads <package>/index.js for directory plugins and may use the same
// module for the TUI, so one default export serves both: TUI contexts (they have ui.slot) are
// delegated to the prebuilt dist/tui.js, everything else is the service plugin.
import service from "./src/index.js"

export const id = service.id

export default {
  id: service.id,
  async setup(ctx) {
    if (ctx?.ui?.slot) {
      const tui = await import("./dist/tui.js")
      return tui.default.setup(ctx)
    }
    return service.setup(ctx)
  },
}
