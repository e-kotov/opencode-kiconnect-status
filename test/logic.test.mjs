import assert from "node:assert/strict"
import test from "node:test"

import {
  activeProviderID,
  DEFAULT_NARROW,
  displayWidth,
  formatSeconds,
  isActive,
  meaningfulStatus,
  mergeStatus,
  normaliseNarrow,
  renderKiStatus,
  restoreStatus,
  selectTier,
  shortenModel,
  sidebarLines,
  statusFromHeaders,
  statusKey,
  tiers,
  tokensPerSecond,
  usesSidebar,
  widgetBudget,
} from "../src/logic.mjs"

/** Exactly what the live gateway sends. */
const GATEWAY_HEADERS = {
  "X-Gateway-RateLimit-Source": "local-shared",
  "X-RateLimit-Limit-Hour": "100",
  "X-RateLimit-Remaining-Hour": "87",
  "X-RateLimit-Reset-Hour": "1800",
  "X-Gateway-Upstream-Model": "gpt-5.6-terra-mitarbeitende",
  "X-Gateway-Upstream-Model-Source": "response.model",
}

test("accepts gateway-labelled quota and a provenance-labelled actual model", () => {
  assert.deepEqual(statusFromHeaders(GATEWAY_HEADERS, 123), {
    limit: 100,
    remaining: 87,
    resetSeconds: 1800,
    quotaSource: "local-shared",
    actualModel: "gpt-5.6-terra-mitarbeitende",
    modelSource: "gateway:response.model",
    observedAt: 123,
  })
})

test("discards quota that is not labelled local-shared", () => {
  // Anti-spoofing: without the gateway's own label these numbers could come
  // from anywhere, so all three fields go.
  const status = statusFromHeaders({
    "x-ratelimit-limit-hour": "1000",
    "x-ratelimit-remaining-hour": "999",
    "x-ratelimit-reset-hour": "42",
  }, 1)
  assert.deepEqual(status, { observedAt: 1 })
})

test("discards a SAIA-shaped or unaccompanied upstream model header", () => {
  const status = statusFromHeaders({
    "llm_provider-x-ratelimit-remaining-hour": "12",
    "x-gateway-upstream-model": "untrusted",
  }, 1)
  assert.deepEqual(status, { observedAt: 1 })

  // The provider echoing back the name we sent is not independent evidence.
  const echoed = statusFromHeaders({
    "x-gateway-upstream-model": "GPT5-Mitarbeitende",
    "x-gateway-upstream-model-source": "response.model-echo",
  }, 1)
  assert.equal(echoed.actualModel, undefined)

  assert.equal(statusFromHeaders({
    "x-gateway-upstream-model": "provider-metadata is fine",
    "x-gateway-upstream-model-source": "provider-metadata",
  }, 1).actualModel, "provider-metadata is fine")
})

test("rejects a model header carrying a newline or unbounded length", () => {
  const injected = statusFromHeaders({
    "x-gateway-upstream-model": "gpt-5\nX-Evil: yes",
    "x-gateway-upstream-model-source": "response.model",
  }, 1)
  assert.equal(injected.actualModel, undefined)

  const long = statusFromHeaders({
    "x-gateway-upstream-model": "m".repeat(500),
    "x-gateway-upstream-model-source": "response.model",
  }, 1)
  assert.equal(long.actualModel.length, 160)
})

test("parses the RFC RateLimit fields as a fallback", () => {
  const status = statusFromHeaders({
    "x-gateway-ratelimit-source": "local-shared",
    "ratelimit-limit": "100;w=3600",
    "ratelimit-remaining": "71",
    "ratelimit-reset": "3599",
  }, 3)
  assert.equal(status.limit, 100)
  assert.equal(status.remaining, 71)
  assert.equal(status.resetSeconds, 3599)
  assert.equal(status.actualModel, undefined)
})

