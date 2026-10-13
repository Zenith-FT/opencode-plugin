// Recovery procedure: rotate until an exit IP is different from the previous one AND a real
// request to the model succeeds through it. Bounded by attempts and total time.

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * @param deps.getIp      () => Promise<string|undefined>   current exit IP (through Tor)
 * @param deps.newCircuit () => Promise<void>
 * @param deps.validate   (ip) => Promise<{ok:boolean, detail?:string}>
 * @param deps.onProgress (info) => void
 * @returns {ok, ip, attempts, elapsedMs, reason?, previousIp?}
 */
export async function recover(deps, opts = {}) {
  const { maxAttempts = 10, timeoutMs = 300_000, ipPollMs = 2000, ipPollMax = 15, sleep = defaultSleep, now = Date.now } = opts
  const started = now()
  const deadline = started + timeoutMs
  const progress = (extra) => deps.onProgress?.({ maxAttempts, startedAt: started, deadline, ...extra })
  let previous
  try {
    previous = await deps.getIp()
  } catch {
    previous = undefined
  }
  const tried = new Set(previous ? [previous] : [])
  let attempts = 0
  let lastDetail = "no attempt made"

  while (attempts < maxAttempts && now() < deadline) {
    attempts++
    progress({ attempt: attempts, phase: "rotating", previousIp: previous })
    try {
      await deps.newCircuit()
    } catch (e) {
      lastDetail = `new circuit failed: ${e.message}`
      await sleep(ipPollMs)
      continue
    }
    // wait until the exit IP actually changes (NEWNYM is rate-limited by tor)
    let ip
    for (let i = 0; i < ipPollMax && now() < deadline; i++) {
      await sleep(ipPollMs)
      try {
        ip = await deps.getIp()
      } catch {
        ip = undefined
      }
      if (ip && !tried.has(ip)) break
      if (ip && tried.has(ip)) await deps.newCircuit().catch(() => {})
      ip = undefined
    }
    if (!ip) {
      lastDetail = "exit IP did not change"
      continue
    }
    tried.add(ip)
    progress({ attempt: attempts, phase: "validating", ip, previousIp: previous })
    let result
    try {
      result = await deps.validate(ip)
    } catch (e) {
      result = { ok: false, detail: e.message }
    }
    if (result.ok) return { ok: true, ip, previousIp: previous, attempts, elapsedMs: now() - started }
    lastDetail = `IP ${ip}: ${result.detail ?? "validation failed"}`
  }
  const reason = attempts >= maxAttempts ? `${maxAttempts} attempts exhausted` : "time limit reached"
  return { ok: false, previousIp: previous, attempts, elapsedMs: now() - started, reason: `${reason} (last: ${lastDetail})` }
}
