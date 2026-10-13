// Tor process management: find / install the binary, start or adopt a daemon, request new circuits.
import { spawn as nodeSpawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function findTor(explicit, env = process.env, platform = process.platform) {
  const exe = platform === "win32" ? "tor.exe" : "tor"
  const candidates = []
  if (explicit) candidates.push(explicit)
  for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe))
  const home = os.homedir()
  if (platform === "win32") {
    candidates.push(
      path.join(home, "scoop", "apps", "tor", "current", "tor", exe),
      path.join(home, "scoop", "shims", exe),
      "C:\\ProgramData\\chocolatey\\bin\\tor.exe",
      path.join(home, "Desktop", "Tor Browser", "Browser", "TorBrowser", "Tor", exe),
    )
  } else {
    candidates.push("/usr/bin/tor", "/usr/local/bin/tor", "/opt/homebrew/bin/tor", "/data/data/com.termux/files/usr/bin/tor")
  }
  return candidates.find((c) => {
    try {
      return fs.statSync(c).isFile()
    } catch {
      return false
    }
  })
}

/** Best-effort installers per platform. Returns { ok, message }. Never throws. */
export function runAsync(cmd, args, { timeout = 300_000 } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = nodeSpawn(cmd, args, { stdio: "ignore", windowsHide: true })
    } catch {
      return resolve({ status: 1 })
    }
    const timer = setTimeout(() => child.kill(), timeout)
    child.on("error", () => (clearTimeout(timer), resolve({ status: 1 })))
    child.on("exit", (code) => (clearTimeout(timer), resolve({ status: code ?? 1 })))
  })
}

export async function installTor(platform = process.platform, run = runAsync, env = process.env) {
  const has = async (cmd) => (await run(platform === "win32" ? "where" : "which", [cmd])).status === 0
  const attempts = []
  if (platform === "win32") {
    if (await has("scoop")) attempts.push(["scoop", ["install", "tor"]])
    if (await has("choco")) attempts.push(["choco", ["install", "tor", "-y"]])
    if (await has("winget")) attempts.push(["winget", ["install", "-e", "--id", "TorProject.TorBrowser", "--accept-package-agreements", "--accept-source-agreements"]])
  } else if (platform === "darwin") {
    if (await has("brew")) attempts.push(["brew", ["install", "tor"]])
  } else if (env.PREFIX?.includes("com.termux")) {
    attempts.push(["pkg", ["install", "-y", "tor"]])
  } else {
    const root = typeof process.getuid === "function" && process.getuid() === 0
    const pre = root ? [] : (await has("sudo")) ? ["sudo", "-n"] : null
    if (pre !== null) {
      if (await has("apt-get")) attempts.push([...pre, "apt-get", "install", "-y", "tor"])
      else if (await has("dnf")) attempts.push([...pre, "dnf", "install", "-y", "tor"])
      else if (await has("pacman")) attempts.push([...pre, "pacman", "-S", "--noconfirm", "tor"])
    }
  }
  if (attempts.length === 0) return { ok: false, message: manualInstallHelp(platform) }
  for (const a of attempts) {
    const [cmd, ...args] = a.flat()
    const r = await run(cmd, args)
    if (r.status === 0) return { ok: true, message: `installed with ${cmd}` }
  }
  return { ok: false, message: `automatic install failed. ${manualInstallHelp(platform)}` }
}

export function manualInstallHelp(platform = process.platform) {
  if (platform === "win32") return "Install tor manually: `scoop install tor` (or Tor Expert Bundle), then set the plugin option torPath."
  if (platform === "darwin") return "Install tor manually: `brew install tor`."
  return "Install tor manually: `sudo apt install tor` (Termux: `pkg install tor`), then restart OpenCode."
}

