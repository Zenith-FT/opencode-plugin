import assert from "node:assert/strict"
import test from "node:test"
import { recover } from "../src/outage.js"

const fast = { sleep: async () => {}, ipPollMs: 0 }

function deps(ips, results) {
  let i = 0
  let v = 0
  const calls = { circuits: 0, validated: [] }
  return {
    calls,
    getIp: async () => ips[Math.min(i, ips.length - 1)],
    newCircuit: async () => (calls.circuits++, i++),
    validate: async (ip) => (calls.validated.push(ip), results[v++] ?? { ok: false, detail: "no more" }),
  }
}

test("first new IP that answers is accepted", async () => {
  const d = deps(["1.1.1.1", "2.2.2.2"], [{ ok: true }])
  const r = await recover(d, fast)
  assert.deepEqual([r.ok, r.ip, r.previousIp, r.attempts], [true, "2.2.2.2", "1.1.1.1", 1])
})
test("retries until a good one", async () => {
  const d = deps(["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4"], [{ ok: false, detail: "429" }, { ok: false, detail: "429" }, { ok: true }])
  const r = await recover(d, fast)
  assert.equal(r.ok, true)
  assert.equal(r.attempts, 3)
  assert.deepEqual(d.calls.validated, ["2.2.2.2", "3.3.3.3", "4.4.4.4"])
})
test("same IP as before is never validated", async () => {
  const d = deps(["1.1.1.1", "1.1.1.1", "9.9.9.9"], [{ ok: true }])
  const r = await recover(d, fast)
  assert.equal(r.ip, "9.9.9.9")
  assert.deepEqual(d.calls.validated, ["9.9.9.9"])
})
test("stops after maxAttempts", async () => {
  const ips = Array.from({ length: 30 }, (_, i) => `10.0.0.${i}`)
  const d = deps(ips, [])
  const r = await recover(d, { ...fast, maxAttempts: 10 })
  assert.equal(r.ok, false)
  assert.equal(r.attempts, 10)
  assert.match(r.reason, /10 attempts exhausted/)
})
test("stops at the time limit", async () => {
  let t = 0
  const ips = Array.from({ length: 30 }, (_, i) => `10.0.0.${i}`)
  const d = deps(ips, [])
  const r = await recover(d, { ...fast, timeoutMs: 1000, now: () => (t += 400) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /time limit/)
})
test("progress callback reports attempts", async () => {
  const seen = []
  const d = { ...deps(["1.1.1.1", "2.2.2.2"], [{ ok: true }]), onProgress: (p) => seen.push(`${p.attempt}:${p.phase}`) }
  await recover(d, fast)
  assert.deepEqual(seen, ["1:rotating", "1:validating"])
})
