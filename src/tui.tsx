import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { KanbanRpc, type KanbanAgentView, type KanbanSnapshot, type KanbanTaskView } from "./rpc.ts"

/**
 * opencode-kanban-manager — TUI entrypoint.
 *
 * Adds a "Kanban · Subagents" session panel that mirrors the native OpenCode
 * subagent picker: ↑/↓ moves, ←/→ toggles the active/inactive filter, Enter
 * opens the selected session, `r` refreshes, Esc closes. Data comes from the
 * server plugin over RPC, so the panel is kanban-aware (task -> subagents).
 */

type PluginCtx = ReturnType<typeof usePlugin>
type Theme = PluginCtx["theme"]

/** Structural copy of the host `session.panel` input (not exported publicly). */
interface PanelInput {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation: "panel" | "fullscreen"
  readonly focused: boolean
  readonly focus: () => void
  readonly close: () => void
  readonly toggleFullscreen: () => void
}

type Row =
  | { readonly kind: "task"; readonly task: KanbanTaskView }
  | { readonly kind: "agent"; readonly task: KanbanTaskView; readonly agent: KanbanAgentView }

const PANEL_NAME = "kanban.agents"

function isActive(a: KanbanAgentView): boolean {
  return a.status === "running"
}

function agentIcon(status: KanbanAgentView["status"]): string {
  switch (status) {
    case "running":
      return "▶"
    case "done":
      return "✓"
    case "failed":
      return "✗"
    default:
      return "◻"
  }
}

function agentColor(status: KanbanAgentView["status"], theme: Theme) {
  switch (status) {
    case "running":
      return theme.text.feedback.info.base
    case "done":
      return theme.text.feedback.success.base
    case "failed":
      return theme.text.feedback.error.base
    default:
      return theme.text.muted
  }
}

