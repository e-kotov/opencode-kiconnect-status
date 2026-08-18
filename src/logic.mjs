/**
 * Pure parsing and rendering for the KI:connect gateway status widget.
 *
 * Lifted from `prime-agent-kiconnect/src/logic.mjs`, keeping its three
 * deliberate behaviours intact:
 *
 *   1. Never fall back to the configured alias for the model name. With no
 *      verified upstream model, print the literal `KI:connect` — never
 *      `GPT5-Mitarbeitende`, which is a routing slot and not evidence of what
 *      answered.
 *   2. Quota is trusted only when the gateway labels it `local-shared`. Without
 *      that header all three quota fields are discarded; an upstream that is not
 *      our gateway must not be able to paint numbers into this widget.
 *   3. `mergeStatus` keeps stale values rather than blanking a field that is
 *      missing from one response.
 *
 * Intentionally contains no credentials and no request content.
 */

export function normaliseHeaders(headers) {
  const result = {}
  if (!headers || typeof headers !== "object") return result
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined && value !== null) result[String(key).toLowerCase()] = String(value)
  }
  return result
}

function integer(value) {
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : undefined
}

function standardLimit(value) {
  return integer(typeof value === "string" ? value.split(";", 1)[0].trim() : undefined)
}

function validModel(value) {
  const model = typeof value === "string" ? value.trim() : ""
  // Header values are only display metadata. Bound it anyway, so a bad upstream
  // cannot make the terminal widget huge or inject a newline.
  return model && !/[\r\n]/.test(model) ? model.slice(0, 160) : undefined
}

/** The source tokens that count as evidence of the model that actually answered. */
const CONFIRMED_SOURCES = new Set(["response.model", "provider-metadata"])

export function statusFromHeaders(headers, observedAt = Date.now()) {
  const h = normaliseHeaders(headers)
  const localGateway = h["x-gateway-ratelimit-source"] === "local-shared"
  const upstreamSource = h["x-gateway-upstream-model-source"]
  const status = { observedAt }

  // Quota values are accepted only when the gateway explicitly labels them as
  // its shared SQLite state. Direct KI:connect has no equivalent truthful data.
  if (localGateway) {
    status.limit = integer(h["x-ratelimit-limit-hour"]) ?? standardLimit(h["ratelimit-limit"])
    status.remaining = integer(h["x-ratelimit-remaining-hour"]) ?? integer(h["ratelimit-remaining"])
    status.resetSeconds = integer(h["x-ratelimit-reset-hour"]) ?? integer(h["ratelimit-reset"])
    status.quotaSource = "local-shared"
  }

  // The same trust rule `upstream-model-server.js` applies: an unaccompanied
  // model header, or one sourced from the provider echoing the name we sent, is
  // not independent evidence.
  if (CONFIRMED_SOURCES.has(upstreamSource)) {
    const model = validModel(h["x-gateway-upstream-model"])
    if (model) {
      status.actualModel = model
      status.modelSource = `gateway:${upstreamSource}`
    }
  }
  return status
}

export function mergeStatus(previous, patch) {
  const next = { ...(previous || {}) }
  for (const [key, value] of Object.entries(patch || {})) {
    if (value !== undefined) next[key] = value
  }
  return next
}

export function meaningfulStatus(status) {
  return Boolean(status?.actualModel || status?.limit !== undefined || status?.remaining !== undefined)
}

export function statusKey(status) {
  const s = status || {}
  return JSON.stringify({
    actualModel: s.actualModel,
    modelSource: s.modelSource,
    limit: s.limit,
    remaining: s.remaining,
    resetSeconds: s.resetSeconds,
    quotaSource: s.quotaSource,
  })
}

