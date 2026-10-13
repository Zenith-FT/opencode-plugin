import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createHooks } from "../src/index.js"

function setup(cfg = {}, enabled = true) {
  const sent = []
  const outages = []
  const notices = []
  const service = Object.assign(new EventEmitter(), {
    isEnabled: () => enabled,
    noteResult() {},
    notice: (t) => notices.push(t),
    runOutage: async (o) => (outages.push(o), { ok: true }),
  })
  const ctx = { session: { prompt: async (i) => sent.push(i) } }
  const timers = []
  const h = createHooks({ ctx, service, port: 9253, cfg, log: () => {}, schedule: (fn) => timers.push(fn) })
  const retry = (sessionID, error, extra = {}) => {
    const e = { sessionID, model: { providerID: "opencode", id: "big-pickle" }, error, attempt: 1, decision: { retry: true, delay: 1 }, ...extra }
    h.hooks.retry(e)
    return e
  }
  return { h, sent, outages, notices, timers, retry, service, setEnabled: (v) => (enabled = v) }
}
const soft = { type: "provider.rate-limit", status: 429, message: "Rate limit exceeded" }
const hard = { type: "provider.rate-limit", status: 429, message: "x", response: { body: '{"error":"EndOfFreeQuota"}' } }

test("off: never touches retry, only suggests tor on", () => {
  const t = setup({}, false)
  const e = t.retry("s1", hard)
  assert.deepEqual(e.decision, { retry: true, delay: 1 })
  assert.equal(t.outages.length, 0)
  assert.match(t.notices[0], /tor on/)
})

test("hard limit: stops OpenCode retry, starts recovery with the model", () => {
  const t = setup()
  const e = t.retry("s1", hard)
  assert.deepEqual(e.decision, { retry: false })
  assert.deepEqual(t.outages, [{ model: "big-pickle", trigger: "hard" }])
})

test("soft limit: 1st and 2nd send 'Continue', 3rd in a row becomes a limit", async () => {
  const t = setup()
  t.retry("s1", soft)
  t.retry("s1", soft)
  assert.equal(t.outages.length, 0)
  assert.equal(t.timers.length, 2)
  for (const fn of t.timers) await fn()
  assert.deepEqual(t.sent.map((s) => s.text), ["Continue where you left off", "Continue where you left off"])
  const e = t.retry("s1", soft)
  assert.deepEqual(e.decision, { retry: false })
  assert.equal(t.outages.length, 1)
})

test("soft limit counter resets after a success", () => {
  const t = setup()
  t.retry("s1", soft)
  t.retry("s1", soft)
  t.h.hooks.httpResponse({ sessionID: "s1", response: { status: 200 } })
  t.retry("s1", soft)
  assert.equal(t.outages.length, 0)
})

test("counters are per session", () => {
  const t = setup()
  t.retry("a", soft); t.retry("b", soft); t.retry("a", soft); t.retry("b", soft)
  assert.equal(t.outages.length, 0)
})

test("other providers and other errors are ignored", () => {
  const t = setup()
  const e1 = t.retry("s", hard, { model: { providerID: "anthropic", id: "x" } })
  const e2 = t.retry("s", { type: "provider.internal", status: 503, message: "service_overloaded" })
  assert.deepEqual([e1.decision.retry, e2.decision.retry], [true, true])
  assert.equal(t.outages.length, 0)
})

test("after recovery every limited session (sub-agents too) gets the resume message", async () => {
  const t = setup()
  t.retry("main", hard)
  t.retry("child1", hard)
  t.retry("child2", soft)
  t.service.emit("recovered", { ok: true })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(t.sent.map((s) => s.sessionID).sort(), ["child1", "child2", "main"])
  assert.equal(t.h.sessions.size, 0)
})

test("resumeChildren=false resumes only the triggering session", async () => {
  const t = setup({ resumeChildren: false })
  t.retry("child", hard)
  t.retry("main", hard)
  t.service.emit("recovered", { ok: true })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(t.sent.map((s) => s.sessionID), ["main"])
})

test("model.request rewrites only opencode.ai baseURL, only when enabled", () => {
  const t = setup()
  const e = { baseURL: "https://opencode.ai/zen/v1", headers: {} }
  t.h.hooks.modelRequest(e)
  assert.equal(e.baseURL, "http://127.0.0.1:9253/zen/v1")
  const other = { baseURL: "https://example.com/v1" }
  t.h.hooks.modelRequest(other)
  assert.equal(other.baseURL, "https://example.com/v1")
  const none = {}
  t.h.hooks.modelRequest(none)
  assert.equal(none.baseURL, "http://127.0.0.1:9253/zen/v1")
  t.setEnabled(false)
  const off = { baseURL: "https://opencode.ai/zen/v1" }
  t.h.hooks.modelRequest(off)
  assert.equal(off.baseURL, "https://opencode.ai/zen/v1")
})
