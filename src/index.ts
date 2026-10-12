import { Plugin } from "@opencode/plugin"
import { KanbanRpc } from "./rpc.ts"

/**
 * opencode-kanban-manager
 * ------------------------
 * A single OpenCode V2 plugin that fuses two ideas:
 *   1. Engineering lifecycle classification  (architecture | feature | bug-fix | testing | docs)
 *   2. Full-stack / cross-stack routing        (frontend | backend | database | full-stack)
 *
 * Every user request is captured on a persistent kanban board, classified on both
 * dimensions, and surfaced back to the master agent as a routing blueprint so it can
 * dispatch the correct expert subagent. Symptoms with unknown root cause become
 * `bug-fix + full-stack` and are flagged for the Full-Stack Detective subagent.
 *
 * v1.1.0 adds subagent tracking: the plugin subscribes to the server event stream,
 * detects child ("subagent") sessions via `parentID`, and attaches a live run record
 * (agent, status, tool count, last tool) to the owning task card. The board therefore
 * answers "which subagents ran for this task, and how did they go?".
 *
 * Persistence uses the V2 `ctx.storage` domain (plugin-scoped JSON) instead of sqlite.
 */

type Status = "todo" | "in_progress" | "review" | "done"
type Lifecycle = "architecture" | "feature" | "bug-fix" | "testing" | "docs"
type Stack = "frontend" | "backend" | "database" | "full-stack"
type AgentStatus = "running" | "idle" | "done" | "failed"

/** A subagent (child-session) run attached to a task card. */
interface SubAgentRun {
  /** Child session id. */
  id: string
  /** Agent id that owns the child session, e.g. "explore". */
  agent?: string
  /** Child-session title, e.g. "摸清页面注册与实现模板". */
  title?: string
  status: AgentStatus
  /** Number of tool calls observed in the child session. */
  tools: number
  /** Name of the most recent tool call observed. */
  lastTool?: string
  started_at: string
  updated_at: string
}

interface UnifiedTask {
  id: string
  title: string
  status: Status
  lifecycle: Lifecycle
  stack: Stack
  summary?: string
  created_at: string
  /** Root session id that this card belongs to. */
  sessionID?: string
  /** Subagents dispatched while working this card. */
  agents?: SubAgentRun[]
}

interface KanbanOptions {
  /** Record every non-command user message as a task card. Default: true. */
  autoCapture?: boolean
  /** Maximum number of active rows shown in the injected board. Default: 30. */
  maxBoardRows?: number
  /** Storage key prefix. Default: "kanban/tasks/". */
  storagePrefix?: string
  /** Track subagent (child session) activity on each card. Default: true. */
  trackSubagents?: boolean
}

const STATUSES: readonly Status[] = ["todo", "in_progress", "review", "done"]
const LIFECYCLES: readonly Lifecycle[] = ["architecture", "feature", "bug-fix", "testing", "docs"]
const STACKS: readonly Stack[] = ["frontend", "backend", "database", "full-stack"]

const TERMINAL_AGENT_STATUSES: readonly AgentStatus[] = ["done", "failed"]

const DEFAULTS: Required<KanbanOptions> = {
  autoCapture: true,
  maxBoardRows: 30,
  storagePrefix: "kanban/tasks/",
  trackSubagents: true,
}

function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v)
}

let seq = 0

