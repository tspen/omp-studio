import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import YAML from "yaml";
import type {
  ApprovalRequest,
  ChatBlock,
  ChatMessage,
  ChatUsage,
  Environment,
  Thread,
  ThreadStatus,
  TreeNode,
} from "../../shared/types";
import type { Store } from "../services/store";
import type { HostToolDefinition, HostToolHandler, HostToolResult } from "../orchestrator/host-tools";
import { RpcClient } from "./rpc-client";
import { trace } from "../diagnostics";

/** Mission Control and groups never touch the workspace; only tree tools remain. */
const ROOT_DENIED_TOOLS = [
  "bash",
  "python",
  "eval",
  "debug",
  "launch",
  "read",
  "edit",
  "write",
  "grep",
  "glob",
  "ast_grep",
  "ast_edit",
  "notebook",
  "lsp",
  "task",
  "checkpoint",
  "security",
  "github",
];

/** Project orchestrators may review, but implementation belongs to workers. */
const PROJECT_ORCHESTRATOR_DENIED_TOOLS = [
  "edit",
  "write",
  "ast_edit",
  "ast_grep",
  "notebook",
  "python",
  "eval",
  "task",
];

export interface OmpSessionOptions {
  store: Store;
  exe: string;
  thread: Thread;
  node: TreeNode;
  environment?: Environment;
  processEnv: NodeJS.ProcessEnv;
  cwd: string;
  systemPrompt: string;
  hostTools: HostToolDefinition[];
  hostToolHandler: HostToolHandler;
  advisor?: boolean;
  toolNames?: string[];
  onChat: (message: ChatMessage) => void;
  onStatus: (status: ThreadStatus, message?: string) => void;
  onState: (state: any) => void;
  onSubagent: (frame: any) => void;
  onExit: (error?: Error) => void;
  onStderr?: (text: string) => void;
  onToolFile?: (path: string) => void;
}

type PendingUi = { frame: any; resolve: (response: any) => void };

export class OmpSession extends EventEmitter {
  readonly thread: Thread;
  readonly node: TreeNode;
  readonly cwd: string;
  readonly environment?: Environment;
  private store: Store;
  private options: OmpSessionOptions;
  private client: RpcClient | null = null;
  private started = false;
  private disposed = false;
  private promptResolve: ((status: string) => void) | null = null;
  private liveAssistantId: string | null = null;
  private liveMessage: ChatMessage | null = null;
  private pendingUi = new Map<string, PendingUi>();
  private lastAssistantText = "";
  private lastEmit = 0;
  private toolMessages = new Map<string, string>();
  private writeChain: Promise<unknown> = Promise.resolve();
  private turnUsage: ChatUsage | undefined;

  constructor(options: OmpSessionOptions) {
    super();
    this.options = options;
    this.store = options.store;
    this.thread = options.thread;
    this.node = options.node;
    this.cwd = options.cwd;
    this.environment = options.environment;
  }

  get isRunning(): boolean {
    return !!this.client?.isRunning && this.started;
  }

