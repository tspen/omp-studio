export type NodeType = "root" | "group" | "project";
export type ThreadKind = "orchestrator" | "worker" | "native";
export type ThreadStatus =
  | "idle"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "error"
  | "cancelled"
  | "parked";

export type EnvelopeKind =
  | "task"
  | "context"
  | "progress"
  | "question"
  | "answer"
  | "result"
  | "decision"
  | "escalation"
  | "digest"
  | "cancel"
  | "error"
  | "note"
  | "memory";

export type EnvelopeDirection = "down" | "up" | "lateral";
export type EnvelopeStatus =
  | "queued"
  | "delivered"
  | "read"
  | "answered"
  | "expired"
  | "cancelled"
  | "error";

export type Priority = "low" | "normal" | "high" | "urgent";
export type GitMode = "auto" | "shared" | "branch" | "worktree";
export type ApprovalMode = "always-ask" | "write" | "yolo";
export type ToolApproval = "allow" | "prompt" | "deny";

export interface ModelRef {
  provider: string;
  id: string;
  selector: string;
  name?: string;
}

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AAScore {
  intelligence?: number;
  coding?: number;
  agentic?: number;
  price?: number;
  speed?: number;
  value?: number;
  source: "artificial-analysis" | "baseline" | "heuristic";
  updatedAt: string;
  version?: number;
}

export interface ModelInfo {
  provider: string;
  id: string;
  selector: string;
  name: string;
  contextWindow: number;
  maxTokens: number | null;
  reasoning: boolean;
  thinking: string[] | null;
  input: string[];
  cost: ModelCost;
  available: boolean;
  billing?: "subscription" | "metered" | "local" | "unknown";
  included?: boolean;
  aa?: AAScore;
  quality: number;
  recommended?: "root" | "group" | "project" | "worker" | "naming" | "memory";
}

export interface ProviderInfo {
  id: string;
  name: string;
  login: string;
  authUrl?: string;
  instructions?: string;
  prompt?: string;
  envVar?: string;
  recommended: boolean;
  connected: boolean;
  modelCount: number;
  billing: "subscription" | "metered" | "local" | "unknown";
}

