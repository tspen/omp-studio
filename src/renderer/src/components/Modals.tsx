import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Bell,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  File,
  FileDiff,
  FileText,
  Folder,
  Inbox,
  MessageSquare,
  Play,
  Plus,
  Search,
  Send,
  Share2,
  Square,
  Terminal,
  Trash2,
  X,
} from "lucide-react";
import type { ApprovalRequest, Artifact, ChatBlock, Environment, ModelInfo, Thread, TreeNode } from "../../../shared/types";
import { nodeAncestors, selectedNode, selectedThread, useApp } from "../store";
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
  const request = state.approvals[0];
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
  const models = useMemo(() => [...state.models].sort((a, b) => b.quality - a.quality), [state.models]);
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
          <div className="inline-actions"><input value={effectivePath} onChange={(event) => { setPathTouched(true); setPath(event.target.value); }} placeholder={name.trim() ? suggestedPath : "Type a name for a default folder, or browse"} /><Button size="sm" variant="soft" onClick={async () => { const picked = await window.omp.pickDirectory(); if (picked) { setPathTouched(true); setPath(picked); } }}><Folder size={13} /> Browse</Button></div>
        </Field>
        {type === "project" ? (
          <label className="inline-check"><input type="checkbox" checked={gitInit} onChange={(event) => setGitInit(event.target.checked)} /> Initialize a git repository if needed</label>
        ) : null}
        <Field label="Orchestrator model">
          <Select value={model} onChange={setModel}>
            {models.map((item) => <option key={item.selector} value={item.selector}>{item.name} · {item.quality.toFixed(0)} · {formatCost(item.cost.output)}/M out</option>)}
          </Select>
        </Field>
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
            const full = await window.omp.readArtifact(artifact.id);
            state.openPreview({ title: artifact.name, kind: artifact.kind === "diff" ? "diff" : "artifact", content: full.content ?? full.path ?? "", path: full.path });
          }}>
            <div className="artifact-icon">{artifact.kind === "diff" ? <FileDiff size={18} /> : <FileText size={18} />}</div>
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

function TerminalModal() {
  const state = useApp();
  const [command, setCommand] = useState("");
  const [selectedRun, setSelectedRun] = useState<string | null>(null);
  const thread = selectedThread(state);
  useEffect(() => { void state.loadTerminals(); }, []);
  const run = state.terminalRuns.find((item) => item.id === selectedRun) ?? state.terminalRuns[0];
  return (
    <Modal title="Terminal" subtitle="Runs commands in the selected node or thread environment. Not a full PTY." onClose={() => state.setOverlay("none")} width={900}>
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
            {run?.status === "running" ? <Button size="sm" variant="ghost" onClick={() => void window.omp.killTerminal(run.id)}><Square size={12} /> Stop</Button> : null}
          </div>
        </div>
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
          <Button variant="soft" onClick={() => state.share && void window.omp.openExternal(state.share.url)}><ExternalLink size={14} /> Open in browser</Button>
          <Button variant="danger" onClick={() => void state.stopShare()}><X size={14} /> Stop sharing</Button>
        </div>
        <p className="muted">Guests can read messages and tool activity, but cannot steer. The server binds to 127.0.0.1 and uses an unguessable token.</p>
      </div>
    </Modal>
  );
}

function PreviewModal() {
  const state = useApp();
  const preview = state.preview;
  if (!preview) return null;
  return (
    <Modal title={preview.title} subtitle={preview.path} onClose={() => state.setOverlay("none")} width={1000} className="preview-modal">
      {preview.kind === "diff" ? <DiffView text={preview.content} /> : <pre className="file-preview">{preview.content || "No content."}</pre>}
    </Modal>
  );
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
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!thread) return;
    setLoading(true);
    void window.omp.getThreadEntries(thread.id)
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [thread?.id]);
  if (!thread) return null;
  return (
    <Modal title="Thread history" subtitle="Fork from a point or rewind this thread. Fork creates a new session file from the selected entry; rewind moves the leaf." onClose={() => state.setOverlay("none")} width={820}>
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
                  await window.omp.forkThread(thread.id, entry.id);
                  await state.refresh();
                  await state.loadMessages(thread.id);
                  state.setOverlay("none");
                  state.pushToast({ kind: "success", title: "Forked thread" });
                }}>Fork from here</Button>
                <Button size="sm" variant="ghost" onClick={async () => {
                  await window.omp.navigateThread(thread.id, entry.id, false);
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
      const result = await window.omp.goalThread(thread.id, "get");
      setCurrent(result);
    } catch {
      setCurrent(null);
    }
  };
  useEffect(() => { void refresh(); }, [thread?.id]);
  if (!thread) return null;
  const goal = current?.goal;
  const op = async (name: "create" | "resume" | "pause" | "drop") => {
    const result = await window.omp.goalThread(thread.id, name, name === "create" ? objective : undefined, budget ? Number(budget) : undefined);
    setCurrent(result);
    state.pushToast({ kind: "success", title: `Goal ${name}` });
  };
  return (
    <Modal title="Goal mode" subtitle="A persistent objective with a token budget. OMP continues the thread until the goal completes or you pause it." onClose={() => state.setOverlay("none")} width={620}>
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
            <Field label="Token budget" hint="Optional. OMP stops when the budget is exhausted."><input value={budget} onChange={(event) => setBudget(event.target.value)} placeholder="e.g. 200000" /></Field>
            <Button variant="primary" disabled={!objective.trim()} onClick={() => void op("create")}>Create goal</Button>
          </>
        )}
      </div>
    </Modal>
  );
}
