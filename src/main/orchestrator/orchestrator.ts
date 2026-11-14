import { EventEmitter } from "node:events";
import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppEvent,
  ApprovalRequest,
  Artifact,
  ChatMessage,
  Envelope,
  EnvelopeKind,
  Environment,
  GitMode,
  MemoryEntry,
  ModelInfo,
  NewNodeRequest,
  NewThreadRequest,
  Priority,
  SendMessageRequest,
  Snapshot,
  Thread,
  ThreadStatus,
  TreeNode,
} from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import { OmpSession } from "../engine/session";
import type { HostToolContext, HostToolHandler, HostToolResult } from "./host-tools";
import { HOST_TOOL_DEFINITIONS } from "./host-tools";
import { MessageBus } from "./message-bus";
import { buildSystemPrompt } from "./prompts";
import type { ArtifactService } from "../services/artifacts";
import type { EnvironmentService } from "../services/environment";
import type { GitService } from "../services/git";
import type { MemoryService } from "../services/memory";
import type { ModelService } from "../services/models";
import type { NamingService } from "../services/naming";
import type { NotificationService } from "../services/notifications";
import type { ShareService } from "../services/share";
import type { SettingsService } from "../services/settings";
import type { Store } from "../services/store";
import { newId } from "../services/store";

export interface OrchestratorDeps {
  store: Store;
  engine: EngineLocator;
  environments: EnvironmentService;
  memory: MemoryService;
  models: ModelService;
  naming: NamingService;
  git: GitService;
  artifacts: ArtifactService;
  notifications: NotificationService;
  settings: SettingsService;
  share: ShareService;
  emit: (event: AppEvent) => void;
}

export class Orchestrator extends EventEmitter {
  private deps: OrchestratorDeps;
  private store: Store;
  private sessions = new Map<string, OmpSession>();
  private approvals = new Map<string, { threadId: string; session: OmpSession }>();
  private starting = new Map<string, Promise<OmpSession>>();
  private gitTimers = new Map<string, NodeJS.Timeout>();
  private autoContinueTimers = new Map<string, NodeJS.Timeout>();
  private digestTimer: NodeJS.Timeout | null = null;
  private parkingTimer: NodeJS.Timeout | null = null;
  private bus: MessageBus;
  private closed = false;

  constructor(deps: OrchestratorDeps) {
    super();
    this.deps = deps;
    this.store = deps.store;
    this.bus = new MessageBus({
      store: deps.store,
      deliver: (envelope) => this.deliverEnvelope(envelope),
      notifyQuestion: (envelope) => {
        this.deps.notifications.notify({
          kind: "input_required",
          title: "Decision needed",
          body: `[${envelope.direction}] ${envelope.subject}`,
          nodeId: envelope.toNodeId,
          threadId: envelope.toThreadId,
        });
      },
    });
    this.bus.on("new", (envelope: Envelope) => this.deps.emit({ type: "envelope:new", payload: envelope }));
    this.bus.on("updated", (envelope: Envelope) => this.deps.emit({ type: "envelope:updated", payload: envelope }));
  }

  async init(): Promise<void> {
    this.ensureRoot();
    for (const node of this.store.nodes) this.ensureNodeThread(node);
    this.recomputeUsage();
    this.startDigestTimer();
    this.parkingTimer = setInterval(() => void this.parkIdleSessions(), 60_000);
  }

