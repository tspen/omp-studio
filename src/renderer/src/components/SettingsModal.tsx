import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Check,
  Cloud,
  ChevronRight,
  Clock,
  Cpu,
  Copy,
  Download,
  ExternalLink,
  Folder,
  FolderGit2,
  Gauge,
  KeyRound,
  MemoryStick,
  Package,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Wifi,
  Wrench,
  X,
} from "lucide-react";
import type { ApprovalMode, AuditEntry, Automation, Environment, EnvVar, InstalledPlugin, McpServerInfo, ModelInfo, OmpConfigEntry, PluginPreview, E2BInfo, MaintenanceReport, PlacementResult, RelayInfo, RemoteInfo, RemoteTarget, SkillInfo, TargetUsage, ToolApproval, ToolInfo } from "../../../shared/types";
import { selectedNode, selectedThread, useApp } from "../store";
import { Badge, Button, Field, IconButton, Modal, Select, Spinner, Toggle, cx, formatCost, formatNumber, relativeTime, statusLabel, truncate } from "./Common";
import { ModelPicker } from "./ModelPicker";
import { playSound } from "../sounds";

const TABS = [
  { id: "general", label: "General", icon: <Settings2 size={15} /> },
  { id: "models", label: "Models", icon: <Sparkles size={15} /> },
  { id: "usage", label: "Usage", icon: <Gauge size={15} /> },
  { id: "tools", label: "Tools", icon: <Wrench size={15} /> },
  { id: "memory", label: "Memory", icon: <MemoryStick size={15} /> },
  { id: "environments", label: "Environment", icon: <Terminal size={15} /> },
  { id: "git", label: "Git", icon: <FolderGit2 size={15} /> },
  { id: "connectors", label: "Connectors", icon: <Plug size={15} /> },
  { id: "automations", label: "Automations", icon: <Clock size={15} /> },
  { id: "sandbox", label: "Sandbox", icon: <Shield size={15} /> },
  { id: "plugins", label: "Plugins", icon: <Package size={15} /> },
  { id: "remote", label: "Remote", icon: <Wifi size={15} /> },
  { id: "notifications", label: "Notifications", icon: <Bell size={15} /> },
  { id: "engine", label: "Engine", icon: <Cpu size={15} /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontal size={15} /> },
] as const;

export function SettingsModal() {
  const state = useApp();
  const tab = state.settingsTab;
  const node = selectedNode(state);
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && state.setOverlay("none")}>
      <div className="settings-modal" role="dialog" aria-modal="true">
        <aside className="settings-nav">
          <div className="settings-brand">
            <div className="settings-brand-icon"><Settings2 size={16} /></div>
            <div>
              <strong>Settings</strong>
              <span>{node?.name ?? "OMP Studio"}</span>
            </div>
          </div>
          <nav>
            {TABS.map((item) => (
              <button key={item.id} type="button" className={cx(tab === item.id && "active")} onClick={() => state.setSettingsTab(item.id)}>
                {item.icon}
                <span>{item.label}</span>
                <ChevronRight size={13} className="settings-chev" />
              </button>
            ))}
          </nav>
          <div className="settings-nav-foot">
            <span>{state.engine?.version ? `OMP ${state.engine.version}` : "OMP not detected"}</span>
            <span>{state.models.length} models</span>
          </div>
        </aside>
        <section className="settings-content">
          <header className="settings-head">
            <div>
              <h2>{TABS.find((item) => item.id === tab)?.label}</h2>
              <p>{settingsBlurb(tab)}</p>
            </div>
            <IconButton icon={<X size={17} />} label="Close settings" onClick={() => state.setOverlay("none")} />
          </header>
          <div className="settings-scroll">
            {tab === "general" ? <GeneralTab /> : null}
            {tab === "models" ? <ModelsTab /> : null}
            {tab === "usage" ? <UsageTab /> : null}
            {tab === "tools" ? <ToolsTab /> : null}
            {tab === "memory" ? <MemoryTab /> : null}
            {tab === "environments" ? <EnvironmentsTab /> : null}
            {tab === "git" ? <GitTab /> : null}
            {tab === "connectors" ? <ConnectorsTab /> : null}
            {tab === "automations" ? <AutomationsTab /> : null}
            {tab === "sandbox" ? <SandboxTab /> : null}
            {tab === "plugins" ? <PluginsTab /> : null}
            {tab === "remote" ? <RemoteTab /> : null}
            {tab === "notifications" ? <NotificationsTab /> : null}
            {tab === "engine" ? <EngineTab /> : null}
            {tab === "advanced" ? <AdvancedTab /> : null}
          </div>
        </section>
      </div>
    </div>
  );
}

function settingsBlurb(tab: string): string {
  switch (tab) {
    case "general":
      return "Tree behavior, this node, and the app shell.";
    case "models":
      return "Explicit model and reasoning defaults for every level. Defaults use Artificial Analysis agentic value within sane cost caps.";
    case "usage":
      return "Provider windows, token/cost totals, budgets and auto-resume behavior.";
    case "tools":
      return "Enable OMP tools and decide how they are approved. Host tree tools are always available to orchestrators.";
    case "memory":
      return "Memory at this level. Orchestrators write here when they decide something is durable.";
    case "environments":
      return "Local execution profiles: env vars, setup scripts, shell, git policy and approval mode.";
    case "git":
      return "Default isolation and integration policy for project threads.";
    case "connectors":
      return "Tokens for GitHub, Cloudflare, Slack, Linear and Figma, plus one-click Cloudflare MCP.";
    case "automations":
      return "Scheduled instructions that spawn a fresh worker thread and report into your queue.";
    case "sandbox":
      return "Command denylist, path scope, network policy and the audit trail.";
    case "plugins":
      return "Install Claude Code-style plugin folders from Git or disk. Skills and MCP servers are installed; hooks are not executed.";
    case "remote":
      return "Control this machine from your phone or another PC over Tailscale or your own network. Token-protected, no public exposure.";
    case "notifications":
      return "Windows toasts, tray badge, and which events are worth interrupting you.";
    case "engine":
      return "The bundled OMP runtime, its version, and updates.";
    case "advanced":
      return "The full OMP config surface, generated from omp config list.";
    default:
      return "";
  }
}

function Section({ title, subtitle, children, right }: { title: string; subtitle?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="setting-section">
      <div className="setting-section-head">
        <div>
          <h3>{title}</h3>
          {subtitle ? <p>{subtitle}</p> : null}
        </div>
        {right}
      </div>
      <div className="setting-section-body">{children}</div>
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div className="setting-row-text">
        <strong>{label}</strong>
        {hint ? <span>{hint}</span> : null}
      </div>
      <div className="setting-row-control">{children}</div>
    </div>
  );
}

function GeneralTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const [name, setName] = useState(node?.name ?? "");
  const [path, setPath] = useState(node?.path ?? "");
  useEffect(() => { setName(node?.name ?? ""); setPath(node?.path ?? ""); }, [node?.id]);
  if (!settings || !node) return null;
  const update = (patch: any) => state.updateSettings({ settings: patch });
  return (
    <>
      <Section title="Appearance & behavior" subtitle="These settings apply to the whole cockpit.">
        <Row label="Theme" hint="Light is the default; dark is available for low-light work.">
          <Select value={settings.theme} onChange={(value) => update({ theme: value })}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
            <option value="system">System</option>
          </Select>
        </Row>
        <Row label="Workspace root" hint="New projects and groups are created as folders named after them here. Existing nodes keep their paths.">
          <div className="inline-actions">
            <input value={settings.workspaceRoot ?? ""} onChange={(event) => update({ workspaceRoot: event.target.value })} placeholder="C:\\Users\\you\\code" />
            <Button size="sm" variant="soft" onClick={async () => { const picked = await window.omp.pickDirectory(); if (picked) update({ workspaceRoot: picked }); }}><Folder size={13} /> Browse</Button>
          </div>
        </Row>
        <Row label="Default tool approval" hint="YOLO auto-approves every tool call, including shell and destructive commands. Applies to new nodes and sessions; change one node from the chat toolbar.">
          <div className="inline-actions">
            <Select value={settings.defaultApprovalMode ?? "yolo"} onChange={(value) => update({ defaultApprovalMode: value as ApprovalMode })}>
              <option value="yolo">YOLO · approve all</option>
              <option value="write">Auto-approve writes</option>
              <option value="always-ask">Always ask</option>
            </Select>
            <Button size="sm" variant="soft" onClick={async () => {
              const mode = (settings.defaultApprovalMode ?? "yolo") as ApprovalMode;
              for (const item of state.snapshot?.nodes ?? []) await window.omp.setNodeApproval(item.id, mode);
              await state.refresh();
            }}>Apply to all</Button>
          </div>
        </Row>
        <Row label="Auto-name threads" hint="Uses the cheap naming model to name threads and refresh long-running worker titles every few turns.">
          <Toggle checked={settings.autoName} onChange={(value) => update({ autoName: value })} />
        </Row>
        <Row label="Report upward automatically" hint="Each completed thread sends a compact result to its parent orchestrator.">
          <Toggle checked={settings.autoReport} onChange={(value) => update({ autoReport: value })} />
        </Row>
        <Row label="Wake parent on report" hint="If the parent is parked, a child report starts it. Disable to queue reports silently.">
          <Toggle checked={settings.autoWakeParent} onChange={(value) => update({ autoWakeParent: value })} />
        </Row>
        <Row label="Tree summary interval" hint="Minutes between a roll-up of running, waiting and failed threads. 0 disables summaries.">
          <input className="num-input" type="number" min={0} value={settings.digestIntervalMin} onChange={(event) => update({ digestIntervalMin: Number(event.target.value) })} />
        </Row>
        <Row label="Status check interval" hint="Minutes between Mission Control status requests to child orchestrators. 0 disables them.">
          <input className="num-input" type="number" min={0} value={settings.statusCheckIntervalMin ?? 15} onChange={(event) => update({ statusCheckIntervalMin: Number(event.target.value) })} />
        </Row>
        <Row label="Max concurrent OMP sessions" hint="Idle sessions are parked to stay under this cap.">
          <input className="num-input" type="number" min={1} max={32} value={settings.maxConcurrentThreads} onChange={(event) => update({ maxConcurrentThreads: Number(event.target.value) })} />
        </Row>
        <Row label="Auto-compact context" hint="OMP summarizes older history as the context window fills, including mid-turn. Applies to running sessions immediately.">
          <Toggle checked={settings.contextCompaction !== false} onChange={(value) => update({ contextCompaction: value })} />
        </Row>
        <Row label="Background compact idle sessions" hint="When a session has been idle for a couple of minutes and its context is above the threshold, OMP summarizes it in the background. Sessions are never stopped and only one compacts at a time.">
          <Toggle checked={settings.idleCompaction !== false} onChange={(value) => update({ idleCompaction: value })} />
        </Row>
        <Row label="Idle compaction threshold" hint="Percent of the context window that triggers background compaction.">
          <input className="num-input" type="number" min={30} max={95} step={5} disabled={settings.idleCompaction === false} value={settings.idleCompactionThreshold ?? 60} onChange={(event) => update({ idleCompactionThreshold: Number(event.target.value) })} />
        </Row>
        <Row label="Terminal shell" hint="Shell used by the persistent Terminal. Blank uses PowerShell on Windows and $SHELL elsewhere.">
          <input value={settings.terminalShell ?? ""} onChange={(event) => update({ terminalShell: event.target.value })} placeholder="powershell.exe" />
        </Row>
        <Row label="Auto-open preview URLs" hint="When a terminal prints a localhost URL, open it in the in-app Browser automatically.">
          <Toggle checked={settings.previewAutoOpen !== false} onChange={(value) => update({ previewAutoOpen: value })} />
        </Row>
        <Row label="Advisor runtime" hint="Passively reviews each turn and injects notes. More tokens, more scrutiny.">
          <Toggle checked={settings.advisor} onChange={(value) => update({ advisor: value })} />
        </Row>
        <Row label="Show thinking blocks" hint="Display model reasoning inline.">
          <Toggle checked={settings.ui.showThinking} onChange={(value) => update({ ui: { ...settings.ui, showThinking: value } })} />
        </Row>
        <Row label="Interface sounds" hint="Quiet chimes when you send, when a thread completes or asks for input, and when a turn fails.">
          <div className="inline-actions">
            <Toggle checked={settings.ui.sounds !== false} onChange={(value) => update({ ui: { ...settings.ui, sounds: value } })} />
            <input
              className="sound-volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              disabled={settings.ui.sounds === false}
              value={settings.ui.soundVolume ?? 0.25}
              onChange={(event) => update({ ui: { ...settings.ui, soundVolume: Number(event.target.value) } })}
            />
            <Button size="sm" variant="ghost" disabled={settings.ui.sounds === false} onClick={() => playSound("complete", { enabled: true, volume: settings.ui.soundVolume ?? 0.25 })}><Play size={12} /> Test</Button>
          </div>
        </Row>
        <Row label="Setup wizard" hint="Re-run provider connection and model selection.">
          <Button size="sm" variant="soft" onClick={() => void state.updateSettings({ settings: { onboardingCompleted: false } })}>Run setup again</Button>
        </Row>
      </Section>

      <Section title="This node" subtitle="Applies to the selected project or group." right={<div className="inline-actions"><Badge tone={node.type === "root" ? "accent" : node.type === "group" ? "blue" : "green"}>{node.type}</Badge><Button size="sm" variant="soft" disabled={!name.trim()} onClick={() => void window.omp.updateNode(node.id, { name, path }).then(() => state.refresh())}><Save size={13} /> Save node</Button></div>}>
        <Row label="Name">
          <div className="inline-actions">
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </div>
        </Row>
        <Row label="Path" hint="Projects use this repo path; groups use a workspace directory.">
          <div className="inline-actions">
            <input value={path} onChange={(event) => setPath(event.target.value)} />
            <Button size="sm" variant="soft" onClick={async () => { const picked = await window.omp.pickDirectory(); if (picked) setPath(picked); }}><Folder size={13} /> Browse</Button>
          </div>
        </Row>
        {node.type !== "root" ? (
        <Row label="Parent" hint="Move this node under another group or the root. Existing child nodes move with it.">
          <Select value={node.parentId ?? ""} onChange={(value) => void window.omp.updateNode(node.id, { parentId: value || null }).then(() => state.refresh())}>
            {(state.snapshot?.nodes ?? []).filter((candidate) => candidate.type !== "project" && candidate.id !== node.id).map((candidate) => (
              <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
            ))}
          </Select>
        </Row>
        ) : null}
        <Row label="Orchestrator model">
          <span className="mono muted">{state.models.find((model) => model.selector === node.model)?.name ?? node.model}</span>
        </Row>
        <Row label="Git isolation">
          <Select value={node.gitMode} onChange={(value) => void window.omp.updateNode(node.id, { gitMode: value as any }).then(() => state.refresh())}>
            <option value="auto">Auto (orchestrator decides)</option>
            <option value="shared">Shared checkout</option>
            <option value="branch">Branch per worker</option>
            <option value="worktree">Worktree per worker</option>
          </Select>
        </Row>
        <Row label="Tool approval">
          <Select value={node.approvalMode} onChange={(value) => void window.omp.updateNode(node.id, { approvalMode: value as any }).then(() => state.refresh())}>
            <option value="always-ask">Always ask</option>
            <option value="write">Auto-approve writes</option>
            <option value="yolo">Yolo</option>
          </Select>
        </Row>
        <Row label="Node budget (USD)" hint="Overrides the app budget for this subtree. 0 uses the app budget.">
          <input className="num-input" type="number" min={0} step={1} value={node.budgetUsd ?? ""} onChange={(event) => void window.omp.updateNode(node.id, { budgetUsd: event.target.value ? Number(event.target.value) : undefined }).then(() => state.refresh())} />
        </Row>
        <Row label="Mute this node" hint="Suppresses toasts, not the in-app inbox.">
          <Toggle checked={node.muted} onChange={(value) => void window.omp.updateNode(node.id, { muted: value }).then(() => state.refresh())} />
        </Row>
        <Row label="Delete node" hint="Removes app state and child threads. Repository files and branches are left in place.">
          <Button size="sm" variant="danger" disabled={node.type === "root"} onClick={async () => {
            if (!confirm(`Delete ${node.name} and its child threads? Files stay on disk.`)) return;
            await window.omp.deleteNode(node.id);
            await state.refresh();
            await state.selectRoot();
            state.setOverlay("none");
          }}><Trash2 size={13} /> Delete</Button>
        </Row>
        {thread ? (
          <Row label="Current thread">
            <span className="muted">{thread.title} · {statusLabel(thread.status)}</span>
          </Row>
        ) : null}
      </Section>
    </>
  );
}

function ModelsTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const [pick, setPick] = useState<string | null>(null);
  const roles = [
    { key: "root", label: "Root orchestrator", hint: "Above all projects. Best global reasoning." },
    { key: "group", label: "Group orchestrator", hint: "Coordinates a group of projects." },
    { key: "project", label: "Project orchestrator", hint: "Owns a repository and implementation." },
    { key: "worker", label: "Thread / subagent", hint: "Default for spawned worker threads." },
    { key: "naming", label: "Naming", hint: "Cheap model for titles and auto-names." },
    { key: "memory", label: "Memory curator", hint: "Extracts durable memory from completed work." },
  ] as const;
  if (!settings) return null;
  const aaCount = state.models.filter((model) => model.aa?.intelligence != null).length;
  return (
    <>
      <Section title="Role defaults" subtitle="Every level can override this. New threads inherit the role default, then can switch independently." right={<Button size="sm" variant="soft" onClick={() => void state.resetModelDefaults()}><Sparkles size={13} /> Reset to recommended</Button>}>
        {roles.map((role) => {
          const selector = (settings.models as any)[role.key] as string;
          const model = state.models.find((item) => item.selector === selector);
          return (
            <div key={role.key} className="role-row">
              <div className="role-copy">
                <strong>{role.label}</strong>
                <span>{role.hint}</span>
                <div className="role-model">
                  <Sparkles size={13} />
                  <span>{model?.name ?? (selector || "Not set")}</span>
                  {model ? <Badge tone={model.quality >= 80 ? "green" : "blue"}>{model.aa?.agentic != null ? `AG ${model.aa.agentic.toFixed(0)}` : model.aa?.intelligence != null ? `AA ${model.quality.toFixed(0)}` : `Q ${model.quality.toFixed(0)}`}</Badge> : null}
                  {model?.aa?.value != null ? <Badge tone="purple">V {model.aa.value.toFixed(1)}</Badge> : null}
                  {model ? <span className="muted">{model.included ? `included · ref ${formatCost(model.cost.input)}/${formatCost(model.cost.output)} · ${formatNumber(model.contextWindow)} ctx` : `${formatCost(model.cost.input)}/${formatCost(model.cost.output)} · ${formatNumber(model.contextWindow)} ctx`}</span> : null}
                  {model && role.key !== "naming" && role.key !== "memory" ? (
                    <Select
                      value={(settings.models as any)[`${role.key}Effort`] ?? "high"}
                      onChange={(value) => state.updateSettings({ settings: { models: { ...settings.models, [`${role.key}Effort`]: value } as any } })}
                    >
                      {["off", ...(model.thinking ?? [])].filter((item, index, list) => list.indexOf(item) === index).map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                    </Select>
                  ) : null}
                </div>
              </div>
              <Button size="sm" variant="soft" onClick={() => setPick(pick === role.key ? null : role.key)}>Change</Button>
            </div>
          );
        })}
      </Section>
      {pick ? (
        <div className="settings-model-picker">
          <ModelPicker
            models={state.models}
            value={(settings.models as any)[pick] ?? ""}
            role={pick as any}
            onSelect={async (selector) => {
              await state.setModelDefault(pick, selector);
              setPick(null);
            }}
            onClose={() => setPick(null)}
          />
        </div>
      ) : null}
      <Section title="Artificial Analysis" subtitle="Independent benchmark scores used to order models and choose sane defaults.">
        <Row label="Catalog" hint={`${state.models.length} models available through OMP. ${aaCount} have AA scores.`}>
          <Button size="sm" variant="soft" onClick={() => void state.refreshModels()}><RefreshCw size={13} /> Refresh OMP catalog</Button>
        </Row>
        <Row label="AA data" hint={settings.models.lastAAUpdate ? `Last updated ${new Date(settings.models.lastAAUpdate).toLocaleString()} · source ${settings.models.aaSource ?? "unknown"}` : "Not fetched yet. The public leaderboard is fetched daily."}>
          <Button size="sm" variant="primary" onClick={() => void state.refreshAA()}><Download size={13} /> Refresh now</Button>
        </Row>
        <Row label="Auto-update daily" hint="Refreshes the AA leaderboard every 24 hours.">
          <Toggle checked={settings.models.autoUpdateAA} onChange={(value) => state.updateSettings({ settings: { models: { ...settings.models, autoUpdateAA: value } } })} />
        </Row>
        <div className="aa-note">Defaults rank by AA agentic score (terminal-bench, τ²-bench, IFBench, long-context) divided by blended cost. Batch routes, free routers, and models above $15/M output are excluded from auto-defaults. Data and pricing are attributed to artificialanalysis.ai; unmatched models use a local estimate labelled Q.</div>
      </Section>
    </>
  );
}