export interface TreeNode {
  id: string;
  type: NodeType;
  name: string;
  parentId: string | null;
  path: string;
  repoPath?: string;
  description?: string;
  environmentId?: string;
  orchestratorThreadId: string;
  model: string;
  effort: string;
  gitMode: GitMode;
  approvalMode: ApprovalMode;
  toolNames?: string[];
  collapsed: boolean;
  muted: boolean;
  color?: string;
  icon?: string;
  autoName: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface TodoTask {
  content: string;
  status: "pending" | "in_progress" | "completed" | "abandoned";
}

export interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

export interface GitFileStatus {
  path: string;
  index: string;
  worktree: string;
  staged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  isRepo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  clean: boolean;
  lastCommit?: { hash: string; subject: string; author: string; date: string };
  error?: string;
  updatedAt: number;
}

export interface ThreadGitInfo extends GitStatus {
  worktreePath?: string;
  baseBranch?: string;
  isolation: GitMode;
}

export interface Thread {
  id: string;
  nodeId: string;
  parentThreadId: string | null;
  kind: ThreadKind;
  title: string;
  titleAuto: boolean;
  status: ThreadStatus;
  statusMessage?: string;
  interrupted?: boolean;
  interruptedAt?: number;
  model: ModelRef;
  modelManual?: boolean;
  effort: string;
  environmentId?: string;
  sessionDir: string;
  sessionFile?: string;
  ompSubagentId?: string;
  ompSubagentParentToolCallId?: string;
  branch?: string;
  baseBranch?: string;
  worktreePath?: string;
  agentName?: string;
  traceId?: string;
  lastMessage?: string;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
  unread: number;
  pinned: boolean;
  archived: boolean;
  muted: boolean;
  cost: number;
  tokens: number;
  contextTokens?: number;
  contextWindow?: number;
  todoPhases: TodoPhase[];
  git?: ThreadGitInfo;
  usageLimit?: {
    stage: string;
    resetsAt?: number;
    allowanceLeftPercent?: number;
  };
  error?: string;
  pendingApproval?: string;
  source: "app" | "native";
  queue?: { steering: string[]; followUp: string[] };
}

export interface Envelope {
  id: string;
  traceId: string;
  fromThreadId: string;
  toThreadId: string;
  fromNodeId?: string;
  toNodeId?: string;
  direction: EnvelopeDirection;
  kind: EnvelopeKind;
  priority: Priority;
  subject: string;
  body: string;
  payload?: Record<string, unknown>;
  status: EnvelopeStatus;
  requiresResponse: boolean;
  parentEnvelopeId?: string;
  rootVisible: boolean;
  createdAt: number;
  deliveredAt?: number;
  readAt?: number;
  answeredAt?: number;
  summary?: string;
  error?: string;
}

export interface Trace {
  id: string;
  title: string;
  prompt: string;
  originNodeId: string;
  originThreadId: string;
  status: "active" | "waiting" | "done" | "error" | "cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface EnvVar {
  key: string;
  value: string;
  secret: boolean;
  hasSecret?: boolean;
}

export interface Environment {
  id: string;
  name: string;
  cwd?: string;
  envVars: EnvVar[];
  setupCommands: string[];
  teardownCommands: string[];
  shell?: string;
  inheritEnv: boolean;
  gitMode: GitMode;
  approvalMode: ApprovalMode;
  toolNames?: string[];
  modelOverrides?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface NotificationSettings {
  enabled: boolean;
  toast: boolean;
  sound: boolean;
  onComplete: boolean;
  onQuestion: boolean;
  onError: boolean;
  onDigest: boolean;
  mutedNodeIds: string[];
}

export interface ModelSettings {
  root: string;
  group: string;
  project: string;
  worker: string;
  naming: string;
  memory: string;
  rootEffort: string;
  groupEffort: string;
  projectEffort: string;
  workerEffort: string;
  preferredProvider?: string;
  autoUpdateAA: boolean;
  aaKeySet: boolean;
  lastAAUpdate?: string;
  aaSource?: "artificial-analysis" | "baseline" | "heuristic";
}

export interface MemorySettings {
  autoCapture: boolean;
  maxEntries: number;
  injectTokenLimit: number;
}

export interface GitSettings {
  defaultMode: GitMode;
  autoCommit: boolean;
  autoMerge: boolean;
  branchPrefix: string;
}

export interface UsageSettings {
  budgetUsd?: number;
  autoContinueOnReset: boolean;
}

export interface AppSettings {
  theme: "light" | "dark" | "system";
  onboardingCompleted: boolean;
  enginePath?: string;
  workspaceRoot: string;
  defaultApprovalMode: ApprovalMode;
  approvalMigrationDone: boolean;
  autoName: boolean;
  autoReport: boolean;
  autoWakeParent: boolean;
  digestIntervalMin: number;
  statusCheckIntervalMin: number;
  maxConcurrentThreads: number;
  contextCompaction: boolean;
  advisor: boolean;
  notifications: NotificationSettings;
  models: ModelSettings;
  memory: MemorySettings;
  git: GitSettings;
  usage: UsageSettings;
  share: { enabled: boolean; port: number };
  ui: { sidebarWidth: number; rightWidth: number; showThinking: boolean; dense: boolean };
}

export interface MemoryEntry {
  id: string;
  nodeId: string;
  text: string;
  tags: string[];
  importance: number;
  sourceThreadId?: string;
  source: "orchestrator" | "user" | "auto" | "digest";
  createdAt: number;
  updatedAt: number;
}

export interface OmpConfigEntry {
  key: string;
  value: unknown;
  type: "boolean" | "number" | "string" | "enum" | "array" | "record" | "unknown";
  description: string;
  group: string;
}

export interface OmpConfigSnapshot {
  path: string;
  entries: OmpConfigEntry[];
  fetchedAt: number;
  error?: string;
}

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  enabled: boolean;
  approval: ToolApproval;
  configKey?: string;
  group: string;
  source: "omp" | "host";
}

export interface SkillInfo {
  name: string;
  path: string;
  description?: string;
  enabled: boolean;
  source: string;
}

export interface McpServerInfo {
  name: string;
  command?: string;
  url?: string;
  enabled: boolean;
  source: string;
}

export interface Artifact {
  id: string;
  nodeId: string;
  threadId?: string;
  kind: "file" | "diff" | "report" | "export" | "image" | "log";
  name: string;
  path?: string;
  content?: string;
  mime?: string;
  size?: number;
  createdAt: number;
  meta?: Record<string, unknown>;
}

export interface AppNotification {
  id: string;
  kind:
    | "thread_completed"
    | "input_required"
    | "error"
    | "usage_limit"
    | "merge_conflict"
    | "digest"
    | "engine"
    | "memory"
    | "system";
  title: string;
  body: string;
  nodeId?: string;
  threadId?: string;
  read: boolean;
  createdAt: number;
}

export interface TerminalRun {
  id: string;
  nodeId: string;
  threadId?: string;
  cwd: string;
  command: string;
  status: "running" | "done" | "error" | "cancelled";
  output: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
}

export interface ProviderUsage {
  provider: string;
  label?: string;
  used?: number;
  limit?: number;
  remaining?: number;
  unit?: string;
  resetsAt?: number;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface UsageSnapshot {
  generatedAt: number;
  providers: ProviderUsage[];
  totalCost: number;
  meteredCost: number;
  referenceCost: number;
  totalTokens: number;
  perNode: Record<string, { cost: number; referenceCost: number; tokens: number; threads: number }>;
}

export interface EngineStatus {
  found: boolean;
  path?: string;
  version?: string;
  source?: "bundled" | "installed" | "custom" | "downloaded";
  downloading: boolean;
  progress?: number;
  error?: string;
  checkedAt: number;
}

export interface ApprovalRequest {
  id: string;
  threadId: string;
  kind: "tool" | "ask" | "input" | "select" | "confirm" | "editor";
  title: string;
  message: string;
  options?: Array<{ label: string; value: string; description?: string }>;
  toolName?: string;
  args?: unknown;
  raw?: unknown;
  createdAt: number;
}

export interface ShareInfo {
  threadId: string;
  url: string;
  token: string;
  createdAt: number;
  active: boolean;
}

export interface ChatUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost?: number;
}

export type ChatBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string; signature?: string }
  | {
      type: "tool";
      id: string;
      name: string;
      args: unknown;
      status: "running" | "done" | "error";
      result?: string;
      intent?: string;
      startedAt?: number;
      endedAt?: number;
    }
  | { type: "image"; mimeType: string; data?: string; path?: string };

