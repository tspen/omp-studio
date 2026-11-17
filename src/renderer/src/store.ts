import { create } from "zustand";
import type {
  AppEvent,
  AppNotification,
  BrowserConsoleEntry,
  BrowserNetworkEntry,
  ApprovalRequest,
  Artifact,
  ChatMessage,
  EngineStatus,
  Envelope,
  Environment,
  MemoryEntry,
  ModelInfo,
  OmpConfigSnapshot,
  PtySession,
  ShareInfo,
  Site,
  Snapshot,
  TerminalRun,
  Thread,
  TreeNode,
} from "../../shared/types";

export type RightTab = "threads" | "bus" | "git" | "ci";
export type SettingsTab = "general" | "models" | "tools" | "memory" | "environments" | "git" | "notifications" | "engine" | "advanced" | "usage" | "connectors" | "automations" | "sandbox";
export type Overlay = "none" | "inbox" | "artifacts" | "terminal" | "search" | "memory" | "settings" | "new-node" | "new-thread" | "share" | "preview" | "history" | "goal" | "sites" | "context" | "devices";

interface Toast {
  id: string;
  kind: "info" | "success" | "error" | "warning";
  title: string;
  body?: string;
}

interface PreviewState {
  title: string;
  kind: "file" | "diff" | "artifact" | "text" | "image";
  content: string;
  path?: string;
  review?: { nodeId: string; threadId?: string; path: string };
}

interface AppState {
  snapshot: Snapshot | null;
  models: ModelInfo[];
  messages: Record<string, ChatMessage[]>;
  envelopes: Envelope[];
  inbox: Envelope[];
  notifications: AppNotification[];
  approvals: ApprovalRequest[];
  toasts: Toast[];
  terminalRuns: TerminalRun[];
  ptySessions: PtySession[];
  artifacts: Artifact[];
  memory: MemoryEntry[];
  ompConfig: OmpConfigSnapshot | null;
  engine: EngineStatus | null;
  share: ShareInfo | null;
  sites: Site[];
  selectedNodeId: string | null;
  selectedThreadId: string | null;
  browserOpen: boolean;
  browserMinimized: boolean;
  browserUrl: string;
  browserConsole: BrowserConsoleEntry[];
  browserNetwork: BrowserNetworkEntry[];
  paneWidths: { sidebar: number; right: number; browser: number };
  composerInsert: { token: number; text: string } | null;
  rightTab: RightTab;
  railOpen: boolean;
  overlay: Overlay;
  settingsTab: SettingsTab;
  preview: PreviewState | null;
  sending: boolean;
  loadingMessages: boolean;
  initialized: boolean;
  init(): Promise<void>;
  refresh(): Promise<void>;
  handleEvent(event: AppEvent): void;
  selectNode(nodeId: string): Promise<void>;
  selectThread(threadId: string, nodeId?: string): Promise<void>;
  loadMessages(threadId: string): Promise<void>;
  setRightTab(tab: RightTab): void;
  openBrowser(url?: string): void;
  closeBrowser(): void;
  toggleBrowserMinimized(): void;
  loadBrowserDevtools(): Promise<void>;
  clearBrowserConsole(): void;
  clearBrowserNetwork(): void;
  insertComposer(text: string): void;
  clearComposerInsert(): void;
  toggleRail(): void;
  setPaneWidth(pane: "sidebar" | "right" | "browser", width: number): void;
  setOverlay(overlay: Overlay): void;
  setSettingsTab(tab: SettingsTab): void;
  openPreview(preview: PreviewState): void;
  send(text: string, mode?: "prompt" | "steer" | "followUp"): Promise<void>;
  continueThread(threadId: string): Promise<void>;
  resolveThread(threadId: string): Promise<void>;
  stop(): Promise<void>;
  createNode(input: any): Promise<void>;
  createThread(input: any): Promise<void>;
  updateSettings(patch: any): Promise<void>;
  completeOnboarding(payload: any): Promise<void>;
  refreshModels(): Promise<void>;
  refreshAA(): Promise<void>;
  refreshUsage(): Promise<void>;
  refreshConfig(): Promise<void>;
  setTool(name: string, enabled: boolean, approval?: "allow" | "prompt" | "deny"): Promise<void>;
  setModelDefault(role: string, selector: string): Promise<void>;
  resetModelDefaults(): Promise<void>;
  loadMemory(nodeId: string): Promise<void>;
  addMemory(text: string, tags?: string[]): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  loadArtifacts(filter?: { nodeId?: string; threadId?: string }): Promise<void>;
  loadTerminals(): Promise<void>;
  loadPtySessions(): Promise<void>;
  startPty(input?: { nodeId?: string; threadId?: string; title?: string }): Promise<PtySession | null>;
  killPty(id: string): Promise<void>;
  loadSites(): Promise<void>;
  createSite(input: { name: string; nodeId: string; path: string }): Promise<void>;
  publishSite(id: string): Promise<void>;
  deleteSite(id: string): Promise<void>;
  runTerminal(command: string): Promise<void>;
  respondApproval(id: string, response: unknown): Promise<void>;
  answerEnvelope(id: string, body: string): Promise<void>;
  markEnvelopeRead(id: string): Promise<void>;
  shareThread(): Promise<void>;
  stopShare(): Promise<void>;
  markNotificationRead(id: string): Promise<void>;
  markAllNotificationsRead(): Promise<void>;
  clearNotifications(): Promise<void>;
  pushToast(toast: Omit<Toast, "id">): void;
  dismissToast(id: string): void;
  selectRoot(): Promise<void>;
}