test("keeps stale values when a field is missing from one response", () => {
  const first = statusFromHeaders(GATEWAY_HEADERS, 1)
  const second = statusFromHeaders({ "x-gateway-ratelimit-source": "local-shared", "x-ratelimit-remaining-hour": "86" }, 2)
  const merged = mergeStatus(first, second)
  assert.equal(merged.remaining, 86)
  assert.equal(merged.actualModel, "gpt-5.6-terra-mitarbeitende", "a verified model survives a response that omits it")
  assert.equal(merged.limit, 100)
})

test("statusKey ignores the observation timestamp", () => {
  assert.equal(statusKey(statusFromHeaders(GATEWAY_HEADERS, 1)), statusKey(statusFromHeaders(GATEWAY_HEADERS, 999)))
})

test("renders every tier", () => {
  const status = statusFromHeaders(GATEWAY_HEADERS, 0)
  assert.deepEqual(tiers(status, { tokensPerSecond: 82 }), [
    "KI: gpt-5.6-terra-mitarbeitende · 87/100/h · 82 T/s",
    "KI: gpt-5.6-terra-mitarbeitende · 87/100/h",
    "KI: terra · 87/100/h",
    "87/100/h",
    // Five columns of the only thing that still matters when there is no room:
    // requests left this hour.
    "87/h",
  ])
})

test("never falls back to the configured alias for the model name", () => {
  // Quota arrived but the model was not verified: say KI:connect, not the
  // route name we asked for.
  const status = statusFromHeaders({
    "x-gateway-ratelimit-source": "local-shared",
    "x-ratelimit-limit-hour": "100",
    "x-ratelimit-remaining-hour": "87",
  }, 0)
  assert.deepEqual(tiers(status), [
    "KI:connect · 87/100/h",
    "KI:connect · 87/100/h",
    "KI:connect · 87/100/h",
    "87/100/h",
    "87/h",
  ])
  assert.doesNotMatch(tiers(status).join(" "), /Mitarbeitende/i)
})

test("renders nothing when neither a model nor a quota is known", () => {
  assert.equal(renderKiStatus(statusFromHeaders({}, 0), { width: 200 }), "")
  assert.equal(renderKiStatus(undefined, { width: 200 }), "")
  assert.equal(meaningfulStatus({ observedAt: 5 }), false)
})

test("shows a missing half of the quota pair as a question mark", () => {
  const status = statusFromHeaders({
    "x-gateway-ratelimit-source": "local-shared",
    "x-ratelimit-remaining-hour": "87",
  }, 0)
  assert.equal(tiers(status)[3], "87/?/h")
  assert.equal(tiers(status)[4], "87/h", "the narrowest tier needs no limit at all")
})

test("steps down a tier as the terminal narrows", () => {
  const status = statusFromHeaders(GATEWAY_HEADERS, 0)
  const at = (width) => renderKiStatus(status, { width, tokensPerSecond: 82 })
  assert.equal(at(200), "KI: gpt-5.6-terra-mitarbeitende · 87/100/h · 82 T/s")
  assert.equal(at(160), "KI: gpt-5.6-terra-mitarbeitende · 87/100/h")
  assert.equal(at(120), "KI: terra · 87/100/h")
  assert.equal(at(110), "87/100/h")
  assert.equal(at(90), "87/100/h", "9 columns still fits the bare quota")
  assert.equal(at(84), "87/h", "6 columns still fits the hourly remainder")
  assert.equal(at(80), "87/h", "and so does 4, exactly")
  // Past the last tier the two narrow modes part company.
  assert.equal(renderKiStatus(status, { width: 76, narrow: "hide" }), "")
  assert.equal(at(76), "87/h", "the default keeps the numbers")
})

test("keeps the narrowest tier when nothing fits, unless told to hide", () => {
  // Below ~70 columns the host's own left segment is already wrapping, so a
  // strict budget buys a tidy row that does not exist and costs the numbers.
  const status = statusFromHeaders(GATEWAY_HEADERS, 0)
  for (const width of [76, 65, 40, 4]) {
    assert.equal(renderKiStatus(status, { width }), "87/h", `${width} columns, default`)
    assert.equal(renderKiStatus(status, { width, narrow: "hide" }), "", `${width} columns, hide`)
  }
  // Nothing known still means nothing shown, in either mode.
  assert.equal(renderKiStatus(statusFromHeaders({}, 0), { width: 40 }), "")
})

