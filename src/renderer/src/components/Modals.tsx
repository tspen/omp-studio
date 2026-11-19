import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Cloud,
  Copy,
  Download,
  ExternalLink,
  File,
  FileDiff,
  FileText,
  Folder,
  Globe,
  Image as ImageIcon,
  Inbox,
  Lock,
  MessageSquare,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Smartphone,
  Square,
  Terminal,
  Trash2,
  Unlock,
  Upload,
  X,
} from "lucide-react";
import type { ApprovalRequest, Artifact, ChatBlock, Checkpoint, Environment, MobileDevice, ModelInfo, Thread, TreeNode, WorkspaceFile, WorkspaceMatch, WorkspaceSymbol } from "../../../shared/types";
import { nodeAncestors, selectedNode, selectedThread, useApp } from "../store";
import { ModelPicker } from "./ModelPicker";
import { ShellsTab } from "./TerminalPane";
import { Badge, Button, Empty, Field, IconButton, Modal, Select, Spinner, StatusDot, cx, defaultNodePath, formatCost, formatNumber, relativeTime, statusLabel, truncate } from "./Common";

export function Modals() {
  const state = useApp();
  switch (state.overlay) {
    case "new-node":
      return <NewNodeModal />;
    case "new-thread":
      return <NewThreadModal />;
    case "inbox":
      return <InboxModal />;
    case "artifacts":
      return <ArtifactsModal />;
    case "sites":
      return <SitesModal />;
    case "context":
      return <ContextModal />;
    case "devices":
      return <DevicesModal />;
    case "terminal":
      return <TerminalModal />;
    case "search":
      return <SearchModal />;
    case "share":
      return <ShareModal />;
    case "preview":
      return <PreviewModal />;
    case "history":
      return <HistoryModal />;
    case "goal":
      return <GoalModal />;
    case "settings":
      return null;
    default:
      return null;
  }
}

export function ApprovalModal() {
  const state = useApp();
  const request = state.approvals.find((item) => item.kind !== "ask");
  if (!request) return null;
  return <ApprovalDialog key={request.id} request={request} />;
}

