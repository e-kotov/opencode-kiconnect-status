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

/** The five candidate renderings, widest first. */
export function tiers(status, options = {}) {
  if (!meaningfulStatus(status)) return ["", "", "", "", ""]

  // Rule 1: no verified model means the literal `KI:connect`, never the alias.
  const name = status.actualModel ? `KI: ${status.actualModel}` : "KI:connect"
  const short = status.actualModel ? `KI: ${shortenModel(status.actualModel)}` : "KI:connect"

  const quota =
    status.remaining !== undefined || status.limit !== undefined
      ? `${status.remaining ?? "?"}/${status.limit ?? "?"}/h`
      : undefined

  const speed = Number(options.tokensPerSecond) > 0 ? `${Math.round(options.tokensPerSecond)} T/s` : undefined

  // The narrowest useful thing this widget knows: requests left this hour. At
  // five columns it still fits a row where `984/1000/h` does not.
  const bare = status.remaining !== undefined ? `${status.remaining}/h` : quota

  return [
    joinSegments([name, quota, speed]),
    joinSegments([name, quota]),
    joinSegments([short, quota]),
    joinSegments([quota]),
    joinSegments([bare]),
  ]
}

export function renderKiStatus(status, options = {}) {
  const budget = options.budget ?? widgetBudget(options.width ?? 120, options.widgets ?? 2)
  return selectTier(tiers(status, options), budget, { floor: normaliseNarrow(options.narrow) === "always" })
}

/**
 * The sidebar rendering: a block of lines, or none.
 *
 * The header carries the gateway's name, so the model line drops the `KI: `
 * prefix the one-line tiers need. Each line steps down its own ladder to fit
 * the fixed width.
 */
export function sidebarLines(status, options = {}) {
  if (!meaningfulStatus(status)) return []
  const budget = options.budget ?? SIDEBAR_BUDGET
  const fit = (...candidates) => selectTier(candidates, budget)

  const quota =
    status.remaining !== undefined || status.limit !== undefined
      ? `${status.remaining ?? "?"}/${status.limit ?? "?"}/h`
      : undefined
  const speed = Number(options.tokensPerSecond) > 0 ? `${Math.round(options.tokensPerSecond)} T/s` : undefined

  return [
    "KI:connect",
    // Rule 1 again: with no verified model this line is simply absent, rather
    // than repeating the alias we asked the gateway to route to.
    status.actualModel ? fit(status.actualModel, shortenModel(status.actualModel)) : "",
    fit(joinSegments([quota, speed]), quota ?? "", speed ?? ""),
  ].filter((line) => line.length > 0)
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

/**
 * Columns the prompt row spends before the right-hand strip is divided.
 *
 * Measured, not assumed. The left side of the row carries agent, model,
 * provider and reasoning effort, e.g.
 *
 *     Build auto · GPT5-mini-Mitarbeitende KI:connect (Responses API) · high
 *
 * which is ~70 columns of a 110-column terminal. The previous value of 12
 * described none of that: it handed each widget half the terminal, and the
 * left side wrapped into an unreadable block.
 */
export const PROMPT_RESERVE = 72

export function widgetBudget(totalWidth, widgets = 2) {
  const total = Number(totalWidth)
  if (!Number.isFinite(total) || total <= 0) return 0
  return Math.max(0, Math.floor((Math.floor(total) - PROMPT_RESERVE) / Math.max(1, widgets)))
}

/**
 * Columns a sidebar row may use.
 *
 * `packages/tui/src/routes/session/sidebar.tsx`: the sidebar box is `width={42}`
 * with `paddingLeft={2} paddingRight={2}`, and the content box inside it adds
 * `paddingRight={1}` — 37 columns. One more is held back for the scrollbar the
 * `scrollbox` draws once the sidebar overflows. Rows carry `truncate` anyway,
 * so an over-estimate clips a character rather than wrapping the block.
 */
export const SIDEBAR_BUDGET = 36

/**
 * Which slot owns the display, mirroring the host's own rule rather than
 * guessing at it (`packages/tui/src/routes/session/index.tsx`): the sidebar is
 * force-hidden in subagent sessions, and otherwise auto-shows above 120
 * columns. Each slot renders nothing when the other owns the display, so the
 * widget never appears twice.
 *
 * Known limitation: a plugin cannot observe the manual sidebar toggle. With the
 * sidebar toggled off on a wide terminal the block is rendered into it and is
 * not visible; toggling it back restores it.
 */
export function usesSidebar(width, session) {
  const total = Number(width)
  if (!Number.isFinite(total)) return false
  return total > 120 && !session?.parentID
}

/**
 * The terminal width to budget against. The caller passes the *reactive*
 * measurement (`useTerminalDimensions`), not `api.renderer.width` — the latter
 * is a plain object property, so a widget reading it never re-runs on resize
 * and never moves between slots.
 */
export function resolveWidth(measuredWidth, columns, fallback = 120) {
  for (const candidate of [measuredWidth, columns]) {
    const width = Number(candidate)
    if (Number.isFinite(width) && width > 0) return Math.floor(width)
  }
  return fallback
}

/**
 * What a widget does when even its narrowest tier will not fit.
 *
 *   "always" — print the narrowest tier anyway. Below ~70 columns the host's
 *              own left segment is already wrapping (`Buil/d auto · GPT5-mini-
 *              Mitarbeitende KI:connect (/Responses API)`), so a strict budget
 *              buys a tidy row that does not exist and costs the numbers.
 *   "hide"   — print nothing, keeping the row as short as the host allows.
 */
export const NARROW_MODES = ["always", "hide"]
export const DEFAULT_NARROW = "always"

export function normaliseNarrow(value, fallback = DEFAULT_NARROW) {
  if (NARROW_MODES.includes(value)) return value
  return NARROW_MODES.includes(fallback) ? fallback : DEFAULT_NARROW
}

export function selectTier(candidates, budget, options = {}) {
  for (const candidate of candidates) {
    if (candidate && displayWidth(candidate) <= budget) return candidate
  }
  if (!options.floor) return ""
  // Nothing fits. The narrowest non-empty candidate beats an empty strip.
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    if (candidates[index]) return candidates[index]
  }
  return ""
}

/* -- Generation speed, from message timings rather than a server-side timer. */

function finiteNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return value
}

/** The provider id this widget speaks for. */
export const PROVIDER_ID = "kiconnect"

/**
 * The provider that actually answered last: the `providerID` of the newest
 * *completed* assistant message. `AssistantMessage.providerID` is part of the
 * SDK's message shape, so gating on it needs no new plumbing.
 */
export function activeProviderID(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index]
    if (message?.role !== "assistant") continue
    if (finiteNumber(message.time?.completed) === undefined) continue
    return message.providerID
  }
  return undefined
}

/**
 * Whether this widget should draw at all.
 *
 * A session that has moved to SAIA must not keep showing KI:connect's model and
 * quota. The stored `metadata.kiStatus` is left untouched, so switching back
 * restores the display without a new request.
 */
export function isActive(messages, providerID = PROVIDER_ID) {
  return activeProviderID(messages) === providerID
}

/**
 * Tokens per second of the last completed assistant turn for this provider.
 * Derived from the message's own `time` field, so it is inherently per session.
 */
export function tokensPerSecond(messages, providerID = PROVIDER_ID) {
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
