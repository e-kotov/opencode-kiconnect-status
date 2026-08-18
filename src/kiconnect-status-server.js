// Publish the KI:connect gateway's verified model and hourly quota into session
// metadata, for the TUI half to render.
//
// This needs a server half because the evidence is only in response *headers* —
// `x-gateway-upstream-model`, `x-gateway-upstream-model-source` and the
// `x-ratelimit-*-hour` family — which are visible only from a `fetch` wrapper.
//
// A deliberate sibling of `upstream-model-server.js` rather than an edit to it:
// that one writes an `upstreamModel` key and covers both providers, this writes
// `kiStatus` and adds the quota. Both wrap `fetch`, and they chain safely
// because each calls the `originalFetch` it captured; each also carries its own
// `Symbol.for()` guard, so neither double-wraps.

import { meaningfulStatus, mergeStatus, statusFromHeaders, statusKey } from "./logic.mjs"

const INTERNAL_SESSION_HEADER = "x-opencode-kiconnect-session"
const WRAPPED_FETCH = Symbol.for("brain-gateway.kiconnect-status-fetch")
const PROVIDER = "kiconnect"
const METADATA_KEY = "kiStatus"

function requestURL(input) {
  try {
    if (typeof input === "string") return new URL(input)
    if (input instanceof URL) return input
    if (input && typeof input.url === "string") return new URL(input.url)
  } catch {}
}

// Match only the configured provider base URL. A missing or malformed base URL
// disables interception rather than guessing an endpoint.
function providerOrigin(options) {
  try {
    if (options?.baseURL) return new URL(options.baseURL).origin
  } catch {}
}

function requestHeaders(input, init) {
  const headers = new Headers()
  const inputHeaders = input instanceof Request ? input.headers : input?.headers
  if (inputHeaders) new Headers(inputHeaders).forEach((value, key) => headers.set(key, value))
  if (init?.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  return headers
}

function unwrap(result) {
  if (result && typeof result === "object" && "data" in result) return result.data
  return result
}

/** `Headers` is not enumerable by `Object.entries`, which the parser expects. */
function headerBag(headers) {
  const bag = {}
  headers.forEach((value, key) => {
    bag[key] = value
  })
  return bag
}

async function saveStatus(client, sessionID, status) {
  const transport = client?._client
  if (!transport || typeof transport.get !== "function" || typeof transport.patch !== "function") {
    throw new Error("OpenCode's HTTP client is unavailable")
  }

  const current = unwrap(await transport.get({ url: "/session/{sessionID}", path: { sessionID } }))
  const metadata =
    current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
      ? current.metadata
      : {}

  await transport.patch({
    url: "/session/{sessionID}",
    path: { sessionID },
    headers: { "Content-Type": "application/json" },
    body: { metadata: { ...metadata, [METADATA_KEY]: status } },
  })
}

export function createKiconnectStatusHooks(client, { onWarning = console.warn } = {}) {
  const pendingWrites = new Map()
  // Merged per session, so a response that omits one field keeps the last known
  // value rather than blanking it.
  const sessions = new Map()

  function observe(sessionID, patch) {
    const previous = sessions.get(sessionID)
    const next = mergeStatus(previous, patch)
    sessions.set(sessionID, next)

    // A response carrying neither a labelled quota nor a verified model has
    // nothing to publish; do not write an empty object over the session.
    if (!meaningfulStatus(next)) return
    // This fires on every response; only write when something actually changed.
    if (previous && statusKey(previous) === statusKey(next)) return
    enqueueSave(sessionID, next)
  }

  function enqueueSave(sessionID, status) {
    const previous = pendingWrites.get(sessionID) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(() => saveStatus(client, sessionID, status))
    pendingWrites.set(sessionID, current)
    void current.then(
      () => {
        if (pendingWrites.get(sessionID) === current) pendingWrites.delete(sessionID)
      },
      (error) => {
        onWarning(
          `[kiconnect-status] Failed to save gateway status: ${error instanceof Error ? error.message : String(error)}`,
        )
        if (pendingWrites.get(sessionID) === current) pendingWrites.delete(sessionID)
      },
    )
  }

  async function flush() {
    while (pendingWrites.size > 0) await Promise.allSettled([...pendingWrites.values()])
  }

  return {
    config(config) {
      const options = config.provider?.[PROVIDER]?.options
      if (!options) return

      const originalFetch = options.fetch ?? globalThis.fetch
      if (typeof originalFetch !== "function" || originalFetch[WRAPPED_FETCH]) return
      const origin = providerOrigin(options)

      const wrappedFetch = async function (input, init) {
        const url = requestURL(input)
        if (!origin || url?.origin !== origin) return originalFetch.call(this, input, init)

        const headers = requestHeaders(input, init)
        const sessionID = headers.get(INTERNAL_SESSION_HEADER)
        if (!sessionID) return originalFetch.call(this, input, init)

        // Routing state for this client only; it must not reach the gateway.
        headers.delete(INTERNAL_SESSION_HEADER)
        const response = await originalFetch.call(this, input, { ...init, headers })
        observe(sessionID, statusFromHeaders(headerBag(response.headers)))
        return response
      }

      Object.defineProperty(wrappedFetch, WRAPPED_FETCH, { value: true })
      options.fetch = wrappedFetch
    },

    "chat.headers"(input, output) {
      if (input.model.providerID !== PROVIDER) return
      output.headers[INTERNAL_SESSION_HEADER] = input.sessionID
    },

    flush,
  }
}

export default {
  id: "kiconnect-status-server",
  server: async ({ client }) => createKiconnectStatusHooks(client),
}