function newTaskId(): string {
  seq = (seq + 1) % 100000
  return `task_${Date.now().toString(36)}${seq.toString(36).padStart(2, "0")}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Intelligent attribute parser.
 * Derives the engineering lifecycle and the technical-stack boundary from free text.
 */
function parseTaskAttributes(input: string): { lifecycle: Lifecycle; stack: Stack } {
  // A. Engineering lifecycle
  let lifecycle: Lifecycle = "feature"
  if (/架构|设计|重构|模式|分层|结构|refactor|architecture/i.test(input)) lifecycle = "architecture"
  else if (/测试|用例|test|qa|coverage|unit\s*test/i.test(input)) lifecycle = "testing"
  else if (/文档|说明|readme|docs|wiki|注释|comment/i.test(input)) lifecycle = "docs"
  else if (/bug|错误|报错|异常|坏了|崩溃|fix|issue|crash|error|没加载|不对|没数据|挂了/i.test(input))
    lifecycle = "bug-fix"

  // B. Stack boundary — default to full-stack when the symptom is ambiguous
  let stack: Stack = "full-stack"
  const hasFrontend = /ui|组件|布局|前端|页面|样式|按钮|控件|react|vue|angular|ant/i.test(input)
  const hasBackend = /api|接口|后端|controller|service|请求|spring|actix|gateway|endpoint/i.test(input)
  const hasDatabase = /sql|数据库|表|数据|mock|oracle|plsql|mysql|postgres|查询|query/i.test(input)

  if (hasFrontend && !hasBackend && !hasDatabase) stack = "frontend"
  else if (hasBackend && !hasFrontend && !hasDatabase) stack = "backend"
  else if (hasDatabase && !hasFrontend && !hasBackend) stack = "database"
  else if (hasFrontend && hasBackend) stack = "full-stack"
  else if (lifecycle === "bug-fix") stack = "full-stack"

  return { lifecycle, stack }
}

function renderAgentsSection(tasks: UnifiedTask[]): string {
  const withAgents = tasks.filter((t) => (t.agents?.length ?? 0) > 0)
  if (withAgents.length === 0) return ""

  const lines: string[] = ["", "**Subagent activity**"]
  for (const t of withAgents) {
    lines.push(`- \`${t.id}\` ${t.title}`)
    for (const a of t.agents ?? []) {
      const icon =
        a.status === "failed" ? "✗" : a.status === "done" ? "✓" : a.status === "idle" ? "◻" : "▶"
      const who = a.agent ? `${a.agent}${a.title ? ` — ${a.title}` : ""}` : (a.title ?? a.id)
      const last = a.lastTool ? ` · last: \`${a.lastTool}\`` : ""
      lines.push(`  - ${icon} \`${who}\` · ${a.status} · ${a.tools} tools${last}`)
    }
  }
  return lines.join("\n")
}

function renderBoard(tasks: UnifiedTask[], maxRows: number): string {
  if (tasks.length === 0) return "_(empty)_"
  const rows = tasks
    .slice(0, maxRows)
    .map((t) => {
      const agents = t.agents ?? []
      const running = agents.filter((a) => a.status === "running").length
      const failed = agents.filter((a) => a.status === "failed").length
      const agentCell =
        agents.length === 0
          ? "-"
          : `${agents.length} total${running > 0 ? ` · ${running}▶` : ""}${failed > 0 ? ` · ${failed}✗` : ""}`
      return `| ${t.id} | \`${t.lifecycle}\` | \`${t.stack}\` | **${t.status}** | ${t.title} | ${agentCell} | ${
        t.summary && t.summary.length > 0 ? t.summary : "-"
      } |`
    })
    .join("\n")
  const table = [
    "| ID | Lifecycle | Stack | Status | Task | Subagents | Delivery Summary |",
    "|:---|:---|:---|:---|:---|:---|:---|",
    rows,
  ].join("\n")
  return [table, renderAgentsSection(tasks)].filter((s) => s.length > 0).join("\n")
}

function routingBlueprint(): string {
  return [
    "**【Master Agent Intelligent Routing Whitepaper】**",
    "1. `bug-fix` + `full-stack` (unknown root cause): dispatch the **Full-Stack Detective subagent**. It investigates top-down UI -> API -> DB. Never patch code blindly.",
    "2. `bug-fix` + `frontend`/`backend`/`database`: dispatch the matching local fix subagent directly.",
    "3. `architecture` / `feature`: dispatch the architect or full-stack development subagent.",
    "4. Zero-pollution principle: keep debugging detail inside subagent sessions. The main context only reads this table. When a task finishes, call `kanban_update_status` to archive it.",
  ].join("\n")
}

