// Pure view-model helpers for the TUI (no JSX): formatting + status interpretation.
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}h${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`
}

export function localReset(resetAtIso, now = Date.now(), locale, timeZone) {
  const t = new Date(resetAtIso)
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone, timeZoneName: "short" }).format(t)
  return { time, inMs: t.getTime() - now }
}

export function summarize(st, now = Date.now(), locale, timeZone) {
  if (!st) return { offline: true, lines: [], headline: "Tor: plugin not loaded" }
  const on = st.enabled
  const torState = st.tor?.state ?? "stopped"
  const headline = st.outage?.active
    ? `Tor: finding a clean IP (${st.outage.attempt ?? 0}/${st.outage.maxAttempts})`
    : on
      ? `Tor: ON${st.ip ? ` · ${st.ip}` : ""}`
      : "Tor: OFF"
  const reset = st.resetAt ? localReset(st.resetAt, now, locale, timeZone) : undefined
  const lines = [
    ["Mode", on ? "ON (via Tor)" : "OFF (direct)"],
    ["Tor daemon", torState + (st.tor?.error ? ` - ${st.tor.error}` : "")],
    ["Exit IP", st.ip ? `${st.ip}${st.ipIsTor === undefined ? "" : st.ipIsTor ? " (Tor exit)" : " (NOT a Tor exit!)"}` : "-"],
    ["Rotations", String(st.stats?.rotations ?? 0)],
    ["Requests", `${st.stats?.ok ?? 0} ok / ${st.stats?.failed ?? 0} failed`],
    ["Outages", String(st.stats?.outages ?? 0)],
  ]
  if (st.outage?.active) {
    const elapsed = now - st.outage.startedAt
    lines.push(["Recovery", `attempt ${st.outage.attempt ?? 0}/${st.outage.maxAttempts} · ${st.outage.phase ?? "..."} · ${fmtDuration(elapsed)}/${fmtDuration(st.cfg?.timeoutMs ?? 300000)}`])
  } else if (st.lastOutage) {
    lines.push(["Last outage", st.lastOutage.ok ? `ok (${st.lastOutage.ip}, ${st.lastOutage.attempts} tries)` : `FAILED: ${st.lastOutage.reason}`])
  }
  if (reset) lines.push(["Quota reset", `${reset.time} (in ${fmtDuration(reset.inMs)})`])
  if (st.exits !== undefined) lines.push(["Tor exits", st.exits.toLocaleString("en-US")])
  if (st.probe) lines.push(["Direct IP", st.probe.ok ? "has quota" : st.probe.kind ? `LIMITED (${st.probe.kind})` : `check failed (${st.probe.detail})`])
  return { offline: false, headline, lines, outage: st.outage, notice: st.notice }
}
