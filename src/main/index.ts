import { app, BrowserWindow, nativeImage } from "electron";
import { basename, join } from "node:path";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { EngineLocator } from "./engine/engine-locator";
import { registerIpc, type IpcContext } from "./ipc";
import { Orchestrator } from "./orchestrator/orchestrator";
import { ArtifactService } from "./services/artifacts";
import { BrowserController } from "./services/browser";
import { EnvironmentService } from "./services/environment";
import { GitService } from "./services/git";
import { MemoryService } from "./services/memory";
import { ModelService } from "./services/models";
import { NamingService } from "./services/naming";
import { NotificationService } from "./services/notifications";
import { SettingsService } from "./services/settings";
import { ShareService } from "./services/share";
import { SiteService } from "./services/sites";
import { PtyService } from "./services/pty";
import { WorkspaceService } from "./services/workspace";
import { PythonService } from "./services/python";
import { PrService } from "./services/pr";
import { DeployService } from "./services/deploy";
import { ComputerService } from "./services/computer";
import { ExportService } from "./services/exporter";
import { OAuthService } from "./services/oauth";
import { MobileService } from "./services/mobile";
import { PluginService } from "./services/plugins";
import { collectGarbage } from "./services/maintenance";
import { RelayService } from "./services/relay";
import { RemoteService } from "./services/remote";
import { Store } from "./services/store";
import { TerminalService } from "./services/terminal";
import { UsageService } from "./services/usage";
import { ProviderService } from "./services/providers";
import { initDiagnostics, trace } from "./diagnostics";
import { initAudit } from "./audit";
import type { AppEvent, PaneDiff, PaneKind } from "../shared/types";

let mainWindow: BrowserWindow | null = null;
let browserWindow: BrowserWindow | null = null;
let browserController: BrowserController | null = null;
let orchestrator: Orchestrator | null = null;
let notifications: NotificationService | null = null;
let share: ShareService | null = null;
let sites: SiteService | null = null;
let store: Store | null = null;
let terminals: PtyService | null = null;
let pythonService: PythonService | null = null;
let remote: RemoteService | null = null;
let relay: RelayService | null = null;
let isQuitting = false;
const paneWindows = new Map<PaneKind, BrowserWindow>();
const panePayload = new Map<PaneKind, PaneDiff | null>();

const smokeTest = process.argv.includes("--smoke-test");
const integrationTest = process.argv.includes("--integration-test");