const api = () => window.omp;
let initStarted = false;

export const useApp = create<AppState>((set, get) => ({
  snapshot: null,
  models: [],
  messages: {},
  envelopes: [],
  inbox: [],
  notifications: [],
  approvals: [],
  toasts: [],
  terminalRuns: [],
  ptySessions: [],
  artifacts: [],
  memory: [],
  ompConfig: null,
  engine: null,
  share: null,
  sites: [],
  selectedNodeId: null,
  selectedThreadId: null,
  browserOpen: false,
  browserMinimized: false,
  browserUrl: "https://example.com",
  browserConsole: [],
  browserNetwork: [],
  paneWidths: { sidebar: 280, right: 320, browser: 440 },
  composerInsert: null,
  rightTab: "threads",
  railOpen: true,
  overlay: "none",
  settingsTab: "general",
  preview: null,
  sending: false,
  loadingMessages: false,
  initialized: false,

  async init() {
    if (get().initialized || initStarted) return;
    initStarted = true;
    try {
      const snapshot = await api().getSnapshot();
      const root = snapshot.nodes.find((node) => node.type === "root") ?? snapshot.nodes[0];
      const threadId = root?.orchestratorThreadId ?? snapshot.threads[0]?.id ?? null;
      set({
        snapshot,
        models: snapshot.models,
        notifications: snapshot.notifications,
        envelopes: snapshot.latestEnvelopes,
        inbox: snapshot.inbox,
        artifacts: snapshot.artifacts,
        ompConfig: snapshot.ompConfig,
        engine: snapshot.engine,
        share: snapshot.share ?? null,
        sites: snapshot.sites ?? [],
        paneWidths: {
          sidebar: Number(snapshot.settings.ui?.sidebarWidth) || 280,
          right: Number(snapshot.settings.ui?.rightWidth) || 320,
          browser: get().paneWidths.browser,
        },
        selectedNodeId: root?.id ?? null,
        selectedThreadId: threadId,
        initialized: true,
      });
      if (threadId) await get().loadMessages(threadId);
      api().onEvent((event) => get().handleEvent(event));
    } catch (error) {
      initStarted = false;
      get().pushToast({ kind: "error", title: "Could not load OMP Studio", body: String(error) });
    }
  },

  async refresh() {
    const snapshot = await api().getSnapshot();
    set({
      snapshot,
      models: snapshot.models,
      notifications: snapshot.notifications,
      envelopes: snapshot.latestEnvelopes,
      inbox: snapshot.inbox,
      artifacts: snapshot.artifacts,
      ompConfig: snapshot.ompConfig,
      engine: snapshot.engine,
      share: snapshot.share ?? null,
      sites: snapshot.sites ?? [],
    });
  },

  handleEvent(event) {
    const state = get();
    switch (event.type) {
      case "snapshot": {
        const snapshot = event.payload;
        const keepNode = snapshot.nodes.some((node) => node.id === state.selectedNodeId);
        const keepThread = snapshot.threads.some((thread) => thread.id === state.selectedThreadId);
        const root = snapshot.nodes.find((node) => node.type === "root") ?? snapshot.nodes[0];
        set({
          snapshot,
          models: snapshot.models,
          notifications: snapshot.notifications,
          envelopes: snapshot.latestEnvelopes,
          inbox: snapshot.inbox,
          artifacts: snapshot.artifacts,
          ompConfig: snapshot.ompConfig,
          engine: snapshot.engine,
          share: snapshot.share ?? null,
          selectedNodeId: keepNode ? state.selectedNodeId : root?.id ?? null,
          selectedThreadId: keepThread ? state.selectedThreadId : root?.orchestratorThreadId ?? null,
        });
        break;
      }
      case "node:updated": {
        if (!state.snapshot) return;
        const nodes = state.snapshot.nodes.some((node) => node.id === event.payload.id)
          ? state.snapshot.nodes.map((node) => (node.id === event.payload.id ? event.payload : node))
          : [...state.snapshot.nodes, event.payload];
        set({ snapshot: { ...state.snapshot, nodes } });
        break;
      }
      case "node:removed": {
        if (!state.snapshot) return;
        set({ snapshot: { ...state.snapshot, nodes: state.snapshot.nodes.filter((node) => node.id !== event.payload.id) } });
        break;
      }
      case "thread:updated": {
        if (!state.snapshot) return;
        const exists = state.snapshot.threads.some((thread) => thread.id === event.payload.id);
        const threads = exists
          ? state.snapshot.threads.map((thread) => (thread.id === event.payload.id ? event.payload : thread))
          : [...state.snapshot.threads, event.payload];
        set({ snapshot: { ...state.snapshot, threads } });
        break;
      }
      case "thread:removed": {
        if (!state.snapshot) return;
        set({ snapshot: { ...state.snapshot, threads: state.snapshot.threads.filter((thread) => thread.id !== event.payload.id) } });
        break;
      }
      case "thread:message": {
        if (event.payload.threadId !== state.selectedThreadId) return;
        const list = state.messages[event.payload.threadId] ?? [];
        const index = list.findIndex((message) => message.id === event.payload.id);
        const next = index >= 0 ? list.map((message) => (message.id === event.payload.id ? event.payload : message)) : [...list, event.payload];
        next.sort((a, b) => a.timestamp - b.timestamp);
        set({ messages: { ...state.messages, [event.payload.threadId]: next } });
        break;
      }
      case "thread:event":
        break;
      case "thread:status": {
        if (!state.snapshot) return;
        const threads = state.snapshot.threads.map((thread) =>
          thread.id === event.payload.threadId
            ? { ...thread, status: event.payload.status, statusMessage: event.payload.message ?? thread.statusMessage }
            : thread,
        );
        set({ snapshot: { ...state.snapshot, threads } });
        break;
      }
      case "envelope:new":
      case "envelope:updated": {
        const envelope = event.payload;
        const envelopes = state.envelopes.some((item) => item.id === envelope.id)
          ? state.envelopes.map((item) => (item.id === envelope.id ? envelope : item))
          : [...state.envelopes, envelope];
        const inbox = envelope.requiresResponse && !["answered", "cancelled", "expired"].includes(envelope.status)
          ? [...state.inbox.filter((item) => item.id !== envelope.id), envelope]
          : state.inbox.filter((item) => item.id !== envelope.id);
        set({ envelopes: envelopes.slice(-400), inbox });
        break;
      }
      case "notification:new":
        set({ notifications: [event.payload, ...state.notifications].slice(0, 200) });
        break;
      case "approval:request":
        set({ approvals: [...state.approvals.filter((item) => item.id !== event.payload.id), event.payload] });
        break;
      case "approval:resolved":
        set({ approvals: state.approvals.filter((item) => item.id !== event.payload.id) });
        break;
      case "engine:progress":
        set({ engine: event.payload });
        break;
      case "models:updated":
        set({ models: event.payload.models });
        break;
      case "config:updated":
        set({ ompConfig: event.payload });
        break;
      case "terminal:updated": {
        const exists = state.terminalRuns.some((run) => run.id === event.payload.id);
        set({
          terminalRuns: exists
            ? state.terminalRuns.map((run) => (run.id === event.payload.id ? event.payload : run))
            : [event.payload, ...state.terminalRuns],
        });
        break;
      }
      case "terminal:output": {
        const runs = state.terminalRuns.map((run) =>
          run.id === event.payload.runId ? { ...run, output: `${run.output}${event.payload.chunk}` } : run,
        );
        set({ terminalRuns: runs });
        break;
      }
      case "share:updated":
        set({ share: event.payload });
        break;
      case "browser:show":
        set({ browserOpen: true, browserMinimized: false, railOpen: false, ...(event.payload.url ? { browserUrl: event.payload.url } : {}) });
        break;
      case "browser:console": {
        const next = [...state.browserConsole, event.payload];
        set({ browserConsole: next.length > 400 ? next.slice(-400) : next });
        break;
      }
      case "browser:network": {
        const next = [...state.browserNetwork, event.payload];
        set({ browserNetwork: next.length > 400 ? next.slice(-400) : next });
        break;
      }
      case "pty:data":
        window.dispatchEvent(new CustomEvent("omp:pty", { detail: event.payload }));
        break;
      case "pty:updated": {
        const exists = state.ptySessions.some((item) => item.id === event.payload.id);
        set({
          ptySessions: exists
            ? state.ptySessions.map((item) => (item.id === event.payload.id ? event.payload : item))
            : [...state.ptySessions, event.payload],
        });
        break;
      }
      case "pty:port":
        set({
          ptySessions: state.ptySessions.map((item) =>
            item.id === event.payload.sessionId && !item.urls.includes(event.payload.url)
              ? { ...item, urls: [...item.urls, event.payload.url] }
              : item,
          ),
        });
        break;
      case "sites:updated":
        set({ sites: event.payload, ...(state.snapshot ? { snapshot: { ...state.snapshot, sites: event.payload } } : {}) });
        break;
      case "usage:updated":
        if (state.snapshot) set({ snapshot: { ...state.snapshot, usage: event.payload } });
        break;
      case "focus":
        if (event.payload.threadId) void get().selectThread(event.payload.threadId, event.payload.nodeId);
        break;
      case "toast":
        get().pushToast(event.payload);
        break;
    }
  },

  async selectNode(nodeId) {
    const node = get().snapshot?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    await get().selectThread(node.orchestratorThreadId, nodeId);
  },

  async selectThread(threadId, nodeId) {
    const state = get();
    const thread = state.snapshot?.threads.find((item) => item.id === threadId);
    if (!thread) return;
    const node = nodeId ?? thread.nodeId;
    if (state.selectedThreadId === threadId && state.messages[threadId]?.length) return;
    set({ selectedThreadId: threadId, selectedNodeId: node, overlay: state.overlay === "inbox" ? "none" : state.overlay });
    await api().focusThread(threadId).catch(() => undefined);
    const cached = !!state.messages[threadId]?.length;
    if (cached) void get().loadMessages(threadId);
    else await get().loadMessages(threadId);
    const envelopes = await api().getEnvelopes({ threadId, limit: 300 });
    set({ envelopes: mergeEnvelopes(state.envelopes, envelopes) });
  },

  async loadMessages(threadId) {
    const existing = get().messages[threadId] ?? [];
    if (!existing.length) set({ loadingMessages: true });
    try {
      const incoming = await api().getThreadMessages(threadId);
      const current = get().messages[threadId] ?? [];
      const byId = new Map(current.map((message) => [message.id, message]));
      for (const message of incoming) {
        const previous = byId.get(message.id);
        if (!previous || messageSignature(previous) !== messageSignature(message)) byId.set(message.id, message);
      }
      const merged = [...byId.values()].sort((a, b) => a.timestamp - b.timestamp);
      const unchanged = merged.length === current.length && merged.every((message, index) => message === current[index]);
      if (!unchanged) set({ messages: { ...get().messages, [threadId]: merged } });
    } finally {
      set({ loadingMessages: false });
    }
  },

  setRightTab(tab) {
    set({ rightTab: tab });
  },
  openBrowser(url) {
    set({ browserOpen: true, browserMinimized: false, railOpen: false, ...(url ? { browserUrl: url } : {}) });
  },
  closeBrowser() {
    set({ browserOpen: false });
  },
  toggleBrowserMinimized() {
    set({ browserMinimized: !get().browserMinimized });
  },
  async loadBrowserDevtools() {
    try {
      const data = await api().getBrowserDevtools();
      set({ browserConsole: data.console ?? [], browserNetwork: data.network ?? [] });
    } catch {
      /* browser not ready */
    }
  },
  clearBrowserConsole() {
    set({ browserConsole: [] });
  },
  clearBrowserNetwork() {
    set({ browserNetwork: [] });
  },
  insertComposer(text) {
    set({ composerInsert: { token: Date.now() + Math.random(), text } });
  },
  clearComposerInsert() {
    set({ composerInsert: null });
  },
  toggleRail() {
    set({ railOpen: !get().railOpen });
  },
  setPaneWidth(pane, width) {
    const next = { ...get().paneWidths };
    if (pane === "sidebar") next.sidebar = Math.min(520, Math.max(220, width));
    if (pane === "right") next.right = Math.min(620, Math.max(260, width));
    if (pane === "browser") next.browser = Math.min(1100, Math.max(340, width));
    set({ paneWidths: next });
  },
  setOverlay(overlay) {
    set({ overlay, preview: overlay === "preview" ? get().preview : null });
  },
  setSettingsTab(tab) {
    set({ settingsTab: tab, overlay: "settings" });
  },
  openPreview(preview) {
    set({ preview, overlay: "preview" });
  },

  async send(text, mode = "prompt") {
    const threadId = get().selectedThreadId;
    if (!threadId || !text.trim()) return;
    set({ sending: true });
    try {
      await api().send({ threadId, text, mode });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Message failed", body: String(error) });
    } finally {
      set({ sending: false });
    }
  },

  async continueThread(threadId) {
    try {
      set({ sending: true });
      await api().continueThread(threadId);
      await get().refresh();
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not continue thread", body: String(error) });
    } finally {
      set({ sending: false });
    }
  },

  async resolveThread(threadId) {
    try {
      await api().resolveThread(threadId);
      await get().refresh();
      get().pushToast({ kind: "success", title: "Thread resolved", body: "Result sent to its parent orchestrator" });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not resolve thread", body: String(error) });
    }
  },

  async stop() {
    const threadId = get().selectedThreadId;
    if (!threadId) return;
    try {
      await api().stopThread(threadId);
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not stop thread", body: String(error) });
    }
  },

  async createNode(input) {
    try {
      const node = await api().createNode(input);
      await get().refresh();
      await get().selectThread(node.orchestratorThreadId, node.id);
      set({ overlay: "none" });
      get().pushToast({ kind: "success", title: `${node.type === "group" ? "Group" : "Project"} created`, body: node.name });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not create node", body: String(error) });
    }
  },

  async createThread(input) {
    try {
      const thread = await api().createThread(input);
      await get().refresh();
      await get().selectThread(thread.id, thread.nodeId);
      set({ overlay: "none" });
      get().pushToast({ kind: "success", title: "Thread spawned", body: thread.title });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not spawn thread", body: String(error) });
    }
  },

  async updateSettings(patch) {
    try {
      await api().updateSettings(patch);
      await get().refresh();
    } catch (error) {
      get().pushToast({ kind: "error", title: "Settings update failed", body: String(error) });
    }
  },

  async completeOnboarding(payload) {
    try {
      const result = await api().completeOnboarding(payload);
      set({ snapshot: result.snapshot, models: result.snapshot.models });
      if (result.node?.orchestratorThreadId) await get().selectThread(result.node.orchestratorThreadId, result.node.id);
      else await get().selectRoot();
    } catch (error) {
      get().pushToast({ kind: "error", title: "Onboarding failed", body: String(error) });
      throw error;
    }
  },

  async refreshModels() {
    try {
      const models = await api().refreshModels();
      set({ models });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Model refresh failed", body: String(error) });
    }
  },

  async refreshAA() {
    try {
      const result = await api().refreshAA();
      const snapshot = await api().getSnapshot();
      set({ models: snapshot.models, snapshot });
      get().pushToast({
        kind: result.ok ? "success" : "warning",
        title: result.ok ? "Artificial Analysis updated" : "AA refresh failed",
        body: result.ok ? `${result.count} models from ${result.source}` : result.error,
      });
    } catch (error) {
      get().pushToast({ kind: "error", title: "AA refresh failed", body: String(error) });
    }
  },

  async refreshUsage() {
    try {
      const usage = await api().refreshUsage();
      const snapshot = get().snapshot;
      if (snapshot) set({ snapshot: { ...snapshot, usage } });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Usage refresh failed", body: String(error) });
    }
  },

  async refreshConfig() {
    try {
      const config = await api().getOmpConfig();
      set({ ompConfig: config });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not read OMP config", body: String(error) });
    }
  },

  async setTool(name, enabled, approval) {
    try {
      await api().setTool(name, enabled, approval);
      await get().refreshConfig();
      get().pushToast({ kind: "success", title: `Tool ${enabled ? "enabled" : "disabled"}`, body: name });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Tool update failed", body: String(error) });
    }
  },

  async setModelDefault(role, selector) {
    try {
      await api().setModelDefault(role, selector);
      await get().refresh();
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not set default model", body: String(error) });
    }
  },

  async resetModelDefaults() {
    try {
      await api().resetModelDefaults();
      await get().refresh();
      get().pushToast({ kind: "success", title: "Model defaults reset" });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not reset defaults", body: String(error) });
    }
  },

  async loadMemory(nodeId) {
    const memory = await api().listMemory(nodeId);
    set({ memory });
  },

  async addMemory(text, tags) {
    const nodeId = get().selectedNodeId;
    if (!nodeId) return;
    await api().addMemory(nodeId, text, tags, 0.7);
    await get().loadMemory(nodeId);
  },

  async deleteMemory(id) {
    await api().deleteMemory(id);
    const nodeId = get().selectedNodeId;
    if (nodeId) await get().loadMemory(nodeId);
  },

  async loadArtifacts(filter) {
    const artifacts = await api().listArtifacts(filter ?? { nodeId: get().selectedNodeId ?? undefined });
    set({ artifacts });
  },

  async loadSites() {
    const sites = await api().listSites();
    const snapshot = get().snapshot;
    set({ sites, ...(snapshot ? { snapshot: { ...snapshot, sites } } : {}) });
  },

  async createSite(input) {
    const site = await api().createSite(input);
    await get().loadSites();
    get().pushToast({ kind: "success", title: "Site created", body: site.name });
  },

  async publishSite(id) {
    const site = await api().publishSite(id);
    await get().loadSites();
    get().pushToast({ kind: "success", title: "Site published", body: site.url });
  },

  async deleteSite(id) {
    const site = get().sites.find((item) => item.id === id);
    await api().deleteSite(id);
    await get().loadSites();
    get().pushToast({ kind: "info", title: "Site deleted", body: site?.name });
  },

  async loadTerminals() {
    const terminalRuns = await api().listTerminals();
    set({ terminalRuns });
  },

  async loadPtySessions() {
    const ptySessions = await api().listPtySessions();
    set({ ptySessions });
  },

  async startPty(input) {
    try {
      const session = await api().startPty({
        nodeId: input?.nodeId ?? get().selectedNodeId ?? undefined,
        threadId: input?.threadId ?? get().selectedThreadId ?? undefined,
        title: input?.title,
      });
      set({ ptySessions: [...get().ptySessions.filter((item) => item.id !== session.id), session] });
      return session;
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not start terminal", body: String(error) });
      return null;
    }
  },

  async killPty(id) {
    await api().killPty(id);
    set({ ptySessions: get().ptySessions.map((item) => (item.id === id ? { ...item, status: "exited" } : item)) });
  },

  async runTerminal(command) {
    const nodeId = get().selectedNodeId;
    if (!nodeId) return;
    const threadId = get().selectedThreadId ?? undefined;
    const run = await api().runTerminal({ nodeId, threadId, command });
    set({ terminalRuns: [run, ...get().terminalRuns.filter((item) => item.id !== run.id)] });
  },

  async respondApproval(id, response) {
    await api().respondApproval(id, response);
    set({ approvals: get().approvals.filter((item) => item.id !== id) });
  },

  async answerEnvelope(id, body) {
    await api().answerEnvelope(id, body);
    set({ inbox: get().inbox.filter((item) => item.id !== id) });
  },

  async markEnvelopeRead(id) {
    await api().markEnvelopeRead(id);
    set({ envelopes: get().envelopes.map((item) => (item.id === id ? { ...item, status: "read" } : item)) });
  },

  async shareThread() {
    const threadId = get().selectedThreadId;
    if (!threadId) return;
    try {
      const share = await api().shareThread(threadId);
      set({ share, overlay: "share" });
    } catch (error) {
      get().pushToast({ kind: "error", title: "Could not share thread", body: String(error) });
    }
  },

  async stopShare() {
    await api().stopShare();
    set({ share: null });
  },

  async markNotificationRead(id) {
    await api().markNotificationRead(id);
    set({ notifications: get().notifications.map((item) => (item.id === id ? { ...item, read: true } : item)) });
  },

  async markAllNotificationsRead() {
    await api().markAllNotificationsRead();
    set({ notifications: get().notifications.map((item) => ({ ...item, read: true })) });
  },

  async clearNotifications() {
    await api().clearNotifications();
    set({ notifications: [] });
  },

  pushToast(toast) {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    set({ toasts: [...get().toasts, { ...toast, id }] });
    setTimeout(() => get().dismissToast(id), 5000);
  },

  dismissToast(id) {
    set({ toasts: get().toasts.filter((toast) => toast.id !== id) });
  },

  async selectRoot() {
    const root = get().snapshot?.nodes.find((node) => node.type === "root");
    if (root) await get().selectThread(root.orchestratorThreadId, root.id);
  },
}));

