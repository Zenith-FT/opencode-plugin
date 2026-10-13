// Local HTTP relay: OpenCode talks plain HTTP to 127.0.0.1; the relay forwards to the upstream
// over HTTPS, either directly or through Tor's SOCKS port. Also serves the control API (/__tor/*).
import http from "node:http"
import https from "node:https"

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host", "content-length"])

export function createRelay({ upstream = "https://opencode.ai", getAgent, isEnabled, onResult, api, agentOptions = {} }) {
  const up = new URL(upstream)
  const direct = new https.Agent({ keepAlive: false, ...agentOptions })

  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/__tor/")) return handleApi(req, res)
    const agent = isEnabled() ? getAgent() : direct
    const headers = {}
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k)) headers[k] = v
    headers.host = up.host
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks)
      if (body.length) headers["content-length"] = String(body.length)
      const out = https.request(
        { method: req.method, hostname: up.hostname, port: up.port || 443, path: req.url, headers, agent },
        (ur) => {
          const rh = {}
          for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k)) rh[k] = v
          res.writeHead(ur.statusCode ?? 502, rh)
          res.flushHeaders?.()
          onResult?.(ur.statusCode ?? 502)
          ur.pipe(res)
          ur.on("error", () => res.destroy())
        },
      )
      out.on("error", (e) => {
        onResult?.(502)
        if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { type: "RelayError", message: `relay: ${e.message}` } }))
      })
      res.on("close", () => out.destroy())
      out.end(body)
    })
  })

  async function handleApi(req, res) {
    const name = req.url.slice("/__tor/".length).split("?")[0]
    const send = (code, obj) => {
      res.writeHead(code, { "content-type": "application/json" })
      res.end(JSON.stringify(obj))
    }
    try {
      if (req.method === "GET" && name === "status") return send(200, api.status())
      if (req.method === "POST" && ["enable", "disable", "rotate"].includes(name)) return send(200, await api[name]())
      send(404, { error: "unknown endpoint" })
    } catch (e) {
      send(500, { error: e.message })
    }
  }

  return {
    server,
    listen: (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, "127.0.0.1", () => resolve(server.address().port))
      }),
    close: () => new Promise((r) => (server.closeAllConnections?.(), server.close(() => r()))),
  }
}
