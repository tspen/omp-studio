import { app, BrowserWindow, nativeImage } from "electron";
import { basename, join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EngineLocator } from "./engine/engine-locator";
import { registerIpc, type IpcContext } from "./ipc";
import { Orchestrator } from "./orchestrator/orchestrator";
import { ArtifactService } from "./services/artifacts";
import { EnvironmentService } from "./services/environment";
import { GitService } from "./services/git";
import { MemoryService } from "./services/memory";
import { ModelService } from "./services/models";
import { NamingService } from "./services/naming";
import { NotificationService } from "./services/notifications";
import { SettingsService } from "./services/settings";
import { ShareService } from "./services/share";
import { Store } from "./services/store";
import { TerminalService } from "./services/terminal";
import { UsageService } from "./services/usage";
import { ProviderService } from "./services/providers";
import type { AppEvent } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;
let notifications: NotificationService | null = null;
let share: ShareService | null = null;
let store: Store | null = null;

const smokeTest = process.argv.includes("--smoke-test");
const integrationTest = process.argv.includes("--integration-test");

function logCrash(kind: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[${kind}]`, error);
  try {
    const dir = app.isReady() ? join(app.getPath("userData"), "omp-studio") : join(process.env.APPDATA ?? process.cwd(), "omp-studio");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "errors.log"), `[${new Date().toISOString()}] ${kind}: ${message}\n`, "utf8");
  } catch {
    /* logging must never throw */
  }
}

process.on("uncaughtException", (error) => logCrash("uncaughtException", error));
process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", reason));
app.on("child-process-gone", (_event, details) => logCrash("child-process-gone", details));
if (process.env.OMP_STUDIO_USER_DATA) {
  mkdirSync(process.env.OMP_STUDIO_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.OMP_STUDIO_USER_DATA);
}

function broadcast(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("omp:event", event);
}

function iconPath(): string {
  const candidates = [
    join(process.resourcesPath, "icon.png"),
    join(app.getAppPath(), "resources", "icon.png"),
  ];
  return candidates.find((path) => existsSync(path)) ?? "";
}

async function runIntegration(
  dataStore: Store,
  orchestrator: Orchestrator,
  models: ModelService,
): Promise<void> {
  const free =
    models.list().find((model) => model.selector === "openrouter/openrouter/free") ??
    models.list().find((model) => model.selector.includes("free")) ??
    models.list()[0];
  if (!free) throw new Error("No model available for integration test");
  const rootNode = dataStore.nodes.find((node) => node.type === "root");
  if (!rootNode) throw new Error("Root node missing");
  const rootThread = dataStore.getThread(rootNode.orchestratorThreadId);
  if (!rootThread) throw new Error("Root thread missing");
  dataStore.updateThread(rootThread.id, {
    model: { provider: free.provider, id: free.id, selector: free.selector, name: free.name },
    effort: free.reasoning ? (free.thinking?.[0] ?? "off") : "off",
  });
  dataStore.updateNode(rootNode.id, { model: free.selector, effort: free.reasoning ? (free.thinking?.[0] ?? "off") : "off" });

  const waitFor = async (threadId: string, needle: string, timeoutMs: number) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const thread = dataStore.getThread(threadId);
      const text = dataStore
        .getChat(threadId)
        .filter((message) => message.role === "assistant")
        .map((message) => message.blocks.filter((block) => block.type === "text").map((block: any) => block.text).join("\n"))
        .join("\n");
      if (text.includes(needle)) return { text, thread };
      if (thread?.status === "error") throw new Error(`Thread ${thread.title} failed: ${thread.statusMessage ?? thread.error ?? "unknown"}`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for "${needle}" in ${dataStore.getThread(threadId)?.title ?? threadId}`);
  };

  console.log("INTEGRATION: root prompt");
  await orchestrator.sendUserMessage({
    threadId: rootThread.id,
    text: "Reply with exactly HELLO. Do not use any tools.",
  });
  await waitFor(rootThread.id, "HELLO", 180_000);

  console.log("INTEGRATION: create project");
  const projectPath = join(dataStore.baseDir, "workspaces", "integration-project");
  mkdirSync(projectPath, { recursive: true });
  writeFileSync(join(projectPath, "README.md"), "# Integration project\n", "utf8");
  const git = (args: string[]) => execFileSync("git", args, { cwd: projectPath, windowsHide: true, encoding: "utf8" });
  if (!existsSync(join(projectPath, ".git"))) {
    git(["init"]);
    git(["add", "."]);
    git(["-c", "user.email=studio@example.test", "-c", "user.name=OMP Studio", "commit", "-m", "Initial commit"]);
  }
  const project = await orchestrator.createNode({
    parentId: rootNode.id,
    type: "project",
    name: `Integration ${Date.now().toString(36)}`,
    path: projectPath,
    model: free.selector,
    effort: free.reasoning ? (free.thinking?.[0] ?? "off") : "off",
    approvalMode: "yolo",
    brief: "Reply with exactly CHILD_OK. Then call tree_report with status done and summary CHILD_OK.",
  });
  await waitFor(project.orchestratorThreadId, "CHILD_OK", 90_000);

  console.log("INTEGRATION: create worker");
  const worker = await orchestrator.createThread({
    nodeId: project.id,
    parentThreadId: project.orchestratorThreadId,
    brief: "Reply with exactly WORKER_OK. Then call tree_report with status done and summary WORKER_OK.",
    model: free.selector,
    effort: free.reasoning ? (free.thinking?.[0] ?? "off") : "off",
    isolation: "worktree",
    wait: false,
  });
  await waitFor(worker.id, "WORKER_OK", 90_000);
  const envelopes = dataStore.listEnvelopes({ limit: 200 });
  const childReport = envelopes.find((envelope) => envelope.fromThreadId === project.orchestratorThreadId && envelope.kind === "result");
  const workerReport = envelopes.find((envelope) => envelope.fromThreadId === worker.id && envelope.kind === "result");
  console.log("INTEGRATION: chat autonomy tools");
  const autonomyRoot = join(dataStore.baseDir, "workspaces");
  dataStore.setSettings({ workspaceRoot: autonomyRoot });
  const defaultPathNode = await orchestrator.createNode({
    parentId: rootNode.id,
    type: "project",
    name: "Default Path Check",
    gitInit: true,
  });
  const defaultProjectPath = defaultPathNode.path;
  if (!defaultProjectPath.toLowerCase().startsWith(autonomyRoot.toLowerCase())) {
    throw new Error(`Default project path is outside the workspace root: ${defaultProjectPath}`);
  }
  if (basename(defaultProjectPath) !== "default-path-check") {
    throw new Error(`Default project path is not named after the project: ${defaultProjectPath}`);
  }
  if (!existsSync(join(defaultProjectPath, ".git"))) throw new Error("Default project path was not git-initialised");
  await orchestrator.deleteNode(defaultPathNode.id);
  const toolGroupName = `Tool Group ${Date.now().toString(36)}`;
  const prompt = [
    "You are being tested. Use the tree tools, in order, without asking questions.",
    '1. Call tree_create_environment with name "Integration Env" and setupCommands ["echo setup-ok"].',
    '2. Call tree_list_environments and note the id of "Integration Env".',
    '3. Call tree_create_node with type "project", name "Tool Project", gitInit true, environmentId set to that environment id, and brief "Reply with exactly TOOL_PROJECT_OK". Do not pass a path; let OMP Studio pick the default folder.',
    `4. Call tree_create_node with type "group" and name ${JSON.stringify(toolGroupName)}.`,
    "5. Call tree_move_node to move the Tool Project node under the new group.",
    '6. Call tree_update_node on Tool Project with effort "high".',
    "7. Reply with exactly TOOL_SETUP_DONE. If any tool fails, report the exact error instead.",
  ].join("\n");
  await orchestrator.sendUserMessage({ threadId: rootThread.id, text: prompt });
  const deadline = Date.now() + 6 * 60_000;
  const latestNode = (name: string) =>
    dataStore.nodes.filter((node) => node.name === name).sort((a, b) => b.createdAt - a.createdAt)[0];
  let env = dataStore.environments.find((item) => item.name === "Integration Env");
  let toolProject = latestNode("Tool Project");
  let toolGroup = latestNode(toolGroupName);
  while (Date.now() < deadline) {
    env = dataStore.environments.find((item) => item.name === "Integration Env");
    toolProject = latestNode("Tool Project");
    toolGroup = latestNode(toolGroupName);
    if (env && toolProject && toolGroup && toolProject.parentId === toolGroup.id && toolProject.effort === "high") break;
    const rootState = dataStore.getThread(rootThread.id);
    if (rootState?.status === "error") throw new Error(`Autonomy prompt failed: ${rootState.statusMessage ?? "unknown"}`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  if (!env) throw new Error("Chat did not create an environment with tree_create_environment");
  if (!toolProject) throw new Error("Chat did not create a project with tree_create_node");
  if (!toolGroup) throw new Error("Chat did not create a group with tree_create_node");
  if (toolProject.parentId !== toolGroup.id) throw new Error("Chat did not move the project under the group with tree_move_node");
  if (toolProject.environmentId !== env.id) throw new Error("Chat did not attach the environment to the project");
  if (toolProject.effort !== "high") throw new Error(`Chat did not update effort (got ${toolProject.effort})`);
  if (!existsSync(join(toolProject.path, ".git"))) throw new Error("Chat did not initialise git for the new project");
  console.log("INTEGRATION_TOOLS_OK", {
    environment: env.id,
    environmentSetup: env.setupCommands,
    project: toolProject.id,
    projectPath: toolProject.path,
    group: toolGroup.id,
    effort: toolProject.effort,
  });

  console.log("INTEGRATION_OK", {
    rootThread: rootThread.id,
    project: project.id,
    projectThread: project.orchestratorThreadId,
    worker: worker.id,
    workerBranch: worker.branch,
    messages: dataStore.getChat(rootThread.id).length,
    envelopes: envelopes.length,
    childReport: !!childReport,
    workerReport: !!workerReport,
    workerStatus: dataStore.getThread(worker.id)?.status,
  });
}

async function createWindow(): Promise<void> {
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: "#f7f7f8",
    title: "OMP Studio",
    icon: icon || undefined,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#f7f7f8",
      symbolColor: "#3b3b43",
      height: 40,
    },
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  let rendererReloads: number[] = [];
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    logCrash("render-process-gone", details);
    store?.flush();
    const now = Date.now();
    rendererReloads = rendererReloads.filter((time) => now - time < 60_000);
    if (!smokeTest && rendererReloads.length < 3 && !mainWindow?.isDestroyed()) {
      rendererReloads.push(now);
      setTimeout(() => mainWindow?.reload(), 700);
    }
  });
  mainWindow.webContents.on("unresponsive", () => logCrash("renderer-unresponsive", "The renderer stopped responding"));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }

  notifications?.setFocusHandler(() => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
  notifications?.setOpenHandler((notification) => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    broadcast({ type: "focus", payload: { threadId: notification.threadId, nodeId: notification.nodeId } });
  });
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId("com.ompstudio.app");
  const dataStore = new Store();
  dataStore.init();
  store = dataStore;
  let memoryEmergencyTripped = false;
  const memoryTimer = setInterval(() => {
    try {
      const usage = process.memoryUsage();
      if (usage.heapUsed > 1_800_000_000) dataStore.clearChatCache();
      if (!memoryEmergencyTripped && usage.rss > 2_500_000_000 && orchestrator) {
        memoryEmergencyTripped = true;
        const diagnostics = orchestrator.diagnostics();
        appendFileSync(
          join(dataStore.baseDir, "memory.log"),
          `${new Date().toISOString()} EMERGENCY rss=${Math.round(usage.rss / 1_048_576)}MB diagnostics=${JSON.stringify(diagnostics)}\n`,
          "utf8",
        );
        void orchestrator.emergencyStop("Stopped live sessions because the app reached 2.5 GB of memory.").catch(() => undefined);
      }
      appendFileSync(
        join(dataStore.baseDir, "memory.log"),
        `${new Date().toISOString()} heap=${Math.round(usage.heapUsed / 1_048_576)}MB rss=${Math.round(usage.rss / 1_048_576)}MB external=${Math.round(usage.external / 1_048_576)}MB arrayBuffers=${Math.round(usage.arrayBuffers / 1_048_576)}MB${usage.heapUsed > 1_800_000_000 ? " trimmed-chat-cache" : ""}\n`,
        "utf8",
      );
    } catch {
      /* diagnostics must never throw */
    }
  }, 2_000);
  memoryTimer.unref();

  const engine = new EngineLocator(dataStore);
  await engine.detect();

  const environments = new EnvironmentService(dataStore);
  environments.init();
  const git = new GitService();
  const memory = new MemoryService(dataStore);
  const artifacts = new ArtifactService(dataStore);
  const models = new ModelService(dataStore, engine);
  const settings = new SettingsService(dataStore, engine);
  const usage = new UsageService(dataStore, engine);
  const providers = new ProviderService(dataStore, engine, models);
  const shareService = new ShareService(dataStore);
  share = shareService;
  const notificationService = new NotificationService(dataStore, broadcast);
  notifications = notificationService;
  const naming = new NamingService(dataStore, engine, (threadId) => {
    const thread = dataStore.getThread(threadId);
    if (thread) broadcast({ type: "thread:updated", payload: thread });
  }, (nodeId) => {
    const node = dataStore.getNode(nodeId);
    if (node) broadcast({ type: "node:updated", payload: node });
  });
  const terminal = new TerminalService(dataStore, environments, broadcast);

  if (dataStore.data.models.length) {
    models.ensureDefaults();
  } else {
    try {
      await models.refresh();
    } catch (error) {
      broadcast({
        type: "toast",
        payload: {
          kind: "warning",
          title: "Model catalog unavailable",
          body: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  orchestrator = new Orchestrator({
    store: dataStore,
    engine,
    environments,
    memory,
    models,
    naming,
    git,
    artifacts,
    notifications: notificationService,
    settings,
    share: shareService,
    emit: broadcast,
  });
  await orchestrator.init();

  const context: IpcContext = {
    store: dataStore,
    engine,
    orchestrator,
    environments,
    models,
    providers,
    settings,
    git,
    artifacts,
    notifications: notificationService,
    terminal,
    share: shareService,
    usage,
    broadcast,
  };
  registerIpc(context);

  await createWindow();
  notificationService.createTray(iconPath());

  if (!smokeTest) {
    void models.refresh().then((list) => {
      orchestrator!.applyDefaultsToEmptyTree();
      broadcast({ type: "models:updated", payload: { models: list, updatedAt: Date.now() } });
      broadcast({ type: "snapshot", payload: orchestrator!.snapshot() });
    }).catch(() => undefined);
    void settings.refresh().then((snapshot) => broadcast({ type: "config:updated", payload: snapshot })).catch(() => undefined);
    void usage.refresh().then((snapshot) => broadcast({ type: "usage:updated", payload: snapshot })).catch(() => undefined);
    setInterval(() => {
      void usage.refresh().then((snapshot) => broadcast({ type: "usage:updated", payload: snapshot })).catch(() => undefined);
    }, 5 * 60_000);
    const last = dataStore.settings.models.lastAAUpdate ? Date.parse(dataStore.settings.models.lastAAUpdate) : 0;
    if (Date.now() - last > 24 * 3_600_000) {
      void models.refreshAA().then(() => {
        orchestrator!.applyDefaultsToEmptyTree(); broadcast({ type: "models:updated", payload: { models: models.list(), updatedAt: models.updatedAt() } }); broadcast({ type: "snapshot", payload: orchestrator!.snapshot() });
      }).catch(() => undefined);
    }
    setInterval(() => {
      const lastUpdate = dataStore.settings.models.lastAAUpdate ? Date.parse(dataStore.settings.models.lastAAUpdate) : 0;
      if (Date.now() - lastUpdate > 24 * 3_600_000) {
        void models.refreshAA().then(() => {
          orchestrator!.applyDefaultsToEmptyTree(); broadcast({ type: "models:updated", payload: { models: models.list(), updatedAt: models.updatedAt() } }); broadcast({ type: "snapshot", payload: orchestrator!.snapshot() });
        }).catch(() => undefined);
      }
    }, 6 * 3_600_000);
  }

  if (smokeTest) {
    setTimeout(() => {
      console.log("SMOKE_OK", {
        engine: engine.current,
        nodes: dataStore.nodes.length,
        threads: dataStore.threads.length,
        models: dataStore.data.models.length,
      });
      app.quit();
    }, 2500);
  }

  if (integrationTest) {
    void runIntegration(dataStore, orchestrator, models)
      .then(() => app.exit(0))
      .catch((error) => {
        console.error("INTEGRATION_FAILED", error);
        app.exit(1);
      });
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap).catch((error) => {
    console.error("OMP Studio failed to start:", error);
    if (smokeTest) app.exit(1);
  });
}

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void share?.stop().catch(() => undefined);
  void orchestrator?.shutdown().catch(() => undefined);
  notifications?.destroy();
  store?.flush();
});
