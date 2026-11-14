import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AppNotification,
  AppSettings,
  Artifact,
  ChatMessage,
  EngineStatus,
  Envelope,
  Environment,
  MemoryEntry,
  ModelInfo,
  OmpConfigSnapshot,
  Snapshot,
  TerminalRun,
  Thread,
  Trace,
  TreeNode,
  UsageSnapshot,
} from "../../shared/types";

interface PersistedState {
  version: number;
  nodes: TreeNode[];
  threads: Thread[];
  environments: Environment[];
  settings: AppSettings;
  traces: Trace[];
  notifications: AppNotification[];
  artifacts: Artifact[];
  terminals: TerminalRun[];
  models: ModelInfo[];
  modelsUpdatedAt: number;
  ompConfig: OmpConfigSnapshot;
  usage: UsageSnapshot;
  engine: EngineStatus;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "light",
  onboardingCompleted: false,
  enginePath: "",
  workspaceRoot: "",
  defaultApprovalMode: "yolo",
  approvalMigrationDone: false,
  autoName: true,
  autoReport: true,
  autoWakeParent: true,
  digestIntervalMin: 10,
  maxConcurrentThreads: 8,
  contextCompaction: true,
  advisor: false,
  notifications: {
    enabled: true,
    toast: true,
    sound: false,
    onComplete: true,
    onQuestion: true,
    onError: true,
    onDigest: false,
    mutedNodeIds: [],
  },
  models: {
    root: "",
    group: "",
    project: "",
    worker: "",
    naming: "",
    memory: "",
    rootEffort: "high",
    groupEffort: "high",
    projectEffort: "high",
    workerEffort: "medium",
    preferredProvider: "",
    autoUpdateAA: true,
    aaKeySet: false,
  },
  memory: {
    autoCapture: true,
    maxEntries: 2000,
    injectTokenLimit: 3000,
  },
  git: {
    defaultMode: "auto",
    autoCommit: false,
    autoMerge: false,
    branchPrefix: "omp",
  },
  usage: {
    autoContinueOnReset: false,
  },
  share: { enabled: true, port: 4337 },
  ui: { sidebarWidth: 296, rightWidth: 340, showThinking: true, dense: false },
};

const EMPTY_CONFIG: OmpConfigSnapshot = {
  path: "",
  entries: [],
  fetchedAt: 0,
};

const EMPTY_USAGE: UsageSnapshot = {
  generatedAt: 0,
  providers: [],
  totalCost: 0,
  meteredCost: 0,
  referenceCost: 0,
  totalTokens: 0,
  perNode: {},
};

const EMPTY_ENGINE: EngineStatus = {
  found: false,
  downloading: false,
  checkedAt: 0,
};

