import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("..", import.meta.url))
const ENTRYPOINTS = ["kiconnect-status-server.js", "kiconnect-status-tui.tsx"]
const install = (dest) => execFileSync(join(repo, "install.sh"), ["--dest", dest], { stdio: "pipe" })
const tui = (dest) => JSON.parse(readFileSync(join(dest, "tui.json"), "utf8"))

function withDest(name, fn) {
  const dest = mkdtempSync(join(tmpdir(), `opencode-kiconnect-status-${name}-`))
  try {
    return fn(dest)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}

test("both entrypoints import the specifier install.sh knows how to rewrite", () => {
  // install.sh rewrites this exact string. A rename here without one there
  // would break only when the plugin is loaded, so pin it.
  for (const entrypoint of ENTRYPOINTS) {
    assert.match(readFileSync(join(repo, "src", entrypoint), "utf8"), /from "\.\/logic\.mjs"/, entrypoint)
  }
})

test("install.sh lands the helper in lib/ and only entrypoints in plugins/", () => {
  withDest("layout", (dest) => {
    install(dest)

    for (const entrypoint of ENTRYPOINTS) {
      const installed = readFileSync(join(dest, "plugins", entrypoint), "utf8")
      assert.match(installed, /from "\.\.\/lib\/kiconnect-status-logic\.mjs"/, entrypoint)
      assert.doesNotMatch(installed, /from "\.\/logic\.mjs"/, entrypoint)
    }

    // Anything in plugins/ matching *.{ts,js} is auto-loaded as a server
    // plugin, so the helper must not be there.
    assert.deepEqual(readdirSync(join(dest, "plugins")).sort(), [...ENTRYPOINTS].sort())
    assert.match(readFileSync(join(dest, "lib/kiconnect-status-logic.mjs"), "utf8"), /export function statusFromHeaders/)
  })
})

test("install.sh registers the widget — and only the widget — in tui.json", () => {
  // The server half is auto-discovered from plugins/; the widget is not
  // discovered at all and must be listed here. Getting only the first half
  // right is why kiStatus reached session metadata while nothing rendered.
  withDest("register", (dest) => {
    install(dest)
    assert.deepEqual(tui(dest).plugin, ["./plugins/kiconnect-status-tui.tsx"])
    assert.equal(tui(dest).$schema, "https://opencode.ai/tui.json")
  })
})

test("install.sh keeps existing tui.json settings and other plugins", () => {
  withDest("merge", (dest) => {
    writeFileSync(
      join(dest, "tui.json"),
      JSON.stringify({ theme: "opencode", plugin: ["./plugins/saia-limits-tui.tsx"] }),
    )
    install(dest)

    const config = tui(dest)
    assert.equal(config.theme, "opencode")
    assert.deepEqual(config.plugin, ["./plugins/saia-limits-tui.tsx", "./plugins/kiconnect-status-tui.tsx"])
  })
})

test("install.sh is idempotent — a second run does not duplicate the entry", () => {
  withDest("idempotent", (dest) => {
    install(dest)
    install(dest)
    assert.deepEqual(tui(dest).plugin, ["./plugins/kiconnect-status-tui.tsx"])
  })
})

test("install.sh rejects an unknown argument", () => {
  assert.throws(() => execFileSync(join(repo, "install.sh"), ["--nonsense"], { stdio: "pipe" }))
})
