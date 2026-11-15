import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import type { Artifact, Thread } from "../../shared/types";
import type { Store } from "./store";

export class ArtifactService {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  list(filter: { nodeId?: string; threadId?: string } = {}): Artifact[] {
    return this.store.data.artifacts.filter(
      (artifact) =>
        (!filter.nodeId || artifact.nodeId === filter.nodeId) && (!filter.threadId || artifact.threadId === filter.threadId),
    );
  }

  read(id: string): Artifact {
    const artifact = this.store.data.artifacts.find((item) => item.id === id);
    if (!artifact) throw new Error(`Artifact not found: ${id}`);
    if (artifact.path && !artifact.content && existsSync(artifact.path) && !isImagePath(artifact.path)) {
      try {
        const stat = statSync(artifact.path);
        if (stat.size < 2 * 1024 * 1024) artifact.content = readFileSync(artifact.path, "utf8");
      } catch {
        /* ignore */
      }
    }
    return artifact;
  }

  recordFile(thread: Thread, path: string, cwd: string): Artifact {
    const absolute = isAbsolute(path) ? normalize(path) : join(cwd, path);
    let size = 0;
    try {
      size = existsSync(absolute) ? statSync(absolute).size : 0;
    } catch {
      /* ignore */
    }
    return this.store.addArtifact({
      id: `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      nodeId: thread.nodeId,
      threadId: thread.id,
      kind: "file",
      name: path.split(/[\\/]/).pop() || path,
      path: absolute,
      size,
      createdAt: Date.now(),
      meta: { threadTitle: thread.title },
    });
  }

  recordDiff(thread: Thread, diff: string, name = "Thread diff"): Artifact {
    return this.store.addArtifact({
      id: `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      nodeId: thread.nodeId,
      threadId: thread.id,
      kind: "diff",
      name,
      content: diff.slice(0, 2_000_000),
      createdAt: Date.now(),
      meta: { threadTitle: thread.title },
    });
  }

  recordReport(thread: Thread, name: string, content: string): Artifact {
    return this.store.addArtifact({
      id: `art_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      nodeId: thread.nodeId,
      threadId: thread.id,
      kind: "report",
      name,
      content,
      createdAt: Date.now(),
      meta: { threadTitle: thread.title },
    });
  }
}

export function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(path);
}