test("normalises a narrow mode, falling back rather than trusting input", () => {
  assert.equal(DEFAULT_NARROW, "always")
  assert.equal(normaliseNarrow("hide"), "hide")
  assert.equal(normaliseNarrow(undefined), "always")
  assert.equal(normaliseNarrow("nonsense"), "always")
  // A bad value from tui.json falls through to the layer beneath it.
  assert.equal(normaliseNarrow(undefined, "hide"), "hide")
  assert.equal(normaliseNarrow("nonsense", "hide"), "hide")
})

test("floors only when asked, so selectTier stays honest by default", () => {
  assert.equal(selectTier(["wide enough", "short"], 3), "")
  assert.equal(selectTier(["wide enough", "short"], 3, { floor: true }), "short")
  assert.equal(selectTier(["", ""], 0, { floor: true }), "", "nothing to fall back to")
})

test("shortens a route name to its distinctive part", () => {
  assert.equal(shortenModel("gpt-5.6-terra-mitarbeitende"), "terra")
  assert.equal(shortenModel("gpt-5-mini-Mitarbeitende"), "mini")
  assert.equal(shortenModel("gpt-5.6-terra-preview-mitarbeitende"), "terra-preview")
  // Every part generic: the first beats an audience suffix.
  assert.equal(shortenModel("GPT5-Mitarbeitende"), "GPT5")
  assert.equal(shortenModel("llama-3.3-70b"), "llama-70b")
  assert.equal(shortenModel(""), "")
})

test("reserves the columns the prompt row actually spends", () => {
  // PROMPT_RESERVE = 72, measured: `Build auto · GPT5-mini-Mitarbeitende
  // KI:connect (Responses API) · high` is ~70 columns of a 110-column terminal.
  // 19 columns is exactly what the narrow tiers were built for.
  assert.equal(widgetBudget(110, 2), 19)
  assert.equal(widgetBudget(120), 24)
  assert.equal(widgetBudget(120, 3), 16)
  assert.equal(widgetBudget(72), 0)
  assert.equal(widgetBudget("nonsense"), 0)
  // 80 columns leaves 4 per widget — exactly what `87/h` costs, so the
  // narrowest tier survives even under "hide". 76 is the first width it does
  // not, though a three-digit remainder (`984/h`) runs out one step earlier.
  assert.equal(widgetBudget(80, 2), 4)
  assert.equal(renderKiStatus(statusFromHeaders(GATEWAY_HEADERS, 0), { width: 80, narrow: "hide" }), "87/h")
  assert.equal(renderKiStatus(statusFromHeaders(GATEWAY_HEADERS, 0), { width: 76, narrow: "hide" }), "")
})

test("draws only while KI:connect is the provider that answered last", () => {
  const ki = { role: "assistant", providerID: "kiconnect", time: { created: 0, completed: 12_700 }, tokens: { output: 1_041 } }
  const saia = { role: "assistant", providerID: "saia", time: { created: 0, completed: 1_000 }, tokens: { output: 5_000 } }

  assert.equal(activeProviderID([saia, ki]), "kiconnect")
  assert.equal(activeProviderID([ki, saia]), "saia")
  assert.equal(activeProviderID([]), undefined)
  assert.equal(activeProviderID(undefined), undefined)

  assert.equal(isActive([saia, ki]), true)
  assert.equal(isActive([ki, saia]), false, "a session that moved to SAIA must go quiet")
  assert.equal(isActive([]), false)
  // An in-flight turn has not answered yet, so it does not hand over.
  assert.equal(isActive([ki, { role: "assistant", providerID: "saia", time: { created: 20_000 } }]), true)
  assert.equal(isActive([ki, saia], "saia"), true)
})

