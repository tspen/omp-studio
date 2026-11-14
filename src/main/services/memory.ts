import { randomUUID } from "node:crypto";
import type { MemoryEntry, Thread } from "../../shared/types";
import type { Store } from "./store";

export class MemoryService {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  list(nodeId: string): MemoryEntry[] {
    return this.store.listMemory(nodeId).sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
  }

  add(input: {
    nodeId: string;
    text: string;
    tags?: string[];
    importance?: number;
    source?: MemoryEntry["source"];
    sourceThreadId?: string;
  }): MemoryEntry {
    const now = Date.now();
    const entry: MemoryEntry = {
      id: `mem_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      nodeId: input.nodeId,
      text: input.text.trim(),
      tags: (input.tags ?? []).map((tag) => tag.trim()).filter(Boolean).slice(0, 12),
      importance: clamp(input.importance ?? 0.6, 0, 1),
      source: input.source ?? "orchestrator",
      sourceThreadId: input.sourceThreadId,
      createdAt: now,
      updatedAt: now,
    };
    return this.store.addMemory(entry);
  }

  update(id: string, patch: Partial<MemoryEntry>): MemoryEntry {
    return this.store.updateMemory(id, patch);
  }

  remove(id: string): void {
    this.store.deleteMemory(id);
  }

  recall(nodeId: string, query = "", limit = 12): MemoryEntry[] {
    const nodes = this.scopeNodeIds(nodeId);
    const entries = nodes.flatMap((id) => this.store.listMemory(id));
    const terms = tokenize(query);
    const now = Date.now();
    const scored = entries.map((entry) => {
      const haystack = `${entry.text} ${entry.tags.join(" ")}`.toLowerCase();
      let score = entry.importance * 2;
      for (const term of terms) {
        if (haystack.includes(term)) score += 2.5;
      }
      const ageDays = (now - entry.updatedAt) / 86_400_000;
      score += Math.max(0, 1.5 - ageDays / 30);
      if (entry.source === "orchestrator") score += 0.3;
      return { entry, score };
    });
    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit))
      .map((item) => item.entry);
  }

  promptBlock(nodeId: string, tokenBudget = this.store.settings.memory.injectTokenLimit): string {
    const entries = this.recall(nodeId, "", 16);
    if (entries.length === 0) return "";
    const lines: string[] = ["Persistent memory for this level (heuristic; verify against repo state):"];
    let used = 0;
    for (const entry of entries) {
      const line = `- [${entry.source}/${entry.importance.toFixed(1)}] ${entry.text}`;
      const approx = Math.ceil(line.length / 4);
      if (used + approx > tokenBudget) break;
      used += approx;
      lines.push(line);
    }
    return lines.join("\n");
  }

  consolidate(nodeId: string): MemoryEntry[] {
    const entries = this.list(nodeId);
    const seen = new Map<string, MemoryEntry>();
    for (const entry of entries) {
      const key = entry.text
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 160);
      const existing = seen.get(key);
      if (existing) {
        existing.importance = Math.max(existing.importance, entry.importance);
        existing.tags = [...new Set([...existing.tags, ...entry.tags])].slice(0, 12);
        existing.updatedAt = Date.now();
        this.store.deleteMemory(entry.id);
      } else {
        seen.set(key, entry);
      }
    }
    return this.list(nodeId);
  }

  autoCapture(thread: Thread, summary: string): MemoryEntry | undefined {
    if (!this.store.settings.memory.autoCapture) return undefined;
    const text = summary.replace(/\s+/g, " ").trim();
    if (text.length < 40) return undefined;
    const clipped = text.length > 700 ? `${text.slice(0, 700)}…` : text;
    return this.add({
      nodeId: thread.nodeId,
      text: `Thread “${thread.title}” outcome: ${clipped}`,
      tags: ["auto", "thread-result", thread.kind],
      importance: 0.35,
      source: "auto",
      sourceThreadId: thread.id,
    });
  }

  scopeNodeIds(nodeId: string): string[] {
    const ids: string[] = [];
    let current = this.store.getNode(nodeId);
    while (current) {
      ids.push(current.id);
      current = current.parentId ? this.store.getNode(current.parentId) : undefined;
    }
    return ids.reverse();
  }

  markdown(nodeId: string): string {
    const node = this.store.getNode(nodeId);
    const entries = this.list(nodeId);
    const lines = [`# Memory — ${node?.name ?? nodeId}`, ""];
    if (entries.length === 0) lines.push("_No memories recorded yet._");
    for (const entry of entries) {
      lines.push(`## ${entry.tags.join(", ") || "general"} · ${entry.importance.toFixed(2)}`);
      lines.push(entry.text);
      lines.push("");
    }
    return lines.join("\n");
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 2)
    .slice(0, 16);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