function logCrash(kind: string, error: unknown): void {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[${kind}]`, error);
  trace(kind, message);
  try {
    const dir = app.isReady() ? join(app.getPath("appData"), "Perch") : join(process.env.APPDATA ?? process.cwd(), "Perch");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "errors.log"), `[${new Date().toISOString()}] ${kind}: ${message}\n`, "utf8");
  } catch {
    /* logging must never throw */
  }
}

process.on("uncaughtException", (error) => logCrash("uncaughtException", error));
process.on("unhandledRejection", (reason) => logCrash("unhandledRejection", reason));
app.on("child-process-gone", (_event, details) => logCrash("child-process-gone", details));
if (process.env.PERCH_USER_DATA) {
  mkdirSync(process.env.PERCH_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.PERCH_USER_DATA);
}

function broadcast(event: AppEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (event.type === "thread:message") {
      const chars = messageChars(event.payload);
      if (chars > 500_000) trace("broadcast-large", { threadId: event.payload.threadId, chars });
      if (event.payload.blocks.length > 20 || chars > 100_000) {
        trace("broadcast-send", { threadId: event.payload.threadId, blocks: event.payload.blocks.length, chars });
      }
    }
    mainWindow.webContents.send("perch:event", event);
  }
  remote?.publish(event);
  relay?.publish(event);
}

function messageChars(message: { blocks?: Array<Record<string, unknown>> }): number {
  let chars = 0;
  for (const block of message.blocks ?? []) {
    if (typeof block.text === "string") chars += block.text.length;
    if (typeof block.result === "string") chars += block.result.length;
    if (block.args) {
      try {
        chars += JSON.stringify(block.args).length;
      } catch {
        /* ignore */
      }
    }
  }
  return chars;
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
    git(["-c", "user.email=studio@example.test", "-c", "user.name=Perch", "commit", "-m", "Initial commit"]);
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
    '3. Call tree_create_node with type "project", name "Tool Project", gitInit true, environmentId set to that environment id, and brief "Reply with exactly TOOL_PROJECT_OK". Do not pass a path; let Perch pick the default folder.',
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

const BROWSER_TOOLBAR_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Perch Browser</title>
<style>
html,body{height:100%;margin:0;background:#f5f5f7;color:#222}
body{display:flex;flex-direction:column;font:12px/1.4 "Segoe UI",system-ui,sans-serif}
.bar{display:flex;align-items:center;gap:5px;padding:6px 8px;background:#fff;border-bottom:1px solid #dedee5}
button{width:28px;height:26px;border:1px solid #dedee5;background:#fff;border-radius:6px;color:#333;cursor:pointer;font-size:14px}
button:hover{background:#f0f0f4}
button:disabled{opacity:.35;cursor:default}
input{flex:1;min-width:0;height:26px;border:1px solid #dedee5;border-radius:6px;padding:0 8px;font:11px ui-monospace,Consolas,monospace;color:#333;background:#fff}
webview{flex:1;width:100%;height:100%;border:0}
</style></head><body>
<div class="bar">
  <button id="back" title="Back (Alt+Left)" disabled>&#8592;</button>
  <button id="forward" title="Forward (Alt+Right)" disabled>&#8594;</button>
  <button id="reload" title="Reload">&#8635;</button>
  <input id="address" spellcheck="false" placeholder="Enter a URL" />
</div>
<webview id="view" partition="persist:perch-browser" allowpopups></webview>
<script>
const view=document.getElementById('view');
const address=document.getElementById('address');
const back=document.getElementById('back');
const forward=document.getElementById('forward');
const initial=new URLSearchParams(location.search).get('url')||'https://example.com';
function sync(){
  try{ const current=view.getURL(); if(current) address.value=current; }catch(e){}
  try{ back.disabled=!view.canGoBack(); forward.disabled=!view.canGoForward(); }catch(e){}
}
back.onclick=function(){ try{ if(view.canGoBack()) view.goBack(); }catch(e){} };
forward.onclick=function(){ try{ if(view.canGoForward()) view.goForward(); }catch(e){} };
document.getElementById('reload').onclick=function(){ try{ view.reload(); }catch(e){} };
address.onkeydown=function(event){
  if(event.key!=='Enter') return;
  let value=address.value.trim();
  if(!value) return;
  if(!/^https?:\\/\\//i.test(value)) value='https://'+value;
  try{ view.loadURL(value); }catch(e){}
};
['dom-ready','did-navigate','did-navigate-in-page','did-stop-loading','did-fail-load'].forEach(function(name){ view.addEventListener(name,sync); });
view.addEventListener('page-title-updated',function(event){ document.title=event.title? event.title+' — Perch Browser' : 'Perch Browser'; });
document.addEventListener('keydown',function(event){
  if(!event.altKey) return;
  if(event.key==='ArrowLeft'){ back.click(); event.preventDefault(); }
  if(event.key==='ArrowRight'){ forward.click(); event.preventDefault(); }
});
window.perchNavigate=function(url){ if(/^https?:\\/\\//i.test(url)){ try{ view.loadURL(url); }catch(e){} } };
try{ view.src=initial; }catch(e){}
</script>
</body></html>`;

function browserToolbarPath(): string {
  return join(app.getPath("userData"), "perch-browser.html");
}

function navigateBrowserWindow(url: string): void {
  if (!browserWindow || browserWindow.isDestroyed()) return;
  const script = `window.perchNavigate && window.perchNavigate(${JSON.stringify(url)})`;
  const run = () => {
    if (!browserWindow || browserWindow.isDestroyed()) return;
    void browserWindow.webContents.executeJavaScript(script).catch(() => undefined);
  };
  run();
  if (browserWindow.isMinimized()) browserWindow.restore();
  browserWindow.show();
  browserWindow.focus();
}

function openBrowserWindow(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  if (browserWindow && !browserWindow.isDestroyed()) {
    navigateBrowserWindow(url);
    return;
  }
  const toolbar = browserToolbarPath();
  writeFileSync(toolbar, BROWSER_TOOLBAR_HTML, "utf8");
  browserWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 520,
    minHeight: 420,
    title: "Perch Browser",
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    parent: mainWindow ?? undefined,
    webPreferences: {
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });
  browserWindow.on("closed", () => {
    browserWindow = null;
  });
  browserWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!(params.src === "about:blank" || /^https?:\/\//i.test(params.src))) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.partition = "persist:perch-browser";
  });
  browserWindow.webContents.on("did-attach-webview", (_event, contents) => {
    contents.setWindowOpenHandler(({ url: target }) => {
      if (/^https?:\/\//i.test(target)) navigateBrowserWindow(target);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, target) => {
      if (!(target === "about:blank" || /^https?:\/\//i.test(target))) event.preventDefault();
    });
  });
  void browserWindow.loadFile(toolbar, { query: { url } }).catch(() => undefined);
  browserWindow.show();
}

function openPaneWindow(input: { kind: PaneKind; threadId?: string; diff?: PaneDiff }): void {
  const existing = paneWindows.get(input.kind);
  if (existing && !existing.isDestroyed()) existing.close();
  panePayload.set(input.kind, input.diff ?? null);
  const win = new BrowserWindow({
    width: 1000,
    height: 760,
    minWidth: 460,
    minHeight: 320,
    title: `Perch - ${input.kind}`,
    backgroundColor: "#f7f7f8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  paneWindows.set(input.kind, win);
  win.on("closed", () => {
    if (paneWindows.get(input.kind) === win) paneWindows.delete(input.kind);
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(
      `${process.env.ELECTRON_RENDERER_URL}?pane=${encodeURIComponent(input.kind)}&thread=${encodeURIComponent(input.threadId ?? "")}`,
    );
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"), {
      query: { pane: input.kind, thread: input.threadId ?? "" },
    });
  }
  win.show();
}

const HEADLESS = process.env.PERCH_HEADLESS === "1";

async function createWindow(): Promise<void> {
  if (HEADLESS) return;
  const icon = iconPath();
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: "#f7f7f8",
    title: "Perch",
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
      webviewTag: true,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });
  mainWindow.on("close", (event) => {
    if (isQuitting) return;
    if (store?.settings.remote.keepRunning && remote?.running()) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    browserController?.setContents(null);
    if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close();
  });
  mainWindow.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    if (!(params.src === "about:blank" || /^https?:\/\//i.test(params.src))) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });
  mainWindow.webContents.on("did-attach-webview", (_event, contents) => {
    browserController?.setContents(contents);
    contents.on("destroyed", () => browserController?.clearContents(contents));
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) {
        void contents.loadURL(url).catch(() => undefined);
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, target) => {
      if (!(target === "about:blank" || /^https?:\/\//i.test(target))) event.preventDefault();
    });
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
  app.setAppUserModelId("com.perch.app");
  const dataStore = new Store();
  dataStore.init();
  initDiagnostics(dataStore.baseDir);
  initAudit(dataStore.baseDir);
  trace("app-start", { pid: process.pid, version: app.getVersion() });
  store = dataStore;
  let memoryEmergencyTripped = false;
  const memoryTimer = setInterval(() => {
    try {
      const usage = process.memoryUsage();
      if (usage.heapUsed > 1_800_000_000) dataStore.clearChatCache();
      if (!memoryEmergencyTripped && usage.rss > 2_500_000_000 && orchestrator) {
        memoryEmergencyTripped = true;
        const diagnostics = orchestrator.diagnostics();
        trace("memory-high", { rss: Math.round(usage.rss / 1_048_576), diagnostics });
        appendFileSync(
          join(dataStore.baseDir, "memory.log"),
          `${new Date().toISOString()} MEMORY-HIGH rss=${Math.round(usage.rss / 1_048_576)}MB diagnostics=${JSON.stringify(diagnostics)}\n`,
          "utf8",
        );
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
  browserController = new BrowserController(dataStore.artifactsDir, (url) => {
    broadcast({ type: "browser:show", payload: { url } });
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  }, broadcast);
  const models = new ModelService(dataStore, engine);
  const settings = new SettingsService(dataStore, engine);
  const usage = new UsageService(dataStore, engine);
  const providers = new ProviderService(dataStore, engine, models);
  const shareService = new ShareService(dataStore);
  share = shareService;
  const siteService = new SiteService(dataStore);
  sites = siteService;
  try {
    await siteService.start();
  } catch (error) {
    trace("sites-server-failed", error instanceof Error ? error.message : String(error));
  }
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
  const pty = new PtyService(dataStore, environments, broadcast, (url) => {
    broadcast({ type: "browser:show", payload: { url } });
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  terminals = pty;
  const workspace = new WorkspaceService(dataStore);
  const python = new PythonService();
  pythonService = python;
  const pr = new PrService();
  const deploy = new DeployService(dataStore);
  const computer = new ComputerService(dataStore.artifactsDir);
  const exporter = new ExportService(dataStore, artifacts);
  const oauth = new OAuthService(dataStore);
  const mobile = new MobileService(dataStore.artifactsDir);
  const plugins = new PluginService(dataStore, settings);

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
    browser: browserController,
    pty,
    workspace,
    python,
    deploy,
    computer,
    mobile,
    notifications: notificationService,
    settings,
    share: shareService,
    sites: siteService,
    emit: broadcast,
  });
  await orchestrator.init();

  const remoteService = new RemoteService(dataStore, orchestrator);
  remote = remoteService;
  const relayService = new RelayService(dataStore);
  relay = relayService;
  if (dataStore.settings.remoteRelay?.enabled || process.env.PERCH_RELAY_URL) {
    await relayService.start().catch((error) => trace("relay-start-failed", error instanceof Error ? error.message : String(error)));
  }
  const maintenance = () => collectGarbage(dataStore.baseDir, { nodes: dataStore.nodes, threads: dataStore.threads }, { dryRun: false });
  setTimeout(() => {
    maintenance()
      .then((report) => {
        if (report.actions.length) trace("gc-startup", { actions: report.actions.length, bytes: report.bytesReclaimed, ms: report.durationMs });
      })
      .catch((error) => trace("gc-startup-failed", error instanceof Error ? error.message : String(error)));
  }, 5_000).unref();
  const gcTimer = setInterval(() => {
    void maintenance().catch(() => undefined);
  }, 5 * 60_000);
  gcTimer.unref();
  const syncTimer = setInterval(() => {
    void remoteService.syncRemoteThreads().catch(() => undefined);
    void remoteService.processPendingMoves().catch(() => undefined);
  }, 8_000);
  syncTimer.unref();
  app.on("before-quit", () => {
    clearInterval(gcTimer);
    clearInterval(syncTimer);
  });
  if (dataStore.settings.remote.enabled !== false) {
    await remoteService.start().catch((error) => {
      trace("remote-start-failed", error instanceof Error ? error.message : String(error));
    });
  }

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
    pty,
    workspace,
    pr,
    deploy,
    exporter,
    oauth,
    mobile,
    plugins,
    remote: remoteService,
    relay: relayService,
    share: shareService,
    sites: siteService,
    browser: browserController!,
    usage,
    broadcast,
    openBrowser: (url: string) => {
      broadcast({ type: "browser:show", payload: { url } });
      mainWindow?.show();
      mainWindow?.focus();
    },
    popOutBrowser: (url: string) => openBrowserWindow(url),
    popOutPane: (input: { kind: PaneKind; threadId?: string; diff?: PaneDiff }) => openPaneWindow(input),
    getPaneData: (kind: PaneKind) => panePayload.get(kind) ?? null,
  };
  registerIpc(context);

  await createWindow();
  if (!HEADLESS) notificationService.createTray(iconPath());

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
    console.error("Perch failed to start:", error);
    if (smokeTest) app.exit(1);
  });
}

app.on("activate", () => {
  if (!HEADLESS && BrowserWindow.getAllWindows().length === 0) void createWindow();
});

app.on("window-all-closed", () => {
  if (HEADLESS) return;
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  void share?.stop().catch(() => undefined);
  void sites?.stop().catch(() => undefined);
  void remote?.stop().catch(() => undefined);
  void relay?.stop(false).catch(() => undefined);
  terminals?.disposeAll();
  pythonService?.dispose();
  void orchestrator?.shutdown().catch(() => undefined);
  notifications?.destroy();
  store?.flush();
});













