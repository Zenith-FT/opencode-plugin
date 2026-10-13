import assert from "node:assert/strict"
import test from "node:test"
import { classify, toRegExp } from "../src/classify.js"

test("plain rate limit is soft", () => {
  assert.equal(classify({ type: "provider.rate-limit", message: "Rate limit exceeded", status: 429 }), "soft")
  assert.equal(classify({ type: "x", message: "Rate limit exceeded. Please try again later." }), "soft")
  assert.equal(classify({ type: "x", message: "m", status: 429 }), "soft")
})
test("end of quota / Go message is hard", () => {
  assert.equal(classify({ type: "provider.quota", message: "x" }), "hard")
  assert.equal(classify({ type: "provider.rate-limit", status: 429, message: "m", response: { body: '{"type":"FreeUsageLimitError","error":"EndOfFreeQuota"}' } }), "hard")
  assert.equal(classify({ type: "u", message: "Free usage exceeded, subscribe to Go" }), "hard")
})
test("other errors are ignored", () => {
  assert.equal(classify({ type: "provider.internal", message: "service_overloaded", status: 503 }), null)
  assert.equal(classify({ type: "provider.auth", message: "403 FreeTierError", status: 403 }), null)
  assert.equal(classify(undefined), null)
})
test("custom hard pattern", () => {
  assert.equal(classify({ type: "x", message: "weird quota text", status: 429 }, toRegExp("weird quota")), "hard")
  assert.ok(toRegExp("(", /fallback/) instanceof RegExp)
})
