import { afterAll, expect, test } from "bun:test"
import http from "node:http"
import { testRender } from "@opentui/solid"

import plugin from "../src/tui.tsx"

let status: any = {
  enabled: true, ip: "185.1.2.3", ipIsTor: true, tor: { state: "ready" },
  stats: { rotations: 4, ok: 120, failed: 3, outages: 2 }, outage: { active: false },
  resetAt: "2026-10-13T00:00:00.000Z", exits: 1500, cfg: { timeoutMs: 300000 },
  notice: { id: 1, text: "Tor routing enabled", level: "success", at: Date.now() },
}
const calls: string[] = []
const server = http.createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`)
  res.setHeader("content-type", "application/json")
  res.end(JSON.stringify(req.url === "/__tor/status" ? status : status))
})
await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
const port = (server.address() as any).port
afterAll(() => server.close())

const ctxState: { popup?: any } = {}
function fakeContext() {
  const slots: Record<string, any> = {}
  const toasts: any[] = []
  const dialogs: string[] = []
  let layer: any
  const context = {
    options: { relayPort: port },
    keymap: { layer: (fn: any) => (layer = fn()) },
    ui: {
      toast: { show: (t: any) => toasts.push(t) },
      dialog: { set() {}, show: (render: any) => (dialogs.push("show"), (ctxState.popup = render)), clear: () => dialogs.push("clear"), alert: async (a: any) => dialogs.push("alert:" + a.message) },
      slot: (s: any) => {
        const key = s.append ?? s.prepend
        slots[key] = s
        return () => delete slots[key]
      },
    },
  }
  return { context, slots, toasts, dialogs, commands: () => layer.commands }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("sidebar shows mode, IP, stats, reset time and exits", async () => {
  const f = fakeContext()
  const cleanup = (plugin as any).setup(f.context)
  await sleep(1300)
  const t = await testRender(() => f.slots["sidebar.content"].render({ sessionID: "s" }), { width: 70, height: 24 })
  await t.renderOnce()
  const frame = t.captureCharFrame()
  for (const s of ["Tor: ON", "185.1.2.3 (Tor exit)", "Rotations: 4", "120 ok / 3 failed", "Quota reset", "Tor exits: 1,500"]) expect(frame).toContain(s)
  const footer = await testRender(() => f.slots["prompt.footer.status"].render({}), { width: 50, height: 3 })
  await footer.renderOnce()
  expect(footer.captureCharFrame()).toContain("Tor: ON · 185.1.2.3")
  expect(f.toasts.length).toBe(1)
  cleanup()
})

test("outage opens a popup and closes it afterwards", async () => {
  const f = fakeContext()
  status = { ...status, outage: { active: true, attempt: 2, maxAttempts: 10, phase: "validating", startedAt: Date.now() - 5000 }, notice: { ...status.notice, id: 2 } }
  const cleanup = (plugin as any).setup(f.context)
  await sleep(1300)
  expect(f.dialogs).toContain("show")
  const pop = await testRender(ctxState.popup, { width: 70, height: 12 })
  await pop.renderOnce()
  const frame = pop.captureCharFrame()
  expect(frame).toContain("Quota limit reached")
  expect(frame).toContain("attempt 2/10")
  status = { ...status, outage: { active: false } }
  await sleep(1300)
  expect(f.dialogs).toContain("clear")
  cleanup()
})

test("commands call the right endpoints", async () => {
  const f = fakeContext()
  const cleanup = (plugin as any).setup(f.context)
  const cmds = f.commands()
  expect(cmds.map((c: any) => c.slash.name)).toEqual(["tor-on", "tor-off", "tor-rotate", "tor-status"])
  cmds[0].run(); cmds[1].run(); cmds[2].run()
  await sleep(400)
  expect(calls).toContain("POST /__tor/enable")
  expect(calls).toContain("POST /__tor/disable")
  expect(calls).toContain("POST /__tor/rotate")
  cleanup()
})

test("relay unreachable shows 'not loaded'", async () => {
  const f = fakeContext()
  f.context.options.relayPort = 1
  const cleanup = (plugin as any).setup(f.context)
  await sleep(1300)
  const t = await testRender(() => f.slots["sidebar.content"].render({ sessionID: "s" }), { width: 60, height: 6 })
  await t.renderOnce()
  expect(t.captureCharFrame()).toContain("not loaded")
  cleanup()
})
