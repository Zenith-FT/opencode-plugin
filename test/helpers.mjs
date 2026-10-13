import { execFileSync } from "node:child_process"
import fs from "node:fs"
import https from "node:https"
import net from "node:net"
import os from "node:os"
import path from "node:path"

let cached
export function selfSigned() {
  if (cached) return cached
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tr-cert-"))
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,DNS:fake.upstream,DNS:check.torproject.org"], { stdio: "ignore" })
  cached = { key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }
  return cached
}

export function listen(server) {
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)))
}

/** HTTPS upstream; handler(req,res,body). */
export async function fakeUpstream(handler) {
  const { key, cert } = selfSigned()
  const server = https.createServer({ key, cert }, (req, res) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => handler(req, res, Buffer.concat(chunks).toString()))
  })
  const port = await listen(server)
  return { server, port, ca: cert, close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(r))) }
}

/** SOCKS5 server that resolves every domain to 127.0.0.1:<targetPort>. */
export async function fakeSocks(targetPort) {
  const seen = []
  const conns = new Set()
  const server = net.createServer((c) => {
    conns.add(c)
    c.on("close", () => conns.delete(c))
    c.once("data", () => {
      c.write(Buffer.from([5, 0]))
      c.once("data", (req) => {
        const len = req[4]
        seen.push(req.subarray(5, 5 + len).toString())
        const up = net.connect(targetPort, "127.0.0.1", () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]))
          c.pipe(up)
          up.pipe(c)
        })
        up.on("error", () => c.destroy())
        c.on("error", () => up.destroy())
      })
    })
  })
  const port = await listen(server)
  return { server, port, seen, close: () => new Promise((r) => (conns.forEach((c) => c.destroy()), server.close(r))) }
}
