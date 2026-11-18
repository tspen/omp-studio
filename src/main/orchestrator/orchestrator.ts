import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppEvent,
  ApprovalMode,
  ApprovalRequest,
  Artifact,
  Automation,
  ChatMessage,
  Checkpoint,
  Envelope,
  EnvelopeKind,
  Environment,
  GitMode,
  MemoryEntry,
  ModelInfo,
  NewNodeRequest,
  NewThreadRequest,
  PermissionRule,
  Priority,
  SendMessageRequest,
  Snapshot,
  Thread,
  ThreadStatus,
  TreeNode,
} from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import { PiSession } from "../engine/pi-session";
import type { HostToolContext, HostToolHandler, HostToolResult } from "./host-tools";
import { HOST_TOOL_DEFINITIONS } from "./host-tools";
import { MessageBus } from "./message-bus";
import { buildSystemPrompt } from "./prompts";
import type { ArtifactService } from "../services/artifacts";
import type { BrowserController } from "../services/browser";
import type { EnvironmentService } from "../services/environment";
import type { GitService } from "../services/git";
import type { MemoryService } from "../services/memory";
import type { ModelService } from "../services/models";
import type { NamingService } from "../services/naming";
import type { NotificationService } from "../services/notifications";
import type { ShareService } from "../services/share";
import type { SettingsService } from "../services/settings";
import type { SiteService } from "../services/sites";
import type { PtyService } from "../services/pty";
import type { WorkspaceService } from "../services/workspace";
import type { DeployService } from "../services/deploy";
import type { ComputerService } from "../services/computer";
import type { MobileService } from "../services/mobile";
import type { Store } from "../services/store";
import { newId } from "../services/store";
import { trace } from "../diagnostics";
import { lspRequest } from "../services/lsp";
import { astEdit, astGrep } from "../services/ast";
import { webSearch } from "../services/web-search";
import type { PythonService } from "../services/python";
import { notebookRequest } from "../services/notebook";
import { audit } from "../audit";

const WORKER_RESUME_PROMPT =
  "The app closed while this thread was working. Resume the interrupted task from where it stopped: inspect the current workspace and branch first, finish the unfinished work, verify it, then call tree_report with the outcome. Do not redo steps that already completed.";

export interface OrchestratorDeps {
  store: Store;
  engine: EngineLocator;
  environments: EnvironmentService;
  memory: MemoryService;
  models: ModelService;
  naming: NamingService;
  git: GitService;
  artifacts: ArtifactService;
  browser: BrowserController;
  pty: PtyService;
  workspace: WorkspaceService;
  python: PythonService;
  deploy: DeployService;
  computer: ComputerService;
  mobile: MobileService;
  notifications: NotificationService;
  settings: SettingsService;
  share: ShareService;
  sites: SiteService;
  emit: (event: AppEvent) => void;
}

