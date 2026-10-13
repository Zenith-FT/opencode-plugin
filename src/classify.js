// Classifies a session error into a "hard" limit (quota exhausted), a "soft" limit
// (plain rate limiting) or null (anything else, which this plugin never touches).

export const DEFAULT_HARD =
  /EndOfFreeQuota|Free usage exceeded|subscribe to Go|GoUsageLimit|CreditsError|insufficient[_ ]quota/i

export function classify(error, hardPattern = DEFAULT_HARD) {
  if (!error || typeof error !== "object") return null
  const body = error.response?.body ?? ""
  const text = `${error.type ?? ""} ${error.message ?? ""} ${typeof body === "string" ? body : JSON.stringify(body)}`
  if (error.type === "provider.quota" || hardPattern.test(text)) return "hard"
  if (error.status === 429 || error.type === "provider.rate-limit" || /rate limit/i.test(text)) return "soft"
  return null
}

export function toRegExp(value, fallback = DEFAULT_HARD) {
  if (value instanceof RegExp) return value
  if (typeof value !== "string" || value === "") return fallback
  try {
    return new RegExp(value, "i")
  } catch {
    return fallback
  }
}
