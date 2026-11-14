import type { Thread, TreeNode } from "../../shared/types";

export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>;
  loadMode?: "essential" | "discoverable";
  hidden?: boolean;
}

export interface HostToolContext {
  thread: Thread;
  node: TreeNode;
  cwd: string;
  toolName: string;
  args: Record<string, any>;
  toolCallId: string;
  requestId: string;
}

export interface HostToolResult {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

export type HostToolHandler = (context: HostToolContext) => Promise<HostToolResult>;

const object = (properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const HOST_TOOL_DEFINITIONS: HostToolDefinition[] = [
  // Definitions are filled below; all tree tools are essential so orchestrators can call them directly.
  {
    name: "tree_list",
    label: "Tree: list",
    description:
      "List the project/group tree around you, with node ids, thread ids, statuses, git branches and unread message counts. Use this before delegating.",
    parameters: object({ includeStatus: { type: "boolean" }, depth: { type: "number" } }),
    loadMode: "essential",
  },
  {
    name: "tree_create_node",
    label: "Tree: create group/project",
    description:
      "Create a child group or project under your node. Root and group orchestrators can create groups; group orchestrators can create projects; a project orchestrator cannot create nodes. Omit name to auto-name from the brief. Omit path to create a workspace folder named after the node; pass a repository path to attach an existing repo.",
    parameters: object(
      {
        type: { type: "string", enum: ["group", "project"] },
        name: { type: "string" },
        path: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        brief: { type: "string" },
        gitInit: { type: "boolean", description: "Initialise a git repository at path when creating a project." },
        environmentId: { type: "string", description: "Environment profile to attach to the new node." },
        approvalMode: { type: "string", enum: ["always-ask", "write", "yolo"] },
      },
      ["type"],
    ),
    loadMode: "essential",
  },
  {
    name: "tree_create_thread",
    label: "Tree: spawn thread",
    description:
      "Spawn a worker thread under you with its own context, model and optional isolated git branch/worktree. Use for independent workstreams. Set wait=false for parallel work; wait=true to receive the result in this turn.",
    parameters: object(
      {
        title: { type: "string" },
        brief: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        isolation: { type: "string", enum: ["auto", "shared", "branch", "worktree"] },
        wait: { type: "boolean" },
      },
      ["brief"],
    ),
    loadMode: "essential",
  },
  {
    name: "tree_message",
    label: "Tree: send message",
    description:
      "Send a typed message to your parent, a child thread, or another node's orchestrator. Downward messages are tasks/context; upward messages are reports/questions. Every message is durable and visible in the tree bus.",
    parameters: object(
      {
        target: { type: "string", description: "parent, child:<threadId>, thread:<threadId>, or node:<nodeId>" },
        kind: {
          type: "string",
          enum: ["task", "context", "progress", "question", "answer", "result", "decision", "escalation", "digest", "cancel", "note"],
        },
        subject: { type: "string" },
        body: { type: "string" },
        requiresResponse: { type: "boolean" },
        priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      },
      ["target", "subject", "body"],
    ),
    loadMode: "essential",
  },
  {
    name: "tree_ask_parent",
    label: "Tree: ask parent",
    description:
      "Ask your parent orchestrator a question. blocking=true holds this turn until the parent answers (default). Use for decisions you cannot make safely; otherwise continue with an explicit assumption.",
    parameters: object({ question: { type: "string" }, blocking: { type: "boolean" }, context: { type: "string" } }, ["question"]),
    loadMode: "essential",
  },
  {
    name: "tree_report",
    label: "Tree: report up",
    description:
      "Report a result, progress update, blocker or escalation to your parent. Use at every meaningful milestone and when you finish. Keep it concise; raw transcripts stay local.",
    parameters: object(
      {
        summary: { type: "string" },
        status: { type: "string", enum: ["progress", "done", "blocked", "error", "needs-decision"] },
        artifacts: { type: "array", items: { type: "string" } },
        needsParentAction: { type: "boolean" },
      },
      ["summary"],
    ),
    loadMode: "essential",
  },
  {
    name: "tree_reply",
    label: "Tree: reply to message",
    description: "Answer a question or message from a child or parent. Use the message id shown in the tree-message header.",
    parameters: object({ messageId: { type: "string" }, body: { type: "string" } }, ["messageId", "body"]),
  },
  {
    name: "tree_wait",
    label: "Tree: wait",
    description: "Wait for one or more child threads to report or finish. Returns their latest status and summaries. Use instead of polling.",
    parameters: object({ threadIds: { type: "array", items: { type: "string" } }, timeoutMs: { type: "number" } }),
  },
  {
    name: "tree_cancel",
    label: "Tree: cancel",
    description: "Cancel a child thread and tell it why. Its work is aborted and its branch is left in place.",
    parameters: object({ threadId: { type: "string" }, reason: { type: "string" } }, ["threadId"]),
  },
  {
    name: "tree_git",
    label: "Tree: git",
    description:
      "Inspect or act on git for a project or worker thread: status, diff, commit, merge a worker branch, or create a PR. Merge only when the worker is complete and tests pass; report conflicts up.",
    parameters: object(
      {
        op: { type: "string", enum: ["status", "diff", "commit", "merge", "pr"] },
        threadId: { type: "string" },
        message: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      ["op"],
    ),
  },
  {
    name: "tree_memory_write",
    label: "Tree: remember",
    description:
      "Write a durable memory at your level: decisions, constraints, preferences, reusable lessons. Do not store transient chatter. Memory is visible and editable by the user.",
    parameters: object({ text: { type: "string" }, tags: { type: "array", items: { type: "string" } }, importance: { type: "number" } }, ["text"]),
    loadMode: "essential",
  },
  {
    name: "tree_memory_read",
    label: "Tree: recall",
    description: "Search memories at your level and its ancestors. Use before assuming a past decision.",
    parameters: object({ query: { type: "string" }, limit: { type: "number" } }),
  },
  {
    name: "tree_set_title",
    label: "Tree: set title",
    description: "Set a concise title for your own thread after you understand the task.",
    parameters: object({ title: { type: "string" } }, ["title"]),
  },
  {
    name: "tree_update_node",
    label: "Tree: update node",
    description:
      "Update a project/group you own: rename it, change its path, model, effort, git policy, approval mode, environment or mute state. Use this instead of asking the user to open Settings.",
    parameters: object({
      nodeId: { type: "string" },
      name: { type: "string" },
      path: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      gitMode: { type: "string", enum: ["auto", "shared", "branch", "worktree"] },
      approvalMode: { type: "string", enum: ["always-ask", "write", "yolo"] },
      environmentId: { type: "string" },
      muted: { type: "boolean" },
    }),
    loadMode: "essential",
  },
  {
    name: "tree_move_node",
    label: "Tree: move node",
    description: "Move a project or group under another group/root. Use this to reorganise the tree; child projects and threads move with it.",
    parameters: object({ nodeId: { type: "string" }, parentId: { type: "string" } }, ["nodeId", "parentId"]),
    loadMode: "essential",
  },
  {
    name: "tree_delete_node",
    label: "Tree: delete node",
    description: "Delete a project/group and its child nodes from OMP Studio. Files, branches and worktrees stay on disk. Only use after confirming with the user.",
    parameters: object({ nodeId: { type: "string" }, confirm: { type: "boolean" } }, ["nodeId", "confirm"]),
  },
  {
    name: "tree_create_environment",
    label: "Tree: create environment",
    description:
      "Create a local environment profile with env vars, setup/teardown commands, shell, git mode and approval mode. Assign it to a node with tree_update_node. Do not put secret values in the prompt; use the Settings UI or ask the user.",
    parameters: object(
      {
        name: { type: "string" },
        cwd: { type: "string" },
        envVars: {
          type: "array",
          items: object({ key: { type: "string" }, value: { type: "string" } }, ["key", "value"]),
        },
        setupCommands: { type: "array", items: { type: "string" } },
        teardownCommands: { type: "array", items: { type: "string" } },
        shell: { type: "string" },
        inheritEnv: { type: "boolean" },
        gitMode: { type: "string", enum: ["auto", "shared", "branch", "worktree"] },
        approvalMode: { type: "string", enum: ["always-ask", "write", "yolo"] },
      },
      ["name"],
    ),
    loadMode: "essential",
  },
  {
    name: "tree_update_environment",
    label: "Tree: update environment",
    description: "Update an existing environment profile. Secret values are preserved; do not pass secrets through this tool.",
    parameters: object({
      environmentId: { type: "string" },
      name: { type: "string" },
      cwd: { type: "string" },
      envVars: { type: "array", items: object({ key: { type: "string" }, value: { type: "string" } }, ["key", "value"]) },
      setupCommands: { type: "array", items: { type: "string" } },
      teardownCommands: { type: "array", items: { type: "string" } },
      shell: { type: "string" },
      inheritEnv: { type: "boolean" },
      gitMode: { type: "string", enum: ["auto", "shared", "branch", "worktree"] },
      approvalMode: { type: "string", enum: ["always-ask", "write", "yolo"] },
    }, ["environmentId"]),
  },
  {
    name: "tree_assign_environment",
    label: "Tree: assign environment",
    description: "Assign an environment profile to a project/group. New threads inherit it immediately; existing OMP sessions pick it up when restarted.",
    parameters: object({ nodeId: { type: "string" }, environmentId: { type: "string" } }, ["nodeId", "environmentId"]),
    loadMode: "essential",
  },
  {
    name: "tree_list_environments",
    label: "Tree: list environments",
    description: "List environment profiles and their commands without exposing secret values.",
    parameters: object({}),
  },
  {
    name: "tree_test_environment",
    label: "Tree: test environment",
    description: "Run an environment's setup commands in a node's directory and return the output.",
    parameters: object({ environmentId: { type: "string" }, nodeId: { type: "string" } }, ["environmentId"]),
  },
];

for (const tool of HOST_TOOL_DEFINITIONS) {
  tool.loadMode = "essential";
}
