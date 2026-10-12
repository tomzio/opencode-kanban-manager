# opencode-kanban-manager

A single **OpenCode V2** plugin that fuses two ideas that usually live apart:

1. **Engineering lifecycle classification** — `architecture` | `feature` | `bug-fix` | `testing` | `docs`
2. **Cross-stack routing** — `frontend` | `backend` | `database` | `full-stack`

Every request you send is captured on a persistent kanban board, classified on *both*
dimensions, and surfaced back to the master agent as a routing blueprint. The agent can
then dispatch the correct expert subagent automatically — and a symptom whose root cause
is unknown is classified as `bug-fix + full-stack` and flagged for the **Full-Stack
Detective** subagent.

The board lives only in the master context. All debugging detail stays inside subagent
sessions, so the orchestrator's context stays clean.

**v1.1.0 — subagent tracking.** The plugin subscribes to the server event stream,
detects child ("subagent") sessions through their `parentID`, and attaches a live run
record to the owning card: agent id, title, status (`running` / `idle` / `done` /
`failed`), tool-call count, and the last tool used. So the board answers *"which
subagents ran for this task, and how did they go?"* — not just *"what is the task?"*.

**v1.2.0 — TUI subagent panel.** The package now also ships a terminal-UI entrypoint
(`opencode-kanban-manager/tui`) that adds a **Kanban · Subagents** session panel mirroring
the native picker: `↑`/`↓` move, `←`/`→` toggle the active/inactive filter, `Enter` opens
the selected session, `r` refreshes, `Esc` closes. Unlike the built-in picker it is
*kanban-aware*: it groups each subagent under its owning task card. Open it with the
`/kanban-agents` slash command or the "Kanban: Subagents" palette entry.

## Preview

![opencode-kanban-manager preview](docs/preview.png)

## Why one plugin, not two

In real development a task always has *both* a lifecycle stage and a technical-stack
boundary. Splitting them into two plugins forces constant config switching. This plugin
derives both at once and uses them together to pick a subagent.

## Install

### From git (recommended)

```sh
opencode plugin add github:tomzio/opencode-kanban-manager
```

The `Kanban · Subagents` TUI panel (v1.2.0) is a CLI/TUI plugin, so it also needs the
package listed in your global `~/.config/opencode/cli.json`:

```jsonc
{
  "plugins": ["opencode-kanban-manager"]
}
```

### From a local checkout

Drop the package directory into your project's `.opencode/plugins/` folder, or point the
`plugins` array at it:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["./.opencode/plugins/kanban-manager"]
}
```

Options can be passed with the object form:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-kanban-manager",
      "options": { "autoCapture": true, "maxBoardRows": 30 }
    }
  ]
}
```

## Usage

Just talk to OpenCode normally. Every non-command message becomes a card, classified
automatically:

| You type | Lifecycle | Stack |
|:---|:---|:---|
| 医疗档案列表控件怎么没数据,是前端坏了还是后端接口挂了? | `bug-fix` | `full-stack` |
| 新加一个患者信息导出的前端按钮和批量下载功能 | `feature` | `frontend` |
| 把这部分的数据库查询 PL/SQL 包重构一下,顺便补个单元测试 | `architecture` | `database` |

### Commands

- `/board` — render the entire board.
- `/task <title>` — explicitly record a card.

### Tools exposed to the agent

- `kanban_update_status` — update a card's status and delivery summary (use to archive).
- `kanban_add_task` — create a card, optionally forcing lifecycle/stack.
- `kanban_list` — list cards, optionally filtered by status.
- `kanban_list_agents` — list subagent activity, optionally scoped to one card or task status.

## Subagent tracking

When the master agent dispatches a subagent, OpenCode runs it in a *child session*
(`parentID` set). The plugin listens to `ctx.event.subscribe(...)`, links each child
session to the card that owns its parent, and keeps the run record fresh:

| Event | Effect on the run record |
|:---|:---|
| `session.created` (has `parentID`) | create the run: agent, title, status `running` |
| `session.tool.input.started` | `tools += 1`, record `lastTool` |
| `session.execution.started` / `session.status` busy | status `running` |
| `session.execution.succeeded` | status `done` |
| `session.execution.failed` / interrupted | status `failed` / `idle` |
| `session.idle` | status `idle` |
| `session.agent.selected` | update the agent id |