export default Plugin.define({
  id: "opencode-kanban-manager",

  async setup(ctx) {
    const rawOpts = ctx.options as KanbanOptions | undefined
    const opts: Required<KanbanOptions> = {
      autoCapture: rawOpts?.autoCapture ?? DEFAULTS.autoCapture,
      maxBoardRows: rawOpts?.maxBoardRows ?? DEFAULTS.maxBoardRows,
      storagePrefix: rawOpts?.storagePrefix ?? DEFAULTS.storagePrefix,
      trackSubagents: rawOpts?.trackSubagents ?? DEFAULTS.trackSubagents,
    }

    const keyOf = (id: string) => `${opts.storagePrefix}${id}`

    // Notified whenever a card changes so the TUI panel can refresh (set after RPC registration).
    let emitChanged: (() => void) | undefined

    // In-memory cache keeps successive rapid updates consistent before they are flushed.
    const cache = new Map<string, UnifiedTask>()

    async function getTask(id: string): Promise<UnifiedTask | undefined> {
      const hit = cache.get(id)
      if (hit) return hit
      const stored = (await ctx.storage.get(keyOf(id))) as unknown as UnifiedTask | undefined
      if (stored) cache.set(id, stored)
      return stored
    }

    async function putTask(task: UnifiedTask): Promise<void> {
      cache.set(task.id, task)
      await ctx.storage.set(keyOf(task.id), task as unknown as Parameters<typeof ctx.storage.set>[1])
      emitChanged?.()
    }

    async function listTasks(): Promise<UnifiedTask[]> {
      const { entries } = await ctx.storage.scan({ prefix: opts.storagePrefix })
      const merged = new Map<string, UnifiedTask>()
      for (const e of entries) {
        const t = e.value as unknown as UnifiedTask
        if (t && typeof t.id === "string") merged.set(t.id, t)
      }
      for (const [id, t] of cache) merged.set(id, t)
      return [...merged.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
    }

    async function createTask(title: string): Promise<UnifiedTask> {
      const { lifecycle, stack } = parseTaskAttributes(title)
      const task: UnifiedTask = {
        id: newTaskId(),
        title,
        status: "todo",
        lifecycle,
        stack,
        summary: "",
        created_at: nowIso(),
      }
      await putTask(task)
      return task
    }

    // ---------------------------------------------------------------------
    // RPC: expose the board to the TUI plugin (src/tui.tsx)
    // ---------------------------------------------------------------------
    const rpc = await ctx.rpc.register(KanbanRpc, {
      snapshot: async () => ({
        generatedAt: nowIso(),
        tasks: (await listTasks()).map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          lifecycle: t.lifecycle,
          stack: t.stack,
          summary: t.summary,
          sessionID: t.sessionID,
          agents: (t.agents ?? []).map((a) => ({
            id: a.id,
            agent: a.agent,
            title: a.title,
            status: a.status,
            tools: a.tools,
            lastTool: a.lastTool,
            started_at: a.started_at,
            updated_at: a.updated_at,
          })),
        })),
      }),
    })

    emitChanged = () => {
      void rpc.events.emit("changed", { at: nowIso() }).catch(() => {})
    }

    // ---------------------------------------------------------------------
    // Subagent tracking — session index
    // ---------------------------------------------------------------------
    // Maps any known session id (root task session OR child subagent session) to its owning card.
    const sessionIndex = new Map<string, string>()

    /**
     * Apply a server event to the matching subagent run, if this plugin tracks the session.
     * Events are loosely typed here on purpose: the payload shapes vary per event type and
     * only the fields used below are stable.
     */
    function applyRunEvent(run: SubAgentRun, type: string, data: Record<string, unknown>): void {
      const isTerminal = TERMINAL_AGENT_STATUSES.includes(run.status)
      switch (type) {
        case "session.tool.input.started":
          run.tools += 1
          if (typeof data.name === "string") run.lastTool = data.name
          run.status = "running"
          break
        case "session.execution.started":
          run.status = "running"
          break
        case "session.execution.succeeded":
          run.status = "done"
          break
        case "session.execution.failed":
          run.status = "failed"
          break
        case "session.execution.interrupted":
          run.status = "idle"
          break
        case "session.idle":
          if (run.status === "running") run.status = "idle"
          break
        case "session.status": {
          const status = data.status as { type?: string } | undefined
          const s = status?.type
          if (s === "busy" || s === "retry") run.status = "running"
          else if (s === "idle" && run.status === "running") run.status = "idle"
          break
        }
        case "session.agent.selected":
          if (typeof data.agent === "string") run.agent = data.agent
          break
        default:
          return
      }
      // Do not resurrect terminal runs on late idle/status noise.
      if (isTerminal && (type === "session.idle" || type === "session.status")) return
      run.updated_at = nowIso()
    }

    async function handleEvent(ev: unknown): Promise<void> {
      const event = ev as {
        type?: string
        data?: Record<string, unknown>
        location?: { directory?: string }
      }
      const type = event.type
      if (!type) return

      const dir = event.location?.directory
      if (dir && ctx.location.directory && dir !== ctx.location.directory) return

      const data = event.data ?? {}
      const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined

      if (type === "session.created") {
        const parentID = typeof data.parentID === "string" ? data.parentID : undefined
        if (!parentID) return
        const taskId = sessionIndex.get(parentID)
        if (!taskId) return
        const task = await getTask(taskId)
        if (!task) return
        const run: SubAgentRun = {
          id: sessionID ?? "unknown",
          agent: typeof data.agent === "string" ? data.agent : undefined,
          title: typeof data.title === "string" ? data.title : undefined,
          status: "running",
          tools: 0,
          started_at: nowIso(),
          updated_at: nowIso(),
        }
        if (!run.id || run.id === "unknown") return
        task.agents = [...(task.agents ?? []), run]
        await putTask(task)
        sessionIndex.set(run.id, taskId)
        return
      }

      if (type === "session.deleted") {
        if (sessionID) sessionIndex.delete(sessionID)
        return
      }

      if (!sessionID) return
      const taskId = sessionIndex.get(sessionID)
      if (!taskId) return
      const task = await getTask(taskId)
      if (!task) return
      const run = (task.agents ?? []).find((a) => a.id === sessionID)
      if (!run) return
      applyRunEvent(run, type, data)
      await putTask(task)
    }

    // ---------------------------------------------------------------------
    // Tools
    // ---------------------------------------------------------------------
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "kanban_update_status",
        description:
          "Update a kanban card's status and optional delivery summary. Use this to archive a task when it is done.",
        input: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Card id, e.g. task_abc123" },
            status: { type: "string", enum: STATUSES as unknown as string[] },
            summary: { type: "string", description: "Short delivery summary (optional)" },
          },
          required: ["taskId", "status"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          const { taskId, status, summary } = input as {
            taskId: string
            status: Status
            summary?: string
          }
          if (!isStatus(status)) {
            return { content: `[Kanban Error] Invalid status: ${status}` }
          }
          const task = await getTask(taskId)
          if (!task) return { content: `[Kanban Error] Card not found: ${taskId}` }
          task.status = status
          if (summary !== undefined) task.summary = summary
          await putTask(task)
          return { content: `[Kanban Success] ${taskId} -> [${status}]` }
        },
      })

      editor.add({
        name: "kanban_add_task",
        description:
          "Create a new kanban card. Lifecycle and stack are inferred from the title unless provided.",
        input: {
          type: "object",
          properties: {
            title: { type: "string" },
            lifecycle: { type: "string", enum: LIFECYCLES as unknown as string[] },
            stack: { type: "string", enum: STACKS as unknown as string[] },
          },
          required: ["title"],
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          const { title, lifecycle, stack } = input as {
            title: string
            lifecycle?: Lifecycle
            stack?: Stack
          }
          const task = await createTask(title)
          if (lifecycle) task.lifecycle = lifecycle
          if (stack) task.stack = stack
          await putTask(task)
          return {
            content: `[Kanban] Created ${task.id} (${task.lifecycle} / ${task.stack}): ${task.title}`,
          }
        },
      })

      editor.add({
        name: "kanban_list",
        description: "List kanban cards, optionally filtered by status.",
        input: {
          type: "object",
          properties: {
            status: { type: "string", enum: STATUSES as unknown as string[] },
          },
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          const { status } = (input ?? {}) as { status?: Status }
          let tasks = await listTasks()
          if (status) tasks = tasks.filter((t) => t.status === status)
          return { content: renderBoard(tasks, opts.maxBoardRows) }
        },
      })

      editor.add({
        name: "kanban_list_agents",
        description:
          "List subagent activity across kanban cards. Optionally filter by a card id or by task status.",
        input: {
          type: "object",
          properties: {
            taskId: { type: "string", description: "Only show subagents for this card" },
            status: { type: "string", enum: STATUSES as unknown as string[] },
          },
          additionalProperties: false,
        },
        options: { codemode: true },
        execute: async (input) => {
          const { taskId, status } = (input ?? {}) as { taskId?: string; status?: Status }
          let tasks = await listTasks()
          if (taskId) tasks = tasks.filter((t) => t.id === taskId)
          if (status) tasks = tasks.filter((t) => t.status === status)
          const section = renderAgentsSection(tasks)
          return { content: section.length > 0 ? section : "_(no subagent activity)_" }
        },
      })
    })

    // ---------------------------------------------------------------------
    // Intercept user input -> unified board
    // ---------------------------------------------------------------------
    await ctx.session.hook("prompt", async (event) => {
      const content = event.prompt.text?.trim()
      if (!content) return

      // /board -> render the whole board
      if (content === "/board") {
        const all = await listTasks()
        event.prompt.text = [
          "Present the following kanban board to the user exactly as shown and stop.",
          "",
          "### OpenCode Unified Engineering & Cross-Stack Detective Board",
          renderBoard(all, opts.maxBoardRows),
        ].join("\n")
        return
      }

      // anything else is captured as a task card (unless autoCapture is disabled)
      let taskTitle = content
      if (content.startsWith("/task ")) taskTitle = content.replace("/task ", "").trim()

      if (content.startsWith("/") && !content.startsWith("/task ")) return
      if (!opts.autoCapture && !content.startsWith("/task ")) return

      // Never capture prompts that belong to a subagent (child) session.
      try {
        const info = (await ctx.session.get({ sessionID: event.sessionID })) as
          | { parentID?: string }
          | undefined
        if (info?.parentID) return
      } catch {
        // If lookup fails, fall through and capture (better to over-capture than drop work).
      }

      const task = await createTask(taskTitle)
      task.sessionID = event.sessionID
      await putTask(task)
      sessionIndex.set(event.sessionID, task.id)

      // Keep the user's original request intact; append routing metadata.
      event.prompt.text = [
        content,
        "",
        "----",
        `【Kanban System Notice】 New task recorded: 📌 [${task.id}]`,
        `- Lifecycle: ${task.lifecycle.toUpperCase()}`,
        `- Stack: ${task.stack.toUpperCase()}`,
        `- Requirement: 「${taskTitle}」`,
        "Follow the routing blueprint above and dispatch the matching expert subagent via the `subagent` tool " +
          "(for an unknown full-stack bug, dispatch the Full-Stack Detective subagent).",
        "Subagent activity will be tracked on this card automatically.",
      ].join("\n")
    })

    // ---------------------------------------------------------------------
    // Inject the board + routing blueprint into every model request
    // ---------------------------------------------------------------------
    await ctx.session.hook("context", async (event) => {
      const active = (await listTasks()).filter((t) => t.status !== "done")
      if (active.length === 0) return

      event.system.push({
        type: "text",
        text: [
          "### 🌐 OpenCode Unified Engineering & Cross-Stack Detective Board",
          renderBoard(active, opts.maxBoardRows),
          "",
          routingBlueprint(),
        ].join("\n"),
      })
    })

    // ---------------------------------------------------------------------
    // Subscribe to the server event stream and track subagent (child) sessions.
    // ---------------------------------------------------------------------
    const ac = new AbortController()
    let loop: Promise<void> | undefined

    if (opts.trackSubagents) {
      // Rebuild the session index from persisted cards so tracking survives restarts.
      for (const t of await listTasks()) {
        if (t.sessionID) sessionIndex.set(t.sessionID, t.id)
        for (const a of t.agents ?? []) sessionIndex.set(a.id, t.id)
      }

      loop = (async () => {
        try {
          for await (const ev of ctx.event.subscribe({ signal: ac.signal })) {
            try {
              await handleEvent(ev)
            } catch {
              // Never let a single bad event kill the subscription.
            }
          }
        } catch {
          // Subscription aborted on cleanup.
        }
      })()
    }

    return async () => {
      ac.abort()
      await loop?.catch(() => {})
    }
  },
})
