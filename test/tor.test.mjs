import assert from "node:assert/strict"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TorManager, findTor, installTor } from "../src/tor.js"
import { listen } from "./helpers.mjs"

function fakeControl({ progress = 100 } = {}) {
  const log = []
  const server = net.createServer((c) => {
    let buf = ""
    c.on("data", (d) => {
      buf += d
      let i
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 2)
        log.push(line)
        if (line.startsWith("AUTHENTICATE")) c.write(line.endsWith("abcd") ? "250 OK\r\n" : "515 Bad authentication\r\n")
        else if (line.startsWith("GETINFO status/bootstrap-phase")) c.write(`250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=${progress} TAG=x\r\n250 OK\r\n`)
        else if (line === "SIGNAL NEWNYM") c.write("250 OK\r\n")
        else if (line === "QUIT") c.end("250 closing\r\n")
        else c.write("510 Unrecognized\r\n")
      }
    })
    c.on("error", () => {})
  })
  return { server, log }
}

async function setup(opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-tor-"))
  fs.writeFileSync(path.join(dir, "control_auth_cookie"), Buffer.from("abcd", "hex"))
  const ctl = fakeControl(opts)
  const controlPort = await listen(ctl.server)
  const socks = net.createServer()
  const socksPort = await listen(socks)
  const tor = new TorManager({ dataDir: dir, controlPort, socksPort, bootstrapTimeoutMs: 3000 })
  return { tor, ctl, close: () => (ctl.server.close(), socks.close()) }
}

test("adopts a running tor, waits for bootstrap, sends NEWNYM with cookie auth", async () => {
  const { tor, ctl, close } = await setup()
  await tor.start()
  assert.equal(tor.adopted, true)
  await tor.newCircuit()
  assert.ok(ctl.log.includes("SIGNAL NEWNYM"))
  assert.ok(ctl.log.some((l) => l === "AUTHENTICATE abcd"))
  close()
})

test("bootstrap that never completes times out", async () => {
  const { tor, close } = await setup({ progress: 40 })
  tor.bootstrapTimeoutMs = 1200
  await assert.rejects(tor.start(), /bootstrap timeout/)
  close()
})

test("wrong cookie is an error", async () => {
  const { tor, close } = await setup()
  fs.writeFileSync(path.join(tor.dataDir, "control_auth_cookie"), Buffer.from("ffff", "hex"))
  await assert.rejects(tor.newCircuit(), /control error: 515/)
  close()
})

test("start without binary and nothing running fails clearly", async () => {
  const tor = new TorManager({ dataDir: os.tmpdir(), controlPort: 1, socksPort: 2 })
  await assert.rejects(tor.start(), /not found/)
})

test("findTor honours explicit path; installTor reports manual help when no installer", async () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tr-bin-")), "tor")
  fs.writeFileSync(f, "")
  assert.equal(findTor(f, { PATH: "" }), f)
  const r = await installTor("linux", async () => ({ status: 1 }), {})
  assert.equal(r.ok, false)
  assert.match(r.message, /Install tor manually/)
  const ok = await installTor("darwin", async () => ({ status: 0 }), {})
  assert.deepEqual(ok, { ok: true, message: "installed with brew" })
})
