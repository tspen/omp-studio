import React, { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Bell,
  Check,
  ChevronRight,
  Cpu,
  Download,
  Folder,
  FolderGit2,
  Gauge,
  KeyRound,
  MemoryStick,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { Environment, EnvVar, McpServerInfo, ModelInfo, OmpConfigEntry, SkillInfo, ToolApproval, ToolInfo } from "../../../shared/types";
import { selectedNode, selectedThread, useApp } from "../store";
import { Badge, Button, Field, IconButton, Modal, Select, Spinner, Toggle, cx, formatCost, formatNumber, statusLabel, truncate } from "./Common";
import { ModelPicker } from "./ModelPicker";

const TABS = [
  { id: "general", label: "General", icon: <Settings2 size={15} /> },
  { id: "models", label: "Models", icon: <Sparkles size={15} /> },
  { id: "usage", label: "Usage", icon: <Gauge size={15} /> },
  { id: "tools", label: "Tools", icon: <Wrench size={15} /> },
  { id: "memory", label: "Memory", icon: <MemoryStick size={15} /> },
  { id: "environments", label: "Environment", icon: <Terminal size={15} /> },
  { id: "git", label: "Git", icon: <FolderGit2 size={15} /> },
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
        <Row label="Auto-name threads" hint="Uses the naming model to turn the first message into a short title.">
          <Toggle checked={settings.autoName} onChange={(value) => update({ autoName: value })} />
        </Row>
        <Row label="Report upward automatically" hint="Each completed thread sends a compact result to its parent orchestrator.">
          <Toggle checked={settings.autoReport} onChange={(value) => update({ autoReport: value })} />
        </Row>
        <Row label="Wake parent on report" hint="If the parent is parked, a child report starts it. Disable to queue reports silently.">
          <Toggle checked={settings.autoWakeParent} onChange={(value) => update({ autoWakeParent: value })} />
        </Row>
        <Row label="Tree digest interval" hint="Minutes between roll-up notifications. 0 disables digests.">
          <input className="num-input" type="number" min={0} value={settings.digestIntervalMin} onChange={(event) => update({ digestIntervalMin: Number(event.target.value) })} />
        </Row>
        <Row label="Max concurrent OMP sessions" hint="Idle sessions are parked to stay under this cap.">
          <input className="num-input" type="number" min={1} max={32} value={settings.maxConcurrentThreads} onChange={(event) => update({ maxConcurrentThreads: Number(event.target.value) })} />
        </Row>
        <Row label="Advisor runtime" hint="Passively reviews each turn and injects notes. More tokens, more scrutiny.">
          <Toggle checked={settings.advisor} onChange={(value) => update({ advisor: value })} />
        </Row>
        <Row label="Show thinking blocks" hint="Display model reasoning inline.">
          <Toggle checked={settings.ui.showThinking} onChange={(value) => update({ ui: { ...settings.ui, showThinking: value } })} />
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
                  {model ? <span className="muted">{formatCost(model.cost.input)}/{formatCost(model.cost.output)} · {formatNumber(model.contextWindow)} ctx</span> : null}
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
        <Row label="Cost"><strong>{formatCost(usage.totalCost)}</strong></Row>
        <Row label="Budget" hint="Optional soft budget in USD. Used for visibility and warnings.">
          <input className="num-input" type="number" min={0} step={1} value={settings.usage.budgetUsd ?? ""} onChange={(event) => state.updateSettings({ settings: { usage: { ...settings.usage, budgetUsd: event.target.value ? Number(event.target.value) : undefined } } })} />
        </Row>
        <Row label="Auto-continue on usage reset" hint="If a thread fails on a usage limit, retry after the reset window with a continuation instruction.">
          <Toggle checked={settings.usage.autoContinueOnReset} onChange={(value) => state.updateSettings({ settings: { usage: { ...settings.usage, autoContinueOnReset: value } } })} />
        </Row>
      </Section>
      <Section title="Provider windows" subtitle="Read from `omp usage --json`.">
        {usage.providers.length ? usage.providers.map((provider) => (
          <div key={`${provider.provider}-${provider.label}`} className="provider-row">
            <div>
              <strong>{provider.provider}</strong>
              <span>{provider.label} · {provider.status ?? "ok"}</span>
            </div>
            <div className="provider-amount">
              {provider.limit != null ? <strong>{provider.remaining ?? "?"} / {provider.limit} {provider.unit ?? ""}</strong> : <strong>{provider.status ?? "ok"}</strong>}
              {provider.resetsAt ? <span>resets {new Date(provider.resetsAt).toLocaleString()}</span> : null}
            </div>
          </div>
        )) : <p className="muted">No provider reports. Authenticate a provider and refresh.</p>}
      </Section>
      <Section title="Cost by node" subtitle="Where the tree is spending.">
        {nodes.map(({ node, stat }) => (
          <div key={node.id} className="provider-row">
            <div><strong>{node.name}</strong><span>{node.type} · {stat?.threads ?? 0} threads</span></div>
            <div className="provider-amount"><strong>{formatCost(stat?.cost ?? 0)}</strong><span>{formatNumber(stat?.tokens ?? 0)} tokens</span></div>
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
      <Section title="Skills" subtitle="Discovered from OMP and Claude skill directories.">
        {skills.length ? skills.map((skill) => (
          <div key={`${skill.source}-${skill.path}`} className="simple-row">
            <div><strong>{skill.name}</strong><span>{skill.description || skill.path}</span></div>
            <Badge tone="blue">{skill.source}</Badge>
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
        <Row label="Tree digests"><Toggle checked={n.onDigest} onChange={(value) => update({ onDigest: value })} /></Row>
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
