/** @jsxImportSource @opentui/solid */

// The KI:connect gateway's verified model and hourly quota, next to the prompt.
//
//     KI: gpt-5.6-terra-mitarbeitende · 87/100/h · 82 T/s
//
// The server half (`kiconnect-status-server.js`) reads the gateway's headers and
// stores them on the session as `metadata.kiStatus`; this only displays them.
// Generation speed is computed here from message timings rather than from a
// server-side timer, so it is inherently per session.

import type { TuiPluginApi, TuiPluginModule, TuiSlotProps } from "@opencode-ai/plugin/tui"
import { renderKiStatus, resolveWidth, restoreStatus, tokensPerSecond } from "./logic.mjs"

type KiconnectStatusProps = Pick<TuiSlotProps<"session_prompt_right">, "session_id">

const plugin: TuiPluginModule = {
  id: "kiconnect-status-tui",
  tui: async (api: TuiPluginApi) => {
    function KiconnectStatus(props: KiconnectStatusProps) {
      const text = () => {
        try {
          const status = restoreStatus(api.state.session.get(props.session_id)?.metadata?.kiStatus)
          if (!status) return ""
          const width = resolveWidth((api.renderer as { width?: unknown } | undefined)?.width, process.stdout?.columns)
          return renderKiStatus(status, {
            width,
            tokensPerSecond: tokensPerSecond(api.state.session.messages(props.session_id)),
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

    api.slots.register({
      // Last in the strip: after saia-limits (100) and cache-hit (120).
      order: 130,
      slots: {
        session_prompt_right(_context, props) {
          return <KiconnectStatus session_id={props.session_id} />
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