export function formatSeconds(seconds) {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return undefined
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function safeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/**
 * Validate a status read back out of session metadata. The server half wrote it,
 * but the TUI half should not trust the shape of anything it did not compute.
 */
export function restoreStatus(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const restored = {
    actualModel: validModel(value.actualModel),
    modelSource: typeof value.modelSource === "string" ? value.modelSource.slice(0, 80) : undefined,
    limit: safeInteger(value.limit),
    remaining: safeInteger(value.remaining),
    resetSeconds: safeInteger(value.resetSeconds),
    quotaSource: value.quotaSource === "local-shared" ? value.quotaSource : undefined,
    observedAt: typeof value.observedAt === "number" && Number.isFinite(value.observedAt) ? value.observedAt : undefined,
  }
  return meaningfulStatus(restored) ? restored : undefined
}

/** Generic name parts that carry no information about which model answered. */
const GENERIC_PART = /^(?:gpt[\d.]*|o\d+|chat|model|llm|v?\d[\d.]*)$/i
/** Tenant and audience suffixes the gateway appends to every route. */
const AUDIENCE_PART = /^(?:mitarbeitende|studierende|beschaeftigte|beschäftigte|intern|internal|shared|public)$/i

/**
 * Reduce a route name to the part that distinguishes it, for the narrowest
 * tiers: `gpt-5.6-terra-mitarbeitende` → `terra`.
 */
export function shortenModel(model) {
  if (typeof model !== "string" || !model.trim()) return model
  const parts = model.trim().split(/[-_]/).filter(Boolean)
  const distinctive = parts.filter((part) => !GENERIC_PART.test(part) && !AUDIENCE_PART.test(part))
  // If every part is generic, the first one is still better than an audience
  // suffix — `GPT5-Mitarbeitende` shortens to `GPT5`, not to `Mitarbeitende`.
  return (distinctive.length ? distinctive : parts.slice(0, 1)).join("-")
}

function joinSegments(segments) {
  return segments.filter((segment) => typeof segment === "string" && segment.length > 0).join(" · ")
}

/** The four candidate renderings, widest first. */
export function tiers(status, options = {}) {
  if (!meaningfulStatus(status)) return ["", "", "", ""]

  // Rule 1: no verified model means the literal `KI:connect`, never the alias.
  const name = status.actualModel ? `KI: ${status.actualModel}` : "KI:connect"
  const short = status.actualModel ? `KI: ${shortenModel(status.actualModel)}` : "KI:connect"

  const quota =
    status.remaining !== undefined || status.limit !== undefined
      ? `${status.remaining ?? "?"}/${status.limit ?? "?"}/h`
      : undefined

  const speed = Number(options.tokensPerSecond) > 0 ? `${Math.round(options.tokensPerSecond)} T/s` : undefined

  return [
    joinSegments([name, quota, speed]),
    joinSegments([name, quota]),
    joinSegments([short, quota]),
    joinSegments([quota]),
  ]
}

export function renderKiStatus(status, options = {}) {
  const budget = options.budget ?? widgetBudget(options.width ?? 120, options.widgets ?? 2)
  return selectTier(tiers(status, options), budget)
}

/* -- Shared width handling; the same rules as opencode-cache-hit. ----------- */

// Ranges rendered two columns wide by terminals.
const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2600, 0x27bf],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f000, 0x1faff],
]

export function displayWidth(text) {
  let width = 0
  for (const character of String(text ?? "")) {
    const codePoint = character.codePointAt(0)
    if (codePoint === 0xfe0f || codePoint === 0x200d) continue
    width += WIDE_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high) ? 2 : 1
  }
  return width
}

/** Columns kept for the prompt itself before the right-hand strip is divided. */
export const PROMPT_RESERVE = 12

export function widgetBudget(totalWidth, widgets = 2) {
  const total = Number(totalWidth)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.floor((Math.floor(total) - PROMPT_RESERVE) / Math.max(1, widgets)))
}

export function resolveWidth(rendererWidth, columns, fallback = 120) {
  for (const candidate of [rendererWidth, columns]) {
    const width = Number(candidate)
    if (Number.isFinite(width) && width > 0) return Math.floor(width)
  }
  return fallback
}

export function selectTier(candidates, budget) {
  for (const candidate of candidates) {
    if (candidate && displayWidth(candidate) <= budget) return candidate
  }
  return ""
}

/* -- Generation speed, from message timings rather than a server-side timer. */

function finiteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

/**
 * Tokens per second of the last completed assistant turn for this provider.
 * Derived from the message's own `time` field, so it is inherently per session.
 */
export function tokensPerSecond(messages, providerID = "kiconnect") {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role !== "assistant") continue
    if (providerID && message.providerID !== providerID) continue

    const created = finiteNumber(message.time?.created)
    const completed = finiteNumber(message.time?.completed)
    const output = finiteNumber(message.tokens?.output)
    if (created === undefined || completed === undefined) continue

    const elapsed = completed - created
    if (elapsed <= 0 || output === undefined || output <= 0) return 0
    return Math.round((output / elapsed) * 1000)
  }
  return 0
}