function ApprovalDialog({ request }: { request: ApprovalRequest }) {
  const state = useApp();
  const raw = (request.raw ?? {}) as any;
  const [text, setText] = useState(raw.prefill ?? "");
  const [selected, setSelected] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const questions = raw.questions ?? [];
  const cancel = () => void state.respondApproval(request.id, null);
  const submit = () => {
    if (request.kind === "confirm") void state.respondApproval(request.id, true);
    else if (request.kind === "select") void state.respondApproval(request.id, selected[0] ?? "");
    else if (request.kind === "ask") void state.respondApproval(request.id, answers);
    else void state.respondApproval(request.id, text);
  };
  return (
    <Modal
      title={request.title}
      subtitle={request.message.split("\n")[0]}
      onClose={cancel}
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          {request.kind === "confirm" ? (
            <>
              <Button variant="danger" onClick={() => void state.respondApproval(request.id, false)}>Deny</Button>
              <Button variant="primary" onClick={() => void state.respondApproval(request.id, true)}><Check size={14} /> Approve</Button>
            </>
          ) : (
            <Button variant="primary" onClick={submit} disabled={request.kind === "select" && !selected.length}><Check size={14} /> Submit</Button>
          )}
        </>
      }
    >
      {request.kind === "confirm" ? (
        <div className="approval-body"><p className="approval-message">{request.message}</p></div>
      ) : request.kind === "select" ? (
        <div className="approval-options">
          {(request.options ?? []).map((option, index) => (
            <button key={option.value} type="button" className={cx("approval-option", selected.includes(option.value) && "selected")} onClick={() => setSelected([option.value])}>
              <span className="approval-option-index">{index + 1}</span>
              <div><strong>{option.label}</strong>{option.description ? <span>{option.description}</span> : null}</div>
              {selected.includes(option.value) ? <Check size={15} /> : null}
            </button>
          ))}
        </div>
      ) : request.kind === "ask" ? (
        <div className="ask-questions">
          {questions.map((question: any) => (
            <div key={question.id} className="ask-question">
              <strong>{question.question}</strong>
              {question.options?.length ? (
                <div className="ask-options">
                  {question.options.map((option: any) => {
                    const current = answers[question.id] ?? [];
                    const active = current.includes(option.label);
                    return (
                      <button key={option.label} type="button" className={cx("ask-option", active && "selected")} onClick={() => {
                        setAnswers({ ...answers, [question.id]: question.multi ? (active ? current.filter((item) => item !== option.label) : [...current, option.label]) : [option.label] });
                      }}>
                        <span>{option.label}</span>
                        {option.description ? <small>{option.description}</small> : null}
                        {active ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <input placeholder="Or type a custom answer…" onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value ? [event.target.value] : [] })} />
            </div>
          ))}
        </div>
      ) : (
        <textarea className="approval-input" autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="Type a response…" />
      )}
    </Modal>
  );
}

function ModelField({
  label,
  value,
  onChange,
  role,
  hint,
}: {
  label: string;
  value: string;
  onChange: (selector: string) => void;
  role: "group" | "project" | "worker";
  hint?: string;
}) {
  const state = useApp();
  const [open, setOpen] = useState(false);
  const model = state.models.find((item) => item.selector === value) ?? state.models[0];
  return (
    <>
      <Field label={label} hint={hint}>
        <button type="button" className="model-choice" onClick={() => setOpen(true)}>
          <span className="model-choice-main">
            <strong>{model?.name ?? "Choose a model"}</strong>
            <span>{model ? `${model.quality.toFixed(0)} quality · ${formatNumber(model.contextWindow)} context${model.reasoning ? " · reasoning" : ""}` : "No model selected"}</span>
          </span>
          <span className={model?.included ? "model-choice-included" : "model-choice-price"}>
            {model?.included ? "included in plan" : model ? `${formatCost(model.cost.input)} in / ${formatCost(model.cost.output)} out` : ""}
          </span>
          <ChevronDown size={14} />
        </button>
      </Field>
      {open ? (
        <div className="picker-layer modal-picker-layer" onMouseDown={() => setOpen(false)}>
          <ModelPicker
            models={state.models}
            value={value}
            role={role}
            onSelect={(selector: string) => {
              onChange(selector);
              setOpen(false);
            }}
            onClose={() => setOpen(false)}
          />
        </div>
      ) : null}
    </>
  );
}

function NewNodeModal() {
  const state = useApp();
  const nodes = state.snapshot?.nodes ?? [];
  const selected = selectedNode(state);
  const parent = selected?.type === "project" ? nodes.find((node) => node.id === selected.parentId) : selected;
  const [type, setType] = useState<"group" | "project">("project");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [brief, setBrief] = useState("");
  const [model, setModel] = useState(state.snapshot?.settings.models.project ?? "");
  const [gitInit, setGitInit] = useState(false);
  const suggestedPath = useMemo(
    () => defaultNodePath(name, state.snapshot?.workspaceRoot),
    [name, state.snapshot?.workspaceRoot],
  );
  const effectivePath = pathTouched ? path : suggestedPath;
  if (!parent) return null;
  return (
    <Modal
      title={type === "group" ? "New group" : "New project"}
      subtitle={`Under ${parent.name}. ${type === "group" ? "A group coordinates multiple projects." : "A project owns a repository and can spawn worker threads."}`}
      onClose={() => state.setOverlay("none")}
      width={680}
      footer={
        <>
          <Button variant="ghost" onClick={() => state.setOverlay("none")}>Cancel</Button>
          <Button variant="primary" onClick={() => void state.createNode({ parentId: parent.id, type, name, path: pathTouched ? path || undefined : undefined, brief: brief || undefined, model: model || undefined, gitInit })}>
            <Plus size={14} /> Create {type}
          </Button>
        </>
      }
    >
      <div className="modal-form">
        <div className="type-switch">
          <button type="button" className={cx(type === "group" && "active")} onClick={() => setType("group")}><Folder size={15} /> Group</button>
          <button type="button" className={cx(type === "project" && "active")} onClick={() => setType("project")}><FileDiff size={15} /> Project</button>
        </div>
        <Field label="Name" hint="Leave blank to auto-name from the brief or first child."><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder={type === "group" ? "Auto-name group" : "Auto-name project"} /></Field>
        <Field label="Path" hint={type === "group" ? "Optional workspace directory for the group orchestrator. Defaults to a folder named after the group under your workspace root." : "Repository path. Defaults to a folder named after the project under your workspace root; browse to use an existing repository."}>
          <div className="inline-actions"><input value={effectivePath} onChange={(event) => { setPathTouched(true); setPath(event.target.value); }} placeholder={name.trim() ? suggestedPath : "Type a name for a default folder, or browse"} /><Button size="sm" variant="soft" onClick={async () => { const picked = await window.perch.pickDirectory(); if (picked) { setPathTouched(true); setPath(picked); } }}><Folder size={13} /> Browse</Button></div>
        </Field>
        {type === "project" ? (
          <label className="inline-check"><input type="checkbox" checked={gitInit} onChange={(event) => setGitInit(event.target.checked)} /> Initialize a git repository if needed</label>
        ) : null}
        <ModelField
          label="Orchestrator model"
          value={model}
          onChange={setModel}
          role={type === "group" ? "group" : "project"}
          hint="Defaults to your project model. Search the full Pi catalog."
        />
        <Field label="Brief" hint="Optional. Sent to the new orchestrator as its first task.">
          <textarea rows={5} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="What should this group/project own? Constraints, definition of done, first milestone…" />
        </Field>
      </div>
    </Modal>
  );
}

function NewThreadModal() {
  const state = useApp();
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const [brief, setBrief] = useState("");
  const [title, setTitle] = useState("");
  const [model, setModel] = useState(state.snapshot?.settings.models.worker ?? "");
  const [effort, setEffort] = useState("high");
  const [isolation, setIsolation] = useState("auto");
  const [wait, setWait] = useState(false);
  const models = useMemo(() => [...state.models].sort((a, b) => b.quality - a.quality), [state.models]);
  if (!node) return null;
  return (
    <Modal
      title="Spawn a worker thread"
      subtitle={`Under ${node.name}. The worker gets its own context${node.type === "project" ? " and optional git worktree" : ""}.`}
      onClose={() => state.setOverlay("none")}
      width={660}
      footer={
        <>
          <Button variant="ghost" onClick={() => state.setOverlay("none")}>Cancel</Button>
          <Button variant="primary" disabled={!brief.trim()} onClick={() => void state.createThread({ nodeId: node.id, parentThreadId: thread?.id, title: title || undefined, brief, model: model || undefined, effort, isolation, wait })}>
            <ArrowRight size={14} /> Spawn
          </Button>
        </>
      }
    >
      <div className="modal-form">
        <Field label="Brief" hint="The worker cannot see the parent transcript. Include objective, constraints, and definition of done.">
          <textarea autoFocus rows={7} value={brief} onChange={(event) => setBrief(event.target.value)} placeholder="Implement X. Files: … Constraints: … Verify with: … Report back with: …" />
        </Field>
        <div className="two-col">
          <Field label="Title" hint="Auto-named if blank."><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Auto" /></Field>
          <Field label="Effort">
            <Select value={effort} onChange={setEffort}>
              {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((item) => <option key={item} value={item}>{item}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Model">
          <Select value={model} onChange={setModel}>
            {models.map((item) => <option key={item.selector} value={item.selector}>{item.name} · {item.quality.toFixed(0)} · {formatCost(item.cost.output)}/M out</option>)}
          </Select>
        </Field>
        {node.type === "project" ? (
          <Field label="Git isolation" hint="Auto lets the project orchestrator decide. Worktree creates a branch and separate directory.">
            <Select value={isolation} onChange={setIsolation}>
              <option value="auto">Auto (orchestrator decides)</option>
              <option value="shared">Shared checkout</option>
              <option value="branch">Branch per worker</option>
              <option value="worktree">Worktree per worker</option>
            </Select>
          </Field>
        ) : null}
        <label className="inline-check"><input type="checkbox" checked={wait} onChange={(event) => setWait(event.target.checked)} /> Wait for the worker to finish before closing this dialog</label>
      </div>
    </Modal>
  );
}

function InboxModal() {
  const state = useApp();
  const [tab, setTab] = useState<"needs" | "notifications">("needs");
  const pending = state.inbox;
  return (
    <Modal title="Inbox" subtitle="Decisions and reports from the tree, plus system notifications." onClose={() => state.setOverlay("none")} width={820}>
      <div className="inbox-tabs">
        <button type="button" className={cx(tab === "needs" && "active")} onClick={() => setTab("needs")}><MessageSquare size={14} /> Needs you <Badge tone="amber">{pending.length}</Badge></button>
        <button type="button" className={cx(tab === "notifications" && "active")} onClick={() => setTab("notifications")}><Bell size={14} /> Notifications <Badge tone="neutral">{state.notifications.filter((item) => !item.read).length}</Badge></button>
      </div>
      <div className="inbox-toolbar">
        {tab === "notifications" ? (
          <>
            <Button size="sm" variant="soft" disabled={!state.notifications.some((item) => !item.read)} onClick={() => void state.markAllNotificationsRead()}>Mark all read</Button>
            <Button size="sm" variant="ghost" disabled={!state.notifications.length} onClick={() => { if (confirm("Clear all notifications?")) void state.clearNotifications(); }}>Clear</Button>
          </>
        ) : (
          <span>{pending.length ? "Answer a question to clear it from Needs you." : ""}</span>
        )}
      </div>
      {tab === "needs" ? (
        <div className="inbox-list">
          {pending.map((envelope) => {
            const from = state.snapshot?.threads.find((thread) => thread.id === envelope.fromThreadId);
            return (
              <button key={envelope.id} type="button" className="inbox-item" onClick={() => { state.setOverlay("none"); void state.selectThread(envelope.toThreadId, envelope.toNodeId); state.setRightTab("bus"); }}>
                <div className="inbox-item-icon"><MessageSquare size={15} /></div>
                <div>
                  <strong>{envelope.subject}</strong>
                  <span>from {from?.title ?? envelope.fromThreadId} · {envelope.kind} · {relativeTime(envelope.createdAt)}</span>
                  <p>{truncate(envelope.body, 180)}</p>
                </div>
                <ChevronRight size={15} />
              </button>
            );
          })}
          {!pending.length ? <Empty icon={<Inbox size={22} />} title="Nothing waiting" body="Questions and reports from the tree will collect here." /> : null}
        </div>
      ) : (
        <div className="inbox-list">
          {state.notifications.map((notification) => (
            <button key={notification.id} type="button" className={cx("inbox-item", notification.read && "read")} onClick={() => { void state.markNotificationRead(notification.id); if (notification.threadId) { state.setOverlay("none"); void state.selectThread(notification.threadId, notification.nodeId); } }}>
              <div className="inbox-item-icon">{notification.kind === "error" ? <CircleAlert size={15} /> : <Bell size={15} />}</div>
              <div><strong>{notification.title}</strong><span>{notification.body} · {relativeTime(notification.createdAt)}</span></div>
              {!notification.read ? <span className="unread-dot" /> : null}
            </button>
          ))}
          {!state.notifications.length ? <Empty icon={<Bell size={22} />} title="No notifications" /> : null}
        </div>
      )}
    </Modal>
  );
}

function ArtifactsModal() {
  const state = useApp();
  useEffect(() => { void state.loadArtifacts(); }, []);
  return (
    <Modal title="Artifacts" subtitle="Files, diffs and reports produced by threads." onClose={() => state.setOverlay("none")} width={780}>
      <div className="artifact-grid">
        {state.artifacts.map((artifact) => (
          <button key={artifact.id} type="button" className="artifact-card" onClick={async () => {
            const full = await window.perch.readArtifact(artifact.id);
            const image = isImage(full.path ?? artifact.name);
            state.openPreview({
              title: artifact.name,
              kind: image ? "image" : artifact.kind === "diff" ? "diff" : "artifact",
              content: image ? "" : full.content ?? full.path ?? "",
              path: full.path,
            });
          }}>
            <div className="artifact-icon">{isImage(artifact.path ?? artifact.name) ? <ImageIcon size={18} /> : artifact.kind === "diff" ? <FileDiff size={18} /> : <FileText size={18} />}</div>
            <strong>{artifact.name}</strong>
            <span>{artifact.kind} · {artifact.size ? `${formatNumber(artifact.size)} bytes` : relativeTime(artifact.createdAt)}</span>
            {artifact.meta?.threadTitle ? <small>{String(artifact.meta.threadTitle)}</small> : null}
          </button>
        ))}
        {!state.artifacts.length ? <Empty icon={<File size={22} />} title="No artifacts yet" body="Edits, diffs and thread reports will appear here." /> : null}
      </div>
    </Modal>
  );
}

function SitesModal() {
  const state = useApp();
  const projects = useMemo(() => (state.snapshot?.nodes ?? []).filter((node) => node.type === "project"), [state.snapshot?.nodes]);
  const fallbackNodeId = projects.find((node) => node.id === state.selectedNodeId)?.id ?? projects[0]?.id ?? "";
  const [name, setName] = useState("");
  const [path, setPath] = useState(".");
  const [nodeId, setNodeId] = useState(fallbackNodeId);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    void state.loadSites();
  }, []);
  useEffect(() => {
    if (!nodeId && fallbackNodeId) setNodeId(fallbackNodeId);
  }, [fallbackNodeId, nodeId]);
  const nodeName = (id: string) => state.snapshot?.nodes.find((node) => node.id === id)?.name ?? "Unknown project";

  const create = async () => {
    if (!name.trim() || !nodeId) return;
    setBusy("create");
    try {
      const site = await window.perch.createSite({ name: name.trim(), nodeId, path: path.trim() || "." });
      await state.publishSite(site.id);
      setName("");
      await state.loadSites();
    } catch (error) {
      state.pushToast({ kind: "error", title: "Could not create site", body: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const republish = async (id: string) => {
    setBusy(id);
    try {
      await state.publishSite(id);
    } catch (error) {
      state.pushToast({ kind: "error", title: "Publish failed", body: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const deploy = async (id: string, provider: "cloudflare" | "github-pages") => {
    setBusy(`${id}-${provider}`);
    try {
      const deployment = await window.perch.deploySite(id, provider);
      state.pushToast({
        kind: "success",
        title: provider === "cloudflare" ? "Deployed to Cloudflare Pages" : "Deployed to GitHub Pages",
        body: deployment.url ?? deployment.detail,
      });
      if (deployment.url) state.openBrowser(deployment.url);
      await state.loadSites();
    } catch (error) {
      state.pushToast({ kind: "error", title: "Deploy failed", body: String(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal title="Sites" subtitle="Publish a folder from a project to a local URL and open it in the in-app browser." onClose={() => state.setOverlay("none")} width={900}>
      <div className="site-create">
        <Field label="Name">
          <input value={name} placeholder="Landing page" onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Folder" hint="Relative to the project, or pick any folder.">
          <div className="inline-actions">
            <input value={path} onChange={(event) => setPath(event.target.value)} />
            <IconButton icon={<Folder size={14} />} label="Pick folder" onClick={async () => {
              const picked = await window.perch.pickDirectory();
              if (picked) {
                setPath(picked);
                if (!name.trim()) setName(picked.split(/[\\/]/).filter(Boolean).pop() ?? "Site");
              }
            }} />
          </div>
        </Field>
        <Field label="Project">
          <Select value={nodeId} onChange={setNodeId}>
            {projects.map((node) => <option key={node.id} value={node.id}>{node.name}</option>)}
          </Select>
        </Field>
        <Button variant="primary" size="sm" disabled={!name.trim() || !nodeId || busy === "create"} onClick={() => void create()}>
          {busy === "create" ? <Spinner /> : <Rocket size={13} />} Create & publish
        </Button>
      </div>

      <div className="site-grid">
        {state.sites.map((site) => {
          const version = site.versions.find((item) => item.id === site.currentVersion) ?? site.versions[0];
          return (
            <div key={site.id} className="site-card">
              <div className="site-card-head">
                <div className="site-icon"><Globe size={16} /></div>
                <div className="site-card-title">
                  <strong>{site.name}</strong>
                  <span>{nodeName(site.nodeId)}</span>
                </div>
                <Badge tone={site.currentVersion ? "green" : "neutral"}>{site.currentVersion ? "live" : "draft"}</Badge>
              </div>
              <div className="site-url mono">{site.url || "Not published yet"}</div>
              <div className="site-meta">
                <span>{version ? `${version.files} files` : "no files"}</span>
                <span>{version ? `${formatNumber(version.bytes)} bytes` : ""}</span>
                <span>{site.versions.length} version{site.versions.length === 1 ? "" : "s"}</span>
                <span>{relativeTime(site.updatedAt)}</span>
              </div>
              <div className="site-path" title={site.sourcePath}>{truncate(site.sourcePath, 58)}</div>
              {(site.deployments ?? []).length ? (
                <div className="site-deployments">
                  {(site.deployments ?? []).slice(0, 2).map((deployment) => (
                    <button key={deployment.id} type="button" className="site-deployment" onClick={() => deployment.url && state.openBrowser(deployment.url)}>
                      <Cloud size={11} /> {deployment.provider === "cloudflare" ? "Cloudflare" : "GitHub Pages"} · {deployment.url?.replace(/^https?:\/\//, "") ?? deployment.status}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="site-actions">
                <Button size="sm" variant="primary" disabled={!site.url} onClick={() => { state.openBrowser(site.url); state.setOverlay("none"); }}><ExternalLink size={12} /> Open</Button>
                <Button size="sm" variant="soft" disabled={!site.url} onClick={() => { const link = site.accessToken ? `${site.url}?t=${site.accessToken}` : site.url; void navigator.clipboard.writeText(link); state.pushToast({ kind: "info", title: site.accessToken ? "Protected URL copied" : "URL copied", body: link }); }}><Copy size={12} /> Copy</Button>
                <Button size="sm" variant="soft" disabled={busy === site.id} onClick={() => void republish(site.id)}>{busy === site.id ? <Spinner /> : <Share2 size={12} />} Publish</Button>
                <IconButton icon={site.accessToken ? <Lock size={13} /> : <Unlock size={13} />} label={site.accessToken ? "Remove access token" : "Protect with an access token"} onClick={async () => {
                  await window.perch.setSiteAccess(site.id, !site.accessToken);
                  await state.loadSites();
                  state.pushToast({ kind: "info", title: site.accessToken ? "Site is public" : "Site protected", body: site.accessToken ? "Anyone on this machine can open it." : "Share the copy link, which includes the token." });
                }} />
                <IconButton icon={<Cloud size={13} />} label="Deploy to Cloudflare Pages" onClick={() => void deploy(site.id, "cloudflare")} disabled={busy !== null} />
                <IconButton icon={<Globe size={13} />} label="Add Cloudflare custom domain" onClick={async () => {
                  const domain = window.prompt("Custom domain for the Cloudflare Pages project", `${site.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pages.dev`);
                  if (!domain) return;
                  setBusy(`${site.id}-domain`);
                  try {
                    const result = await window.perch.addSiteDomain(site.id, domain.trim());
                    state.pushToast({ kind: "success", title: "Domain added", body: result.output });
                  } catch (error) {
                    state.pushToast({ kind: "error", title: "Could not add domain", body: String(error) });
                  } finally {
                    setBusy(null);
                  }
                }} disabled={busy !== null} />
                <IconButton icon={<ShieldCheck size={13} />} label="Protect custom domain with Cloudflare Access" onClick={async () => {
                  const domain = window.prompt("Domain to protect with Cloudflare Access", `${site.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.pages.dev`);
                  if (!domain) return;
                  const emails = window.prompt("Allowed emails (comma separated)", "");
                  if (!emails) return;
                  setBusy(`${site.id}-access`);
                  try {
                    const result = await window.perch.configureCloudflareAccess(site.id, domain.trim(), emails.split(",").map((email) => email.trim()).filter(Boolean));
                    state.pushToast({ kind: "success", title: "Cloudflare Access configured", body: result.output });
                  } catch (error) {
                    state.pushToast({ kind: "error", title: "Cloudflare Access failed", body: String(error) });
                  } finally {
                    setBusy(null);
                  }
                }} disabled={busy !== null} />
                <IconButton icon={<Upload size={13} />} label="Deploy to GitHub Pages" onClick={() => void deploy(site.id, "github-pages")} disabled={busy !== null} />
                <IconButton icon={<Trash2 size={13} />} label="Delete site" onClick={async () => {
                  if (confirm(`Delete ${site.name}? Published files are removed.`)) await state.deleteSite(site.id);
                }} />
              </div>
            </div>
          );
        })}
        {!state.sites.length ? (
          <Empty icon={<Globe size={22} />} title="No sites yet" body="Point a project at an HTML folder, then publish it. The agent can also create sites with site_create." />
        ) : null}
      </div>
    </Modal>
  );
}

function TerminalModal() {
  const state = useApp();
  const [tab, setTab] = useState<"shells" | "runs">("shells");
  return (
    <Modal title="Terminal" subtitle="Persistent shells with preview URL detection, or one-off command runs." onClose={() => state.setOverlay("none")} width={1000} className="terminal-modal">
      <div className="modal-tabs">
        <button type="button" className={cx("modal-tab", tab === "shells" && "active")} onClick={() => setTab("shells")}>Shells</button>
        <button type="button" className={cx("modal-tab", tab === "runs" && "active")} onClick={() => setTab("runs")}>Command runs</button>
      </div>
      {tab === "shells" ? <ShellsTab /> : <CommandRuns />}
    </Modal>
  );
}

function CommandRuns() {
  const state = useApp();
  const [command, setCommand] = useState("");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const thread = selectedThread(state);
  useEffect(() => { void state.loadTerminals(); }, []);
  const run = state.terminalRuns.find((item) => item.id === selectedRun) ?? state.terminalRuns[0];
  return (
    <div className="terminal-layout">
      <div className="terminal-runs">
        {state.terminalRuns.map((item) => (
          <button key={item.id} type="button" className={cx("terminal-run", run?.id === item.id && "active")} onClick={() => setSelectedRun(item.id)}>
            <span className={cx("run-dot", item.status)} />
            <span className="mono">{truncate(item.command, 30)}</span>
            <span>{relativeTime(item.startedAt)}</span>
          </button>
        ))}
        {!state.terminalRuns.length ? <p className="muted">No commands yet.</p> : null}
      </div>
      <div className="terminal-main">
        <div className="terminal-output">{run?.output || "Run a command to see output."}</div>
        <div className="terminal-input">
          <span>$</span>
          <input value={command} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && command.trim()) { void state.runTerminal(command); setCommand(""); } }} placeholder="npm test" />
          <Button size="sm" variant="primary" disabled={!command.trim()} onClick={() => { void state.runTerminal(command); setCommand(""); }}><Play size={13} /> Run</Button>
          {run?.status === "running" ? <Button size="sm" variant="ghost" onClick={() => void window.perch.killTerminal(run.id)}><Square size={12} /> Stop</Button> : null}
        </div>
      </div>
    </div>
  );
}

function DevicesModal() {
  const state = useApp();
  const [status, setStatus] = useState<{ adb: boolean; emulator: boolean } | null>(null);
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  const [avds, setAvds] = useState<string[]>([]);
  const [serial, setSerial] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    setStatus(await window.perch.mobileStatus());
    setDevices(await window.perch.listMobileDevices());
    setAvds(await window.perch.listAvds());
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!serial && devices.length) setSerial(devices.find((device) => device.state === "device")?.serial ?? devices[0].serial);
  }, [devices, serial]);

  const shoot = async () => {
    setBusy("shot");
    try {
      const result = await window.perch.mobileScreenshot(serial || undefined);
      setShot(result.path);
    } catch (error) {
      state.pushToast({ kind: "error", title: "Screenshot failed", body: String(error) });
    } finally {
      setBusy(null);
    }
  };

  const tapAt = async (event: React.MouseEvent<HTMLImageElement>) => {
    if (!shot) return;
    const image = event.currentTarget;
    const rect = image.getBoundingClientRect();
    const x = Math.round(((event.clientX - rect.left) / rect.width) * image.naturalWidth);
    const y = Math.round(((event.clientY - rect.top) / rect.height) * image.naturalHeight);
    try {
      await window.perch.mobileTap(serial || undefined, x, y);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await shoot();
    } catch (error) {
      state.pushToast({ kind: "error", title: "Tap failed", body: String(error) });
    }
  };

  return (
    <Modal title="Devices" subtitle="Android emulators and devices through adb. iOS simulators require macOS." onClose={() => state.setOverlay("none")} width={900}>
      {!status ? <div className="settings-loading"><Spinner /> Checking Android tools</div> : null}
      {status && !status.adb ? (
        <div className="device-missing">
          <Smartphone size={26} />
          <strong>adb not found</strong>
          <p>Install Android platform-tools and add them to PATH to control emulators and devices.</p>
          <Button size="sm" variant="soft" onClick={() => void window.perch.openExternal("https://developer.android.com/tools/releases/platform-tools")}><ExternalLink size={12} /> Download platform-tools</Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}><RefreshCw size={12} /> Check again</Button>
        </div>
      ) : null}
      {status?.adb ? (
        <div className="device-layout">
          <div className="device-side">
            <div className="device-side-head"><strong>Devices</strong><IconButton icon={<RefreshCw size={13} />} label="Refresh" onClick={() => void load()} /></div>
            {devices.map((device) => (
              <button key={device.serial} type="button" className={cx("device-row", serial === device.serial && "active")} onClick={() => setSerial(device.serial)}>
                <span className={cx("run-dot", device.state === "device" ? "running" : "done")} />
                <span className="device-name">{device.model ?? device.serial}<small>{device.serial} · {device.state}</small></span>
              </button>
            ))}
            {!devices.length ? <p className="rail-empty">No running devices.</p> : null}
            <div className="device-side-head"><strong>AVDs</strong></div>
            {avds.map((avd) => (
              <div key={avd} className="device-row">
                <span className="device-name">{avd}</span>
                <Button size="sm" variant="ghost" disabled={busy === avd} onClick={async () => {
                  setBusy(avd);
                  try {
                    await window.perch.startAvd(avd);
                    state.pushToast({ kind: "info", title: "Emulator starting", body: avd });
                    setTimeout(() => void load(), 12_000);
                  } finally {
                    setBusy(null);
                  }
                }}><Play size={11} /> Start</Button>
              </div>
            ))}
            {!avds.length ? <p className="rail-empty">No AVDs. Create one in Android Studio.</p> : null}
          </div>
          <div className="device-main">
            <div className="device-bar">
              <span>{serial || "No device selected"}</span>
              <Button size="sm" variant="soft" disabled={!serial || busy === "shot"} onClick={() => void shoot()}>{busy === "shot" ? <Spinner /> : <Smartphone size={12} />} Screenshot</Button>
              <input className="device-text" value={text} onChange={(event) => setText(event.target.value)} placeholder="Type text or a keyevent" />
              <Button size="sm" variant="ghost" disabled={!text} onClick={async () => { await window.perch.mobileText(serial || undefined, text); setText(""); await new Promise((r) => setTimeout(r, 400)); await shoot(); }}>Type</Button>
              <Button size="sm" variant="ghost" disabled={!text} onClick={async () => { await window.perch.mobileKey(serial || undefined, text); setText(""); await new Promise((r) => setTimeout(r, 400)); await shoot(); }}>Key</Button>
              <Button size="sm" variant="ghost" onClick={async () => { await window.perch.mobileKey(serial || undefined, "KEYCODE_BACK"); }}>Back</Button>
            </div>
            {shot ? (
              <img className="device-shot" src={fileUrl(shot)} alt="Android device" onClick={(event) => void tapAt(event)} title="Click to tap at this point" />
            ) : (
              <div className="device-empty">
                <Smartphone size={30} />
                <p>Select a device, then take a screenshot. Click the screenshot to tap.</p>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}

function ContextModal() {
  const state = useApp();
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const [tab, setTab] = useState<"files" | "symbols" | "text">("files");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [symbols, setSymbols] = useState<WorkspaceSymbol[]>([]);
  const [matches, setMatches] = useState<WorkspaceMatch[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        if (tab === "files") {
          const result = await window.perch.listWorkspaceFiles({ nodeId: node?.id, threadId: thread?.id, query, limit: 100 });
          if (!cancelled) setFiles(result);
        } else if (tab === "symbols") {
          const result = await window.perch.searchWorkspaceSymbols({ nodeId: node?.id, threadId: thread?.id, query, limit: 100 });
          if (!cancelled) setSymbols(result);
        } else if (query.trim().length >= 2) {
          const result = await window.perch.searchWorkspaceContent({ nodeId: node?.id, threadId: thread?.id, query, limit: 100 });
          if (!cancelled) setMatches(result);
        } else if (!cancelled) {
          setMatches([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 140);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, tab, node?.id, thread?.id]);

  const choose = (text: string) => {
    state.insertComposer(text);
    state.setOverlay("none");
  };

  return (
    <Modal title="Add context" subtitle="Reference files and symbols, or attach images and text from the composer." onClose={() => state.setOverlay("none")} width={760}>
      <div className="modal-tabs">
        <button type="button" className={cx("modal-tab", tab === "files" && "active")} onClick={() => setTab("files")}>Files</button>
        <button type="button" className={cx("modal-tab", tab === "symbols" && "active")} onClick={() => setTab("symbols")}>Symbols</button>
        <button type="button" className={cx("modal-tab", tab === "text" && "active")} onClick={() => setTab("text")}>Text</button>
        <span className="browser-devspace" />
        {loading ? <Spinner size={13} /> : null}
      </div>
      <div className="context-search">
        <Search size={13} />
        <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "files" ? "Search files by name or path" : tab === "symbols" ? "Search functions, classes and types" : "Search text across the project"} />
        <span>{tab === "files" ? `${files.length} files` : tab === "symbols" ? `${symbols.length} symbols` : `${matches.length} matches`}</span>
      </div>
      <div className="context-list">
        {tab === "files"
          ? files.map((file) => (
              <button key={file.path} type="button" className="context-row" onClick={() => choose(`@${file.path}`)}>
                <File size={13} />
                <span className="context-name">{file.name}</span>
                <span className="context-dir">{file.dir}</span>
                <span className="context-meta">{formatNumber(file.size)} B</span>
              </button>
            ))
          : tab === "symbols"
            ? symbols.map((symbol) => (
                <button key={`${symbol.path}:${symbol.line}:${symbol.name}`} type="button" className="context-row" onClick={() => choose(`@${symbol.path}:${symbol.line} ${symbol.name}`)}>
                  <FileText size={13} />
                  <span className="context-name">{symbol.name}</span>
                  <span className="context-dir">{symbol.kind} · {symbol.path}:{symbol.line}</span>
                </button>
              ))
            : matches.map((match) => (
                <button key={`${match.path}:${match.line}`} type="button" className="context-row" onClick={() => choose(`@${match.path}:${match.line}`)}>
                  <Search size={13} />
                  <span className="context-name">{match.path}:{match.line}</span>
                  <span className="context-dir">{match.preview}</span>
                </button>
              ))}
        {tab === "files" && !files.length ? <p className="rail-empty">No files match.</p> : null}
        {tab === "symbols" && !symbols.length ? <p className="rail-empty">No symbols match. Type a file or symbol name.</p> : null}
        {tab === "text" && !matches.length ? <p className="rail-empty">Type at least two characters to search file contents.</p> : null}
      </div>
    </Modal>
  );
}

function SearchModal() {
  const state = useApp();
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<"threads" | "nodes">("threads");
  const threads = (state.snapshot?.threads ?? []).filter((thread) => !query || thread.title.toLowerCase().includes(query.toLowerCase()) || thread.lastMessage?.toLowerCase().includes(query.toLowerCase()));
  const nodes = (state.snapshot?.nodes ?? []).filter((node) => !query || node.name.toLowerCase().includes(query.toLowerCase()) || node.path.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title="Search" subtitle="Threads, projects and groups." onClose={() => state.setOverlay("none")} width={720}>
      <div className="search-modal">
        <div className="search-input"><Search size={16} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search…" /></div>
        <div className="segmented"><button type="button" className={cx(tab === "threads" && "active")} onClick={() => setTab("threads")}>Threads {threads.length}</button><button type="button" className={cx(tab === "nodes" && "active")} onClick={() => setTab("nodes")}>Tree {nodes.length}</button></div>
        <div className="search-results">
          {tab === "threads" ? threads.map((thread) => (
            <button key={thread.id} type="button" className="search-result" onClick={() => { state.setOverlay("none"); void state.selectThread(thread.id, thread.nodeId); }}>
              <StatusDot status={thread.status} />
              <div><strong>{thread.title}</strong><span>{thread.kind} · {thread.model.name} · {thread.lastMessage ?? "No messages"}</span></div>
              <span className="muted">{relativeTime(thread.lastActivityAt)}</span>
            </button>
          )) : nodes.map((node) => (
            <button key={node.id} type="button" className="search-result" onClick={() => { state.setOverlay("none"); void state.selectNode(node.id); }}>
              <div><strong>{node.name}</strong><span>{node.type} · {node.path}</span></div>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ShareModal() {
  const state = useApp();
  return (
    <Modal title="Live share" subtitle="Read-only live transcript in the browser. The link is local to this machine." onClose={() => state.setOverlay("none")} width={620}>
      <div className="share-modal">
        <div className="share-url"><input readOnly value={state.share?.url ?? ""} /><Button size="sm" variant="soft" onClick={() => { if (state.share) { void navigator.clipboard.writeText(state.share.url); state.pushToast({ kind: "success", title: "Link copied" }); } }}><Copy size={13} /> Copy</Button></div>
        <div className="share-actions">
          <Button variant="soft" onClick={() => state.share && void window.perch.openExternal(state.share.url)}><ExternalLink size={14} /> Open in browser</Button>
          <Button variant="danger" onClick={() => void state.stopShare()}><X size={14} /> Stop sharing</Button>
        </div>
        <p className="muted">Guests can read messages and tool activity, but cannot steer. The server binds to 127.0.0.1 and uses an unguessable token.</p>
      </div>
    </Modal>
  );
}

const TEXT_PREVIEW_EXTENSIONS = new Set([
  "txt", "md", "markdown", "json", "jsonl", "log", "diff", "patch", "csv", "tsv",
  "ts", "tsx", "js", "jsx", "css", "html", "xml", "yml", "yaml", "toml", "ini",
  "sql", "py", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "rb", "php",
  "kt", "swift", "scala", "sh", "bash", "lua", "ex", "exs", "hs", "ipynb",
]);

function isTextPreview(path: string | undefined, content: string): boolean {
  const extension = path?.split(".").pop()?.toLowerCase() ?? "";
  if (path && extension && !TEXT_PREVIEW_EXTENSIONS.has(extension)) return false;
  return !/[\u0000-\u0008\u000e-\u001f]/.test(content.slice(0, 2048));
}

function PreviewModal() {
  const state = useApp();
  const preview = state.preview;
  if (!preview) return null;
  const binary = preview.kind !== "image" && preview.kind !== "diff" && !isTextPreview(preview.path, preview.content);
  return (
    <Modal title={preview.title} subtitle={preview.path} onClose={() => state.setOverlay("none")} width={1000} className="preview-modal">
      {preview.kind === "image" ? (
        <div className="preview-image-wrap">
          <img src={fileUrl(preview.path)} alt={preview.title} />
          {preview.path ? <Button size="sm" variant="soft" onClick={() => void window.perch.openPath(preview.path!)}><ExternalLink size={13} /> Open file</Button> : null}
        </div>
      ) : preview.kind === "diff" ? (
        preview.review ? <DiffReview preview={preview} review={preview.review} /> : <DiffView text={preview.content} />
      ) : binary ? (
        <div className="preview-file">
          <File size={28} />
          <strong>{preview.title}</strong>
          <span>This file type opens in its default app instead of inline.</span>
          {preview.path ? <Button size="sm" variant="soft" onClick={() => void window.perch.openPath(preview.path!)}><ExternalLink size={13} /> Open file</Button> : null}
        </div>
      ) : <pre className="file-preview">{preview.content || "No content."}</pre>}
    </Modal>
  );
}

function DiffReview({ preview, review }: { preview: { content: string; path?: string; title: string }; review: { nodeId: string; threadId?: string; path: string } }) {
  const state = useApp();
  const [comments, setComments] = useState<Array<{ line: number; text: string }>>([]);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [approved, setApproved] = useState<Record<number, boolean>>({});
  const [busy, setBusy] = useState(false);
  const lines = preview.content.split("\n");
  const firstHunk = lines.findIndex((line) => line.startsWith("@@"));
  const preamble = firstHunk > 0 ? lines.slice(0, firstHunk) : [];
  const hunks: Array<{ header: string; lines: string[]; index: number }> = [];
  for (let index = Math.max(0, firstHunk); index < lines.length; index += 1) {
    if (lines[index].startsWith("@@")) {
      hunks.push({ header: lines[index], lines: [], index: hunks.length });
    } else if (hunks.length) {
      hunks[hunks.length - 1].lines.push(lines[index]);
    }
  }

  const addComment = () => {
    if (activeLine === null || !comment.trim()) return;
    setComments((items) => [...items, { line: activeLine, text: comment.trim() }]);
    setComment("");
    setActiveLine(null);
  };

  const askAgent = async () => {
    const threadId = review.threadId ?? state.selectedThreadId;
    if (!threadId || !comments.length) return;
    setBusy(true);
    try {
      const body = [
        `Review comments on ${review.path}:`,
        ...comments.map((item) => `- Line ${item.line}: ${item.text}`),
        "",
        "Address each comment in the working tree, keep the rest of the change intact, verify the result, then report what changed. Do not discard unrelated work.",
      ].join("\n");
      await window.perch.send({ threadId, text: body });
      state.pushToast({ kind: "success", title: "Comments sent to agent", body: `${comments.length} comment(s) on ${review.path}` });
      state.setOverlay("none");
    } catch (error) {
      state.pushToast({ kind: "error", title: "Could not send comments", body: String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="diff-review">
      <div className="diff-review-body">
        <pre className="diff-view">
          {lines.map((line, index) => {
            const className = line.startsWith("+++") || line.startsWith("---") ? "diff-same" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : line.startsWith("@@") ? "diff-hunk" : "diff-same";
            const canComment = line.startsWith("+") || line.startsWith("-") || line.startsWith(" ");
            return (
              <div key={index} className={cx(className, "diff-line")}>
                <span className="diff-marker">{line.startsWith("+++") || line.startsWith("---") ? " " : line[0] === "+" || line[0] === "-" ? line[0] : " "}</span>
                <span className="diff-text">{line.replace(/^[+-]/, "")}</span>
                {canComment && line && !line.startsWith("@@") ? (
                  <button type="button" className="diff-comment-btn" title={`Comment on line ${index + 1}`} onClick={() => setActiveLine(index + 1)}>+</button>
                ) : null}
                {comments.filter((item) => item.line === index + 1).map((item) => (
                  <span key={item.text} className="diff-comment-chip" title={item.text}>💬 {item.text.slice(0, 60)}</span>
                ))}
              </div>
            );
          })}
        </pre>
      </div>
      <div className="diff-side">
        <div className="diff-hunks">
          {hunks.map((hunk) => (
            <div key={hunk.index} className="diff-hunk-row">
              <span className="mono">{hunk.header.slice(0, 40)}</span>
              {approved[hunk.index] ? (
                <Badge tone="green">approved</Badge>
              ) : (
                <div className="inline-actions">
                  <Button size="sm" variant="soft" onClick={() => setApproved((value) => ({ ...value, [hunk.index]: true }))}><Check size={11} /> Approve</Button>
                  <Button size="sm" variant="danger" disabled={busy} onClick={async () => {
                    setBusy(true);
                    try {
                      const patch = [...preamble, hunk.header, ...hunk.lines].join("\n") + "\n";
                      const result = await window.perch.gitRejectHunk(review.nodeId, review.threadId ?? state.selectedThreadId ?? "", review.path, patch);
                      state.pushToast({ kind: result.ok ? "success" : "error", title: result.ok ? "Hunk rejected" : "Could not reject hunk", body: result.output.slice(0, 300) });
                      if (result.ok) state.setOverlay("none");
                    } catch (error) {
                      state.pushToast({ kind: "error", title: "Could not reject hunk", body: String(error) });
                    } finally {
                      setBusy(false);
                    }
                  }}>Reject hunk</Button>
                </div>
              )}
            </div>
          ))}
          {!hunks.length ? <p className="rail-empty">No hunks in this diff.</p> : null}
        </div>
        <div className="diff-comments">
          <strong>Comments {comments.length ? `(${comments.length})` : ""}</strong>
          {comments.map((item, index) => (
            <div key={`${item.line}-${index}`} className="diff-comment">
              <span>Line {item.line}</span>
              <p>{item.text}</p>
              <IconButton icon={<X size={11} />} label="Remove comment" onClick={() => setComments((items) => items.filter((_, i) => i !== index))} />
            </div>
          ))}
          {activeLine !== null ? (
            <div className="diff-comment-form">
              <span>Line {activeLine}</span>
              <textarea autoFocus value={comment} onChange={(event) => setComment(event.target.value)} placeholder="What should change here?" />
              <div className="inline-actions">
                <Button size="sm" variant="primary" disabled={!comment.trim()} onClick={addComment}>Add comment</Button>
                <Button size="sm" variant="ghost" onClick={() => { setActiveLine(null); setComment(""); }}>Cancel</Button>
              </div>
            </div>
          ) : null}
        </div>
        <div className="diff-actions">
          <Button size="sm" variant="primary" disabled={!comments.length || busy} onClick={() => void askAgent()}><Send size={12} /> Ask agent to fix comments</Button>
        </div>
      </div>
    </div>
  );
}

function isImage(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}

function fileUrl(path?: string): string {
  if (!path) return "";
  return `file:///${path.replace(/\\/g, "/").replace(/ /g, "%20")}`;
}

function DiffView({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <pre className="diff-view">
      {lines.map((line, index) => {
        const marker = line.startsWith("+++") || line.startsWith("---") ? " " : line.startsWith("+") ? "+" : line.startsWith("-") ? "-" : " ";
        const className = line.startsWith("+++") || line.startsWith("---") ? "diff-same" : line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-same";
        return (
          <div key={index} className={className}>
            <span className="diff-marker">{marker}</span>{line.replace(/^[+-]/, "")}
          </div>
        );
      })}
    </pre>
  );
}

function HistoryModal() {
  const state = useApp();
  const thread = selectedThread(state);
  const [entries, setEntries] = useState<any[]>([]);
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!thread) return;
    setLoading(true);
    void window.perch.getThreadEntries(thread.id)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
    void window.perch.listCheckpoints(thread.id).then(setCheckpoints).catch(() => setCheckpoints([]));
  }, [thread?.id]);
  if (!thread) return null;
  const restore = async (checkpoint: Checkpoint, mode: "code" | "both") => {
    if (!confirm(`Restore ${mode === "both" ? "code and conversation" : "code"} from "${checkpoint.label}"? Current uncommitted changes in this checkout are replaced.`)) return;
    try {
      const result = await window.perch.restoreCheckpoint(checkpoint.id, mode);
      await state.refresh();
      await state.loadMessages(thread.id);
      state.pushToast({ kind: "success", title: "Checkpoint restored", body: `${result.restored} files restored, ${result.removed} removed` });
    } catch (error) {
      state.pushToast({ kind: "error", title: "Restore failed", body: String(error) });
    }
  };
  return (
    <Modal title="Thread history" subtitle="Checkpoints restore code, and optionally the conversation. Fork creates a new session from an entry; rewind moves the leaf." onClose={() => state.setOverlay("none")} width={820}>
      <div className="checkpoint-head">
        <div><strong>File checkpoints</strong><span>Automatic before each prompt, plus manual snapshots.</span></div>
        <Button size="sm" variant="soft" onClick={async () => {
          try {
            await window.perch.createCheckpoint(thread.id, "Manual checkpoint");
            setCheckpoints(await window.perch.listCheckpoints(thread.id));
            state.pushToast({ kind: "success", title: "Checkpoint created" });
          } catch (error) {
            state.pushToast({ kind: "error", title: "Checkpoint failed", body: String(error) });
          }
        }}>Checkpoint now</Button>
      </div>
      <div className="checkpoint-list">
        {checkpoints.map((checkpoint) => (
          <div key={checkpoint.id} className="checkpoint-row">
            <div><strong>{checkpoint.label}</strong><span>{relativeTime(checkpoint.createdAt)} · {checkpoint.sha.slice(0, 10)}</span></div>
            <div className="inline-actions">
              <Button size="sm" variant="soft" onClick={() => void restore(checkpoint, "code")}>Restore code</Button>
              <Button size="sm" variant="ghost" onClick={() => void restore(checkpoint, "both")}>Code + chat</Button>
            </div>
          </div>
        ))}
        {!checkpoints.length ? <p className="muted">No checkpoints yet. One is created automatically before each prompt in a git project.</p> : null}
      </div>
      {loading ? <div className="settings-loading"><Spinner /> Loading entries…</div> : (
        <div className="history-list">
          {entries.slice().reverse().map((entry) => (
            <div key={entry.id} className="history-entry">
              <div className="history-meta">
                <Badge tone={entry.role === "assistant" ? "accent" : entry.role === "user" ? "blue" : "neutral"}>{entry.role ?? entry.type}</Badge>
                <span>{new Date(entry.timestamp).toLocaleString()}</span>
                <span className="mono">{entry.id.slice(0, 10)}</span>
              </div>
              <p>{entry.text || "(no text)"}</p>
              <div className="history-actions">
                <Button size="sm" variant="soft" onClick={async () => {
                  await window.perch.forkThread(thread.id, entry.id);
                  await state.refresh();
                  await state.loadMessages(thread.id);
                  state.setOverlay("none");
                  state.pushToast({ kind: "success", title: "Forked thread" });
                }}>Fork from here</Button>
                <Button size="sm" variant="ghost" onClick={async () => {
                  await window.perch.navigateThread(thread.id, entry.id, false);
                  await state.refresh();
                  await state.loadMessages(thread.id);
                  state.setOverlay("none");
                  state.pushToast({ kind: "success", title: "Rewound thread" });
                }}>Rewind to here</Button>
              </div>
            </div>
          ))}
          {!entries.length ? <Empty title="No entries yet" body="Send a message to create the first entry." /> : null}
        </div>
      )}
    </Modal>
  );
}

function GoalModal() {
  const state = useApp();
  const thread = selectedThread(state);
  const [current, setCurrent] = useState<any>(null);
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const refresh = async () => {
    if (!thread) return;
    try {
      const result = await window.perch.goalThread(thread.id, "get");
      setCurrent(result);
    } catch {
      setCurrent(null);
    }
  };
  useEffect(() => { void refresh(); }, [thread?.id]);
  if (!thread) return null;
  const goal = current?.goal;
  const op = async (name: "create" | "resume" | "pause" | "drop") => {
    const result = await window.perch.goalThread(thread.id, name, name === "create" ? objective : undefined, budget ? Number(budget) : undefined);
    setCurrent(result);
    state.pushToast({ kind: "success", title: `Goal ${name}` });
  };
  return (
    <Modal title="Goal mode" subtitle="A persistent objective with a token budget. Pi continues the thread until the goal completes or you pause it." onClose={() => state.setOverlay("none")} width={620}>
      <div className="goal-modal">
        {goal ? (
          <div className="goal-card">
            <Badge tone={goal.status === "active" ? "green" : goal.status === "paused" ? "amber" : "neutral"}>{goal.status ?? "goal"}</Badge>
            <p>{goal.objective}</p>
            {goal.tokenBudget ? <span>Budget: {formatNumber(goal.tokenBudget)} tokens</span> : null}
            <div className="goal-actions">
              {goal.status === "paused" ? <Button size="sm" variant="primary" onClick={() => void op("resume")}>Resume</Button> : <Button size="sm" variant="soft" onClick={() => void op("pause")}>Pause</Button>}
              <Button size="sm" variant="danger" onClick={() => void op("drop")}>Drop goal</Button>
            </div>
          </div>
        ) : (
          <>
            <Field label="Objective"><textarea rows={4} value={objective} onChange={(event) => setObjective(event.target.value)} placeholder="What should this thread keep working toward?" /></Field>
            <Field label="Token budget" hint="Optional. Pi stops when the budget is exhausted."><input value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="e.g. 200000" /></Field>
            <Button variant="primary" disabled={!objective.trim()} onClick={() => void op("create")}>Create goal</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
