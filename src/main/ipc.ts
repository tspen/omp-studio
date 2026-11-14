import { app, dialog, ipcMain, shell, BrowserWindow } from "electron";
import type { AppEvent, NewNodeRequest, NewThreadRequest, OnboardingPayload, SendMessageRequest, SettingsPatch } from "../shared/types";
import type { EngineLocator } from "./engine/engine-locator";
import type { Orchestrator } from "./orchestrator/orchestrator";
import type { ArtifactService } from "./services/artifacts";
import type { EnvironmentService } from "./services/environment";
import type { GitService } from "./services/git";
import type { ModelService } from "./services/models";
import type { NotificationService } from "./services/notifications";
import type { SettingsService } from "./services/settings";
import type { ShareService } from "./services/share";
import type { Store } from "./services/store";
import type { TerminalService } from "./services/terminal";
import type { UsageService } from "./services/usage";
import type { ProviderService } from "./services/providers";

export interface IpcContext {
  store: Store;
  engine: EngineLocator;
  orchestrator: Orchestrator;
  environments: EnvironmentService;
  models: ModelService;
  providers: ProviderService;
  settings: SettingsService;
  git: GitService;
  artifacts: ArtifactService;
  notifications: NotificationService;
  terminal: TerminalService;
  share: ShareService;
  usage: UsageService;
  broadcast: (event: AppEvent) => void;
}

