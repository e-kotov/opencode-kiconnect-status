import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const repo = fileURLToPath(new URL("..", import.meta.url))
const ENTRYPOINTS = ["kiconnect-status-server.js", "kiconnect-status-tui.tsx"]

test("both entrypoints import the specifier install.sh knows how to rewrite", () => {
  // install.sh rewrites this exact string. A rename here without one there
  // would break only when the plugin is loaded, so pin it.
  for (const entrypoint of ENTRYPOINTS) {
    const source = readFileSync(join(repo, "src", entrypoint), "utf8")
    assert.match(source, /from "\.\/logic\.mjs"/, entrypoint)
  }
})

test("install.sh lands the helper in lib/ and only entrypoints in plugins/", () => {
  const dest = mkdtempSync(join(tmpdir(), "opencode-kiconnect-status-"))
  try {
    execFileSync(join(repo, "install.sh"), ["--dest", dest], { stdio: "pipe" })

    for (const entrypoint of ENTRYPOINTS) {
      const installed = readFileSync(join(dest, "plugins", entrypoint), "utf8")
      assert.match(installed, /from "\.\.\/lib\/kiconnect-status-logic\.mjs"/, entrypoint)
      assert.doesNotMatch(installed, /from "\.\/logic\.mjs"/, entrypoint)
    }

    // OpenCode loads every immediate file in plugins/ as a plugin, so the
    // helper must not be among them.
    assert.deepEqual(readdirSync(join(dest, "plugins")).sort(), [...ENTRYPOINTS].sort())
    assert.match(readFileSync(join(dest, "lib/kiconnect-status-logic.mjs"), "utf8"), /export function statusFromHeaders/)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})

test("install.sh rejects an unknown argument", () => {
  assert.throws(() => execFileSync(join(repo, "install.sh"), ["--nonsense"], { stdio: "pipe" }))
})