  async start(): Promise<void> {
    if (this.started) return;
    mkdirSync(this.thread.sessionDir, { recursive: true });
    const promptDir = join(this.store.baseDir, "prompts");
    mkdirSync(promptDir, { recursive: true });
    const promptPath = join(promptDir, `${this.thread.id}.md`);
    writeFileSync(promptPath, this.options.systemPrompt, "utf8");
    const overlayPath = join(promptDir, `${this.thread.id}.config.yml`);
    const configuredApproval = (this.store.data.ompConfig.entries.find((entry) => entry.key === "tools.approval")?.value ?? {}) as Record<string, string>;
    const orchestratorDenied =
      this.thread.kind === "orchestrator"
        ? this.node.type === "root" || this.node.type === "group"
          ? ROOT_DENIED_TOOLS
          : this.node.type === "project"
            ? PROJECT_ORCHESTRATOR_DENIED_TOOLS
            : []
        : [];
    writeFileSync(
      overlayPath,
      YAML.stringify({
        tools: {
          approval: {
            ...configuredApproval,
            ...Object.fromEntries(this.options.hostTools.map((tool) => [tool.name, "allow"])),
            ...Object.fromEntries(orchestratorDenied.map((name) => [name, "deny"])),
          },
        },
      }),
      "utf8",
    );

    const hasSession = existsSync(this.thread.sessionDir) && readdirSync(this.thread.sessionDir).some((file) => file.endsWith(".jsonl"));
    const args = [
      "--mode",
      "rpc-ui",
      "--cwd",
      this.cwd,
      "--session-dir",
      this.thread.sessionDir,
      ...(hasSession ? ["--continue"] : []),
      "--model",
      this.thread.model.selector || `${this.thread.model.provider}/${this.thread.model.id}`,
      "--thinking",
      this.thread.effort || "medium",
      "--approval-mode",
      this.node.approvalMode || this.store.settings.defaultApprovalMode || "yolo",
      "--append-system-prompt",
      promptPath,
      "--config",
      overlayPath,
    ];
    if (this.options.advisor) args.push("--advisor");
    if (this.options.toolNames?.length) args.push("--tools", this.options.toolNames.join(","));

    this.client = new RpcClient({
      exe: this.options.exe,
      args,
      cwd: this.cwd,
      env: this.options.processEnv,
      onStderr: (text) => {
        this.options.onStderr?.(text);
        this.emit("stderr", text);
      },
    });

    this.client.on("frame", (frame: any) => this.handleFrame(frame));
    this.client.on("exit", (info: any) => {
      const error = info?.code === 0 || this.disposed ? undefined : new Error(`OMP exited with code ${info?.code}`);
      this.options.onExit(error);
      this.emit("exit", error);
    });
    this.client.on("error", (error: Error) => {
      this.options.onExit(error);
      this.emit("error", error);
    });

    this.options.onStatus("starting", "Starting OMP…");
    await this.client.start();
    this.started = true;

    const hostTools = await this.client.request("set_host_tools", { tools: this.options.hostTools }).catch((error) => {
      console.error("set_host_tools failed", error);
      return null;
    });
    if (process.argv.includes("--integration-test")) console.log("HOST_TOOLS", JSON.stringify(hostTools));
    await this.client.request("set_subagent_subscription", { level: "events" }).catch(() => undefined);
    await this.client.request("set_ask_dialog", { enabled: true }).catch(() => undefined);
    await this.client
      .request("set_auto_compaction", { enabled: this.store.settings.contextCompaction !== false })
      .catch(() => undefined);

    const state = await this.client.request("get_state").catch(() => null);
    if (state) this.applyState(state);
    if (this.thread.model.provider && this.thread.model.id) {
      if (state?.model?.provider !== this.thread.model.provider || state?.model?.id !== this.thread.model.id) {
        await this.client.request("set_model", { provider: this.thread.model.provider, modelId: this.thread.model.id }, 120_000).catch(() => undefined);
      }
    }
    if (this.thread.effort) {
      await this.client.request("set_thinking_level", { level: this.thread.effort }, 30_000).catch(() => undefined);
    }
    this.options.onStatus("idle");
  }

  async prompt(text: string, mode: "prompt" | "steer" | "followUp" = "prompt"): Promise<void> {
    await this.ensureStarted();
    const type = mode === "prompt" ? "prompt" : mode === "steer" ? "steer" : "follow_up";
    await this.client!.request(type, { message: text }, 120_000);
    this.options.onStatus(mode === "prompt" ? "running" : this.thread.status, mode === "prompt" ? "Working…" : undefined);
  }

  async abort(): Promise<void> {
    if (!this.client?.isRunning) return;
    await this.client.request("abort", {}, 30_000).catch(() => undefined);
    this.options.onStatus("idle", "Stopped");
  }

  async setModel(selector: string): Promise<any> {
    await this.ensureStarted();
    const slash = selector.indexOf("/");
    if (slash < 0) throw new Error("Model selector must be provider/model");
    const provider = selector.slice(0, slash);
    const modelId = selector.slice(slash + 1);
    return this.client!.request("set_model", { provider, modelId }, 120_000);
  }

  async setThinking(level: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("set_thinking_level", { level }, 30_000);
  }

