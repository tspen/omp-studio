import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  Inbox,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Split,
  Waypoints,
} from "lucide-react";
import type { Envelope, GitFileStatus, GitStatus, Thread } from "../../../shared/types";
import { selectedNode, selectedThread, useApp } from "../store";
import { Badge, Button, Empty, IconButton, Markdown, Segmented, StatusDot, cx, formatCost, formatNumber, relativeTime, statusColor, statusLabel, truncate } from "./Common";

export function ThreadRail() {
  const state = useApp();
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const tab = state.rightTab;
  if (!node || !thread) return <aside className="rail" />;
  return (
    <aside className="rail">
      <div className="rail-tabs">
        <Segmented
          value={tab}
          options={[
            { value: "threads", label: `Threads ${nodeThreads(state, node.id).length}` },
            { value: "bus", label: "Message bus" },
            { value: "git", label: "Git" },
          ]}
          onChange={(value) => state.setRightTab(value)}
        />
      </div>
      <div className="rail-body">
        {tab === "threads" ? <ThreadsTab /> : tab === "bus" ? <BusTab /> : <GitTab />}
      </div>
    </aside>
  );
}

function nodeThreads(state: ReturnType<typeof useApp.getState>, nodeId: string): Thread[] {
  return (state.snapshot?.threads ?? []).filter((thread) => thread.nodeId === nodeId);
}

