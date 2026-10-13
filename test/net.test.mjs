import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { call } from "../src/client.js"
import { probeModel } from "../src/probe.js"
import { createRelay } from "../src/relay.js"
import { SocksAgent, httpsRequest } from "../src/socks.js"
import { fakeSocks, fakeUpstream } from "./helpers.mjs"

test("httpsRequest goes through the SOCKS5 server by domain name", async () => {
  const up = await fakeUpstream((req, res) => res.end('{"IP":"5.5.5.5","IsTor":true}'))
  const socks = await fakeSocks(up.port)
  const agent = new SocksAgent({ port: socks.port }, { ca: up.ca })
  const r = await httpsRequest("https://fake.upstream/api/ip", { agent })
  assert.equal(r.status, 200)
  assert.equal(JSON.parse(r.body).IP, "5.5.5.5")
  assert.deepEqual(socks.seen, ["fake.upstream"])
  await socks.close(); await up.close()
})

test("probeModel: 200 ok, 429 soft, EndOfFreeQuota hard", async () => {
  let mode = "ok"
  const up = await fakeUpstream((req, res, body) => {
    assert.equal(JSON.parse(body).max_tokens, 1)
    if (mode === "ok") return res.end("{}")
    res.writeHead(429)
    res.end(mode === "soft" ? '{"error":"Rate limit exceeded"}' : '{"type":"FreeUsageLimitError","error":"EndOfFreeQuota"}')
  })
  const socks = await fakeSocks(up.port)
  const agent = new SocksAgent({ port: socks.port }, { ca: up.ca })
  const run = () => probeModel({ endpoint: "https://fake.upstream/zen/v1/chat/completions", agent })
  assert.equal((await run()).ok, true)
  mode = "soft"
  assert.deepEqual([(await run()).ok, (await run()).kind], [false, "soft"])
  mode = "hard"
  assert.equal((await run()).kind, "hard")
  await socks.close(); await up.close()
})

test("relay: direct when off, through SOCKS when on, streams, serves API", async () => {
  const up = await fakeUpstream((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" })
    res.write("data: 1\n\n")
    setTimeout(() => res.end("data: 2\n\n"), 30)
  })
  const socks = await fakeSocks(up.port)
  let enabled = false
  const results = []
  const relay2 = createRelay({
    upstream: `https://fake.upstream:${up.port}`,
    getAgent: () => new SocksAgent({ port: socks.port }, { ca: up.ca }),
    isEnabled: () => enabled,
    onResult: (s) => results.push(s),
    agentOptions: { ca: up.ca, lookup: (h, o, cb) => (o?.all ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4)) },
    api: { status: () => ({ enabled }), enable: async () => ((enabled = true), { enabled }), disable: async () => ((enabled = false), { enabled }), rotate: async () => ({ rotated: true }) },
  })
  const port = await relay2.listen(0)
  const get = () =>
    new Promise((resolve, reject) => {
      http.get({ port, host: "127.0.0.1", path: "/zen/v1/x" }, (r) => {
        let b = ""
        r.on("data", (c) => (b += c))
        r.on("end", () => resolve({ status: r.statusCode, b }))
      }).on("error", reject)
    })
  assert.deepEqual(await get(), { status: 200, b: "data: 1\n\ndata: 2\n\n" })
  assert.equal(socks.seen.length, 0, "off => direct")
  assert.equal((await call(port, "POST", "enable")).enabled, true)
  assert.equal((await get()).status, 200)
  assert.equal(socks.seen.length, 1, "on => via socks")
  assert.equal((await call(port, "GET", "status")).enabled, true)
  await assert.rejects(call(port, "GET", "nope"), /unknown/)
  await relay2.close(); await socks.close(); await up.close()
})
