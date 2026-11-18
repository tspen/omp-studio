import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  ExternalLink,
  KeyRound,
  Loader2,
  Search,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wifi,
  Wrench,
} from "lucide-react";
import type { ModelInfo, ProviderInfo } from "../../../shared/types";
import { useApp } from "../store";
import { Badge, Button, Field, Logo, Select, Spinner, Toggle, cx, defaultNodePath, formatCost, formatNumber } from "../components/Common";
import { ModelPicker } from "../components/ModelPicker";

type Step = 0 | 1 | 2;

export function Onboarding() {
  const state = useApp();
  const settings = state.snapshot?.settings;
  const engine = state.engine;
  const [step, setStep] = useState<Step>(0);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providerQuery, setProviderQuery] = useState("");
  const [showAllProviders, setShowAllProviders] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState("");
  const [providerKey, setProviderKey] = useState("");
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [providerOutput, setProviderOutput] = useState("");
  const [providerError, setProviderError] = useState("");
  const [rootModel, setRootModel] = useState("");
  const [workerModel, setWorkerModel] = useState("");
  const [namingModel, setNamingModel] = useState("");
  const [rootEffort, setRootEffort] = useState("high");
  const [workerEffort, setWorkerEffort] = useState("medium");
  const [picking, setPicking] = useState<"root" | "worker" | "naming" | null>(null);
  const [notifications, setNotifications] = useState(true);
  const [autoName, setAutoName] = useState(true);
  const [projectName, setProjectName] = useState("");
  const [projectPath, setProjectPath] = useState("");
  const [projectPathTouched, setProjectPathTouched] = useState(false);
  const [projectBrief, setProjectBrief] = useState("");
  const [gitInit, setGitInit] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!settings) return;
    setNotifications(settings.notifications.enabled);
    setAutoName(settings.autoName);
  }, [settings?.notifications.enabled, settings?.autoName]);

  useEffect(() => {
    void window.perch.listProviders().then((list) => {
      setProviders(list);
      const preferred = settings?.models.preferredProvider;
      const chosen =
        list.find((provider) => provider.id === preferred) ??
        list.find((provider) => provider.id === "opencode-go") ??
        list.find((provider) => provider.connected && provider.recommended) ??
        list.find((provider) => provider.connected);
      setSelectedProvider(chosen?.id ?? "opencode-go");
    }).catch((error) => setProviderError(String(error)));
  }, []);

  const modelPool = useMemo(() => {
    const sane = (model: ModelInfo) => model.available && !model.id.includes(":batch") && !/\(batch\)/i.test(model.name) && !model.id.includes("~") && !/latest/i.test(model.id);
    const providerModels = selectedProvider ? state.models.filter((model) => model.provider === selectedProvider && sane(model)) : [];
    return providerModels.length ? providerModels : state.models.filter(sane);
  }, [state.models, selectedProvider]);

  useEffect(() => {
    if (!modelPool.length) return;
    setRootModel(pickModel("root", modelPool));
    setWorkerModel(pickModel("worker", modelPool));
    setNamingModel(pickModel("naming", modelPool));
  }, [modelPool.map((model) => model.selector).join("|"), selectedProvider]);

  useEffect(() => {
    const normalize = (selector: string, effort: string, set: (value: string) => void, role: "root" | "worker") => {
      const model = modelPool.find((item) => item.selector === selector);
      if (!model) return;
      if (!model.reasoning) {
        if (effort !== "off") set("off");
        return;
      }
      const supported = model.thinking ?? [];
      if (supported.length && !supported.includes(effort)) {
        const preferred = role === "root" ? ["high", "medium", "xhigh", "low", "max"] : ["medium", "high", "low", "minimal", "max"];
        set(preferred.find((item) => supported.includes(item)) ?? supported[0] ?? "off");
      }
    };
    normalize(rootModel, rootEffort, setRootEffort, "root");
    normalize(workerModel, workerEffort, setWorkerEffort, "worker");
  }, [rootModel, workerModel, modelPool.map((model) => model.selector).join("|")]);

  const selectedProviderInfo = providers.find((provider) => provider.id === selectedProvider);
  const providerUsage = state.snapshot?.usage.providers.find((provider) => provider.provider === selectedProvider);
  const providerWindows = ((providerUsage?.metadata?.limits ?? []) as Array<{ label?: string; used?: number; limit?: number; remaining?: number; unit?: string; status?: string }>);
  const connectedProviders = providers.filter((provider) => provider.connected);
  const visibleProviders = useMemo(() => {
    const query = providerQuery.toLowerCase();
    let list = providers.filter((provider) => !query || provider.name.toLowerCase().includes(query) || provider.id.toLowerCase().includes(query));
    if (!query && !showAllProviders) list = list.slice(0, 9);
    return list;
  }, [providers, providerQuery, showAllProviders]);

  if (!settings) return null;

  const connect = async () => {
    if (!selectedProviderInfo) return;
    const needsKey = selectedProviderInfo.login === "api-key";
    if (needsKey && !providerKey.trim()) {
      setProviderError("Paste the provider API key first.");
      return;
    }
    setConnecting(true);
    setProviderError("");
    setProviderOutput("");
    try {
      const result = await window.perch.connectProvider(selectedProvider, needsKey ? providerKey.trim() : undefined);
      setProviders(result.providers);
      if (!result.ok) {
        setProviderOutput("");
        setProviderError(result.output.split("\n").filter(Boolean).slice(-1)[0] ?? "Connection failed.");
        return;
      }
      setProviderOutput(result.output);
      setProviderKey("");
      setShowKeyForm(false);
      await state.refresh();
      if (result.providers.find((provider) => provider.id === selectedProvider)?.connected) {
        setStep(1);
      }
    } catch (error) {
      setProviderError(String(error));
    } finally {
      setConnecting(false);
    }
  };

  const useRecommended = () => {
    setRootModel(pickModel("root", modelPool));
    setWorkerModel(pickModel("worker", modelPool));
    setNamingModel(pickModel("naming", modelPool));
  };

  const suggestedProjectPath = defaultNodePath(projectName, state.snapshot?.workspaceRoot);
  const effectiveProjectPath = projectPathTouched ? projectPath : suggestedProjectPath;

  const finish = async () => {
    setSubmitting(true);
    try {
      await state.completeOnboarding({
        models: { root: rootModel, worker: workerModel, naming: namingModel },
        efforts: { root: rootEffort, worker: workerEffort },
        notificationsEnabled: notifications,
        autoName,
        firstProject: projectName.trim() || projectBrief.trim() || effectiveProjectPath.trim()
          ? { name: projectName, path: projectPathTouched ? projectPath || undefined : undefined, brief: projectBrief || undefined, gitInit }
          : undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  const skip = async () => {
    await state.updateSettings({ settings: { onboardingCompleted: true } });
    await state.refresh();
  };

  return (
    <div className="onboarding">
      <div className="onboarding-drag-region" />
      <div className="onboarding-left">
        <div className="onboarding-brand"><Logo size={34} /><div><strong>Perch</strong><span>Tree orchestration for real code</span></div></div>
        <div className="onboarding-pitch">
          <h1>One orchestrator.<br />A tree of workers.</h1>
          <p>Connect a provider, pick your defaults, and let the orchestrator split work into isolated threads that report back.</p>
          <div className="onboarding-features">
            <Feature icon={<Sparkles size={15} />} title="Orchestrator + threads" body="Root, groups, projects and workers with typed messages up and down." />
            <Feature icon={<Wrench size={15} />} title="Real tools, real repo" body="Pi tools, git worktrees, diffs, commits and merges." />
            <Feature icon={<ShieldCheck size={15} />} title="Your keys, your machine" body="Provider credentials stay in Pi's local auth store." />
          </div>
        </div>
        <div className="onboarding-foot">Pi {engine?.version ?? ""} {engine?.found ? "detected" : "not found"}</div>
      </div>
      <div className="onboarding-right">
        <div className="onboarding-progress">
          {["Connect", "Models", "Ready"].map((label, index) => (
            <React.Fragment key={label}>
              <div className={cx("onboarding-step", index === step && "active", index < step && "done")}>
                <span>{index < step ? <Check size={12} /> : index + 1}</span>
                {label}
              </div>
              {index < 2 ? <div className={cx("onboarding-line", index < step && "done")} /> : null}
            </React.Fragment>
          ))}
          <button type="button" className="onboarding-skip" onClick={() => void skip()}>Skip setup</button>
        </div>

        {step === 0 ? (
          <div className="onboarding-panel">
            <div className="onboarding-head">
              <Badge tone="accent">Step 1</Badge>
              <h2>Connect a provider</h2>
              <p>Perch uses Pi's provider catalog and credential store. Connect one service to unlock its models.</p>
            </div>

            <div className={cx("engine-card", engine?.found ? "ok" : "bad")}>
              <div className="engine-card-icon">{engine?.found ? <Check size={16} /> : <CircleAlert size={16} />}</div>
              <div>
                <strong>{engine?.found ? `Pi ${engine.version} is ready` : "Pi engine not found"}</strong>
                <span>{engine?.found ? engine.path : "Download the engine before connecting a provider."}</span>
              </div>
              {!engine?.found ? (
                <Button size="sm" variant="primary" onClick={() => void window.perch.downloadEngine().then(() => state.refresh())}><Download size={13} /> Recheck engine</Button>
              ) : null}
            </div>

            <div className="provider-connected">
              <span>Already connected through Pi</span>
              {connectedProviders.length ? connectedProviders.slice(0, 6).map((provider) => <Badge key={provider.id} tone="green">{provider.name} · {provider.modelCount}</Badge>) : <Badge tone="neutral">None yet</Badge>}
            </div>

            <div className="provider-search"><Search size={14} /><input value={providerQuery} onChange={(event) => setProviderQuery(event.target.value)} placeholder="Search providers…" /></div>
            <div className="provider-list">
              {visibleProviders.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  className={cx("provider-row", selectedProvider === provider.id && "active")}
                  onClick={() => { setSelectedProvider(provider.id); setShowKeyForm(false); setProviderError(""); setProviderOutput(""); }}
                >
                  <div className="provider-logo">{provider.name.slice(0, 1).toUpperCase()}</div>
                  <div className="provider-copy">
                    <strong>{provider.name}</strong>
                    <span>{provider.id} · {provider.login === "api-key" ? "API key" : provider.login === "oauth-code" ? "OAuth" : provider.login === "device-code" ? "device code" : provider.envVar ? "API key / env" : "Pi config"}</span>
                  </div>
                  {provider.connected ? <Badge tone="green">connected</Badge> : provider.recommended ? <Badge tone="accent">recommended</Badge> : null}
                  {provider.billing === "subscription" && !provider.connected ? <Badge tone="blue">plan</Badge> : null}
                </button>
              ))}
            </div>
            {!providerQuery && !showAllProviders && providers.length > 9 ? (
              <button type="button" className="link-button" onClick={() => setShowAllProviders(true)}>Show all {providers.length} providers</button>
            ) : null}

            {selectedProviderInfo ? (
              <div className="provider-connect-panel">
                {selectedProviderInfo.connected ? (
                  <div className="provider-success"><Check size={15} /> {selectedProviderInfo.name} is connected with {selectedProviderInfo.modelCount} models.</div>
                ) : selectedProviderInfo.login === "api-key" ? (
                  <>
                    <div className="provider-instructions">
                      <div><strong>{selectedProviderInfo.name}</strong><span>{selectedProviderInfo.instructions ?? "Paste your API key."}</span></div>
                      {selectedProviderInfo.authUrl ? <Button size="sm" variant="soft" onClick={() => void window.perch.openExternal(selectedProviderInfo.authUrl!)}><ExternalLink size={13} /> Get key</Button> : null}
                    </div>
                    <div className="provider-key">
                      <KeyRound size={15} />
                      <input type="password" value={providerKey} onChange={(event) => setProviderKey(event.target.value)} placeholder={selectedProviderInfo.prompt ?? "Paste API key"} onKeyDown={(event) => event.key === "Enter" && void connect()} />
                      <Button size="sm" variant="primary" disabled={connecting || !providerKey.trim()} onClick={() => void connect()}>{connecting ? <Spinner /> : <ArrowRight size={13} />} Connect</Button>
                    </div>
                    <span className="provider-hint">The key is sent to Pi's local auth store and is never stored in the renderer.</span>
                  </>
                ) : selectedProviderInfo.login === "none" ? (
                  <div className="provider-warning"><CircleAlert size={15} /> This provider needs configuration through Pi settings or a local endpoint.</div>
                ) : (
                  <div className="provider-instructions">
                    <div><strong>{selectedProviderInfo.name}</strong><span>{selectedProviderInfo.instructions ?? "This provider uses an interactive login."}</span></div>
                    <Button size="sm" variant="primary" disabled={connecting} onClick={() => void connect()}>{connecting ? <Spinner /> : <Wifi size={13} />} Connect</Button>
                  </div>
                )}
                {selectedProviderInfo.billing === "subscription" ? (
                  <div className="provider-plan">
                    <ShieldCheck size={14} />
                    <div>
                      <strong>Subscription plan</strong>
                      <span>Token prices are reference values. Usage is governed by the plan's quota windows.</span>
                      {providerWindows.length ? <div className="provider-windows">{providerWindows.map((window) => <Badge key={window.label ?? "window"} tone={window.status === "exhausted" ? "red" : "green"}>{window.label ?? "window"} {window.used ?? 0}%</Badge>)}</div> : null}
                    </div>
                  </div>
                ) : null}
                {providerOutput ? <pre className="provider-output">{providerOutput.slice(-1600)}</pre> : null}
                {providerError ? <div className="provider-error"><CircleAlert size={14} /> {providerError}</div> : null}
                {selectedProviderInfo.connected ? (
                  <div className="onboarding-actions"><Button variant="primary" onClick={() => setStep(1)}>Choose models <ArrowRight size={14} /></Button></div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : step === 1 ? (
          <div className="onboarding-panel">
            <div className="onboarding-head">
              <Badge tone="accent">Step 2</Badge>
              <h2>Pick your starting models</h2>
              <p>Defaults are ordered by Artificial Analysis agentic value within a sane cost cap. You can change any thread later.</p>
            </div>
            <div className="onboarding-model-toolbar">
              <span>{selectedProviderInfo?.name ?? "All providers"} · {modelPool.length} models</span>
              <div className="inline-actions"><Button size="sm" variant="soft" onClick={useRecommended}><Sparkles size={13} /> Use recommended</Button><Button size="sm" variant="ghost" onClick={() => setStep(0)}>Change provider</Button></div>
            </div>
            <div className="onboarding-roles">
              <RoleCard label="Root orchestrator" hint="Coordinates the whole tree." model={findModel(modelPool, rootModel)} role="root" effort={rootEffort} onEffort={setRootEffort} onChange={() => setPicking("root")} />
              <RoleCard label="Thread / subagent" hint="Default for worker threads." model={findModel(modelPool, workerModel)} role="worker" effort={workerEffort} onEffort={setWorkerEffort} onChange={() => setPicking("worker")} />
              <RoleCard label="Naming & memory" hint="Cheap model for titles and recall." model={findModel(modelPool, namingModel)} role="naming" effort="off" onEffort={() => undefined} onChange={() => setPicking("naming")} />
            </div>
            <div className="onboarding-note"><ShieldCheck size={14} /> Models above the default cost cap are still available, but you have to choose them explicitly.</div>
            <div className="onboarding-actions">
              <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
              <Button variant="primary" disabled={!rootModel || !workerModel || !namingModel} onClick={() => setStep(2)}>Continue <ArrowRight size={14} /></Button>
            </div>
          </div>
        ) : (
          <div className="onboarding-panel">
            <div className="onboarding-head">
              <Badge tone="accent">Step 3</Badge>
              <h2>Ready to orchestrate</h2>
              <p>Choose notifications, then optionally create the first project. You can change all of this later.</p>
            </div>
            <div className="onboarding-options">
              <div className="onboarding-option"><div><strong>Windows notifications</strong><span>Toasts when a thread finishes, needs a decision, or errors.</span></div><Toggle checked={notifications} onChange={setNotifications} /></div>
              <div className="onboarding-option"><div><strong>Auto-name threads</strong><span>Names threads from the first message and refreshes long workers every few turns.</span></div><Toggle checked={autoName} onChange={setAutoName} /></div>
            </div>
            <div className="onboarding-project">
              <div className="onboarding-project-head"><div><strong>First project</strong><span>Optional. Point it at a repository or let Perch create a workspace folder.</span></div><Badge tone="neutral">optional</Badge></div>
              <div className="two-col">
                <Field label="Name" hint="Leave blank to auto-name."><input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Auto-name project" /></Field>
                <Field label="Path" hint="Defaults to a folder named after the project under your workspace root."><div className="inline-actions"><input value={effectiveProjectPath} onChange={(event) => { setProjectPathTouched(true); setProjectPath(event.target.value); }} placeholder={projectName.trim() ? suggestedProjectPath : "Type a name for a default folder, or pick one"} /><Button size="sm" variant="soft" onClick={async () => { const picked = await window.perch.pickDirectory(); if (picked) { setProjectPathTouched(true); setProjectPath(picked); } }}><Terminal size={13} /></Button></div></Field>
              </div>
              <Field label="Brief" hint="Sent to the project orchestrator as its first task."><textarea rows={3} value={projectBrief} onChange={(event) => setProjectBrief(event.target.value)} placeholder="What should the first project own?" /></Field>
              <label className="inline-check"><input type="checkbox" checked={gitInit} onChange={(event) => setGitInit(event.target.checked)} /> Initialize git if needed</label>
            </div>
            <div className="onboarding-actions">
              <Button variant="ghost" onClick={() => setStep(1)}>Back</Button>
              <Button variant="primary" disabled={submitting} onClick={() => void finish()}>{submitting ? <Spinner /> : <Check size={14} />} Enter Mission Control</Button>
            </div>
          </div>
        )}
      </div>

      {picking ? (
        <div className="onboarding-picker-layer" onMouseDown={() => setPicking(null)}>
          <div className="onboarding-picker" onMouseDown={(event) => event.stopPropagation()}>
            <ModelPicker
              models={modelPool}
              value={picking === "root" ? rootModel : picking === "worker" ? workerModel : namingModel}
              role={picking}
              onSelect={(selector) => {
                if (picking === "root") setRootModel(selector);
                if (picking === "worker") setWorkerModel(selector);
                if (picking === "naming") setNamingModel(selector);
                setPicking(null);
              }}
              onClose={() => setPicking(null)}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Feature({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="onboarding-feature">
      <div className="onboarding-feature-icon">{icon}</div>
      <div><strong>{title}</strong><span>{body}</span></div>
    </div>
  );
}

function RoleCard({
  label,
  hint,
  model,
  role,
  effort,
  onEffort,
  onChange,
}: {
  label: string;
  hint: string;
  model?: ModelInfo;
  role: "root" | "worker" | "naming";
  effort: string;
  onEffort: (value: string) => void;
  onChange: () => void;
}) {
  const efforts = model?.thinking?.length ? ["off", ...model.thinking] : ["off"];
  const costTone = !model ? "neutral" : model.cost.output > 15 ? "red" : model.cost.output > 5 ? "amber" : "green";
  return (
    <div className="onboarding-role">
      <div className="onboarding-role-head">
        <div><strong>{label}</strong><span>{hint}</span></div>
        {model ? <Badge tone="purple">{model.aa?.agentic != null ? `AG ${model.aa.agentic.toFixed(0)}` : `Q ${model.quality.toFixed(0)}`}</Badge> : null}
      </div>
      <button type="button" className="onboarding-model" onClick={onChange}>
        <div>
          <strong>{model?.name ?? "Choose a model"}</strong>
          <span>{model ? `${formatNumber(model.contextWindow)} ctx${model.maxTokens ? ` · ${formatNumber(model.maxTokens)} out` : ""} · ${model.included ? `included · ref ${formatCost(model.cost.input)}/${formatCost(model.cost.output)}` : `${formatCost(model.cost.input)} in / ${formatCost(model.cost.output)} out`}` : "No model available"}</span>
        </div>
        {model ? <Badge tone={costTone}>{model.aa?.value != null ? `value ${model.aa.value.toFixed(1)}` : "estimated"}</Badge> : null}
        <ChevronDown size={14} />
      </button>
      {role !== "naming" ? (
        <div className="onboarding-role-foot">
          <span>Effort</span>
          <Select value={effort} onChange={onEffort}>
            {[...new Set(efforts)].map((item) => <option key={item} value={item}>{item}</option>)}
          </Select>
        </div>
      ) : null}
    </div>
  );
}

function findModel(models: ModelInfo[], selector: string): ModelInfo | undefined {
  return models.find((model) => model.selector === selector);
}

function pickModel(role: "root" | "worker" | "naming", models: ModelInfo[]): string {
  if (!models.length) return "";
  if (models[0]?.provider === "opencode-go") {
    const curated = models.find((model) => model.selector === "opencode-go/deepseek-v4.1-flash");
    if (curated) return curated.selector;
  }
  const subscription = models[0]?.billing === "subscription";
  const cap = role === "naming" ? 1 : 15;
  const withinCap = subscription ? models : models.filter((model) => model.cost.output <= cap);
  const paid = role === "naming" || subscription ? withinCap : withinCap.filter((model) => !model.id.endsWith(":free"));
  const floor = role === "root" ? 55 : role === "worker" ? 40 : 0;
  const withQuality = paid.filter((model) => (model.aa?.agentic ?? model.aa?.intelligence ?? 0) >= floor);
  const pool = withQuality.length ? withQuality : paid.length ? paid : withinCap.length ? withinCap : models;
  if (role === "naming") {
    return pool.slice().sort((a, b) => (a.cost.output + a.cost.input * 4) - (b.cost.output + b.cost.input * 4) || b.quality - a.quality)[0]?.selector ?? "";
  }
  const scored = pool.map((model) => {
    const blended = model.cost.input * 0.3 + model.cost.output * 0.7;
    const agentic = model.aa?.agentic ?? model.aa?.intelligence ?? model.quality * 0.9;
    if (subscription) {
      const contextBonus = Math.min(6, Math.log2(Math.max(1, model.contextWindow / 100_000)) * 2);
      const outputBonus = Math.min(3, Math.log2(Math.max(1, (model.maxTokens ?? 32_000) / 32_000)) * 0.5);
      return { model, score: agentic + contextBonus + outputBonus + (model.reasoning ? 1 : 0) };
    }
    const exponent = role === "root" ? 0.18 : 0.42;
    return { model, score: agentic / Math.pow(blended + 1, exponent) + (model.reasoning ? 0.4 : 0) };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.model.selector ?? "";
}