function messageSignature(message: ChatMessage): string {
  let chars = 0;
  for (const block of message.blocks) {
    if (block.type === "text" || block.type === "thinking") chars += block.text.length;
    else if (block.type === "tool") chars += (block.result?.length ?? 0) + (block.status === "running" ? 1 : 0);
  }
  return `${message.timestamp}|${message.stopReason ?? ""}|${message.usage?.totalTokens ?? ""}|${message.blocks.length}|${chars}`;
}

function mergeEnvelopes(a: Envelope[], b: Envelope[]): Envelope[] {
  const map = new Map<string, Envelope>();
  for (const envelope of [...a, ...b]) map.set(envelope.id, envelope);
  return [...map.values()].sort((x, y) => x.createdAt - y.createdAt).slice(-500);
}

export function selectedThread(state: AppState): Thread | undefined {
  return state.snapshot?.threads.find((thread) => thread.id === state.selectedThreadId);
}

export function selectedNode(state: AppState): TreeNode | undefined {
  return state.snapshot?.nodes.find((node) => node.id === state.selectedNodeId);
}

export function nodeAncestors(nodes: TreeNode[], nodeId: string): TreeNode[] {
  const result: TreeNode[] = [];
  let current = nodes.find((node) => node.id === nodeId);
  while (current) {
    result.unshift(current);
    current = current.parentId ? nodes.find((node) => node.id === current!.parentId) : undefined;
  }
  return result;
}

export function childNodes(nodes: TreeNode[], parentId: string | null): TreeNode[] {
  return nodes.filter((node) => node.parentId === parentId);
}