Every card gains a **Subagents** column (counts) plus an expanded `**Subagent activity**`
list in `/board` and in the injected context, e.g.:

```
- `task_a1` 医疗档案列表控件怎么没数据
  - ▶ `explore — 摸清页面注册` · running · 12 tools · last: `grep`
  - ✓ `general — 医保附属拆四册` · done · 5 tools
```

This is per-task and persisted, so it survives restarts — it complements the native TUI
`Subagents` picker (press `↓`), which only shows the *current* session's live children.

## TUI subagent panel (v1.2.0)

The native `↓` picker shows the **current session's** live children. The kanban TUI panel
shows the same information **grouped by task card**, and works across the whole board.

Open it with:

- the slash command `/kanban-agents`, or
- the command palette (`Ctrl+P`) → **Kanban: Subagents**.

| Key | Action |
|:---|:---|
| `↑` / `↓` | Move between task rows and subagent rows |
| `←` | Show **active only** (`running`) |
| `→` | Show **active + inactive** (`idle` / `done` / `failed`) |
| `Enter` | Open the selected task's root session, or the selected subagent's child session |
| `r` | Refresh |
| `Esc` | Close the panel and return to the main agent |

Rows render like:

```
Kanban · Subagents                                            all agents
▸ task_a1 [bug-fix / full-stack] in_progress 医疗档案列表控件怎么没数据
  ▸ ↳ ▶ explore — 摸清页面注册 · running · 12 tools · last: grep
      ↳ ✓ general — 医保附属拆四册 · done · 5 tools
```

### How the panel is wired

- `src/rpc.ts` defines a shared RPC contract (`Rpc.define`) with a read-only `snapshot`
  method and a `changed` event.
- The server plugin (`src/index.ts`) registers the RPC handler and emits `changed`
  whenever a card is written.
- The TUI plugin (`src/tui.tsx`) claims the `session.panel` slot, fetches a snapshot over
  `ctx.client.rpc(KanbanRpc)`, subscribes to `ctx.data.listen(...)` to refresh live, and
  binds its keys with a panel-scoped `ctx.keymap.layer(...)`.

Because the TUI entrypoint is optional, the server plugin still works on its own in
headless / SDK usage.

## Routing blueprint (injected into the model context)

1. `bug-fix` + `full-stack` (unknown root cause) → **Full-Stack Detective subagent**,
   investigating top-down `UI → API → DB`. No blind patching.
2. `bug-fix` + `frontend`/`backend`/`database` → the matching local fix subagent.
3. `architecture` / `feature` → architect or full-stack development subagent.
4. Zero-pollution: keep debugging detail inside subagent sessions; archive with
   `kanban_update_status` when done.

## Options

| Option | Type | Default | Description |
|:---|:---|:---|:---|
| `autoCapture` | `boolean` | `true` | Record every non-command user message as a card. |
| `maxBoardRows` | `number` | `30` | Max active rows injected into the context. |
| `storagePrefix` | `string` | `"kanban/tasks/"` | Storage key prefix. |
| `trackSubagents` | `boolean` | `true` | Track subagent (child-session) activity on each card. |

## How it works (V2 API)

- `Plugin.define({ id, setup })` — plugin entrypoint.
- `ctx.storage` — plugin-scoped durable JSON persistence for the cards (no sqlite needed).
- `ctx.tool.transform(editor => editor.add(...))` — registers the kanban tools.
- `ctx.session.hook("prompt", ...)` — captures user input and appends the routing notice
  (the original request is preserved).
- `ctx.session.hook("context", ...)` — injects the board + routing blueprint into every
  model request.
- `ctx.event.subscribe({ signal })` — observes `session.created` (child sessions),
  `session.tool.input.started`, `session.execution.*`, and `session.status` to keep each
  card's subagent run records current.
- `ctx.rpc.register(KanbanRpc, handlers)` + `registration.events.emit(...)` — expose the
  board to the optional TUI entrypoint.
- TUI (`@opencode/plugin/tui`): `ctx.ui.slot({ append: "session.panel", ... })`,
  `ctx.ui.panel.open(...)`, `ctx.keymap.layer(...)`, and `ctx.client.rpc(...)` build the
  `Kanban · Subagents` panel.

## Development

```sh
npm install
npm run typecheck
```

## License

MIT
