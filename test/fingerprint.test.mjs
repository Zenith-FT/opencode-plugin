import assert from "node:assert/strict"
import test from "node:test"
import {
  REQUEST_RE,
  SESSION_RE,
  endpointFor,
  isResponsesModel,
  newRequestId,
  newSessionId,
  pickReplayHeaders,
  probeModel,
  stripProvider,
} from "../src/probe.js"

const QUARTET = ["bash", "glob", "grep", "read"]

function toolNames(body, responsesShape) {
  return (body.tools ?? []).map((t) => (responsesShape ? t.name : t?.function?.name))
}

test("pickReplayHeaders keeps the fingerprint, drops framing", () => {
  const out = pickReplayHeaders({
    Authorization: "Bearer secret",
    "User-Agent": "opencode/2.0.21",
    "X-Opencode-Session": "ses_abc",
    "x-session-affinity": "w",
    "Content-Length": "12",
    Host: "opencode.ai",
    Connection: "keep-alive",
  })
  assert.deepEqual(out, {
    authorization: "Bearer secret",
    "user-agent": "opencode/2.0.21",
    "x-opencode-session": "ses_abc",
    "x-session-affinity": "w",
  })
  assert.deepEqual(pickReplayHeaders(undefined), {})
})

test("stripProvider + isResponsesModel", () => {
  assert.equal(stripProvider("opencode/big-pickle"), "big-pickle")
  assert.equal(stripProvider("muse-spark-1.3-contributor-free"), "muse-spark-1.3-contributor-free")
  assert.equal(isResponsesModel("opencode/muse-spark-1.3-contributor-free"), true)
  assert.equal(isResponsesModel("big-pickle"), false)
  assert.equal(endpointFor("https://opencode.ai/zen/v1/", "big-pickle"), "https://opencode.ai/zen/v1/chat/completions")
  assert.equal(endpointFor("https://opencode.ai/zen/v1", "muse-spark-1.3-contributor-free"), "https://opencode.ai/zen/v1/responses")
})

test("replay: captured headers win over forged ones", async () => {
  const seen = []
  const request = async (url, opts) => (seen.push({ url, opts }), { status: 200, headers: {}, body: "{}" })
  const r = await probeModel({
    model: "opencode/big-pickle",
    key: "public",
    endpoint: "https://opencode.ai/zen/v1/chat/completions",
    request,
    fingerprint: {
      baseURL: "https://opencode.ai/zen/v1",
      headers: {
        Authorization: "Bearer captured",
        "User-Agent": "opencode/9.9.9",
        "x-opencode-session": "ses_realsession",
        "x-session-affinity": "w-real",
        "x-opencode-project": "proj_1",
        "content-length": "999",
      },
    },
  })
  assert.equal(r.ok, true)
  const { url, opts } = seen[0]
  assert.equal(url, "https://opencode.ai/zen/v1/chat/completions")
  assert.equal(opts.headers.authorization, "Bearer captured")
  assert.equal(opts.headers["user-agent"], "opencode/9.9.9")
  assert.equal(opts.headers["x-opencode-session"], "ses_realsession")
  assert.equal(opts.headers["x-session-affinity"], "w-real")
  assert.equal(opts.headers["x-opencode-project"], "proj_1")
  assert.ok(!("content-length" in opts.headers), "framing header must not be replayed")
  const body = JSON.parse(opts.body)
  assert.equal(body.model, "big-pickle")
  assert.equal(body.stream, true)
  assert.deepEqual(toolNames(body, false).sort(), QUARTET)
})

test("fallback: forged fingerprint has the real client's id shapes", async () => {
  const seen = []
  const request = async (url, opts) => (seen.push({ url, opts }), { status: 403, headers: {}, body: '{"error":{"type":"FreeTierError"}}' })
  const realNow = Date.now
  Date.now = () => 1790067753123 // fixed ms: plain prefix 0c85a40a3001, inverted f37a5bf5cffe
  try {
    await probeModel({ model: "big-pickle", key: "public", endpoint: "https://x/", client: "desktop", request })
  } finally {
    Date.now = realNow
  }
  const h = seen[0].opts.headers
  assert.equal(h["user-agent"], "opencode/1.18.31")
  assert.equal(h.authorization, "Bearer public")
  assert.match(h["x-opencode-session"], SESSION_RE)
  assert.match(h["x-opencode-request"], REQUEST_RE)
  assert.ok(h["x-opencode-session"].startsWith("ses_f37a5bf5cffe"), `session prefix must be inverted, got ${h["x-opencode-session"]}`)
  assert.ok(h["x-opencode-request"].startsWith("msg_0c85a40a3001"), `request prefix must ascend, got ${h["x-opencode-request"]}`)
})

test("responses models go to /responses with a Responses body", async () => {
  const seen = []
  const request = async (url, opts) => (seen.push({ url, opts }), { status: 200, headers: {}, body: "{}" })
  const r = await probeModel({ model: "muse-spark-1.3-contributor-free", key: "public", endpoint: "https://opencode.ai/zen/v1/responses", request })
  assert.equal(r.ok, true)
  assert.equal(seen[0].url, "https://opencode.ai/zen/v1/responses")
  const body = JSON.parse(seen[0].opts.body)
  assert.equal(body.model, "muse-spark-1.3-contributor-free")
  assert.equal(body.stream, true)
  assert.equal(body.store, false)
  assert.equal(body.input[0].role, "user")
  assert.deepEqual(toolNames(body, true).sort(), QUARTET)
  assert.ok(!("x-opencode-request" in seen[0].opts.headers), "responses shape carries no x-opencode-request")
})

test("id generators: session inverted, request ascending", () => {
  const realNow = Date.now
  Date.now = () => 1790067753123
  try {
    assert.ok(newSessionId().startsWith("ses_f37a5bf5cffe"))
    assert.ok(newRequestId().startsWith("msg_0c85a40a3001"))
    assert.match(newSessionId(), SESSION_RE)
    assert.match(newRequestId(), REQUEST_RE)
  } finally {
    Date.now = realNow
  }
})