test("gives the sidebar the display exactly when the host would show it", () => {
  // packages/tui/src/routes/session/index.tsx: 42-column sidebar, auto above
  // 120 columns, force-hidden in a subagent session.
  assert.equal(usesSidebar(121, {}), true)
  assert.equal(usesSidebar(120, {}), false, "120 is not wider than 120")
  assert.equal(usesSidebar(200, { parentID: "ses_parent" }), false, "a subagent session has no sidebar")
  assert.equal(usesSidebar(200, undefined), true)
  assert.equal(usesSidebar(undefined, {}), false)
  assert.equal(usesSidebar("nonsense", {}), false)
})

test("the sidebar renderer returns lines and the prompt renderer one string", () => {
  const status = statusFromHeaders({
    "x-gateway-ratelimit-source": "local-shared",
    "x-ratelimit-limit-hour": "1000",
    "x-ratelimit-remaining-hour": "974",
    "x-gateway-upstream-model": "gpt-5-mini-Mitarbeitende",
    "x-gateway-upstream-model-source": "response.model",
  }, 0)

  const lines = sidebarLines(status, { tokensPerSecond: 82 })
  assert.deepEqual(lines, ["KI:connect", "gpt-5-mini-Mitarbeitende", "974/1000/h · 82 T/s"])
  for (const line of lines) {
    assert.ok(displayWidth(line) <= 36, `"${line}" must fit the sidebar's 36 columns`)
  }
  assert.equal(typeof renderKiStatus(status, { width: 120 }), "string")

  // The header carries the gateway's name, so an unverified model leaves no
  // second line rather than repeating the alias we asked it to route to.
  const unverified = statusFromHeaders({
    "x-gateway-ratelimit-source": "local-shared",
    "x-ratelimit-limit-hour": "100",
    "x-ratelimit-remaining-hour": "87",
  }, 0)
  assert.deepEqual(sidebarLines(unverified), ["KI:connect", "87/100/h"])
  assert.deepEqual(sidebarLines(statusFromHeaders({}, 0)), [])
  assert.deepEqual(sidebarLines(undefined), [])
})

test("steps each sidebar line down its own ladder when the name is long", () => {
  const status = statusFromHeaders(GATEWAY_HEADERS, 0)
  assert.deepEqual(sidebarLines(status, { tokensPerSecond: 82 }), [
    "KI:connect",
    "gpt-5.6-terra-mitarbeitende",
    "87/100/h · 82 T/s",
  ])
  assert.deepEqual(sidebarLines(status, { budget: 12, tokensPerSecond: 82 }), ["KI:connect", "terra", "87/100/h"])
})

test("computes speed from the last completed kiconnect turn", () => {
  const messages = [
    { role: "assistant", providerID: "saia", time: { created: 0, completed: 1_000 }, tokens: { output: 5_000 } },
    { role: "assistant", providerID: "kiconnect", time: { created: 0, completed: 12_700 }, tokens: { output: 1_041 } },
    { role: "user" },
  ]
  assert.equal(tokensPerSecond(messages), 82, "a SAIA turn must not be read as a KI one")
  assert.equal(tokensPerSecond(messages, "saia"), 5_000)
  assert.equal(tokensPerSecond([]), 0)
  assert.equal(tokensPerSecond([{ role: "assistant", providerID: "kiconnect", time: { created: 0 }, tokens: { output: 9 } }]), 0)
})

test("validates a status read back out of session metadata", () => {
  const stored = statusFromHeaders(GATEWAY_HEADERS, 7)
  assert.deepEqual(restoreStatus(JSON.parse(JSON.stringify(stored))), stored)

  assert.equal(restoreStatus(undefined), undefined)
  assert.equal(restoreStatus({ observedAt: 1 }), undefined)
  assert.equal(restoreStatus({ actualModel: "x", limit: -5, quotaSource: "spoofed" }).limit, undefined)
  assert.equal(restoreStatus({ actualModel: "x", quotaSource: "spoofed" }).quotaSource, undefined)
})

test("formats a quota reset interval", () => {
  assert.equal(formatSeconds(42), "42s")
  assert.equal(formatSeconds(1_800), "30m")
  assert.equal(formatSeconds(1_805), "30m 5s")
  assert.equal(formatSeconds(-1), undefined)
})
