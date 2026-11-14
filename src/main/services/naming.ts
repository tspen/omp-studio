import { execFile } from "node:child_process";
import type { ChatMessage } from "../../shared/types";
import type { EngineLocator } from "../engine/engine-locator";
import type { Store } from "./store";

export class NamingService {
  private store: Store;
  private engine: EngineLocator;
  private queue: Array<() => Promise<void>> = [];
  private running = false;
  private onUpdate?: (threadId: string, title: string) => void;
  private onNodeUpdate?: (nodeId: string, name: string) => void;

  constructor(
    store: Store,
    engine: EngineLocator,
    onUpdate?: (threadId: string, title: string) => void,
    onNodeUpdate?: (nodeId: string, name: string) => void,
  ) {
    this.store = store;
    this.engine = engine;
    this.onUpdate = onUpdate;
    this.onNodeUpdate = onNodeUpdate;
  }

  heuristicTitle(text: string, fallback = "New thread"): string {
    const cleaned = text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s{0,3}#{1,6}\s*/gm, " ")
      .replace(/[#*_>`]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/…+$/g, "")
      .replace(/^(objective|goal|task|brief|mission|assignment)\b[\s:–—-]*/i, "")
      .replace(/^you are\b[^.]*\.\s*/i, "")
      .trim();
    if (!cleaned) return fallback;
    const sentence = cleaned.split(/[.;!?](?:\s|$)/)[0] ?? cleaned;
    const filler = new Set(["the", "a", "an", "signature", "comprehensive", "complete", "robust", "full", "pure", "modern", "entire", "whole", "new"]);
    const tokens = sentence
      .split(/\s+/)
      .filter(Boolean)
      .filter((word, index) => index === 0 || !filler.has(word.toLowerCase().replace(/[^a-z0-9-]/g, "")))
      .filter((word) => !/[\\/]/.test(word));
    while (tokens.length > 1 && ["for", "in", "on", "with", "to", "of", "and", "the"].includes(tokens[tokens.length - 1].toLowerCase())) {
      tokens.pop();
    }
    const forIndex = tokens.findIndex((word, index) => index >= 2 && word.toLowerCase() === "for");
    if (forIndex > 0 && tokens.slice(forIndex + 1).some((word) => /^[A-Z0-9"“]/.test(word))) {
      tokens.length = forIndex;
    }
    const words = tokens.slice(0, 7).join(" ");
    const clipped = words.length > 52 ? words.slice(0, 52).trim() : words;
    return titleCase(clipped) || fallback;
  }

  suggestTitle(text: string, fallback = "New thread"): string {
    return this.heuristicTitle(text, fallback);
  }

  autoName(threadId: string, text: string): void {
    if (!this.store.settings.autoName) return;
    const thread = this.store.getThread(threadId);
    if (!thread?.titleAuto) return;
    if (!isPlaceholderTitle(thread.title)) return;
    const model = this.store.settings.models.naming;
    if (!model) return;
    this.enqueue(async () => {
      const result = await this.ask(
        model,
        "You name work threads in a coding cockpit. Return only a concise 3-6 word title, title case, no quotes, no punctuation at the end, maximum 48 characters.",
        `Name this work:\n\n${text.slice(0, 4000)}`,
      );
      const title = sanitizeTitle(result);
      const current = this.store.getThread(threadId);
      if (title && current?.titleAuto) {
        this.store.updateThread(threadId, { title, titleAuto: true });
        this.onUpdate?.(threadId, title);
      }
    });
  }

  suggestNodeName(text: string, fallback = "New project"): string {
    return this.heuristicTitle(text, fallback);
  }

  /** Give a freshly spawned worker a short model-written title from its brief. */
  nameWorker(threadId: string, brief: string): void {
    if (!this.store.settings.autoName) return;
    const thread = this.store.getThread(threadId);
    if (!thread?.titleAuto || thread.kind !== "worker") return;
    const model = this.store.settings.models.naming;
    if (!model) return;
    this.enqueue(async () => {
      const result = await this.ask(
        model,
        "You name coding work items in a task board. Return only a 3-6 word title, title case, no quotes, no trailing punctuation, maximum 48 characters. Describe the deliverable, never start with Objective, Task or Goal.",
        `Name this work:\n\n${brief.slice(0, 2500)}`,
      );
      const title = sanitizeTitle(result);
      const current = this.store.getThread(threadId);
      if (title && current?.titleAuto && current.kind === "worker") {
        this.store.updateThread(threadId, { title, titleAuto: true });
        this.onUpdate?.(threadId, title);
      }
    });
  }

  autoNameNode(nodeId: string, text: string): void {
    if (!this.store.settings.autoName) return;
    const node = this.store.getNode(nodeId);
    if (!node?.autoName) return;
    const model = this.store.settings.models.naming;
    if (!model) return;
    this.enqueue(async () => {
      const result = await this.ask(
        model,
        "You name projects and groups in a coding cockpit. Return only a concise 2-5 word name, title case, no quotes, maximum 40 characters.",
        `Name this ${this.store.getNode(nodeId)?.type ?? "node"}:\n\n${text.slice(0, 3000)}`,
      );
      const name = sanitizeTitle(result);
      const current = this.store.getNode(nodeId);
      if (name && current?.autoName) {
        this.store.updateNode(nodeId, { name });
        const thread = this.store.getThread(current.orchestratorThreadId);
        if (thread) this.store.updateThread(thread.id, { title: name });
        this.onNodeUpdate?.(nodeId, name);
      }
    });
  }

  /**
   * Re-title a long-running thread from a compact digest of its own chat. Uses
   * the cheap naming model with thinking off, so the cost stays negligible.
   */
  refreshTitle(threadId: string): void {
    if (!this.store.settings.autoName) return;
    const thread = this.store.getThread(threadId);
    if (!thread?.titleAuto || thread.kind !== "worker") return;
    const model = this.store.settings.models.naming;
    if (!model) return;
    const chat = this.store.getChat(threadId);
    const users = chat
      .filter((message) => message.role === "user")
      .map((message) => messageText(message))
      .filter(Boolean);
    const assistants = chat
      .filter((message) => message.role === "assistant")
      .map((message) => messageText(message))
      .filter((text) => text.length > 20);
    if (users.length < 2 || !assistants.length) return;
    const digest = [
      `Current title: ${thread.title}`,
      "",
      "User requests:",
      ...users.slice(-6).map((text) => `- ${truncate(text, 220)}`),
      "",
      "Latest progress:",
      truncate(assistants[assistants.length - 1], 360),
      "",
      "Return the best title for this work.",
    ].join("\n");
    this.enqueue(async () => {
      const result = await this.ask(
        model,
        "You maintain thread titles in a coding cockpit. Describe the work, not the process: 3-6 words, title case, no quotes, no trailing punctuation, maximum 48 characters. If the current title already fits, return it unchanged. Return only the title.",
        digest,
      );
      const title = sanitizeTitle(result);
      const current = this.store.getThread(threadId);
      if (!title || !current?.titleAuto || title.toLowerCase() === current.title.toLowerCase()) return;
      this.store.updateThread(threadId, { title, titleAuto: true });
      this.onUpdate?.(threadId, title);
    });
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length) {
      const job = this.queue.shift();
      if (!job) continue;
      try {
        await job();
      } catch {
        /* naming is best-effort */
      }
    }
    this.running = false;
  }

  private ask(model: string, system: string, prompt: string): Promise<string> {
    const exe = this.engine.resolveForSpawn();
    return new Promise((resolve, reject) => {
      execFile(
        exe,
        [
          "-p",
          "--no-session",
          "--no-tools",
          "--no-lsp",
          "--no-pty",
          "--no-title",
          "--no-skills",
          "--no-rules",
          "--no-extensions",
          "--model",
          model,
          "--thinking",
          "off",
          "--cwd",
          this.store.baseDir,
          "--system-prompt",
          system,
          prompt,
        ],
        {
          timeout: 90_000,
          maxBuffer: 4 * 1024 * 1024,
          windowsHide: true,
          encoding: "utf8",
          cwd: this.store.baseDir,
          env: { ...process.env, PI_NO_TITLE: "1" },
        },
        (error, stdout, stderr) => {
          if (error && !stdout.trim()) {
            reject(new Error(stderr || error.message));
            return;
          }
          resolve(stripAnsi(stdout));
        },
      );
    });
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "").replace(/^Working\.\.\.\s*/i, "").trim();
}

function messageText(message: ChatMessage): string {
  return message.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block as { text?: string }).text ?? "")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, length: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1).trim()}…` : clean;
}

function isPlaceholderTitle(title: string): boolean {
  return /^(new thread|new group|new project|mission control|untitled|thread \d+)$/i.test(title.trim());
}

function sanitizeTitle(value: string): string {
  let title = stripAnsi(value)
    .split(/\r?\n/)[0]
    .replace(/^["'`#*\s-]+|["'`#*\s.,;:—–-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (title.length > 60) title = `${title.slice(0, 57).trim()}…`;
  return title;
}

function titleCase(value: string): string {
  if (!value) return "";
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"]);
  return value
    .split(" ")
    .map((word, index) => {
      const lower = word.toLowerCase();
      if (index > 0 && small.has(lower)) return lower;
      if (/^[A-Z0-9.]+$/.test(word)) return word;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}
