# OMP Studio

A Windows desktop cockpit for [oh-my-pi](https://github.com/can1357/oh-my-pi) built around a **tree of orchestrators**. The main chat is an orchestrator; it delegates down to groups, projects and worker threads, and every child sends typed messages back up. Projects stay linked to git, models are chosen explicitly with Artificial Analysis ordering, and memory is captured at the level where it matters.

## What is in the box

- **Tree orchestrators**: Root → Groups → Projects → Worker threads. Each level has its own OMP session, context, model, environment and memory.
- **Messages up and down**: `tree_*` host tools let orchestrators spawn nodes/threads, send tasks, ask blocking questions, report results, escalate blockers, wait, cancel and inspect git. Every envelope is durable and visible in the message bus.
- **OMP under the hood**: The app launches the real `omp.exe` in `--mode rpc-ui`, uses OMP's model catalog, tools, skills, auth, session files, subagents, goal mode and approvals. It does not reimplement the agent loop.
- **Explicit model selection**: Per-thread model and reasoning effort, plus role defaults for root/group/project/worker/naming/memory. Defaults are ordered by Artificial Analysis data, fetched daily from the public leaderboard; unmatched models fall back to a local quality estimate labelled `Q`.
- **Git-aware threads**: Project repositories, worker branches and worktrees, status, diffs, commit, merge and PR actions. Worktrees live outside the repository so unmerged work is not silently destroyed.
- **Environments**: Local env vars, secrets, setup/teardown commands, shell, git isolation and approval mode, assignable per node and inherited.
- **Memory**: Per-node durable memory, visible and editable. Orchestrators write through `tree_memory_write`; completed thread outcomes are auto-captured as low-importance entries.
- **Notifications**: Windows toasts, tray badge, in-app inbox, per-node mute.
- **Thread history**: Fork from an entry or rewind the leaf; goal mode; live read-only share over a local token URL.
- **Tools and settings**: OMP tool matrix with per-tool approval, full dynamic OMP config browser, skills/MCP inventory, engine manager.

## Run it

Requirements: Windows 10/11 x64, Node.js 22+ (built with Node 24), git, and an OMP-authenticated provider.

```powershell
npm install
npm run fetch:omp   # downloads omp-windows-x64.exe into vendor/omp (skips if present)
npm run dev
```

The app also detects an existing install at `%LOCALAPPDATA%\omp\omp.exe` or `omp.exe` on `PATH`. If none is found, Settings → Engine can download it.

## Build a Windows installer

```powershell
npm run package
```

The NSIS installer is written to `dist/`. The OMP engine is bundled as an extra resource, so the installed app has its own runtime. The binary is excluded from git by `.gitignore` and fetched by `npm run fetch:omp`.

## Architecture

```
React renderer
   │ typed IPC (contextIsolation)
Electron main
   ├─ OMP Supervisor ── one omp.exe session per active thread, RPC v2 framing
   ├─ Orchestrator ───── tree, host tools, scheduling, auto-reports, budgets
   ├─ MessageBus ─────── envelopes, traces, questions, answers, directions
   ├─ GitService ─────── status/diff/worktrees/branches/merge/PR
   ├─ MemoryService ──── per-node memory and recall
   ├─ ModelService ───── OMP catalog + AA daily refresh + role defaults
   ├─ EnvironmentService local env profiles + DPAPI secrets
   ├─ NotificationService Windows toasts / tray / inbox
   └─ ShareService ───── read-only live transcript over 127.0.0.1
```

OMP session files remain the transcript source of truth. OMP Studio keeps a compact message/envelope log, a normalized transcript cache for fast paint, and app metadata in `%APPDATA%\omp-studio\omp-studio`.

## Tree protocol (host tools)

`tree_list`, `tree_create_node`, `tree_create_thread`, `tree_message`, `tree_ask_parent`, `tree_report`, `tree_reply`, `tree_wait`, `tree_cancel`, `tree_git`, `tree_memory_write`, `tree_memory_read`, `tree_set_title`.

A parent prompt says: state objective, constraints and definition of done; spawn a thread for independent work; report upward at milestones and before finishing; ask blocking questions instead of guessing. A child prompt says: work only in your assignment, report evidence, never merge/push without permission.

## Known scope and choices

- Environments are local only (env vars, secrets, setup scripts, services via commands). Docker/WSL/remote are intentionally deferred.
- Model scores come from the public Artificial Analysis leaderboard; the app fetches it daily and labels the source. No API key is required.
- The tree is logically unlimited, but concurrent OMP sessions are capped in Settings (default 8) and idle sessions are parked.
- Plan mode is disabled by policy. Goal mode, advisor, history/fork, artifacts, terminal, diffs and live sharing are exposed.
- Live sharing is read-only. Steering guests is not implemented.

## Attribution

- OMP / oh-my-pi: MIT, https://github.com/can1357/oh-my-pi
- Artificial Analysis data: https://artificialanalysis.ai
