import { Plugin } from "@opencode/plugin"

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
 * Persistence uses the V2 `ctx.storage` domain (plugin-scoped JSON) instead of sqlite.
 */

type Status = "todo" | "in_progress" | "review" | "done"
type Lifecycle = "architecture" | "feature" | "bug-fix" | "testing" | "docs"
type Stack = "frontend" | "backend" | "database" | "full-stack"

interface UnifiedTask {
  id: string
  title: string
  status: Status
  lifecycle: Lifecycle
  stack: Stack
  summary?: string
  created_at: string
}

interface KanbanOptions {
  /** Record every non-command user message as a task card. Default: true. */
  autoCapture?: boolean
  /** Maximum number of active rows shown in the injected board. Default: 30. */
  maxBoardRows?: number
  /** Storage key prefix. Default: "kanban/tasks/". */
  storagePrefix?: string
}

const STATUSES: readonly Status[] = ["todo", "in_progress", "review", "done"]
const LIFECYCLES: readonly Lifecycle[] = ["architecture", "feature", "bug-fix", "testing", "docs"]
const STACKS: readonly Stack[] = ["frontend", "backend", "database", "full-stack"]

const DEFAULTS: Required<KanbanOptions> = {
  autoCapture: true,
  maxBoardRows: 30,
  storagePrefix: "kanban/tasks/",
}

function isStatus(v: string): v is Status {
  return (STATUSES as readonly string[]).includes(v)
}

let seq = 0

function newTaskId(): string {
  seq = (seq + 1) % 100000
  return `task_${Date.now().toString(36)}${seq.toString(36).padStart(2, "0")}`
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

function renderBoard(tasks: UnifiedTask[], maxRows: number): string {
  if (tasks.length === 0) return "_(empty)_"
  const rows = tasks
    .slice(0, maxRows)
    .map(
      (t) =>
        `| ${t.id} | \`${t.lifecycle}\` | \`${t.stack}\` | **${t.status}** | ${t.title} | ${
          t.summary && t.summary.length > 0 ? t.summary : "-"
        } |`,
    )
    .join("\n")
  return [
    "| ID | Lifecycle | Stack | Status | Task | Delivery Summary |",
    "|:---|:---|:---|:---|:---|:---|",
    rows,
  ].join("\n")
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
    const opts: Required<KanbanOptions> = {
      autoCapture: (ctx.options as KanbanOptions | undefined)?.autoCapture ?? DEFAULTS.autoCapture,
      maxBoardRows: (ctx.options as KanbanOptions | undefined)?.maxBoardRows ?? DEFAULTS.maxBoardRows,
      storagePrefix: (ctx.options as KanbanOptions | undefined)?.storagePrefix ?? DEFAULTS.storagePrefix,
    }

    const keyOf = (id: string) => `${opts.storagePrefix}${id}`

    async function getTask(id: string): Promise<UnifiedTask | undefined> {
      return (await ctx.storage.get(keyOf(id))) as unknown as UnifiedTask | undefined
    }

    async function putTask(task: UnifiedTask): Promise<void> {
      await ctx.storage.set(keyOf(task.id), task as unknown as Parameters<typeof ctx.storage.set>[1])
    }

    async function listTasks(): Promise<UnifiedTask[]> {
      const { entries } = await ctx.storage.scan({ prefix: opts.storagePrefix })
      return entries
        .map((e) => e.value as unknown as UnifiedTask)
        .filter((t): t is UnifiedTask => !!t && typeof t.id === "string")
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
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
        created_at: new Date().toISOString(),
      }
      await putTask(task)
      return task
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

      const task = await createTask(taskTitle)

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

    return () => {
      // no long-lived resources held; storage is managed by the runtime
    }
  },
})