  async setAutoCompaction(enabled: boolean): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("set_auto_compaction", { enabled }, 30_000);
  }

  async compact(customInstructions?: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("compact", customInstructions ? { customInstructions } : {}, 600_000);
  }

  async getState(): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("get_state");
  }

  async getMessages(): Promise<any[]> {
    await this.ensureStarted();
    const data = await this.client!.request<any>("get_messages", {}, 120_000);
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  async restoredChat(): Promise<ChatMessage[]> {
    const raw = await this.getMessages();
    const chats: ChatMessage[] = [];
    for (const message of raw) {
      const role = message?.role;
      if (role !== "user" && role !== "assistant") continue;
      const blocks = normalizeBlocks(message.content).filter((block) => block.type === "text" || block.type === "thinking");
      if (!blocks.length) continue;
      chats.push({
        id: `restored_${randomUUID().slice(0, 8)}`,
        threadId: this.thread.id,
        role,
        blocks,
        timestamp: message.timestamp ?? Date.now(),
        model: role === "assistant" ? this.thread.model.name ?? message.model : undefined,
        usage: role === "assistant" ? normalizeUsage(message.usage) : undefined,
      });
    }
    return chats;
  }

  async fork(entryId?: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("fork", entryId ? { entryId } : {}, 120_000);
  }

  async branch(entryId: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("branch", { entryId }, 120_000);
  }

  async navigate(entryId: string, summarize = false): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("navigate_tree", { entryId, summarize }, 180_000);
  }

  async getEntries(): Promise<any[]> {
    await this.ensureStarted();
    const data = await this.client!.request<any>("get_entries", {}, 60_000);
    return Array.isArray(data) ? data : Array.isArray(data?.entries) ? data.entries : [];
  }

  async goal(op: string, objective?: string, tokenBudget?: number): Promise<any> {
    await this.ensureStarted();
    const payload: Record<string, unknown> = { op };
    if (objective) payload.objective = objective;
    if (tokenBudget) payload.token_budget = tokenBudget;
    return this.client!.request("goal", payload, 120_000);
  }

  async exportHtml(outputPath: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("export_html", { outputPath }, 120_000);
  }

  async generateTitle(text: string): Promise<string | undefined> {
    await this.ensureStarted();
    const data = await this.client!.request<any>("get_last_assistant_text").catch(() => null);
    return data?.text;
  }

  async steerSubagent(subagentId: string, message: string): Promise<void> {
    await this.ensureStarted();
    await this.client!.request("steer_subagent", { subagentId, message }, 60_000);
  }

  async cancelSubagent(subagentId: string): Promise<void> {
    await this.ensureStarted();
    await this.client!.request("cancel_subagent", { subagentId }, 30_000);
  }

  async respondUi(id: string, response: any): Promise<void> {
    const pending = this.pendingUi.get(id);
    if (!pending) return;
    const frame = pending.frame;
    let payload: any;
    if (frame.method === "ask") {
      payload = { type: "extension_ui_response", id, answers: normalizeAnswers(frame, response) };
    } else if (frame.method === "confirm") {
      payload = { type: "extension_ui_response", id, confirmed: !!response };
    } else if (frame.method === "select") {
      const index = Number(response);
      const value = Number.isInteger(index) && frame.options?.[index] ? frame.options[index] : String(response);
      payload = { type: "extension_ui_response", id, value };
    } else if (response === null || response === undefined || response === "__cancel__") {
      payload = { type: "extension_ui_response", id, cancelled: true };
    } else {
      payload = { type: "extension_ui_response", id, value: String(response) };
    }
    this.pendingUi.delete(id);
    try {
      this.client?.sendRaw(payload);
    } catch {
      /* ignore */
    }
    pending.resolve(payload);
    this.emit("ui_resolved", id);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const [, pending] of this.pendingUi) pending.resolve({ cancelled: true });
    this.pendingUi.clear();
    await this.client?.close();
    this.client = null;
    this.started = false;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
    if (!this.client?.isRunning) throw new Error("OMP session is not running");
  }

  private handleFrame(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    const type = frame.type;
    if (process.argv.includes("--integration-test") && !["message_update", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "turn_start", "turn_end"].includes(type)) {
      console.log("FRAME", this.thread.id, type, frame.method ?? "", frame.toolName ?? "");
    }
    if (type === "extension_ui_request") {
      this.handleUiRequest(frame);
      return;
    }
    if (type === "message_start") {
      this.handleMessageStart(frame);
      return;
    }
    if (type === "message_update") {
      this.handleMessageUpdate(frame);
      return;
    }
    if (type === "message_end") {
      this.handleMessageEnd(frame);
      return;
    }
    if (type === "tool_execution_start") {
      this.handleToolStart(frame);
      return;
    }
    if (type === "tool_execution_end") {
      this.handleToolEnd(frame);
      return;
    }
    if (type === "agent_start") {
      this.options.onStatus("running", "Working…");
      this.emit("agent_start");
      return;
    }
    if (type === "agent_end") {
      this.handleAgentEnd(frame);
      return;
    }
    if (type === "auto_compaction_start" || type === "manual_compaction_start") {
      const manual = type === "manual_compaction_start";
      this.options.onStatus("running", manual ? "Compacting context…" : "Auto-compacting context…");
      this.emit("compaction", { phase: "start", manual, ...frame });
      return;
    }
    if (type === "auto_compaction_end" || type === "manual_compaction_end") {
      this.emit("compaction", { phase: "end", manual: type === "manual_compaction_end", ...frame });
      if (!frame.aborted) {
        const manual = type === "manual_compaction_end";
        const wasRunning = this.thread.status === "running";
        this.options.onStatus(manual ? "idle" : wasRunning ? "running" : "idle", manual ? "Compacted" : wasRunning ? "Working…" : "Ready");
      }
      return;
    }
    if (type === "turn_end") {
      this.handleTurnEnd(frame);
      return;
    }
    if (type === "prompt_result") {
      this.handlePromptResult(frame);
      return;
    }
    if (type === "session_settled") {
      if (this.thread.status === "running" || this.thread.status === "starting") this.options.onStatus("idle", "Ready");
      this.emit("settled");
      return;
    }
    if (type === "subagent_lifecycle" || type === "subagent_progress" || type === "subagent_event") {
      this.options.onSubagent(frame);
      return;
    }
    if (type === "available_commands_update") {
      this.emit("commands", frame.commands);
      return;
    }
    if (type === "notice") {
      if (frame.message) this.emit("notice", frame.message);
      return;
    }
    if (type === "config_update") {
      this.emit("config", frame);
      return;
    }
    if (type === "host_tool_call") {
      void this.handleHostTool(frame);
    }
  }

  private handleUiRequest(frame: any): void {
    if (process.argv.includes("--integration-test")) {
      console.log("UI_REQUEST", this.thread.id, frame.method, JSON.stringify({ title: frame.title, message: frame.message, options: frame.options, toolName: frame.toolName, questions: frame.questions }).slice(0, 800));
    }
    if (frame.method === "notify") {
      this.emit("notice", frame.message);
      return;
    }
    if (frame.method === "setStatus") {
      this.options.onStatus(this.thread.status, frame.statusText);
      return;
    }
    if (frame.method === "setTitle") {
      this.emit("title", frame.title);
      return;
    }
    if (frame.method === "open_url") {
      this.emit("open_url", frame.url);
      return;
    }
    if (["setWidget", "set_editor_text", "cancel"].includes(frame.method)) return;

    const request: ApprovalRequest = {
      id: frame.id,
      threadId: this.thread.id,
      kind: frame.method,
      title: frame.title || titleForMethod(frame.method),
      message: messageForUi(frame),
      options: (frame.options ?? []).map((label: string, index: number) => ({
        label,
        value: String(index),
        description: frame.optionDetails?.[index]?.description,
      })),
      createdAt: Date.now(),
    };
    (request as any).raw = frame;
    const promise = new Promise<any>((resolve) => {
      this.pendingUi.set(frame.id, { frame, resolve });
    });
    this.emit("ui_request", request, promise);
  }

  private handleHostTool(frame: any): void {
    const run = async () => {
      try {
        const result: HostToolResult = await this.options.hostToolHandler({
          thread: this.thread,
          node: this.node,
          cwd: this.cwd,
          toolName: frame.toolName,
          args: frame.arguments ?? {},
          toolCallId: frame.toolCallId,
          requestId: frame.id,
        });
        this.client?.sendRaw({ type: "host_tool_result", id: frame.id, result: result as any, isError: result.isError });
      } catch (error) {
        this.client?.sendRaw({
          type: "host_tool_result",
          id: frame.id,
          result: { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] },
          isError: true,
        });
      }
    };
    void run();
  }

  private handleMessageStart(frame: any): void {
    const message = frame.message;
    if (!message) return;
    if (message.role === "assistant") {
      const id = String(frame.messageId || message.id || `msg_${randomUUID()}`);
      this.liveAssistantId = id;
      const live: ChatMessage = {
        id,
        threadId: this.thread.id,
        role: "assistant",
        blocks: [],
        timestamp: Date.now(),
        model: this.thread.model.name,
      };
      this.liveMessage = live;
      this.emitChat(live);
    }
  }

  private handleMessageUpdate(frame: any): void {
    if (frame.message?.role === "assistant") {
      if (!this.liveMessage) {
        const id = String(frame.messageId || frame.message.id || `msg_${randomUUID()}`);
        this.liveAssistantId = id;
        this.liveMessage = {
          id,
          threadId: this.thread.id,
          role: "assistant",
          blocks: [],
          timestamp: Date.now(),
          model: this.thread.model.name,
        };
      }
      const live = this.liveMessage;
      live.blocks = normalizeBlocks(frame.message.content);
      capLiveBlocks(live.blocks);
      this.emitChatThrottled(live);
      return;
    }
    const delta = frame.assistantMessageEvent;
    const live = this.liveMessage;
    if (!delta || !live) return;
    const rawIndex = Number(delta.contentIndex);
    const index = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < 200 ? rawIndex : 0;
    const blocks = live.blocks;
    if (delta.type === "text_start") {
      blocks[index] = { type: "text", text: "" };
    } else if (delta.type === "text_delta") {
      const block = blocks[index];
      if (block?.type === "text") {
        if (block.text.length < LIVE_TEXT_LIMIT) block.text += delta.delta ?? "";
      } else blocks[index] = { type: "text", text: (delta.delta ?? "").slice(0, LIVE_TEXT_LIMIT) };
    } else if (delta.type === "thinking_start") {
      blocks[index] = { type: "thinking", text: "" };
    } else if (delta.type === "thinking_delta") {
      const block = blocks[index];
      if (block?.type === "thinking") {
        if (block.text.length < LIVE_THINKING_LIMIT) block.text += delta.delta ?? "";
      } else blocks[index] = { type: "thinking", text: (delta.delta ?? "").slice(0, LIVE_THINKING_LIMIT) };
    }
    this.emitChatThrottled(live);
  }

  private handleMessageEnd(frame: any): void {
    const message = frame.message;
    if (!message) return;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      trace("message-end-start", { blocks: message.content.length });
    }
    const role = message.role;
    if (role === "assistant") {
      const blocks = normalizeBlocks(message.content).filter((block) => block.type === "text" || block.type === "thinking");
      const totalChars = blocks.reduce((sum, block) => sum + ("text" in block ? block.text.length : 0), 0);
      if (totalChars > 500_000) trace("message-large", { role, chars: totalChars, blocks: blocks.length, id: frame.messageId ?? message.id });
      const text = blocks.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n").trim();
      if (text) this.lastAssistantText = text.slice(-8000);
      const id = String(this.liveAssistantId ?? frame.messageId ?? message.id ?? `msg_${randomUUID()}`);
      const chat: ChatMessage = {
        id,
        threadId: this.thread.id,
        role: "assistant",
        blocks,
        timestamp: Date.now(),
        model: this.thread.model.name ?? message.model,
        usage: normalizeUsage(message.usage),
        stopReason: message.stopReason,
      };
      if (blocks.length) this.options.onChat(chat);
      this.liveMessage = null;
      this.liveAssistantId = null;
      if (chat.usage) this.turnUsage = chat.usage;
      return;
    }
    if (role === "user") {
      const blocks = normalizeBlocks(message.content);
      if (!blocks.length) return;
      this.options.onChat({
        id: String(frame.messageId || message.id || `msg_${randomUUID()}`),
        threadId: this.thread.id,
        role: "user",
        blocks,
        timestamp: message.timestamp ?? Date.now(),
      });
      return;
    }
    if (role === "toolResult") {
      const toolCallId = message.toolCallId || message.toolCallID || message.tool_call_id;
      if (toolCallId && this.toolMessages.has(toolCallId)) {
        const id = this.toolMessages.get(toolCallId)!;
        const existing = this.store.getChat(this.thread.id).find((m) => m.id === id);
        if (existing) {
          const block = existing.blocks.find((b) => b.type === "tool" && b.id === toolCallId);
          if (block?.type === "tool") {
            block.status = message.isError ? "error" : "done";
            block.result = textFromContent(message.content).slice(0, 30_000);
            block.endedAt = Date.now();
            this.options.onChat(existing);
          }
        }
      }
    }
  }

  private handleToolStart(frame: any): void {
    const toolCallId = frame.toolCallId;
    if (!toolCallId) return;
    const argChars = approxSize(frame.args);
    if (argChars > 200_000) trace("tool-args-large", { tool: frame.toolName, chars: argChars });
    const id = `tool_${toolCallId}`;
    this.toolMessages.set(toolCallId, id);
    const message: ChatMessage = {
      id,
      threadId: this.thread.id,
      role: "tool",
      blocks: [
        {
          type: "tool",
          id: toolCallId,
          name: frame.toolName,
          args: frame.args,
          status: "running",
          intent: frame.intent,
          startedAt: Date.now(),
        },
      ],
      timestamp: Date.now(),
    };
    this.options.onChat(message);
    this.emit("tool_start", frame);
  }

  private handleToolEnd(frame: any): void {
    const toolCallId = frame.toolCallId;
    if (!toolCallId) return;
    trace("tool-end-start", { tool: frame.toolName, resultType: typeof frame.result, argsType: typeof frame.args });
    const id = this.toolMessages.get(toolCallId) ?? `tool_${toolCallId}`;
    this.toolMessages.set(toolCallId, id);
    const resultText = frame.result ? textFromResult(frame.result) : "";
    if (resultText.length > 200_000) trace("tool-result-large", { tool: frame.toolName, chars: resultText.length });
    const existing = this.store.getChat(this.thread.id).find((m) => m.id === id);
    const message: ChatMessage = existing ?? {
      id,
      threadId: this.thread.id,
      role: "tool",
      blocks: [
        {
          type: "tool",
          id: toolCallId,
          name: frame.toolName,
          args: frame.args,
          status: "done",
          result: "",
          startedAt: Date.now(),
        },
      ],
      timestamp: Date.now(),
    };
    const block = message.blocks.find((b) => b.type === "tool" && b.id === toolCallId);
    if (block?.type === "tool") {
      block.status = frame.isError ? "error" : "done";
      block.result = resultText.slice(0, 30_000);
      block.endedAt = Date.now();
    }
    this.options.onChat(message);

    if (!frame.isError && ["write", "edit", "ast_edit"].includes(frame.toolName)) {
      const path = frame.args?.path ?? frame.args?.file_path ?? frame.args?.filePath;
      if (typeof path === "string") this.options.onToolFile?.(path);
    }
    this.emit("tool_end", frame);
  }

  private handleTurnEnd(frame: any): void {
    const usage = normalizeUsage(frame.message?.usage);
    if (usage) this.turnUsage = usage;
    this.emit("turn_end", frame);
  }

  private handleAgentEnd(frame: any): void {
    this.emit("agent_end", frame);
    void this.refreshState();
  }

  private handlePromptResult(frame: any): void {
    if (frame.status === "error") {
      const message = frame.error?.message ?? "The model request failed";
      this.options.onStatus("error", message);
      this.emit("prompt_result", { ...frame, errorMessage: message });
    } else if (frame.status === "aborted") {
      this.options.onStatus("idle", "Stopped");
      this.emit("prompt_result", frame);
    } else {
      this.emit("prompt_result", frame);
      void this.refreshState();
    }
    this.promptResolve?.(frame.status);
    this.promptResolve = null;
  }

  private async refreshState(): Promise<void> {
    try {
      const state = await this.client?.request("get_state", {}, 30_000);
      if (state) this.applyState(state);
    } catch {
      /* ignore */
    }
  }

  private applyState(state: any): void {
    this.options.onState(state);
    if (state.todoPhases) this.emit("todos", state.todoPhases);
  }

  private emitChat(message: ChatMessage): void {
    this.emit("chat", message);
    this.options.onChat(message);
  }

  private emitChatThrottled(message: ChatMessage): void {
    const now = Date.now();
    if (now - this.lastEmit < 80) return;
    this.lastEmit = now;
    this.emitChat(message);
  }
}

