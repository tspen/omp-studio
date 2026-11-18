import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
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
import { PiClient } from "./pi-client";
import { PI_HOST_EXTENSION } from "./pi-extension";
import { trace } from "../diagnostics";

const ROOT_DENIED_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
  "python",
  "notebook",
  "ast_edit",
  "launch",
  "debug",
];
const PROJECT_ORCHESTRATOR_DENIED_TOOLS = ["edit", "write", "notebook", "ast_edit"];
const AUTO_APPROVE_TOOLS = new Set(["read", "grep", "find", "ls"]);

export interface PiSessionOptions {
  store: Store;
  cliPath: string;
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

export class PiSession extends EventEmitter {
  readonly thread: Thread;
  readonly node: TreeNode;
  readonly cwd: string;
  readonly environment?: Environment;
  private store: Store;
  private options: PiSessionOptions;
  private client: PiClient | null = null;
  private bridge: Server | null = null;
  private bridgeToken = randomBytes(24).toString("hex");
  private bridgeUrl = "";
  private started = false;
  private disposed = false;
  private liveAssistantId: string | null = null;
  private liveMessage: ChatMessage | null = null;
  private pendingUi = new Map<string, PendingUi>();
  private lastAssistantText = "";
  private lastEmit = 0;
  private toolMessages = new Map<string, string>();
  private turnUsage: ChatUsage | undefined;
  private lastError: string | null = null;
  private aborted = false;
  private promptWaiting: (() => void) | null = null;

