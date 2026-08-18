import assert from "node:assert/strict"
import test from "node:test"

import { createKiconnectStatusHooks } from "../src/kiconnect-status-server.js"

const BASE_URL = "https://gateway.example/v1"
const INTERNAL_SESSION_HEADER = "x-opencode-kiconnect-session"

const GATEWAY_HEADERS = {
  "x-gateway-ratelimit-source": "local-shared",
  "x-ratelimit-limit-hour": "100",
  "x-ratelimit-remaining-hour": "87",
  "x-gateway-upstream-model": "gpt-5.6-terra-mitarbeitende",
  "x-gateway-upstream-model-source": "response.model",
}

/**
 * A session store with the semantics measured against a live OpenCode server:
 * `PATCH /session` replaces the whole metadata object rather than merging it.
 */
function fakeClient({ initial = { saiaLimits: { hour: "5" } }, onPatch } = {}) {
  const patches = []
  const state = { metadata: { ...initial } }
  return {
    patches,
    state,
    client: {
      _client: {
        get: async () => ({ data: { metadata: { ...state.metadata } } }),
        patch: async (args) => {
          patches.push(args)
          state.metadata = { ...args.body.metadata }
          await onPatch?.(state, patches.length)
        },
      },
    },
  }
}

/** Tests drive the timing themselves; the delays are for the live race only. */
const NO_DELAYS = { writeDelayMs: 0, verifyDelayMs: 0 }

/**
 * A config whose provider fetch records what it was called with and replies
 * with the next set of headers in the queue (repeating the last one).
 */
function fakeConfig(...responses) {
  const queue = responses.length ? responses : [GATEWAY_HEADERS]
  const seen = []
  return {
    seen,
    config: {
      provider: {
        kiconnect: {
          options: {
            baseURL: BASE_URL,
            fetch: async (input, init) => {
              seen.push({ input, init })
              const headers = queue[Math.min(seen.length - 1, queue.length - 1)]
              return new Response("{}", { headers })
            },
          },
        },
      },
    },
  }
}

async function call(options, { sessionID = "ses_1", url = `${BASE_URL}/chat/completions` } = {}) {
  return options.fetch(url, {
    headers: sessionID ? { [INTERNAL_SESSION_HEADER]: sessionID } : {},
  })
}

test("publishes model and quota to session metadata, preserving other keys", async () => {
  const { client, patches } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await hooks.flush()

  assert.equal(patches.length, 1)
  assert.equal(patches[0].path.sessionID, "ses_1")
  const metadata = patches[0].body.metadata
  assert.equal(metadata.saiaLimits.hour, "5", "another plugin's key must survive")
  assert.equal(metadata.kiStatus.actualModel, "gpt-5.6-terra-mitarbeitende")
  assert.equal(metadata.kiStatus.remaining, 87)
  assert.equal(metadata.kiStatus.limit, 100)
})

test("strips the routing header before the request leaves the client", async () => {
  const { client } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config, seen } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await hooks.flush()

  const sent = new Headers(seen[0].init.headers)
  assert.equal(sent.get(INTERNAL_SESSION_HEADER), null)
})

test("writes only when the status actually changes", async () => {
  const { client, patches } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig()

  hooks.config(config)
  for (let i = 0; i < 3; i += 1) await call(config.provider.kiconnect.options)
  await hooks.flush()
  assert.equal(patches.length, 1, "three identical responses, one write")
})

test("keeps a verified model across a response that omits it", async () => {
  const { client, patches } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  // Second response: the quota moved and the model header is absent.
  const { config } = fakeConfig(GATEWAY_HEADERS, {
    "x-gateway-ratelimit-source": "local-shared",
    "x-ratelimit-limit-hour": "100",
    "x-ratelimit-remaining-hour": "86",
  })

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await call(config.provider.kiconnect.options)
  await hooks.flush()

  assert.equal(patches.length, 1, "the two responses of one turn coalesce into a single write")
  const latest = patches.at(-1).body.metadata.kiStatus
  assert.equal(latest.remaining, 86)
  assert.equal(latest.actualModel, "gpt-5.6-terra-mitarbeitende", "the verified model must not be blanked")
})

test("writes nothing when the response carries no gateway evidence", async () => {
  const { client, patches } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig({ "x-ratelimit-remaining-hour": "999" })

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await hooks.flush()
  assert.equal(patches.length, 0)
})