function ThreadsTab() {
  const state = useApp();
  const node = selectedNode(state);
  const current = selectedThread(state);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "live" | "open" | "done">("all");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ resolved: true });
  if (!node || !current) return null;
  const threads = nodeThreads(state, node.id);
  const orchestrator = threads.find((thread) => thread.kind === "orchestrator");
  const workers = threads.filter((thread) => thread.kind !== "orchestrator");
  const matches = (thread: Thread) => {
    const text = query.trim().toLowerCase();
    if (text) {
      const haystack = `${thread.title} ${thread.model.name ?? ""} ${thread.branch ?? ""} ${thread.lastMessage ?? ""}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    if (filter === "live") return ["running", "starting", "waiting", "queued"].includes(thread.status) || !!thread.pendingApproval;
    if (filter === "open") return !thread.archived && !["completed", "error"].includes(thread.status);
    if (filter === "done") return thread.archived || ["completed", "error"].includes(thread.status);
    return true;
  };
  const active = workers.filter((thread) => ["running", "starting", "waiting", "queued"].includes(thread.status) && matches(thread));
  const idle = workers.filter((thread) => !thread.archived && ["idle", "parked", "cancelled"].includes(thread.status) && matches(thread));
  const done = workers.filter((thread) => !thread.archived && ["completed", "error"].includes(thread.status) && matches(thread));
  const resolved = workers.filter((thread) => thread.archived && !["running", "starting", "waiting", "queued"].includes(thread.status) && matches(thread));
  const showLive = filter === "all" || filter === "live" || filter === "open";
  const showIdle = filter === "all" || filter === "open";
  const showDone = filter === "all" || filter === "done";
  const showResolved = filter === "all" || filter === "done";
  const toggle = (section: string) => setCollapsed((value) => ({ ...value, [section]: !value[section] }));
  const sectionHead = (key: string, title: string, count?: number, extra?: React.ReactNode) => (
    <div className="rail-section-head">
      <button type="button" className="rail-toggle" onClick={() => toggle(key)} title={collapsed[key] ? `Expand ${title}` : `Collapse ${title}`}>
        {collapsed[key] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
      </button>
      <span>{title}</span>
      {count !== undefined ? <span className="rail-count">{count}</span> : null}
      {extra}
    </div>
  );

  return (
    <div className="threads-tab">
      <div className="rail-filter">
        <Search size={13} />
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter threads" />
        <select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}>
          <option value="all">All</option>
          <option value="live">Live</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
      </div>

      <div className="rail-section">
        <div className="rail-section-head">
          <span>Orchestrator</span>
          <Badge tone={node.type === "root" ? "accent" : node.type === "group" ? "blue" : "green"}>{node.type}</Badge>
        </div>
        {orchestrator ? <ThreadRow thread={orchestrator} current={current.id} /> : null}
      </div>

      {showLive ? (
        <div className="rail-section">
          {sectionHead("live", "Live threads", active.length, (
            <Button size="sm" variant="ghost" onClick={(event) => { event.stopPropagation(); state.setOverlay("new-thread"); }}><Plus size={13} /> New</Button>
          ))}
          {collapsed.live ? null : active.length ? active.map((thread) => <ThreadRow key={thread.id} thread={thread} current={current.id} />) : <p className="rail-empty">{query || filter !== "all" ? "No matching live workers." : "No live workers. The orchestrator can spawn them from chat."}</p>}
        </div>
      ) : null}

      {showIdle && idle.length ? (
        <div className="rail-section">
          {sectionHead("idle", "Idle", idle.length)}
          {collapsed.idle ? null : idle.map((thread) => <ThreadRow key={thread.id} thread={thread} current={current.id} />)}
        </div>
      ) : null}

      {showDone && done.length ? (
        <div className="rail-section">
          {sectionHead("done", "Finished", done.length)}
          {collapsed.done ? null : done.map((thread) => <ThreadRow key={thread.id} thread={thread} current={current.id} />)}
        </div>
      ) : null}

      {showResolved && resolved.length ? (
        <div className="rail-section">
          {sectionHead("resolved", "Resolved", resolved.length)}
          {collapsed.resolved ? null : resolved.map((thread) => <ThreadRow key={thread.id} thread={thread} current={current.id} />)}
        </div>
      ) : null}

      {!active.length && !idle.length && !done.length && !resolved.length && (query || filter !== "all") ? (
        <p className="rail-empty">No threads match this filter.</p>
      ) : null}

      <div className="rail-section">
        <div className="rail-section-head"><span>Node status</span></div>
        <div className="node-status-card">
          <div><span>Path</span><strong title={node.repoPath || node.path}>{truncate(node.repoPath || node.path, 30)}</strong></div>
          <div><span>Model</span><strong>{truncate(state.models.find((model) => model.selector === node.model)?.name ?? node.model, 28)}</strong></div>
          <div><span>Git policy</span><strong>{node.gitMode}</strong></div>
          <div><span>Approval</span><strong>{node.approvalMode}</strong></div>
          <div><span>Threads</span><strong>{threads.length}</strong></div>
        </div>
      </div>
    </div>
  );
}

function ThreadRow({ thread, current }: { thread: Thread; current: string }) {
  const state = useApp();
  const active = current === thread.id;
  const branch = thread.branch ? thread.branch.split("/").filter(Boolean).slice(-1)[0] ?? "" : "";
  return (
    <button
      type="button"
      className={cx("thread-row", active && "active")}
      title={`${thread.title}\n${statusLabel(thread.status)} · ${thread.model.name ?? thread.model.selector}${thread.branch ? `\n${thread.branch}` : ""}`}
      onClick={() => void state.selectThread(thread.id, thread.nodeId)}
    >
      <div className="thread-row-top">
        <StatusDot status={thread.status} pulse={thread.status === "running" || thread.status === "starting"} />
        <span className="thread-row-title">{thread.title}</span>
        {thread.kind === "native" ? <Badge tone="purple">sub</Badge> : null}
        {thread.pendingApproval ? <ShieldAlert size={13} className="warn-icon" /> : null}
        <span className="thread-row-time">{relativeTime(thread.lastActivityAt)}</span>
      </div>
      <div className="thread-row-meta">
        <span className="thread-row-status">{statusLabel(thread.status)}</span>
        {branch ? <span className="thread-row-branch"><GitBranch size={10} /> {branch}</span> : null}
        {thread.tokens ? <span className="thread-row-tokens">{formatNumber(thread.tokens)} tok</span> : null}
      </div>
      {thread.lastMessage ? <div className="thread-row-last">{truncate(thread.lastMessage, 90)}</div> : null}
    </button>
  );
}

function BusTab() {
  const state = useApp();
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const [scope, setScope] = useState<"thread" | "node">("thread");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [answerDraft, setAnswerDraft] = useState("");
  if (!node || !thread) return null;
  const nodeIds = new Set<string>([node.id, ...descendantIds(state, node.id)]);
  const envelopes = state.envelopes
    .filter((envelope) => scope === "thread" ? envelope.fromThreadId === thread.id || envelope.toThreadId === thread.id : (envelope.fromNodeId && nodeIds.has(envelope.fromNodeId)) || (envelope.toNodeId && nodeIds.has(envelope.toNodeId)))
    .slice(-80)
    .reverse();

  return (
    <div className="bus-tab">
      <div className="bus-header">
        <div>
          <strong>Tree messages</strong>
          <span>Messages flow down as tasks and up as reports. Every orchestrator sees its inbox.</span>
        </div>
        <Segmented
          value={scope}
          options={[
            { value: "thread", label: "Thread" },
            { value: "node", label: "Node" },
          ]}
          onChange={(value) => setScope(value)}
        />
      </div>
      <ManualMessage thread={thread} />
      <div className="envelope-list">
        {envelopes.map((envelope) => (
          <EnvelopeRow
            key={envelope.id}
            envelope={envelope}
            me={thread.id}
            expanded={expanded === envelope.id}
            onToggle={() => setExpanded(expanded === envelope.id ? null : envelope.id)}
            answerDraft={answerDraft}
            setAnswerDraft={setAnswerDraft}
            onAnswer={async () => {
              await state.answerEnvelope(envelope.id, answerDraft);
              setAnswerDraft("");
              setExpanded(null);
            }}
          />
        ))}
        {!envelopes.length ? <Empty icon={<Waypoints size={22} />} title="No traffic yet" body="Ask the orchestrator to delegate. Its task and report messages will appear here." /> : null}
      </div>
    </div>
  );
}

function EnvelopeRow({
  envelope,
  me,
  expanded,
  onToggle,
  answerDraft,
  setAnswerDraft,
  onAnswer,
}: {
  envelope: Envelope;
  me: string;
  expanded: boolean;
  onToggle: () => void;
  answerDraft: string;
  setAnswerDraft: (value: string) => void;
  onAnswer: () => Promise<void>;
}) {
  const incoming = envelope.toThreadId === me;
  const pending = envelope.requiresResponse && !["answered", "cancelled", "expired"].includes(envelope.status);
  return (
    <div className={cx("envelope-row", incoming ? "incoming" : "outgoing", pending && "pending")}>
      <button type="button" className="envelope-summary" onClick={onToggle}>
        <span className={cx("direction-icon", envelope.direction)}>
          {envelope.direction === "up" ? <ArrowUpRight size={13} /> : envelope.direction === "down" ? <ArrowDownLeft size={13} /> : <Split size={13} />}
        </span>
        <span className="envelope-kind">{envelope.kind}</span>
        <span className="envelope-subject">{envelope.subject}</span>
        {envelope.priority === "high" || envelope.priority === "urgent" ? <Badge tone="red">{envelope.priority}</Badge> : null}
        {pending ? <Badge tone="amber">needs reply</Badge> : null}
        <span className="envelope-time">{relativeTime(envelope.createdAt)}</span>
        <ChevronDown size={13} className={cx("envelope-caret", expanded && "open")} />
      </button>
      {expanded ? (
        <div className="envelope-detail">
          <div className="envelope-detail-meta">
            <span>{envelope.direction}</span>
            <span>{envelope.status}</span>
            <span className="mono">{envelope.id}</span>
            {envelope.traceId ? <span className="mono">trace {envelope.traceId.slice(-8)}</span> : null}
          </div>
          <Markdown>{envelope.body}</Markdown>
          {pending && incoming ? (
            <div className="envelope-answer">
              <textarea value={answerDraft} onChange={(event) => setAnswerDraft(event.target.value)} placeholder="Reply as this thread…" />
              <Button size="sm" variant="primary" disabled={!answerDraft.trim()} onClick={() => void onAnswer()}>
                <Send size={13} /> Send answer
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ManualMessage({ thread }: { thread: Thread }) {
  const state = useApp();
  const parent = state.snapshot?.threads.find((item) => item.id === thread.parentThreadId);
  const children = (state.snapshot?.threads ?? []).filter((item) => item.parentThreadId === thread.id);
  const node = selectedNode(state);
  const parentNode = node?.parentId ? state.snapshot?.nodes.find((item) => item.id === node.parentId) : undefined;
  const parentOrchestrator = parentNode ? state.snapshot?.threads.find((item) => item.id === parentNode.orchestratorThreadId) : undefined;
  const targets = [
    ...(parent ? [{ id: parent.id, label: `Parent · ${parent.title}` }] : []),
    ...(!parent && parentOrchestrator ? [{ id: parentOrchestrator.id, label: `Parent node · ${parentOrchestrator.title}` }] : []),
    ...children.map((child) => ({ id: child.id, label: `Child · ${child.title}` })),
  ];
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState("note");
  useEffect(() => {
    if (!targets.some((item) => item.id === target)) setTarget(targets[0]?.id ?? "");
  }, [targets.map((item) => item.id).join(",")]);
  if (!targets.length) return null;
  return (
    <details className="manual-message">
      <summary><MessageSquare size={13} /> Send a tree message</summary>
      <div className="manual-form">
        <select value={target} onChange={(event) => setTarget(event.target.value)}>
          {targets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <select value={kind} onChange={(event) => setKind(event.target.value)}>
          {["task", "context", "progress", "question", "answer", "result", "decision", "escalation", "note"].map((item) => <option key={item} value={item}>{item}</option>)}
        </select>
        <input value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="Subject" />
        <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Message body…" />
        <Button
          size="sm"
          variant="primary"
          disabled={!body.trim() || !subject.trim()}
          onClick={async () => {
            await window.omp.sendEnvelope({ fromThreadId: thread.id, toThreadId: target, kind: kind as any, subject, body, requiresResponse: kind === "question" });
            setBody("");
            setSubject("");
            await state.refresh();
          }}
        >
          <Send size={13} /> Send
        </Button>
      </div>
    </details>
  );
}

function GitTab() {
  const state = useApp();
  const node = selectedNode(state);
  const thread = selectedThread(state);
  const [status, setStatus] = useState<GitStatus | null>(thread?.git ?? null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [diff, setDiff] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!node) return;
    setLoading(true);
    void window.omp.getGitStatus(node.id, thread?.id)
      .then((value) => setStatus(value))
      .catch(() => setStatus(null))
      .finally(() => setLoading(false));
  }, [node?.id, thread?.id]);

  if (!node) return null;
  const files = status?.files ?? [];
  return (
    <div className="git-tab">
      <div className="git-card">
        <div className="git-card-head">
          <div>
            <strong>{status?.isRepo ? status.branch ?? "repository" : "Not a git repository"}</strong>
            <span>{status?.root ?? node.repoPath ?? node.path}</span>
          </div>
          <IconButton icon={<RefreshCw size={14} />} label="Refresh" onClick={async () => { setLoading(true); setStatus(await window.omp.getGitStatus(node.id, thread?.id)); setLoading(false); }} />
        </div>
        {status?.isRepo ? (
          <>
            <div className="git-stats">
              <span><GitBranch size={12} /> {status.branch}</span>
              <span className={status.clean ? "git-clean" : "git-dirty"}>{status.clean ? "clean" : `${files.length} changed`}</span>
              <span>↑{status.ahead} ↓{status.behind}</span>
            </div>
            {status.lastCommit ? <div className="git-last"><GitCommitHorizontal size={12} /><span className="mono">{status.lastCommit.hash}</span>{status.lastCommit.subject}</div> : null}
            <div className="git-files">
              {files.map((file) => <GitFileRow key={file.path} file={file} onClick={async () => {
                const value = await window.omp.getGitDiff(node.id, thread?.id, file.path);
                state.openPreview({ title: file.path, kind: "diff", content: value || "No diff (untracked or binary file).", path: file.path });
              }} />)}
              {!files.length ? <p className="rail-empty">Working tree clean.</p> : null}
            </div>
            {files.length ? (
              <div className="git-commit">
                <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Commit message" />
                <Button size="sm" variant="primary" disabled={!message.trim() || busy} onClick={async () => {
                  setBusy(true);
                  const result = await window.omp.gitCommit(node.id, thread?.id, message);
                  state.pushToast({ kind: result.ok ? "success" : "error", title: result.ok ? "Committed" : "Commit failed", body: result.output.slice(0, 300) });
                  setStatus(await window.omp.getGitStatus(node.id, thread?.id));
                  setMessage("");
                  setBusy(false);
                }}>Commit</Button>
              </div>
            ) : null}
            {thread?.branch ? (
              <div className="git-actions">
                <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
                  setBusy(true);
                  const result = await window.omp.gitMerge(node.id, thread.id);
                  state.pushToast({ kind: result.ok ? "success" : "error", title: result.ok ? "Merged" : "Merge needs attention", body: result.conflicts.length ? result.conflicts.join(", ") : result.output.slice(0, 300) });
                  setStatus(await window.omp.getGitStatus(node.id));
                  setBusy(false);
                }}><GitMerge size={13} /> Merge branch</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={async () => {
                  setBusy(true);
                  const result = await window.omp.gitCreatePr(node.id, thread.id, thread.title, "Created from OMP Studio.");
                  state.pushToast({ kind: result.ok ? "success" : "error", title: result.ok ? "Pull request created" : "PR failed", body: result.url ?? result.output.slice(0, 300) });
                  setBusy(false);
                }}><GitPullRequest size={13} /> Create PR</Button>
              </div>
            ) : null}
            {diff ? <pre className="diff-preview">{diff}</pre> : null}
          </>
        ) : (
          <p className="rail-empty">This node is not linked to a git repository. Create a project from a repo path to enable branch and worktree tracking.</p>
        )}
      </div>
    </div>
  );
}

function GitFileRow({ file, onClick }: { file: GitFileStatus; onClick: () => void }) {
  return (
    <button type="button" className="git-file" onClick={onClick}>
      <span className="git-file-status">{file.untracked ? "U" : file.staged ? file.index : file.worktree}</span>
      <span>{file.path}</span>
      <FileDiff size={12} />
    </button>
  );
}

function descendantIds(state: ReturnType<typeof useApp.getState>, nodeId: string): string[] {
  const nodes = state.snapshot?.nodes ?? [];
  const result: string[] = [];
  const walk = (parentId: string) => {
    for (const node of nodes.filter((item) => item.parentId === parentId)) {
      result.push(node.id);
      walk(node.id);
    }
  };
  walk(nodeId);
  return result;
}