  constructor(options: PiSessionOptions) {
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

    const engineDir = join(this.store.baseDir, "engine");
    mkdirSync(engineDir, { recursive: true });
    const extensionPath = join(engineDir, "perch-host.mjs");
    writeFileSync(extensionPath, PI_HOST_EXTENSION, "utf8");
    const specPath = join(this.thread.sessionDir, "host-tools.json");
    writeFileSync(specPath, JSON.stringify(this.options.hostTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }))), "utf8");

    this.bridge = createServer((request, response) => void this.handleBridge(request, response));
    await new Promise<void>((resolve, reject) => {
      this.bridge!.once("error", reject);
      this.bridge!.listen(0, "127.0.0.1", () => resolve());
    });
    const address = this.bridge.address();
    if (!address || typeof address === "string") throw new Error("Could not start the host tool bridge");
    this.bridgeUrl = `http://127.0.0.1:${address.port}`;

    const hasSession = existsSync(this.thread.sessionDir) && readdirSync(this.thread.sessionDir).some((file) => file.endsWith(".jsonl"));
    const denied = this.deniedTools();
    const policy = Object.fromEntries(denied.map((name) => [name, "deny"]));
    const args = [
      "--session-dir",
      this.thread.sessionDir,
      ...(hasSession ? ["--continue"] : []),
      "--append-system-prompt",
      promptPath,
      "--extension",
      extensionPath,
      "--no-extensions",
      "--no-approve",
      "--thinking",
      this.thread.effort || "medium",
    ];
    if (this.thread.model.selector) args.push("--model", this.thread.model.selector);
    if (this.thread.title && this.thread.title !== "New thread") args.push("--name", this.thread.title);
    if (denied.length) args.push("--exclude-tools", denied.join(","));

    this.client = new PiClient({
      cliPath: this.options.cliPath,
      cwd: this.cwd,
      args,
      env: {
        ...this.options.processEnv,
        PERCH_BRIDGE_URL: this.bridgeUrl,
        PERCH_BRIDGE_TOKEN: this.bridgeToken,
        PERCH_HOST_TOOLS: specPath,
        PERCH_APPROVAL_MODE: this.node.approvalMode || this.store.settings.defaultApprovalMode || "yolo",
        PERCH_TOOL_POLICY: JSON.stringify(policy),
        PI_CODING_AGENT_DIR: join(this.store.baseDir, "pi-agent"),
        PI_TELEMETRY: "0",
        PI_SKIP_VERSION_CHECK: "1",
        PI_OFFLINE: "1",
        PI_NO_TITLE: "1",
      },
      onStderr: (text) => {
        this.options.onStderr?.(text);
        this.emit("stderr", text);
      },
    });
    this.client.on("event", (frame: any) => this.handleEvent(frame));
    this.client.on("ui_request", (frame: any) => this.handleUiRequest(frame));
    this.client.on("exit", (info: any) => {
      const error = info?.code === 0 || this.disposed ? undefined : new Error(`Pi exited with code ${info?.code}`);
      this.options.onExit(error);
      this.emit("exit", error);
    });
    this.client.on("error", (error: Error) => {
      this.options.onExit(error);
      this.emit("error", error);
    });

    this.options.onStatus("starting", "Starting Pi…");
    await this.client.start();
    this.started = true;
    await this.client.request("set_auto_compaction", { enabled: this.store.settings.contextCompaction !== false }).catch(() => undefined);
    await this.client.request("set_auto_retry", { enabled: true }).catch(() => undefined);
    const state = await this.readState().catch(() => null);
    if (state) this.applyState(state);
    this.options.onStatus("idle");
  }

  async prompt(text: string, mode: "prompt" | "steer" | "followUp" = "prompt"): Promise<void> {
    await this.ensureStarted();
    this.lastError = null;
    this.aborted = false;
    if (mode === "steer") {
      await this.client!.request("steer", { message: text }, 120_000);
    } else if (mode === "followUp") {
      await this.client!.request("follow_up", { message: text }, 120_000);
    } else {
      await this.client!.request("prompt", { message: text }, 120_000);
    }
    this.options.onStatus(mode === "prompt" ? "running" : this.thread.status, mode === "prompt" ? "Working…" : undefined);
  }

  async suspend(): Promise<void> {
    if (!this.client?.isRunning) throw new Error("This session has no running turn to pause");
    await this.client.suspend();
    this.options.onStatus("running", "Paused");
  }

  async resume(): Promise<void> {
    if (!this.client?.isRunning) throw new Error("This session is not running");
    await this.client.resume();
    this.options.onStatus("running", "Resumed");
  }

  async abort(): Promise<void> {
    if (!this.client?.isRunning) return;
    this.aborted = true;
    await this.client.request("abort", {}, 30_000).catch(() => undefined);
    this.options.onStatus("idle", "Stopped");
  }

  async setModel(selector: string): Promise<any> {
    await this.ensureStarted();
    const slash = selector.indexOf("/");
    if (slash < 0) throw new Error("Model selector must be provider/model");
    return this.client!.request("set_model", {
      provider: selector.slice(0, slash),
      modelId: selector.slice(slash + 1),
    }, 120_000);
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
    return this.readState();
  }

  async getMessages(): Promise<any[]> {
    await this.ensureStarted();
    const data = await this.client!.request("get_messages", {}, 120_000);
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
    let target = entryId;
    if (!target) {
      const data = await this.client!.request("get_fork_messages", {}, 60_000).catch(() => null);
      target = data?.messages?.[data.messages.length - 1]?.entryId;
    }
    if (target) return this.client!.request("fork", { entryId: target }, 120_000);
    return this.client!.request("clone", {}, 120_000);
  }

  async branch(entryId: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("fork", { entryId }, 120_000);
  }

  async navigate(entryId: string, _summarize = false): Promise<any> {
    await this.ensureStarted();
    // Pi exposes tree navigation in its TUI only. Forking is the closest RPC
    // equivalent and preserves the requested entry as the new leaf.
    return this.client!.request("fork", { entryId }, 180_000);
  }

  async getEntries(): Promise<any[]> {
    await this.ensureStarted();
    const data = await this.client!.request("get_entries", {}, 60_000);
    return Array.isArray(data?.entries) ? data.entries : [];
  }

  async goal(_op: string, _objective?: string, _tokenBudget?: number): Promise<any> {
    return { ok: false, error: "Goal mode is not available in the Pi engine" };
  }

  async exportHtml(outputPath: string): Promise<any> {
    await this.ensureStarted();
    return this.client!.request("export_html", { outputPath }, 120_000);
  }

  async generateTitle(_text: string): Promise<string | undefined> {
    await this.ensureStarted();
    const text = await this.client!.request("get_last_assistant_text", {}, 30_000).catch(() => null);
    return text?.text ?? undefined;
  }

  async steerSubagent(_subagentId: string, _message: string): Promise<void> {
    /* Pi has no native subagents. Perch workers are separate sessions. */
  }

  async cancelSubagent(_subagentId: string): Promise<void> {
    /* Pi has no native subagents. */
  }

  async respondUi(id: string, response: any): Promise<void> {
    const pending = this.pendingUi.get(id);
    if (!pending) return;
    const frame = pending.frame;
    let payload: any;
    if (frame.method === "confirm") {
      payload = { type: "extension_ui_response", id, confirmed: !!response };
    } else if (frame.method === "select" && Number.isInteger(Number(response)) && Array.isArray(frame.options)) {
      payload = { type: "extension_ui_response", id, value: frame.options[Number(response)] ?? String(response) };
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
    await this.client?.stop().catch(() => undefined);
    this.client = null;
    if (this.bridge) {
      await new Promise<void>((resolve) => this.bridge!.close(() => resolve()));
      this.bridge = null;
    }
    this.started = false;
  }

  private async ensureStarted(): Promise<void> {
    if (!this.started) await this.start();
    if (!this.client?.isRunning) throw new Error("Pi session is not running");
  }

  private async readState(): Promise<any> {
    const state = await this.client!.request("get_state", {}, 30_000);
    const stats = await this.client!.request("get_session_stats", {}, 30_000).catch(() => null);
    return {
      ...state,
      contextUsage: stats?.contextUsage,
      totalTokens: stats?.tokens?.total,
      cost: stats?.cost,
    };
  }

  private toolPolicy(): { denied: string[]; policy: Record<string, string> } {
    const denied = new Set(this.deniedTools());
    const policy: Record<string, string> = {};
    for (const [name, override] of Object.entries(this.store.settings.perchTools ?? {})) {
      if (!override?.enabled) denied.add(name);
      if (override?.approval === "deny") policy[name] = "deny";
      else if (override?.approval === "prompt") policy[name] = "prompt";
      else policy[name] = "allow";
    }
    for (const name of denied) policy[name] = "deny";
    return { denied: [...denied], policy };
  }
  private deniedTools(): string[] {
    if (this.thread.kind !== "orchestrator") return [];
    if (this.node.type === "root" || this.node.type === "group") return ROOT_DENIED_TOOLS;
    if (this.node.type === "project") return PROJECT_ORCHESTRATOR_DENIED_TOOLS;
    return [];
  }

  private handleEvent(frame: any): void {
    if (!frame || typeof frame !== "object") return;
    switch (frame.type) {
      case "message_start":
        this.handleMessageStart(frame);
        return;
      case "message_update":
        this.handleMessageUpdate(frame);
        return;
      case "message_end":
        this.handleMessageEnd(frame);
        return;
      case "tool_execution_start":
        this.handleToolStart(frame);
        return;
      case "tool_execution_end":
        this.handleToolEnd(frame);
        return;
      case "agent_start":
        this.options.onStatus("running", "Working…");
        this.emit("agent_start");
        return;
      case "agent_end":
        this.emit("agent_end", frame);
        return;
      case "agent_settled":
        this.handleSettled(frame);
        return;
      case "compaction_start": {
        const manual = frame.reason === "manual";
        this.options.onStatus("running", manual ? "Compacting context…" : "Auto-compacting context…");
        this.emit("compaction", { phase: "start", manual, ...frame });
        return;
      }
      case "compaction_end": {
        const manual = frame.reason === "manual";
        this.emit("compaction", { phase: "end", manual, ...frame });
        if (!frame.aborted && !frame.errorMessage) {
          const wasRunning = this.thread.status === "running";
          this.options.onStatus(manual ? "idle" : wasRunning ? "running" : "idle", manual ? "Compacted" : wasRunning ? "Working…" : "Ready");
        }
        return;
      }
      case "turn_end":
        this.handleTurnEnd(frame);
        return;
      case "session_info_changed":
        if (frame.name) this.emit("title", frame.name);
        return;
      case "auto_retry_start":
        this.options.onStatus("running", `Retrying (${frame.attempt}/${frame.maxAttempts})…`);
        return;
      case "auto_retry_end":
        if (frame.success === false && frame.finalError) {
          this.lastError = String(frame.finalError);
          this.options.onStatus("error", this.lastError ?? undefined);
        }
        return;
      case "extension_error":
        if (frame.error) this.emit("notice", String(frame.error));
        return;
      default:
        return;
    }
  }

  private handleUiRequest(frame: any): void {
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

  private handleMessageStart(frame: any): void {
    const message = frame.message;
    if (!message) return;
    if (message.role === "assistant") {
      const id = String(message.id || `msg_${randomUUID()}`);
      this.liveAssistantId = id;
      this.liveMessage = {
        id,
        threadId: this.thread.id,
        role: "assistant",
        blocks: [],
        timestamp: Date.now(),
        model: this.thread.model.name,
      };
      this.emitChat(this.liveMessage);
    }
  }

  private handleMessageUpdate(frame: any): void {
    const delta = frame.assistantMessageEvent;
    if (!delta) return;
    if (!this.liveMessage) {
      const id = `msg_${randomUUID()}`;
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
    const rawIndex = Number(delta.contentIndex);
    const index = Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < 200 ? rawIndex : 0;
    const blocks = live.blocks;
    if (delta.type === "text_start") {
      blocks[index] = { type: "text", text: "" };
    } else if (delta.type === "text_delta") {
      const block = blocks[index];
      if (block?.type === "text") {
        if (block.text.length < LIVE_TEXT_LIMIT) block.text += delta.delta ?? "";
      } else blocks[index] = { type: "text", text: String(delta.delta ?? "").slice(0, LIVE_TEXT_LIMIT) };
    } else if (delta.type === "thinking_start") {
      blocks[index] = { type: "thinking", text: "" };
    } else if (delta.type === "thinking_delta") {
      const block = blocks[index];
      if (block?.type === "thinking") {
        if (block.text.length < LIVE_THINKING_LIMIT) block.text += delta.delta ?? "";
      } else blocks[index] = { type: "thinking", text: String(delta.delta ?? "").slice(0, LIVE_THINKING_LIMIT) };
    } else if (delta.type === "text_end" && typeof delta.content === "string") {
      blocks[index] = { type: "text", text: delta.content };
    } else if (delta.type === "thinking_end" && typeof delta.content === "string") {
      blocks[index] = { type: "thinking", text: delta.content };
    }
    this.emitChatThrottled(live);
  }

  private handleMessageEnd(frame: any): void {
    const message = frame.message;
    if (!message) return;
    const role = message.role;
    if (role === "assistant") {
      const blocks = normalizeBlocks(message.content).filter((block) => block.type === "text" || block.type === "thinking" || block.type === "image");
      for (const block of blocks) if (block.type === "image" && block.path) this.options.onToolFile?.(block.path);
      const text = blocks.filter((b) => b.type === "text").map((b) => (b as any).text).join("\n").trim();
      if (text) this.lastAssistantText = text.slice(-8000);
      if (message.stopReason === "error") {
        this.lastError = message.errorMessage || "The model request failed";
        this.options.onStatus("error", this.lastError ?? undefined);
      } else if (message.stopReason === "aborted") {
        this.aborted = true;
      }
      const id = String(this.liveAssistantId ?? `msg_${randomUUID()}`);
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
      for (const block of blocks) if (block.type === "image" && block.path) this.options.onToolFile?.(block.path);
      this.options.onChat({
        id: String(message.id || `msg_${randomUUID()}`),
        threadId: this.thread.id,
        role: "user",
        blocks,
        timestamp: message.timestamp ?? Date.now(),
      });
      return;
    }
    if (role === "toolResult") {
      const toolCallId = message.toolCallId;
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
    const id = `tool_${toolCallId}`;
    this.toolMessages.set(toolCallId, id);
    this.options.onChat({
      id,
      threadId: this.thread.id,
      role: "tool",
      blocks: [{
        type: "tool",
        id: toolCallId,
        name: frame.toolName,
        args: frame.args,
        status: "running",
        startedAt: Date.now(),
      }],
      timestamp: Date.now(),
    });
    this.emit("tool_start", frame);
  }

  private handleToolEnd(frame: any): void {
    const toolCallId = frame.toolCallId;
    if (!toolCallId) return;
    const id = this.toolMessages.get(toolCallId) ?? `tool_${toolCallId}`;
    this.toolMessages.set(toolCallId, id);
    const resultText = frame.result ? textFromResult(frame.result) : "";
    const existing = this.store.getChat(this.thread.id).find((m) => m.id === id);
    const message: ChatMessage = existing ?? {
      id,
      threadId: this.thread.id,
      role: "tool",
      blocks: [{
        type: "tool",
        id: toolCallId,
        name: frame.toolName,
        args: frame.args,
        status: "done",
        result: "",
        startedAt: Date.now(),
      }],
      timestamp: Date.now(),
    };
    const block = message.blocks.find((b) => b.type === "tool" && b.id === toolCallId);
    if (block?.type === "tool") {
      block.status = frame.isError ? "error" : "done";
      block.result = resultText.slice(0, 30_000);
      block.endedAt = Date.now();
    }
    this.options.onChat(message);
    if (!frame.isError && ["write", "edit"].includes(frame.toolName)) {
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

  private handleSettled(frame: any): void {
    const error = this.lastError;
    if (error) {
      this.emit("prompt_result", { status: "error", error: { message: error } });
    } else if (frame?.aborted || this.aborted) {
      this.options.onStatus("idle", "Stopped");
      this.emit("prompt_result", { status: "aborted" });
    } else {
      if (this.thread.status === "running" || this.thread.status === "starting") this.options.onStatus("idle", "Ready");
      this.emit("prompt_result", { status: "success" });
    }
    this.promptWaiting?.();
    this.promptWaiting = null;
    this.emit("settled");
    void this.refreshState();
  }

  private async refreshState(): Promise<void> {
    try {
      const state = await this.readState();
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

  private async handleBridge(request: any, response: any): Promise<void> {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const auth = String(request.headers.authorization ?? "");
      if (auth !== `Bearer ${this.bridgeToken}`) return send(403, { error: "Forbidden" });
      if (request.method !== "POST") return send(405, { error: "Method not allowed" });
      let raw = "";
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) return send(413, { error: "Payload too large" });
      }
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === "/event") {
        if (body.type === "session_start" && body.sessionFile) {
          this.emit("session_file", body.sessionFile);
        }
        return send(200, { ok: true });
      }
      if (url.pathname !== "/tool") return send(404, { error: "Not found" });
      const result = await this.options.hostToolHandler({
        thread: this.thread,
        node: this.node,
        cwd: this.cwd,
        toolName: String(body.toolName ?? ""),
        args: body.args ?? {},
        toolCallId: String(body.toolCallId ?? ""),
        requestId: String(body.toolCallId ?? ""),
      });
      send(200, { result });
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

const LIVE_THINKING_LIMIT = 30_000;
const LIVE_TEXT_LIMIT = 200_000;

function capLiveBlocks(blocks: ChatBlock[]): void {
  for (const block of blocks) {
    if (block.type === "thinking" && block.text.length > LIVE_THINKING_LIMIT) block.text = block.text.slice(0, LIVE_THINKING_LIMIT);
    else if (block.type === "text" && block.text.length > LIVE_TEXT_LIMIT) block.text = block.text.slice(0, LIVE_TEXT_LIMIT);
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
        data: typeof item.data === "string" && item.data.length > 6_000_000 ? undefined : item.data,
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
    case "confirm": return "Approval required";
    case "select": return "Choose an option";
    case "input": return "Input required";
    case "editor": return "Edit text";
    default: return "Pi needs input";
  }
}

function messageForUi(frame: any): string {
  if (frame.method === "confirm") return frame.message ?? "";
  if (frame.method === "input" || frame.method === "editor") return frame.placeholder ?? frame.prefill ?? "";
  if (frame.method === "select") return frame.title ?? "Select an option";
  return "";
}



