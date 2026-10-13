// TorService: single source of truth (state, stats, enable/disable/rotate, outage procedure).
// Lives in the OpenCode service process; the TUI reads it through the relay's /__tor/* API.
import { EventEmitter } from "node:events"

import { recover } from "./outage.js"
import { probeModel } from "./probe.js"
import { SocksAgent, httpsRequest } from "./socks.js"

export function nextResetUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

export const DEFAULTS = {
  maxAttempts: 10,
  timeoutMs: 300_000,
  ipPollMs: 2000,
  defaultModel: "big-pickle",
  ipCheckUrl: "https://check.torproject.org/api/ip",
  exitsUrl: "https://onionoo.torproject.org/summary?flag=Exit&running=true&type=relay&limit=1",
}

export class TorService extends EventEmitter {
  constructor({ tor, getKey = async () => "public", config = {}, log = () => {}, request = httpsRequest, probe = probeModel, sleep, now = Date.now } = {}) {
    super()
    this.tor = tor
    this.getKey = getKey
    this.cfg = { ...DEFAULTS, ...config }
    this.log = log
    this.request = request
    this.probeFn = probe
    this.sleep = sleep
    this.now = now
    this.agent = tor ? new SocksAgent(tor.proxy) : undefined
    this.s = {
      enabled: false,
      tor: { state: "stopped", error: undefined },
      ip: undefined,
      ipIsTor: undefined,
      exits: undefined,
      stats: { rotations: 0, ok: 0, failed: 0, outages: 0 },
      outage: { active: false },
      lastOutage: undefined,
      probe: undefined,
      notice: undefined,
    }
    this.inflight = undefined
  }

  getAgent() {
    return this.agent
  }
  isEnabled() {
    return this.s.enabled
  }
  noteResult(status) {
    if (status >= 200 && status < 400) this.s.stats.ok++
    else this.s.stats.failed++
    this.emit("change")
  }
  notice(text, level = "info") {
    this.s.notice = { text, level, at: this.now(), id: (this.s.notice?.id ?? 0) + 1 }
    this.emit("change")
  }

  status() {
    return JSON.parse(JSON.stringify({ ...this.s, resetAt: nextResetUtc(new Date(this.now())), cfg: { maxAttempts: this.cfg.maxAttempts, timeoutMs: this.cfg.timeoutMs } }))
  }

  async ensureTor() {
    if (this.s.tor.state === "ready") return
    this.s.tor = { state: "starting" }
    this.emit("change")
    try {
      await this.tor.start()
      this.s.tor = { state: "ready" }
    } catch (e) {
      this.s.tor = { state: "error", error: e.message }
      this.emit("change")
      throw e
    }
    this.emit("change")
  }

  async exitIp() {
    const res = await this.request(this.cfg.ipCheckUrl, { agent: this.agent, timeoutMs: 20_000 })
    if (res.status !== 200) throw new Error(`ip check HTTP ${res.status}`)
    const j = JSON.parse(res.body)
    this.s.ip = j.IP
    this.s.ipIsTor = j.IsTor === true
    this.emit("change")
    return j.IP
  }

  async refreshExits() {
    try {
      const res = await this.request(this.cfg.exitsUrl, { timeoutMs: 20_000 })
      const j = JSON.parse(res.body)
      this.s.exits = (j.relays?.length ?? 0) + (j.relays_truncated ?? 0)
      this.emit("change")
    } catch (e) {
      this.log(`onionoo: ${e.message}`)
    }
  }

  async enable() {
    await this.ensureTor()
    this.s.enabled = true
    this.notice("Tor routing enabled", "success")
    this.exitIp().catch((e) => this.log(`ip check: ${e.message}`))
    this.refreshExits()
    return this.status()
  }

  async disable() {
    this.s.enabled = false
    this.notice("Tor routing disabled (direct connection)", "info")
    return this.status()
  }

  probeEndpoint() {
    return this.cfg.probeEndpoint ?? `${(this.cfg.upstream ?? "https://opencode.ai").replace(/\/$/, "")}/zen/v1/chat/completions`
  }

  async validateIp(model) {
    const key = await this.getKey()
    return this.probeFn({ model: model ?? this.cfg.defaultModel, key, agent: this.agent, hardPattern: this.cfg.hardPattern, endpoint: this.probeEndpoint() })
  }

  /** Runs the recovery procedure once at a time. Resolves { ok, ip, reason, attempts }. */
  runOutage({ model, trigger = "limit" } = {}) {
    if (this.inflight) return this.inflight
    this.inflight = this.#outage(model, trigger).finally(() => (this.inflight = undefined))
    return this.inflight
  }

  async #outage(model, trigger) {
    this.s.stats.outages++
    this.s.outage = { active: true, trigger, attempt: 0, maxAttempts: this.cfg.maxAttempts, phase: "starting", startedAt: this.now(), deadline: this.now() + this.cfg.timeoutMs }
    this.emit("change")
    let result
    try {
      await this.ensureTor()
      result = await recover(
        {
          getIp: () => this.exitIp(),
          newCircuit: async () => {
            await this.tor.newCircuit()
            this.s.stats.rotations++
          },
          validate: (ip) => this.validateIp(model),
          onProgress: (p) => {
            this.s.outage = { ...this.s.outage, ...p, active: true }
            this.emit("change")
          },
        },
        { maxAttempts: this.cfg.maxAttempts, timeoutMs: this.cfg.timeoutMs, ipPollMs: this.cfg.ipPollMs, sleep: this.sleep },
      )
    } catch (e) {
      result = { ok: false, attempts: 0, reason: e.message }
    }
    this.s.outage = { active: false }
    this.s.lastOutage = { ok: result.ok, ip: result.ip, reason: result.reason, attempts: result.attempts, at: this.now() }
    if (result.ok) this.emit("recovered", result)
    this.notice(result.ok ? `New IP ${result.ip} is usable` : `No usable IP: ${result.reason}`, result.ok ? "success" : "error")
    return result
  }

  /** Manual rotation (command): same procedure, no session resume. */
  async rotate() {
    if (!this.s.enabled) throw new Error("Tor routing is off. Run `tor on` first.")
    await this.runOutage({ trigger: "manual" })
    return this.status()
  }

  /** Direct (non-Tor) probe, used at startup to learn whether the user's own IP is out of quota. */
  async startupProbe() {
    const key = await this.getKey()
    const r = await this.probeFn({ model: this.cfg.defaultModel, key, hardPattern: this.cfg.hardPattern, endpoint: this.probeEndpoint() })
    this.s.probe = { ok: r.ok, kind: r.kind, status: r.status, detail: r.detail, at: this.now() }
    if (r.kind) this.notice(`Direct IP is limited (${r.kind}). Run \`tor on\` to route through Tor.`, "warning")
    this.emit("change")
    return this.s.probe
  }
}