export function registerIpc(context: IpcContext): void {
  const { store, orchestrator, environments, models, providers, settings, git, artifacts, notifications, terminal, share, engine, usage, broadcast } = context;

  ipcMain.handle("state:get", () => orchestrator.snapshot());
  ipcMain.handle("thread:messages", (_event, threadId: string) => store.getChat(threadId));
  ipcMain.handle("envelopes:list", (_event, filter) => orchestrator.getEnvelopes(filter ?? {}));

  ipcMain.handle("node:create", (_event, req: NewNodeRequest) => orchestrator.createNode(req));
  ipcMain.handle("node:update", (_event, id: string, patch) => orchestrator.updateNode(id, patch));
  ipcMain.handle("node:delete", (_event, id: string) => orchestrator.deleteNode(id));

  ipcMain.handle("thread:create", (_event, req: NewThreadRequest) => orchestrator.createThread(req));
  ipcMain.handle("thread:update", (_event, id: string, patch) => orchestrator.updateThread(id, patch));
  ipcMain.handle("thread:delete", (_event, id: string) => orchestrator.deleteThread(id));
  ipcMain.handle("thread:send", (_event, req: SendMessageRequest) => orchestrator.sendUserMessage(req));
  ipcMain.handle("thread:stop", (_event, id: string) => orchestrator.stopThread(id));
  ipcMain.handle("thread:restart", (_event, id: string) => orchestrator.restartThread(id));
  ipcMain.handle("thread:set-model", (_event, id: string, selector: string) => orchestrator.setThreadModel(id, selector));
  ipcMain.handle("thread:set-effort", (_event, id: string, effort: string) => orchestrator.setThreadEffort(id, effort));
  ipcMain.handle("thread:fork", (_event, id: string, entryId?: string) => orchestrator.forkThread(id, entryId));
  ipcMain.handle("thread:branch", (_event, id: string, entryId: string) => orchestrator.branchThread(id, entryId));
  ipcMain.handle("thread:navigate", (_event, id: string, entryId: string, summarize?: boolean) =>
    orchestrator.navigateThread(id, entryId, summarize),
  );
  ipcMain.handle("thread:entries", (_event, id: string) => orchestrator.getThreadEntries(id));
  ipcMain.handle("thread:goal", (_event, id: string, op: string, objective?: string, tokenBudget?: number) =>
    orchestrator.goalThread(id, op as any, objective, tokenBudget),
  );
  ipcMain.handle("thread:export", (_event, id: string) => orchestrator.exportThread(id));

  ipcMain.handle("envelope:send", (_event, req) => orchestrator.sendEnvelope(req));
  ipcMain.handle("envelope:answer", (_event, id: string, body: string) => orchestrator.answerEnvelope(id, body));
  ipcMain.handle("envelope:read", (_event, id: string) => orchestrator.markEnvelopeRead(id));

  ipcMain.handle("memory:list", (_event, nodeId: string, query?: string) => orchestrator.memoryList(nodeId, query));
  ipcMain.handle("memory:add", (_event, nodeId: string, text: string, tags?: string[], importance?: number) =>
    orchestrator.addMemory(nodeId, text, tags, importance),
  );
  ipcMain.handle("memory:update", (_event, id: string, patch) => orchestrator.updateMemory(id, patch));
  ipcMain.handle("memory:delete", (_event, id: string) => orchestrator.deleteMemory(id));
  ipcMain.handle("memory:consolidate", (_event, nodeId: string) => orchestrator.consolidateMemory(nodeId));

  ipcMain.handle("env:save", (_event, env) => {
    const saved = environments.save(env);
    broadcast({ type: "snapshot", payload: orchestrator.snapshot() });
    return saved;
  });
  ipcMain.handle("env:delete", (_event, id: string) => {
    environments.remove(id);
    broadcast({ type: "snapshot", payload: orchestrator.snapshot() });
  });
  ipcMain.handle("env:test", (_event, id: string) => {
    const env = store.getEnvironment(id);
    const cwd = env?.cwd || store.baseDir;
    return environments.test(id, cwd);
  });

  ipcMain.handle("git:status", (_event, nodeId: string, threadId?: string) => orchestrator.gitStatus(nodeId, threadId));
  ipcMain.handle("git:diff", (_event, nodeId: string, threadId?: string, path?: string) =>
    orchestrator.gitDiff(nodeId, threadId, path),
  );
  ipcMain.handle("git:read-file", (_event, path: string) => git.readFile(path));
  ipcMain.handle("git:commit", (_event, nodeId: string, threadId: string | undefined, message: string, paths?: string[]) =>
    orchestrator.gitCommit(nodeId, threadId, message, paths),
  );
  ipcMain.handle("git:merge", (_event, nodeId: string, threadId: string) => orchestrator.gitMerge(nodeId, threadId));
  ipcMain.handle("git:pr", (_event, nodeId: string, threadId: string, title: string, body: string) =>
    orchestrator.gitCreatePr(nodeId, threadId, title, body),
  );
  ipcMain.handle("git:discard", (_event, nodeId: string, threadId: string) => orchestrator.gitDiscard(nodeId, threadId));

  ipcMain.handle("settings:update", (_event, patch: SettingsPatch) => {
    const updated = store.setSettings(patch.settings ?? {});
    if (patch.settings?.models) models.ensureDefaults();
    broadcast({ type: "snapshot", payload: orchestrator.snapshot() });
    return updated;
  });
  ipcMain.handle("settings:complete-onboarding", async (_event, payload: OnboardingPayload) => {
    const current = store.settings;
    const models = {
      ...current.models,
      ...payload.models,
      group: payload.models.group ?? payload.models.root,
      project: payload.models.project ?? payload.models.worker,
      memory: payload.models.memory ?? payload.models.naming,
      rootEffort: payload.efforts.root,
      groupEffort: payload.efforts.group ?? payload.efforts.root,
      projectEffort: payload.efforts.project ?? payload.efforts.worker,
      workerEffort: payload.efforts.worker,
    };
    store.setSettings({
      onboardingCompleted: true,
      autoName: payload.autoName,
      notifications: { ...current.notifications, enabled: payload.notificationsEnabled },
      models,
    });
    orchestrator.applyDefaultsToEmptyTree();
    let node: any;
    const first = payload.firstProject;
    if (first && (first.name?.trim() || first.brief?.trim())) {
      const root = store.nodes.find((item) => item.type === "root");
      if (root) {
        node = await orchestrator.createNode({
          parentId: root.id,
          type: "project",
          name: first.name?.trim() ?? "",
          path: first.path?.trim() || undefined,
          brief: first.brief?.trim() || undefined,
          model: models.project,
          effort: models.projectEffort,
          gitInit: !!first.gitInit,
        });
      }
    }
    const snapshot = orchestrator.snapshot();
    broadcast({ type: "snapshot", payload: snapshot });
    return { snapshot, node };
  });
  ipcMain.handle("omp-config:get", async () => {
    const cached = store.data.ompConfig;
    if (cached.fetchedAt && Date.now() - cached.fetchedAt < 5 * 60_000) return cached;
    return settings.refresh();
  });
  ipcMain.handle("omp-config:set", async (_event, key: string, value: unknown) => {
    const snapshot = await settings.set(key, value);
    broadcast({ type: "config:updated", payload: snapshot });
    return snapshot;
  });
  ipcMain.handle("omp-config:reset", async (_event, key: string) => {
    const snapshot = await settings.reset(key);
    broadcast({ type: "config:updated", payload: snapshot });
    return snapshot;
  });

  ipcMain.handle("tools:list", () => settings.tools());
  ipcMain.handle("tools:set", async (_event, name: string, enabled: boolean, approval?) => {
    const tools = await settings.setTool(name, enabled, approval);
    return tools;
  });
  ipcMain.handle("skills:list", () => settings.skills());
  ipcMain.handle("mcp:list", () => settings.mcpServers());
  ipcMain.handle("providers:list", () => providers.list());
  ipcMain.handle("providers:connect", async (_event, id: string, apiKey?: string) => {
    const result = await providers.connect(id, apiKey);
    if (result.ok) {
      const list = await models.refresh().catch(() => models.list());
      broadcast({ type: "models:updated", payload: { models: list, updatedAt: Date.now() } });
      const usageSnapshot = await usage.refresh().catch(() => null);
      if (usageSnapshot) broadcast({ type: "usage:updated", payload: usageSnapshot });
      broadcast({ type: "snapshot", payload: orchestrator.snapshot() });
    }
    return result;
  });

  ipcMain.handle("models:refresh", async () => {
    const list = await models.refresh();
    broadcast({ type: "models:updated", payload: { models: list, updatedAt: Date.now() } });
    return list;
  });
  ipcMain.handle("models:defaults", () => store.settings.models);
  ipcMain.handle("models:set-default", (_event, role: string, selector: string) => {
    const updated = store.setSettings({ models: { ...store.settings.models, [role]: selector } as any });
    return updated;
  });
  ipcMain.handle("models:reset-defaults", () => {
    models.resetDefaults();
    orchestrator.applyDefaultsToEmptyTree();
    return store.settings;
  });
  ipcMain.handle("models:refresh-aa", async () => {
    const result = await models.refreshAA(true);
    broadcast({ type: "models:updated", payload: { models: models.list(), updatedAt: models.updatedAt() } });
    return result;
  });
  ipcMain.handle("usage:refresh", async () => {
    const snapshot = await usage.refresh();
    broadcast({ type: "usage:updated", payload: snapshot });
    return snapshot;
  });

  ipcMain.handle("terminal:run", (_event, req) => terminal.run(req));
  ipcMain.handle("terminal:kill", (_event, runId: string) => terminal.kill(runId));
  ipcMain.handle("terminal:list", () => terminal.list());

  ipcMain.handle("artifacts:list", (_event, filter) => artifacts.list(filter ?? {}));
  ipcMain.handle("artifacts:read", (_event, id: string) => artifacts.read(id));

  ipcMain.handle("notifications:list", () => notifications.list());
  ipcMain.handle("notifications:read", (_event, id: string) => notifications.markRead(id));
  ipcMain.handle("notifications:clear", () => notifications.clear());

  ipcMain.handle("approval:respond", (_event, id: string, response: unknown) => orchestrator.respondApproval(id, response));

  ipcMain.handle("share:create", async (_event, threadId: string) => {
    const info = await share.start(threadId);
    broadcast({ type: "share:updated", payload: info });
    return info;
  });
  ipcMain.handle("share:stop", async () => {
    await share.stop();
    broadcast({ type: "share:updated", payload: null });
  });

  ipcMain.handle("dialog:pick-directory", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle("shell:open-external", (_event, url: string) => shell.openExternal(url));
  ipcMain.handle("shell:open-path", (_event, path: string) => shell.openPath(path));

  ipcMain.handle("engine:download", async () => {
    engine.setProgressHandler((status) => broadcast({ type: "engine:progress", payload: status }));
    return engine.download();
  });
  ipcMain.handle("app:restart", () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle("window:minimize", () => undefined);
  ipcMain.handle("window:maximize", () => undefined);
  ipcMain.handle("window:theme", (_event, theme: "light" | "dark") => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    const dark = theme === "dark";
    win.setBackgroundColor(dark ? "#141417" : "#f7f7f8");
    win.setTitleBarOverlay({
      color: dark ? "#17171b" : "#f7f7f8",
      symbolColor: dark ? "#e6e6ef" : "#3b3b43",
      height: 40,
    });
  });
}
