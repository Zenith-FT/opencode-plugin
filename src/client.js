// Tiny HTTP client for the relay's /__tor/* control API (used by the TUI and by secondary plugin instances).
import http from "node:http"

export function call(port, method, name, body, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const req = http.request(
      { host: "127.0.0.1", port, path: `/__tor/${name}`, method, headers: payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {} },
      (res) => {
        let data = ""
        res.on("data", (c) => (data += c))
        res.on("end", () => {
          try {
            const j = JSON.parse(data || "{}")
            res.statusCode >= 400 ? reject(new Error(j.error ?? `HTTP ${res.statusCode}`)) : resolve(j)
          } catch (e) {
            reject(e)
          }
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")))
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export const getStatus = (port) => call(port, "GET", "status")
export const command = (port, name, body, timeoutMs) => call(port, "POST", name, body, timeoutMs)
