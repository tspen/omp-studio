#!/usr/bin/env node
/**
 * Self-test for the label-scoped garbage collector.
 * Run after `npm run build:runner`:  node scripts/gc-selftest.mjs
 */
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { collectGarbage } = require("../out/runner/main/services/maintenance.js");

const base = mkdtempSync(join(tmpdir(), "perch-gc-"));
const old = Date.now() / 1000 - 7 * 24 * 60 * 60;
const make = (path, contents = "x".repeat(1024)) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "file.txt"), contents);
  utimesSync(path, old, old);
};

const referencedSession = join(base, "sessions", "keep-me");
const orphanSession = join(base, "sessions", "delete-me");
const referencedWorkspace = join(base, "workspaces", "keep-ws");
const orphanWorkspace = join(base, "workspaces", "delete-ws");
const referencedWorktree = join(base, "worktrees", "keep-wt");
for (const path of [referencedSession, orphanSession, referencedWorkspace, orphanWorkspace, referencedWorktree]) make(path);
make(join(base, "share", "expired"), "z".repeat(2048));
writeFileSync(join(base, "state.json"), "{}");

const state = {
  nodes: [{ path: referencedWorkspace }],
  threads: [{ sessionDir: referencedSession, worktreePath: referencedWorktree }],
};

const dry = await collectGarbage(base, state, { dryRun: true });
const removedDry = new Set(dry.actions.map((action) => action.path));
const keptAfterDry = ["keep-me", "keep-ws", "keep-wt"].every((name) => ![...removedDry].some((path) => path.endsWith(name)));

const applied = await collectGarbage(base, state, { dryRun: false });
const gone = ["delete-me", "delete-ws", "expired"].every((name) => !require("node:fs").existsSync(join(base, name === "expired" ? "share" : name.startsWith("delete-me") ? "sessions" : "workspaces", name)));
const survivors = ["sessions/keep-me", "workspaces/keep-ws", "worktrees/keep-wt"].every((relative) => require("node:fs").existsSync(join(base, relative)));

console.log(JSON.stringify({
  dryRunActions: dry.actions.length,
  dryRunReclaimed: dry.bytesReclaimed,
  appliedActions: applied.actions.length,
  survivors,
  orphansRemoved: gone,
  referencedKeptInPreview: keptAfterDry,
}, null, 2));

rmSync(base, { recursive: true, force: true });
if (!survivors || !gone || !keptAfterDry || dry.actions.length !== applied.actions.length) {
  console.error("GC self-test FAILED");
  process.exit(1);
}
console.log("GC self-test PASSED");