export class TorManager {
  constructor({ torPath, socksPort = 9250, controlPort = 9251, dataDir, spawn = nodeSpawn, log = () => {}, bootstrapTimeoutMs = 120_000 } = {}) {
    this.torPath = torPath
    this.socksPort = socksPort
    this.controlPort = controlPort
    this.dataDir = dataDir
    this.spawn = spawn
    this.log = log
    this.bootstrapTimeoutMs = bootstrapTimeoutMs
    this.child = undefined
    this.adopted = false
  }

  get proxy() {
    return { host: "127.0.0.1", port: this.socksPort }
  }

  isPortOpen(port) {
    return new Promise((resolve) => {
      const s = net.connect({ host: "127.0.0.1", port })
      s.once("connect", () => (s.destroy(), resolve(true)))
      s.once("error", () => resolve(false))
      s.setTimeout(1500, () => (s.destroy(), resolve(false)))
    })
  }

  /** Starts tor, or adopts a daemon already listening on our ports. Resolves when bootstrapped. */
  async start() {
    if ((await this.isPortOpen(this.controlPort)) && (await this.isPortOpen(this.socksPort))) {
      this.adopted = true
      await this.waitBootstrap()
      return
    }
    if (!this.torPath) throw new Error("tor binary not found")
    fs.mkdirSync(this.dataDir, { recursive: true })
    const args = [
      "--SocksPort", `127.0.0.1:${this.socksPort}`,
      "--ControlPort", `127.0.0.1:${this.controlPort}`,
      "--CookieAuthentication", "1",
      "--DataDirectory", this.dataDir,
      "--Log", "notice stdout",
    ]
    this.child = this.spawn(this.torPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    this.child.stdout?.on("data", (d) => this.log(`tor: ${String(d).trim()}`))
    this.child.on("exit", (code) => {
      this.log(`tor exited (${code})`)
      this.child = undefined
    })
    await this.waitBootstrap()
  }

  async waitBootstrap() {
    const deadline = Date.now() + this.bootstrapTimeoutMs
    while (Date.now() < deadline) {
      if (this.child === undefined && !this.adopted) throw new Error("tor exited during startup")
      try {
        const out = await this.control(["GETINFO status/bootstrap-phase"])
        if (/PROGRESS=100/.test(out)) return
      } catch {
        // control port not ready yet
      }
      await sleep(1000)
    }
    throw new Error("tor bootstrap timeout")
  }

  cookie() {
    return fs.readFileSync(path.join(this.dataDir, "control_auth_cookie")).toString("hex")
  }

  /** Sends commands on the control port; resolves the raw reply text. Rejects on any non-2xx reply. */
  control(commands) {
    return new Promise((resolve, reject) => {
      let cookie
      try {
        cookie = this.cookie()
      } catch (e) {
        return reject(e)
      }
      const s = net.connect({ host: "127.0.0.1", port: this.controlPort })
      const all = [`AUTHENTICATE ${cookie}`, ...commands]
      let pending = ""
      let text = ""
      let step = 0
      const timer = setTimeout(() => (s.destroy(), reject(new Error("control timeout"))), 10_000)
      const fail = (err) => (clearTimeout(timer), s.destroy(), reject(err))
      s.on("connect", () => s.write(all[0] + "\r\n"))
      s.on("data", (d) => {
        pending += d
        let nl
        while ((nl = pending.indexOf("\n")) !== -1) {
          const line = pending.slice(0, nl).trim()
          pending = pending.slice(nl + 1)
          text += line + "\n"
          // A terminal line is "<code><space>..."; "250-" / "250+" lines are continuations.
          if (!/^\d{3} /.test(line)) continue
          if (!line.startsWith("250")) return fail(new Error(`control error: ${line}`))
          step++
          if (step < all.length) s.write(all[step] + "\r\n")
          else {
            clearTimeout(timer)
            s.end("QUIT\r\n")
            return resolve(text)
          }
        }
      })
      s.on("error", (e) => (clearTimeout(timer), reject(e)))
    })
  }

  async newCircuit() {
    await this.control(["SIGNAL NEWNYM"])
  }

  stop() {
    if (this.child) {
      this.child.kill()
      this.child = undefined
    }
  }
}
