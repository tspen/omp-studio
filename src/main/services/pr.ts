import { execFile } from "node:child_process";
import type { CiRun, PrStatus } from "../../shared/types";

function gh(cwd: string, args: string[], timeout = 60_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      { cwd, windowsHide: true, timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({ ok: !error, stdout: stdout ?? "", stderr: (stderr ?? "") + (error && !stderr ? error.message : "") });
      },
    );
  });
}

export class PrService {
  async status(cwd: string): Promise<PrStatus> {
    const result = await gh(cwd, [
      "pr",
      "view",
      "--json",
      "number,title,url,state,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,headRefName",
    ]);
    if (!result.ok) {
      const branch = await gh(cwd, ["branch", "--show-current"]);
      return { ok: false, error: result.stderr.trim() || "No pull request for this branch", branch: branch.stdout.trim() };
    }
    try {
      const data = JSON.parse(result.stdout) as any;
      const checks = (data.statusCheckRollup ?? []).map((item: any) => ({
        name: item.name ?? item.context ?? item.workflowName ?? "check",
        workflow: item.workflowName,
        status: item.status ?? item.state ?? "unknown",
        conclusion: item.conclusion ?? item.state ?? "unknown",
        url: item.detailsUrl ?? item.targetUrl,
      }));
      return {
        ok: true,
        number: data.number,
        title: data.title,
        url: data.url,
        state: data.state,
        draft: !!data.isDraft,
        mergeable: data.mergeable,
        mergeStateStatus: data.mergeStateStatus,
        reviewDecision: data.reviewDecision,
        branch: data.headRefName,
        checks,
      };
    } catch (error) {
      return { ok: false, error: `Could not parse gh output: ${String(error)}` };
    }
  }

  async runs(cwd: string): Promise<CiRun[]> {
    const result = await gh(cwd, [
      "run",
      "list",
      "--limit",
      "10",
      "--json",
      "databaseId,displayTitle,workflowName,status,conclusion,headBranch,createdAt,url",
    ]);
    if (!result.ok) {
      if (/no runs found/i.test(result.stderr)) return [];
      throw new Error(result.stderr.trim() || "Could not list CI runs");
    }
    try {
      const data = JSON.parse(result.stdout) as any[];
      return data.map((item) => ({
        id: String(item.databaseId),
        title: item.displayTitle ?? item.workflowName ?? "run",
        workflow: item.workflowName,
        status: item.status ?? "unknown",
        conclusion: item.conclusion ?? "",
        branch: item.headBranch,
        createdAt: item.createdAt ? Date.parse(item.createdAt) : undefined,
        url: item.url,
      }));
    } catch {
      return [];
    }
  }

  async logs(cwd: string, runId: string): Promise<{ ok: boolean; output: string }> {
    const failed = await gh(cwd, ["run", "view", runId, "--log-failed"], 180_000);
    const text = failed.stdout.trim() || failed.stderr.trim();
    if (text && !/no failed jobs/i.test(text)) return { ok: failed.ok, output: text.slice(-60_000) };
    const all = await gh(cwd, ["run", "view", runId, "--log"], 180_000);
    return { ok: all.ok, output: (all.stdout.trim() || all.stderr.trim()).slice(-60_000) };
  }

  async rerun(cwd: string, runId: string): Promise<{ ok: boolean; output: string }> {
    const result = await gh(cwd, ["run", "rerun", runId, "--failed"]);
    return { ok: result.ok, output: (result.stdout || result.stderr).trim() || (result.ok ? "Re-run requested" : "Re-run failed") };
  }

  async merge(cwd: string, number: number): Promise<{ ok: boolean; output: string }> {
    const result = await gh(cwd, ["pr", "merge", String(number), "--squash"]);
    return { ok: result.ok, output: (result.stdout || result.stderr).trim() || (result.ok ? "Merged" : "Merge failed") };
  }

  async comment(cwd: string, number: number, body: string): Promise<{ ok: boolean; output: string }> {
    const result = await gh(cwd, ["pr", "comment", String(number), "--body", body]);
    return { ok: result.ok, output: (result.stdout || result.stderr).trim() };
  }
}