export class Store {
  readonly baseDir: string;
  readonly sessionsDir: string;
  readonly worktreesDir: string;
  readonly artifactsDir: string;
  readonly memoryDir: string;
  readonly shareDir: string;
  readonly statePath: string;
  private readonly envelopesPath: string;
  private readonly transcriptsDir: string;
  private state!: PersistedState;
  private saveTimer: NodeJS.Timeout | null = null;
  private dirty = false;
  private envelopes: Envelope[] = [];
  private envelopeIndex = new Map<string, number>();
  private chats = new Map<string, ChatMessage[]>();

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(app.getPath("userData"), "omp-studio");
    this.sessionsDir = join(this.baseDir, "sessions");
    this.worktreesDir = join(this.baseDir, "worktrees");
    this.artifactsDir = join(this.baseDir, "artifacts");
    this.memoryDir = join(this.baseDir, "memory");
    this.shareDir = join(this.baseDir, "share");
    this.statePath = join(this.baseDir, "state.json");
    this.envelopesPath = join(this.baseDir, "envelopes.jsonl");
    this.transcriptsDir = join(this.baseDir, "transcripts");
  }

  init(): void {
    for (const dir of [
      this.baseDir,
      this.sessionsDir,
      this.worktreesDir,
      this.artifactsDir,
      this.memoryDir,
      this.shareDir,
      this.transcriptsDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    this.state = this.loadState();
    if (!this.state.settings.workspaceRoot) {
      this.state.settings.workspaceRoot = this.detectWorkspaceRoot();
      this.markDirty();
    }
    if (!this.state.settings.approvalMigrationDone) {
      const target = this.state.settings.defaultApprovalMode || "yolo";
      for (const node of this.state.nodes) if (node.approvalMode === "write") node.approvalMode = target;
      for (const environment of this.state.environments) if (environment.approvalMode === "write") environment.approvalMode = target;
      this.state.settings.approvalMigrationDone = true;
      this.markDirty();
    }
    this.loadEnvelopes();
  }

  /**
   * Pick a sensible home for new projects. Respects an existing dev folder
   * instead of burying repositories in app data.
   */
  private detectWorkspaceRoot(): string {
    const home = app.getPath("home");
    for (const candidate of ["code", "Projects", "projects", "source/repos", "dev", "Developer"]) {
      const path = join(home, candidate);
      if (existsSync(path)) return path;
    }
    return join(home, "code");
  }

  get workspaceRoot(): string {
    return this.state.settings.workspaceRoot?.trim() || this.baseDir;
  }

  private loadState(): PersistedState {
    if (!existsSync(this.statePath)) {
      return {
        version: 1,
        nodes: [],
        threads: [],
        environments: [],
        settings: structuredClone(DEFAULT_SETTINGS),
        traces: [],
        notifications: [],
        artifacts: [],
        terminals: [],
        models: [],
        modelsUpdatedAt: 0,
        ompConfig: { ...EMPTY_CONFIG },
        usage: { ...EMPTY_USAGE },
        engine: { ...EMPTY_ENGINE },
        updatedAt: Date.now(),
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
      return {
        ...parsed,
        settings: deepMerge(structuredClone(DEFAULT_SETTINGS), parsed.settings ?? {}),
        nodes: parsed.nodes ?? [],
        threads: (parsed.threads ?? []).map((t) => {
          const wasActive = ["running", "starting", "queued", "waiting"].includes(t.status);
          const interrupted = wasActive || !!t.pendingApproval || !!t.interrupted;
          return {
            ...t,
            status: wasActive ? "parked" : t.status,
            interrupted: interrupted || undefined,
            interruptedAt: interrupted ? (t.interruptedAt ?? Date.now()) : undefined,
            pendingApproval: undefined,
          };
        }),
        environments: parsed.environments ?? [],
        traces: parsed.traces ?? [],
        notifications: parsed.notifications ?? [],
        artifacts: parsed.artifacts ?? [],
        terminals: (parsed.terminals ?? []).map((t) => (t.status === "running" ? { ...t, status: "cancelled" } : t)),
        models: parsed.models ?? [],
        ompConfig: parsed.ompConfig ?? { ...EMPTY_CONFIG },
        usage: parsed.usage ?? { ...EMPTY_USAGE },
        engine: parsed.engine ?? { ...EMPTY_ENGINE },
      };
    } catch (error) {
      const backup = `${this.statePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.statePath, backup);
      } catch {
        /* ignore */
      }
      return {
        version: 1,
        nodes: [],
        threads: [],
        environments: [],
        settings: structuredClone(DEFAULT_SETTINGS),
        traces: [],
        notifications: [],
        artifacts: [],
        terminals: [],
        models: [],
        modelsUpdatedAt: 0,
        ompConfig: { ...EMPTY_CONFIG },
        usage: { ...EMPTY_USAGE },
        engine: { ...EMPTY_ENGINE },
        updatedAt: Date.now(),
      };
    }
  }

  private loadEnvelopes(): void {
    if (!existsSync(this.envelopesPath)) return;
    try {
      const lines = readFileSync(this.envelopesPath, "utf8").split("\n");
      const byId = new Map<string, Envelope>();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const envelope = JSON.parse(line) as Envelope;
          byId.set(envelope.id, envelope);
        } catch {
          /* skip corrupt line */
        }
      }
      this.envelopes = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt).slice(-8000);
      this.reindexEnvelopes();
    } catch {
      this.envelopes = [];
    }
  }

  private reindexEnvelopes(): void {
    this.envelopeIndex.clear();
    this.envelopes.forEach((e, index) => this.envelopeIndex.set(e.id, index));
  }

  get data(): PersistedState {
    return this.state;
  }

  get settings(): AppSettings {
    return this.state.settings;
  }

  get nodes(): TreeNode[] {
    return this.state.nodes;
  }

  get threads(): Thread[] {
    return this.state.threads;
  }

  get environments(): Environment[] {
    return this.state.environments;
  }

  markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 180);
  }

  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.state.updatedAt = Date.now();
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), "utf8");
    renameSync(tmp, this.statePath);
  }

  snapshot(extra: {
    inbox: Envelope[];
    latestEnvelopes: Envelope[];
    share?: Snapshot["share"];
  }): Snapshot {
    return {
      nodes: this.state.nodes,
      threads: this.state.threads,
      environments: this.state.environments,
      settings: this.state.settings,
      models: this.state.models,
      modelsUpdatedAt: this.state.modelsUpdatedAt,
      workspaceRoot: this.workspaceRoot,
      ompConfig: this.state.ompConfig,
      notifications: this.state.notifications,
      artifacts: this.state.artifacts,
      traces: this.state.traces,
      usage: this.state.usage,
      engine: this.state.engine,
      inbox: extra.inbox,
      latestEnvelopes: extra.latestEnvelopes,
      share: extra.share,
    };
  }

  // ---- nodes ----
  addNode(node: TreeNode): TreeNode {
    this.state.nodes.push(node);
    this.markDirty();
    return node;
  }

  getNode(id: string): TreeNode | undefined {
    return this.state.nodes.find((n) => n.id === id);
  }

  updateNode(id: string, patch: Partial<TreeNode>): TreeNode {
    const node = this.getNode(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    Object.assign(node, patch, { updatedAt: Date.now() });
    this.markDirty();
    return node;
  }

  removeNode(id: string): void {
    this.state.nodes = this.state.nodes.filter((n) => n.id !== id);
    this.state.threads = this.state.threads.filter((t) => t.nodeId !== id);
    this.markDirty();
  }

  // ---- threads ----
  addThread(thread: Thread): Thread {
    this.state.threads.push(thread);
    this.markDirty();
    return thread;
  }

  getThread(id: string): Thread | undefined {
    return this.state.threads.find((t) => t.id === id);
  }

  updateThread(id: string, patch: Partial<Thread>): Thread {
    const thread = this.getThread(id);
    if (!thread) throw new Error(`Thread not found: ${id}`);
    Object.assign(thread, patch, { updatedAt: Date.now() });
    this.markDirty();
    return thread;
  }

  removeThread(id: string): void {
    this.state.threads = this.state.threads.filter((t) => t.id !== id);
    this.markDirty();
  }

  threadsForNode(nodeId: string): Thread[] {
    return this.state.threads.filter((t) => t.nodeId === nodeId);
  }

  // ---- environments ----
  saveEnvironment(env: Environment): Environment {
    const existing = this.state.environments.find((e) => e.id === env.id);
    if (existing) Object.assign(existing, env, { updatedAt: Date.now() });
    else this.state.environments.push(env);
    this.markDirty();
    return env;
  }

  getEnvironment(id: string): Environment | undefined {
    return this.state.environments.find((e) => e.id === id);
  }

  removeEnvironment(id: string): void {
    this.state.environments = this.state.environments.filter((e) => e.id !== id);
    this.markDirty();
  }

  // ---- traces ----
  addTrace(trace: Trace): Trace {
    this.state.traces.push(trace);
    this.markDirty();
    return trace;
  }

  updateTrace(id: string, patch: Partial<Trace>): Trace | undefined {
    const trace = this.state.traces.find((t) => t.id === id);
    if (!trace) return undefined;
    Object.assign(trace, patch, { updatedAt: Date.now() });
    this.markDirty();
    return trace;
  }

  // ---- notifications ----
  addNotification(notification: AppNotification): AppNotification {
    this.state.notifications.unshift(notification);
    this.state.notifications = this.state.notifications.slice(0, 400);
    this.markDirty();
    return notification;
  }

  markNotificationRead(id: string): void {
    const notification = this.state.notifications.find((n) => n.id === id);
    if (notification) notification.read = true;
    this.markDirty();
  }

  clearNotifications(): void {
    this.state.notifications = [];
    this.markDirty();
  }

  // ---- artifacts ----
  addArtifact(artifact: Artifact): Artifact {
    this.state.artifacts.unshift(artifact);
    this.state.artifacts = this.state.artifacts.slice(0, 800);
    this.markDirty();
    return artifact;
  }

  // ---- terminals ----
  addTerminal(run: TerminalRun): TerminalRun {
    this.state.terminals.unshift(run);
    this.state.terminals = this.state.terminals.slice(0, 200);
    this.markDirty();
    return run;
  }

  updateTerminal(id: string, patch: Partial<TerminalRun>): TerminalRun | undefined {
    const run = this.state.terminals.find((r) => r.id === id);
    if (!run) return undefined;
    Object.assign(run, patch);
    this.markDirty();
    return run;
  }

  // ---- caches ----
  setModels(models: ModelInfo[]): void {
    this.state.models = models;
    this.state.modelsUpdatedAt = Date.now();
    this.markDirty();
  }

  setConfig(config: OmpConfigSnapshot): void {
    this.state.ompConfig = config;
    this.markDirty();
  }

  setUsage(usage: UsageSnapshot): void {
    this.state.usage = usage;
    this.markDirty();
  }

  setEngine(engine: EngineStatus): void {
    this.state.engine = { ...engine, checkedAt: Date.now() };
    this.markDirty();
  }

  setSettings(patch: Partial<AppSettings>): AppSettings {
    this.state.settings = deepMerge(this.state.settings, patch);
    this.markDirty();
    return this.state.settings;
  }

  // ---- envelopes ----
  appendEnvelope(envelope: Envelope): Envelope {
    const existingIndex = this.envelopeIndex.get(envelope.id);
    if (existingIndex !== undefined) {
      this.envelopes[existingIndex] = envelope;
    } else {
      this.envelopeIndex.set(envelope.id, this.envelopes.length);
      this.envelopes.push(envelope);
    }
    appendFileSync(this.envelopesPath, `${JSON.stringify(envelope)}\n`, "utf8");
    this.compactEnvelopesIfNeeded();
    return envelope;
  }

  private compactEnvelopesIfNeeded(): void {
    if (this.envelopes.length > 12000) {
      this.envelopes = this.envelopes.slice(-6000);
      this.reindexEnvelopes();
      const tmp = `${this.envelopesPath}.tmp`;
      writeFileSync(tmp, this.envelopes.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
      renameSync(tmp, this.envelopesPath);
    }
  }

  getEnvelope(id: string): Envelope | undefined {
    return this.envelopes.find((e) => e.id === id);
  }

  listEnvelopes(filter: { threadId?: string; nodeId?: string; traceId?: string; limit?: number } = {}): Envelope[] {
    let list = this.envelopes;
    if (filter.threadId) {
      const id = filter.threadId;
      list = list.filter((e) => e.fromThreadId === id || e.toThreadId === id);
    }
    if (filter.nodeId) {
      const id = filter.nodeId;
      list = list.filter((e) => e.fromNodeId === id || e.toNodeId === id);
    }
    if (filter.traceId) list = list.filter((e) => e.traceId === filter.traceId);
    return list.slice(-(filter.limit ?? 500));
  }

  inboxFor(threadId: string): Envelope[] {
    return this.envelopes.filter(
      (e) => e.toThreadId === threadId && e.status !== "read" && e.status !== "answered" && e.status !== "cancelled",
    );
  }

  latestEnvelopes(limit = 120): Envelope[] {
    return this.envelopes.slice(-limit);
  }

  // ---- chats ----
  private transcriptPath(threadId: string): string {
    return join(this.transcriptsDir, `${threadId}.jsonl`);
  }

  appendChat(message: ChatMessage): ChatMessage {
    const list = this.getChat(message.threadId);
    const existing = list.findIndex((m) => m.id === message.id);
    if (existing >= 0) list[existing] = message;
    else list.push(message);
    if (list.length > 1200) list.splice(0, list.length - 1200);
    appendFileSync(this.transcriptPath(message.threadId), `${JSON.stringify(message)}\n`, "utf8");
    return message;
  }

  getChat(threadId: string): ChatMessage[] {
    const cached = this.chats.get(threadId);
    if (cached) return cached;
    const path = this.transcriptPath(threadId);
    const byId = new Map<string, ChatMessage>();
    if (existsSync(path)) {
      try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line) as ChatMessage;
            byId.set(message.id, message);
          } catch {
            /* skip */
          }
        }
      } catch {
        /* ignore */
      }
    }
    const list = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
    this.chats.set(threadId, list);
    return list;
  }

  replaceChat(threadId: string, messages: ChatMessage[]): void {
    this.chats.set(threadId, messages);
    const path = this.transcriptPath(threadId);
    writeFileSync(path, messages.map((m) => JSON.stringify(m)).join("\n") + (messages.length ? "\n" : ""), "utf8");
  }

  // ---- memory ----
  private memoryPath(nodeId: string): string {
    return join(this.memoryDir, `${nodeId}.json`);
  }

  listMemory(nodeId: string): MemoryEntry[] {
    const path = this.memoryPath(nodeId);
    if (!existsSync(path)) return [];
    try {
      return JSON.parse(readFileSync(path, "utf8")) as MemoryEntry[];
    } catch {
      return [];
    }
  }

  private saveMemoryEntries(nodeId: string, entries: MemoryEntry[]): void {
    const path = this.memoryPath(nodeId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    renameSync(tmp, path);
  }

  addMemory(entry: MemoryEntry): MemoryEntry {
    const entries = this.listMemory(entry.nodeId);
    const duplicate = entries.find((e) => e.text.trim().toLowerCase() === entry.text.trim().toLowerCase());
    if (duplicate) {
      duplicate.updatedAt = Date.now();
      duplicate.importance = Math.max(duplicate.importance, entry.importance);
      this.saveMemoryEntries(entry.nodeId, entries);
      return duplicate;
    }
    entries.push(entry);
    const max = this.settings.memory.maxEntries;
    while (entries.length > max) {
      entries.sort((a, b) => a.importance - b.importance || a.updatedAt - b.updatedAt);
      entries.shift();
    }
    this.saveMemoryEntries(entry.nodeId, entries);
    return entry;
  }

  updateMemory(id: string, patch: Partial<MemoryEntry>): MemoryEntry {
    const nodeId = patch.nodeId ?? this.findMemoryNode(id);
    if (!nodeId) throw new Error(`Memory not found: ${id}`);
    const entries = this.listMemory(nodeId);
    const entry = entries.find((e) => e.id === id);
    if (!entry) throw new Error(`Memory not found: ${id}`);
    Object.assign(entry, patch, { updatedAt: Date.now() });
    this.saveMemoryEntries(nodeId, entries);
    return entry;
  }

  deleteMemory(id: string): void {
    const nodeId = this.findMemoryNode(id);
    if (!nodeId) return;
    const entries = this.listMemory(nodeId).filter((e) => e.id !== id);
    this.saveMemoryEntries(nodeId, entries);
  }

  private findMemoryNode(id: string): string | undefined {
    for (const node of this.state.nodes) {
      if (this.listMemory(node.id).some((e) => e.id === id)) return node.id;
    }
    return undefined;
  }

  memoryFileSize(nodeId: string): number {
    const path = this.memoryPath(nodeId);
    return existsSync(path) ? statSync(path).size : 0;
  }

  resolvePath(...parts: string[]): string {
    return resolve(this.baseDir, ...parts);
  }
}

function deepMerge<T>(base: T, patch: Partial<T>): T {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return (patch ?? base) as T;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [key, value] of Object.entries(patch as any)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object") {
      out[key] = deepMerge(out[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}
