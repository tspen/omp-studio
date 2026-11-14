import { contextBridge, ipcRenderer } from "electron";
import type { AppEvent, OmpStudioApi } from "../shared/types";

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

const api: OmpStudioApi = {
  getSnapshot: () => invoke("state:get") as Promise<any>,
  getThreadMessages: (threadId) => invoke("thread:messages", threadId) as Promise<any>,
  getEnvelopes: (filter) => invoke("envelopes:list", filter) as Promise<any>,

  createNode: (req) => invoke("node:create", req) as Promise<any>,
  updateNode: (id, patch) => invoke("node:update", id, patch) as Promise<any>,
  setNodeApproval: (id, mode) => invoke("node:set-approval", id, mode) as Promise<any>,
  deleteNode: (id) => invoke("node:delete", id) as Promise<any>,
  createThread: (req) => invoke("thread:create", req) as Promise<any>,
  updateThread: (id, patch) => invoke("thread:update", id, patch) as Promise<any>,
  deleteThread: (id) => invoke("thread:delete", id) as Promise<any>,
  send: (req) => invoke("thread:send", req) as Promise<any>,
  stopThread: (id) => invoke("thread:stop", id) as Promise<any>,
  restartThread: (id) => invoke("thread:restart", id) as Promise<any>,
  continueThread: (id) => invoke("thread:continue", id) as Promise<any>,
  compactThread: (id) => invoke("thread:compact", id) as Promise<any>,
  setThreadModel: (id, selector) => invoke("thread:set-model", id, selector) as Promise<any>,
  setThreadEffort: (id, effort) => invoke("thread:set-effort", id, effort) as Promise<any>,
  forkThread: (id, entryId) => invoke("thread:fork", id, entryId) as Promise<any>,
  branchThread: (id, entryId) => invoke("thread:branch", id, entryId) as Promise<any>,
  navigateThread: (id, entryId, summarize) => invoke("thread:navigate", id, entryId, summarize) as Promise<any>,
  getThreadEntries: (id) => invoke("thread:entries", id) as Promise<any>,
  goalThread: (id, op, objective, tokenBudget) => invoke("thread:goal", id, op, objective, tokenBudget) as Promise<any>,
  exportThread: (id) => invoke("thread:export", id) as Promise<any>,

  sendEnvelope: (req) => invoke("envelope:send", req) as Promise<any>,
  answerEnvelope: (id, body) => invoke("envelope:answer", id, body) as Promise<any>,
  markEnvelopeRead: (id) => invoke("envelope:read", id) as Promise<any>,

  listMemory: (nodeId, query) => invoke("memory:list", nodeId, query) as Promise<any>,
  addMemory: (nodeId, text, tags, importance) => invoke("memory:add", nodeId, text, tags, importance) as Promise<any>,
  updateMemory: (id, patch) => invoke("memory:update", id, patch) as Promise<any>,
  deleteMemory: (id) => invoke("memory:delete", id) as Promise<any>,
  consolidateMemory: (nodeId) => invoke("memory:consolidate", nodeId) as Promise<any>,

  saveEnvironment: (env) => invoke("env:save", env) as Promise<any>,
  deleteEnvironment: (id) => invoke("env:delete", id) as Promise<any>,
  testEnvironment: (id) => invoke("env:test", id) as Promise<any>,

  getGitStatus: (nodeId, threadId) => invoke("git:status", nodeId, threadId) as Promise<any>,
  getGitDiff: (nodeId, threadId, path) => invoke("git:diff", nodeId, threadId, path) as Promise<any>,
  readFile: (path) => invoke("git:read-file", path) as Promise<any>,
  gitCommit: (nodeId, threadId, message, paths) => invoke("git:commit", nodeId, threadId, message, paths) as Promise<any>,
  gitMerge: (nodeId, threadId) => invoke("git:merge", nodeId, threadId) as Promise<any>,
  gitCreatePr: (nodeId, threadId, title, body) => invoke("git:pr", nodeId, threadId, title, body) as Promise<any>,
  gitDiscard: (nodeId, threadId) => invoke("git:discard", nodeId, threadId) as Promise<any>,

  updateSettings: (patch) => invoke("settings:update", patch) as Promise<any>,
  completeOnboarding: (payload) => invoke("settings:complete-onboarding", payload) as Promise<any>,
  getOmpConfig: () => invoke("omp-config:get") as Promise<any>,
  setOmpConfig: (key, value) => invoke("omp-config:set", key, value) as Promise<any>,
  resetOmpConfig: (key) => invoke("omp-config:reset", key) as Promise<any>,

  listTools: () => invoke("tools:list") as Promise<any>,
  setTool: (name, enabled, approval) => invoke("tools:set", name, enabled, approval) as Promise<any>,
  listSkills: () => invoke("skills:list") as Promise<any>,
  listMcpServers: () => invoke("mcp:list") as Promise<any>,
  listProviders: () => invoke("providers:list") as Promise<any>,
  connectProvider: (id, apiKey) => invoke("providers:connect", id, apiKey) as Promise<any>,

  refreshModels: () => invoke("models:refresh") as Promise<any>,
  getModelDefaults: () => invoke("models:defaults") as Promise<any>,
  setModelDefault: (role, selector) => invoke("models:set-default", role, selector) as Promise<any>,
  resetModelDefaults: () => invoke("models:reset-defaults") as Promise<any>,
  refreshAA: () => invoke("models:refresh-aa") as Promise<any>,
  refreshUsage: () => invoke("usage:refresh") as Promise<any>,

  runTerminal: (req) => invoke("terminal:run", req) as Promise<any>,
  killTerminal: (runId) => invoke("terminal:kill", runId) as Promise<any>,
  listTerminals: () => invoke("terminal:list") as Promise<any>,

  listArtifacts: (filter) => invoke("artifacts:list", filter) as Promise<any>,
  readArtifact: (id) => invoke("artifacts:read", id) as Promise<any>,

  listNotifications: () => invoke("notifications:list") as Promise<any>,
  markNotificationRead: (id) => invoke("notifications:read", id) as Promise<any>,
  clearNotifications: () => invoke("notifications:clear") as Promise<any>,

  respondApproval: (id, response) => invoke("approval:respond", id, response) as Promise<any>,

  shareThread: (threadId) => invoke("share:create", threadId) as Promise<any>,
  stopShare: () => invoke("share:stop") as Promise<any>,

  pickDirectory: () => invoke("dialog:pick-directory") as Promise<any>,
  setWindowTheme: (theme) => invoke("window:theme", theme) as Promise<any>,
  openExternal: (url) => invoke("shell:open-external", url) as Promise<any>,
  openPath: (path) => invoke("shell:open-path", path) as Promise<any>,
  downloadEngine: () => invoke("engine:download") as Promise<any>,
  restartApp: () => invoke("app:restart") as Promise<any>,

  onEvent: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, event: AppEvent) => cb(event);
    ipcRenderer.on("omp:event", listener);
    return () => ipcRenderer.removeListener("omp:event", listener);
  },
};

contextBridge.exposeInMainWorld("omp", api);