const LIVE_THINKING_LIMIT = 30_000;
const LIVE_TEXT_LIMIT = 200_000;

function approxSize(value: unknown, depth = 0): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (depth > 4) return 32;
  if (Array.isArray(value)) return value.slice(0, 200).reduce((sum, item) => sum + approxSize(item, depth + 1), 0);
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .slice(0, 100)
      .reduce((sum, [key, item]) => sum + key.length + approxSize(item, depth + 1), 0);
  }
  return 16;
}

function capLiveBlocks(blocks: ChatBlock[]): void {
  for (const block of blocks) {
    if (block.type === "thinking" && block.text.length > LIVE_THINKING_LIMIT) block.text = block.text.slice(0, LIVE_THINKING_LIMIT);
    else if (block.type === "text" && block.text.length > LIVE_TEXT_LIMIT) block.text = block.text.slice(0, LIVE_TEXT_LIMIT);
    else if (block.type === "tool" && block.result && block.result.length > 60_000) block.result = block.result.slice(0, 60_000);
  }
}

function normalizeBlocks(content: any): ChatBlock[] {
  if (!content) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks: ChatBlock[] = [];
  for (const item of content.slice(0, 200)) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") blocks.push({ type: "text", text: item.text });
    else if (item.type === "thinking" && typeof item.thinking === "string") {
      blocks.push({ type: "thinking", text: item.thinking, signature: item.thinkingSignature });
    } else if (item.type === "image") {
      blocks.push({
        type: "image",
        mimeType: item.mimeType ?? "image/png",
        data: typeof item.data === "string" && item.data.length > 1_000_000 ? undefined : item.data,
        path: item.path,
      });
    }
  }
  return blocks;
}

