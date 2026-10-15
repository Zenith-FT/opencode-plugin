// Minimal real request to the model, made by the plugin itself (outside OpenCode).
//
// Free-tier gate: Zen answers 403 FreeTierError ("...can only be used from within
// OpenCode...") unless the request carries the official client's fingerprint.
// Forging that fingerprint stopped working: the gateway checks values the plugin
// cannot invent (notably x-session-affinity, bound server-side to a real session).
// So the plugin REPLAYS the fingerprint captured from a real client request (see
// the model.request hook in index.js) and only forges one as a last resort (a
// startup probe fired before any real request exists).
//
// Endpoint family depends on the model (shapes copied from
// 0xgetz/opencode-free-9router, verified live against the gateway):
//   chat models         -> POST <base>/chat/completions (OpenAI Chat Completions)
//   muse-spark-*-free   -> POST <base>/responses        (OpenAI Responses API)
import { randomBytes } from "node:crypto"

import { classify, toRegExp } from "./classify.js"
import { httpsRequest } from "./socks.js"

export const DEFAULT_ENDPOINT = "https://opencode.ai/zen/v1/chat/completions"
export const DEFAULT_OPENCODE_VERSION = "1.18.31"
/** Fingerprint quartet the gateway expects to see declared (0xgetz/opencode-free-9router). */
export const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"]
const FINGERPRINT_TOOL_DESCRIPTION = (name) => `OpenCode built-in ${name} tool`

/** Models served by the OpenAI Responses API (/responses), not /chat/completions. */
export const RESPONSES_MODELS = ["muse-spark-1.2-contributor-free", "muse-spark-1.3-contributor-free"]
export const isResponsesModel = (model) => RESPONSES_MODELS.includes(stripProvider(model))

/** Gateway-facing model id: the provider prefix ("opencode/big-pickle") is client-side only. */
export function stripProvider(model) {
  return String(model ?? "").split("/").pop().trim()
}

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** Headers safe to replay on a new request (hop-by-hop and framing headers excluded). */
const REPLAYABLE = new Set(["authorization", "user-agent", "accept"])
const REPLAYABLE_PREFIX = ["x-opencode-", "x-session-"]

/** Keep only the client-fingerprint headers (names lowercased, values as-is). */
export function pickReplayHeaders(headers) {
  const out = {}
  if (!headers || typeof headers !== "object") return out
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue
    const name = String(k).toLowerCase()
    if (REPLAYABLE.has(name) || REPLAYABLE_PREFIX.some((p) => name.startsWith(p))) out[name] = v
  }
  return out
}

function fingerprintTools(responsesShape) {
  return FINGERPRINT_TOOLS.map((name) =>
    responsesShape
      ? { type: "function", name, description: FINGERPRINT_TOOL_DESCRIPTION(name), parameters: { type: "object", properties: {} } }
      : { type: "function", function: { name, description: FINGERPRINT_TOOL_DESCRIPTION(name), parameters: { type: "object", properties: {} } } },
  )
}

function toolName(tool) {
  if (!tool || typeof tool !== "object") return ""
  const fn = tool.function && typeof tool.function === "object" ? tool.function : null
  return (typeof tool.name === "string" ? tool.name : fn?.name || "").trim()
}

/** The quartet must be present in the request body (forged fallback and replay alike). */
function ensureFingerprintTools(body, responsesShape) {
  const present = new Set(Array.isArray(body.tools) ? body.tools.map(toolName) : [])
  if (!Array.isArray(body.tools)) body.tools = []
  for (const t of fingerprintTools(responsesShape)) {
    if (present.has(toolName(t))) continue
    body.tools.push(t)
    present.add(toolName(t))
  }
  return body
}

const IDENTIFIER_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** User-Agent to impersonate (forged fallback only). Overridable via PI_FAKE_OPENCODE_UA / PI_FAKE_OPENCODE_VERSION. */
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

/**
 * 12-hex prefix of an OpenCode id for `timestamp` (ms). Sessions use the
 * INVERTED form (~(ts*0x1000+counter), verified against real ses_ ids in the
 * local opencode.db); request ids use the plain ascending form. Both end with
 * 14 random alphanumerics.
 */
function hexPrefix(timestamp, invert, counter = 1) {
  let value = BigInt(timestamp) * 0x1000n + BigInt(counter)
  if (invert) value = ~value & 0xffffffffffffn
  let hex = ""
  for (let i = 0; i < 6; i++) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0")
  return hex
}

/** Mint a structurally valid session id (inverted prefix, like the real client). */
export function newSessionId(timestamp = Date.now()) {
  return `ses_${hexPrefix(timestamp, true)}${randomChars(14)}`
}

/** Mint a structurally valid request id (ascending prefix, like the real client). */
export function newRequestId(timestamp = Date.now()) {
  return `msg_${hexPrefix(timestamp, false)}${randomChars(14)}`
}

/** Canonical OpenCode id shape (kept for compatibility: ses_ -> inverted, msg_ -> ascending). */
export function canonicalId(prefix) {
  return String(prefix).startsWith("ses_") ? newSessionId() : newRequestId()
}

/** Pick the upstream URL path family for a model. */
export function endpointFor(base, model) {
  return `${String(base).replace(/\/+$/, "")}${isResponsesModel(model) ? "/responses" : "/chat/completions"}`
}

/**
 * @param fingerprint { headers, baseURL } captured from a real client request (model.request hook).
 *   When present the captured headers are replayed verbatim; otherwise a fingerprint is forged.
 * @returns {ok, status, kind: "hard"|"soft"|null, detail}
 */
export async function probeModel({ model = "big-pickle", key = "public", agent, endpoint = DEFAULT_ENDPOINT, timeoutMs = 30_000, hardPattern, userAgent = buildUserAgent(), sessionId, requestId, client = process.env.OPENCODE_CLIENT?.trim() || "desktop", tools, request = httpsRequest, fingerprint }) {
  const gatewayModel = stripProvider(model)
  const responses = isResponsesModel(gatewayModel)
  const replayed = pickReplayHeaders(fingerprint?.headers)
  const headers = {
    ...replayed,
    "content-type": "application/json",
    accept: replayed.accept ?? "text/event-stream",
    "user-agent": replayed["user-agent"] ?? userAgent,
    authorization: replayed.authorization ?? `Bearer ${key}`,
  }
  if (!replayed["x-opencode-session"]) headers["x-opencode-session"] = sessionId ?? newSessionId()
  if (!replayed["x-opencode-request"] && !responses) headers["x-opencode-request"] = requestId ?? newRequestId()
  if (!replayed["x-opencode-client"]) headers["x-opencode-client"] = client
  if (!replayed["x-opencode-project"]) headers["x-opencode-project"] = "global"

  let body
  if (responses) {
    body = {
      model: gatewayModel,
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      stream: true,
      store: false,
      max_output_tokens: 16,
    }
    ensureFingerprintTools(body, true)
  } else {
    const existing = Array.isArray(tools) ? [...tools] : []
    body = { model: gatewayModel, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: true, tools: existing }
    ensureFingerprintTools(body, false)
  }
  let res
  try {
    res = await request(endpoint, { method: "POST", headers, body: JSON.stringify(body), agent, timeoutMs })
  } catch (e) {
    return { ok: false, status: 0, kind: null, detail: `network: ${e.message}` }
  }
  if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, kind: null, detail: "ok" }
  const kind = classify({ status: res.status, message: res.body.slice(0, 500), response: { body: res.body } }, toRegExp(hardPattern))
  return { ok: false, status: res.status, kind, detail: `HTTP ${res.status} ${res.body.slice(0, 120).replace(/\s+/g, " ")}` }
}