function KanbanAgentsPanel(props: { input: PanelInput }) {
  const ctx = usePlugin()
  const theme = ctx.theme

  const [snapshot, setSnapshot] = createSignal<KanbanSnapshot | undefined>(undefined)
  const [error, setError] = createSignal<string | undefined>(undefined)
  const [showInactive, setShowInactive] = createSignal(true)
  const [cursor, setCursor] = createSignal(0)

  let timer: ReturnType<typeof setTimeout> | undefined

  async function refresh(): Promise<void> {
    try {
      const result = (await ctx.client.rpc(KanbanRpc).snapshot({})) as KanbanSnapshot
      setSnapshot(result)
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void refresh(), 120)
  }

  onMount(() => {
    void refresh()
    const off = ctx.data.listen(() => schedule())
    onCleanup(() => {
      off()
      if (timer) clearTimeout(timer)
    })
  })

  const rows = createMemo<Row[]>(() => {
    const snap = snapshot()
    if (!snap) return []
    const out: Row[] = []
    for (const task of snap.tasks) {
      out.push({ kind: "task", task })
      const agents = task.agents ?? []
      const visible = showInactive() ? agents : agents.filter(isActive)
      for (const agent of visible) out.push({ kind: "agent", task, agent })
    }
    return out
  })

  const clamped = createMemo(() => {
    const len = rows().length
    if (len === 0) return 0
    return Math.max(0, Math.min(cursor(), len - 1))
  })

  function move(delta: number): void {
    const len = rows().length
    if (len === 0) return
    setCursor((c) => (c + delta + len) % len)
  }

  function activate(): void {
    const row = rows()[clamped()]
    if (!row) return
    const sessionID = row.kind === "task" ? row.task.sessionID : row.agent.id
    if (!sessionID) return
    ctx.ui.router.navigate({ type: "session", sessionID })
    props.input.close()
  }

  ctx.keymap.layer(() => ({
    enabled: () => props.input.focused,
    commands: [
      { id: "kanban.agents.down", title: "Next row", bind: "down", run: () => move(1) },
      { id: "kanban.agents.up", title: "Previous row", bind: "up", run: () => move(-1) },
      { id: "kanban.agents.active", title: "Show active only", bind: "left", run: () => setShowInactive(false) },
      { id: "kanban.agents.all", title: "Show active + inactive", bind: "right", run: () => setShowInactive(true) },
      { id: "kanban.agents.open", title: "Open session", bind: "return", run: () => activate() },
      { id: "kanban.agents.refresh", title: "Refresh", bind: "r", run: () => void refresh() },
      { id: "kanban.agents.close", title: "Close panel", bind: "escape", run: () => props.input.close() },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row">
        <text fg={theme.text.action.primary.base}>
          <b>Kanban · Subagents</b>
        </text>
        <box flexGrow={1} />
        <text fg={theme.text.muted}>{showInactive() ? "all agents" : "active only"}</text>
      </box>

      <Show when={error()}>
        <text fg={theme.text.feedback.error.base}>RPC error: {error()}</text>
      </Show>

      <Show when={!error() && rows().length === 0}>
        <text fg={theme.text.muted}>
          No subagents yet. Activity appears here as subagents run for a task.
        </text>
      </Show>

      <scrollbox flexGrow={1} marginTop={1}>
        <For each={rows()}>
          {(row, index) => {
            const selected = () => index() === clamped()
            if (row.kind === "task") {
              return (
                <box flexDirection="row" backgroundColor={selected() ? theme.background.raised.high : undefined}>
                  <text fg={selected() ? theme.text.action.primary.base : theme.text.muted}>
                    {selected() ? "▸" : " "}{" "}
                  </text>
                  <text fg={theme.text.base}>{row.task.id}</text>
                  <text fg={theme.text.muted}>
                    {" "}
                    [{row.task.lifecycle} / {row.task.stack}]{" "}
                  </text>
                  <text fg={theme.text.action.secondary.base}>{row.task.status}</text>
                  <text fg={theme.text.base}> {row.task.title}</text>
                </box>
              )
            }
            return (
              <box flexDirection="row" backgroundColor={selected() ? theme.background.raised.high : undefined}>
                <text fg={selected() ? theme.text.action.primary.base : theme.text.muted}>
                  {selected() ? "▸" : " "} ↳{" "}
                </text>
                <text fg={agentColor(row.agent.status, theme)}>{agentIcon(row.agent.status)} </text>
                <text fg={theme.text.base}>{row.agent.agent ?? row.agent.title ?? row.agent.id}</text>
                <Show when={row.agent.agent && row.agent.title}>
                  <text fg={theme.text.muted}> — {row.agent.title}</text>
                </Show>
                <text fg={theme.text.muted}>
                  {" "}
                  · {row.agent.status} · {row.agent.tools} tools
                </text>
                <Show when={row.agent.lastTool}>
                  <text fg={theme.text.muted}> · last: {row.agent.lastTool}</text>
                </Show>
              </box>
            )
          }}
        </For>
      </scrollbox>

      <box flexDirection="row" marginTop={1}>
        <text fg={theme.text.muted}>↑/↓ select · ←/→ filter · Enter open · r refresh · esc close</text>
      </box>
    </box>
  )
}

export default Plugin.define({
  id: "kanban-manager-tui",
  setup(context) {
    const disposers: Array<() => void> = []

    // Render the panel only when the host selected our panel name.
    disposers.push(
      context.ui.slot({
        append: "session.panel",
        render: (input) => (input.name === PANEL_NAME ? <KanbanAgentsPanel input={input} /> : null),
      }),
    )

    // Palette + slash entrypoint that opens the panel for the current session.
    context.keymap.layer(() => ({
      commands: [
        {
          id: "kanban.open_agents",
          title: "Kanban: Subagents",
          group: "Kanban",
          palette: true,
          slash: { name: "kanban-agents" },
          run: () => {
            const opened = context.ui.panel.open(PANEL_NAME, { presentation: "panel" })
            if (!opened) {
              context.ui.toast.show({
                title: "Kanban",
                message: "Open a session before opening the subagent board.",
                variant: "warning",
              })
            }
          },
        },
      ],
    }))

    return () => {
      for (const dispose of disposers) dispose()
    }
  },
})
