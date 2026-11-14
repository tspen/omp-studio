import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { GitFileStatus, GitStatus } from "../../shared/types";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class GitService {
  async run(cwd: string, args: string[], timeoutMs = 60_000): Promise<ExecResult> {
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd,
          windowsHide: true,
          timeout: timeoutMs,
          maxBuffer: 32 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const code = error && typeof (error as any).code === "number" ? (error as any).code : error ? 1 : 0;
          resolve({ code, stdout: stdout ?? "", stderr: stderr ?? (error ? String(error.message) : "") });
        },
      );
    });
  }

  async isRepo(path: string): Promise<boolean> {
    if (!existsSync(path)) return false;
    const result = await this.run(path, ["rev-parse", "--is-inside-work-tree"]);
    return result.code === 0 && result.stdout.trim() === "true";
  }

  async root(path: string): Promise<string | undefined> {
    const result = await this.run(path, ["rev-parse", "--show-toplevel"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async branch(path: string): Promise<string | undefined> {
    const result = await this.run(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async status(path: string): Promise<GitStatus> {
    const now = Date.now();
    if (!existsSync(path)) {
      return { isRepo: false, ahead: 0, behind: 0, files: [], clean: true, error: "Path does not exist", updatedAt: now };
    }
    if (!(await this.isRepo(path))) {
      return { isRepo: false, ahead: 0, behind: 0, files: [], clean: true, updatedAt: now };
    }
    const result = await this.run(path, ["status", "--porcelain=v2", "--branch"]);
    if (result.code !== 0) {
      return { isRepo: false, ahead: 0, behind: 0, files: [], clean: true, error: result.stderr.trim(), updatedAt: now };
    }
    const files: GitFileStatus[] = [];
    let branch = "";
    let upstream = "";
    let ahead = 0;
    let behind = 0;
    for (const raw of result.stdout.split(/\r?\n/)) {
      if (!raw) continue;
      if (raw.startsWith("# branch.head ")) {
        branch = raw.slice("# branch.head ".length).trim();
      } else if (raw.startsWith("# branch.upstream ")) {
        upstream = raw.slice("# branch.upstream ".length).trim();
      } else if (raw.startsWith("# branch.ab ")) {
        const match = raw.match(/\+(\d+)\s+-(\d+)/);
        if (match) {
          ahead = Number(match[1]);
          behind = Number(match[2]);
        }
      } else if (raw.startsWith("1 ") || raw.startsWith("2 ") || raw.startsWith("u ")) {
        const parts = raw.split(" ");
        const xy = parts[1] ?? "..";
        const pathPart = raw.startsWith("2 ") ? parts.slice(9).join(" ").split("\t")[0] : parts.slice(8).join(" ");
        files.push({
          path: pathPart,
          index: xy[0] ?? ".",
          worktree: xy[1] ?? ".",
          staged: xy[0] !== "." && xy[0] !== "?",
          untracked: false,
        });
      } else if (raw.startsWith("? ")) {
        const file = raw.slice(2);
        files.push({ path: file, index: "?", worktree: "?", staged: false, untracked: true });
      }
    }
    const log = await this.run(path, ["log", "-1", "--pretty=format:%h%x00%s%x00%an%x00%aI"]);
    let lastCommit: GitStatus["lastCommit"];
    if (log.code === 0 && log.stdout.trim()) {
      const [hash, subject, author, date] = log.stdout.split("\0");
      lastCommit = { hash, subject, author, date };
    }
    return {
      isRepo: true,
      root: await this.root(path),
      branch: branch === "(detached)" ? "detached" : branch,
      upstream,
      ahead,
      behind,
      files,
      clean: files.length === 0,
      lastCommit,
      updatedAt: now,
    };
  }

  async diff(path: string, file?: string): Promise<string> {
    const args = ["diff", "--no-color", "--", ...(file ? [file] : [])];
    const result = await this.run(path, args);
    if (result.stdout.trim()) return result.stdout;
    // Include staged changes too.
    const staged = await this.run(path, ["diff", "--cached", "--no-color", "--", ...(file ? [file] : [])]);
    return staged.stdout || result.stdout;
  }

  async addWorktree(repoPath: string, worktreePath: string, branch: string, baseBranch?: string): Promise<ExecResult> {
    mkdirSync(dirname(worktreePath), { recursive: true });
    const base = baseBranch || (await this.branch(repoPath)) || "HEAD";
    let result = await this.run(repoPath, ["worktree", "add", "-b", branch, worktreePath, base], 180_000);
    if (result.code !== 0 && /already exists/i.test(result.stderr)) {
      result = await this.run(repoPath, ["worktree", "add", worktreePath, branch], 180_000);
    }
    return result;
  }

  async removeWorktree(repoPath: string, worktreePath: string, force = false): Promise<ExecResult> {
    return this.run(repoPath, ["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], 120_000);
  }

  async commit(path: string, message: string, paths?: string[]): Promise<ExecResult> {
    const add = await this.run(path, ["add", "-A", "--", ...(paths?.length ? paths : ["."])]);
    if (add.code !== 0) return add;
    return this.run(path, ["commit", "-m", message]);
  }

  async merge(repoPath: string, branch: string): Promise<ExecResult> {
    return this.run(repoPath, ["merge", "--no-ff", branch, "-m", `Merge ${branch}`], 180_000);
  }

  async discard(worktreePath: string): Promise<ExecResult> {
    const reset = await this.run(worktreePath, ["reset", "--hard", "HEAD"]);
    if (reset.code !== 0) return reset;
    return this.run(worktreePath, ["clean", "-fd"]);
  }

  async createPr(cwd: string, title: string, body: string): Promise<ExecResult & { url?: string }> {
    return new Promise((resolve) => {
      execFile(
        "gh",
        ["pr", "create", "--title", title, "--body", body],
        { cwd, windowsHide: true, timeout: 180_000, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
        (error, stdout, stderr) => {
          const text = (stdout ?? "") + (stderr ?? "");
          const url = text.match(/https:\/\/github\.com\/[^\s]+/)?.[0];
          resolve({ code: error ? 1 : 0, stdout: stdout ?? "", stderr: stderr ?? "", url, ...(error ? { stderr: text } : {}) });
        },
      );
    });
  }

  async log(path: string, limit = 20): Promise<Array<{ hash: string; subject: string; author: string; date: string }>> {
    const result = await this.run(path, ["log", `-${limit}`, "--pretty=format:%h%x00%s%x00%an%x00%aI"]);
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, subject, author, date] = line.split("\0");
        return { hash, subject, author, date };
      });
  }

  readFile(path: string): { content: string; size: number; binary: boolean } {
    const stat = statSync(path);
    if (stat.size > 4 * 1024 * 1024) {
      return { content: "", size: stat.size, binary: true };
    }
    const buffer = readFileSync(path);
    const binary = buffer.includes(0);
    return { content: binary ? "" : buffer.toString("utf8"), size: stat.size, binary };
  }
}
