import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("..", import.meta.url))
const SOURCES = ["kiconnect-status-server.js", "kiconnect-status-tui.tsx"]

test("both sources import the specifier install.sh knows how to rewrite", () => {
  // install.sh rewrites this exact string. A rename here without one there
  // would break only when the plugin is loaded, so pin it.
  for (const source of SOURCES) {
    assert.match(readFileSync(join(repo, "src", source), "utf8"), /from "\.\/logic\.mjs"/, source)
  }
})

test("install.sh splits the server into plugins/ and the widget into lib/", () => {
  const dest = mkdtempSync(join(tmpdir(), "opencode-kiconnect-status-"))
  try {
    execFileSync(join(repo, "install.sh"), ["--dest", dest], { stdio: "pipe" })

    // Server half stays in plugins/, so it reaches the helper via ../lib/.
    const server = readFileSync(join(dest, "plugins/kiconnect-status-server.js"), "utf8")
    assert.match(server, /from "\.\.\/lib\/kiconnect-status-logic\.mjs"/)
    assert.doesNotMatch(server, /from "\.\/logic\.mjs"/)

    // Widget half sits beside the helper, so the import is a plain ./ hop.
    const widget = readFileSync(join(dest, "lib/kiconnect-status-tui.tsx"), "utf8")
    assert.match(widget, /from "\.\/kiconnect-status-logic\.mjs"/)
    assert.doesNotMatch(widget, /from "\.\/logic\.mjs"/)

    const shim = readFileSync(join(dest, "plugins/kiconnect-status-tui.ts"), "utf8")
    assert.match(shim, /export \{ default \} from "\.\.\/lib\/kiconnect-status-tui\.tsx"/)

    assert.match(readFileSync(join(dest, "lib/kiconnect-status-logic.mjs"), "utf8"), /export function statusFromHeaders/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test("everything installed into plugins/ is discoverable by OpenCode's glob", () => {
  // OpenCode scans `{plugin,plugins}/*.{ts,js}`. A `.tsx` entrypoint there is
  // never loaded and never logs an error — it just silently renders nothing.
  // That is exactly why the server half worked while the widget stayed blank.
  // The helper must also not be here: every match is loaded as a plugin.
  const dest = mkdtempSync(join(tmpdir(), "opencode-kiconnect-status-glob-"))
  try {
    execFileSync(join(repo, "install.sh"), ["--dest", dest], { stdio: "pipe" })

    const installed = readdirSync(join(dest, "plugins")).sort()
    assert.deepEqual(installed, ["kiconnect-status-server.js", "kiconnect-status-tui.ts"])
    for (const name of installed) assert.match(name, /\.(ts|js)$/, name)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test("install.sh rejects an unknown argument", () => {
  assert.throws(() => execFileSync(join(repo, "install.sh"), ["--nonsense"], { stdio: "pipe" }))
})