export interface ChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool" | "system";
  blocks: ChatBlock[];
  timestamp: number;
  model?: string;
  usage?: ChatUsage;
  stopReason?: string;
  synthetic?: boolean;
  envelopeId?: string;
  direction?: EnvelopeDirection;
}

export interface ThreadEvent {
  id: string;
  threadId: string;
  type: string;
  timestamp: number;
  payload?: unknown;
}

export interface ThreadEntry {
  id: string;
  type: string;
  role?: string;
  text: string;
  timestamp: number;
  label?: string;
  raw?: unknown;
}

export interface Snapshot {
  nodes: TreeNode[];
  threads: Thread[];
  environments: Environment[];
  settings: AppSettings;
  models: ModelInfo[];
  modelsUpdatedAt: number;
  workspaceRoot: string;
  ompConfig: OmpConfigSnapshot;
  notifications: AppNotification[];
  artifacts: Artifact[];
  traces: Trace[];
  usage: UsageSnapshot;
  engine: EngineStatus;
  inbox: Envelope[];
  latestEnvelopes: Envelope[];
  share?: ShareInfo;
}

export type AppEvent =
  | { type: "snapshot"; payload: Snapshot }
  | { type: "node:updated"; payload: TreeNode }
  | { type: "node:removed"; payload: { id: string } }
  | { type: "thread:updated"; payload: Thread }
  | { type: "thread:removed"; payload: { id: string } }
  | { type: "thread:message"; payload: ChatMessage }
  | { type: "thread:event"; payload: ThreadEvent }
  | { type: "thread:status"; payload: { threadId: string; status: ThreadStatus; message?: string } }
  | { type: "envelope:new"; payload: Envelope }
  | { type: "envelope:updated"; payload: Envelope }
  | { type: "notification:new"; payload: AppNotification }
  | { type: "approval:request"; payload: ApprovalRequest }
  | { type: "approval:resolved"; payload: { id: string } }
  | { type: "terminal:output"; payload: { runId: string; chunk: string; done?: boolean; exitCode?: number } }
  | { type: "terminal:updated"; payload: TerminalRun }
  | { type: "engine:progress"; payload: EngineStatus }
  | { type: "models:updated"; payload: { models: ModelInfo[]; updatedAt: number } }
  | { type: "config:updated"; payload: OmpConfigSnapshot }
  | { type: "usage:updated"; payload: UsageSnapshot }
  | { type: "share:updated"; payload: ShareInfo | null }
  | { type: "focus"; payload: { threadId?: string; nodeId?: string } }
  | { type: "toast"; payload: { kind: "info" | "success" | "error" | "warning"; title: string; body?: string } };