  private async parkIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [threadId, session] of this.sessions) {
      const thread = this.store.getThread(threadId);
      if (!thread) continue;
      if (!["idle", "parked"].includes(thread.status)) continue;
      if (now - thread.lastActivityAt < 10 * 60_000) continue;
      await this.disposeSession(threadId).catch(() => undefined);
    }
  }

  applyDefaultsToEmptyTree(): void {
    for (const node of this.store.nodes) {
      if (node.type !== "root" && node.type !== "group" && node.type !== "project") continue;
      const thread = this.store.getThread(node.orchestratorThreadId);
      if (!thread || thread.modelManual || this.store.getChat(thread.id).length > 0) continue;
      if (!["idle", "parked"].includes(thread.status)) continue;
      const selector = node.type === "root" ? this.store.settings.models.root : node.type === "group" ? this.store.settings.models.group : this.store.settings.models.project;
      const model = this.deps.models.resolve(selector);
      if (!model) continue;
      const effort = normalizeEffort(thread.effort, model);
      const updatedNode = this.store.updateNode(node.id, { model: model.selector, effort });
      const updatedThread = this.store.updateThread(thread.id, {
        model: { provider: model.provider, id: model.id, selector: model.selector, name: model.name },
        effort,
      });
      this.deps.emit({ type: "node:updated", payload: updatedNode });
      this.deps.emit({ type: "thread:updated", payload: updatedThread });
    }
  }

  private ensureRoot(): void {
    const rootPath = join(this.store.baseDir, "workspaces", "root");
    mkdirSync(rootPath, { recursive: true });
    let root = this.store.nodes.find((node) => node.type === "root");
    if (!root) {
      const now = Date.now();
      const model = this.deps.models.resolve(this.store.settings.models.root) ?? this.deps.models.list()[0];
      const threadId = newId("thr");
      root = {
        id: "root",
        type: "root",
        name: "Mission Control",
        parentId: null,
        path: rootPath,
        orchestratorThreadId: threadId,
        model: model?.selector ?? "",
        effort: "high",
        gitMode: "shared",
        approvalMode: "write",
        collapsed: false,
        muted: false,
        autoName: false,
        createdAt: now,
        updatedAt: now,
      };
      this.store.addNode(root);
      this.store.addThread(this.makeThread({
        id: threadId,
        nodeId: root.id,
        parentThreadId: null,
        kind: "orchestrator",
        title: "Mission Control",
        model: model?.selector ?? "",
        effort: "high",
        sessionDir: join(this.store.sessionsDir, "root"),
        status: "idle",
      }));
    } else if (!this.store.getThread(root.orchestratorThreadId)) {
      const model = this.deps.models.resolve(root.model) ?? this.deps.models.list()[0];
      this.store.addThread(this.makeThread({
        id: root.orchestratorThreadId,
        nodeId: root.id,
        parentThreadId: null,
        kind: "orchestrator",
        title: root.name,
        model: model?.selector ?? "",
        effort: root.effort,
        sessionDir: join(this.store.sessionsDir, "root"),
        status: "idle",
      }));
    }
  }

  private ensureNodeThread(node: TreeNode): void {
    if (this.store.getThread(node.orchestratorThreadId)) return;
    const model = this.deps.models.resolve(node.model) ?? this.deps.models.list()[0];
    this.store.addThread(this.makeThread({
      id: node.orchestratorThreadId,
      nodeId: node.id,
      parentThreadId: node.parentId ? (this.store.getNode(node.parentId)?.orchestratorThreadId ?? null) : null,
      kind: "orchestrator",
      title: node.name,
      model: model?.selector ?? "",
      effort: node.effort,
      sessionDir: join(this.store.sessionsDir, node.id),
      status: "idle",
    }));
  }

  private makeThread(input: {
    id?: string;
    nodeId: string;
    parentThreadId: string | null;
    kind: Thread["kind"];
    title: string;
    model: string;
    effort: string;
    sessionDir: string;
    status?: ThreadStatus;
    modelManual?: boolean;
    branch?: string;
    baseBranch?: string;
    worktreePath?: string;
    titleAuto?: boolean;
    source?: Thread["source"];
    ompSubagentId?: string;
    sessionFile?: string;
  }): Thread {
    const now = Date.now();
    const model = this.deps.models.resolve(input.model) ?? this.deps.models.list()[0];
    return {
      id: input.id ?? newId("thr"),
      nodeId: input.nodeId,
      parentThreadId: input.parentThreadId,
      kind: input.kind,
      title: input.title,
      titleAuto: input.titleAuto ?? true,
      status: input.status ?? "idle",
      model: {
        provider: model?.provider ?? "",
        id: model?.id ?? "",
        selector: model?.selector ?? input.model,
        name: model?.name ?? input.model,
      },
      modelManual: input.modelManual,
      effort: normalizeEffort(input.effort || "medium", model),
      sessionDir: input.sessionDir,
      sessionFile: input.sessionFile,
      ompSubagentId: input.ompSubagentId,
      branch: input.branch,
      baseBranch: input.baseBranch,
      worktreePath: input.worktreePath,
      lastActivityAt: now,
      createdAt: now,
      updatedAt: now,
      unread: 0,
      pinned: false,
      archived: false,
      muted: false,
      cost: 0,
      tokens: 0,
      todoPhases: [],
      source: input.source ?? "app",
    };
  }

  snapshot(): Snapshot {
    const pending = this.store.listEnvelopes({ limit: 2000 }).filter(
      (envelope) => envelope.requiresResponse && !["answered", "cancelled", "expired"].includes(envelope.status),
    );
    const latest = this.store.latestEnvelopes(160);
    return this.store.snapshot({
      inbox: pending.slice(-200),
      latestEnvelopes: latest,
      share: this.deps.share.current(),
    });
  }

  getEnvelopes(filter: { threadId?: string; nodeId?: string; traceId?: string; limit?: number }): Envelope[] {
    return this.store.listEnvelopes(filter);
  }

  getChat(threadId: string): ChatMessage[] {
    return this.store.getChat(threadId);
  }

  async createNode(input: NewNodeRequest): Promise<TreeNode> {
    const parent = this.store.getNode(input.parentId) ?? this.store.nodes.find((n) => n.type === "root");
    if (!parent) throw new Error("Root node is missing");
    if (parent.type === "project") throw new Error("A project cannot create child nodes");
    const type = input.type;
    const autoName = !input.name?.trim();
    const name = input.name.trim() || (type === "group" ? "New group" : "New project");
    const path = input.path?.trim() || join(this.store.baseDir, "workspaces", type === "group" ? "groups" : "projects", `${slug(name)}-${randomUUID().slice(0, 6)}`);
    mkdirSync(path, { recursive: true });
    if (type === "project" && input.gitInit && !(await this.deps.git.isRepo(path))) {
      await this.deps.git.run(path, ["init"]);
    }
    const modelSelector = input.model || (type === "group" ? this.store.settings.models.group : this.store.settings.models.project) || parent.model;
    const model = this.deps.models.resolve(modelSelector) ?? this.deps.models.list()[0];
    const threadId = newId("thr");
    const now = Date.now();
    const node: TreeNode = {
      id: newId(type === "group" ? "grp" : "prj"),
      type,
      name,
      parentId: parent.id,
      path,
      repoPath: type === "project" ? ((await this.deps.git.root(path)) ?? path) : undefined,
      environmentId: input.environmentId ?? parent.environmentId,
      orchestratorThreadId: threadId,
      model: model?.selector ?? "",
      effort: input.effort || "high",
      gitMode: type === "project" ? this.store.settings.git.defaultMode : "shared",
      approvalMode: input.approvalMode ?? "write",
      collapsed: false,
      muted: false,
      autoName,
      createdAt: now,
      updatedAt: now,
    };
    this.store.addNode(node);
    const thread = this.makeThread({
      id: threadId,
      nodeId: node.id,
      parentThreadId: parent.orchestratorThreadId,
      kind: "orchestrator",
      title: name,
      model: node.model,
      effort: node.effort,
      sessionDir: join(this.store.sessionsDir, node.id),
      status: "idle",
      titleAuto: false,
      modelManual: !!input.model,
    });
    this.store.addThread(thread);
    this.deps.emit({ type: "node:updated", payload: node });
    this.deps.emit({ type: "thread:updated", payload: thread });
    if (autoName) this.deps.naming.autoNameNode(node.id, input.brief?.trim() || `${type} ${name}`);
    if (parent.autoName && /^New group$/i.test(parent.name)) this.deps.naming.autoNameNode(parent.id, `Group containing ${name}`);

    if (input.brief?.trim()) {
      const trace = this.bus.createTrace({
        title: this.deps.naming.heuristicTitle(input.brief, name),
        prompt: input.brief,
        nodeId: parent.id,
        threadId: parent.orchestratorThreadId,
      });
      await this.bus.send({
        fromThreadId: parent.orchestratorThreadId,
        toThreadId: thread.id,
        kind: "task",
        subject: `Set up ${type} ${name}`,
        body: input.brief,
        traceId: trace.id,
        priority: "high",
      });
    }
    return node;
  }

  async createThread(input: NewThreadRequest): Promise<Thread> {
    const node = this.store.getNode(input.nodeId);
    if (!node) throw new Error(`Node not found: ${input.nodeId}`);
    const parent = input.parentThreadId ? this.store.getThread(input.parentThreadId) : this.store.getThread(node.orchestratorThreadId);
    if (!parent) throw new Error("Parent thread not found");
    const title = input.title?.trim() || this.deps.naming.suggestTitle(input.brief, "New thread");
    const modelSelector = input.model || this.store.settings.models.worker || node.model;
    const model = this.deps.models.resolve(modelSelector) ?? this.deps.models.list()[0];
    const threadId = newId("thr");
    const isolation = input.isolation || (node.type === "project" ? node.gitMode : this.store.settings.git.defaultMode);
    let worktreePath: string | undefined;
    let branch: string | undefined;
    let baseBranch: string | undefined;
    let isolationUsed: GitMode = "shared";

    if (node.type === "project" && node.repoPath && isolation !== "shared") {
      if (await this.deps.git.isRepo(node.repoPath)) {
        branch = `${this.store.settings.git.branchPrefix}/${slug(title)}-${threadId.slice(-6)}`;
        worktreePath = join(this.store.worktreesDir, threadId);
        baseBranch = (await this.deps.git.branch(node.repoPath)) || "HEAD";
        const worktree = await this.deps.git.addWorktree(node.repoPath, worktreePath, branch, baseBranch);
        if (worktree.code === 0) {
          isolationUsed = isolation === "branch" ? "branch" : "worktree";
        } else {
          worktreePath = undefined;
          branch = undefined;
          isolationUsed = "shared";
        }
      }
    }

    const thread = this.makeThread({
      id: threadId,
      nodeId: node.id,
      parentThreadId: parent.id,
      kind: "worker",
      title,
      model: model?.selector ?? "",
      effort: input.effort || "high",
      sessionDir: join(this.store.sessionsDir, threadId),
      status: "queued",
      branch,
      baseBranch,
      worktreePath,
      modelManual: !!input.model,
    });
    thread.environmentId = input.environmentId ?? node.environmentId;
    thread.git = worktreePath ? { ...(await this.deps.git.status(worktreePath)), worktreePath, baseBranch, isolation: isolationUsed } : undefined;
    this.store.addThread(thread);
    this.deps.emit({ type: "thread:updated", payload: thread });

    const trace = this.bus.createTrace({
      title,
      prompt: input.brief,
      nodeId: node.id,
      threadId: parent.id,
    });
    thread.traceId = trace.id;
    this.store.updateThread(thread.id, { traceId: trace.id });
    await this.bus.send({
      fromThreadId: parent.id,
      toThreadId: thread.id,
      kind: "task",
      subject: title,
      body: input.brief,
      traceId: trace.id,
      priority: "high",
    });
    if (input.wait) await this.waitForThreads([thread.id], 15 * 60_000);
    return this.store.getThread(thread.id)!;
  }

  async sendUserMessage(request: SendMessageRequest): Promise<void> {
    const thread = this.store.getThread(request.threadId);
    if (!thread) throw new Error("Thread not found");
    const text = request.text.trim();
    if (!text) return;
    let traceId = request.traceId;
    if (!traceId) {
      const trace = this.bus.createTrace({
        title: this.deps.naming.heuristicTitle(text, thread.title),
        prompt: text,
        nodeId: thread.nodeId,
        threadId: thread.id,
      });
      traceId = trace.id;
      this.store.updateThread(thread.id, { traceId });
    }
    await this.bus.send({
      fromThreadId: "user",
      fromNodeId: thread.nodeId,
      toThreadId: thread.id,
      kind: "task",
      subject: this.deps.naming.heuristicTitle(text, "User request"),
      body: text,
      traceId,
      priority: "high",
    });
  }

  async stopThread(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) await session.abort();
    this.updateStatus(threadId, "idle", "Stopped");
  }

  async restartThread(threadId: string): Promise<void> {
    await this.disposeSession(threadId);
    await this.ensureSession(threadId);
  }

  async setThreadModel(threadId: string, selector: string): Promise<Thread> {
    const model = this.deps.models.resolve(selector);
    if (!model) throw new Error(`Model not found: ${selector}`);
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const session = this.sessions.get(threadId);
    if (session?.isRunning) await session.setModel(model.selector);
    const updated = this.store.updateThread(threadId, {
      model: { provider: model.provider, id: model.id, selector: model.selector, name: model.name },
      modelManual: true,
    });
    this.deps.emit({ type: "thread:updated", payload: updated });
    return updated;
  }

  async setThreadEffort(threadId: string, effort: string): Promise<Thread> {
    const session = this.sessions.get(threadId);
    if (session?.isRunning) await session.setThinking(effort);
    const updated = this.store.updateThread(threadId, { effort });
    this.deps.emit({ type: "thread:updated", payload: updated });
    return updated;
  }

  async forkThread(threadId: string, entryId?: string): Promise<Thread> {
    const session = await this.ensureSession(threadId);
    await session.fork(entryId);
    const state = await session.getState().catch(() => null);
    const restored = await session.restoredChat().catch(() => []);
    if (restored.length) this.store.replaceChat(threadId, restored);
    const updated = this.store.updateThread(threadId, {
      sessionFile: state?.sessionFile,
      title: `Fork · ${this.store.getThread(threadId)?.title ?? "thread"}`,
      titleAuto: false,
    });
    this.deps.emit({ type: "thread:updated", payload: updated });
    return updated;
  }

  async branchThread(threadId: string, entryId: string): Promise<Thread> {
    const session = await this.ensureSession(threadId);
    await session.branch(entryId);
    const state = await session.getState().catch(() => null);
    const restored = await session.restoredChat().catch(() => []);
    if (restored.length) this.store.replaceChat(threadId, restored);
    const updated = this.store.updateThread(threadId, { sessionFile: state?.sessionFile });
    this.deps.emit({ type: "thread:updated", payload: updated });
    return updated;
  }

  async navigateThread(threadId: string, entryId: string, summarize = false): Promise<void> {
    const session = await this.ensureSession(threadId);
    await session.navigate(entryId, summarize);
    const restored = await session.restoredChat().catch(() => []);
    if (restored.length) this.store.replaceChat(threadId, restored);
  }

  async getThreadEntries(threadId: string): Promise<any[]> {
    const session = await this.ensureSession(threadId);
    const entries = await session.getEntries();
    return entries.map((entry) => {
      const message = entry.message ?? entry;
      const content = message?.content;
      let text = "";
      if (typeof content === "string") text = content;
      else if (Array.isArray(content)) {
        text = content
          .map((block: any) => (block?.type === "text" ? block.text : block?.type === "thinking" ? `[thinking] ${block.thinking ?? ""}` : ""))
          .filter(Boolean)
          .join("\n");
      }
      return {
        id: entry.id,
        type: entry.type ?? message?.role ?? "entry",
        role: message?.role,
        text: text.slice(0, 4000),
        timestamp: entry.timestamp ?? message?.timestamp ?? Date.now(),
        raw: entry,
      };
    });
  }

  async goalThread(threadId: string, op: "get" | "create" | "resume" | "pause" | "drop", objective?: string, tokenBudget?: number): Promise<any> {
    const session = await this.ensureSession(threadId);
    return session.goal(op, objective, tokenBudget);
  }

  async exportThread(threadId: string): Promise<{ path: string }> {
    const session = await this.ensureSession(threadId);
    const path = join(this.store.shareDir, `${threadId}-${Date.now()}.html`);
    await session.exportHtml(path);
    const thread = this.store.getThread(threadId);
    if (thread) this.deps.artifacts.recordReport(thread, basename(path), path);
    return { path };
  }

  async sendEnvelope(input: {
    fromThreadId: string;
    toThreadId: string;
    kind: EnvelopeKind;
    subject: string;
    body: string;
    priority?: Priority;
    requiresResponse?: boolean;
    traceId?: string;
  }): Promise<Envelope> {
    return this.bus.send(input);
  }

  async answerEnvelope(id: string, body: string): Promise<void> {
    const envelope = this.store.getEnvelope(id);
    if (!envelope) throw new Error("Message not found");
    const from = this.store.getThread(envelope.toThreadId);
    if (!from) throw new Error("Thread not found");
    await this.bus.answer(id, body, from.id);
  }

  markEnvelopeRead(id: string): void {
    this.bus.markRead(id);
  }

  async respondApproval(id: string, response: unknown): Promise<void> {
    const entry = this.approvals.get(id);
    if (!entry) return;
    await entry.session.respondUi(id, response);
    this.approvals.delete(id);
    const thread = this.store.getThread(entry.threadId);
    if (thread) this.store.updateThread(thread.id, { pendingApproval: undefined });
    this.deps.emit({ type: "approval:resolved", payload: { id } });
  }

  async memoryList(nodeId: string, query?: string): Promise<MemoryEntry[]> {
    return this.deps.memory.recall(nodeId, query ?? "", 200);
  }

  addMemory(nodeId: string, text: string, tags?: string[], importance?: number): MemoryEntry {
    return this.deps.memory.add({ nodeId, text, tags, importance, source: "user" });
  }

  updateMemory(id: string, patch: Partial<MemoryEntry>): MemoryEntry {
    return this.deps.memory.update(id, patch);
  }

  deleteMemory(id: string): void {
    this.deps.memory.remove(id);
  }

  consolidateMemory(nodeId: string): MemoryEntry[] {
    return this.deps.memory.consolidate(nodeId);
  }

  async gitStatus(nodeId: string, threadId?: string): Promise<any> {
    const thread = threadId ? this.store.getThread(threadId) : undefined;
    const node = this.store.getNode(nodeId);
    const path = thread?.worktreePath || node?.repoPath || node?.path;
    if (!path) throw new Error("No path");
    const status = await this.deps.git.status(path);
    if (thread) {
      const updated = this.store.updateThread(thread.id, {
        git: { ...status, worktreePath: thread.worktreePath, baseBranch: thread.baseBranch, isolation: thread.worktreePath ? "worktree" : "shared" },
      });
      this.deps.emit({ type: "thread:updated", payload: updated });
    }
    return status;
  }

  async gitDiff(nodeId: string, threadId?: string, file?: string): Promise<string> {
    const thread = threadId ? this.store.getThread(threadId) : undefined;
    const node = this.store.getNode(nodeId);
    const path = thread?.worktreePath || node?.repoPath || node?.path;
    if (!path) return "";
    return this.deps.git.diff(path, file);
  }

  async gitCommit(nodeId: string, threadId: string | undefined, message: string, paths?: string[]): Promise<{ ok: boolean; output: string }> {
    const thread = threadId ? this.store.getThread(threadId) : undefined;
    const node = this.store.getNode(nodeId);
    const path = thread?.worktreePath || node?.repoPath || node?.path;
    if (!path) return { ok: false, output: "No repository path" };
    const result = await this.deps.git.commit(path, message, paths);
    if (thread) await this.gitStatus(nodeId, threadId);
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
  }

  async gitMerge(nodeId: string, threadId: string): Promise<{ ok: boolean; output: string; conflicts: string[] }> {
    const thread = this.store.getThread(threadId);
    const node = this.store.getNode(nodeId);
    if (!thread?.branch || !node?.repoPath) return { ok: false, output: "Thread has no branch", conflicts: [] };
    const result = await this.deps.git.merge(node.repoPath, thread.branch);
    const status = await this.deps.git.status(node.repoPath);
    const conflicts = status.files.filter((file) => /U|AA|DD/.test(`${file.index}${file.worktree}`)).map((file) => file.path);
    if (conflicts.length) {
      this.deps.notifications.notify({
        kind: "merge_conflict",
        title: "Merge conflict",
        body: `${thread.title} conflicts in ${conflicts.length} file(s)`,
        nodeId,
        threadId,
      });
    }
    await this.gitStatus(nodeId);
    return { ok: result.code === 0 && conflicts.length === 0, output: `${result.stdout}\n${result.stderr}`.trim(), conflicts };
  }

  async gitCreatePr(nodeId: string, threadId: string, title: string, body: string): Promise<{ ok: boolean; output: string; url?: string }> {
    const thread = this.store.getThread(threadId);
    const node = this.store.getNode(nodeId);
    const cwd = thread?.worktreePath || node?.repoPath;
    if (!cwd) return { ok: false, output: "No repository path" };
    const result = await this.deps.git.createPr(cwd, title, body);
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim(), url: result.url };
  }

  async gitDiscard(nodeId: string, threadId: string): Promise<{ ok: boolean; output: string }> {
    const thread = this.store.getThread(threadId);
    if (!thread?.worktreePath) return { ok: false, output: "Thread is not isolated" };
    const result = await this.deps.git.discard(thread.worktreePath);
    await this.gitStatus(nodeId, threadId);
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() };
  }

  async deleteNode(id: string): Promise<void> {
    if (id === "root") throw new Error("Cannot delete the root node");
    const node = this.store.getNode(id);
    if (!node) return;
    const descendants = this.descendantNodes(id);
    for (const descendant of [...descendants, node]) {
      for (const thread of this.store.threadsForNode(descendant.id)) {
        await this.disposeSession(thread.id).catch(() => undefined);
      }
      this.store.removeNode(descendant.id);
      this.deps.emit({ type: "node:removed", payload: { id: descendant.id } });
    }
  }

  async deleteThread(id: string): Promise<void> {
    await this.disposeSession(id).catch(() => undefined);
    this.store.removeThread(id);
    this.deps.emit({ type: "thread:removed", payload: { id } });
  }

  async updateNode(id: string, patch: Partial<TreeNode>): Promise<TreeNode> {
    const existing = this.store.getNode(id);
    if (!existing) throw new Error(`Node not found: ${id}`);
    if (patch.parentId !== undefined) {
      if (patch.parentId === id) throw new Error("A node cannot be its own parent");
      if (patch.parentId && this.descendantNodes(id).some((node) => node.id === patch.parentId)) {
        throw new Error("Cannot move a node inside its own subtree");
      }
      const parent = patch.parentId ? this.store.getNode(patch.parentId) : undefined;
      if (patch.parentId && !parent) throw new Error("Target parent not found");
      const thread = this.store.getThread(existing.orchestratorThreadId);
      if (thread) {
        this.store.updateThread(thread.id, { parentThreadId: parent?.orchestratorThreadId ?? null });
      }
    }
    if (existing && patch.path && patch.path !== existing.path && existing.type === "project") {
      patch.repoPath = (await this.deps.git.root(patch.path)) ?? patch.path;
    }
    const node = this.store.updateNode(id, patch);
    this.deps.emit({ type: "node:updated", payload: node });
    return node;
  }

  async updateThread(id: string, patch: Partial<Thread>): Promise<Thread> {
    const thread = this.store.updateThread(id, patch);
    this.deps.emit({ type: "thread:updated", payload: thread });
    return thread;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    if (this.digestTimer) clearInterval(this.digestTimer);
    if (this.parkingTimer) clearInterval(this.parkingTimer);
    for (const timer of this.gitTimers.values()) clearTimeout(timer);
    for (const timer of this.autoContinueTimers.values()) clearTimeout(timer);
    await Promise.all([...this.sessions.values()].map((session) => session.dispose().catch(() => undefined)));
    this.sessions.clear();
  }

  // ---------- sessions ----------

  private async ensureSession(threadId: string): Promise<OmpSession> {
    const existing = this.sessions.get(threadId);
    if (existing?.isRunning) return existing;
    const inFlight = this.starting.get(threadId);
    if (inFlight) return inFlight;
    const promise = this.startSession(threadId).finally(() => this.starting.delete(threadId));
    this.starting.set(threadId, promise);
    return promise;
  }

  private async startSession(threadId: string): Promise<OmpSession> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const node = this.store.getNode(thread.nodeId);
    if (!node) throw new Error("Node not found");
    if (thread.kind === "native") throw new Error("Native OMP subagents are controlled by their parent");
    if (this.sessions.size >= this.store.settings.maxConcurrentThreads) {
      const idle = [...this.sessions.entries()].find(([, session]) => session.thread.status === "idle" || session.thread.status === "parked");
      if (idle) await this.disposeSession(idle[0]);
    }
    const environment = thread.environmentId
      ? this.store.getEnvironment(thread.environmentId) ?? this.deps.environments.resolveForNode(thread.nodeId)
      : this.deps.environments.resolveForNode(thread.nodeId);
    const cwd = thread.worktreePath || node.repoPath || node.path;
    mkdirSync(cwd, { recursive: true });
    mkdirSync(thread.sessionDir, { recursive: true });
    this.updateStatus(threadId, "starting", "Starting OMP…");

    if (environment) {
      const ok = await this.deps.environments.runSetup(environment, cwd, (text) => {
        this.deps.emit({
          type: "thread:event",
          payload: { id: newId("evt"), threadId, type: "environment", timestamp: Date.now(), payload: { text } },
        });
      });
      if (!ok) {
        this.updateStatus(threadId, "error", "Environment setup failed");
        throw new Error("Environment setup failed");
      }
    }

    const toolNames = envToolNames(node, environment);
    const systemPrompt = buildSystemPrompt({
      store: this.store,
      memory: this.deps.memory,
      thread,
      node,
      environment,
      parent: this.bus.parentOf(thread),
      children: this.bus.childrenOf(thread),
      root: this.store.nodes.find((n) => n.type === "root") ?? node,
      toolNames,
    });

    const session = new OmpSession({
      store: this.store,
      exe: this.deps.engine.resolveForSpawn(),
      thread,
      node,
      environment,
      processEnv: this.deps.environments.envForProcess(environment),
      cwd,
      systemPrompt,
      hostTools: HOST_TOOL_DEFINITIONS,
      hostToolHandler: (context) => this.handleHostTool(context),
      advisor: this.store.settings.advisor,
      toolNames,
      onChat: (message) => this.handleChat(message),
      onStatus: (status, message) => this.updateStatus(threadId, status, message),
      onState: (state) => this.applySessionState(threadId, state),
      onSubagent: (frame) => this.handleSubagent(threadId, frame),
      onExit: (error) => this.handleSessionExit(threadId, error),
      onStderr: (text) => {
        this.deps.emit({
          type: "thread:event",
          payload: { id: newId("evt"), threadId, type: "stderr", timestamp: Date.now(), payload: { text: text.slice(-4000) } },
        });
      },
      onToolFile: (path) => {
        const current = this.store.getThread(threadId);
        if (current) this.deps.artifacts.recordFile(current, path, cwd);
      },
    });
    session.on("ui_request", (request: ApprovalRequest, promise: Promise<any>) => {
      this.approvals.set(request.id, { threadId, session });
      this.store.updateThread(threadId, { pendingApproval: request.id });
      this.deps.emit({ type: "approval:request", payload: request });
      this.deps.notifications.notify({
        kind: "input_required",
        title: request.title,
        body: request.message.slice(0, 180),
        nodeId: thread.nodeId,
        threadId,
      });
      void promise.finally(() => {
        this.approvals.delete(request.id);
        this.store.updateThread(threadId, { pendingApproval: undefined });
        this.deps.emit({ type: "approval:resolved", payload: { id: request.id } });
      });
    });
    session.on("prompt_result", (result: any) => this.handlePromptResult(threadId, result));
    session.on("agent_end", () => this.refreshGit(threadId));
    session.on("title", (title: string) => {
      const current = this.store.getThread(threadId);
      if (current && current.titleAuto) {
        const updated = this.store.updateThread(threadId, { title, titleAuto: false });
        this.deps.emit({ type: "thread:updated", payload: updated });
      }
    });
    session.on("open_url", (url: string) => this.emit("open_url", url));
    this.sessions.set(threadId, session);
    await session.start();
    this.updateStatus(threadId, "idle", "Ready");
    return session;
  }

  private async disposeSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.sessions.delete(threadId);
    if (session.environment) {
      await this.deps.environments.runTeardown(session.environment, session.cwd, (text) => {
        this.deps.emit({
          type: "thread:event",
          payload: { id: newId("evt"), threadId, type: "environment", timestamp: Date.now(), payload: { text } },
        });
      }).catch(() => undefined);
    }
    await session.dispose();
    this.updateStatus(threadId, "parked", "Parked");
  }

  private updateStatus(threadId: string, status: ThreadStatus, message?: string): void {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const updated = this.store.updateThread(threadId, {
      status,
      statusMessage: message,
      lastActivityAt: Date.now(),
      pendingApproval: status === "waiting" ? thread.pendingApproval : undefined,
    });
    this.deps.emit({ type: "thread:updated", payload: updated });
    this.deps.emit({ type: "thread:status", payload: { threadId, status, message } });
  }

  private handleChat(message: ChatMessage): void {
    if (message.role === "user") {
      const recent = this.store.getChat(message.threadId).slice(-3);
      if (recent.some((item) => item.role === "user" && textOf(item) === textOf(message) && Math.abs(item.timestamp - message.timestamp) < 15_000)) {
        return;
      }
    }
    this.store.appendChat(message);
    const thread = this.store.getThread(message.threadId);
    if (thread) {
      const patch: Partial<Thread> = {
        lastActivityAt: Date.now(),
        lastMessage: textOf(message).slice(0, 240),
      };
      if (message.usage) {
        patch.tokens = thread.tokens + message.usage.totalTokens;
        patch.cost = thread.cost + this.estimateCost(thread, message.usage);
      }
      const updated = this.store.updateThread(thread.id, patch);
      this.deps.emit({ type: "thread:message", payload: message });
      this.deps.emit({ type: "thread:updated", payload: updated });
      if (message.usage) this.recomputeUsage();
      if (message.role === "assistant" && textOf(message)) {
        this.deps.naming.autoName(thread.id, textOf(message));
      }
    } else {
      this.deps.emit({ type: "thread:message", payload: message });
    }
  }

  private applySessionState(threadId: string, state: any): void {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const patch: Partial<Thread> = {
      todoPhases: state.todoPhases ?? thread.todoPhases,
      contextTokens: state.contextUsage?.tokens ?? thread.contextTokens,
      contextWindow: state.contextUsage?.contextWindow ?? thread.contextWindow,
      statusMessage: state.statusMessage ?? thread.statusMessage,
    };
    if (state.model?.provider && state.model?.id) {
      patch.model = {
        provider: state.model.provider,
        id: state.model.id,
        selector: `${state.model.provider}/${state.model.id}`,
        name: state.model.name,
      };
    }
    if (state.thinkingLevel) patch.effort = state.thinkingLevel;
    if (state.usageLimit) {
      patch.usageLimit = {
        stage: state.usageLimit.stage,
        resetsAt: state.usageLimit.resetsAtSec ? state.usageLimit.resetsAtSec * 1000 : undefined,
        allowanceLeftPercent: state.usageLimit.allowanceLeftPercent,
      };
    } else {
      patch.usageLimit = undefined;
    }
    const updated = this.store.updateThread(threadId, patch);
    this.deps.emit({ type: "thread:updated", payload: updated });
  }

  private handleSubagent(parentThreadId: string, frame: any): void {
    const payload = frame.payload ?? {};
    const parent = this.store.getThread(parentThreadId);
    if (!parent) return;
    const subagentId = payload.id ?? payload.progress?.id;
    if (!subagentId) return;
    let native = this.store.threads.find((thread) => thread.ompSubagentId === subagentId);
    if (frame.type === "subagent_lifecycle") {
      if (payload.status === "started") {
        if (!native) {
          native = this.makeThread({
            nodeId: parent.nodeId,
            parentThreadId,
            kind: "native",
            title: payload.description || `${payload.agent ?? "Subagent"} #${(payload.index ?? 0) + 1}`,
            model: parent.model.selector,
            effort: parent.effort,
            sessionDir: join(this.store.sessionsDir, "native", subagentId),
            status: "running",
            source: "native",
            titleAuto: false,
            ompSubagentId: subagentId,
            sessionFile: payload.sessionFile,
          });
          native.agentName = payload.agent;
          native.ompSubagentParentToolCallId = payload.parentToolCallId;
          this.store.addThread(native);
          this.deps.emit({ type: "thread:updated", payload: native });
        }
      } else if (native) {
        const status: ThreadStatus =
          payload.status === "completed" ? "completed" : payload.status === "aborted" ? "cancelled" : "error";
        const updated = this.store.updateThread(native.id, { status, statusMessage: payload.status, sessionFile: payload.sessionFile });
        this.deps.emit({ type: "thread:updated", payload: updated });
        if (status === "completed") {
          this.deps.notifications.notify({
            kind: "thread_completed",
            title: "Subagent finished",
            body: native.title,
            nodeId: native.nodeId,
            threadId: native.id,
          });
        }
        this.bus
          .send({
            fromThreadId: native.id,
            toThreadId: parentThreadId,
            kind: "result",
            subject: native.title,
            body: `Native OMP subagent ${native.title} ${payload.status}. Its full transcript is in the nested thread.`,
            deliver: false,
            priority: "low",
          })
          .catch(() => undefined);
      }
      return;
    }
    if (!native) return;
    if (frame.type === "subagent_progress") {
      const progress = payload.progress ?? {};
      const updated = this.store.updateThread(native.id, {
        status: progress.status === "completed" ? "completed" : progress.status === "failed" ? "error" : "running",
        statusMessage: progress.currentTool ? `${progress.currentTool}: ${progress.currentIntent ?? ""}` : progress.lastIntent,
        tokens: progress.tokens ?? native.tokens,
        cost: progress.cost ?? native.cost,
        contextTokens: progress.contextTokens ?? native.contextTokens,
        contextWindow: progress.contextWindow ?? native.contextWindow,
      });
      this.deps.emit({ type: "thread:updated", payload: updated });
      return;
    }
    if (frame.type === "subagent_event" && payload.event?.type === "message_end") {
      const message = payload.event.message;
      if (message?.role === "assistant") {
        const text = Array.isArray(message.content)
          ? message.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n")
          : "";
        if (text) {
          const chat: ChatMessage = {
            id: `sub_${subagentId}_${randomUUID().slice(0, 8)}`,
            threadId: native.id,
            role: "assistant",
            blocks: [{ type: "text", text }],
            timestamp: Date.now(),
            usage: message.usage,
          };
          this.store.appendChat(chat);
          this.deps.emit({ type: "thread:message", payload: chat });
        }
      }
    }
  }

  private handleSessionExit(threadId: string, error?: Error): void {
    this.sessions.delete(threadId);
    if (this.closed) return;
    if (error) {
      this.updateStatus(threadId, "error", error.message);
      const thread = this.store.getThread(threadId);
      if (thread) {
        this.deps.notifications.notify({
          kind: "error",
          title: "Thread error",
          body: `${thread.title}: ${error.message.slice(0, 160)}`,
          nodeId: thread.nodeId,
          threadId,
        });
      }
    } else {
      this.updateStatus(threadId, "parked", "Parked");
    }
  }

  private async handlePromptResult(threadId: string, result: any): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    if (result.status === "error") {
      const error = result.errorMessage ?? result.error?.message ?? "Model request failed";
      this.updateStatus(threadId, "error", error);
      this.deps.notifications.notify({
        kind: "error",
        title: "Thread failed",
        body: `${thread.title}: ${String(error).slice(0, 160)}`,
        nodeId: thread.nodeId,
        threadId,
      });
      this.scheduleUsageResume(threadId);
      await this.autoReport(threadId, `ERROR: ${error}`);
      return;
    }
    if (result.status === "aborted") {
      this.updateStatus(threadId, "cancelled", "Stopped");
      await this.autoReport(threadId, "The thread was stopped before completion.");
      return;
    }
    const status: ThreadStatus = thread.kind === "worker" ? "completed" : "idle";
    this.updateStatus(threadId, status, thread.kind === "worker" ? "Completed" : "Idle");
    const summary = this.store.getChat(threadId)
      .slice()
      .reverse()
      .find((message) => message.role === "assistant" && textOf(message));
    const text = summary ? textOf(summary) : "Completed without a final text summary.";
    this.deps.memory.autoCapture(thread, text);
    if (thread.kind === "worker") {
      this.deps.notifications.notify({
        kind: "thread_completed",
        title: "Thread finished",
        body: thread.title,
        nodeId: thread.nodeId,
        threadId,
      });
    }
    await this.autoReport(threadId, text);
    await this.refreshGit(threadId);
  }

  private scheduleUsageResume(threadId: string): void {
    if (!this.store.settings.usage.autoContinueOnReset) return;
    if (this.autoContinueTimers.has(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const now = Date.now();
    const when = thread.usageLimit?.resetsAt && thread.usageLimit.resetsAt > now ? thread.usageLimit.resetsAt + 15_000 : now + 15 * 60_000;
    const delay = Math.max(30_000, Math.min(when - now, 24 * 3_600_000));
    const timer = setTimeout(() => {
      this.autoContinueTimers.delete(threadId);
      const current = this.store.getThread(threadId);
      if (!current || current.status !== "error") return;
      this.deps.notifications.notify({
        kind: "usage_limit",
        title: "Resuming after usage limit",
        body: current.title,
        nodeId: current.nodeId,
        threadId: current.id,
      });
      void this.sendUserMessage({
        threadId,
        text: "The usage limit window should have reset. Continue the work from where you stopped, re-check the current repository state, and report the outcome.",
      }).catch(() => undefined);
    }, delay);
    this.autoContinueTimers.set(threadId, timer);
  }

  private async autoReport(threadId: string, summary: string): Promise<void> {
    if (!this.store.settings.autoReport) return;
    const thread = this.store.getThread(threadId);
    if (!thread) return;
    const parent = this.bus.parentOf(thread);
    if (!parent) return;
    const git = thread.worktreePath ? await this.deps.git.status(thread.worktreePath).catch(() => null) : null;
    const parts = [
      `Outcome: ${thread.status}`,
      `Thread: ${thread.title} (${thread.kind})`,
      `Model: ${thread.model.name ?? thread.model.selector}; effort: ${thread.effort}`,
      `Usage: ${thread.tokens.toLocaleString()} tokens; $${thread.cost.toFixed(3)}`,
    ];
    if (git?.isRepo) {
      parts.push(`Git: branch ${git.branch ?? "?"}; ${git.files.length} changed file(s); ahead ${git.ahead}, behind ${git.behind}`);
    }
    parts.push("", summary.slice(0, 6000));
    this.deps.artifacts.recordReport(thread, `${thread.title} — result`, parts.join("\n"));
    if (thread.worktreePath && git && !git.clean) {
      const diff = await this.deps.git.diff(thread.worktreePath).catch(() => "");
      if (diff.trim()) this.deps.artifacts.recordDiff(thread, diff, `${thread.title} — diff`);
    }
    const envelope = await this.bus.send({
      fromThreadId: thread.id,
      toThreadId: parent.id,
      kind: thread.status === "error" ? "error" : "result",
      subject: `${thread.title} — ${thread.status}`,
      body: parts.join("\n"),
      priority: thread.status === "error" ? "high" : "normal",
      traceId: thread.traceId,
    });
    this.store.updateTrace(thread.traceId ?? envelope.traceId, { status: thread.status === "error" ? "error" : "done" });
  }

  private async refreshGit(threadId: string): Promise<void> {
    const existing = this.gitTimers.get(threadId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.gitTimers.delete(threadId);
      const thread = this.store.getThread(threadId);
      if (!thread) return;
      const node = this.store.getNode(thread.nodeId);
      const path = thread.worktreePath || node?.repoPath;
      if (!path) return;
      void this.deps.git.status(path).then((status) => {
        const updated = this.store.updateThread(threadId, {
          git: { ...status, worktreePath: thread.worktreePath, baseBranch: thread.baseBranch, isolation: thread.worktreePath ? "worktree" : "shared" },
        });
        this.deps.emit({ type: "thread:updated", payload: updated });
      }).catch(() => undefined);
    }, 1200);
    this.gitTimers.set(threadId, timer);
  }

  private async deliverEnvelope(envelope: Envelope): Promise<boolean> {
    const debug = process.argv.includes("--integration-test");
    if (debug) console.log("DELIVER_START", envelope.id, envelope.fromThreadId, "->", envelope.toThreadId, envelope.kind, envelope.direction);
    const target = this.store.getThread(envelope.toThreadId);
    if (!target) return false;
    if (target.kind === "native") {
      const parent = target.parentThreadId ? this.sessions.get(target.parentThreadId) : undefined;
      if (parent?.isRunning && target.ompSubagentId) {
        await parent.steerSubagent(target.ompSubagentId, envelope.body).catch(() => undefined);
        return true;
      }
      return false;
    }
    const shouldWake =
      envelope.direction === "down" || envelope.fromThreadId === "user" || this.store.settings.autoWakeParent;
    if (!this.sessions.get(target.id)?.isRunning && !shouldWake) return false;
    let session: OmpSession;
    try {
      if (debug) console.log("DELIVER_ENSURE", target.id, target.title, target.status);
      session = await this.ensureSession(target.id);
    } catch {
      return false;
    }
    const text = this.bus.formatForPrompt(envelope, target);
    const current = this.store.getThread(target.id);
    try {
      await this.flushQueued(target.id, envelope.id);
      if (debug) console.log("DELIVER_PROMPT", target.id, current?.status, target.status);
      if (current && (current.status === "running" || current.status === "waiting")) {
        await session.prompt(text, "steer");
      } else {
        await session.prompt(text, "prompt");
      }
      this.bus.markDelivered(envelope);
      if (debug) console.log("DELIVER_DONE", envelope.id);
      return true;
    } catch (error) {
      if (debug) console.log("DELIVER_FAIL", envelope.id, String(error));
      return false;
    }
  }

  private async flushQueued(threadId: string, excludeId?: string): Promise<void> {
    const queued = this.store.listEnvelopes({ threadId, limit: 50 }).filter(
      (envelope) => envelope.toThreadId === threadId && envelope.status === "queued" && envelope.id !== excludeId,
    );
    for (const envelope of queued) {
      const delivered = await this.deliverEnvelope(envelope);
      if (delivered) this.bus.markDelivered(envelope);
    }
  }

  // ---------- host tools ----------

  private async handleHostTool(context: HostToolContext): Promise<HostToolResult> {
    const debug = process.argv.includes("--integration-test");
    if (debug) console.log("HOST_TOOL_START", context.thread.id, context.toolName, JSON.stringify(context.args).slice(0, 200));
    try {
      const result = await this.executeHostTool(context);
      if (debug) console.log("HOST_TOOL_END", context.thread.id, context.toolName, result.isError ? "ERROR" : "OK");
      return result;
    } catch (error) {
      if (debug) console.log("HOST_TOOL_FAIL", context.thread.id, context.toolName, String(error));
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  private async executeHostTool(context: HostToolContext): Promise<HostToolResult> {
    try {
      switch (context.toolName) {
        case "tree_list":
          return textResult(this.describeTree(context));
        case "tree_create_node": {
          if (context.node.type === "project") throw new Error("A project cannot create child nodes");
          const node = await this.createNode({
            parentId: context.node.id,
            type: context.args.type === "project" ? "project" : "group",
            name: String(context.args.name ?? ""),
            path: typeof context.args.path === "string" ? context.args.path : undefined,
            model: context.args.model,
            effort: context.args.effort,
            brief: context.args.brief,
          });
          return textResult(`Created ${node.type} "${node.name}" (${node.id}), orchestrator ${node.orchestratorThreadId}.`);
        }
        case "tree_create_thread": {
          const thread = await this.createThread({
            nodeId: context.node.id,
            parentThreadId: context.thread.id,
            title: context.args.title,
            brief: String(context.args.brief ?? ""),
            model: context.args.model,
            effort: context.args.effort,
            isolation: context.args.isolation,
            wait: false,
          });
          if (context.args.wait) {
            const settled = await this.waitForThreads([thread.id], 15 * 60_000);
            return textResult(`Thread ${settled.map((t) => `${t.title} [${t.status}]`).join(", ")}\n\n${this.latestSummary(thread.id)}`);
          }
          return textResult(`Spawned worker "${thread.title}" (${thread.id}), status ${thread.status}. It will report upward.`);
        }
        case "tree_message": {
          const target = this.resolveMessageTarget(context);
          if (!target) throw new Error("Target not found");
          const envelope = await this.bus.send({
            fromThreadId: context.thread.id,
            toThreadId: target.id,
            kind: (context.args.kind as EnvelopeKind) || "note",
            subject: String(context.args.subject ?? "Message"),
            body: String(context.args.body ?? ""),
            priority: (context.args.priority as Priority) || "normal",
            requiresResponse: !!context.args.requiresResponse,
          });
          return textResult(`Sent ${envelope.kind} message ${envelope.id} to ${target.title} (${envelope.status}).`);
        }
        case "tree_ask_parent": {
          const answer = await this.bus.askParent(context.thread.id, String(context.args.question ?? ""), context.args.context);
          return textResult(answer ? `Answer from parent (${answer.id}):\n${answer.body}` : "No answer from parent before timeout.");
        }
        case "tree_report": {
          const parent = this.bus.parentOf(context.thread);
          if (!parent) return textResult("You are the root; the user is your audience. No parent to report to.");
          const status = String(context.args.status ?? "progress");
          const body = [
            `Status: ${status}`,
            context.args.needsParentAction ? "PARENT ACTION REQUIRED" : "",
            String(context.args.summary ?? ""),
            Array.isArray(context.args.artifacts) && context.args.artifacts.length
              ? `Artifacts: ${context.args.artifacts.join(", ")}`
              : "",
          ].filter(Boolean).join("\n");
          const envelope = await this.bus.send({
            fromThreadId: context.thread.id,
            toThreadId: parent.id,
            kind: status === "done" ? "result" : status === "blocked" || status === "needs-decision" ? "question" : "progress",
            subject: `${context.thread.title}: ${status}`,
            body,
            priority: status === "blocked" || status === "error" ? "high" : "normal",
            requiresResponse: status === "needs-decision" || status === "blocked",
          });
          return textResult(`Reported to ${parent.title} (${envelope.id}, ${envelope.status}).`);
        }
        case "tree_reply": {
          const id = String(context.args.messageId ?? "");
          await this.answerEnvelope(id, String(context.args.body ?? ""));
          return textResult(`Answered message ${id}.`);
        }
        case "tree_wait": {
          const ids = Array.isArray(context.args.threadIds) && context.args.threadIds.length
            ? context.args.threadIds.map(String)
            : this.bus.childrenOf(context.thread).map((thread) => thread.id);
          const settled = await this.waitForThreads(ids, Number(context.args.timeoutMs) || 10 * 60_000);
          return textResult(settled.map((thread) => `## ${thread.title} [${thread.status}]\n${this.latestSummary(thread.id)}`).join("\n\n"));
        }
        case "tree_cancel": {
          const threadId = String(context.args.threadId ?? "");
          const target = this.store.getThread(threadId);
          if (!target) throw new Error("Thread not found");
          await this.disposeSession(threadId);
          this.updateStatus(threadId, "cancelled", context.args.reason ? String(context.args.reason) : "Cancelled by parent");
          await this.bus.send({
            fromThreadId: context.thread.id,
            toThreadId: threadId,
            kind: "cancel",
            subject: "Cancelled",
            body: String(context.args.reason ?? "Cancelled by parent"),
            deliver: false,
          });
          return textResult(`Cancelled ${target.title}.`);
        }
        case "tree_git":
          return this.handleGitTool(context);
        case "tree_memory_write": {
          const entry = this.deps.memory.add({
            nodeId: context.node.id,
            text: String(context.args.text ?? ""),
            tags: Array.isArray(context.args.tags) ? context.args.tags.map(String) : [],
            importance: typeof context.args.importance === "number" ? context.args.importance : 0.6,
            source: "orchestrator",
            sourceThreadId: context.thread.id,
          });
          return textResult(`Remembered (${entry.id}, importance ${entry.importance}).`);
        }
        case "tree_memory_read": {
          const entries = this.deps.memory.recall(context.node.id, String(context.args.query ?? ""), Number(context.args.limit) || 12);
          return textResult(entries.length ? entries.map((entry) => `- [${entry.source}/${entry.importance.toFixed(1)}] ${entry.text}`).join("\n") : "No memories found.");
        }
        case "tree_set_title": {
          const title = String(context.args.title ?? "").trim();
          if (!title) throw new Error("Title is empty");
          const updated = this.store.updateThread(context.thread.id, { title: title.slice(0, 80), titleAuto: false });
          this.deps.emit({ type: "thread:updated", payload: updated });
          return textResult(`Title set to "${updated.title}".`);
        }
        default:
          throw new Error(`Unknown host tool: ${context.toolName}`);
      }
    } catch (error) {
      return {
        content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        isError: true,
      };
    }
  }

  private async handleGitTool(context: HostToolContext): Promise<HostToolResult> {
    const op = String(context.args.op ?? "status");
    const threadId = typeof context.args.threadId === "string" ? context.args.threadId : context.thread.id;
    const thread = this.store.getThread(threadId);
    const node = this.store.getNode(thread?.nodeId ?? context.node.id);
    if (!node) throw new Error("Node not found");
    if (op === "status") {
      const status = await this.gitStatus(node.id, thread?.id);
      return textResult(JSON.stringify(status, null, 2));
    }
    if (op === "diff") {
      return textResult(await this.gitDiff(node.id, thread?.id));
    }
    if (op === "commit") {
      const result = await this.gitCommit(node.id, thread?.id, String(context.args.message ?? "OMP Studio: commit"), undefined);
      return { ...textResult(result.output), isError: !result.ok };
    }
    if (op === "merge") {
      if (!thread) throw new Error("Thread not found");
      const result = await this.gitMerge(node.id, thread.id);
      return { ...textResult(result.output + (result.conflicts.length ? `\nConflicts: ${result.conflicts.join(", ")}` : "")), isError: !result.ok };
    }
    if (op === "pr") {
      if (!thread) throw new Error("Thread not found");
      const result = await this.gitCreatePr(node.id, thread.id, String(context.args.title ?? thread.title), String(context.args.body ?? ""));
      return { ...textResult(result.output + (result.url ? `\n${result.url}` : "")), isError: !result.ok };
    }
    throw new Error(`Unknown git op: ${op}`);
  }

  private describeTree(context: HostToolContext): string {
    const nodes = this.store.nodes;
    const lines: string[] = ["Tree:"];
    const walk = (parentId: string | null, depth: number) => {
      for (const node of nodes.filter((n) => n.parentId === parentId)) {
        const indent = "  ".repeat(depth);
        const threads = this.store.threadsForNode(node.id);
        const running = threads.filter((t) => t.status === "running").length;
        const waiting = threads.filter((t) => t.status === "waiting" || t.pendingApproval).length;
        const errors = threads.filter((t) => t.status === "error").length;
        lines.push(`${indent}- ${node.name} [${node.type}] id=${node.id} orch=${node.orchestratorThreadId} threads=${threads.length} running=${running} waiting=${waiting} errors=${errors}`);
        walk(node.id, depth + 1);
      }
    };
    walk(null, 0);
    lines.push("");
    lines.push("Your thread id: " + context.thread.id);
    const children = this.bus.childrenOf(context.thread);
    if (children.length) {
      lines.push("Direct child threads:");
      for (const child of children) {
        lines.push(`- ${child.title} (${child.id}) status=${child.status} model=${child.model.selector} branch=${child.branch ?? "shared"}`);
      }
    }
    const subtree = new Set<string>([context.node.id, ...this.descendantNodes(context.node.id).map((node) => node.id)]);
    const records = this.store
      .listEnvelopes({ limit: 120 })
      .filter((envelope) => (envelope.fromNodeId && subtree.has(envelope.fromNodeId)) || (envelope.toNodeId && subtree.has(envelope.toNodeId)));
    if (records.length) {
      lines.push("");
      lines.push("Recent messages at this level:");
      for (const envelope of records.slice(-10)) {
        lines.push(`- [${envelope.direction}/${envelope.kind}] ${envelope.subject} (${envelope.status}) ${envelope.id}`);
      }
    }
    return lines.join("\n");
  }

  private resolveMessageTarget(context: HostToolContext): Thread | undefined {
    const raw = String(context.args.target ?? "");
    if (raw === "parent") return this.bus.parentOf(context.thread);
    if (raw.startsWith("child:")) return this.store.getThread(raw.slice(6));
    if (raw.startsWith("thread:")) return this.store.getThread(raw.slice(7));
    if (raw.startsWith("node:")) {
      const node = this.store.getNode(raw.slice(5));
      return node ? this.store.getThread(node.orchestratorThreadId) : undefined;
    }
    return this.store.getThread(raw);
  }

  private async waitForThreads(ids: string[], timeoutMs: number): Promise<Thread[]> {
    const deadline = Date.now() + Math.max(1000, timeoutMs);
    const wanted = ids.map((id) => this.store.getThread(id)).filter(Boolean) as Thread[];
    while (Date.now() < deadline) {
      const current = ids.map((id) => this.store.getThread(id)).filter(Boolean) as Thread[];
      if (current.every((thread) => ["completed", "error", "cancelled", "idle"].includes(thread.status) && !thread.pendingApproval)) {
        return current;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    return ids.map((id) => this.store.getThread(id)).filter(Boolean) as Thread[];
  }

  private latestSummary(threadId: string): string {
    const message = this.store.getChat(threadId).slice().reverse().find((item) => item.role === "assistant" && textOf(item));
    return message ? textOf(message).slice(0, 4000) : "No assistant summary yet.";
  }

  private estimateCost(thread: Thread, usage: NonNullable<ChatMessage["usage"]>): number {
    const model = this.deps.models.resolve(thread.model.selector);
    if (!model) return 0;
    return (
      (usage.input / 1_000_000) * model.cost.input +
      (usage.output / 1_000_000) * model.cost.output +
      (usage.cacheRead / 1_000_000) * model.cost.cacheRead +
      (usage.cacheWrite / 1_000_000) * model.cost.cacheWrite
    );
  }

  private recomputeUsage(): void {
    const perNode: Record<string, { cost: number; tokens: number; threads: number }> = {};
    let totalCost = 0;
    let totalTokens = 0;
    for (const thread of this.store.threads) {
      totalCost += thread.cost;
      totalTokens += thread.tokens;
      const current = perNode[thread.nodeId] ?? { cost: 0, tokens: 0, threads: 0 };
      current.cost += thread.cost;
      current.tokens += thread.tokens;
      current.threads += 1;
      perNode[thread.nodeId] = current;
    }
    const usage = {
      ...this.store.data.usage,
      generatedAt: Date.now(),
      totalCost,
      totalTokens,
      perNode,
    };
    this.store.setUsage(usage);
    this.deps.emit({ type: "usage:updated", payload: usage });
  }

  private descendantNodes(id: string): TreeNode[] {
    const result: TreeNode[] = [];
    const walk = (parentId: string) => {
      for (const child of this.store.nodes.filter((node) => node.parentId === parentId)) {
        result.push(child);
        walk(child.id);
      }
    };
    walk(id);
    return result;
  }

  private startDigestTimer(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    const minutes = this.store.settings.digestIntervalMin;
    if (!minutes || minutes <= 0) return;
    this.digestTimer = setInterval(() => this.emitDigest(), Math.max(1, minutes) * 60_000);
  }

  private emitDigest(): void {
    const root = this.store.nodes.find((node) => node.type === "root");
    if (!root) return;
    const active = this.store.threads.filter((thread) => thread.status === "running").length;
    const waiting = this.store.threads.filter((thread) => thread.status === "waiting" || thread.pendingApproval).length;
    const errors = this.store.threads.filter((thread) => thread.status === "error").length;
    const completed = this.store.threads.filter((thread) => thread.status === "completed").length;
    if (!active && !waiting && !errors) return;
    this.deps.notifications.notify({
      kind: "digest",
      title: "Tree digest",
      body: `${active} running · ${waiting} waiting · ${errors} errors · ${completed} completed`,
      nodeId: root.id,
      threadId: root.orchestratorThreadId,
    });
  }
}

function textResult(text: string): HostToolResult {
  return { content: [{ type: "text", text }] };
}

function textOf(message: ChatMessage): string {
  return message.blocks.filter((block) => block.type === "text").map((block) => (block as any).text).join("\n").trim();
}

function slug(value: string): string {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return base || "work";
}

function normalizeEffort(effort: string, model: ModelInfo | undefined): string {
  if (!model?.reasoning) return "off";
  const supported = model.thinking ?? [];
  if (!supported.length) return effort === "off" ? "off" : effort;
  if (effort === "off") return "off";
  if (supported.includes(effort)) return effort;
  if (supported.includes("medium")) return "medium";
  return supported[0] ?? "off";
}

function envToolNames(node: TreeNode, environment?: Environment): string[] {
  const names = environment?.toolNames?.length ? environment.toolNames : node.toolNames;
  return names?.length ? names : [];
}
