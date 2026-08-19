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
//
// Writing the metadata is the part that needs care. `PATCH /session` *replaces*
// the whole metadata object — measured, not assumed — so every writer has to
// read, merge, and write back, and two writers racing on the same response will
// drop each other's keys. This one wraps the other, so its response handler runs
// last and its unguarded write reliably clobbered `upstreamModel`.
//
// Two things prevent that here. The write is deferred briefly, so the sibling's
// prompt read-modify-write has finished before this one reads; and it is then
// verified, re-reading after the PATCH and retrying against the fresh metadata
// if the key did not survive. The deferral also coalesces the several responses
// of a multi-step turn into one write.

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

/** Milliseconds to wait before reading, so a sibling writer has settled. */
const WRITE_DELAY_MS = 400
/** Milliseconds to wait before re-reading to confirm the write survived. */
const VERIFY_DELAY_MS = 250
const MAX_ATTEMPTS = 3

const sleep = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve())

function transportOf(client) {
  const transport = client?._client
  if (!transport || typeof transport.get !== "function" || typeof transport.patch !== "function") {
    throw new Error("OpenCode's HTTP client is unavailable")
  }
  return transport
}

async function readMetadata(transport, sessionID) {
  // OpenCode supports session metadata, but its generated SDK wrapper omits the
  // field; use the configured transport directly so its directory and
  // authentication context are retained.
  const current = unwrap(await transport.get({ url: "/session/{sessionID}", path: { sessionID } }))
  return current?.metadata && typeof current.metadata === "object" && !Array.isArray(current.metadata)
    ? current.metadata
    : {}
}

function subagentNameOf(session) {
  if (!session?.parentID) return undefined
  if (typeof session.agent === "string" && session.agent.trim()) {
    return session.agent.trim()
  }
  if (typeof session.title === "string") {
    const match = session.title.match(/@([\w-]+)\s+subagent/i)
    if (match) return match[1]
  }
  return "subagent"
}

async function saveStatus(client, sessionID, status, { verifyDelayMs = VERIFY_DELAY_MS } = {}) {
  const transport = transportOf(client)

  const session = unwrap(await transport.get({ url: "/session/{sessionID}", path: { sessionID } }))
  const isSubagent = Boolean(session?.parentID)
  const subagentName = subagentNameOf(session)
  const subagent = isSubagent ? subagentName || true : false

  const statusToSave = {
    ...status,
    subagent,
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const metadata = await readMetadata(transport, sessionID)
    // Already there — either this write or a later one won; nothing to do.
    if (statusKey(metadata[METADATA_KEY]) === statusKey(statusToSave)) break

    await transport.patch({
      url: "/session/{sessionID}",
      path: { sessionID },
      headers: { "Content-Type": "application/json" },
      body: { metadata: { ...metadata, [METADATA_KEY]: statusToSave } },
    })

    if (attempt === MAX_ATTEMPTS) break
    await sleep(verifyDelayMs)
    const after = await readMetadata(transport, sessionID)
    // Survived the window: done. Clobbered: go round again, this time merging
    // onto whatever the other writer left behind.
    if (statusKey(after[METADATA_KEY]) === statusKey(statusToSave)) break
  }

  // If this is a subagent session, also persist status to parent session
  if (isSubagent && session?.parentID) {
    try {
      const parentMetadata = await readMetadata(transport, session.parentID)
      const prevSubagents =
        parentMetadata.kiSubagents && typeof parentMetadata.kiSubagents === "object"
          ? parentMetadata.kiSubagents
          : {}

      const subagentModel = session?.model?.modelID || statusToSave.model || ""
      const updatedSubagents = {
        ...prevSubagents,
        [sessionID]: {
          id: sessionID,
          name: subagentName || "subagent",
          model: subagentModel,
          updated: Date.now(),
        },
      }

      await transport.patch({
        url: "/session/{sessionID}",
        path: { sessionID: session.parentID },
        headers: { "Content-Type": "application/json" },
        body: {
          metadata: {
            ...parentMetadata,
            kiSubagents: updatedSubagents,
            kiSubagentStatus: statusToSave,
            [METADATA_KEY]: statusToSave,
          },
        },
      })
    } catch {
      // Non-fatal if parent update fails
    }
  }
}

export function createKiconnectStatusHooks(
  client,
  { onWarning = console.warn, writeDelayMs = WRITE_DELAY_MS, verifyDelayMs = VERIFY_DELAY_MS } = {},
) {
  const pendingWrites = new Map()
  const pendingTimers = new Map()
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
    scheduleSave(sessionID)
  }

  function scheduleSave(sessionID) {
    if (pendingTimers.has(sessionID)) return
    const timer = setTimeout(() => {
      pendingTimers.delete(sessionID)
      enqueueSave(sessionID)
    }, writeDelayMs)
    // Never hold the process open for a status widget; `flush` forces the write
    // out on shutdown.
    timer?.unref?.()
    pendingTimers.set(sessionID, timer)
  }

  function enqueueSave(sessionID) {
    const status = sessions.get(sessionID)
    if (!meaningfulStatus(status)) return

    const previous = pendingWrites.get(sessionID) ?? Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(() => saveStatus(client, sessionID, sessions.get(sessionID) ?? status, { verifyDelayMs }))
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
    // Deferred writes must still happen when the process is going away.
    for (const [sessionID, timer] of pendingTimers) {
      clearTimeout(timer)
      pendingTimers.delete(sessionID)
      enqueueSave(sessionID)
    }
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
