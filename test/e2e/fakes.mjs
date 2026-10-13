// Fake world for the end-to-end run: HTTPS "Zen" upstream, SOCKS5 -> upstream, tor control port.
import fs from "node:fs"
import https from "node:https"
import net from "node:net"
import path from "node:path"
import { selfSigned } from "../helpers.mjs"

export async function startFakes({ upPort, socksPort, controlPort, stateDir, goodFrom = 2, certDir }) {
  const { key, cert } = selfSigned()
  fs.mkdirSync(certDir, { recursive: true })
  fs.writeFileSync(path.join(certDir, "ca.pem"), cert)
  const world = { nyms: 0, chats: [], goodFrom, log: (m) => console.log("[fake]", m) }

  const up = https.createServer({ key, cert }, (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString()
      if (req.url === "/api/ip") {
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ IP: `10.0.0.${world.nyms}`, IsTor: true }))
      }
      if (req.url.endsWith("/chat/completions")) {
        let j = {}
        try { j = JSON.parse(body) } catch {}
        const via = req.headers["x-forwarded-by-relay"] ?? "?"
        const good = world.nyms >= world.goodFrom
        world.chats.push({ nyms: world.nyms, good, stream: !!j.stream, lastUser: JSON.stringify(j.messages?.at(-1))?.slice(0, 120), t: Date.now() })
        if (!good) {
          res.writeHead(429, { "content-type": "application/json" })
          return res.end(JSON.stringify({ type: "error", error: { type: "FreeUsageLimitError", message: "Free usage exceeded, subscribe to Go", code: "EndOfFreeQuota" } }))
        }
        if (j.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" })
          const chunk = (d, fin) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: d, finish_reason: fin ?? null }] })}\n\n`
          res.write(chunk({ role: "assistant", content: "" }))
          res.write(chunk({ content: "all good" }))
          res.write(chunk({}, "stop"))
          return res.end("data: [DONE]\n\n")
        }
        res.writeHead(200, { "content-type": "application/json" })
        return res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: "m", choices: [{ index: 0, message: { role: "assistant", content: "all good" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
      res.writeHead(404); res.end()
    })
  })
  await new Promise((r) => up.listen(upPort, "127.0.0.1", r))

  const conns = new Set()
  const socks = net.createServer((c) => {
    conns.add(c); c.on("close", () => conns.delete(c))
    c.once("data", () => {
      c.write(Buffer.from([5, 0]))
      c.once("data", (req) => {
        world.log(`socks CONNECT ${req.subarray(5, 5 + req[4])}`)
        const t = net.connect(upPort, "127.0.0.1", () => { c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0])); c.pipe(t); t.pipe(c) })
        t.on("error", () => c.destroy()); c.on("error", () => t.destroy())
      })
    })
  })
  await new Promise((r) => socks.listen(socksPort, "127.0.0.1", r))

  fs.mkdirSync(path.join(stateDir, "tor"), { recursive: true })
  fs.writeFileSync(path.join(stateDir, "tor", "control_auth_cookie"), Buffer.from("abcd", "hex"))
  const ctl = net.createServer((c) => {
    let buf = ""
    c.on("data", (d) => {
      buf += d
      let i
      while ((i = buf.indexOf("\r\n")) !== -1) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2)
        if (line.startsWith("AUTHENTICATE")) c.write("250 OK\r\n")
        else if (line.startsWith("GETINFO")) c.write("250-status/bootstrap-phase=NOTICE BOOTSTRAP PROGRESS=100\r\n250 OK\r\n")
        else if (line === "SIGNAL NEWNYM") { world.nyms++; world.log(`NEWNYM #${world.nyms}`); c.write("250 OK\r\n") }
        else if (line === "QUIT") c.end("250 bye\r\n")
      }
    })
    c.on("error", () => {})
  })
  await new Promise((r) => ctl.listen(controlPort, "127.0.0.1", r))
  return { world, close: () => { up.close(); socks.close(); ctl.close(); conns.forEach((c) => c.destroy()) } }
}