function textFromContent(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text")
      .map((item) => item.text)
      .join("\n");
  }
  return "";
}

function textFromResult(result: any): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return textFromContent(result.content);
  if (result.content) return textFromContent(result.content);
  return JSON.stringify(result).slice(0, 10_000);
}

function normalizeUsage(usage: any): ChatUsage | undefined {
  if (!usage) return undefined;
  return {
    input: Number(usage.input) || 0,
    output: Number(usage.output) || 0,
    cacheRead: Number(usage.cacheRead) || 0,
    cacheWrite: Number(usage.cacheWrite) || 0,
    totalTokens: Number(usage.totalTokens) || 0,
  };
}

function titleForMethod(method: string): string {
  switch (method) {
    case "confirm":
      return "Approval required";
    case "select":
      return "Choose an option";
    case "input":
      return "Input required";
    case "editor":
      return "Edit text";
    case "ask":
      return "Question from OMP";
    default:
      return "OMP needs input";
  }
}

function messageForUi(frame: any): string {
  if (frame.method === "confirm") return frame.message ?? "";
  if (frame.method === "input" || frame.method === "editor") return frame.placeholder ?? frame.prefill ?? "";
  if (frame.method === "select") return frame.title ?? "Select an option";
  if (frame.method === "ask") {
    return (frame.questions ?? [])
      .map((q: any) => q.question)
      .join("\n");
  }
  return "";
}

function normalizeAnswers(frame: any, response: any): Array<{ id: string; selectedOptions: string[]; customInput?: string }> {
  const questions: any[] = frame.questions ?? [];
  if (Array.isArray(response)) {
    return questions.map((question, index) => ({
      id: question.id,
      selectedOptions: Array.isArray(response[index]) ? response[index] : response[index] ? [String(response[index])] : [],
    }));
  }
  if (response && typeof response === "object") {
    return questions.map((question) => {
      const value = (response as any)[question.id];
      return {
        id: question.id,
        selectedOptions: Array.isArray(value) ? value : value ? [String(value)] : [],
      };
    });
  }
  return questions.map((question) => ({ id: question.id, selectedOptions: response ? [String(response)] : [] }));
}