export interface NewNodeRequest {
  parentId: string;
  type: "group" | "project";
  name: string;
  path?: string;
  gitInit?: boolean;
  model?: string;
  effort?: string;
  environmentId?: string;
  approvalMode?: ApprovalMode;
  brief?: string;
}

export interface NewThreadRequest {
  nodeId: string;
  parentThreadId?: string;
  title?: string;
  brief: string;
  model?: string;
  effort?: string;
  environmentId?: string;
  isolation?: GitMode;
  wait?: boolean;
}

export interface SendMessageRequest {
  threadId: string;
  text: string;
  mode?: "prompt" | "steer" | "followUp";
  traceId?: string;
}

export interface ManualEnvelopeRequest {
  fromThreadId: string;
  toThreadId: string;
  kind: EnvelopeKind;
  subject: string;
  body: string;
  priority?: Priority;
  requiresResponse?: boolean;
  traceId?: string;
}

export interface MemoryQuery {
  nodeId: string;
  query?: string;
  limit?: number;
}

export interface SettingsPatch {
  settings?: Partial<AppSettings>;
  aaApiKey?: string;
  clearAAKey?: boolean;
}

export interface OnboardingPayload {
  models: {
    root: string;
    group?: string;
    project?: string;
    worker: string;
    naming: string;
    memory?: string;
  };
  efforts: {
    root: string;
    group?: string;
    project?: string;
    worker: string;
  };
  notificationsEnabled: boolean;
  autoName: boolean;
  firstProject?: {
    name?: string;
    path?: string;
    brief?: string;
    gitInit?: boolean;
  };
}

export interface OmpStudioApi {
  getSnapshot(): Promise<Snapshot>;
  getThreadMessages(threadId: string): Promise<ChatMessage[]>;
  getEnvelopes(filter?: { threadId?: string; nodeId?: string; traceId?: string; limit?: number }): Promise<Envelope[]>;

  createNode(req: NewNodeRequest): Promise<TreeNode>;
  updateNode(id: string, patch: Partial<TreeNode>): Promise<TreeNode>;
  setNodeApproval(id: string, mode: ApprovalMode): Promise<TreeNode>;
  deleteNode(id: string): Promise<void>;
  createThread(req: NewThreadRequest): Promise<Thread>;
  updateThread(id: string, patch: Partial<Thread>): Promise<Thread>;
  deleteThread(id: string): Promise<void>;
  resolveThread(id: string, note?: string): Promise<Thread>;
  send(req: SendMessageRequest): Promise<void>;
  stopThread(id: string): Promise<void>;
  restartThread(id: string): Promise<void>;
  continueThread(id: string): Promise<void>;
  compactThread(id: string): Promise<void>;
  setThreadModel(id: string, selector: string): Promise<Thread>;
  setThreadEffort(id: string, effort: string): Promise<Thread>;
  focusThread(id: string | null): Promise<void>;
  forkThread(id: string, entryId?: string): Promise<Thread>;
  branchThread(id: string, entryId: string): Promise<Thread>;
  navigateThread(id: string, entryId: string, summarize?: boolean): Promise<void>;
  getThreadEntries(id: string): Promise<ThreadEntry[]>;
  goalThread(id: string, op: "get" | "create" | "resume" | "pause" | "drop", objective?: string, tokenBudget?: number): Promise<any>;
  exportThread(id: string): Promise<{ path: string }>;

