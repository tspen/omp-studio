import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Copy,
  FileEdit,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  ListChecks,
  MessageSquare,
  Search,
  Terminal,
  Wrench,
  Plus,
} from "lucide-react";
import type { ChatBlock, ChatMessage, Thread } from "../../../shared/types";
import { useApp } from "../store";
import { Badge, Logo, Markdown, Button, cx, formatNumber, relativeTime, statusLabel, truncate } from "./Common";

export function Transcript({ thread, messages, loading = false }: { thread: Thread; messages: ChatMessage[]; loading?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const showThinking = useApp((state) => state.snapshot?.settings.ui.showThinking ?? true);

  const scrollToBottom = () => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  useLayoutEffect(() => {
    stickRef.current = true;
    scrollToBottom();
  }, [thread.id]);

  useLayoutEffect(() => {
    if (stickRef.current) scrollToBottom();
  }, [messages, thread.status]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      stickRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    const observer = innerRef.current
      ? new ResizeObserver(() => {
          if (stickRef.current) element.scrollTop = element.scrollHeight;
        })
      : null;
    if (innerRef.current) observer?.observe(innerRef.current);
    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, []);

  return (
    <div className="transcript" ref={scrollRef}>
      <div className="transcript-inner" ref={innerRef}>
        <ThreadIntro thread={thread} />
        {thread.todoPhases?.length ? <TodoPanel thread={thread} /> : null}
        {messages.map((message) => (
          <MessageRow key={message.id} message={message} showThinking={showThinking} />
        ))}
        {thread.status === "running" ? (
          <div className="typing-row">
            <Logo size={20} />
            <span className="typing-dots"><i /><i /><i /></span>
            <span>{thread.statusMessage ?? "Working…"}</span>
          </div>
        ) : null}
        {loading ? (
          <div className="typing-row">
            <Logo size={20} />
            <span className="typing-dots"><i /><i /><i /></span>
            <span>Loading thread…</span>
          </div>
        ) : null}
        {!messages.length && !loading && thread.status !== "running" ? (
          <div className="thread-empty">
            <div className="thread-empty-icon"><Bot size={22} /></div>
            <h3>{thread.kind === "orchestrator" ? "Talk to this orchestrator" : "Thread ready"}</h3>
            <p>
              {thread.kind === "orchestrator"
                ? "Give it an objective. It can create child nodes, spawn worker threads, and message upward and downward through the tree."
                : "This worker has its own context, model and git branch. Send a message to continue the task."}
            </p>
            {thread.kind === "orchestrator" ? (
              <div className="thread-empty-actions">
                <Button size="sm" variant="primary" onClick={() => useApp.getState().setOverlay("new-node")}>
                  <Plus size={13} /> New project
                </Button>
                <Button size="sm" variant="soft" onClick={() => useApp.getState().setOverlay("new-node")}>
                  New group
                </Button>
                <Button size="sm" variant="ghost" onClick={() => useApp.getState().setOverlay("new-thread")}>
                  Spawn a worker
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThreadIntro({ thread }: { thread: Thread }) {
  return (
    <div className="thread-intro">
      <div className="thread-intro-avatar"><Logo size={30} /></div>
      <div>
        <h1>{thread.title}</h1>
        <div className="thread-intro-meta">
          <span>{thread.kind === "orchestrator" ? "Orchestrator" : thread.kind === "native" ? "Pi subagent" : "Worker thread"}</span>
          <span>·</span>
          <span>{thread.model.name ?? thread.model.selector}</span>
          <span>·</span>
          <span>{thread.effort} effort</span>
          {thread.branch ? <><span>·</span><span className="mono">{thread.branch}</span></> : null}
        </div>
      </div>
    </div>
  );
}

function TodoPanel({ thread }: { thread: Thread }) {
  const tasks = thread.todoPhases.flatMap((phase) => phase.tasks);
  const done = tasks.filter((task) => task.status === "completed").length;
  return (
    <details className="todo-panel" open>
      <summary>
        <ListChecks size={15} />
        <span>Plan</span>
        <span className="todo-count">{done}/{tasks.length}</span>
        <div className="todo-progress"><i style={{ width: `${tasks.length ? (done / tasks.length) * 100 : 0}%` }} /></div>
        <ChevronDown size={14} className="todo-caret" />
      </summary>
      <div className="todo-list">
        {thread.todoPhases.map((phase) => (
          <div key={phase.name} className="todo-phase">
            <span className="todo-phase-name">{phase.name}</span>
            {phase.tasks.map((task, index) => (
              <div key={`${task.content}-${index}`} className={cx("todo-item", task.status)}>
                {task.status === "completed" ? <CircleCheck size={14} /> : task.status === "in_progress" ? <CircleDashed size={14} className="spin-slow" /> : <Circle size={14} />}
                <span>{task.content}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </details>
  );
}

function MessageRow({ message, showThinking }: { message: ChatMessage; showThinking: boolean }) {
  const envelope = parseEnvelope(message);
  if (message.role === "tool") {
    return (
      <div className="message-row tool-row">
        {message.blocks.map((block) => block.type === "tool" ? <ToolCard key={block.id} block={block} /> : null)}
      </div>
    );
  }
  if (message.role === "user") {
    if (envelope) {
      return (
        <div className="message-row">
          <EnvelopeCard header={envelope.header} body={envelope.body} from={envelope.from} />
        </div>
      );
    }
    return (
      <div className="message-row user-row">
        <div className="user-bubble">
          {message.blocks.map((block, index) => <Block key={index} block={block} showThinking={showThinking} />)}
        </div>
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className="message-row assistant-row">
        <div className="assistant-avatar"><Logo size={22} /></div>
        <div className="assistant-content">
          <div className="assistant-meta">
            <strong>{message.model ?? "Pi"}</strong>
            <span>{new Date(message.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
            {message.usage ? <span>{formatNumber(message.usage.totalTokens)} tok</span> : null}
          </div>
          <div className="assistant-blocks">
            {message.blocks.map((block, index) => <Block key={index} block={block} showThinking={showThinking} />)}
          </div>
        </div>
      </div>
    );
  }
  return null;
}

function Block({ block, showThinking }: { block: ChatBlock; showThinking: boolean }) {
  if (block.type === "text") return <Markdown>{block.text}</Markdown>;
  if (block.type === "thinking") {
    if (!showThinking || !block.text.trim()) return null;
    return (
      <details className="thinking-block">
        <summary><span>Thinking</span><ChevronRight size={13} /></summary>
        <div>{block.text}</div>
      </details>
    );
  }
  if (block.type === "tool") return <ToolCard block={block} />;
  if (block.type === "image") return <ImageBlock block={block} />;
  return null;
}

function ImageBlock({ block }: { block: Extract<ChatBlock, { type: "image" }> }) {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = block.data
    ? `data:${block.mimeType || "image/png"};base64,${block.data}`
    : block.path
      ? `file:///${block.path.replace(/\\/g, "/").replace(/ /g, "%20")}`
      : "";
  if (!source || failed) {
    return (
      <div className="image-block">
        <ImageIcon size={14} /> Image{block.path ? `: ${truncate(block.path, 80)}` : " attachment"}
      </div>
    );
  }
  return (
    <>
      <button type="button" className="image-thumb" onClick={() => setOpen(true)} title="Open image">
        <img src={source} alt={block.path ?? "Image attachment"} onError={() => setFailed(true)} />
      </button>
      {open ? (
        <div className="image-lightbox" onClick={() => setOpen(false)}>
          <img src={source} alt={block.path ?? "Image attachment"} onClick={(event) => event.stopPropagation()} />
          <div className="image-lightbox-foot">
            <span>{block.path ? truncate(block.path, 90) : block.mimeType}</span>
            {block.path ? <Button size="sm" variant="soft" onClick={() => void window.perch.openPath(block.path!)}>Open file</Button> : null}
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Close</Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function ToolCard({ block }: { block: Extract<ChatBlock, { type: "tool" }> }) {
  const state = useApp();
  const [copied, setCopied] = useState(false);
  const presentation = describeTool(block.name, block.args, state.snapshot);
  const icon = toolIcon(block.name);
  const result = block.result ?? "";
  const hasArgs = block.args != null && (typeof block.args !== "object" || Object.keys(block.args as object).length > 0);
  const duration = block.startedAt && block.endedAt ? formatDuration(block.endedAt - block.startedAt) : "";
  return (
    <div className={cx("tool-card", block.status)}>
      <div className="tool-head">
        <span className="tool-icon">{icon}</span>
        <span className="tool-title">{presentation.label}</span>
        {presentation.summary ? <span className={cx("tool-summary", presentation.mono && "mono")}>{truncate(presentation.summary, 120)}</span> : <span className="tool-summary" />}
        {duration && block.status !== "running" ? <span className="tool-duration">{duration}</span> : null}
        {block.status === "running" ? (
          <span className="tool-status running"><span className="tool-spinner" /> working</span>
        ) : block.status === "error" ? (
          <span className="tool-status error"><CircleAlert size={11} /> failed</span>
        ) : (
          <span className="tool-done" title="Done"><CircleCheck size={13} /></span>
        )}
        {result ? (
          <button
            type="button"
            className="tool-copy"
            title="Copy result"
            onClick={() => {
              void navigator.clipboard.writeText(result);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
          </button>
        ) : null}
      </div>
      {block.intent ? <div className="tool-intent">{block.intent}</div> : null}
      {hasArgs || result ? (
        <div className="tool-details">
          {hasArgs ? (
            <details className="tool-output">
              <summary>Arguments</summary>
              <pre>{typeof block.args === "string" ? block.args : JSON.stringify(block.args, null, 2)}</pre>
            </details>
          ) : null}
          {result ? (
            <details className="tool-output">
              <summary>Result · {result.split("\n").length} line{result.split("\n").length === 1 ? "" : "s"}</summary>
              <pre>{truncate(result, 20_000)}</pre>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function describeTool(
  name: string,
  args: unknown,
  snapshot: ReturnType<typeof useApp.getState>["snapshot"],
): { label: string; summary: string; mono?: boolean } {
  const key = name.toLowerCase();
  const record = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const threadName = (id: unknown) => {
    const value = str(id);
    const thread = snapshot?.threads.find((item) => item.id === value);
    return thread?.title ?? (value ? value.slice(-6) : "child thread");
  };
  const nodeName = (id: unknown) => {
    const value = str(id);
    return snapshot?.nodes.find((item) => item.id === value)?.name ?? (value ? value.slice(-6) : "node");
  };
  let summary = "";
  let mono = false;
  switch (key) {
    case "tree_wait": {
      const ids = Array.isArray(record.threadIds) ? record.threadIds : [];
      const names = ids.slice(0, 3).map(threadName).join(", ");
      const minutes = record.timeoutMs ? Math.round(Number(record.timeoutMs) / 60_000) : 0;
      summary = `${names || "child threads"}${minutes ? ` · ${minutes}m timeout` : ""}`;
      break;
    }
    case "tree_list":
      summary = [record.depth ? `depth ${record.depth}` : "", record.includeStatus ? "with statuses" : ""].filter(Boolean).join(" · ");
      break;
    case "tree_message":
      summary = `${threadName(record.toThreadId ?? record.threadId)}${record.kind ? ` · ${record.kind}` : ""}`;
      break;
    case "tree_create_thread":
      summary = `${str(record.title) || "worker"}${record.model ? ` · ${String(record.model).split("/").pop()}` : ""}`;
      break;
    case "tree_create_node":
      summary = `${str(record.type) || "node"}${record.name ? ` · ${record.name}` : ""}`;
      break;
    case "tree_resolve_thread":
      summary = threadName(record.threadId);
      break;
    case "tree_cancel":
      summary = threadName(record.threadId);
      break;
    case "tree_report":
      summary = [str(record.status), truncate(str(record.summary), 80)].filter(Boolean).join(" · ");
      break;
    case "tree_ask_parent":
      summary = truncate(str(record.question), 100);
      break;
    case "tree_git":
      summary = [str(record.op), threadName(record.threadId)].filter(Boolean).join(" · ");
      break;
    case "tree_memory_write":
      summary = truncate(str(record.text), 90);
      break;
    case "tree_memory_read":
      summary = truncate(str(record.query) || "recall", 60);
      break;
    case "tree_create_environment":
    case "tree_update_environment":
      summary = str(record.name) || str(record.environmentId);
      break;
    case "tree_assign_environment":
      summary = `${nodeName(record.nodeId)} · ${str(record.environmentId)}`;
      break;
    case "bash":
      summary = truncate(str(record.command), 110);
      mono = true;
      break;
    case "read":
    case "edit":
    case "write":
    case "notebook":
      summary = str(record.path) || str(record.file_path) || str(record.filePath);
      mono = true;
      break;
    case "grep":
    case "glob":
    case "ast_grep":
      summary = [str(record.pattern), str(record.path)].filter(Boolean).join(" · ");
      mono = true;
      break;
    case "task":
    case "ask":
      summary = truncate(str(record.description) || str(record.question) || str(record.prompt), 100);
      break;
    case "web_search":
    case "web_fetch":
      summary = truncate(str(record.query) || str(record.url), 100);
      break;
    default: {
      const values = Object.entries(record)
        .filter(([, value]) => typeof value === "string" || typeof value === "number")
        .slice(0, 2)
        .map(([, value]) => String(value));
      summary = truncate(values.join(" · "), 100);
    }
  }
  return { label: toolLabel(key), summary, mono };
}

function toolLabel(key: string): string {
  const labels: Record<string, string> = {
    tree_wait: "Wait",
    tree_list: "Tree",
    tree_message: "Message",
    tree_create_thread: "New thread",
    tree_create_node: "New node",
    tree_report: "Report",
    tree_ask_parent: "Ask parent",
    tree_reply: "Reply",
    tree_cancel: "Cancel",
    tree_resolve_thread: "Resolve",
    tree_git: "Git",
    tree_memory_write: "Remember",
    tree_memory_read: "Recall",
    tree_set_title: "Title",
    tree_create_environment: "New environment",
    tree_update_environment: "Update environment",
    tree_assign_environment: "Assign environment",
    tree_list_environments: "Environments",
    tree_test_environment: "Test environment",
    bash: "Shell",
    read: "Read",
    edit: "Edit",
    write: "Write",
    grep: "Search",
    glob: "Find files",
    ast_grep: "Search code",
    ast_edit: "Edit code",
    task: "Subagent",
    web_search: "Web search",
    web_fetch: "Fetch",
    ask: "Ask",
    todo: "Plan",
    goal: "Goal",
    python: "Python",
    eval: "Eval",
    notebook: "Notebook",
    github: "GitHub",
  };
  return labels[key] ?? key.replace(/^mcp__/, "").replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function EnvelopeCard({
  header,
  body,
  from,
}: {
  header: Record<string, string>;
  body: string;
  from: string;
}) {
  const direction = header.direction ?? "down";
  const kind = header.kind ?? "task";
  return (
    <div className={cx("envelope-card", direction)}>
      <div className="envelope-top">
        <Badge tone={direction === "up" ? "green" : direction === "down" ? "accent" : "neutral"}>
          {direction === "up" ? "↑ up" : direction === "down" ? "↓ down" : "↔ lateral"}
        </Badge>
        <Badge tone="blue">{kind}</Badge>
        <span className="envelope-from">{from}</span>
        <span className="envelope-id">{header.id}</span>
      </div>
      {header.subject ? <div className="envelope-subject">{header.subject}</div> : null}
      <div className="envelope-body">{body}</div>
      {header.requiresResponse?.startsWith("YES") ? <div className="envelope-requires">Response required</div> : null}
    </div>
  );
}

function parseEnvelope(message: ChatMessage): { header: Record<string, string>; body: string; from: string } | null {
  const text = message.blocks.filter((block) => block.type === "text").map((block) => (block as any).text).join("\n").trim();
  if (!text.startsWith("[TREE MESSAGE")) return null;
  const split = text.indexOf("\n\n");
  const head = split >= 0 ? text.slice(0, split) : text;
  const body = split >= 0 ? text.slice(split + 2) : "";
  const lines = head.split("\n");
  const first = lines[0] ?? "";
  const header: Record<string, string> = {};
  const matches = first.matchAll(/(\w+)=([^\s\]]+)/g);
  for (const match of matches) header[match[1]] = match[2];
  for (const line of lines.slice(1)) {
    const index = line.indexOf(":");
    if (index > 0) header[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return { header, body, from: header.from ?? "tree" };
}

function toolIcon(name: string) {
  const value = name.toLowerCase();
  if (value.startsWith("tree_") && value.includes("wait")) return <Clock size={13} />;
  if (value.startsWith("tree_") && (value.includes("message") || value.includes("report") || value.includes("reply") || value.includes("ask"))) return <MessageSquare size={13} />;
  if (value.startsWith("tree_")) return <GitBranch size={13} />;
  if (value.includes("bash") || value.includes("terminal")) return <Terminal size={13} />;
  if (value.includes("edit") || value.includes("write")) return <FileEdit size={13} />;
  if (value.includes("read")) return <FileText size={13} />;
  if (value.includes("grep") || value.includes("glob") || value.includes("find")) return <Search size={13} />;
  if (value.includes("web")) return <Globe size={13} />;
  if (value.includes("todo") || value.includes("plan")) return <ListChecks size={13} />;
  if (value.includes("task") || value.includes("agent")) return <Bot size={13} />;
  return <Wrench size={13} />;
}
