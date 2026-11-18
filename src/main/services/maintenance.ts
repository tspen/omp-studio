import { existsSync, promises as fsp, readdirSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { join, sep } from "node:path";
import type { MaintenanceAction as GcAction, MaintenanceReport as GcReport } from "../../shared/types";

export interface GcOptions {
  dryRun?: boolean;
  now?: number;
  graceMs?: number;
  runnerQuotaBytes?: number;
  sessionQuotaBytes?: number;
}

export interface GcState {
  nodes?: Array<{ path?: string }>;
  threads?: Array<{ sessionDir?: string; worktreePath?: string }>;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const RUNNER_QUOTA_BYTES = 20 * 1024 * 1024 * 1024;
export const SESSION_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;
const LOG_KEEP = 3;
const LOG_FILES = ["audit.log", "runtime.log", "errors.log", "memory.log", "renderer.log"];

/**
 * One filesystem walk that reports the total size of the data directory and the
/**
 * One filesystem walk that reports the total size of the data directory and the
 * size of each candidate we may delete. Directory reads and stats run on a small
 * worker pool so the sweep stays within the 100 ms performance gate.
 */
async function measure(root: string, candidates: string[], concurrency = 48): Promise<{ total: number; sizes: Map<string, number> }> {
  const sizes = new Map<string, number>();
  const prefixed = candidates.map((path) => ({ path, prefix: path.endsWith(sep) ? path : path + sep }));
  for (const candidate of prefixed) sizes.set(candidate.path, 0);
  let total = 0;
  let active = 0;
  const tasks: Array<{ kind: "dir" | "file"; path: string }> = [{ kind: "dir", path: root }];
  await new Promise<void>((resolve) => {
    const pump = () => {
      if (active === 0 && tasks.length === 0) {
        resolve();
        return;
      }
      while (active < concurrency && tasks.length) {
        const task = tasks.pop()!;
        active += 1;
        void (async () => {
          try {
            if (task.kind === "dir") {
              const entries = await fsp.readdir(task.path, { withFileTypes: true });
              for (const entry of entries) {
                const full = join(task.path, entry.name);
                tasks.push({ kind: entry.isDirectory() ? "dir" : "file", path: full });
              }
            } else {
              const size = (await fsp.stat(task.path)).size;
              total += size;
              for (const candidate of prefixed) {
                if (task.path.startsWith(candidate.prefix)) sizes.set(candidate.path, (sizes.get(candidate.path) ?? 0) + size);
              }
            }
          } catch {
            /* skip unreadable */
          } finally {
            active -= 1;
            pump();
          }
        })();
      }
    };
    pump();
  });
  return { total, sizes };
}
function listDirs(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(path, entry.name));
  } catch {
    return [];
  }
}

/**
 * Label-scoped sweep of everything the runner owns. It never touches files outside
 * the Perch data directory, never runs a global Docker prune, and never deletes a
 * resource that current state still references.
 */
export async function collectGarbage(baseDir: string, state: GcState | null, options: GcOptions = {}): Promise<GcReport> {
  const started = Date.now();
  const now = options.now ?? started;
  const dryRun = options.dryRun !== false;
  const grace = options.graceMs ?? 5 * MINUTE;
  const quota = options.runnerQuotaBytes ?? RUNNER_QUOTA_BYTES;
  const warnings: string[] = [];

  const referenced = {
    sessions: new Set<string>(),
    workspaces: new Set<string>(),
    worktrees: new Set<string>(),
  };
  for (const thread of state?.threads ?? []) {
    if (thread.sessionDir) referenced.sessions.add(thread.sessionDir.toLowerCase());
  }
  for (const node of state?.nodes ?? []) {
    if (node.path) referenced.workspaces.add(node.path.toLowerCase());
  }
  for (const thread of state?.threads ?? []) {
    if (thread.worktreePath) referenced.worktrees.add(thread.worktreePath.toLowerCase());
  }

  const candidates: Array<{ kind: GcAction["kind"]; path: string; reason: string }> = [];
  const consider = (kind: GcAction["kind"], path: string, reason: string, maxAgeMs: number) => {
    let info;
    try {
      info = statSync(path);
    } catch {
      return;
    }
    if (!info.isDirectory()) return;
    if (now - info.mtimeMs < Math.max(maxAgeMs, grace)) return;
    candidates.push({ kind, path, reason });
  };

  for (const dir of listDirs(join(baseDir, "sessions"))) {
    if (!referenced.sessions.has(dir.toLowerCase())) consider("session-dir", dir, "session no longer referenced by a thread", 5 * MINUTE);
  }
  for (const dir of listDirs(join(baseDir, "workspaces"))) {
    if (!referenced.workspaces.has(dir.toLowerCase())) consider("workspace", dir, "imported workspace has no node", 5 * MINUTE);
  }
  for (const dir of listDirs(join(baseDir, "worktrees"))) {
    if (!referenced.worktrees.has(dir.toLowerCase())) consider("worktree", dir, "worktree is not attached to a thread", DAY);
  }
  for (const dir of listDirs(join(baseDir, "share"))) {
    consider("share-bundle", dir, "share bundle expired", DAY);
  }
  for (const dir of listDirs(join(baseDir, "artifacts"))) {
    consider("artifact", dir, "artifact older than 30 days", 30 * DAY);
  }

  const logs: Array<{ path: string; size: number }> = [];
  for (const name of LOG_FILES) {
    const file = join(baseDir, name);
    if (!existsSync(file)) continue;
    try {
      const size = statSync(file).size;
      if (size >= LOG_ROTATE_BYTES) logs.push({ path: file, size });
    } catch {
      /* skip unreadable */
    }
  }

  const { total, sizes } = await measure(baseDir, candidates.map((candidate) => candidate.path));

  const actions: GcAction[] = candidates.map((candidate) => ({
    ...candidate,
    bytes: sizes.get(candidate.path) ?? 0,
  }));
  for (const log of logs) {
    actions.push({ kind: "log", path: log.path, bytes: log.size, reason: "log exceeded 20 MB" });
  }

  if (!dryRun) {
    for (const action of actions) {
      if (action.kind === "log") {
        try {
          for (let index = LOG_KEEP - 1; index >= 1; index -= 1) {
            const from = `${action.path}.${index}`;
            const to = `${action.path}.${index + 1}`;
            if (existsSync(from)) {
              rmSync(to, { force: true });
              renameSync(from, to);
            }
          }
          renameSync(action.path, `${action.path}.1`);
          truncateSync(action.path, 0);
        } catch {
          warnings.push(`could not rotate ${action.path}`);
        }
        continue;
      }
      try {
        rmSync(action.path, { recursive: true, force: true });
      } catch {
        warnings.push(`could not remove ${action.path}`);
      }
    }
  }

  const bytesReclaimed = actions.reduce((sum, action) => sum + action.bytes, 0);
  const quotaUsedPct = quota > 0 ? Math.round((total / quota) * 1000) / 10 : 0;
  if (quotaUsedPct >= 100) warnings.push("runner disk quota is exhausted; new sessions should be refused");
  else if (quotaUsedPct >= 80) warnings.push("runner disk usage is above 80% of quota");

  return {
    at: now,
    dryRun,
    actions,
    bytesReclaimed,
    runnerBytes: total,
    quotaBytes: quota,
    quotaUsedPct,
    warnings,
    durationMs: Date.now() - started,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}


