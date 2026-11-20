import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronRight,
  CircleHelp,
  CircleStop,
  FileDown,
  FileText,
  GitBranch,
  Minimize2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCw,
  Save,
  Settings2,
  Share2,
  Sparkles,
  Split,
  History,
  ListChecks,
  Target,
  Trash2,
  X,
} from "lucide-react";
import type { ApprovalMode, ApprovalRequest, Thread, TreeNode } from "../../../shared/types";
import { nodeAncestors, selectedNode, selectedThread, useApp } from "../store";
import { Badge, Button, IconButton, Select, Spinner, cx, formatNumber, statusColor, statusLabel, truncate } from "./Common";
import { Transcript } from "./Transcript";
import { ModelPicker } from "./ModelPicker";
import { NodeMark, nodeAccent } from "./NodeMark";

export function ChatView() {
  const state = useApp();
  const thread = selectedThread(state);
  const node = selectedNode(state);
  const [pickerOpen, setPickerOpen] = useState(false);
  const messages = thread ? state.messages[thread.id] ?? [] : [];

  if (!thread || !node) {
    return (
      <div className="chat">
        <div className="thread-empty">
          <h3>Loading Perch…</h3>
          <p>Preparing the tree and the Pi engine.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="chat" style={{ "--node-accent": nodeAccent(node) } as React.CSSProperties}>
      <ThreadHeader thread={thread} node={node} onModelPicker={() => setPickerOpen(true)} />
      {thread.interrupted ? (
        <div className="resume-banner">
          <RotateCw size={15} />
          <div>
            <strong>This thread was interrupted when the app closed</strong>
            <span>{thread.kind === "orchestrator" ? "Continue resumes its interrupted child threads, then asks it to review their reports and tidy up." : "Continue from the last checkpoint. The model re-reads the workspace and finishes the unfinished work."}</span>
          </div>
          <Button size="sm" variant="primary" disabled={state.sending || thread.status === "running" || thread.status === "starting"} onClick={() => void state.continueThread(thread.id)}>
            {state.sending ? <Spinner size={13} /> : <RotateCw size={13} />} Continue
          </Button>
          <IconButton icon={<X size={14} />} label="Dismiss" onClick={() => void window.perch.updateThread(thread.id, { interrupted: false }).then(() => state.refresh())} />
        </div>
      ) : null}
      <Transcript key={thread.id} thread={thread} messages={messages} loading={state.loadingMessages && !messages.length} />
      {pickerOpen ? (
        <div className="picker-layer" onMouseDown={() => setPickerOpen(false)}>
          <ModelPicker
            models={state.models}
            value={thread.model.selector}
            role={thread.kind === "orchestrator" ? (node.type === "root" ? "root" : node.type === "group" ? "group" : "project") : "worker"}
            onSelect={async (selector) => {
              setPickerOpen(false);
              await window.perch.setThreadModel(thread.id, selector);
              await state.refresh();
              state.pushToast({ kind: "success", title: "Model changed", body: selector });
            }}
            onClose={() => setPickerOpen(false)}
          />
        </div>
      ) : null}
      <QuestionCards threadId={thread.id} />
      <Composer thread={thread} node={node} onModelPicker={() => setPickerOpen(true)} />
    </div>
  );
}

function QuestionCards({ threadId }: { threadId: string }) {
  const state = useApp();
  const questions = state.approvals.filter((request) => request.kind === "ask" && request.threadId === threadId);
  if (!questions.length) return null;
  return (
    <div className="question-cards">
      {questions.map((request) => <QuestionCard key={request.id} request={request} />)}
    </div>
  );
}

function QuestionCard({ request }: { request: ApprovalRequest }) {
  const state = useApp();
  const raw = (request.raw ?? {}) as { questions?: Array<{ id: string; question: string; multi?: boolean; options?: Array<{ label: string; description?: string }> }> };
  const questions = raw.questions ?? [];
  const from = state.snapshot?.threads.find((thread) => thread.id === request.threadId);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const answerOf = (id: string) => custom[id]?.trim() ? [custom[id].trim()] : answers[id] ?? [];
  const ready = questions.length > 0 && questions.every((question) => answerOf(question.id).length > 0);
  const submit = () => {
    if (!ready) return;
    const payload: Record<string, string[]> = {};
    for (const question of questions) payload[question.id] = answerOf(question.id);
    void state.respondApproval(request.id, payload);
  };
  return (
    <div className="question-card">
      <div className="question-card-head">
        <CircleHelp size={16} />
        <div>
          <strong>{request.title || "Question"}</strong>
          <span>{from ? `From ${from.title}` : request.message.split("\n")[0]}</span>
        </div>
      </div>
      <div className="ask-questions">
        {questions.map((question) => {
          const current = answers[question.id] ?? [];
          return (
            <div key={question.id} className="ask-question">
              <strong>{question.question}</strong>
              {question.options?.length ? (
                <div className="ask-options">
                  {question.options.map((option) => {
                    const active = current.includes(option.label);
                    return (
                      <button
                        key={option.label}
                        type="button"
                        className={cx("ask-option", active && "selected")}
                        onClick={() => {
                          setCustom({ ...custom, [question.id]: "" });
                          setAnswers({
                            ...answers,
                            [question.id]: question.multi ? (active ? current.filter((item) => item !== option.label) : [...current, option.label]) : [option.label],
                          });
                        }}
                      >
                        <span>{option.label}</span>
                        {option.description ? <small>{option.description}</small> : null}
                        {active ? <Check size={14} /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : null}
              <input
                placeholder="Or type an answer…"
                value={custom[question.id] ?? ""}
                onChange={(event) => {
                  setCustom({ ...custom, [question.id]: event.target.value });
                  if (event.target.value) setAnswers({ ...answers, [question.id]: [] });
                }}
              />
            </div>
          );
        })}
      </div>
      <div className="question-card-foot">
        <span>This thread is waiting for your answer.</span>
        <Button size="sm" variant="ghost" onClick={() => void state.respondApproval(request.id, null)}>Skip</Button>
        <Button size="sm" variant="primary" disabled={!ready} onClick={submit}><Check size={13} /> Answer</Button>
      </div>
    </div>
  );
}

function ThreadHeader({
  thread,
  node,
  onModelPicker,
}: {
  thread: Thread;
  node: TreeNode;
  onModelPicker: () => void;
}) {
  const state = useApp();
  const nodes = state.snapshot?.nodes ?? [];
  const ancestors = nodeAncestors(nodes, node.id);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(thread.title);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const model = state.models.find((item) => item.selector === thread.model.selector);
  const efforts = model?.thinking?.length ? model.thinking : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

  useEffect(() => setTitle(thread.title), [thread.title]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (event: MouseEvent) => {
      if (!moreRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [moreOpen]);

  const saveTitle = async () => {
    setEditing(false);
    if (title.trim() && title.trim() !== thread.title) {
      await window.perch.updateThread(thread.id, { title: title.trim(), titleAuto: false });
      await state.refresh();
    }
  };

  return (
    <header className="chat-header">
      <div className="chat-header-main">
        <div className="breadcrumbs">
          {ancestors.map((ancestor, index) => (
            <React.Fragment key={ancestor.id}>
              {index > 0 ? <ChevronRight size={12} /> : null}
              <button type="button" onClick={() => void state.selectNode(ancestor.id)} className={ancestor.id === node.id ? "current" : ""}>
                {ancestor.type === "root" ? <Sparkles size={12} /> : <NodeMark node={ancestor} size={14} />}
                {ancestor.type === "root" ? "Root" : ancestor.name}
              </button>
            </React.Fragment>
          ))}
          {thread.kind !== "orchestrator" ? (
            <>
              <ChevronRight size={12} />
              <span className="breadcrumb-thread">{thread.kind === "native" || thread.spawnedByTask ? "subagent" : "worker"}</span>
            </>
          ) : null}
        </div>
        {editing ? (
          <input
            className="title-edit"
            value={title}
            autoFocus
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(event) => {
              if (event.key === "Enter") void saveTitle();
              if (event.key === "Escape") { setTitle(thread.title); setEditing(false); }
            }}
          />
        ) : (
          <h1 onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {thread.title}
          </h1>
        )}
        <div className="chat-header-sub">
          <span className="status-inline" style={{ color: statusColor(thread.status) }}>
            <i style={{ background: statusColor(thread.status) }} className={thread.status === "running" ? "pulse" : ""} />
            {statusLabel(thread.status)}
          </span>
          <span>{thread.kind === "orchestrator" ? node.type : thread.kind}</span>
          {thread.targetId ? <span className="chip-inline">cloud target</span> : null}
          <span>{thread.model.name ?? thread.model.selector}</span>
          {/compact/i.test(thread.statusMessage ?? "") ? <span className="compaction-inline">{thread.statusMessage}</span> : null}
          {thread.branch ? <span className="mono chip-inline"><GitBranch size={11} /> {thread.branch}</span> : null}
          {thread.git ? (
            <span className={thread.git.clean ? "git-clean" : "git-dirty"}>
              {thread.git.clean ? "clean" : `${thread.git.files.length} changes`}
            </span>
          ) : null}
          {thread.pendingApproval ? <Badge tone="amber">approval needed</Badge> : null}
          {thread.interrupted ? <Badge tone="amber">interrupted</Badge> : null}
        </div>
      </div>
      <div className="chat-header-actions">
        <Button size="sm" variant="soft" onClick={() => state.setOverlay("new-thread")} title="Spawn a worker thread">
          <Plus size={14} /> Thread
        </Button>
        <IconButton icon={<Target size={15} />} label="Goal mode" onClick={() => state.setOverlay("goal")} />
        <IconButton icon={<History size={15} />} label="History, checkpoints, fork and rewind" onClick={() => state.setOverlay("history")} />
        <div className="header-more" ref={moreRef}>
          <IconButton icon={<MoreHorizontal size={16} />} label="More actions" onClick={() => setMoreOpen((value) => !value)} />
          {moreOpen ? (
            <div className="header-more-menu">
              <button type="button" onClick={() => { setMoreOpen(false); state.openPane("tasks"); }}><ListChecks size={14} /> Tasks</button>
              <button type="button" onClick={async () => {
                setMoreOpen(false);
                if (thread.status === "running" && !confirm("Manual compaction aborts the current turn. Continue?")) return;
                state.pushToast({ kind: "info", title: "Compacting context", body: "Pi is summarizing older history." });
                try {
                  await window.perch.compactThread(thread.id);
                  state.pushToast({ kind: "success", title: "Context compacted" });
                  await state.refresh();
                } catch (error) {
                  state.pushToast({ kind: "error", title: "Compaction failed", body: String(error) });
                }
              }}><Minimize2 size={14} /> Compact context</button>
              <button type="button" onClick={async () => {
                setMoreOpen(false);
                try {
                  await window.perch.createCheckpoint(thread.id, "Manual checkpoint");
                  state.pushToast({ kind: "success", title: "Checkpoint created" });
                } catch (error) {
                  state.pushToast({ kind: "error", title: "Checkpoint failed", body: String(error) });
                }
              }}><Save size={14} /> Create checkpoint</button>
              <button type="button" onClick={() => { setMoreOpen(false); void state.shareThread(); }}><Share2 size={14} /> Share thread</button>
              <button type="button" onClick={() => { setMoreOpen(false); state.setSettingsTab("workspace"); }}><Settings2 size={14} /> Project settings</button>
              <button type="button" onClick={async () => {
                setMoreOpen(false);
                try {
                  const result = await window.perch.exportThreadPdf(thread.id);
                  state.pushToast({ kind: "success", title: "PDF exported", body: result.path });
                  await window.perch.openPath(result.path.replace(/[\\/][^\\/]+$/, ""));
                } catch (error) {
                  state.pushToast({ kind: "error", title: "PDF export failed", body: String(error) });
                }
              }}><FileDown size={14} /> Export PDF</button>
              <button type="button" onClick={async () => {
                setMoreOpen(false);
                try {
                  const result = await window.perch.exportThreadDocx(thread.id);
                  state.pushToast({ kind: "success", title: "Word document exported", body: result.path });
                  await window.perch.openPath(result.path.replace(/[\\/][^\\/]+$/, ""));
                } catch (error) {
                  state.pushToast({ kind: "error", title: "Word export failed", body: String(error) });
                }
              }}><FileText size={14} /> Export Word</button>
              {thread.kind !== "orchestrator" ? (
                <button type="button" className="danger" onClick={async () => {
                  setMoreOpen(false);
                  if (!confirm("Delete thread \"" + thread.title + "\"? Its branch and files stay on disk.")) return;
                  await window.perch.deleteThread(thread.id);
                  await state.refresh();
                  await state.selectNode(node.id);
                }}><Trash2 size={14} /> Delete thread</button>
              ) : null}
            </div>
          ) : null}
        </div>
        <IconButton icon={state.railOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />} label="Toggle right panel" onClick={state.toggleRail} />
      </div>
    </header>
  );
}

function Composer({ thread, node, onModelPicker }: { thread: Thread; node: TreeNode; onModelPicker: () => void }) {
  const state = useApp();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const model = state.models.find((item) => item.selector === thread.model.selector);
  const efforts = model?.thinking?.length ? model.thinking : ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const running = thread.status === "running" || thread.status === "starting";
  const contextPercent = thread.contextTokens && thread.contextWindow ? Math.min(100, (thread.contextTokens / thread.contextWindow) * 100) : 0;
  const [dragging, setDragging] = useState(false);

  const attach = async (list: FileList | File[] | null) => {
    if (!list || !list.length) return;
    const parts: string[] = [];
    for (const file of [...list].slice(0, 6)) {
      try {
        if (/^image\//.test(file.type) && file.size <= 8_000_000) {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result ?? ""));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(file);
          });
          const saved = await window.perch.attachImage({ nodeId: node.id, threadId: thread.id, name: file.name, dataUrl });
          parts.push(`Image: ${saved.path}`);
        } else if (file.size <= 200_000) {
          const text = await file.text();
          parts.push(`File: ${file.name}\n\`\`\`\n${text.slice(0, 60_000)}\n\`\`\``);
        } else {
          parts.push(`File: ${file.name} (${formatNumber(file.size)} bytes, not inlined)`);
        }
      } catch (error) {
        state.pushToast({ kind: "error", title: `Could not attach ${file.name}`, body: String(error) });
      }
    }
    if (parts.length) setDraft((value) => `${value ? `${value}\n` : ""}${parts.join("\n\n")}\n`);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    element.style.height = `${Math.min(220, Math.max(44, element.scrollHeight))}px`;
  }, [draft]);

  const insert = state.composerInsert;
  useEffect(() => {
    if (!insert) return;
    setDraft((value) => (value ? `${value}\n${insert.text}` : insert.text));
    state.clearComposerInsert();
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [insert?.token]);

  const submit = async () => {
    if (!draft.trim() || state.sending) return;
    const text = draft;
    setDraft("");
    const sent = await state.send(text, running ? "steer" : "prompt");
    if (!sent) setDraft(text);
  };

  return (
    <div className="composer-wrap">
      {state.inbox.filter((envelope) => envelope.toThreadId === thread.id && envelope.requiresResponse).slice(0, 1).map((envelope) => (
        <div key={envelope.id} className="pending-banner">
          <span>Message from {envelope.direction === "up" ? "child" : "parent"} requires a response:</span>
          <strong>{envelope.subject}</strong>
          <button type="button" onClick={() => state.setRightTab("bus")}>Open message bus</button>
        </div>
      ))}
      <div className="composer">
        <textarea
          ref={textareaRef}
          className={dragging ? "composer-textarea dragging" : "composer-textarea"}
          value={draft}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => { event.preventDefault(); setDragging(false); void attach(event.dataTransfer.files); }}
          onPaste={(event) => {
            if (event.clipboardData?.files?.length) {
              event.preventDefault();
              void attach(event.clipboardData.files);
            }
          }}
          placeholder={
            thread.kind === "orchestrator"
              ? node.type === "root"
                ? "Direct the whole tree…"
                : node.type === "group"
                  ? "Ask this group to coordinate its projects…"
                  : "Ask this project orchestrator…"
              : "Steer this thread…"
          }
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-left">
            <IconButton icon={<Paperclip size={13} />} label="Add files, symbols or images" onClick={() => state.setOverlay("context")} />
            <button type="button" className="composer-model" onClick={onModelPicker} title="Change model">
              <Sparkles size={13} />
              <span>{thread.model.name ?? thread.model.selector}</span>
            </button>
            <Select value={thread.effort} onChange={(value) => void window.perch.setThreadEffort(thread.id, value).then(() => state.refresh())} className="effort-select">
              {["off", ...efforts.filter((item) => item !== "off")].map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </Select>
            <span title="Tool approval for this node. Running turns keep their current policy; the next prompt uses the new one.">
              <Select
                value={node.approvalMode}
                className={node.approvalMode === "yolo" ? "approval-select approval-danger" : "approval-select"}
                onChange={(value) => void window.perch.setNodeApproval(node.id, value as ApprovalMode).then(() => {
                  state.refresh();
                  state.pushToast({
                    kind: value === "yolo" ? "warning" : "info",
                    title: "Permissions updated",
                    body: value === "yolo" ? "All tool calls auto-approve for this node. Running turns keep the old policy." : value === "write" ? "Writes auto-approve; other sensitive tools still ask." : "Every sensitive tool call asks first.",
                  });
                })}
              >
                <option value="yolo">Auto-approve all</option>
                <option value="write">Auto-approve writes</option>
                <option value="always-ask">Ask each time</option>
              </Select>
            </span>
            <span className="composer-context">
              <span className="context-bar"><i style={{ width: `${contextPercent}%` }} /></span>
              {thread.contextTokens ? `${formatNumber(thread.contextTokens)} ctx` : "context"}
            </span>
          </div>
          <div className="composer-right">
                        {running ? (
              <Button size="sm" variant="ghost" onClick={async () => {
                try {
                  if (thread.paused) await window.perch.resumeThread(thread.id);
                  else await window.perch.pauseThread(thread.id);
                  await state.refresh();
                } catch (error) {
                  state.pushToast({ kind: "error", title: "Pause failed", body: String(error) });
                }
              }}>
                {thread.paused ? <Play size={14} /> : <Pause size={14} />} {thread.paused ? "Resume" : "Pause"}
              </Button>
            ) : null}
            {running ? (
              <Button size="sm" variant="ghost" onClick={() => void state.stop()}>
                <CircleStop size={14} /> Stop
              </Button>
            ) : null}
<Button size="sm" variant="primary" disabled={!draft.trim() || state.sending} onClick={() => void submit()}>
              {state.sending ? <Spinner size={13} /> : running ? <Split size={14} /> : <ArrowUp size={14} />}
              {running ? "Steer" : "Send"}
            </Button>
          </div>
        </div>
      </div>
      <div className="composer-foot">
        <span>{running ? "Steering the live turn" : "Enter to send / Shift+Enter for newline"}</span>
        {state.share ? <span className="share-live">live share active</span> : null}
      </div>
    </div>
  );
}