test("ignores requests to another origin or without a session header", async () => {
  const { client, patches } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options, { url: "https://elsewhere.example/v1/chat" })
  await call(config.provider.kiconnect.options, { sessionID: "" })
  await hooks.flush()
  assert.equal(patches.length, 0)
})

test("chains onto an existing wrapper instead of replacing it, and never double-wraps", async () => {
  const { client } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config, seen } = fakeConfig()

  // Stand in for upstream-model-server.js, which wraps the same options.fetch.
  const inner = config.provider.kiconnect.options.fetch
  let outerCalls = 0
  config.provider.kiconnect.options.fetch = async (input, init) => {
    outerCalls += 1
    return inner(input, init)
  }

  hooks.config(config)
  const wrapped = config.provider.kiconnect.options.fetch
  hooks.config(config)
  assert.equal(config.provider.kiconnect.options.fetch, wrapped, "a second pass must not re-wrap")

  await call(config.provider.kiconnect.options)
  await hooks.flush()
  assert.equal(outerCalls, 1, "the previously installed fetch still runs")
  assert.equal(seen.length, 1)
})

test("tags only kiconnect requests with the session header", () => {
  const { client } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)

  const kiconnect = { headers: {} }
  hooks["chat.headers"]({ model: { providerID: "kiconnect" }, sessionID: "ses_9" }, kiconnect)
  assert.equal(kiconnect.headers[INTERNAL_SESSION_HEADER], "ses_9")

  const saia = { headers: {} }
  hooks["chat.headers"]({ model: { providerID: "saia" }, sessionID: "ses_9" }, saia)
  assert.deepEqual(saia.headers, {})
})

test("does nothing when the provider is not configured", () => {
  const { client } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  assert.doesNotThrow(() => hooks.config({}))
  assert.doesNotThrow(() => hooks.config({ provider: { saia: { options: { baseURL: BASE_URL } } } }))
})

test("reports a failed metadata write instead of throwing", async () => {
  const warnings = []
  const client = {
    _client: {
      get: async () => ({ data: { metadata: {} } }),
      patch: async () => {
        throw new Error("session gone")
      },
    },
  }
  const hooks = createKiconnectStatusHooks(client, { ...NO_DELAYS, onWarning: (message) => warnings.push(message) })
  const { config } = fakeConfig()

  hooks.config(config)
  const response = await call(config.provider.kiconnect.options)
  await hooks.flush()

  assert.equal(response.status, 200, "the model response is returned regardless")
  assert.match(warnings[0], /session gone/)
})

test("defers the write, then forces it out on flush", async () => {
  const { client, patches } = fakeClient()
  const hooks = createKiconnectStatusHooks(client, { writeDelayMs: 60_000, verifyDelayMs: 0 })
  const { config } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  assert.equal(patches.length, 0, "nothing is written while the sibling writer settles")

  await hooks.flush()
  assert.equal(patches.length, 1)
})

test("recovers when another writer clobbers the metadata after the patch", async () => {
  // Reproduces the live failure: `upstream-model-server` reads before this
  // write and patches after it, dropping `kiStatus`.
  const { client, patches, state } = fakeClient({
    initial: {},
    onPatch: async (store, count) => {
      if (count === 1) store.metadata = { upstreamModel: { model: "gpt-5-mini-Mitarbeitende" } }
    },
  })
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await hooks.flush()

  assert.equal(patches.length, 2, "the lost write is noticed and repeated")
  assert.equal(state.metadata.kiStatus.actualModel, "gpt-5.6-terra-mitarbeitende")
  assert.equal(state.metadata.upstreamModel.model, "gpt-5-mini-Mitarbeitende", "the other writer's key is carried along")
})

test("stops after the retry budget rather than looping forever", async () => {
  // A writer that clobbers every time must not spin this one indefinitely.
  const { client, patches } = fakeClient({
    initial: {},
    onPatch: async (store) => {
      store.metadata = { upstreamModel: { model: "x" } }
    },
  })
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await hooks.flush()

  assert.equal(patches.length, 3)
})

test("skips the write when the status is already stored", async () => {
  const { client, patches } = fakeClient({ initial: {} })
  const hooks = createKiconnectStatusHooks(client, NO_DELAYS)
  const { config } = fakeConfig()

  hooks.config(config)
  await call(config.provider.kiconnect.options)
  await hooks.flush()
  assert.equal(patches.length, 1)

  // A second, identical turn in the same process: nothing changed, nothing written.
  await call(config.provider.kiconnect.options)
  await hooks.flush()
  assert.equal(patches.length, 1)
})
