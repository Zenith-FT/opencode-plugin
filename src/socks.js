// Minimal SOCKS5 client (CONNECT, no auth, domain names) + HTTPS helpers that go through it.
import https from "node:https"
import net from "node:net"
import tls from "node:tls"

function makeReader(socket) {
  let buf = Buffer.alloc(0)
  let waiter
  const check = () => {
    if (waiter && buf.length >= waiter.n) {
      const { n, resolve } = waiter
      waiter = undefined
      const out = buf.subarray(0, n)
      buf = buf.subarray(n)
      resolve(out)
    }
  }
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    check()
  }
  const fail = (err) => waiter && ((w) => ((waiter = undefined), w.reject(err)))(waiter)
  const onErr = (err) => fail(err)
  const onEnd = () => fail(new Error("socks: connection closed"))
  socket.on("data", onData)
  socket.on("error", onErr)
  socket.on("end", onEnd)
  return {
    read: (n) => new Promise((resolve, reject) => ((waiter = { n, resolve, reject }), check())),
    release() {
      socket.off("data", onData)
      socket.off("error", onErr)
      socket.off("end", onEnd)
      socket.pause()
      if (buf.length) socket.unshift(buf)
    },
  }
}

export async function socksConnect(proxy, host, port, timeoutMs = 20_000) {
  const socket = net.connect({ host: proxy.host ?? "127.0.0.1", port: proxy.port })
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error("socks: timeout")))
  try {
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve)
      socket.once("error", reject)
    })
    const rd = makeReader(socket)
    socket.write(Buffer.from([5, 1, 0]))
    const greet = await rd.read(2)
    if (greet[0] !== 5 || greet[1] !== 0) throw new Error("socks: handshake refused")
    const h = Buffer.from(host)
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 255])]))
    const head = await rd.read( 4)
    if (head[1] !== 0) throw new Error(`socks: connect failed (code ${head[1]})`)
    if (head[3] === 1) await rd.read(6)
    else if (head[3] === 4) await rd.read(18)
    else {
      const len = (await rd.read( 1))[0]
      await rd.read(len + 2)
    }
    rd.release()
    socket.setTimeout(0)
    return socket
  } catch (err) {
    socket.destroy()
    throw err
  }
}

/** https.Agent that tunnels every connection through a SOCKS5 proxy. */
export class SocksAgent extends https.Agent {
  constructor(proxy, tlsOptions = {}) {
    super({ keepAlive: false })
    this.proxy = proxy
    this.tlsOptions = tlsOptions
  }
  createConnection(options, cb) {
    const host = options.host ?? options.hostname
    const port = Number(options.port) || 443
    socksConnect(this.proxy, host, port)
      .then((raw) => {
        const secure = tls.connect({ ...this.tlsOptions, socket: raw, servername: options.servername ?? host })
        secure.once("secureConnect", () => cb(null, secure))
        secure.once("error", (e) => cb(e))
      })
      .catch((e) => cb(e))
  }
}

/** One-shot HTTPS request, optionally through an agent. Resolves { status, headers, body }. */
export function httpsRequest(url, { method = "GET", headers = {}, body, agent, timeoutMs = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = https.request(
      { method, hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, headers, agent },
      (res) => {
        const chunks = []
        res.on("data", (c) => chunks.push(c))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }),
        )
        res.on("error", reject)
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error("request timeout")))
    req.on("error", reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}
