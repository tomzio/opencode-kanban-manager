import { Rpc } from "@opencode/plugin/rpc"

/**
 * Shared RPC contract between the server plugin (src/index.ts) and the TUI
 * plugin (src/tui.tsx).
 *
 * The server plugin exposes a read-only `snapshot` method returning the current
 * kanban board, and emits a `changed` event whenever a card is created or a
 * subagent run is updated. The TUI plugin subscribes to that event and renders
 * the data inside a session panel.
 */

export type KanbanAgentStatus = "running" | "idle" | "done" | "failed"

export interface KanbanAgentView {
  /** Child (subagent) session id. */
  id: string
  agent?: string
  title?: string
  status: KanbanAgentStatus
  tools: number
  lastTool?: string
  started_at: string
  updated_at: string
}

export interface KanbanTaskView {
  id: string
  title: string
  status: "todo" | "in_progress" | "review" | "done"
  lifecycle: "architecture" | "feature" | "bug-fix" | "testing" | "docs"
  stack: "frontend" | "backend" | "database" | "full-stack"
  summary?: string
  sessionID?: string
  agents?: KanbanAgentView[]
}

export interface KanbanSnapshot {
  generatedAt: string
  tasks: KanbanTaskView[]
}

export const KanbanRpc = Rpc.define({
  id: "kanban",
  methods: {
    snapshot: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          generatedAt: { type: "string" },
          tasks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                status: { type: "string" },
                lifecycle: { type: "string" },
                stack: { type: "string" },
                summary: { type: "string" },
                sessionID: { type: "string" },
                agents: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      id: { type: "string" },
                      agent: { type: "string" },
                      title: { type: "string" },
                      status: { type: "string" },
                      tools: { type: "number" },
                      lastTool: { type: "string" },
                      started_at: { type: "string" },
                      updated_at: { type: "string" },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
          },
        },
        required: ["generatedAt", "tasks"],
        additionalProperties: false,
      },
    },
  },
  events: {
    changed: { schema: { type: "object", additionalProperties: true } },
  },
})
