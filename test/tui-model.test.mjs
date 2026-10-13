import assert from "node:assert/strict"
import test from "node:test"
import { fmtDuration, localReset, summarize } from "../src/tui-model.js"

test("fmtDuration", () => {
  assert.equal(fmtDuration(65_000), "1:05")
  assert.equal(fmtDuration(3_900_000), "1h05m")
  assert.equal(fmtDuration(-5), "0:00")
})

test("reset time converts 00:00 UTC to the given zone (DST aware)", () => {
  const r = localReset("2026-10-13T00:00:00.000Z", Date.parse("2026-10-12T20:00:00Z"), "en-GB", "Europe/Paris")
  assert.match(r.time, /02:00/)
  assert.equal(r.inMs, 4 * 3600_000)
  const w = localReset("2026-01-13T00:00:00.000Z", 0, "en-GB", "Europe/Paris")
  assert.match(w.time, /01:00/)
})

test("offline status", () => {
  const v = summarize(undefined)
  assert.equal(v.offline, true)
  assert.match(v.headline, /not loaded/)
})

test("off, on and outage headlines + lines", () => {
  const base = { enabled: false, tor: { state: "stopped" }, stats: { rotations: 3, ok: 10, failed: 2, outages: 1 }, resetAt: "2026-10-13T00:00:00.000Z", exits: 1234, cfg: { timeoutMs: 300000 } }
  assert.equal(summarize(base, 0, "en-GB", "UTC").headline, "Tor: OFF")
  const on = summarize({ ...base, enabled: true, ip: "1.2.3.4", ipIsTor: true, tor: { state: "ready" } }, 0, "en-GB", "UTC")
  assert.equal(on.headline, "Tor: ON · 1.2.3.4")
  const get = (v, k) => v.lines.find((l) => l[0] === k)?.[1]
  assert.equal(get(on, "Exit IP"), "1.2.3.4 (Tor exit)")
  assert.equal(get(on, "Requests"), "10 ok / 2 failed")
  assert.equal(get(on, "Tor exits"), "1,234")
  const out = summarize({ ...base, enabled: true, outage: { active: true, attempt: 3, maxAttempts: 10, phase: "validating", startedAt: 0 } }, 75_000, "en-GB", "UTC")
  assert.equal(out.headline, "Tor: finding a clean IP (3/10)")
  assert.equal(get(out, "Recovery"), "attempt 3/10 · validating · 1:15/5:00")
  const failed = summarize({ ...base, lastOutage: { ok: false, reason: "10 attempts exhausted" }, probe: { ok: false, kind: "hard" } }, 0, "en-GB", "UTC")
  assert.match(get(failed, "Last outage"), /FAILED/)
  assert.equal(get(failed, "Direct IP"), "LIMITED (hard)")
  assert.equal(get(summarize({ ...base, ip: "9.9.9.9", ipIsTor: false }, 0), "Exit IP"), "9.9.9.9 (NOT a Tor exit!)")
})
