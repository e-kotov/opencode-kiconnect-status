/** @jsxImportSource @opentui/solid */

// The KI:connect gateway's verified model and hourly quota.
//
//     KI: gpt-5.6-terra-mitarbeitende · 87/100/h · 82 T/s
//
// The server half (`kiconnect-status-server.js`) reads the gateway's headers and
// stores them on the session as `metadata.kiStatus`; this only displays them.
// Generation speed is computed here from message timings rather than from a
// server-side timer, so it is inherently per session.
//
// Displayed only while KI:connect is the provider that answered last. A session
// that moves to SAIA must not keep showing KI:connect's model and quota; the
// stored metadata is left untouched, so switching back restores the display
// without a new request.
//
// Two slots are registered and exactly one of them draws: the block goes in the
// sidebar when the host would show it, and in the prompt row otherwise. See
// `usesSidebar` for the rule and its one known limitation.

import { For, Show } from "solid-js"
import type { TuiPluginApi, TuiPluginModule, TuiSlotProps } from "@opencode-ai/plugin/tui"
import { isActive, renderKiStatus, resolveWidth, restoreStatus, sidebarLines, tokensPerSecond, usesSidebar } from "./logic.mjs"

type KiconnectStatusProps = Pick<TuiSlotProps<"session_prompt_right">, "session_id">

const plugin: TuiPluginModule = {
  id: "kiconnect-status-tui",
  tui: async (api: TuiPluginApi) => {
    const terminalWidth = () =>
      resolveWidth((api.renderer as { width?: unknown } | undefined)?.width, process.stdout?.columns)

    // Which slot owns the display for this session, at this width.
    const sidebarOwns = (session_id: string) => {
      try {
        return usesSidebar(terminalWidth(), api.state.session.get(session_id))
      } catch {
        return false
      }
    }

    // The status to draw, or undefined when this widget must stay silent.
    const active = (session_id: string) => {
      const messages = api.state.session.messages(session_id)
      if (!isActive(messages)) return undefined
      const status = restoreStatus(api.state.session.get(session_id)?.metadata?.kiStatus)
      if (!status) return undefined
      return { status, tokensPerSecond: tokensPerSecond(messages) }
    }

    function KiconnectStatusPrompt(props: KiconnectStatusProps) {
      const text = () => {
        try {
          if (sidebarOwns(props.session_id)) return ""
          const current = active(props.session_id)
          if (!current) return ""
          return renderKiStatus(current.status, {
            width: terminalWidth(),
            tokensPerSecond: current.tokensPerSecond,
          })
        } catch {
          // A widget must never take the prompt row down with it.
          return ""
        }
      }

      // Belt and braces: the tier already fits the measured width, and this
      // clips rather than reflows if that measurement was wrong.
      return (
        <box height={1} minWidth={0} flexShrink={1} overflow="hidden">
          <text height={1} wrapMode="none" truncate fg={api.theme.current.textMuted}>
            {text()}
          </text>
        </box>
      )
    }

    function KiconnectStatusSidebar(props: KiconnectStatusProps) {
      const lines = () => {
        try {
          if (!sidebarOwns(props.session_id)) return []
          const current = active(props.session_id)
          if (!current) return []
          return sidebarLines(current.status, { tokensPerSecond: current.tokensPerSecond }) as string[]
        } catch {
          return []
        }
      }

      // `Show` rather than an empty box: a zero-height child would still take a
      // gap row from the sidebar's stack.
      return (
        <Show when={lines().length > 0}>
          <box flexDirection="column" flexShrink={0}>
            <text height={1} wrapMode="none" truncate fg={api.theme.current.text}>
              <b>{lines()[0]}</b>
            </text>
            <For each={lines().slice(1)}>
              {(line) => (
                <text height={1} wrapMode="none" truncate fg={api.theme.current.textMuted}>
                  {line}
                </text>
              )}
            </For>
          </box>
        </Show>
      )
    }

    api.slots.register({
      // Last in the strip: after saia-limits (100) and cache-hit (120). The
      // same order governs the sidebar stack.
      order: 130,
      slots: {
        session_prompt_right(_context, props) {
          return <KiconnectStatusPrompt session_id={props.session_id} />
        },
        sidebar_content(_context, props) {
          return <KiconnectStatusSidebar session_id={props.session_id} />
        },
      },
    })
  },
}

export default plugin

// Installed plugin files can be evaluated as CommonJS outside this repository's
// package boundary; keep the default export usable either way.
if (typeof module !== "undefined") {
  module.exports = plugin
  module.exports.default = plugin
}
