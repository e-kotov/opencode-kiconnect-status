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

import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import type { TuiPluginApi, TuiPluginModule, TuiSlotProps } from "@opencode-ai/plugin/tui"
import { isActive, normaliseNarrow, normalisePlacement, renderKiStatus, resolveWidth, restoreStatus, sidebarLines, tokensPerSecond, usesSidebar } from "./logic.mjs"

type KiconnectStatusProps = Pick<TuiSlotProps<"session_prompt_right">, "session_id">

/** Where the runtime overrides live, so they survive a restart. */
const NARROW_KEY = "kiconnect-status.narrow"
const PLACEMENT_KEY = "kiconnect-status.placement"

const plugin: TuiPluginModule = {
  id: "kiconnect-status-tui",
  tui: async (api: TuiPluginApi, options) => {
    // Three layers, narrowest scope first: a value set at runtime by the
    // command below wins, else the `tui.json` plugin options written by
    // install.sh, else the built-in default.
    const settings = (options ?? {}) as { narrow?: unknown; placement?: unknown }
    const configured = { narrow: settings.narrow, placement: settings.placement }
    const stored = (key: string) => {
      try {
        return api.kv.get(key)
      } catch {
        return undefined
      }
    }
    const remember = (key: string, value: string) => {
      try {
        api.kv.set(key, value)
      } catch {
        // Not persisting is survivable; not redrawing is not.
      }
    }
    const [narrow, setNarrow] = createSignal(normaliseNarrow(stored(NARROW_KEY), configured.narrow))
    const [placement, setPlacement] = createSignal(
      normalisePlacement(stored(PLACEMENT_KEY), configured.placement),
    )

    try {
      api.keymap.registerLayer({
        commands: [
          {
            name: "kiconnect_status_narrow",
            title: "KI:connect widget: toggle narrow-terminal behaviour",
            category: "Plugin",
            namespace: "palette",
            slashName: "ki-status-narrow",
            run() {
              const next = narrow() === "always" ? "hide" : "always"
              setNarrow(next)
              remember(NARROW_KEY, next)
              api.ui.toast({
                message: `KI:connect widget on narrow terminals: ${next === "always" ? "always show" : "hide"}`,
              })
            },
          },
          {
            name: "kiconnect_status_placement",
            title: "KI:connect widget: cycle where it draws",
            category: "Plugin",
            namespace: "palette",
            slashName: "ki-status-placement",
            run() {
              // Three modes, so a cycle rather than a toggle, running from the
              // least opinionated to the most.
              const order = ["auto", "prompt", "sidebar"]
              const next = order[(order.indexOf(placement()) + 1) % order.length]
              setPlacement(next)
              remember(PLACEMENT_KEY, next)
              api.ui.toast({ message: `KI:connect widget draws: ${next}` })
            },
          },
        ],
      })
    } catch {
      // A command API that moved must not cost us the widget itself.
    }

    // `api.renderer` is a plain CliRenderer, so reading `.width` off it is not
    // reactive and the widget would keep whatever width it saw at first render
    // — it would never move between slots on a resize. `useTerminalDimensions`
    // is the signal the host itself uses for this rule, so both agree.
    // It is a hook: it must be called inside a component, not out here.
    function useWidth() {
      let dimensions: (() => { width: number }) | undefined
      try {
        dimensions = useTerminalDimensions()
      } catch {
        // `useRenderer` throws without a renderer context. Fall back to a
        // non-reactive reading rather than taking the row down with us: the
        // widget then still draws, it just will not move on a resize.
        dimensions = undefined
      }
      const fallback = () => (api.renderer as { width?: unknown } | undefined)?.width
      return () => resolveWidth(dimensions ? dimensions().width : fallback(), process.stdout?.columns)
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
      const width = useWidth()
      const text = () => {
        try {
          if (usesSidebar(width(), api.state.session.get(props.session_id), placement())) return ""
          const current = active(props.session_id)
          if (!current) return ""
          return renderKiStatus(current.status, {
            width: width(),
            narrow: narrow(),
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
      const width = useWidth()
      const lines = () => {
        try {
          if (!usesSidebar(width(), api.state.session.get(props.session_id), placement())) return []
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
