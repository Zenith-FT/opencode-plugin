// Process-wide singleton: one tor + one relay + one TorService, shared by every plugin instance
// (OpenCode instantiates the plugin once per project directory). If another process already owns
// the relay port, we become a client of it instead.
import os from "node:os"
import path from "node:path"
import fs from "node:fs"

import { command, getStatus } from "./client.js"
import { createRelay } from "./relay.js"
import { TorService } from "./service.js"
import { TorManager, findTor, installTor, manualInstallHelp } from "./tor.js"

const KEY = Symbol.for("opencode-tor-rotate.host")

export function stateDir(env = process.env, platform = process.platform) {
  if (env.TOR_ROTATE_STATE_DIR) return env.TOR_ROTATE_STATE_DIR
  const base = env.XDG_STATE_HOME || (platform === "win32" && env.LOCALAPPDATA) || path.join(os.homedir(), ".local", "state")
  return path.join(base, "opencode-tor-rotate")
}

export function makeLogger(dir) {
  const file = path.join(dir, "plugin.log")
  return (msg) => {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
    } catch {
      // logging must never break OpenCode
    }
  }
}

export async function acquireHost(cfg, getKey) {
  const g = globalThis
  if (g[KEY]) {
    g[KEY].refs++
    return g[KEY]
  }
  const dir = stateDir()
  const log = makeLogger(dir)
  const port = cfg.relayPort ?? 9253
  let torPath = cfg.torPath || findTor()
  const tor = new TorManager({
    torPath,
    socksPort: cfg.socksPort ?? 9250,
    controlPort: cfg.controlPort ?? 9251,
    dataDir: path.join(dir, "tor"),
    log,
  })
  // Resolve the binary lazily so a missing tor never blocks plugin load.
  const origStart = tor.start.bind(tor)
  tor.start = async () => {
    if (!tor.torPath) tor.torPath = findTor(cfg.torPath)
    if (!tor.torPath && cfg.autoInstallTor !== false && !(await tor.isPortOpen(tor.controlPort))) {
      log("tor not found, trying to install it")
      const r = await installTor()
      log(`install: ${r.message}`)
      tor.torPath = findTor(cfg.torPath)
      if (!tor.torPath) throw new Error(r.ok ? "tor installed but binary not found; set option torPath" : r.message)
    }
    if (!tor.torPath && !(await tor.isPortOpen(tor.controlPort))) throw new Error(`tor binary not found. ${manualInstallHelp()}`)
    return origStart()
  }
  const service = new TorService({ tor, getKey, config: cfg, log })
  const relay = createRelay({
    upstream: cfg.upstream ?? "https://opencode.ai",
    getAgent: () => service.getAgent(),
    isEnabled: () => service.isEnabled(),
    api: {
      status: () => service.status(),
      enable: () => service.enable(),
      disable: () => service.disable(),
      rotate: () => service.rotate(),
    },
  })
  relay.server.requestTimeout = 0
  const host = { refs: 1, log, service, relay, port, tor, mode: "owner" }
  try {
    host.port = await relay.listen(port)
  } catch (e) {
    if (e.code !== "EADDRINUSE") throw e
    log(`relay port ${port} in use: joining the existing instance as a client`)
    host.mode = "client"
    host.service = clientService(port)
  }
  g[KEY] = host
  return host
}

/** Same surface as TorService for the few calls the hooks need, backed by the owner's HTTP API. */
function clientService(port) {
  const listeners = new Set()
  let last = { enabled: false }
  const poll = setInterval(() => getStatus(port).then((s) => (last = s)).catch(() => {}), 1500)
  poll.unref?.()
  return {
    isClient: true,
    isEnabled: () => last.enabled === true,
    status: () => last,
    getAgent: () => undefined,
    noteResult() {},
    notice() {},
    noteFingerprint() {
      return false
    },
    on: (ev, fn) => listeners.add(fn),
    off: (ev, fn) => listeners.delete(fn),
    runOutage: async ({ model }) => ({ ok: false, reason: "outage must run in the owner process", model }),
    startupProbe: async () => undefined,
    enable: () => command(port, "enable"),
    disable: () => command(port, "disable"),
    rotate: () => command(port, "rotate", undefined, 330_000),
  }
}

export async function releaseHost() {
  const g = globalThis
  const host = g[KEY]
  if (!host) return
  host.refs--
  if (host.refs > 0) return
  delete g[KEY]
  try {
    await host.relay.close()
  } catch {}
  host.tor.stop()
}