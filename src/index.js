// opencode-tor-rotate — service entry. See README.md.
import { classify, toRegExp } from "./classify.js"
import { acquireHost, releaseHost } from "./host.js"

export const PLUGIN_ID = "tor-rotate"

const DEFAULT_PROVIDER = "opencode"
const ZEN_BASE = "https://opencode.ai/zen/v1"

async function resolveKey(ctx) {
  for (const id of ["opencode", "opencode-zen", "zen"]) {
    try {
      const conn = await ctx.integration.connection.active(id)
      if (!conn) continue
      const cred = await ctx.integration.connection.resolve(conn)
      const key = typeof cred === "string" ? cred : (cred?.key ?? cred?.apiKey ?? cred?.token ?? cred?.value)
      if (typeof key === "string" && key) return key
    } catch {
      // try the next id
    }
  }
  return "public"
}

export function createHooks({ ctx, service, port, cfg, log, schedule = setTimeout }) {
  const providerID = cfg.providerID ?? DEFAULT_PROVIDER
  const hardPattern = toRegExp(cfg.hardPattern)
  const softThreshold = cfg.softThreshold ?? 3
  const resumeText = cfg.resumeText ?? "Continue where you left off"
  const softDelayMs = cfg.softDelayMs ?? 4000
  const sessions = new Map() // sessionID -> { at }
  const soft = new Map() // sessionID -> consecutive soft errors

  async function prompt(sessionID) {
    try {
      await ctx.session.prompt({ sessionID, text: resumeText })
      log(`resume message sent to ${sessionID}`)
    } catch (e) {
      log(`resume failed for ${sessionID}: ${e.message}`)
    }
  }

  async function resumeAll(onlyOne) {
    const ids = cfg.resumeChildren === false && onlyOne ? [onlyOne] : [...sessions.keys()]
    sessions.clear()
    for (const id of ids) await prompt(id)
  }

  let lastTrigger
  const onRecovered = () => void resumeAll(lastTrigger)
  service.on?.("recovered", onRecovered)

  const hooks = {
    modelRequest(e) {
      let orig
      try {
        orig = new URL(e.baseURL ?? ZEN_BASE)
      } catch {
        return
      }
      if (orig.host !== new URL(cfg.upstream ?? "https://opencode.ai").host) return
      // Remember the real client's fingerprint (headers + base URL): validation
      // probes replay it instead of forging one (the gateway 403s forged ones).
      // Captured even with Tor off so it is ready before it is needed. Missing
      // on older OpenCode builds (no e.headers): probes fall back to forged.
      service.noteFingerprint?.({ baseURL: `${orig.protocol}//${orig.host}${orig.pathname.replace(/\/+$/, "")}`, headers: e.headers })
      if (!service.isEnabled()) return
      e.baseURL = `http://127.0.0.1:${port}${orig.pathname.replace(/\/$/, "")}`
    },
    httpResponse(e) {
      const status = e.response?.status ?? 0
      service.noteResult(status)
      if (status >= 200 && status < 400) soft.delete(e.sessionID)
    },
    retry(e) {
      if (e.model?.providerID !== providerID) return
      let kind = classify(e.error, hardPattern)
      if (!kind) return
      if (!service.isEnabled()) {
        service.notice?.(`Limit reached (${kind}). Run \`tor on\` to route through Tor.`, "warning")
        return
      }
      sessions.set(e.sessionID, { at: Date.now() })
      if (kind === "soft") {
        const n = (soft.get(e.sessionID) ?? 0) + 1
        soft.set(e.sessionID, n)
        if (n < softThreshold) {
          e.decision = { retry: false }
          log(`soft limit ${n}/${softThreshold} on ${e.sessionID}: will send resume message`)
          schedule(() => void prompt(e.sessionID), softDelayMs)
          return
        }
        soft.delete(e.sessionID)
        kind = "hard"
        log(`soft limit repeated ${softThreshold}x on ${e.sessionID}: treated as a limit`)
      }
      e.decision = { retry: false }
      lastTrigger = e.sessionID
      log(`limit on ${e.sessionID} (${e.model.id}): starting recovery`)
      void service.runOutage({ model: e.model.id, trigger: kind })
    },
  }
  return { hooks, sessions, soft, dispose: () => service.off?.("recovered", onRecovered), resumeAll }
}

export default {
  id: PLUGIN_ID,
  async setup(ctx) {
    // Some OpenCode builds load the same module in the TUI; the TUI part lives in ./tui.
    if (ctx.ui?.slot) return
    const cfg = { ...(ctx.options ?? {}) }
    let keyCache
    const getKey = async () => (keyCache ??= await resolveKey(ctx))
    const host = await acquireHost(cfg, getKey)
    const { service, port, log } = host
    const h = createHooks({ ctx, service, port: host.port, cfg, log })
    const providerID = cfg.providerID ?? DEFAULT_PROVIDER
    await ctx.session.hook("model.request", h.hooks.modelRequest, { providerID })
    await ctx.session.hook("http.response", h.hooks.httpResponse, { providerID })
    await ctx.session.hook("retry", h.hooks.retry)
    log(`plugin loaded (${host.mode}, relay :${host.port}, off by default)`)
    if (host.mode === "owner" && host.refs === 1 && cfg.startupProbe !== false) {
      service.startupProbe().catch((e) => log(`startup probe failed: ${e.message}`))
    }
    return async () => {
      h.dispose()
      await releaseHost()
    }
  },
}