function UsageTab() {
  const state = useApp();
  const usage = state.snapshot?.usage;
  const settings = state.snapshot?.settings;
  useEffect(() => { if (!usage?.generatedAt) void state.refreshUsage(); }, []);
  if (!usage || !settings) return null;
  const nodes = [...(state.snapshot?.nodes ?? [])]
    .map((node) => ({ node, stat: usage.perNode[node.id] }))
    .filter((item) => item.stat)
    .sort((a, b) => (b.stat?.cost ?? 0) - (a.stat?.cost ?? 0))
    .slice(0, 12);
  return (
    <>
      <Section title="Totals" subtitle="Accumulated across all threads in this app." right={<Button size="sm" variant="soft" onClick={() => void state.refreshUsage()}><RefreshCw size={13} /> Refresh</Button>}>
        <Row label="Tokens"><strong>{formatNumber(usage.totalTokens)}</strong></Row>
        <Row label="Metered spend"><strong>{formatCost(usage.meteredCost ?? usage.totalCost)}</strong></Row>
        <Row label="Included reference value" hint="Token value at reference prices; not billed on subscription plans."><strong>{formatCost(usage.referenceCost ?? 0)}</strong></Row>
        <Row label="Budget" hint="Optional budget in USD for the whole app.">
          <input className="num-input" type="number" min={0} step={1} value={settings.usage.budgetUsd ?? ""} onChange={(event) => state.updateSettings({ settings: { usage: { ...settings.usage, budgetUsd: event.target.value ? Number(event.target.value) : undefined } } })} />
        </Row>
        <Row label="At budget" hint="Warn once per hour, or block new prompts and threads until the budget is raised.">
          <Select value={settings.usage.budgetAction ?? "warn"} onChange={(value) => state.updateSettings({ settings: { usage: { ...settings.usage, budgetAction: value as "warn" | "pause" } } })}>
            <option value="warn">Warn only</option>
            <option value="pause">Pause new work</option>
          </Select>
        </Row>
        <Row label="Auto-continue on usage reset" hint="If a thread fails on a usage limit, retry after the reset window with a continuation instruction.">
          <Toggle checked={settings.usage.autoContinueOnReset} onChange={(value) => state.updateSettings({ settings: { usage: { ...settings.usage, autoContinueOnReset: value } } })} />
        </Row>
      </Section>
      <Section title="Provider windows" subtitle="Read from `omp usage --json`.">
        {usage.providers.length ? usage.providers.map((provider) => {
          const windows = ((provider.metadata?.limits ?? []) as Array<{ id?: string; label?: string; used?: number; limit?: number; remaining?: number; unit?: string; status?: string; resetsAt?: number }>);
          return (
          <div key={`${provider.provider}-${provider.label}`} className="provider-row">
            <div>
              <strong>{provider.provider}</strong>
              <span>{provider.label} · {provider.status ?? "ok"}</span>
            </div>
            <div className="provider-amount">
              {windows.length ? windows.map((window) => (
                <span key={window.id ?? window.label}>{window.label ?? "window"}: {window.used ?? 0}% used{window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleDateString()}` : ""}</span>
              )) : provider.limit != null ? <strong>{provider.remaining ?? "?"} / {provider.limit} {provider.unit ?? ""}</strong> : <strong>{provider.status ?? "ok"}</strong>}
            </div>
          </div>
          );
        }) : <p className="muted">No provider reports. Authenticate a provider and refresh.</p>}
      </Section>
      <Section title="Cost by node" subtitle="Where the tree is spending.">
        {nodes.map(({ node, stat }) => (
          <div key={node.id} className="provider-row">
            <div><strong>{node.name}</strong><span>{node.type} · {stat?.threads ?? 0} threads</span></div>
            <div className="provider-amount"><strong>{formatCost(stat?.cost ?? 0)}</strong><span>{formatNumber(stat?.tokens ?? 0)} tokens{stat?.referenceCost ? ` · ${formatCost(stat.referenceCost)} ref` : ""}</span></div>
          </div>
        ))}
        {!nodes.length ? <p className="muted">No usage recorded yet.</p> : null}
      </Section>
    </>
  );
}

function ToolsTab() {
  const state = useApp();
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [mcps, setMcps] = useState<McpServerInfo[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [skillForm, setSkillForm] = useState<{ name: string; description: string; body: string } | null>(null);
  const [skillEdit, setSkillEdit] = useState<{ path: string; content: string } | null>(null);
  const refreshSkills = async () => setSkills(await window.omp.listSkills());
  useEffect(() => {
    void Promise.all([window.omp.listTools(), window.omp.listSkills(), window.omp.listMcpServers()])
      .then(([toolList, skillList, mcpList]) => { setTools(toolList); setSkills(skillList); setMcps(mcpList); })
      .finally(() => setLoading(false));
  }, []);
  const filtered = tools.filter((tool) => !query || tool.name.toLowerCase().includes(query.toLowerCase()) || tool.group.toLowerCase().includes(query.toLowerCase()));
  const groups = [...new Set(filtered.map((tool) => tool.group))];
  const refresh = async () => setTools(await window.omp.listTools());
  if (loading) return <div className="settings-loading"><Spinner /> Loading tool surface…</div>;
  return (
    <>
      <Section title="OMP tools" subtitle="Writes OMP's own tool settings. Changes apply to newly started sessions." right={<input className="settings-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter tools…" />}>
        {groups.map((group) => (
          <div key={group} className="tool-group">
            <div className="tool-group-label">{group}</div>
            {filtered.filter((tool) => tool.group === group).map((tool) => (
              <div key={tool.name} className="tool-row">
                <div className="tool-row-copy">
                  <strong>{tool.label || tool.name}</strong>
                  <span>{tool.description}</span>
                  <div className="tool-row-tags">
                    <Badge tone={tool.source === "host" ? "purple" : "neutral"}>{tool.source}</Badge>
                    <span className="mono">{tool.name}</span>
                  </div>
                </div>
                <div className="tool-row-controls">
                  {tool.source === "host" ? (
                    <Badge tone="green">always on</Badge>
                  ) : (
                    <>
                      <Select value={tool.approval} onChange={async (value) => { await window.omp.setTool(tool.name, tool.enabled, value as ToolApproval); await refresh(); }}>
                        <option value="allow">allow</option>
                        <option value="prompt">prompt</option>
                        <option value="deny">deny</option>
                      </Select>
                      <Toggle checked={tool.enabled} onChange={async (value) => { await window.omp.setTool(tool.name, value, tool.approval); await refresh(); }} />
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        ))}
      </Section>
      <Section title="Skills" subtitle="Discovered from OMP and Claude skill directories. OMP skills are editable here." right={<Button size="sm" variant="soft" onClick={() => setSkillForm({ name: "", description: "", body: "" })}><Plus size={12} /> New skill</Button>}>
        {skillForm ? (
          <div className="skill-form">
            <input value={skillForm.name} onChange={(event) => setSkillForm({ ...skillForm, name: event.target.value })} placeholder="Skill name" />
            <input value={skillForm.description} onChange={(event) => setSkillForm({ ...skillForm, description: event.target.value })} placeholder="Short description" />
            <textarea value={skillForm.body} onChange={(event) => setSkillForm({ ...skillForm, body: event.target.value })} placeholder="Instructions the agent should follow when this skill applies." />
            <div className="inline-actions">
              <Button size="sm" variant="primary" disabled={!skillForm.name.trim()} onClick={async () => {
                await window.omp.createSkill(skillForm);
                setSkillForm(null);
                await refreshSkills();
                state.pushToast({ kind: "success", title: "Skill created" });
              }}><Save size={12} /> Create</Button>
              <Button size="sm" variant="ghost" onClick={() => setSkillForm(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {skillEdit ? (
          <div className="skill-form">
            <span className="mono">{skillEdit.path}</span>
            <textarea className="skill-editor" value={skillEdit.content} onChange={(event) => setSkillEdit({ ...skillEdit, content: event.target.value })} />
            <div className="inline-actions">
              <Button size="sm" variant="primary" onClick={async () => {
                await window.omp.saveSkill(skillEdit.path, skillEdit.content);
                setSkillEdit(null);
                await refreshSkills();
                state.pushToast({ kind: "success", title: "Skill saved" });
              }}><Save size={12} /> Save</Button>
              <Button size="sm" variant="ghost" onClick={() => setSkillEdit(null)}>Cancel</Button>
            </div>
          </div>
        ) : null}
        {skills.length ? skills.map((skill) => (
          <div key={`${skill.source}-${skill.path}`} className="simple-row">
            <div><strong>{skill.name}</strong><span>{skill.description || skill.path}</span></div>
            <div className="inline-actions">
              <Badge tone="blue">{skill.source}</Badge>
              <Button size="sm" variant="ghost" onClick={async () => {
                const skillFile = await window.omp.readSkill(skill.path);
                setSkillEdit({ path: skill.path, content: skillFile.content });
              }}>Edit</Button>
              <IconButton icon={<Trash2 size={12} />} label="Delete skill" onClick={async () => {
                if (!confirm(`Delete skill ${skill.name}?`)) return;
                await window.omp.deleteSkill(skill.path);
                await refreshSkills();
              }} />
            </div>
          </div>
        )) : <p className="muted">No skills discovered.</p>}
      </Section>
      <Section title="MCP servers" subtitle="Project and user MCP configuration.">
        {mcps.length ? mcps.map((mcp) => (
          <div key={mcp.name} className="simple-row"><div><strong>{mcp.name}</strong><span>{mcp.command || mcp.url || mcp.source}</span></div><Badge tone={mcp.enabled ? "green" : "neutral"}>{mcp.enabled ? "enabled" : "disabled"}</Badge></div>
        )) : <p className="muted">No MCP servers configured.</p>}
      </Section>
    </>
  );
}

function MemoryTab() {
  const state = useApp();
  const node = selectedNode(state);
  const [text, setText] = useState("");
  const [tags, setTags] = useState("");
  useEffect(() => { if (node) void state.loadMemory(node.id); }, [node?.id]);
  if (!node) return null;
  return (
    <>
      <Section title="Memory at this level" subtitle="Durable facts and decisions. Orchestrators call tree_memory_write; you can edit or remove anything." right={<Badge tone="purple">{state.memory.length} entries</Badge>}>
        <div className="memory-add">
          <textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="A decision, constraint or lesson worth remembering…" />
          <div className="memory-add-row">
            <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="tags, comma separated" />
            <Button size="sm" variant="primary" disabled={!text.trim()} onClick={async () => { await state.addMemory(text, tags.split(",").map((tag) => tag.trim()).filter(Boolean)); setText(""); setTags(""); }}><Plus size={13} /> Remember</Button>
          </div>
        </div>
        <div className="memory-list">
          {state.memory.map((entry) => (
            <div key={entry.id} className="memory-entry">
              <div className="memory-entry-top">
                <Badge tone={entry.source === "auto" ? "amber" : entry.source === "user" ? "blue" : "purple"}>{entry.source}</Badge>
                <span className="memory-importance">importance {entry.importance.toFixed(2)}</span>
                {entry.tags.map((tag) => <Badge key={tag} tone="neutral">{tag}</Badge>)}
                <IconButton icon={<Trash2 size={13} />} label="Delete" onClick={() => void state.deleteMemory(entry.id)} />
              </div>
              <p>{entry.text}</p>
              <span className="memory-meta">{new Date(entry.updatedAt).toLocaleString()}</span>
            </div>
          ))}
          {!state.memory.length ? <p className="muted">No memories at this level yet. The orchestrator decides what is worth keeping.</p> : null}
        </div>
      </Section>
      <Section title="Auto memory" subtitle="A safety net for completed work; orchestrators can still write their own entries.">
        <Row label="Auto-capture thread outcomes" hint="Stores a compact, low-importance summary when a thread finishes.">
          <Toggle checked={state.snapshot?.settings.memory.autoCapture ?? true} onChange={(value) => state.updateSettings({ settings: { memory: { ...state.snapshot!.settings.memory, autoCapture: value } } })} />
        </Row>
        <Row label="Inject token budget" hint="Approximate cap for memory guidance in each session prompt.">
          <input className="num-input" type="number" min={500} step={500} value={state.snapshot?.settings.memory.injectTokenLimit ?? 3000} onChange={(event) => state.updateSettings({ settings: { memory: { ...state.snapshot!.settings.memory, injectTokenLimit: Number(event.target.value) } } })} />
        </Row>
        <Row label="Maximum entries" hint="Oldest low-importance entries are pruned beyond this.">
          <input className="num-input" type="number" min={100} value={state.snapshot?.settings.memory.maxEntries ?? 2000} onChange={(event) => state.updateSettings({ settings: { memory: { ...state.snapshot!.settings.memory, maxEntries: Number(event.target.value) } } })} />
        </Row>
        <Row label="Consolidate" hint="Merge near-duplicate entries at this level.">
          <Button size="sm" variant="soft" onClick={async () => { await window.omp.consolidateMemory(node.id); await state.loadMemory(node.id); }}>Consolidate</Button>
        </Row>
      </Section>
    </>
  );
}

function EnvironmentsTab() {
  const state = useApp();
  const node = selectedNode(state);
  const envs = state.snapshot?.environments ?? [];
  const [selected, setSelected] = useState<string | null>(envs[0]?.id ?? null);
  const [draft, setDraft] = useState<Environment | null>(null);
  useEffect(() => {
    const env = envs.find((item) => item.id === selected) ?? envs[0];
    setDraft(env ? structuredClone(env) : null);
  }, [selected, envs.length]);
  if (!node) return null;
  const assign = envs.find((env) => env.id === node.environmentId);
  return (
    <>
      <Section title="Environment profiles" subtitle="Local only for now: env vars, setup scripts, shell and git policy." right={<Button size="sm" variant="soft" onClick={() => {
        const now = Date.now();
        const env: Environment = { id: `env_${Math.random().toString(36).slice(2, 10)}`, name: "New environment", envVars: [], setupCommands: [], teardownCommands: [], inheritEnv: true, gitMode: "auto", approvalMode: "write", createdAt: now, updatedAt: now };
        setSelected(env.id);
        setDraft(env);
      }}><Plus size={13} /> New</Button>}>
        <Row label="Environment for this node" hint={assign ? `Inherited: ${assign.name}` : "Falls back to the first environment."}>
          <Select value={node.environmentId ?? ""} onChange={(value) => void window.omp.updateNode(node.id, { environmentId: value || undefined }).then(() => state.refresh())}>
            <option value="">Inherit / default</option>
            {envs.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
          </Select>
        </Row>
        <div className="env-list">
          {envs.map((env) => (
            <button key={env.id} type="button" className={cx("env-row", selected === env.id && "active")} onClick={() => setSelected(env.id)}>
              <Terminal size={14} />
              <span>{env.name}</span>
              <span className="muted">{env.envVars.length} vars · {env.setupCommands.length} setup</span>
            </button>
          ))}
        </div>
      </Section>
      {draft ? (
        <Section title={draft.name || "Environment"} subtitle="Secrets are stored with Windows DPAPI via Electron safeStorage." right={<div className="inline-actions">
          <Button size="sm" variant="soft" onClick={async () => { const result = await window.omp.testEnvironment(draft.id); state.pushToast({ kind: result.ok ? "success" : "error", title: result.ok ? "Environment ready" : "Environment failed", body: result.output.slice(0, 500) }); }}>Test</Button>
          <Button size="sm" variant="primary" onClick={async () => { await window.omp.saveEnvironment(draft); await state.refresh(); state.pushToast({ kind: "success", title: "Environment saved", body: draft.name }); }}><Save size={13} /> Save</Button>
          <Button size="sm" variant="danger" onClick={async () => { if (confirm(`Delete ${draft.name}?`)) { await window.omp.deleteEnvironment(draft.id); setSelected(null); await state.refresh(); } }}><Trash2 size={13} /></Button>
        </div>}>
          <Row label="Name"><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></Row>
          <Row label="Working directory" hint="Leave blank to use the project/thread directory.">
            <div className="inline-actions"><input value={draft.cwd ?? ""} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="Project directory" /><Button size="sm" variant="soft" onClick={async () => { const picked = await window.omp.pickDirectory(); if (picked) setDraft({ ...draft, cwd: picked }); }}><Folder size={13} /></Button></div>
          </Row>
          <Row label="Inherit process environment" hint="Start from the app's environment variables."><Toggle checked={draft.inheritEnv} onChange={(value) => setDraft({ ...draft, inheritEnv: value })} /></Row>
          <Row label="Shell" hint="Defaults to cmd.exe on Windows."><input value={draft.shell ?? ""} onChange={(event) => setDraft({ ...draft, shell: event.target.value })} placeholder="cmd.exe" /></Row>
          <Row label="Git policy">
            <Select value={draft.gitMode} onChange={(value) => setDraft({ ...draft, gitMode: value as any })}>
              <option value="auto">Auto</option><option value="shared">Shared</option><option value="branch">Branch</option><option value="worktree">Worktree</option>
            </Select>
          </Row>
          <Row label="Approval mode">
            <Select value={draft.approvalMode} onChange={(value) => setDraft({ ...draft, approvalMode: value as any })}>
              <option value="always-ask">Always ask</option><option value="write">Auto-approve writes</option><option value="yolo">Yolo</option>
            </Select>
          </Row>
          <div className="env-block">
            <div className="env-block-head"><strong>Environment variables</strong><Button size="sm" variant="soft" onClick={() => setDraft({ ...draft, envVars: [...draft.envVars, { key: "", value: "", secret: false }] })}><Plus size={12} /> Add</Button></div>
            {draft.envVars.map((item, index) => (
              <div key={index} className="env-var">
                <input value={item.key} onChange={(event) => replaceAt(draft, setDraft, "envVars", index, { ...item, key: event.target.value })} placeholder="KEY" />
                <input type={item.secret ? "password" : "text"} value={item.value} onChange={(event) => replaceAt(draft, setDraft, "envVars", index, { ...item, value: event.target.value })} placeholder={item.secret ? "stored secret" : "value"} />
                <label className="secret-check"><input type="checkbox" checked={item.secret} onChange={(event) => replaceAt(draft, setDraft, "envVars", index, { ...item, secret: event.target.checked })} /> secret</label>
                <IconButton icon={<Trash2 size={13} />} label="Remove" onClick={() => setDraft({ ...draft, envVars: draft.envVars.filter((_, i) => i !== index) })} />
              </div>
            ))}
            {!draft.envVars.length ? <p className="muted">No variables.</p> : null}
          </div>
          <div className="env-block">
            <div className="env-block-head"><strong>Setup commands</strong></div>
            <textarea className="code-input" value={draft.setupCommands.join("\n")} onChange={(event) => setDraft({ ...draft, setupCommands: event.target.value.split("\n") })} placeholder="npm install&#10;npm run build" />
          </div>
          <div className="env-block">
            <div className="env-block-head"><strong>Teardown commands</strong></div>
            <textarea className="code-input" value={draft.teardownCommands.join("\n")} onChange={(event) => setDraft({ ...draft, teardownCommands: event.target.value.split("\n") })} placeholder="docker compose down" />
          </div>
        </Section>
      ) : null}
    </>
  );
}

function GitTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  if (!settings) return null;
  return (
    <Section title="Git policy" subtitle="The orchestrator can override isolation per thread. These are the defaults.">
      <Row label="Default isolation" hint="Auto lets the project orchestrator choose; worktree gives each worker a branch and directory.">
        <Select value={settings.git.defaultMode} onChange={(value) => state.updateSettings({ settings: { git: { ...settings.git, defaultMode: value as any } } })}>
          <option value="auto">Auto (orchestrator decides)</option>
          <option value="shared">Shared checkout</option>
          <option value="branch">Branch per worker</option>
          <option value="worktree">Worktree per worker</option>
        </Select>
      </Row>
      <Row label="Branch prefix" hint="Worker branches are <prefix>/<slug>-<id>."><input value={settings.git.branchPrefix} onChange={(event) => state.updateSettings({ settings: { git: { ...settings.git, branchPrefix: event.target.value } } })} /></Row>
      <Row label="Automatically commit" hint="Off by default; workers leave diffs for the orchestrator."><Toggle checked={settings.git.autoCommit} onChange={(value) => state.updateSettings({ settings: { git: { ...settings.git, autoCommit: value } } })} /></Row>
      <Row label="Automatically merge" hint="Off by default. The orchestrator can merge a completed worker branch, but auto-merge is risky."><Toggle checked={settings.git.autoMerge} onChange={(value) => state.updateSettings({ settings: { git: { ...settings.git, autoMerge: value } } })} /></Row>
      <div className="aa-note">Worktrees live under the OMP Studio data directory, not inside the repository. Removing a thread does not delete its branch, so unmerged work is never silently lost.</div>
    </Section>
  );
}

function NotificationsTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  if (!settings) return null;
  const n = settings.notifications;
  const update = (patch: any) => state.updateSettings({ settings: { notifications: { ...n, ...patch } } });
  return (
    <>
      <Section title="Windows notifications" subtitle="Toasts and tray badge. In-app notifications are always stored.">
        <Row label="Enable notifications"><Toggle checked={n.enabled} onChange={(value) => update({ enabled: value })} /></Row>
        <Row label="Windows toast"><Toggle checked={n.toast} onChange={(value) => update({ toast: value })} /></Row>
        <Row label="Sound"><Toggle checked={n.sound} onChange={(value) => update({ sound: value })} /></Row>
        <Row label="Thread completed"><Toggle checked={n.onComplete} onChange={(value) => update({ onComplete: value })} /></Row>
        <Row label="Decision needed"><Toggle checked={n.onQuestion} onChange={(value) => update({ onQuestion: value })} /></Row>
        <Row label="Errors"><Toggle checked={n.onError} onChange={(value) => update({ onError: value })} /></Row>
        <Row label="Tree summaries"><Toggle checked={n.onDigest} onChange={(value) => update({ onDigest: value })} /></Row>
      </Section>
      <Section title="Muted nodes" subtitle="Muted nodes still appear in the inbox.">
        {(state.snapshot?.nodes ?? []).filter((node) => node.type !== "root").map((node) => (
          <Row key={node.id} label={node.name}>
            <Toggle checked={n.mutedNodeIds.includes(node.id)} onChange={(value) => update({ mutedNodeIds: value ? [...n.mutedNodeIds, node.id] : n.mutedNodeIds.filter((id) => id !== node.id) })} />
          </Row>
        ))}
      </Section>
    </>
  );
}

function EngineTab() {
  const state = useApp();
  const engine = state.engine;
  const settings = state.snapshot?.settings;
  return (
    <>
      <Section title="OMP runtime" subtitle="OMP Studio launches and supervises the real omp.exe. The installer bundles a Windows x64 build.">
        <Row label="Status"><Badge tone={engine?.found ? "green" : "red"}>{engine?.found ? "ready" : "not found"}</Badge></Row>
        <Row label="Version"><span className="mono">{engine?.version ?? "—"}</span></Row>
        <Row label="Path"><span className="mono muted">{engine?.path ?? "—"}</span></Row>
        <Row label="Source"><span>{engine?.source ?? "—"}</span></Row>
        <Row label="Custom engine path" hint="Optional. Restart after changing. Blank uses the bundled/installed engine.">
          <input defaultValue={settings?.enginePath ?? ""} onBlur={(event) => state.updateSettings({ settings: { enginePath: event.target.value } })} placeholder="C:\\path\\to\\omp.exe" />
        </Row>
        {engine?.downloading ? <Row label="Download"><div className="download-bar"><i style={{ width: `${engine.progress ?? 0}%` }} /><span>{engine.progress ?? 0}%</span></div></Row> : null}
        <Row label="Install / update" hint="Downloads the latest omp-windows-x64.exe from GitHub releases.">
          <Button size="sm" variant="primary" disabled={engine?.downloading} onClick={() => void window.omp.downloadEngine().then(() => state.refresh())}><Download size={13} /> Download OMP</Button>
        </Row>
        <Row label="Restart app" hint="Required after changing the engine or some global settings.">
          <Button size="sm" variant="soft" onClick={() => void window.omp.restartApp()}><RefreshCw size={13} /> Restart</Button>
        </Row>
        <Row label="Open config file" hint="The raw OMP config YAML is also editable from Advanced.">
          <Button size="sm" variant="soft" onClick={() => state.ompConfig?.path && void window.omp.openPath(state.ompConfig.path)}>Open config</Button>
        </Row>
      </Section>
      <Section title="OMP config" subtitle="The advanced tab exposes the full config surface.">
        <Row label="Config file"><span className="mono muted">{state.ompConfig?.path ?? "—"}</span></Row>
        <Row label="Entries"><span>{state.ompConfig?.entries.length ?? 0}</span></Row>
        <Row label="Refresh"><Button size="sm" variant="soft" onClick={() => void state.refreshConfig()}><RefreshCw size={13} /> Reload</Button></Row>
      </Section>
    </>
  );
}

function AdvancedTab() {
  const state = useApp();
  const config = state.ompConfig;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState("all");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  useEffect(() => { if (!config?.entries.length) void state.refreshConfig(); }, []);
  if (!config) return <div className="settings-loading"><Spinner /> Loading OMP config…</div>;
  const groups = [...new Set(config.entries.map((entry) => entry.group))].sort();
  const entries = config.entries.filter((entry) => (group === "all" || entry.group === group) && (!query || entry.key.toLowerCase().includes(query.toLowerCase()) || entry.description.toLowerCase().includes(query.toLowerCase())));
  return (
    <>
      <Section title="OMP configuration" subtitle={`Generated from omp config list · ${config.entries.length} settings. Changes are written to the real OMP config.`} right={<div className="inline-actions"><input className="settings-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search settings…" /><Button size="sm" variant="soft" onClick={() => void state.refreshConfig()}><RefreshCw size={13} /></Button></div>}>
        <div className="config-groups">
          <button type="button" className={cx(group === "all" && "active")} onClick={() => setGroup("all")}>all</button>
          {groups.map((item) => <button key={item} type="button" className={cx(group === item && "active")} onClick={() => setGroup(item)}>{item}</button>)}
        </div>
        <div className="config-list">
          {entries.slice(0, 160).map((entry) => (
            <ConfigRow key={entry.key} entry={entry} draft={drafts[entry.key]} setDraft={(value) => setDrafts({ ...drafts, [entry.key]: value })} onSave={async (value) => {
              await window.omp.setOmpConfig(entry.key, value);
              await state.refreshConfig();
            }} onReset={async () => { await window.omp.resetOmpConfig(entry.key); await state.refreshConfig(); }} />
          ))}
          {entries.length > 160 ? <p className="muted">Showing 160 of {entries.length}. Use search or a group filter.</p> : null}
        </div>
      </Section>
    </>
  );
}

function ConfigRow({ entry, draft, setDraft, onSave, onReset }: { entry: OmpConfigEntry; draft?: string; setDraft: (value: string) => void; onSave: (value: unknown) => Promise<void>; onReset: () => Promise<void> }) {
  const [value, setValue] = useState(draft ?? serialize(entry.value));
  useEffect(() => setValue(serialize(entry.value)), [entry.value]);
  const isComplex = entry.type === "array" || entry.type === "record" || entry.type === "unknown";
  return (
    <div className="config-row">
      <div className="config-row-copy">
        <strong>{entry.key}</strong>
        {entry.description ? <span>{entry.description}</span> : null}
      </div>
      <div className="config-row-control">
        {entry.type === "boolean" ? (
          <Toggle checked={!!entry.value} onChange={(next) => void onSave(next)} />
        ) : entry.type === "enum" ? (
          <input value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => value !== serialize(entry.value) && void onSave(value)} />
        ) : entry.type === "number" ? (
          <input className="num-input" type="number" value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => value !== serialize(entry.value) && void onSave(Number(value))} />
        ) : isComplex ? (
          <textarea className="config-json" value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => value !== serialize(entry.value) && void onSave(parseJson(value))} />
        ) : (
          <input value={value} onChange={(event) => setValue(event.target.value)} onBlur={() => value !== serialize(entry.value) && void onSave(value)} />
        )}
        <IconButton icon={<RefreshCw size={12} />} label="Reset" onClick={() => void onReset()} />
      </div>
    </div>
  );
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

function replaceAt<T extends keyof Environment>(draft: Environment, setDraft: (value: Environment) => void, key: T, index: number, value: any) {
  const list = [...(draft[key] as any[])];
  list[index] = value;
  setDraft({ ...draft, [key]: list });
}

function ConnectorsTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const [secrets, setSecrets] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const [mcps, setMcps] = useState<McpServerInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void window.omp.connectorSecrets().then(setSecrets);
    void window.omp.listMcpServers().then(setMcps);
  }, []);
  if (!settings) return null;
  const cf = settings.connectors?.cloudflare ?? { mcp: false };
  const update = (patch: any) => state.updateSettings({ settings: { connectors: { ...settings.connectors, ...patch } } });
  const save = async (key: string) => {
    const value = drafts[key] ?? "";
    const next = await window.omp.setConnectorSecret(key, value);
    setSecrets(next);
    setDrafts((items) => ({ ...items, [key]: "" }));
    state.pushToast({ kind: "success", title: "Credential saved", body: key });
  };
  const test = async (provider: string) => {
    setBusy(provider);
    try {
      const result = await window.omp.testConnector(provider);
      setResults((items) => ({ ...items, [provider]: `${result.ok ? "OK" : "Failed"}: ${result.output}` }));
    } finally {
      setBusy(null);
    }
  };
  const oauthFields = (provider: string, label: string) => {
    const current = (settings.connectors as any)?.[provider] ?? {};
    return (
      <>
        <Row label={`${label} OAuth client ID`} hint="Create an OAuth app with the provider and paste its client ID. Callback URL: http://127.0.0.1:43110/oauth/callback">
          <input value={current.clientId ?? ""} onChange={(event) => update({ [provider]: { ...current, clientId: event.target.value } })} placeholder="Client ID" />
        </Row>
        <Row label="OAuth client secret" hint="Encrypted locally with Windows safeStorage.">
          <div className="inline-actions">
            <input type="password" value={drafts[`oauth.${provider}.secret`] ?? ""} placeholder={secrets[`oauth.${provider}.secret`] ? "Saved (enter to replace)" : "Client secret"} onChange={(event) => setDrafts((items) => ({ ...items, [`oauth.${provider}.secret`]: event.target.value }))} />
            <Button size="sm" variant="soft" disabled={!drafts[`oauth.${provider}.secret`]} onClick={() => void save(`oauth.${provider}.secret`)}><Save size={12} /> Save</Button>
            <Button size="sm" variant="outline" disabled={busy === `oauth-${provider}`} onClick={async () => {
              setBusy(`oauth-${provider}`);
              try {
                const result = await window.omp.connectOAuth(provider);
                setResults((items) => ({ ...items, [provider]: `${result.ok ? "OK" : "Failed"}: ${result.output}` }));
                setSecrets(await window.omp.connectorSecrets());
              } catch (error) {
                setResults((items) => ({ ...items, [provider]: `Failed: ${String(error)}` }));
              } finally {
                setBusy(null);
              }
            }}>{busy === `oauth-${provider}` ? <Spinner /> : <ExternalLink size={12} />} Connect with OAuth</Button>
          </div>
        </Row>
      </>
    );
  };
  const credential = (provider: string, key: string, label: string, placeholder: string, hint: string) => (
    <Row label={label} hint={hint}>
      <div className="inline-actions">
        <input type="password" value={drafts[key] ?? ""} placeholder={secrets[key] ? "Saved (enter to replace)" : placeholder} onChange={(event) => setDrafts((items) => ({ ...items, [key]: event.target.value }))} />
        <Button size="sm" variant="soft" disabled={!drafts[key]} onClick={() => void save(key)}><Save size={12} /> Save</Button>
        <Button size="sm" variant="outline" disabled={busy === provider} onClick={() => void test(provider)}>{busy === provider ? <Spinner /> : <Check size={12} />} Test</Button>
      </div>
      {results[provider] ? <small className="connector-result">{results[provider]}</small> : null}
    </Row>
  );
  return (
    <>
      <Section title="Cloudflare" subtitle="Use the Cloudflare API MCP for account-wide work, and a token for Pages deployments from Sites." right={<Badge tone={cf.mcp ? "green" : "neutral"}>{cf.mcp ? "MCP added" : "MCP not added"}</Badge>}>
        <Row label="Cloudflare MCP" hint="Adds https://mcp.cloudflare.com/mcp to ~/.omp/agent/mcp.json. OMP prompts for Cloudflare OAuth on first use.">
          <div className="inline-actions">
            <Button size="sm" variant="primary" onClick={async () => {
              const result = await window.omp.addCloudflareMcp();
              setMcps(result.servers);
              state.pushToast({ kind: "success", title: "Cloudflare MCP added", body: result.path });
              await state.refresh();
            }}><Plus size={12} /> Add Cloudflare MCP</Button>
            <Button size="sm" variant="soft" onClick={async () => { setMcps(await window.omp.listMcpServers()); }}><RefreshCw size={12} /> Refresh</Button>
          </div>
        </Row>
        {mcps.filter((mcp) => /cloudflare/i.test(mcp.name)).map((mcp) => (
          <div key={mcp.name} className="simple-row"><div><strong>{mcp.name}</strong><span>{mcp.url || mcp.command}</span></div><Badge tone={mcp.enabled ? "green" : "neutral"}>{mcp.enabled ? "enabled" : "disabled"}</Badge></div>
        ))}
        {credential("cloudflare", "cloudflare.token", "API token", "Cloudflare API token", "Needs Pages:Edit and Account:Read. Used only for Sites deploys and the MCP fallback.")}
        <Row label="Account ID" hint="Cloudflare dashboard ? Workers & Pages ? Account ID.">
          <input value={cf.accountId ?? ""} onChange={(event) => update({ cloudflare: { ...cf, accountId: event.target.value } })} placeholder="023e105f..." />
        </Row>
        <Row label="Pages project" hint="Blank derives a project name from the site name.">
          <input value={cf.projectName ?? ""} onChange={(event) => update({ cloudflare: { ...cf, projectName: event.target.value } })} placeholder="my-site" />
        </Row>
        <Row label="Production branch" hint="Cloudflare Pages production branch used for deployments.">
          <input value={cf.branch ?? "main"} onChange={(event) => update({ cloudflare: { ...cf, branch: event.target.value } })} placeholder="main" />
        </Row>
      </Section>
      <Section title="GitHub" subtitle="Optional personal token. Without it, the app uses the GitHub CLI (gh) session.">
        {credential("github", "github.token", "Personal access token", "ghp_...", "Repo scope is enough for PRs, Pages and CI logs.")}
        {oauthFields("github", "GitHub")}
      </Section>
      <Section title="Slack" subtitle="OAuth bot token or incoming webhook for automation and CI summaries.">
        {oauthFields("slack", "Slack")}
        {credential("slack", "slack.webhook", "Webhook URL", "https://hooks.slack.com/...", "Messages are posted as OMP Studio.")}
      </Section>
      <Section title="Linear" subtitle="OAuth app or API key for issue creation and project context.">
        {oauthFields("linear", "Linear")}
        {credential("linear", "linear.token", "API key", "lin_api_...", "Read access is enough to start.")}
      </Section>
      <Section title="Figma" subtitle="OAuth app or personal access token for design context.">
        {oauthFields("figma", "Figma")}
        {credential("figma", "figma.token", "Personal access token", "figd_...", "Used by agents through the browser and connectors.")}
      </Section>
      <Section title="MCP servers" subtitle="Remote and local MCP servers discovered from ~/.omp/agent/mcp.json." right={<Button size="sm" variant="soft" onClick={async () => {
        const result = await window.omp.importAgentConfigs();
        setMcps(await window.omp.listMcpServers());
        state.pushToast({ kind: "success", title: "Imported agent configs", body: result.imported.length ? result.imported.join(", ") : "No MCP servers found to import." });
      }}><Download size={12} /> Import from Claude/Codex</Button>}>
        {mcps.length ? mcps.map((mcp) => (
          <div key={mcp.name} className="simple-row">
            <div><strong>{mcp.name}</strong><span>{mcp.url || mcp.command || mcp.source}</span></div>
            <div className="inline-actions">
              <Badge tone={mcp.enabled ? "green" : "neutral"}>{mcp.enabled ? "enabled" : "disabled"}</Badge>
              <IconButton icon={<Trash2 size={12} />} label="Remove MCP server" onClick={async () => { setMcps(await window.omp.removeMcpServer(mcp.name)); }} />
            </div>
          </div>
        )) : <p className="muted">No MCP servers configured.</p>}
      </Section>
    </>
  );
}

function AutomationsTab() {
  const state = useApp();
  const [items, setItems] = useState<Automation[]>([]);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [intervalMin, setIntervalMin] = useState(60);
  const [nodeId, setNodeId] = useState("");
  const projects = (state.snapshot?.nodes ?? []).filter((node) => node.type === "project");
  const load = async () => setItems(await window.omp.listAutomations());
  useEffect(() => {
    void load();
    if (!nodeId && projects[0]) setNodeId(projects[0].id);
  }, [projects.length]);
  const save = async () => {
    if (!name.trim() || !prompt.trim() || !nodeId) return;
    await window.omp.saveAutomation({ name, prompt, intervalMin, nodeId });
    setName("");
    setPrompt("");
    await load();
    state.pushToast({ kind: "success", title: "Automation saved" });
  };
  return (
    <>
      <Section title="New automation" subtitle="Each run creates a fresh worker thread under the selected project. It never reuses idle threads.">
        <Row label="Name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nightly dependency audit" /></Row>
        <Row label="Project">
          <Select value={nodeId} onChange={setNodeId}>
            {projects.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
          </Select>
        </Row>
        <Row label="Interval (minutes)" hint="Minimum 5 minutes."><input className="num-input" type="number" min={5} value={intervalMin} onChange={(event) => setIntervalMin(Number(event.target.value))} /></Row>
        <Row label="Instructions"><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Check dependencies for security updates, run tests, and report anything that needs a human." /></Row>
        <Button size="sm" variant="primary" disabled={!name.trim() || !prompt.trim() || !nodeId} onClick={() => void save()}><Plus size={13} /> Save automation</Button>
      </Section>
      <Section title="Scheduled jobs" subtitle="Results appear as threads under their project.">
        {items.map((item) => (
          <div key={item.id} className="automation-row">
            <div className="automation-main">
              <strong>{item.name}</strong>
              <span>every {item.intervalMin} min � {state.snapshot?.nodes.find((node) => node.id === item.nodeId)?.name ?? item.nodeId}{item.lastRunAt ? ` � last ${relativeTime(item.lastRunAt)}` : ""}</span>
              {item.lastStatus ? <small>{item.lastStatus}</small> : null}
            </div>
            <div className="inline-actions">
              {item.lastThreadId ? <Button size="sm" variant="ghost" onClick={() => void state.selectThread(item.lastThreadId!, item.nodeId)}>Open thread</Button> : null}
              <Button size="sm" variant="soft" onClick={async () => { await window.omp.runAutomation(item.id); await load(); }}><Play size={12} /> Run now</Button>
              <Toggle checked={item.enabled} onChange={async (value) => { await window.omp.saveAutomation({ ...item, enabled: value }); await load(); }} />
              <IconButton icon={<Trash2 size={13} />} label="Delete automation" onClick={async () => { await window.omp.deleteAutomation(item.id); await load(); }} />
            </div>
          </div>
        ))}
        {!items.length ? <p className="muted">No automations yet.</p> : null}
      </Section>
      <Section title="Results queue" subtitle="Latest runs and their outcome. Click a thread to inspect it; resolve it from the tree when done.">
        {items.filter((item) => item.lastThreadId).map((item) => {
          const thread = state.snapshot?.threads.find((entry) => entry.id === item.lastThreadId);
          return (
            <div key={`${item.id}-result`} className="simple-row">
              <div><strong>{item.name}</strong><span>{thread ? `${thread.title} � ${thread.status}` : item.lastThreadId}</span></div>
              {thread ? <Badge tone={thread.status === "error" ? "red" : thread.status === "running" ? "blue" : "neutral"}>{thread.status}</Badge> : null}
              <Button size="sm" variant="ghost" onClick={() => item.lastThreadId && void state.selectThread(item.lastThreadId, item.nodeId)}>Open</Button>
            </div>
          );
        })}
        {!items.some((item) => item.lastThreadId) ? <p className="muted">No runs yet.</p> : null}
      </Section>
    </>
  );
}

function SandboxTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [rulePattern, setRulePattern] = useState("");
  const [ruleAction, setRuleAction] = useState<"allow" | "ask" | "deny">("ask");
  const load = async () => setEntries(await window.omp.listAudit(200));
  useEffect(() => { void load(); }, []);
  if (!settings) return null;
  const sandbox = settings.sandbox ?? { enabled: false, allowedPaths: [], deniedCommands: [], allowNetwork: true };
  const update = (patch: any) => state.updateSettings({ settings: { sandbox: { ...sandbox, ...patch } } });
  return (
    <>
      <Section title="Policy" subtitle="Applies to app terminals, dev servers and the agent's environment prompt. Not a kernel sandbox.">
        <Row label="Enable policy" hint="Blocks matching commands in the app terminal and dev-server runner."><Toggle checked={sandbox.enabled} onChange={(value) => update({ enabled: value })} /></Row>
        <Row label="Allowed paths" hint="One per line. Injected into agent guidance; empty means the project plus app data."><textarea value={(sandbox.allowedPaths ?? []).join("\n")} onChange={(event) => update({ allowedPaths: event.target.value.split(/\r?\n/).filter(Boolean) })} placeholder="C:\\Users\\you\\code" /></Row>
        <Row label="Denied command fragments" hint="One per line. Case-insensitive substring match, e.g. rm -rf /, format C:, del /s."><textarea value={(sandbox.deniedCommands ?? []).join("\n")} onChange={(event) => update({ deniedCommands: event.target.value.split(/\r?\n/).filter(Boolean) })} placeholder="git push --force" /></Row>
        <Row label="Allow network" hint="When off, agent guidance forbids network commands and browser use is still explicit."><Toggle checked={sandbox.allowNetwork !== false} onChange={(value) => update({ allowNetwork: value })} /></Row>
        <Row label="Windows computer use" hint="Allows desktop screenshots and mouse/keyboard tools. Off by default."><Toggle checked={settings.computerUse} onChange={(value) => state.updateSettings({ settings: { computerUse: value } })} /></Row>
        <Row label="Auto-fix CI" hint="Lets the CI panel send failing logs to the thread automatically."><Toggle checked={settings.autoFixCi} onChange={(value) => state.updateSettings({ settings: { autoFixCi: value } })} /></Row>
        <Row label="Automatic file checkpoints" hint="Snapshot the checkout before each prompt so you can restore code later. YOLO stays safe."><Toggle checked={settings.autoCheckpoints !== false} onChange={(value) => state.updateSettings({ settings: { autoCheckpoints: value } })} /></Row>
      </Section>
      <Section title="Permission rules" subtitle="YOLO stays the default. Rules are opt-in exceptions evaluated before auto-approval." right={<Badge tone="green">YOLO default</Badge>}>
        <Row label="Add rule" hint="Patterns like Bash(npm run *), Edit, Write, mcp__*, or * for everything.">
          <div className="inline-actions">
            <input value={rulePattern} onChange={(event) => setRulePattern(event.target.value)} placeholder="Bash(git push *)" />
            <Select value={ruleAction} onChange={(value) => setRuleAction(value as "allow" | "ask" | "deny")}>
              <option value="allow">allow</option>
              <option value="ask">ask</option>
              <option value="deny">deny</option>
            </Select>
            <Button size="sm" variant="soft" disabled={!rulePattern.trim()} onClick={() => {
              const rules = [...(settings.permissions?.rules ?? []), { id: `rule_${Date.now().toString(36)}`, pattern: rulePattern.trim(), action: ruleAction }];
              state.updateSettings({ settings: { permissions: { rules } } });
              setRulePattern("");
            }}><Plus size={12} /> Add</Button>
          </div>
        </Row>
        {(settings.permissions?.rules ?? []).map((rule) => (
          <div key={rule.id} className="simple-row">
            <div><strong className="mono">{rule.pattern}</strong><span>{rule.action === "deny" ? "Blocked even in YOLO" : rule.action === "ask" ? "Always asks" : "Auto-approved"}</span></div>
            <div className="inline-actions">
              <Badge tone={rule.action === "deny" ? "red" : rule.action === "ask" ? "amber" : "green"}>{rule.action}</Badge>
              <IconButton icon={<Trash2 size={12} />} label="Delete rule" onClick={() => {
                const rules = (settings.permissions?.rules ?? []).filter((item) => item.id !== rule.id);
                state.updateSettings({ settings: { permissions: { rules } } });
              }} />
            </div>
          </div>
        ))}
        {!(settings.permissions?.rules ?? []).length ? <p className="muted">No rules. Every tool call is auto-approved.</p> : null}
      </Section>
      <Section title="Audit trail" subtitle="Prompts, host tools, approvals, rule hits, terminals and deploys, newest first." right={<Button size="sm" variant="soft" onClick={() => void load()}><RefreshCw size={12} /> Refresh</Button>}>
        <div className="audit-list">
          {entries.map((entry, index) => (
            <div key={`${entry.at}-${index}`} className="audit-row">
              <span className="mono">{new Date(entry.at).toLocaleTimeString()}</span>
              <Badge tone={entry.tag.includes("block") ? "red" : entry.tag.includes("deploy") ? "green" : "neutral"}>{entry.tag}</Badge>
              <span>{truncate(typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail), 160)}</span>
            </div>
          ))}
          {!entries.length ? <p className="muted">No audit entries yet.</p> : null}
        </div>
      </Section>
    </>
  );
}

function PluginsTab() {
  const state = useApp();
  const [installed, setInstalled] = useState<InstalledPlugin[]>([]);
  const [source, setSource] = useState("");
  const [previews, setPreviews] = useState<PluginPreview[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => setInstalled(await window.omp.listPlugins());
  useEffect(() => { void load(); }, []);
  const preview = async () => {
    setBusy("preview");
    try {
      const list = await window.omp.previewPlugin(source);
      setPreviews(list);
      setSelected(list.length === 1 ? list[0].name : "");
      if (!list.length) state.pushToast({ kind: "warning", title: "No plugins found", body: "Check the repository or folder." });
    } catch (error) {
      state.pushToast({ kind: "error", title: "Plugin preview failed", body: String(error) });
    } finally {
      setBusy(null);
    }
  };
  const install = async () => {
    setBusy("install");
    try {
      const plugin = await window.omp.installPlugin(source, selected || undefined);
      state.pushToast({ kind: "success", title: "Plugin installed", body: `${plugin.name}: ${plugin.skills.length} skills, ${plugin.mcpServers.length} MCP servers` });
      setPreviews([]);
      setSource("");
      await load();
    } catch (error) {
      state.pushToast({ kind: "error", title: "Plugin install failed", body: String(error) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Section title="Install a plugin" subtitle="Git URL or local folder with plugin.json or .claude-plugin/marketplace.json. Skills and MCP servers are installed; hook code is counted but never executed.">
        <Row label="Source">
          <div className="inline-actions">
            <input value={source} onChange={(event) => setSource(event.target.value)} placeholder="https://github.com/org/plugin or C:\\plugins\\mine" />
            <Button size="sm" variant="soft" disabled={!source.trim() || busy !== null} onClick={() => void preview()}>{busy === "preview" ? <Spinner /> : <Search size={12} />} Preview</Button>
          </div>
        </Row>
        {previews.length ? (
          <div className="plugin-preview-list">
            {previews.map((plugin) => (
              <button key={plugin.name} type="button" className={cx("plugin-preview", selected === plugin.name && "active")} onClick={() => setSelected(plugin.name)}>
                <div><strong>{plugin.name}</strong><span>{plugin.description || "No description"}</span></div>
                <div className="plugin-components">
                  <Badge tone="blue">{plugin.skills} skills</Badge>
                  <Badge tone="purple">{plugin.commands} commands</Badge>
                  <Badge tone="neutral">{plugin.agents} agents</Badge>
                  <Badge tone="amber">{plugin.hooks} hooks (not run)</Badge>
                  <Badge tone="green">{plugin.mcpServers} MCP</Badge>
                </div>
              </button>
            ))}
            <Button size="sm" variant="primary" disabled={!selected || busy !== null} onClick={() => void install()}>{busy === "install" ? <Spinner /> : <Download size={12} />} Install {selected || "selected"}</Button>
          </div>
        ) : null}
      </Section>
      <Section title="Installed plugins" subtitle="Remove restores skills and MCP entries added by the plugin.">
        {installed.map((plugin) => (
          <div key={plugin.name} className="simple-row">
            <div>
              <strong>{plugin.name}</strong>
              <span>{plugin.skills.length} skills � {plugin.commands} commands � {plugin.mcpServers.length} MCP � {plugin.agents} agents � {plugin.hooks} hooks unused</span>
              <small className="mono">{plugin.source}</small>
            </div>
            <Button size="sm" variant="danger" onClick={async () => {
              if (!confirm(`Remove ${plugin.name} and its installed skills/MCP entries?`)) return;
              await window.omp.removePlugin(plugin.name);
              await load();
            }}>Remove</Button>
          </div>
        ))}
        {!installed.length ? <p className="muted">No plugins installed.</p> : null}
      </Section>
      <Section title="Safety" subtitle="Plugin hooks and mods are code execution. This app does not execute plugin hooks; only declarative skills, commands-as-skills and MCP servers are installed.">
        <p className="muted">Review a plugin before installing. MCP servers start local processes or connect to remote URLs, so install only sources you trust.</p>
      </Section>
    </>
  );
}

function RemoteTab() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const [info, setInfo] = useState<RemoteInfo | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);
  const [report, setReport] = useState<MaintenanceReport | null>(null);
  const load = async () => setInfo(await window.omp.remoteInfo());
  useEffect(() => { void load(); }, []);
  if (!settings) return null;
  const remote = settings.remote ?? { enabled: true, port: 43120, host: "127.0.0.1", keepRunning: false };
  const apply = async (patch: Partial<typeof remote>) => {
    setBusy("apply");
    try {
      await window.omp.stopRemote();
      await state.updateSettings({ settings: { remote: { ...remote, ...patch } } });
      const next = await window.omp.startRemote();
      setInfo(next);
    } catch (error) {
      state.pushToast({ kind: "error", title: "Could not apply remote settings", body: String(error) });
      await load();
    } finally {
      setBusy(null);
    }
  };
  const link = info?.urls[0] ? `${info.urls[0]}/#t=${encodeURIComponent(info.token)}` : "";
  return (
    <>
      <Section title="Remote access" subtitle="No public ports. Use Tailscale, your LAN, or a reverse proxy you control." right={<Badge tone={info?.running ? "green" : "neutral"}>{info?.running ? "running" : "stopped"}</Badge>}>
        <Row label="Enable remote server" hint="Token-protected HTTP + WebSocket on this machine. The mobile PWA is served from it.">
          <Toggle checked={remote.enabled} onChange={(value) => void (value ? window.omp.startRemote().then(setInfo) : window.omp.stopRemote().then(setInfo)).catch((error) => state.pushToast({ kind: "error", title: "Remote toggle failed", body: String(error) }))} />
        </Row>
        <Row label="Bind address" hint="127.0.0.1 is correct for Tailscale Serve. Use 0.0.0.0 only on a trusted LAN.">
          <div className="inline-actions">
            <input value={remote.host} onChange={(event) => state.updateSettings({ settings: { remote: { ...remote, host: event.target.value } } })} />
            <input className="num-input" type="number" min={1024} max={65535} value={remote.port} onChange={(event) => state.updateSettings({ settings: { remote: { ...remote, port: Number(event.target.value) } } })} />
            <Button size="sm" variant="soft" disabled={busy !== null} onClick={() => void apply({})}>{busy === "apply" ? <Spinner /> : <RefreshCw size={12} />} Apply</Button>
          </div>
        </Row>
        <Row label="Keep running when the window closes" hint="Hide to the tray instead of quitting, so the phone can keep using this machine. Quit from the tray menu when done.">
          <Toggle checked={!!remote.keepRunning} onChange={(value) => state.updateSettings({ settings: { remote: { ...remote, keepRunning: value } } })} />
        </Row>
        {info?.error ? <Row label="Last error"><span className="connector-result">{info.error}</span></Row> : null}
        {info?.urls.length ? (
          <Row label="Runner URLs" hint="Open one on your phone (Tailscale IP recommended).">
            <div className="remote-urls">
              {info.urls.map((url) => <button key={url} type="button" className="remote-url" onClick={() => void window.omp.openExternal(url)}>{url}</button>)}
            </div>
          </Row>
        ) : null}
        {info ? (
          <Row label="Pairing token" hint="Stored locally and required by every device. Rotate to revoke all phones.">
            <div className="inline-actions">
              <input type={showToken ? "text" : "password"} readOnly value={info.token} />
              <Button size="sm" variant="ghost" onClick={() => setShowToken((value) => !value)}>{showToken ? "Hide" : "Show"}</Button>
              <Button size="sm" variant="soft" disabled={!link} onClick={() => { void navigator.clipboard.writeText(link); state.pushToast({ kind: "info", title: "Mobile link copied", body: "Open it on your phone with Tailscale connected." }); }}><Copy size={12} /> Copy link</Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={async () => {
                if (!confirm("Rotate the token? Every paired phone will be disconnected.")) return;
                setBusy("rotate");
                try { setInfo(await window.omp.rotateRemoteToken()); state.pushToast({ kind: "success", title: "Token rotated" }); } finally { setBusy(null); }
              }}>Rotate</Button>
            </div>
          </Row>
        ) : null}
      </Section>
      {info?.qr ? (
        <Section title="Pair a phone" subtitle="Tailscale connected? Scan this code. It contains the runner URL and token in the URL fragment, which is never sent to the server.">
          <div className="remote-qr"><img src={info.qr} alt="Remote pairing QR" /><div><strong>OMP Remote</strong><span>Scan with the camera, or open the copied link.</span><small>If you rotate the token, rescan.</small></div></div>
        </Section>
      ) : null}
      <Section title="Tailscale (recommended)" subtitle="Private access from anywhere without opening a port.">
        <ol className="remote-steps">
          <li>Install Tailscale on this PC and on your phone, signed into the same tailnet.</li>
          <li>Run <code>tailscale serve --bg 43120</code> on this PC. It gives you an HTTPS URL on your tailnet.</li>
          <li>Open that HTTPS URL on your phone and add <code>#t=&lt;token&gt;</code>, or scan the QR after Tailscale is connected.</li>
          <li>On iPhone, use Share ? Add to Home Screen. On Android, Install app.</li>
        </ol>
        <p className="muted">No public exposure, no firewall changes, no dynamic DNS. A self-hosted relay or Cloudflare Tunnel + Access works the same way if you prefer.</p>
      </Section>
      <Section title="Mobile app" subtitle="The PWA is the mobile app: installable, offline shell, same token.">
        <div className="inline-actions">
          <Button size="sm" variant="soft" disabled={!info?.urls[0]} onClick={() => void window.omp.openExternal(link)}><ExternalLink size={12} /> Open on this device</Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={12} /> Refresh</Button>
        </div>
      </Section>
      <Section title="Cleanup" subtitle="Label-scoped garbage collection for sessions, imported workspaces, worktrees, expired share bundles, artifacts and logs. It never touches files outside the OMP data directory.">
        <div className="inline-actions">
          <Button size="sm" variant="soft" disabled={busy !== null} onClick={async () => {
            setBusy("sweep");
            try { setReport(await window.omp.maintenanceSweep(false)); } catch (error) { state.pushToast({ kind: "error", title: "Cleanup failed", body: String(error) }); } finally { setBusy(null); }
          }}>{busy === "sweep" ? <Spinner /> : <Trash2 size={12} />} Clean up now</Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={async () => {
            setBusy("preview");
            try { setReport(await window.omp.maintenanceSweep(true)); } finally { setBusy(null); }
          }}>Preview</Button>
        </div>
        {report ? (
          <p className="muted">
            {report.dryRun ? "Would reclaim " : "Reclaimed "}{formatBytes(report.bytesReclaimed)} across {report.actions.length} item{report.actions.length === 1 ? "" : "s"} in {report.durationMs} ms. Data directory is {formatBytes(report.runnerBytes)} ({report.quotaUsedPct}% of quota).
            {report.warnings.length ? ` ${report.warnings.join("; ")}` : ""}
          </p>
        ) : <p className="muted">Runs automatically at startup and every five minutes. Quota: 20 GB per runner, 5 GB per session.</p>}
      </Section>
      <RemoteTargets />
      <RelaySettings />
      <E2BSettings />
    </>
  );
}

function E2BSettings() {
  const state = useApp();
  const [info, setInfo] = useState<E2BInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ apiUrl: "http://127.0.0.1:3000", domain: "localhost", template: "omp-runner", timeoutMinutes: 60, apiKey: "" });
  useEffect(() => {
    void window.omp.e2bInfo().then((next: E2BInfo) => {
      setInfo(next);
      setForm((current) => ({ ...current, apiUrl: next.apiUrl, domain: next.domain, template: next.template }));
    }).catch(() => undefined);
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      setInfo(await window.omp.configureE2B(form));
      setForm((current) => ({ ...current, apiKey: "" }));
    } catch (error) {
      state.pushToast({ kind: "error", title: "E2B settings failed", body: String(error) });
    } finally {
      setBusy(false);
    }
  };
  const provision = async () => {
    setBusy(true);
    try {
      const target = await window.omp.provisionE2B();
      setInfo(await window.omp.e2bInfo());
      state.pushToast({ kind: "success", title: "E2B sandbox ready", body: `${target.name} at ${target.url}` });
    } catch (error) {
      state.pushToast({ kind: "error", title: "E2B sandbox failed", body: String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="E2B Embed target"
      subtitle="Create a Firecracker microVM target on your own KVM host. The sandbox runs the OMP runner template and is terminated when its target is removed."
      right={<Badge tone={info?.configured ? "green" : "neutral"}>{info?.configured ? "configured" : "setup"}</Badge>}
    >
      <div className="remote-target-form">
        <input placeholder="http://127.0.0.1:3000" value={form.apiUrl} onChange={(event) => setForm({ ...form, apiUrl: event.target.value })} />
        <input placeholder="localhost" value={form.domain} onChange={(event) => setForm({ ...form, domain: event.target.value })} />
      </div>
      <div className="remote-target-form">
        <input placeholder="omp-runner" value={form.template} onChange={(event) => setForm({ ...form, template: event.target.value })} />
        <input className="num-input" type="number" min={5} max={1440} value={form.timeoutMinutes} onChange={(event) => setForm({ ...form, timeoutMinutes: Number(event.target.value) })} />
        <input type="password" placeholder={info?.hasKey ? "API key (leave blank to keep)" : "E2B API key"} value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
      </div>
      <div className="inline-actions">
        <Button size="sm" variant="soft" disabled={busy} onClick={() => void save()}>{busy ? <Spinner /> : <Save size={12} />} Save</Button>
        <Button size="sm" variant="soft" disabled={busy || !info?.configured} onClick={() => void provision()}>{busy ? <Spinner /> : <Cloud size={12} />} Create sandbox target</Button>
      </div>
      {info?.error ? <p className="muted">{info.error}</p> : null}
      {info?.targets.length ? (
        <div className="remote-targets">
          {info.targets.map((target) => (
            <div key={target.id} className="remote-target">
              <div><strong>{target.name}</strong><span>{target.sandboxId} · {target.url}</span></div>
              <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
                setBusy(true);
                try { setInfo(await window.omp.terminateE2B(target.id)); } finally { setBusy(false); }
              }}>Terminate</Button>
            </div>
          ))}
        </div>
      ) : <p className="muted">No E2B targets. Build the “omp-runner” template on your KVM host first (see e2b/README.md).</p>}
    </Section>
  );
}


function RelaySettings() {
  const state = useApp();
  const [info, setInfo] = useState<RelayInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ url: "", room: "", token: "", secret: "" });
  useEffect(() => {
    void window.omp.relayInfo().then((next: RelayInfo) => {
      setInfo(next);
      setForm({ url: next.url, room: next.room, token: "", secret: "" });
    }).catch(() => undefined);
  }, []);
  const save = async (enabled: boolean) => {
    setBusy(true);
    try {
      const next = await window.omp.configureRelay({ enabled, url: form.url, room: form.room, token: form.token, secret: form.secret });
      setInfo(next);
      setForm({ url: next.url, room: next.room, token: "", secret: "" });
    } catch (error) {
      state.pushToast({ kind: "error", title: "Relay failed", body: String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Self-hosted relay"
      subtitle="Runner and phone connect outbound to a relay you own. The relay forwards AES-256-GCM frames and never sees prompts or session data."
      right={<Badge tone={info?.connected ? "green" : info?.running ? "amber" : "neutral"}>{info?.connected ? "connected" : info?.running ? "connecting" : "off"}</Badge>}
    >
      <div className="remote-target-form">
        <input placeholder="https://relay.tailnet-name.ts.net" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
        <input placeholder="Room (auto)" value={form.room} onChange={(event) => setForm({ ...form, room: event.target.value })} />
      </div>
      <div className="remote-target-form">
        <input type="password" placeholder={info?.hasToken ? "Room token (leave blank to keep)" : "Room token (auto)"} value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} />
        <input type="password" placeholder={info?.hasSecret ? "E2E secret (leave blank to keep)" : "E2E secret (auto)"} value={form.secret} onChange={(event) => setForm({ ...form, secret: event.target.value })} />
      </div>
      <div className="inline-actions">
        <Button size="sm" variant="soft" disabled={busy || !form.url.trim()} onClick={() => void save(true)}>{busy ? <Spinner /> : <Cloud size={12} />} Save and connect</Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void save(false)}>Disconnect</Button>
        {info?.link ? <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard.writeText(info.link!); state.pushToast({ kind: "info", title: "Relay link copied" }); }}><Copy size={12} /> Copy link</Button> : null}
        <Button size="sm" variant="ghost" disabled={!info?.link} onClick={() => void window.omp.openExternal(info!.link!)}><ExternalLink size={12} /> Open relay</Button>
      </div>
      {info?.error ? <p className="muted">{info.error}</p> : null}
      {info?.connected ? <p className="muted">Room {info.room} · {info.clients} client(s). The relay only sees ciphertext.</p> : null}
      {info?.qr ? <div className="remote-qr"><img src={info.qr} alt="Relay pairing QR" /><div><strong>Relay pairing</strong><span>Scan on the phone. The token and E2E key are in the URL fragment.</span><small>Put the relay behind Tailscale or TLS; it should not be public.</small></div></div> : null}
    </Section>
  );
}

function RemoteTargets() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const policy = settings?.remotePlacement ?? { enabled: false, targetId: "", idleSeconds: 60, consent: false };
  const [targets, setTargets] = useState<RemoteTarget[]>([]);
  const [form, setForm] = useState({ name: "", url: "", token: "" });
  const [busy, setBusy] = useState<string | null>(null);
  const [threadId, setThreadId] = useState("");
  const [targetId, setTargetId] = useState("");
  const [result, setResult] = useState("");
  const [placement, setPlacement] = useState("");
  const [lastPlacement, setLastPlacement] = useState<PlacementResult | null>(null);
  const [usage, setUsage] = useState<TargetUsage | null>(null);
  const [usageBusy, setUsageBusy] = useState<string | null>(null);
  useEffect(() => {
    void window.omp.listRemoteTargets().then(setTargets).catch(() => undefined);
    void window.omp.lastPlacement().then(setLastPlacement).catch(() => undefined);
    const timer = window.setInterval(() => { void window.omp.lastPlacement().then(setLastPlacement).catch(() => undefined); }, 10_000);
    return () => window.clearInterval(timer);
  }, []);
  const threads = useMemo(() => [...(state.snapshot?.threads ?? [])].sort((a, b) => b.updatedAt - a.updatedAt), [state.snapshot?.threads]);
  const updatePolicy = (patch: Partial<typeof policy>) => state.updateSettings({ settings: { remotePlacement: { ...policy, ...patch } } });
  return (
    <Section title="Targets and cold move" subtitle="Register another user-owned runner (a VPS, a spare PC, or the Docker runner). Moving exports the workspace, OMP session and chat, then imports them on the target. The source stays for rollback.">
      {targets.length ? (
        <div className="remote-targets">
          {targets.map((target) => (
            <div key={target.id} className="remote-target">
              <div>
                <strong>{target.name}</strong>
                <span>{target.url} · {target.status}{target.latencyMs ? ` · ${target.latencyMs} ms` : ""}{target.error ? ` · ${target.error}` : ""}</span>
              </div>
              <div className="inline-actions">
                <Button size="sm" variant="ghost" disabled={busy !== null} onClick={async () => {
                  setBusy(target.id);
                  try { setTargets(await window.omp.testRemoteTarget(target.id)); } finally { setBusy(null); }
                }}>Test</Button>
                <Button size="sm" variant="ghost" disabled={usageBusy !== null} onClick={async () => {
                  setUsageBusy(target.id);
                  try {
                    const report = await window.omp.targetUsage(target.id);
                    setUsage(report);
                    setTargets((current) => current.map((item) => item.id === target.id ? report.target : item));
                  } catch (error) {
                    state.pushToast({ kind: "error", title: "Cost check failed", body: String(error) });
                  } finally { setUsageBusy(null); }
                }}>{usageBusy === target.id ? <Spinner /> : <Gauge size={12} />} Costs</Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={async () => {
                  if (!confirm(`Remove ${target.name}? The token is deleted from this device.`)) return;
                  setTargets(await window.omp.removeRemoteTarget(target.id));
                }}>Remove</Button>
              </div>
            </div>
          ))}
        </div>
      ) : <p className="muted">No targets yet.</p>}
      <div className="remote-cost">
        <strong>Cost meter</strong>
        <span>Placed sessions: ${threads.filter((thread) => thread.targetId).reduce((sum, thread) => sum + (thread.cost ?? 0), 0).toFixed(4)} · {threads.filter((thread) => thread.targetId).reduce((sum, thread) => sum + (thread.tokens ?? 0), 0).toLocaleString()} tok</span>
        <span>{usage ? `${usage.target.name}: $${usage.totalCost.toFixed(4)} · ${usage.totalTokens.toLocaleString()} tok · ${usage.threads.length} session(s) · ${new Date(usage.generatedAt).toLocaleTimeString()}` : "Use Costs on a target to refresh its usage."}</span>
      </div>
      <div className="remote-target-form">
        <input placeholder="Name (VPS)" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
        <input placeholder="https://vps.tailnet-name.ts.net" value={form.url} onChange={(event) => setForm({ ...form, url: event.target.value })} />
        <input placeholder="Pairing token" value={form.token} onChange={(event) => setForm({ ...form, token: event.target.value })} />
        <Button size="sm" variant="soft" disabled={busy !== null || !form.url.trim() || !form.token.trim()} onClick={async () => {
          setBusy("add");
          try {
            setTargets(await window.omp.addRemoteTarget({ ...form, kind: "paired" }));
            setForm({ name: "", url: "", token: "" });
          } catch (error) {
            state.pushToast({ kind: "error", title: "Could not add target", body: String(error) });
          } finally { setBusy(null); }
        }}>{busy === "add" ? <Spinner /> : <Plus size={12} />} Add target</Button>
      </div>

      <div className="remote-policy">
        <div className="remote-policy-head">
          <div>
            <strong>Automatic placement</strong>
            <span>Move idle worker sessions to a user-owned runner at a turn boundary. No per-session prompt.</span>
          </div>
          <Toggle checked={policy.enabled} onChange={(value) => updatePolicy({ enabled: value })} />
        </div>
        <div className="remote-target-form">
          <select value={policy.targetId} onChange={(event) => updatePolicy({ targetId: event.target.value })}>
            <option value="">Choose a runner…</option>
            {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
          </select>
          <select value={policy.idleSeconds} onChange={(event) => updatePolicy({ idleSeconds: Number(event.target.value) })}>
            <option value={60}>After 1 minute idle</option>
            <option value={300}>After 5 minutes idle</option>
            <option value={900}>After 15 minutes idle</option>
          </select>
          <label className="remote-consent">
            <input type="checkbox" checked={policy.consent} onChange={(event) => updatePolicy({ consent: event.target.checked })} />
            I understand moved sessions run on that machine and their files leave this PC.
          </label>
          <Button size="sm" variant="soft" disabled={busy !== null || !policy.targetId} onClick={async () => {
            setBusy("place");
            setPlacement("");
            try {
              const report = await window.omp.placeIdleSessions(true);
              setPlacement(report.placed.length
                ? `Placed ${report.placed.length} session(s) on ${report.target?.name ?? "target"}: ${report.placed.map((item) => `${item.warm ? "warm" : "cold"} ${item.ms} ms, ${item.filesWritten} file(s)${item.filesUnchanged ? `, ${item.filesUnchanged} unchanged` : ""}`).join("; ")}.`
                : `Nothing placed: ${report.skipped.join("; ") || "no eligible sessions"}.`);
            } catch (error) {
              setPlacement(String(error));
            } finally { setBusy(null); }
          }}>{busy === "place" ? <Spinner /> : <Cloud size={12} />} Place idle sessions now</Button>
        </div>
        {placement ? <p className="muted">{placement}</p> : null}
        {lastPlacement?.placed.length ? <p className="muted">Last automatic placement: {lastPlacement.placed.length} session(s) at {new Date(lastPlacement.at).toLocaleTimeString()} ({lastPlacement.placed.map((item) => `${item.warm ? "warm" : "cold"} ${item.ms} ms`).join(", ")}).</p> : null}
        <p className="muted">Checks every 20 seconds when enabled and consented. Only idle worker sessions with history are moved; running turns are never interrupted.</p>
      </div>

      <div className="remote-target-form">
        <select value={threadId} onChange={(event) => setThreadId(event.target.value)}>
          <option value="">Choose a session…</option>
          {threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.title}</option>)}
        </select>
        <select value={targetId} onChange={(event) => setTargetId(event.target.value)}>
          <option value="">Choose a target…</option>
          {targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
        </select>
        <Button size="sm" variant="soft" disabled={busy !== null || !threadId || !targets.length} onClick={async () => {
          const target = targets.find((item) => item.id === targetId) ?? targets[0];
          setBusy("move");
          setResult("");
          try {
            const moved = await window.omp.moveThreadToTarget(threadId, target.id);
            setResult(`Moved to ${target.name} as ${moved.threadId} (${moved.warm ? "warm" : "cold"}, ${moved.filesWritten} file(s) written, ${moved.filesUnchanged} unchanged, ${(moved.bytesSent / 1024).toFixed(0)} KB). Continue it there from the PWA or that runner.`);
          } catch (error) {
            setResult(String(error));
          } finally { setBusy(null); }
        }}>{busy === "move" ? <Spinner /> : <Play size={12} />} Move session</Button>
      </div>
      {result ? <p className="muted">{result}</p> : null}
    </Section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}









