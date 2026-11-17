#!/usr/bin/env node
/**
 * omp-runner maintenance CLI.
 *
 * This is the same code the desktop runner calls at startup and every five
 * minutes, so `gc --dry-run` is an exact preview of what the app will remove.
 *
 *   node out/runner/cli/runner.js gc --dry-run
 *   node out/runner/cli/runner.js gc --json
 *   node out/runner/cli/runner.js quota
 *   node out/runner/cli/runner.js bench
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { collectGarbage, RUNNER_QUOTA_BYTES, formatBytes, type GcState } from "../main/services/maintenance";

interface StateShape {
  nodes?: Array<{ path?: string }>;
  threads?: Array<{ sessionDir?: string; worktreePath?: string }>;
}

function defaultBaseDir(): string {
  if (process.env.OMP_STUDIO_BASE_DIR) return process.env.OMP_STUDIO_BASE_DIR;
  if (process.env.OMP_STUDIO_USER_DATA) return join(process.env.OMP_STUDIO_USER_DATA, "omp-studio");
  if (process.platform === "win32") return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "omp-studio", "omp-studio");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "omp-studio", "omp-studio");
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "omp-studio", "omp-studio");
}

function parseArgs(argv: string[]) {
  const args = { command: argv[0] || "gc", dryRun: false, json: false, base: "" };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.dryRun = false;
    else if (arg === "--json") args.json = true;
    else if (arg === "--base") args.base = argv[++index] || "";
  }
  return args;
}

function loadState(base: string): GcState | null {
  const file = join(base, "state.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as StateShape;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const base = args.base ? args.base : defaultBaseDir();
  if (!existsSync(base)) {
    console.error(`OMP data directory not found: ${base}`);
    return 2;
  }
  const state = loadState(base);

  if (args.command === "bench") {
    const iterations = 20;
    const started = Date.now();
    for (let index = 0; index < iterations; index += 1) await collectGarbage(base, state, { dryRun: true });
    const average = (Date.now() - started) / iterations;
    const report = await collectGarbage(base, state, { dryRun: true });
    console.log(`gc sweep average ${average.toFixed(1)} ms over ${iterations} runs (gate: <100 ms)`);
    console.log(`data directory ${formatBytes(report.runnerBytes)} of ${formatBytes(RUNNER_QUOTA_BYTES)} (${report.quotaUsedPct}%)`);
    return average < 100 ? 0 : 1;
  }

  if (args.command === "quota") {
    const report = await collectGarbage(base, state, { dryRun: true });
    console.log(`base:   ${base}`);
    console.log(`used:   ${formatBytes(report.runnerBytes)} / ${formatBytes(report.quotaBytes)} (${report.quotaUsedPct}%)`);
    console.log(`nodes:  ${state?.nodes?.length ?? 0}, threads: ${state?.threads?.length ?? 0}`);
    for (const warning of report.warnings) console.log(`warn:   ${warning}`);
    return report.quotaUsedPct >= 100 ? 1 : 0;
  }

  const report = await collectGarbage(base, state, { dryRun: args.dryRun });
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`${report.dryRun ? "Would reclaim" : "Reclaimed"} ${formatBytes(report.bytesReclaimed)} across ${report.actions.length} item(s) in ${report.durationMs} ms`);
  console.log(`base: ${base}`);
  console.log(`used: ${formatBytes(report.runnerBytes)} / ${formatBytes(report.quotaBytes)} (${report.quotaUsedPct}%)`);
  for (const action of report.actions) console.log(`- ${action.kind} ${formatBytes(action.bytes)} ${action.path} (${action.reason})`);
  for (const warning of report.warnings) console.log(`warn: ${warning}`);
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error); process.exit(1); });

