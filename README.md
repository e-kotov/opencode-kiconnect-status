# opencode-kiconnect-status

An OpenCode widget for the prompt row: the model that the KI:connect gateway
says *actually* answered, and the hourly quota left on it.

```
KI: gpt-5.6-terra-mitarbeitende · 87/100/h · 82 T/s
```

Ported from the `prime-agent-kiconnect` extension, which had no OpenCode
equivalent.

## Two halves

| File | Installed as | Job |
|---|---|---|
| `src/kiconnect-status-server.js` | `plugins/` | wraps the provider `fetch`, parses the response headers, writes `metadata.kiStatus` on the session |
| `src/kiconnect-status-tui.tsx` | `plugins/` | reads that metadata and renders one line |
| `src/logic.mjs` | `lib/` | all parsing, trust rules, and formatting; pure, no I/O |

A server half is unavoidable: the evidence lives only in response headers, which
nothing but a `fetch` wrapper can see.

```
x-ratelimit-limit-hour: 1000        x-gateway-upstream-model: gpt-5-mini-Mitarbeitende
x-ratelimit-remaining-hour: 988     x-gateway-upstream-model-source: response.model
x-gateway-ratelimit-source: local-shared
```

## Trust rules

These are the point of the widget, and the tests assert each of them.

**Never fall back to the configured alias.** With no verified upstream model the
widget prints the literal `KI:connect` — never `GPT5-Mitarbeitende`. That name
is a routing slot: it is what we *asked* for, and it stays stable by design even
when the model behind it is swapped.

**Quota counts only when the gateway labels it.** All three quota fields are
discarded unless `x-gateway-ratelimit-source: local-shared` is present. Without
that label the numbers could come from anywhere, and a widget that can be
painted by an arbitrary upstream is worse than no widget.

**A model header counts only with matching provenance.** The same rule
`upstream-model-server.js` applies: `x-gateway-upstream-model` is accepted only
when `x-gateway-upstream-model-source` is `response.model` or
`provider-metadata`. An unaccompanied header, or one sourced from the provider
echoing back the name we sent, is not independent evidence. The value is also
bounded and newline-rejected, so a hostile upstream cannot inject into the
terminal.

**Stale beats blank.** `mergeStatus` keeps the last known value for a field that
one response omits, so a verified model does not disappear on the next turn.

Generation speed is computed in the TUI from message timings, not from a
server-side timer, so it cannot bleed between sessions.

## Narrow terminals

`session_prompt_right` is one strip shared with the other prompt widgets. Four
tiers are rendered and the widest that fits the budget wins:

```
T3  KI: gpt-5.6-terra-mitarbeitende · 87/100/h · 82 T/s
T2  KI: gpt-5.6-terra-mitarbeitende · 87/100/h
T1  KI: terra · 87/100/h
T0  87/100/h
```

T1 reduces the route name to its distinctive part, dropping generic (`gpt`,
`5.6`) and audience (`mitarbeitende`) components. If every part is generic the
first one wins, so `GPT5-Mitarbeitende` shortens to `GPT5` rather than to
`Mitarbeitende`.

Width comes from `api.renderer.width`, then `process.stdout.columns`, then 120;
the budget is what is left after 12 columns for the prompt, divided between two
widgets. As a backstop the widget renders inside
`<box flexShrink={1} overflow="hidden">` with `truncate`, so a mis-measured
width clips instead of reflowing. If nothing fits, it renders nothing.

Registered at `order: 130`, last in the strip.

## Coexisting with the other plugins

`upstream-model-server.js` is left alone. It writes a different key
(`upstreamModel`), its TUI half is unregistered, and the two `fetch` wrappers
chain safely: each holds its own `Symbol.for()` guard against double-wrapping
and calls the `originalFetch` it captured. `saia-limits-server.js` only ever
touches the `saia` provider. Nothing renders twice.

### The metadata write is the sharp edge

`PATCH /session` **replaces** the whole metadata object — measured against a
live server, not assumed. Every writer therefore has to read, merge, and write
back, and two writers handling the same response will drop each other's keys.

This plugin loads before `upstream-model-server`, so it ends up wrapping *that*
wrapper, which means its response handler runs last and its write lands last.
An unguarded version of this file deleted `upstreamModel` on every single
KI:connect session — three out of three, until it was fixed.

Two measures keep both keys:

- **The write is deferred** by 400 ms, so the sibling's prompt read-modify-write
  has already landed by the time this one reads. The delay also coalesces the
  several responses of a multi-step turn into one write.
- **The write is verified**: after the PATCH it re-reads, and if `kiStatus` did
  not survive it retries against the fresh metadata, up to three attempts. That
  converges whichever writer wins the race.

`flush` cancels any pending deferral and forces the write out, so a headless
`opencode run` still records the status before the process exits.

The quota reset interval is captured into `kiStatus.resetSeconds` and formatted
by `formatSeconds`, but is not rendered: the strip has room for one line.

## Install

```sh
./install.sh                  # ~/.config/opencode
./install.sh --dest /some/dir
```

It **copies**:

```
<dest>/lib/kiconnect-status-logic.mjs      helper module
<dest>/plugins/kiconnect-status-server.js  server entrypoint
<dest>/plugins/kiconnect-status-tui.tsx    TUI entrypoint
```

The helper must not live in `plugins/`: OpenCode auto-discovers *every immediate
file* there and loads it as a plugin, so a bare module fails with `Plugin export
is not a function`. `install.sh` therefore rewrites each entrypoint's
`./logic.mjs` import to `../lib/kiconnect-status-logic.mjs`, and fails loudly if
that rewrite does not take.

Copies, not symlinks, because the same checkout is `scp`'d to a remote host and
installed there. Editing the repo means re-running `install.sh`.

Restart OpenCode afterwards.

## Test

```sh
node --test 'test/**/*.test.mjs'
```

No build step, no bundler, no runtime dependencies.

## Licence

MIT.
