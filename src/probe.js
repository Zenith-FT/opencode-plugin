// Minimal real request to the model, made by the plugin itself (outside OpenCode).
// Conforms to the free-tier client contract, copied from NekoSekaiMoe/nanopi
// (packages/coding-agent/extras/pi-fake-opencode, verified live against the gateway)
// plus diegosouzapw/OmniRoute (open-sse/executors/opencodeFreeTierContract.ts):
// Zen answers 403 FreeTierError unless the request carries User-Agent opencode/<recent>,
// x-opencode-session shaped ses_+26 alphanumerics, stream:true and a non-empty tools array.
import { randomBytes } from "node:crypto"

import { classify, toRegExp } from "./classify.js"
import { httpsRequest } from "./socks.js"

export const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions"
export const DEFAULT_OPENCODE_VERSION = "1.18.31"
/** Fingerprint quartet the gateway expects to see declared (0xgetz/opencode-free-9router). */
export const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"]
const FINGERPRINT_TOOL_DESCRIPTION = (name) => `OpenCode built-in ${name} tool`

function fingerprintTools() {
  return FINGERPRINT_TOOLS.map((name) => ({
    type: "function",
    function: { name, description: FINGERPRINT_TOOL_DESCRIPTION(name), parameters: { type: "object", properties: {} } },
  }))
}

const IDENTIFIER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** User-Agent to impersonate. Overridable via PI_FAKE_OPENCODE_UA / PI_FAKE_OPENCODE_VERSION. */
export function buildUserAgent(env = process.env) {
  const full = env.PI_FAKE_OPENCODE_UA?.trim()
  if (full) return full
  return `opencode/${env.PI_FAKE_OPENCODE_VERSION?.trim() || DEFAULT_OPENCODE_VERSION}`
}

function randomChars(count) {
  const bytes = randomBytes(count)
  let out = ""
  for (const b of bytes) out += IDENTIFIER_CHARS[b % IDENTIFIER_CHARS.length]
  return out
}

let lastTimestamp = 0
let counter = 0

/**
 * Ascending identifier like opencode's Identifier.create()
 * (packages/schema/src/identifier.ts): 12 lowercase-hex chars of
 * millisecond timestamp + per-process counter, then 14 random alphanumerics.
 */
function ascendingIdentifier() {
  const timestamp = Date.now()
  if (timestamp !== lastTimestamp) {
    lastTimestamp = timestamp
    counter = 0
  }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const time = Array.from(
    { length: 6 },
    (_, i) => Number((current >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0"),
  ).join("")
  return time + randomChars(26 - 12)
}

/** Canonical OpenCode id shape (ses_/msg_ + 26 alphanumerics). Shape is checked, value is not. */
export function canonicalId(prefix) {
  return `${prefix}${ascendingIdentifier()}`
}

/** @returns {ok, status, kind: "hard"|"soft"|null, detail} */
export async function probeModel({ model = "big-pickle", key = "public", agent, endpoint = DEFAULT_ENDPOINT, timeoutMs = 30_000, hardPattern, userAgent = buildUserAgent(), sessionId, requestId, client = process.env.OPENCODE_CLIENT?.trim() || "desktop", tools, request = httpsRequest }) {
  const existing = Array.isArray(tools) ? [...tools] : []
  const present = new Set(
    existing
      .map((t) => (typeof t?.name === "string" ? t.name : t?.function?.name))
      .filter((n) => typeof n === "string"),
  )
  const bodyTools = [...existing, ...fingerprintTools().filter((t) => !present.has(t.function.name))]
  let res
  try {
    res = await request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${key}`,
        "user-agent": userAgent,
        "x-opencode-session": sessionId ?? canonicalId("ses_"),
        "x-opencode-request": requestId ?? canonicalId("msg_"),
        "x-opencode-client": client,
        "x-opencode-project": "global",
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true, tools: bodyTools }),
      agent,
      timeoutMs,
    })
  } catch (e) {
    return { ok: false, status: 0, kind: null, detail: `network: ${e.message}` }
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, kind: null, detail: "ok" }
  const kind = classify({ status: res.status, message: res.body.slice(0, 500), response: { body: res.body } }, toRegExp(hardPattern))
  return { ok: false, status: res.status, kind, detail: `HTTP ${res.status} ${res.body.slice(0, 120).replace(/\s+/g, " ")}` }
}