  sendEnvelope(req: ManualEnvelopeRequest): Promise<Envelope>;
  answerEnvelope(id: string, body: string): Promise<void>;
  markEnvelopeRead(id: string): Promise<void>;

  listMemory(nodeId: string, query?: string): Promise<MemoryEntry[]>;
  addMemory(nodeId: string, text: string, tags?: string[], importance?: number): Promise<MemoryEntry>;
  updateMemory(id: string, patch: Partial<MemoryEntry>): Promise<MemoryEntry>;
  deleteMemory(id: string): Promise<void>;
  consolidateMemory(nodeId: string): Promise<MemoryEntry[]>;

  saveEnvironment(env: Environment): Promise<Environment>;
  deleteEnvironment(id: string): Promise<void>;
  testEnvironment(id: string): Promise<{ ok: boolean; output: string }>;

  getGitStatus(nodeId: string, threadId?: string): Promise<GitStatus>;
  getGitDiff(nodeId: string, threadId?: string, path?: string): Promise<string>;
  readFile(path: string): Promise<{ content: string; size: number; binary: boolean }>;
  gitCommit(nodeId: string, threadId: string | undefined, message: string, paths?: string[]): Promise<{ ok: boolean; output: string }>;
  gitMerge(nodeId: string, threadId: string): Promise<{ ok: boolean; output: string; conflicts: string[] }>;
  gitCreatePr(nodeId: string, threadId: string, title: string, body: string): Promise<{ ok: boolean; output: string; url?: string }>;
  gitDiscard(nodeId: string, threadId: string): Promise<{ ok: boolean; output: string }>;

  updateSettings(patch: SettingsPatch): Promise<AppSettings>;
  completeOnboarding(payload: OnboardingPayload): Promise<{ snapshot: Snapshot; node?: TreeNode }>;
  getOmpConfig(): Promise<OmpConfigSnapshot>;
  setOmpConfig(key: string, value: unknown): Promise<OmpConfigSnapshot>;
  resetOmpConfig(key: string): Promise<OmpConfigSnapshot>;

  listTools(): Promise<ToolInfo[]>;
  setTool(name: string, enabled: boolean, approval?: ToolApproval): Promise<ToolInfo[]>;
  listSkills(): Promise<SkillInfo[]>;
  listMcpServers(): Promise<McpServerInfo[]>;

  listProviders(): Promise<ProviderInfo[]>;
  connectProvider(id: string, apiKey?: string): Promise<{ ok: boolean; output: string; providers: ProviderInfo[] }>;
  refreshModels(): Promise<ModelInfo[]>;
  getModelDefaults(): Promise<Record<string, string>>;
  setModelDefault(role: string, selector: string): Promise<AppSettings>;
  resetModelDefaults(): Promise<AppSettings>;
  refreshAA(): Promise<{ ok: boolean; source: string; count: number; error?: string }>;
  refreshUsage(): Promise<UsageSnapshot>;

  runTerminal(req: { nodeId: string; threadId?: string; command: string }): Promise<TerminalRun>;
  killTerminal(runId: string): Promise<void>;
  listTerminals(): Promise<TerminalRun[]>;

  listArtifacts(filter?: { nodeId?: string; threadId?: string }): Promise<Artifact[]>;
  readArtifact(id: string): Promise<Artifact>;

  listNotifications(): Promise<AppNotification[]>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  clearNotifications(): Promise<void>;

  respondApproval(id: string, response: unknown): Promise<void>;

  shareThread(threadId: string): Promise<ShareInfo>;
  stopShare(): Promise<void>;

  pickDirectory(): Promise<string | null>;
  setWindowTheme(theme: "light" | "dark"): Promise<void>;
  openExternal(url: string): Promise<void>;
  openPath(path: string): Promise<void>;
  downloadEngine(): Promise<EngineStatus>;
  restartApp(): Promise<void>;

  onEvent(cb: (event: AppEvent) => void): () => void;
}
