import assert from "node:assert/strict"
import test from "node:test"
import { TorService, nextResetUtc } from "../src/service.js"

function makeService(over = {}) {
  const calls = { circuits: 0, started: 0 }
  let n = 0
  const tor = {
    proxy: { port: 1 },
    start: async () => calls.started++,
    newCircuit: async () => (calls.circuits++, n++),
  }
  const request = async (url) => {
    if (url.includes("check.torproject")) return { status: 200, body: JSON.stringify({ IP: `9.9.9.${n}`, IsTor: true }) }
    return { status: 200, body: JSON.stringify({ relays: [{}], relays_truncated: 1500 }) }
  }
  const svc = new TorService({ tor, request, sleep: async () => {}, config: { ipPollMs: 0 }, ...over })
  return { svc, calls }
}

test("off by default; enable starts tor and refreshes ip + exits", async () => {
  const { svc, calls } = makeService()
  assert.equal(svc.isEnabled(), false)
  await svc.enable()
  assert.equal(svc.isEnabled(), true)
  assert.equal(calls.started, 1)
  await new Promise((r) => setTimeout(r, 20))
  const st = svc.status()
  assert.equal(st.ip, "9.9.9.0")
  assert.equal(st.ipIsTor, true)
  assert.equal(st.exits, 1501)
  await svc.disable()
  assert.equal(svc.isEnabled(), false)
})

test("outage: rotates, validates through probe, counts, emits recovered", async () => {
  const results = [{ ok: false, detail: "429" }, { ok: true }]
  const { svc, calls } = makeService({ probe: async () => results.shift() })
  await svc.enable()
  let recovered
  svc.on("recovered", (r) => (recovered = r))
  const r = await svc.runOutage({ model: "m" })
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 2)
  assert.equal(calls.circuits, 2)
  assert.equal(recovered.ip, r.ip)
  const st = svc.status()
  assert.equal(st.stats.rotations, 2)
  assert.equal(st.outage.active, false)
  assert.equal(st.lastOutage.ok, true)
})

test("outage failure after maxAttempts is reported, not recovered", async () => {
  const { svc } = makeService({ probe: async () => ({ ok: false, detail: "429" }), config: { ipPollMs: 0, maxAttempts: 3 } })
  await svc.enable()
  let recovered = false
  svc.on("recovered", () => (recovered = true))
  const r = await svc.runOutage({ model: "m", trigger: "test" })
  assert.equal(r.ok, false)
  assert.equal(r.attempts, 3)
  assert.equal(recovered, false)
  assert.equal(svc.status().notice.level, "error")
})

test("only one outage at a time", async () => {
  const { svc } = makeService({ probe: async () => ({ ok: true }) })
  await svc.enable()
  const a = svc.runOutage({})
  const b = svc.runOutage({})
  assert.equal(a, b)
  await a
})

test("manual rotate refuses while off", async () => {
  const { svc } = makeService()
  await assert.rejects(svc.rotate(), /off/)
})

test("startup probe records limited direct IP and notices", async () => {
  const { svc } = makeService({ probe: async () => ({ ok: false, kind: "hard", status: 429, detail: "EndOfFreeQuota" }) })
  const p = await svc.startupProbe()
  assert.equal(p.kind, "hard")
  assert.match(svc.status().notice.text, /tor on/)
})

test("tor start failure surfaces in state", async () => {
  const { svc } = makeService({ tor: { proxy: { port: 1 }, start: async () => { throw new Error("tor binary not found") } } })
  await assert.rejects(svc.enable(), /not found/)
  assert.equal(svc.status().tor.state, "error")
  assert.equal(svc.isEnabled(), false)
})

test("reset time is next 00:00 UTC", () => {
  assert.equal(nextResetUtc(new Date("2026-10-12T13:00:00Z")), "2026-10-13T00:00:00.000Z")
  assert.equal(nextResetUtc(new Date("2026-12-31T23:59:59Z")), "2027-01-01T00:00:00.000Z")
})

test("noteFingerprint stores the capture; validateIp replays it with a derived endpoint", async () => {
  const probed = []
  const { svc } = makeService({ probe: async (o) => (probed.push(o), { ok: true, status: 200, detail: "ok" }) })
  assert.equal(svc.noteFingerprint(null), false)
  assert.equal(svc.noteFingerprint({ headers: {} }), false)
  assert.equal(svc.noteFingerprint({ baseURL: "https://opencode.ai/inference/v1", headers: { "user-agent": "u" } }), true)
  await svc.validateIp("opencode/big-pickle")
  assert.equal(probed.length, 1)
  assert.equal(probed[0].model, "big-pickle")
  assert.equal(probed[0].endpoint, "https://opencode.ai/inference/v1/chat/completions")
  assert.deepEqual(probed[0].fingerprint.headers, { "user-agent": "u" })
  assert.equal(typeof svc.status().fp.at, "number")
})

test("responses models validate against /responses", async () => {
  const probed = []
  const { svc } = makeService({ probe: async (o) => (probed.push(o), { ok: true, status: 200, detail: "ok" }) })
  await svc.validateIp("muse-spark-1.3-contributor-free")
  assert.equal(probed[0].model, "muse-spark-1.3-contributor-free")
  assert.equal(probed[0].endpoint, "https://opencode.ai/zen/v1/responses")
})
