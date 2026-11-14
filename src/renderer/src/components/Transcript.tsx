import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleCheck,
  CircleDashed,
  Copy,
  FileEdit,
  FileText,
  Globe,
  Image as ImageIcon,
  ListChecks,
  Search,
  Terminal,
  Wrench,
  Plus,
} from "lucide-react";
import type { ChatBlock, ChatMessage, Thread } from "../../../shared/types";
import { useApp } from "../store";
import { Badge, Logo, Markdown, Button, cx, formatNumber, relativeTime, statusLabel, truncate } from "./Common";

export function Transcript({ thread, messages }: { thread: Thread; messages: ChatMessage[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const showThinking = useApp((state) => state.snapshot?.settings.ui.showThinking ?? true);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      setStick(distance < 120);
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (stick) bottomRef.current?.scrollIntoView({ behavior: messages.length > 20 ? "auto" : "smooth", block: "end" });
  }, [messages, thread.status, stick]);

  return (
    <div className="transcript" ref={scrollRef}>
      <div className="transcript-inner">
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
        {!messages.length && thread.status !== "running" ? (
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
        <div ref={bottomRef} />
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
          <span>{thread.kind === "orchestrator" ? "Orchestrator" : thread.kind === "native" ? "OMP subagent" : "Worker thread"}</span>
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
            <strong>{message.model ?? "OMP"}</strong>
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
  if (block.type === "image") {
    return <div className="image-block"><ImageIcon size={14} /> Image attachment</div>;
  }
  return null;
}

function ToolCard({ block }: { block: Extract<ChatBlock, { type: "tool" }> }) {
  const [copied, setCopied] = useState(false);
  const icon = toolIcon(block.name);
  const args = summarizeArgs(block.args);
  const result = block.result ?? "";
  return (
    <div className={cx("tool-card", block.status)}>
      <div className="tool-head">
        <span className="tool-icon">{icon}</span>
        <span className="tool-name">{block.name}</span>
        {args ? <span className="tool-args">{truncate(args, 110)}</span> : null}
        <span className={cx("tool-status", block.status)}>
          {block.status === "running" ? "running" : block.status === "error" ? "failed" : "done"}
        </span>
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
      {result ? (
        <details className="tool-output">
          <summary>{result.split("\n").length} lines of output</summary>
          <pre>{truncate(result, 20_000)}</pre>
        </details>
      ) : null}
    </div>
  );
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
  if (value.includes("bash") || value.includes("terminal")) return <Terminal size={14} />;
  if (value.includes("edit") || value.includes("write")) return <FileEdit size={14} />;
  if (value.includes("read")) return <FileText size={14} />;
  if (value.includes("grep") || value.includes("glob") || value.includes("find")) return <Search size={14} />;
  if (value.includes("web")) return <Globe size={14} />;
  if (value.includes("todo")) return <ListChecks size={14} />;
  return <Wrench size={14} />;
}

function summarizeArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    if (typeof args === "object") {
      const record = args as Record<string, unknown>;
      for (const key of ["path", "file_path", "filePath", "command", "query", "pattern", "description"]) {
        if (typeof record[key] === "string") return `${key}: ${record[key]}`;
      }
    }
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}