export class Orchestrator extends EventEmitter {
  private deps: OrchestratorDeps;
  private store: Store;
  private sessions = new Map<string, PiSession>();
  private goalContinuing = new Set<string>();
  private approvals = new Map<string, { threadId: string; session: PiSession; request: ApprovalRequest }>();
  private starting = new Map<string, Promise<PiSession>>();
  private gitTimers = new Map<string, NodeJS.Timeout>();
  private autoContinueTimers = new Map<string, NodeJS.Timeout>();
  private retitleState = new Map<string, { turns: number; lastAt: number }>();
  private focusedThreadId: string | null = null;
  private digestTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private parkingTimer: NodeJS.Timeout | null = null;
  private automationTimer: NodeJS.Timeout | null = null;
  private compactingIdle = new Set<string>();
  private lastIdleCompaction = new Map<string, number>();
  private budgetWarned = new Map<string, number>();
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
    this.store.reconcileStaleTools("Interrupted when the app closed");
    for (const node of this.store.nodes) this.ensureNodeThread(node);
    this.retitleLegacyWorkers();
    this.recomputeUsage();
    this.startDigestTimer();
    this.startStatusTimer();
    this.parkingTimer = setInterval(() => void this.runMaintenance(), 60_000);
    this.automationTimer = setInterval(() => void this.runDueAutomations(), 60_000);
  }

  listAutomations(): Automation[] {
    return this.store.automations;
  }

  saveAutomation(input: Partial<Automation> & { name: string; nodeId: string; prompt: string; intervalMin: number }): Automation {
    if (!this.store.getNode(input.nodeId)) throw new Error("Node not found");
    if (input.id) {
      return this.store.updateAutomation(input.id, {
        name: input.name,
        nodeId: input.nodeId,
        prompt: input.prompt,
        intervalMin: Math.max(5, Number(input.intervalMin) || 30),
        enabled: input.enabled !== false,
      });
    }
    return this.store.addAutomation({
      id: newId("aut"),
      name: input.name.trim() || "Automation",
      nodeId: input.nodeId,
      prompt: input.prompt,
      intervalMin: Math.max(5, Number(input.intervalMin) || 30),
      enabled: input.enabled !== false,
      createdAt: Date.now(),
    });
  }

  deleteAutomation(id: string): void {
    this.store.removeAutomation(id);
  }

  async runAutomation(id: string): Promise<Thread> {
    const automation = this.store.automations.find((item) => item.id === id);
    if (!automation) throw new Error("Automation not found");
    const node = this.store.getNode(automation.nodeId);
    if (!node) throw new Error("Automation node not found");
    const thread = await this.createThread({
      nodeId: automation.nodeId,
      title: `Automation · ${automation.name}`.slice(0, 60),
      brief: [
        `Scheduled automation: ${automation.name}`,
        "",
        automation.prompt,
        "",
        "Work in your own thread, verify the result and report the outcome. Ask a question instead of guessing when blocked.",
      ].join("\n"),
    });
    this.store.updateAutomation(id, { lastRunAt: Date.now(), lastThreadId: thread.id, lastStatus: "running" });
    return thread;
  }

  private async runDueAutomations(): Promise<void> {
    const now = Date.now();
    for (const automation of this.store.automations) {
      if (!automation.enabled) continue;
      if (now - (automation.lastRunAt ?? 0) < Math.max(5, automation.intervalMin) * 60_000) continue;
      this.store.updateAutomation(automation.id, { lastRunAt: now, lastStatus: "running" });
      void this.runAutomation(automation.id)
        .then((thread) => this.store.updateAutomation(automation.id, { lastThreadId: thread.id, lastStatus: "started" }))
        .catch((error) => this.store.updateAutomation(automation.id, { lastStatus: `error: ${String(error).slice(0, 120)}` }));
      break;
    }
  }

  private async runMaintenance(): Promise<void> {
    await this.compactIdleSessions();
    await this.parkIdleSessions();
  }

  /**
   * Compact sessions that are idle and above the configured context threshold.
   * Runs in the background: the session is never stopped, and only one idle
   * thread is compacted at a time so the app stays responsive.
   */
  private async compactIdleSessions(): Promise<void> {
    const settings = this.store.settings;
    if (settings.idleCompaction === false || settings.contextCompaction === false) return;
    if (this.compactingIdle.size >= 1) return;
    const threshold = Math.min(95, Math.max(30, Number(settings.idleCompactionThreshold) || 60)) / 100;
    const now = Date.now();
    const pendingApprovals = new Set([...this.approvals.values()].map((item) => item.threadId));
    for (const [threadId] of this.sessions) {
      if (this.compactingIdle.size >= 1) break;
      const thread = this.store.getThread(threadId);
      if (!thread) continue;
      if (thread.archived) continue;
      if (thread.status !== "idle") continue;
      if (now - thread.lastActivityAt < 2 * 60_000) continue;
      if (pendingApprovals.has(threadId)) continue;
      if (!thread.contextTokens || !thread.contextWindow) continue;
      if (thread.contextTokens / thread.contextWindow < threshold) continue;
      if (now - (this.lastIdleCompaction.get(threadId) ?? 0) < 30 * 60_000) continue;
      const session = this.sessions.get(threadId);
      if (!session) continue;
      this.lastIdleCompaction.set(threadId, now);
      this.compactingIdle.add(threadId);
      trace("idle-compaction-start", {
        threadId,
        contextTokens: thread.contextTokens,
        contextWindow: thread.contextWindow,
      });
      void this.compactIdleThread(thread.id, session).finally(() => {
        this.compactingIdle.delete(threadId);
      });
    }
  }

  private async compactIdleThread(threadId: string, session: PiSession): Promise<void> {
    try {
      await session.compact();
      const state = await session.getState().catch(() => null);
      if (state) this.applySessionState(threadId, state);
      trace("idle-compaction-end", { threadId });
    } catch (error) {
      trace("idle-compaction-failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async parkIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const [threadId, session] of this.sessions) {
      const thread = this.store.getThread(threadId);
      if (!thread) continue;
      if (this.compactingIdle.has(threadId)) continue;
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
      const preferredEffort =
        node.type === "root"
          ? this.store.settings.models.rootEffort
          : node.type === "group"
            ? this.store.settings.models.groupEffort
            : this.store.settings.models.projectEffort;
      const effort = normalizeEffort(preferredEffort || "high", model);
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
        effort: this.store.settings.models.rootEffort || "high",
        gitMode: "shared",
        approvalMode: this.store.settings.defaultApprovalMode || "yolo",
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
        effort: this.store.settings.models.rootEffort || "high",
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
    nativeSubagentId?: string;
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
      nativeSubagentId: input.nativeSubagentId,
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
    const path = input.path?.trim() || this.uniqueWorkspacePath(join(this.store.workspaceRoot, slug(name)));
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
      effort: input.effort || (type === "group" ? this.store.settings.models.groupEffort : this.store.settings.models.projectEffort) || "high",
      gitMode: type === "project" ? this.store.settings.git.defaultMode : "shared",
      approvalMode: input.approvalMode ?? this.store.settings.defaultApprovalMode ?? "yolo",
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
    this.assertBudget(node.id);
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
      effort: input.effort || this.store.settings.models.workerEffort || "high",
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
    this.deps.naming.nameWorker(thread.id, input.brief);

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

  async continueThread(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    trace("continue-start", { threadId, kind: thread?.kind, status: thread?.status });
    if (!thread) throw new Error("Thread not found");
    if (thread.archived) {
      const revived = this.store.updateThread(thread.id, { archived: false, status: "idle", statusMessage: "Reopened" });
      this.deps.emit({ type: "thread:updated", payload: revived });
    }
    if (thread.kind === "native") throw new Error("Native subagent threads are resumed by their parent");
    if (["running", "starting"].includes(thread.status)) return;
    if (thread.kind !== "orchestrator") {
      await this.sendUserMessage({ threadId, text: WORKER_RESUME_PROMPT });
      return;
    }
    const node = this.store.getNode(thread.nodeId);
    if (!node) throw new Error("Node not found");
    this.cleanupFinishedThreads(node.id);
    const subtreeIds = new Set([node.id, ...this.descendantNodes(node.id).map((item) => item.id)]);
    const active = this.store.threads.filter(
      (item) => subtreeIds.has(item.nodeId) && item.kind === "worker" && !item.archived && ["running", "starting", "waiting"].includes(item.status),
    );
    const claimed = new Map<string, string>();
    for (const running of active) for (const key of this.conflictKeys(running)) claimed.set(key, running.title);
    const slots = Math.min(3, Math.max(1, this.store.settings.maxConcurrentThreads - active.length));
    const resumable = this.resumableThreads(node.id);
    trace("continue-candidates", { node: node.id, active: active.length, resumable: resumable.map((worker) => worker.id) });
    const resumed: Thread[] = [];
    const paused: Array<{ thread: Thread; reason: string }> = [];
    for (const worker of resumable) {
      const conflict = this.conflictKeys(worker).map((key) => ({ key, owner: claimed.get(key) })).find((item) => item.owner);
      if (conflict?.owner) {
        const reason = `Paused: overlaps "${conflict.owner}" on ${conflict.key.startsWith("title:") ? "the same task" : "the same checkout or branch"}`;
        await this.pauseThread(worker, reason);
        paused.push({ thread: worker, reason });
        continue;
      }
      if (resumed.length >= slots) {
        const reason = `Paused: resume batch limit (${slots} started this pass)`;
        await this.pauseThread(worker, reason);
        paused.push({ thread: worker, reason });
        continue;
      }
      await this.sendUserMessage({ threadId: worker.id, text: WORKER_RESUME_PROMPT }).catch(() => undefined);
      for (const key of this.conflictKeys(worker)) claimed.set(key, worker.title);
      resumed.push(worker);
    }
    // Nested orchestrators will wake from their workers' reports; clear their
    // banners without spending a turn on each of them.
    for (const descendant of this.descendantNodes(node.id)) {
      const nested = this.store.getThread(descendant.orchestratorThreadId);
      if (nested?.interrupted) {
        const cleared = this.store.updateThread(nested.id, { interrupted: false, interruptedAt: undefined });
        this.deps.emit({ type: "thread:updated", payload: cleared });
      }
    }
    const resumedLines = resumed.slice(0, 8).map((worker) => `- ${worker.title}`).join("\n");
    const pausedLines = paused.slice(0, 8).map((item) => `- ${item.thread.title}: ${item.reason}`).join("\n");
    const summary = [
      resumed.length
        ? `Continue requested. Resumed ${resumed.length} interrupted child thread(s):\n${resumedLines}`
        : "Continue requested. No child threads were resumed.",
      paused.length ? `Paused ${paused.length} overlapping or over-limit thread(s):\n${pausedLines}` : "",
      "",
      "Monitor their reports, answer questions, resolve finished threads with tree_resolve_thread, and escalate blockers. Do not implement code or inspect files yourself.",
    ].filter(Boolean).join("\n");
    await this.sendUserMessage({ threadId, text: summary });
  }

  private async pauseThread(thread: Thread, reason: string): Promise<void> {
    await this.disposeSession(thread.id).catch(() => undefined);
    const updated = this.store.updateThread(thread.id, {
      status: "parked",
      statusMessage: reason,
    });
    this.deps.emit({ type: "thread:updated", payload: updated });
  }

  private cleanupFinishedThreads(nodeId: string): void {
    const nodeIds = new Set([nodeId, ...this.descendantNodes(nodeId).map((node) => node.id)]);
    for (const thread of this.store.threads) {
      if (!nodeIds.has(thread.nodeId) || thread.kind !== "worker" || thread.archived) continue;
      if (!thread.interrupted || !["completed", "cancelled", "error"].includes(thread.status)) continue;
      const cleared = this.store.updateThread(thread.id, {
        interrupted: false,
        interruptedAt: undefined,
        statusMessage: thread.statusMessage ?? "Finished before restart",
      });
      this.deps.emit({ type: "thread:updated", payload: cleared });
    }
  }

  private conflictKeys(thread: Thread): string[] {
    const keys: string[] = [];
    if (thread.worktreePath) keys.push(`worktree:${thread.worktreePath.toLowerCase()}`);
    if (thread.branch) keys.push(`branch:${thread.branch.toLowerCase()}`);
    if (!thread.worktreePath) keys.push(`checkout:${thread.nodeId}`);
    const title = thread.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (title) keys.push(`title:${thread.nodeId}:${title}`);
    return keys;
  }

  private resumableThreads(nodeId: string): Thread[] {
    const nodeIds = new Set([nodeId, ...this.descendantNodes(nodeId).map((node) => node.id)]);
    return this.store.threads.filter(
      (thread) =>
        nodeIds.has(thread.nodeId) &&
        thread.kind === "worker" &&
        thread.interrupted &&
        !thread.archived &&
        ["parked", "waiting", "queued", "idle"].includes(thread.status),
    );
  }

  async setContextCompaction(enabled: boolean): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.setAutoCompaction(enabled).catch(() => undefined)));
  }

  async compactThread(threadId: string): Promise<void> {
    const session = await this.ensureSession(threadId);
    await session.compact();
  }

  async sendUserMessage(request: SendMessageRequest): Promise<void> {
    const thread = this.store.getThread(request.threadId);
    if (!thread) throw new Error("Thread not found");
    trace("send-user", { threadId: thread.id, chars: request.text.length });
    if (thread.archived) {
      const revived = this.store.updateThread(thread.id, { archived: false, status: "idle", statusMessage: "Reopened" });
      this.deps.emit({ type: "thread:updated", payload: revived });
    }
    this.focusedThreadId = thread.id;
    if (thread.interrupted) {
      this.store.updateThread(thread.id, { interrupted: false, interruptedAt: undefined });
      this.deps.emit({ type: "thread:updated", payload: this.store.getThread(thread.id)! });
    }
    const text = request.text.trim();
    if (!text) return;
    this.assertBudget(thread.nodeId);
    audit("user-prompt", { threadId: thread.id, nodeId: thread.nodeId, model: thread.model.selector, chars: text.length, text: text.slice(0, 2_000) });
    if (request.checkpoint && this.store.settings.autoCheckpoints !== false) {
      await this.createCheckpoint(thread.id, "Before prompt").catch((error) => {
        trace("checkpoint-auto-failed", { threadId: thread.id, error: String(error) });
      });
    }
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

  async suspendThread(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("This session has no live process to pause");
    await session.suspend();
    const updated = this.store.updateThread(threadId, { paused: true, statusMessage: "Paused (process suspended)" });
    this.deps.emit({ type: "thread:updated", payload: updated });
    audit("thread-pause", { threadId });
  }

  async resumeThread(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const session = this.sessions.get(threadId);
    if (!session) throw new Error("This session has no live process to resume");
    await session.resume();
    const updated = this.store.updateThread(threadId, { paused: false, statusMessage: "Resumed" });
    this.deps.emit({ type: "thread:updated", payload: updated });
    audit("thread-resume", { threadId });
  }

  async stopThread(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (session) await session.abort();
    this.updateStatus(threadId, "idle", "Stopped");
  }

  async restartThread(threadId: string): Promise<void> {
    const thread = this.store.getThread(threadId);
    if (thread?.archived) {
      const revived = this.store.updateThread(threadId, { archived: false, status: "idle", statusMessage: "Restarting" });
      this.deps.emit({ type: "thread:updated", payload: revived });
    }
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

  /**
   * Change a node's tool-approval policy. Idle sessions are recycled so the
   * next prompt starts with the new policy; a running turn is left alone.
   */
  async setNodeApproval(nodeId: string, mode: ApprovalMode): Promise<TreeNode> {
    if (!["always-ask", "write", "yolo"].includes(mode)) throw new Error(`Unknown approval mode: ${mode}`);
    const node = this.store.getNode(nodeId);
    if (!node) throw new Error("Node not found");
    const updated = this.store.updateNode(nodeId, { approvalMode: mode });
    this.deps.emit({ type: "node:updated", payload: updated });
    if (mode === "yolo") {
      const pending = [...this.approvals.entries()].filter(([, entry]) => this.store.getThread(entry.threadId)?.nodeId === nodeId);
      for (const [id, entry] of pending) {
        const rule = this.matchPermissionRule(entry.request);
        if (rule?.action === "deny") {
          await this.respondApproval(id, denyValue(entry.request)).catch(() => undefined);
          continue;
        }
        if (rule?.action === "ask") continue;
        const value = autoApproveValue(entry.request);
        if (value !== undefined) await this.respondApproval(id, value).catch(() => undefined);
      }
    }
    for (const thread of this.store.threadsForNode(nodeId)) {
      const session = this.sessions.get(thread.id);
      if (session && !["running", "starting", "waiting"].includes(thread.status)) {
        await this.disposeSession(thread.id).catch(() => undefined);
      }
    }
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

  listCheckpoints(threadId?: string): Checkpoint[] {
    return threadId ? this.store.checkpoints.filter((item) => item.threadId === threadId) : this.store.checkpoints;
  }

  async createCheckpoint(threadId: string, label = "Manual checkpoint"): Promise<Checkpoint> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const node = this.store.getNode(thread.nodeId);
    if (!node) throw new Error("Node not found");
    const cwd = thread.worktreePath || node.repoPath || node.path;
    const entries = await this.getThreadEntries(threadId).catch(() => []);
    const sha = await this.deps.git.createSnapshot(cwd, label);
    if (!sha) throw new Error("Could not create a checkpoint. The thread folder must be a git repository.");
    const checkpoint: Checkpoint = {
      id: newId("cp"),
      threadId,
      nodeId: thread.nodeId,
      label,
      sha,
      cwd,
      entryId: entries.at(-1)?.id,
      createdAt: Date.now(),
    };
    audit("checkpoint-create", { threadId, label, sha });
    return this.store.addCheckpoint(checkpoint);
  }

  async restoreCheckpoint(id: string, mode: "code" | "both"): Promise<{ restored: number; removed: number }> {
    const checkpoint = this.store.getCheckpoint(id);
    if (!checkpoint) throw new Error("Checkpoint not found");
    const result = await this.deps.git.restoreSnapshot(checkpoint.cwd, checkpoint.sha);
    if (mode === "both" && checkpoint.entryId) {
      await this.navigateThread(checkpoint.threadId, checkpoint.entryId, false).catch((error) => {
        trace("checkpoint-conversation-restore-failed", { threadId: checkpoint.threadId, error: String(error) });
      });
    }
    audit("checkpoint-restore", { checkpointId: id, threadId: checkpoint.threadId, mode, ...result });
    await this.gitStatus(checkpoint.nodeId, checkpoint.threadId).catch(() => undefined);
    return result;
  }

  async getThreadEntries(threadId: string): Promise<any[]> {
    if (this.store.getChat(threadId).length === 0) return [];
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
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    if (op === "get") return { goal: thread.goal };
    if (op === "create") {
      const text = objective?.trim();
      if (!text) throw new Error("A goal objective is required");
      const goal = { objective: text, tokenBudget: tokenBudget && tokenBudget > 0 ? tokenBudget : undefined, status: "active" as const, createdAt: Date.now(), turns: 0 };
      const updated = this.store.updateThread(threadId, { goal });
      this.deps.emit({ type: "thread:updated", payload: updated });
      await this.sendUserMessage({
        threadId,
        text: `Goal: ${text}\n\nWork toward this goal. Report what you changed and what remains. Continue until it is complete or I pause it.`,
      });
      return { goal: this.store.getThread(threadId)?.goal };
    }
    const status = op === "resume" ? "active" : op === "pause" ? "paused" : "dropped";
    const updated = this.store.updateThread(threadId, { goal: thread.goal ? { ...thread.goal, status } : undefined });
    this.deps.emit({ type: "thread:updated", payload: updated });
    return { goal: updated.goal };
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

  pendingApprovals(): ApprovalRequest[] {
    return [...this.approvals.values()].map((entry) => entry.request);
  }

  notify(event: AppEvent): void {
    this.deps.emit(event);
  }

  async respondApproval(id: string, response: unknown): Promise<void> {    const entry = this.approvals.get(id);
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

  createEnvironment(input: {
    name: string;
    cwd?: string;
    envVars?: Array<{ key: string; value: string }>;
    setupCommands?: string[];
    teardownCommands?: string[];
    shell?: string;
    inheritEnv?: boolean;
    gitMode?: GitMode;
    approvalMode?: Environment["approvalMode"];
  }): Environment {
    const now = Date.now();
    const env: Environment = {
      id: newId("env"),
      name: input.name.trim() || "New environment",
      cwd: input.cwd?.trim() || undefined,
      envVars: (input.envVars ?? []).map((item) => ({ key: item.key, value: item.value, secret: false })),
      setupCommands: (input.setupCommands ?? []).filter(Boolean),
      teardownCommands: (input.teardownCommands ?? []).filter(Boolean),
      shell: input.shell?.trim() || undefined,
      inheritEnv: input.inheritEnv !== false,
      gitMode: input.gitMode ?? "auto",
      approvalMode: input.approvalMode ?? this.store.settings.defaultApprovalMode ?? "yolo",
      createdAt: now,
      updatedAt: now,
    };
    const saved = this.deps.environments.save(env);
    this.deps.emit({ type: "snapshot", payload: this.snapshot() });
    return saved;
  }

  updateEnvironment(
    id: string,
    input: Partial<Omit<Environment, "envVars">> & { envVars?: Array<{ key: string; value: string }> },
  ): Environment {
    const existing = this.store.getEnvironment(id);
    if (!existing) throw new Error(`Environment not found: ${id}`);
    const previous = new Map(existing.envVars.map((item) => [item.key, item]));
    const merged: Environment = {
      ...existing,
      ...input,
      envVars: input.envVars
        ? input.envVars.map((item) => {
            const prev = previous.get(item.key);
            if (prev?.secret) return { key: item.key, value: item.value ?? "", secret: true, hasSecret: true };
            return { key: item.key, value: item.value ?? "", secret: false };
          })
        : existing.envVars,
      updatedAt: Date.now(),
    } as Environment;
    const saved = this.deps.environments.save(merged);
    this.deps.emit({ type: "snapshot", payload: this.snapshot() });
    return saved;
  }

  listEnvironments(): Environment[] {
    return this.deps.environments.list();
  }

  assignEnvironment(nodeId: string, environmentId: string): TreeNode {
    const env = this.store.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment not found: ${environmentId}`);
    const node = this.store.updateNode(nodeId, { environmentId });
    this.deps.emit({ type: "node:updated", payload: node });
    return node;
  }

  async testEnvironment(environmentId: string, nodeId?: string): Promise<{ ok: boolean; output: string }> {
    const env = this.store.getEnvironment(environmentId);
    if (!env) throw new Error(`Environment not found: ${environmentId}`);
    const node = nodeId ? this.store.getNode(nodeId) : undefined;
    const cwd = env.cwd || node?.repoPath || node?.path || this.store.baseDir;
    return this.deps.environments.test(environmentId, cwd);
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

  async gitRejectHunk(nodeId: string, threadId: string, path: string, patch: string): Promise<{ ok: boolean; output: string }> {
    const thread = this.store.getThread(threadId);
    if (!thread?.worktreePath) return { ok: false, output: "Thread is not isolated" };
    if (!patch.includes("@@")) return { ok: false, output: "No hunk patch provided" };
    const result = await this.deps.git.applyReversePatch(thread.worktreePath, patch);
    await this.gitStatus(nodeId, threadId);
    return { ok: result.code === 0, output: `${result.stdout}\n${result.stderr}`.trim() || (result.code === 0 ? `Reverted hunk in ${path}` : "Patch failed") };
  }

  /** Stop a local Pi session without deleting its stored transcript. */
  async releaseThreadSession(threadId: string): Promise<void> {
    await this.disposeSession(threadId).catch(() => undefined);
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

  setFocusedThread(threadId: string | null): void {
    this.focusedThreadId = threadId;
  }

  diagnostics(): { sessions: number; focused: string | null; approvals: number; chats: ReturnType<Store["diagnostics"]> } {
    return {
      sessions: this.sessions.size,
      focused: this.focusedThreadId,
      approvals: this.approvals.size,
      chats: this.store.diagnostics(),
    };
  }

  async deleteThread(id: string): Promise<void> {
    await this.disposeSession(id).catch(() => undefined);
    this.store.removeThread(id);
    this.deps.emit({ type: "thread:removed", payload: { id } });
  }

  /**
   * Close a finished worker from the tree: archive it and send a result to its
   * parent so the orchestrator sees it as done, not silently disappeared.
   */
  async resolveThread(id: string, note?: string): Promise<Thread> {
    const thread = this.store.getThread(id);
    if (!thread) throw new Error("Thread not found");
    if (thread.kind === "orchestrator") throw new Error("Resolve the node instead; orchestrator threads are owned by their node");
    const parent = thread.parentThreadId ? this.store.getThread(thread.parentThreadId) : undefined;
    const updated = this.store.updateThread(id, {
      archived: true,
      status: "completed",
      statusMessage: note || "Resolved by user",
      pendingApproval: undefined,
    });
    this.deps.emit({ type: "thread:updated", payload: updated });
    if (parent) {
      const body = [
        "Resolved by the user from the tree.",
        `Thread: ${thread.title} (${thread.kind})`,
        `Status: ${thread.status} -> completed`,
        `Model: ${thread.model.name ?? thread.model.selector}; effort: ${thread.effort}`,
        `Usage: ${thread.tokens.toLocaleString()} tokens`,
        thread.git?.branch ? `Git: branch ${thread.git.branch}; ${thread.git.files.length} changed file(s)` : "",
        note ? `Note: ${note}` : "",
      ].filter(Boolean).join("\n");
      await this.bus.send({
        fromThreadId: thread.id,
        toThreadId: parent.id,
        kind: "result",
        subject: `${thread.title} — resolved`,
        body,
        priority: "normal",
        traceId: thread.traceId,
      });
    }
    await this.disposeSession(id).catch(() => undefined);
    return updated;
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
    if (existing && patch.path && patch.path !== existing.path) {
      mkdirSync(patch.path, { recursive: true });
      if (existing.type === "project") patch.repoPath = (await this.deps.git.root(patch.path)) ?? patch.path;
    }
    if (patch.model !== undefined || patch.effort !== undefined) {
      const model = this.deps.models.resolve(patch.model ?? existing.model);
      if (!model) throw new Error(`Model not found: ${patch.model ?? existing.model}`);
      patch.model = model.selector;
      patch.effort = normalizeEffort(patch.effort ?? existing.effort, model);
    }
    const node = this.store.updateNode(id, patch);
    this.deps.emit({ type: "node:updated", payload: node });
    await this.syncOrchestratorThread(node, {
      name: patch.name !== undefined,
      model: patch.model !== undefined,
      effort: patch.effort !== undefined,
    });
    return node;
  }

  /**
   * Keep a node's orchestrator thread in step with node-level settings, so tree
   * changes made from chat take effect without a restart.
   */
  private async syncOrchestratorThread(
    node: TreeNode,
    changed: { name?: boolean; model?: boolean; effort?: boolean },
  ): Promise<void> {
    const thread = this.store.getThread(node.orchestratorThreadId);
    if (!thread) return;
    if (changed.name && thread.title !== node.name) {
      this.store.updateThread(thread.id, { title: node.name });
      this.deps.emit({ type: "thread:updated", payload: this.store.getThread(thread.id)! });
    }
    if (changed.model && node.model && node.model !== thread.model.selector) {
      await this.setThreadModel(thread.id, node.model).catch(() => undefined);
    }
    if (changed.effort && node.effort) {
      const model = this.deps.models.resolve(thread.model.selector);
      const effort = normalizeEffort(node.effort, model);
      if (effort !== thread.effort) await this.setThreadEffort(thread.id, effort).catch(() => undefined);
    }
  }

  private canManageNode(callerNodeId: string, targetNodeId: string): boolean {
    if (!callerNodeId || !targetNodeId) return false;
    if (callerNodeId === targetNodeId) return true;
    const caller = this.store.getNode(callerNodeId);
    if (!caller) return false;
    if (caller.type === "root") return true;
    if (caller.type === "project") return false;
    return this.descendantNodes(callerNodeId).some((node) => node.id === targetNodeId);
  }

  /**
   * An orchestrator may edit environments used inside its own subtree, plus
   * environments nobody has claimed yet. Shared environments owned by another
   * branch stay read-only.
   */
  private canManageEnvironment(callerNodeId: string, environmentId: string): boolean {
    const caller = this.store.getNode(callerNodeId);
    if (caller?.type === "root") return true;
    const owners = this.store.nodes.filter((node) => node.environmentId === environmentId);
    if (!owners.length) return true;
    const managed = new Set([callerNodeId, ...this.descendantNodes(callerNodeId).map((node) => node.id)]);
    return owners.some((node) => managed.has(node.id));
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
    if (this.automationTimer) clearInterval(this.automationTimer);
    for (const timer of this.gitTimers.values()) clearTimeout(timer);
    for (const timer of this.autoContinueTimers.values()) clearTimeout(timer);
    await Promise.all([...this.sessions.values()].map((session) => session.dispose().catch(() => undefined)));
    this.sessions.clear();
  }

  // ---------- sessions ----------

  private async ensureSession(threadId: string): Promise<PiSession> {
    const existing = this.sessions.get(threadId);
    if (existing?.isRunning) return existing;
    const inFlight = this.starting.get(threadId);
    if (inFlight) return inFlight;
    const promise = this.startSession(threadId).finally(() => this.starting.delete(threadId));
    this.starting.set(threadId, promise);
    return promise;
  }

  private async startSession(threadId: string): Promise<PiSession> {
    const thread = this.store.getThread(threadId);
    if (!thread) throw new Error("Thread not found");
    const node = this.store.getNode(thread.nodeId);
    if (!node) throw new Error("Node not found");
    if (thread.kind === "native") throw new Error("Native Pi subagents are controlled by their parent");
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
    this.updateStatus(threadId, "starting", "Starting Pi…");

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

    const session = new PiSession({
      store: this.store,
      cliPath: this.deps.engine.resolveForSpawn(),
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
      const rule = this.matchPermissionRule(request);
      if (rule) {
        audit("permission-rule", { threadId, rule: rule.pattern, action: rule.action, tool: request.toolName, title: request.title });
        if (rule.action === "deny") {
          void session.respondUi(request.id, denyValue(request)).catch(() => undefined);
          return;
        }
        if (rule.action === "allow") {
          const value = autoApproveValue(request);
          if (value !== undefined) {
            void session.respondUi(request.id, value).catch(() => undefined);
            return;
          }
        }
        if (rule.action === "ask") {
          // fall through to the approval UI
        }
      } else if (this.store.getNode(thread.nodeId)?.approvalMode === "yolo") {
        const value = autoApproveValue(request);
        if (value !== undefined) {
          void session.respondUi(request.id, value).catch(() => undefined);
          return;
        }
      }
      this.approvals.set(request.id, { threadId, session, request });
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
    session.on("compaction", (info: any) => {
      this.deps.emit({
        type: "thread:event",
        payload: { id: newId("evt"), threadId, type: "compaction", timestamp: Date.now(), payload: info },
      });
    });
    session.on("title", (title: string) => {
      const current = this.store.getThread(threadId);
      if (current && current.titleAuto) {
        const updated = this.store.updateThread(threadId, { title: cleanThreadTitle(title), titleAuto: true });
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
    this.store.finalizeRunningTools(threadId, "Stopped");
    this.updateStatus(threadId, "parked", "Parked");
  }

  private matchPermissionRule(request: ApprovalRequest): PermissionRule | undefined {
    const rules = this.store.settings.permissions?.rules ?? [];
    if (!rules.length) return;
    const tool = (request.toolName ?? request.kind).trim();
    const args = (request.args ?? {}) as any;
    const target = String(args.command ?? args.path ?? args.pattern ?? request.message ?? "");
    for (const rule of rules) {
      if (!rule.pattern.trim()) continue;
      const match = /^([\w.*:-]+)(?:\((.*)\))?$/.exec(rule.pattern.trim());
      if (!match) continue;
      const toolPattern = match[1];
      const argPattern = match[2];
      if (!globMatch(toolPattern, tool)) continue;
      if (argPattern !== undefined) {
        const haystack = `${target} ${request.title ?? ""} ${request.message ?? ""}`;
        if (!globMatch(argPattern, haystack)) continue;
      }
      return rule;
    }
    return undefined;
  }

  private assertComputerUse(): void {
    if (!this.store.settings.computerUse) {
      throw new Error("Computer use is disabled. Enable it in Settings → Sandbox to allow desktop screenshots and input.");
    }
  }

  private assertBudget(nodeId: string): void {
    const node = this.store.getNode(nodeId);
    if (!node) return;
    const budget = Number(node.budgetUsd ?? this.store.settings.usage.budgetUsd ?? 0);
    if (!budget || budget <= 0) return;
    const ids = new Set([node.id, ...this.descendantNodes(node.id).map((item) => item.id)]);
    const cost = this.store.threads.filter((thread) => ids.has(thread.nodeId)).reduce((sum, thread) => sum + thread.cost, 0);
    if (cost < budget) return;
    const action = this.store.settings.usage.budgetAction ?? "warn";
    const key = `${node.id}`;
    audit("budget-hit", { nodeId: node.id, cost, budget, action });
    if (action === "pause") {
      throw new Error(`Budget reached for ${node.name}: $${cost.toFixed(2)} of $${budget.toFixed(2)}. Raise the budget in Settings → Usage or This node.`);
    }
    if (Date.now() - (this.budgetWarned.get(key) ?? 0) > 60 * 60_000) {
      this.budgetWarned.set(key, Date.now());
      this.deps.notifications.notify({
        kind: "usage_limit",
        title: `Budget reached for ${node.name}`,
        body: `$${cost.toFixed(2)} of $${budget.toFixed(2)} spent. Work continues in warn mode.`,
      });
    }
  }

  private updateStatus(threadId: string, status: ThreadStatus, message?: string): void {    const thread = this.store.getThread(threadId);
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
    const stored = this.store.appendChat(message);
    const thread = this.store.getThread(message.threadId);
    if (!thread) {
      if (this.focusedThreadId === message.threadId) this.deps.emit({ type: "thread:message", payload: stored });
      return;
    }
    const final = !!stored.stopReason || !!stored.usage;
    const visible = this.focusedThreadId === thread.id || final || stored.role === "user";
    if (!visible) return;
    const patch: Partial<Thread> = {
      lastActivityAt: Date.now(),
      lastMessage: textOf(stored).slice(0, 240),
    };
    if (stored.usage) {
      patch.tokens = thread.tokens + stored.usage.totalTokens;
      patch.cost = thread.cost + this.estimateCost(thread, stored.usage);
    }
    const updated = this.store.updateThread(thread.id, patch);
    this.deps.emit({ type: "thread:message", payload: stored });
    this.deps.emit({ type: "thread:updated", payload: updated });
    if (stored.usage) this.recomputeUsage();
    if (stored.role === "assistant" && textOf(stored) && final) {
      this.deps.naming.autoName(thread.id, textOf(stored));
      this.maybeRetitle(thread);
    }
  }

  /**
   * Long-running workers drift away from their initial brief. Every few
   * assistant turns, ask the cheap naming model for a better title. Throttled
   * so a chatty thread cannot burn tokens on titles.
   */
  /**
   * Old worker threads were titled with the raw brief ("Objective ...").
   * Compact those once on load without spending model tokens.
   */
  private retitleLegacyWorkers(): void {
    for (const thread of this.store.threads) {
      if (thread.kind !== "worker" || !thread.titleAuto) continue;
      if (!/^(objective|goal|task|brief|mission|assignment)\b/i.test(thread.title)) continue;
      const trace = thread.traceId ? this.store.data.traces.find((item) => item.id === thread.traceId) : undefined;
      const title = this.deps.naming.suggestTitle(trace?.prompt || thread.title, thread.title);
      if (title && title !== thread.title) this.store.updateThread(thread.id, { title });
    }
  }

  private maybeRetitle(thread: Thread): void {
    if (!thread.titleAuto || thread.kind !== "worker") return;
    const state = this.retitleState.get(thread.id) ?? { turns: 0, lastAt: 0 };
    state.turns += 1;
    this.retitleState.set(thread.id, state);
    if (state.turns < 4 || Date.now() - state.lastAt < 10 * 60_000) return;
    state.turns = 0;
    state.lastAt = Date.now();
    this.deps.naming.refreshTitle(thread.id);
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
    let native = this.store.threads.find((thread) => thread.nativeSubagentId === subagentId);
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
            nativeSubagentId: subagentId,
            sessionFile: payload.sessionFile,
          });
          native.agentName = payload.agent;
          native.nativeSubagentParentToolCallId = payload.parentToolCallId;
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
            body: `Native Pi subagent ${native.title} ${payload.status}. Its full transcript is in the nested thread.`,
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
    this.store.finalizeRunningTools(threadId, error ? `Session ended: ${error.message}` : "Session ended before completion");
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

  private async continueGoal(threadId: string): Promise<void> {
    if (this.goalContinuing.has(threadId)) return;
    const thread = this.store.getThread(threadId);
    if (!thread?.goal || thread.goal.status !== "active" || thread.archived) return;
    const last = this.latestSummary(threadId);
    if (/goal complete|goal achieved|objective complete|all done\b/i.test(last)) {
      const updated = this.store.updateThread(threadId, { goal: { ...thread.goal, status: "completed" } });
      this.deps.emit({ type: "thread:updated", payload: updated });
      this.deps.notifications.notify({ kind: "thread_completed", title: "Goal complete", body: thread.title, nodeId: thread.nodeId, threadId });
      return;
    }
    if (thread.goal.tokenBudget && thread.tokens >= thread.goal.tokenBudget) {
      const updated = this.store.updateThread(threadId, { goal: { ...thread.goal, status: "paused" }, statusMessage: "Goal budget reached" });
      this.deps.emit({ type: "thread:updated", payload: updated });
      return;
    }
    if (thread.goal.turns >= 50) {
      const updated = this.store.updateThread(threadId, { goal: { ...thread.goal, status: "paused" }, statusMessage: "Goal paused after 50 turns" });
      this.deps.emit({ type: "thread:updated", payload: updated });
      return;
    }
    const session = this.sessions.get(threadId);
    if (!session?.isRunning) return;
    this.goalContinuing.add(threadId);
    const updated = this.store.updateThread(threadId, { goal: { ...thread.goal, turns: thread.goal.turns + 1 } });
    this.deps.emit({ type: "thread:updated", payload: updated });
    setTimeout(() => {
      this.goalContinuing.delete(threadId);
      void session.prompt("Continue working toward the goal. Report progress and what remains. If the goal is fully complete, say GOAL COMPLETE.", "prompt").catch(() => undefined);
    }, 750);
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
    void this.continueGoal(threadId);
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
    // Orchestrators report deliberately through `tree_report`. Auto-report is a
    // safety net for leaf work; otherwise every orchestrator turn wakes its
    // parent and the tree turns into a report storm.
    if (thread.kind === "orchestrator") return;
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

  private flushing = new Set<string>();

  private async deliverEnvelope(envelope: Envelope, options?: { skipFlush?: boolean }): Promise<boolean> {
    const debug = process.argv.includes("--integration-test");
    if (debug) console.log("DELIVER_START", envelope.id, envelope.fromThreadId, "->", envelope.toThreadId, envelope.kind, envelope.direction);
    const target = this.store.getThread(envelope.toThreadId);
    if (!target) return false;
    if (target.kind === "native") {
      const parent = target.parentThreadId ? this.sessions.get(target.parentThreadId) : undefined;
      if (parent?.isRunning && target.nativeSubagentId) {
        await parent.steerSubagent(target.nativeSubagentId, envelope.body).catch(() => undefined);
        return true;
      }
      return false;
    }
    // Progress reports are queued for the parent's next turn instead of
    // steering or waking it. Only decisions and completed work interrupt.
    if (envelope.direction === "up" && envelope.kind === "progress" && !envelope.requiresResponse) return false;
    const urgent = ["question", "escalation", "result", "cancel"].includes(envelope.kind);
    const shouldWake =
      envelope.direction === "down" || envelope.fromThreadId === "user" || (this.store.settings.autoWakeParent && urgent);
    if (!this.sessions.get(target.id)?.isRunning && !shouldWake) return false;
    let session: PiSession;
    try {
      if (debug) console.log("DELIVER_ENSURE", target.id, target.title, target.status);
      session = await this.ensureSession(target.id);
    } catch {
      return false;
    }
    const text = this.bus.formatForPrompt(envelope, target);
    if (text.length > 100_000) trace("deliver-large", { target: target.id, chars: text.length, kind: envelope.kind });
    const current = this.store.getThread(target.id);
    try {
      if (!options?.skipFlush) await this.flushQueued(target.id, envelope.id);
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
    if (this.flushing.has(threadId)) return;
    this.flushing.add(threadId);
    try {
      const queued = this.store.listEnvelopes({ threadId, limit: 50 }).filter(
        (envelope) => envelope.toThreadId === threadId && envelope.status === "queued" && envelope.id !== excludeId,
      ).slice(0, 5);
      for (const envelope of queued) {
        const delivered = await this.deliverEnvelope(envelope, { skipFlush: true });
        if (delivered) this.bus.markDelivered(envelope);
      }
    } finally {
      this.flushing.delete(threadId);
    }
  }

  // ---------- host tools ----------

  private async handleHostTool(context: HostToolContext): Promise<HostToolResult> {
    const debug = process.argv.includes("--integration-test");
    if (debug) console.log("HOST_TOOL_START", context.thread.id, context.toolName, JSON.stringify(context.args).slice(0, 200));
    audit("host-tool", { threadId: context.thread.id, nodeId: context.node.id, tool: context.toolName, args: JSON.stringify(context.args).slice(0, 2_000) });
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
            gitInit: !!context.args.gitInit,
            environmentId: typeof context.args.environmentId === "string" ? context.args.environmentId : undefined,
            approvalMode: context.args.approvalMode,
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
        case "lsp": {
          const result = await lspRequest({
            action: context.args.action,
            cwd: context.cwd,
            path: String(context.args.path ?? ""),
            line: context.args.line == null ? undefined : Number(context.args.line),
            character: context.args.character == null ? undefined : Number(context.args.character),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { action: context.args.action, result },
          };
        }
        case "ast_grep": {
          const result = astGrep({
            cwd: context.cwd,
            pattern: String(context.args.pattern ?? ""),
            path: typeof context.args.path === "string" ? context.args.path : undefined,
            lang: typeof context.args.lang === "string" ? context.args.lang : undefined,
            limit: context.args.limit == null ? undefined : Number(context.args.limit),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { matches: result.matches.length, files: result.files, truncated: result.truncated },
          };
        }
        case "ast_edit": {
          const result = astEdit({
            cwd: context.cwd,
            pattern: String(context.args.pattern ?? ""),
            rewrite: String(context.args.rewrite ?? ""),
            path: typeof context.args.path === "string" ? context.args.path : undefined,
            lang: typeof context.args.lang === "string" ? context.args.lang : undefined,
            dryRun: context.args.dryRun === true,
            limit: context.args.limit == null ? undefined : Number(context.args.limit),
          });
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { changes: result.changes.length, files: result.files, applied: result.applied, truncated: result.truncated },
          };
        }
        case "web_search": {
          if (this.store.settings.sandbox.enabled && this.store.settings.sandbox.allowNetwork === false) {
            throw new Error("Network access is disabled in Settings → Sandbox");
          }
          const response = await webSearch(String(context.args.query ?? ""), Number(context.args.limit) || 6);
          if (!response.results.length) return textResult("No web results.");
          return {
            content: [{
              type: "text",
              text: response.results
                .map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`)
                .join("\n\n"),
            }],
            details: { provider: response.provider, count: response.results.length },
          };
        }
        case "python": {
          if (context.args.reset) {
            const reset = this.deps.python.reset(context.thread.id);
            return textResult(reset ? "Python kernel reset." : "No Python kernel was running.");
          }
          const result = await this.deps.python.execute(
            context.thread.id,
            context.cwd,
            String(context.args.code ?? ""),
            Number(context.args.timeoutMs) || 30_000,
          );
          const output = [
            result.stdout ? `stdout:\n${result.stdout}` : "",
            result.stderr ? `stderr:\n${result.stderr}` : "",
            result.result ? `result: ${result.result}` : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          return {
            content: [{ type: "text", text: output || "Python completed with no output." }],
            details: { stdout: result.stdout, stderr: result.stderr, result: result.result },
          };
        }
        case "notebook": {
          const result = await notebookRequest(
            {
              action: context.args.action,
              cwd: context.cwd,
              path: String(context.args.path ?? ""),
              index: context.args.index == null ? undefined : Number(context.args.index),
              source: typeof context.args.source === "string" ? context.args.source : undefined,
              cellType: context.args.cellType,
              save: context.args.save !== false,
              timeoutMs: context.args.timeoutMs == null ? undefined : Number(context.args.timeoutMs),
              threadId: context.thread.id,
            },
            this.deps.python,
          );
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            details: { action: context.args.action, result },
          };
        }
        case "task": {
          const requested = Array.isArray(context.args.tasks) ? context.args.tasks : [];
          const tasks = requested.slice(0, 8).map((item: any) => ({
            title: typeof item?.title === "string" ? item.title : undefined,
            brief: String(item?.brief ?? "").trim(),
            model: typeof item?.model === "string" ? item.model : undefined,
            effort: typeof item?.effort === "string" ? item.effort : undefined,
            isolation: item?.isolation,
          })).filter((item: any) => item.brief);
          if (!tasks.length) throw new Error("task needs at least one task with a brief");
          const created: Thread[] = [];
          for (const item of tasks) {
            created.push(await this.createThread({
              nodeId: context.node.id,
              parentThreadId: context.thread.id,
              title: item.title,
              brief: item.brief,
              model: item.model ?? context.thread.model.selector,
              effort: item.effort ?? context.thread.effort,
              isolation: item.isolation,
              wait: false,
            }));
          }
          if (context.args.wait === false) {
            return textResult(`Started ${created.length} worker(s): ${created.map((thread) => `${thread.title} (${thread.id})`).join(", ")}. Use tree_wait to collect results.`);
          }
          const settled = await this.waitForThreads(created.map((thread) => thread.id), Number(context.args.timeoutMs) || 20 * 60_000);
          const results = settled.map((thread) => ({
            threadId: thread.id,
            title: thread.title,
            status: thread.status,
            summary: this.latestSummary(thread.id),
            error: thread.error,
          }));
          return {
            content: [{ type: "text", text: JSON.stringify({ tasks: results }, null, 2) }],
            details: { tasks: results },
          };
        }
        case "tree_message": {
          const target = this.resolveMessageTarget(context);
          if (!target) throw new Error("Target not found");
          const kind = (context.args.kind as EnvelopeKind) || "note";
          const reuse = !!context.args.reuse;
          if (kind === "task" && target.kind !== "orchestrator" && !reuse) {
            throw new Error(
              `New work must create a worker thread: use tree_create_thread with the full brief instead of messaging "${target.title}". Set reuse:true only for a deliberate follow-up that depends on this worker's existing context.`,
            );
          }
          const envelope = await this.bus.send({
            fromThreadId: context.thread.id,
            toThreadId: target.id,
            kind,
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
        case "tree_resolve_thread": {
          if (context.thread.kind !== "orchestrator") throw new Error("Only orchestrators can resolve threads");
          const threadId = String(context.args.threadId ?? "");
          const target = this.store.getThread(threadId);
          if (!target) throw new Error("Thread not found");
          if (target.kind === "orchestrator") throw new Error("Resolve the node instead; orchestrator threads are owned by their node");
          if (target.parentThreadId !== context.thread.id) throw new Error("You can only resolve your direct child threads");
          if (["running", "starting"].includes(target.status)) throw new Error("Stop the thread before resolving it");
          const resolved = await this.resolveThread(threadId, context.args.note ? String(context.args.note) : undefined);
          return textResult(`Resolved and archived "${resolved.title}".`);
        }
        case "mobile_devices": {
          const status = this.deps.mobile.available();
          if (!status.adb) return textResult("adb was not found on PATH. Install Android platform-tools or add them to PATH.");
          const devices = this.deps.mobile.devices();
          const avds = this.deps.mobile.avds();
          return textResult(
            [
              devices.length ? `Devices:\n${devices.map((device) => `${device.serial} ${device.state}${device.model ? ` ${device.model}` : ""}`).join("\n")}` : "No running devices.",
              avds.length ? `AVDs:\n${avds.join("\n")}` : "No AVDs found.",
            ].join("\n\n"),
          );
        }
        case "mobile_start_avd": {
          this.deps.mobile.startAvd(String(context.args.name ?? ""));
          return textResult(`Started emulator ${context.args.name}. It may take a minute to appear in mobile_devices.`);
        }
        case "mobile_screenshot": {
          const path = await this.deps.mobile.screenshot(context.args.device ? String(context.args.device) : undefined);
          this.deps.artifacts.recordFile(context.thread, path, this.store.baseDir);
          try {
            const data = readFileSync(path).toString("base64");
            if (data.length < 8_000_000) {
              this.handleChat({
                id: newId("msg"),
                threadId: context.thread.id,
                role: "assistant",
                blocks: [{ type: "image", mimeType: "image/png", data, path }],
                timestamp: Date.now(),
                model: context.thread.model.name,
              });
            }
          } catch {
            /* artifact exists */
          }
          return textResult(`Android screenshot saved to ${path} and shown in this thread.`);
        }
        case "mobile_tap":
          return textResult(this.deps.mobile.tap(context.args.device ? String(context.args.device) : undefined, Number(context.args.x), Number(context.args.y)));
        case "mobile_text":
          return textResult(this.deps.mobile.text(context.args.device ? String(context.args.device) : undefined, String(context.args.text ?? "")));
        case "mobile_key":
          return textResult(this.deps.mobile.key(context.args.device ? String(context.args.device) : undefined, String(context.args.key ?? "")));
        case "computer_screenshot": {
          this.assertComputerUse();
          const path = await this.deps.computer.screenshot();
          this.deps.artifacts.recordFile(context.thread, path, this.store.baseDir);
          try {
            const data = readFileSync(path).toString("base64");
            if (data.length < 8_000_000) {
              this.handleChat({
                id: newId("msg"),
                threadId: context.thread.id,
                role: "assistant",
                blocks: [{ type: "image", mimeType: "image/png", data, path }],
                timestamp: Date.now(),
                model: context.thread.model.name,
              });
            }
          } catch {
            /* artifact still exists */
          }
          return textResult(`Desktop screenshot saved to ${path} and shown in this thread.`);
        }
        case "computer_click":
          this.assertComputerUse();
          return textResult(await this.deps.computer.click(Number(context.args.x), Number(context.args.y), context.args.button === "right" ? "right" : "left"));
        case "computer_type":
          this.assertComputerUse();
          return textResult(await this.deps.computer.type(String(context.args.text ?? "")));
        case "computer_keys":
          this.assertComputerUse();
          return textResult(await this.deps.computer.keys(String(context.args.keys ?? "")));
        case "workspace_search": {
          const matches = this.deps.workspace.searchContent({
            nodeId: context.node.id,
            threadId: context.thread.id,
            query: String(context.args.query ?? ""),
            limit: Number(context.args.limit) || 60,
          });
          if (!matches.length) return textResult("No matches.");
          return textResult(matches.map((match) => `${match.path}:${match.line}: ${match.preview}`).join("\n"));
        }
        case "workspace_map": {
          const symbols = this.deps.workspace.map({ nodeId: context.node.id, threadId: context.thread.id, limit: Number(context.args.limit) || 250 });
          if (!symbols.length) return textResult("No symbols found.");
          return textResult(symbols.map((symbol) => `${symbol.path}:${symbol.line} ${symbol.kind} ${symbol.name}`).join("\n"));
        }
        case "site_deploy": {
          const deployment = await this.deps.deploy.deploy(String(context.args.siteId ?? ""), context.args.provider === "github-pages" ? "github-pages" : "cloudflare");
          this.deps.emit({ type: "sites:updated", payload: this.deps.sites.list() });
          return textResult(`Deployed with ${deployment.provider}${deployment.url ? ` at ${deployment.url}` : ""}. ${deployment.detail ?? ""}`);
        }
        case "site_list": {
          const list = this.deps.sites.list();
          if (!list.length) return textResult("No sites yet. Create one with site_create.");
          return textResult(
            list
              .map(
                (site) =>
                  `${site.id} | ${site.name} | ${site.url || "not published"} | node ${site.nodeId} | versions ${site.versions.length} | source ${site.sourcePath}`,
              )
              .join("\n"),
          );
        }
        case "site_create": {
          const site = this.deps.sites.create({
            name: String(context.args.name ?? ""),
            nodeId: String(context.args.nodeId ?? context.node.id),
            path: String(context.args.path ?? "."),
          });
          if (context.args.publish !== false) {
            const published = await this.deps.sites.publish(site.id);
            this.deps.emit({ type: "sites:updated", payload: this.deps.sites.list() });
            return textResult(`Created and published "${published.name}" at ${published.url}`);
          }
          this.deps.emit({ type: "sites:updated", payload: this.deps.sites.list() });
          return textResult(`Created site "${site.name}" (${site.id}). Publish with site_publish.`);
        }
        case "site_publish": {
          const site = await this.deps.sites.publish(String(context.args.siteId ?? ""));
          this.deps.emit({ type: "sites:updated", payload: this.deps.sites.list() });
          return textResult(`Published "${site.name}" version ${site.currentVersion} at ${site.url}`);
        }
        case "dev_server_start": {
          const command = String(context.args.command ?? "");
          if (!command.trim()) throw new Error("command is required");
          const result = await this.deps.pty.startDevServer({
            command,
            nodeId: context.args.nodeId ? String(context.args.nodeId) : context.node.id,
            threadId: context.thread.id,
          });
          if (!result.url) {
            return textResult(
              `Started dev server in terminal ${result.session.id} (cwd ${result.session.cwd}), but no localhost URL was detected within 30s. Check app_preview_logs or the Terminal panel, or open the URL manually with app_browser_navigate.`,
            );
          }
          return textResult(
            `Dev server running in terminal ${result.session.id}. Preview URL: ${result.url}. Open it with app_browser_navigate and verify console/network with app_browser_console and app_browser_network.`,
          );
        }
        case "dev_server_stop": {
          const sessionId = String(context.args.sessionId ?? "");
          if (!sessionId) throw new Error("sessionId is required");
          this.deps.pty.kill(sessionId);
          return textResult(`Stopped terminal ${sessionId}.`);
        }
        case "dev_server_list": {
          const sessions = this.deps.pty.list().filter((session) => session.status === "running");
          if (!sessions.length) return textResult("No running terminals or dev servers.");
          return textResult(
            sessions
              .map((session) => `${session.id} | ${session.title} | ${session.cwd}${session.urls.length ? ` | ${session.urls.join(", ")}` : ""}`)
              .join("\n"),
          );
        }
        case "app_browser_visual_diff": {
          const result = await this.deps.browser.compare(String(context.args.before ?? ""), String(context.args.after ?? ""));
          this.deps.artifacts.recordFile(context.thread, result.path, this.store.baseDir);
          return textResult(`Visual diff: ${result.percent}% changed (${result.diffPixels}/${result.totalPixels} pixels). Diff image: ${result.path}`);
        }
        case "app_browser_console": {          const limit = Math.min(300, Math.max(1, Number(context.args.limit) || 80));
          const level = context.args.level ? String(context.args.level) : "";
          let entries = this.deps.browser.history().console;
          if (level) entries = entries.filter((entry) => entry.level === level);
          entries = entries.slice(-limit);
          if (context.args.clear) this.deps.browser.clearConsole();
          if (!entries.length) return textResult(level ? `No ${level} console messages.` : "No console messages yet.");
          return textResult(
            entries
              .map((entry) => {
                const source = entry.source ? ` (${entry.source}${entry.line ? `:${entry.line}` : ""})` : "";
                return `[${entry.level}] ${entry.message}${source}`;
              })
              .join("\n"),
          );
        }
        case "app_browser_network": {
          const limit = Math.min(300, Math.max(1, Number(context.args.limit) || 80));
          const filter = String(context.args.filter ?? "").toLowerCase();
          let entries = this.deps.browser.history().network;
          if (context.args.failedOnly) entries = entries.filter((entry) => !entry.ok);
          if (filter) entries = entries.filter((entry) => entry.url.toLowerCase().includes(filter));
          entries = entries.slice(-limit);
          if (!entries.length) return textResult("No matching network requests.");
          return textResult(
            entries
              .map((entry) => {
                const status = entry.ok === false ? entry.failed ? `FAILED ${entry.failed}` : "FAILED" : String(entry.status ?? "?");
                const duration = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : "";
                return `${status} ${entry.method} ${entry.type} ${entry.url}${duration}`;
              })
              .join("\n"),
          );
        }
        case "app_browser_navigate": {
          const url = String(context.args.url ?? "");
          if (!/^https?:\/\//i.test(url)) throw new Error("Only http/https URLs are supported");
          const current = await this.deps.browser.navigate(url);
          return textResult(`In-app browser is at ${current}.`);
        }
        case "app_browser_read": {
          const text = await this.deps.browser.read();
          return textResult(text || "(page is empty)");
        }
        case "app_browser_click": {
          const result = await this.deps.browser.click(String(context.args.selector ?? ""));
          return textResult(result);
        }
        case "app_browser_type": {
          const result = await this.deps.browser.type(
            String(context.args.selector ?? ""),
            String(context.args.text ?? ""),
            !!context.args.submit,
          );
          return textResult(result);
        }
        case "app_browser_back":
          await this.deps.browser.back();
          return textResult("Went back.");
        case "app_browser_forward":
          await this.deps.browser.forward();
          return textResult("Went forward.");
        case "app_browser_reload":
          await this.deps.browser.reload();
          return textResult("Reloaded.");
        case "app_browser_screenshot": {
          const path = await this.deps.browser.screenshot();
          this.deps.artifacts.recordFile(context.thread, path, this.store.baseDir);
          try {
            const data = readFileSync(path).toString("base64");
            if (data.length < 8_000_000) {
              this.handleChat({
                id: newId("msg"),
                threadId: context.thread.id,
                role: "assistant",
                blocks: [{ type: "image", mimeType: "image/png", data, path }],
                timestamp: Date.now(),
                model: context.thread.model.name,
              });
            }
          } catch {
            /* artifact still exists */
          }
          return textResult(`Screenshot saved to ${path} and shown in this thread. Analyse it with inspect_image or open it from Artifacts.`);
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
        case "tree_update_node": {
          if (context.thread.kind !== "orchestrator") throw new Error("Only orchestrators can change the tree");
          const targetId = String(context.args.nodeId ?? context.node.id);
          if (!this.canManageNode(context.node.id, targetId)) throw new Error("You can only update nodes in your subtree");
          const patch: Partial<TreeNode> = {};
          for (const key of ["name", "path", "model", "effort", "gitMode", "approvalMode", "environmentId"] as const) {
            if (context.args[key] !== undefined) (patch as any)[key] = context.args[key];
          }
          if (context.args.muted !== undefined) patch.muted = !!context.args.muted;
          if (context.args.environmentId) {
            if (!this.store.getEnvironment(String(context.args.environmentId))) throw new Error("Environment not found");
            if (!this.canManageEnvironment(context.node.id, String(context.args.environmentId))) {
              throw new Error("That environment belongs to another part of the tree");
            }
          }
          const node = await this.updateNode(targetId, patch);
          return textResult(`Updated ${node.type} "${node.name}" (${node.id}).`);
        }
        case "tree_move_node": {
          if (context.thread.kind !== "orchestrator") throw new Error("Only orchestrators can change the tree");
          const targetId = String(context.args.nodeId ?? "");
          const parentId = String(context.args.parentId ?? "");
          if (!this.canManageNode(context.node.id, targetId)) throw new Error("You can only move nodes in your subtree");
          if (!this.canManageNode(context.node.id, parentId)) throw new Error("You can only move nodes within your own subtree");
          const parent = this.store.getNode(parentId);
          if (!parent || parent.type === "project") throw new Error("Target parent must be the root or a group");
          const node = await this.updateNode(targetId, { parentId });
          return textResult(`Moved "${node.name}" under "${parent.name}".`);
        }
        case "tree_delete_node": {
          if (context.thread.kind !== "orchestrator") throw new Error("Only orchestrators can change the tree");
          if (!context.args.confirm) throw new Error("Set confirm:true after confirming with the user");
          const targetId = String(context.args.nodeId ?? "");
          if (!this.canManageNode(context.node.id, targetId)) throw new Error("You can only delete nodes in your subtree");
          const target = this.store.getNode(targetId);
          if (!target || target.type === "root") throw new Error("Cannot delete the root node");
          await this.deleteNode(targetId);
          return textResult(`Deleted ${target.type} "${target.name}" from the tree. Files and branches remain on disk.`);
        }
        case "tree_create_environment": {
          if (context.thread.kind === "worker") throw new Error("Only orchestrators can create environments");
          const env = this.createEnvironment({
            name: String(context.args.name ?? "New environment"),
            cwd: context.args.cwd,
            envVars: Array.isArray(context.args.envVars) ? context.args.envVars.map((item: any) => ({ key: String(item.key), value: String(item.value) })) : [],
            setupCommands: Array.isArray(context.args.setupCommands) ? context.args.setupCommands.map(String) : [],
            teardownCommands: Array.isArray(context.args.teardownCommands) ? context.args.teardownCommands.map(String) : [],
            shell: context.args.shell,
            inheritEnv: context.args.inheritEnv,
            gitMode: context.args.gitMode,
            approvalMode: context.args.approvalMode,
          });
          return textResult(`Created environment "${env.name}" (${env.id}). Assign it with tree_assign_environment.`);
        }
        case "tree_update_environment": {
          if (context.thread.kind === "worker") throw new Error("Only orchestrators can update environments");
          const environmentId = String(context.args.environmentId ?? "");
          if (!this.store.getEnvironment(environmentId)) throw new Error("Environment not found");
          if (!this.canManageEnvironment(context.node.id, environmentId)) {
            throw new Error("That environment belongs to another part of the tree");
          }
          const env = this.updateEnvironment(environmentId, {
            name: context.args.name,
            cwd: context.args.cwd,
            envVars: Array.isArray(context.args.envVars) ? context.args.envVars.map((item: any) => ({ key: String(item.key), value: String(item.value) })) : undefined,
            setupCommands: Array.isArray(context.args.setupCommands) ? context.args.setupCommands.map(String) : undefined,
            teardownCommands: Array.isArray(context.args.teardownCommands) ? context.args.teardownCommands.map(String) : undefined,
            shell: context.args.shell,
            inheritEnv: context.args.inheritEnv,
            gitMode: context.args.gitMode,
            approvalMode: context.args.approvalMode,
          });
          return textResult(`Updated environment "${env.name}" (${env.id}).`);
        }
        case "tree_assign_environment": {
          const targetId = String(context.args.nodeId ?? context.node.id);
          if (!this.canManageNode(context.node.id, targetId)) throw new Error("You can only update nodes in your subtree");
          const environmentId = String(context.args.environmentId ?? "");
          if (!this.store.getEnvironment(environmentId)) throw new Error("Environment not found");
          if (!this.canManageEnvironment(context.node.id, environmentId)) {
            throw new Error("That environment belongs to another part of the tree");
          }
          const node = this.assignEnvironment(targetId, environmentId);
          return textResult(`Assigned environment ${environmentId} to "${node.name}". New sessions will use it.`);
        }
        case "tree_list_environments": {
          const envs = this.listEnvironments();
          return textResult(envs.length ? envs.map((env) => `- ${env.name} (${env.id}) vars=${env.envVars.map((v) => v.key).join(",") || "none"} setup=${env.setupCommands.length} teardown=${env.teardownCommands.length}${env.cwd ? ` cwd=${env.cwd}` : ""}`).join("\n") : "No environments.");
        }
        case "tree_test_environment": {
          const environmentId = String(context.args.environmentId ?? "");
          if (!this.store.getEnvironment(environmentId)) throw new Error("Environment not found");
          if (!this.canManageEnvironment(context.node.id, environmentId)) {
            throw new Error("That environment belongs to another part of the tree");
          }
          const nodeId = context.args.nodeId ? String(context.args.nodeId) : undefined;
          if (nodeId && !this.canManageNode(context.node.id, nodeId)) throw new Error("You can only test environments in your subtree");
          const result = await this.testEnvironment(environmentId, nodeId);
          return { ...textResult(result.output || (result.ok ? "Environment ready." : "Environment test failed.")), isError: !result.ok };
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
      const result = await this.gitCommit(node.id, thread?.id, String(context.args.message ?? "Perch: commit"), undefined);
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
      if (current.every((thread) => {
        if (thread.pendingApproval) return false;
        if (["completed", "error", "cancelled"].includes(thread.status)) return true;
        return thread.status === "idle" && this.store.getChat(thread.id).length > 0;
      })) {
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
    const perNode: Record<string, { cost: number; referenceCost: number; tokens: number; threads: number }> = {};
    let meteredCost = 0;
    let referenceCost = 0;
    let totalTokens = 0;
    for (const thread of this.store.threads) {
      const model = this.deps.models.resolve(thread.model.selector);
      const included = model?.billing === "subscription";
      if (included) referenceCost += thread.cost;
      else meteredCost += thread.cost;
      totalTokens += thread.tokens;
      const current = perNode[thread.nodeId] ?? { cost: 0, referenceCost: 0, tokens: 0, threads: 0 };
      if (included) current.referenceCost += thread.cost;
      else current.cost += thread.cost;
      current.tokens += thread.tokens;
      current.threads += 1;
      perNode[thread.nodeId] = current;
    }
    const usage = {
      ...this.store.data.usage,
      generatedAt: Date.now(),
      totalCost: meteredCost,
      meteredCost,
      referenceCost,
      totalTokens,
      perNode,
    };
    this.store.setUsage(usage);
    this.deps.emit({ type: "usage:updated", payload: usage });
  }

  private uniqueWorkspacePath(candidate: string): string {
    if (!existsSync(candidate)) return candidate;
    for (let index = 2; index < 100; index += 1) {
      const next = `${candidate}-${index}`;
      if (!existsSync(next)) return next;
    }
    return `${candidate}-${Date.now().toString(36)}`;
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

  refreshStatusTimer(): void {
    this.startStatusTimer();
  }

  private startStatusTimer(): void {
    if (this.statusTimer) clearInterval(this.statusTimer);
    const minutes = this.store.settings.statusCheckIntervalMin;
    if (!minutes || minutes <= 0) return;
    this.statusTimer = setInterval(() => void this.requestStatusUpdates(), Math.max(1, minutes) * 60_000);
  }

  /**
   * Mission Control nudges its direct child orchestrators for a compact status
   * report. It never asks running children, and never does the work itself.
   */
  private async requestStatusUpdates(): Promise<void> {
    const root = this.store.nodes.find((node) => node.type === "root");
    if (!root) return;
    const rootThread = this.store.getThread(root.orchestratorThreadId);
    if (!rootThread || ["running", "starting"].includes(rootThread.status)) return;
    const targets = this.store.nodes
      .filter((node) => node.parentId === root.id)
      .map((node) => this.store.getThread(node.orchestratorThreadId))
      .filter((thread): thread is Thread => !!thread && !thread.archived && !["running", "starting"].includes(thread.status))
      .slice(0, 8);
    if (!targets.length) return;
    trace("status-check", { targets: targets.map((thread) => thread.id) });
    for (const target of targets) {
      await this.bus
        .send({
          fromThreadId: rootThread.id,
          toThreadId: target.id,
          kind: "question",
          subject: "Status check",
          body: "Status check from Mission Control. Reply with: current outcome, evidence, blockers, next step, and whether anything needs a decision. Do not start new work just to answer.",
          priority: "normal",
          requiresResponse: false,
        })
        .catch(() => undefined);
    }
  }

  private emitDigest(): void {
    const root = this.store.nodes.find((node) => node.type === "root");
    if (!root) return;
    const live = this.store.threads.filter((thread) => !thread.archived);
    const running = live.filter((thread) => thread.status === "running" || thread.status === "starting");
    const waiting = live.filter((thread) => thread.status === "waiting" || thread.pendingApproval);
    const errors = live.filter((thread) => thread.status === "error");
    const completed = live.filter((thread) => thread.status === "completed");
    if (!running.length && !waiting.length && !errors.length) return;
    const label = (thread: Thread) => {
      const node = this.store.getNode(thread.nodeId);
      return node && node.type !== "root" ? `${thread.title} (${node.name})` : thread.title;
    };
    const list = (threads: Thread[]) => {
      const shown = threads.slice(0, 3).map(label).join(", ");
      return threads.length > 3 ? `${shown} +${threads.length - 3} more` : shown;
    };
    const lines: string[] = [];
    if (waiting.length) lines.push(`Waiting on you: ${list(waiting)}`);
    if (errors.length) lines.push(`Failed: ${list(errors)}`);
    if (running.length) lines.push(`Running: ${list(running)}`);
    lines.push(`${running.length} running · ${waiting.length} waiting · ${errors.length} failed · ${completed.length} completed`);
    const focus = waiting[0] ?? errors[0] ?? running[0] ?? this.store.getThread(root.orchestratorThreadId);
    const title = waiting.length
      ? `${waiting.length} thread${waiting.length === 1 ? "" : "s"} need${waiting.length === 1 ? "s" : ""} your decision`
      : errors.length
        ? `${errors.length} thread${errors.length === 1 ? "" : "s"} failed`
        : `${running.length} thread${running.length === 1 ? "" : "s"} still running`;
    this.deps.notifications.notify({
      kind: "digest",
      title,
      body: lines.join("\n"),
      nodeId: focus?.nodeId ?? root.id,
      threadId: focus?.id ?? root.orchestratorThreadId,
    });
  }
}

function textResult(text: string): HostToolResult {
  return { content: [{ type: "text", text }] };
}

function textOf(message: ChatMessage): string {
  return message.blocks.filter((block) => block.type === "text").map((block) => (block as any).text).join("\n").trim();
}

/**
 * The response that approves a Pi permission prompt when the node is in
 * yolo mode. Returns undefined for genuine questions we must ask the user.
 */
const ACRONYMS = new Set(["API", "HTTP", "HTTPS", "CLI", "UI", "UX", "RPC", "SSE", "JSON", "GPU", "CPU", "MCP", "LLM", "AI", "CI", "CD", "PR", "URL", "ID", "SDK", "SQL", "CSS", "HTML", "TS", "JS"]);

function cleanThreadTitle(value: string): string {
  let title = value
    .replace(/^["'`#*\s-]+|["'`#*\s.,;:—–-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  title = title
    .split(" ")
    .map((word) => {
      const core = word.replace(/[^A-Za-z]/g, "");
      if (core.length > 2 && core === core.toUpperCase() && !ACRONYMS.has(core)) {
        return word.charAt(0) + word.slice(1).toLowerCase();
      }
      return word;
    })
    .join(" ");
  return title.length > 60 ? `${title.slice(0, 57).trim()}…` : title;
}

function denyValue(request: ApprovalRequest): unknown {
  if (request.kind === "confirm") return false;
  if (request.kind === "select") {
    return request.options?.find((option) => /deny|reject|cancel/i.test(option.label))?.value ?? null;
  }
  return null;
}

function globMatch(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  try {
    return new RegExp(`^${escaped}$`, "i").test(value.trim());
  } catch {
    return false;
  }
}

function autoApproveValue(request: ApprovalRequest): unknown {
  if (request.kind === "confirm") return true;
  if (request.kind !== "select") return undefined;
  const labels = (request.options ?? []).map((option) => option.label.trim());
  if (!labels.some((label) => /^deny$/i.test(label))) return undefined;
  const once = labels.findIndex((label) => /^approve(\s+once)?$/i.test(label));
  if (once >= 0) return String(once);
  const allow = labels.findIndex((label) => /^(allow|approve|yes|run)/i.test(label) && !/deny/i.test(label));
  return allow >= 0 ? String(allow) : undefined;
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
  const preference =
    effort === "medium"
      ? ["high", "low", "minimal", "max"]
      : effort === "high"
        ? ["medium", "xhigh", "low", "max"]
        : ["medium", "high", "low", "max"];
  return preference.find((item) => supported.includes(item)) ?? supported[0] ?? "off";
}

function envToolNames(node: TreeNode, environment?: Environment): string[] {
  const names = environment?.toolNames?.length ? environment.toolNames : node.toolNames;
  return names?.length ? names : [];
}











