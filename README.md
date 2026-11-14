# OMP Studio

A Windows desktop cockpit for [oh-my-pi](https://github.com/can1357/oh-my-pi) built around a **tree of orchestrators**. The main chat is an orchestrator; it delegates down to groups, projects and worker threads, and every child sends typed messages back up. Projects stay linked to git, models are chosen explicitly with Artificial Analysis ordering, and memory is captured at the level where it matters.

## What is in the box

- **Tree orchestrators**: Root -> Groups -> Projects -> Worker threads. Each level has its own OMP session, context, model, environment and memory.
- **Messages up and down**: `tree_*` host tools let orchestrators spawn nodes/threads, send tasks, ask blocking questions, report results, escalate blockers, wait, cancel and inspect git. Every envelope is durable and visible in the message bus.
- **Self-managing chats**: The chat can create and reshape its own tree: new projects and groups, paths, moves, deletes, environments with setup commands, model/effort and approval policy. Setup does not have to be done by hand in Settings.
- **Sensible folder defaults**: Name a project and the path fills in under your workspace root (`~/code` when it exists, otherwise `~/Projects`, `~/source/repos` or `~/code`). The root is configurable in Settings, and collisions get a numeric suffix.
- **OMP under the hood**: The app launches the real `omp.exe` in `--mode rpc-ui`, uses OMP's model catalog, tools, skills, auth, session files, subagents, goal mode and approvals. It does not reimplement the agent loop.
- **Explicit model selection**: Per-thread model and reasoning effort, plus role defaults for root/group/project/worker/naming/memory.
- **Git-aware threads**: Project repositories, worker branches and worktrees, status, diffs, commit, merge and PR actions. Worktrees live outside the repository so unmerged work is not silently destroyed.
- **Environments**: Local env vars, secrets, setup/teardown commands, shell, git isolation and approval mode, assignable per node and inherited.
- **Memory**: Per-node durable memory, visible and editable. Orchestrators write through `tree_memory_write`; completed thread outcomes are auto-captured as low-importance entries.
- **Notifications**: Windows toasts, tray badge, in-app inbox, per-node mute.
- **Permissions where you work**: tool approval is chosen in the chat toolbar (YOLO, auto-approve writes, ask always) and defaults to YOLO. Switching to YOLO resolves any pending approval immediately and future tool calls skip the prompt, even in sessions that started under a stricter policy.
- **Interrupted work resumes**: if the app closes mid-turn, affected threads load as interrupted with a Continue banner. Continue reopens the OMP session and tells the model to inspect the workspace, finish the unfinished work and verify it.
- **Context management**: OMP auto-compacts history by default when the window fills, including mid-turn. The app applies the auto-compact setting to live sessions, shows a compacting indicator and offers a manual **Compact now** action in the chat header. Thresholds and method order remain OMP config values.
- **Thread history**: Fork from an entry or rewind the leaf; goal mode; live read-only share over a local token URL. Worker titles refresh every few turns using the cheap naming model, throttled so titles never dominate spend.
- **Tools and settings**: OMP tool matrix with per-tool approval, full dynamic OMP config browser, skills/MCP inventory, engine manager.

## First run

OMP Studio opens a setup wizard before Mission Control:

1. **Connect a provider**. The list comes from the providers OMP knows about, with OpenCode Go first. API-key providers use OMP's own `omp login <provider>` flow, so credentials land in `~/.omp/agent/agent.db`, not in the app. OpenCode Go keys are validated against the provider model endpoint before being saved.
2. **Pick models**. Root, worker and naming defaults are selected from the connected provider using Artificial Analysis agentic value, with cost caps, free-router/batch filtering and a quality floor. Every role can still be overridden.
3. **Ready**. Notifications, auto-naming and an optional first project.

The wizard is skippable and can be re-run from Settings -> General.

## Model defaults

Defaults are not simply "highest AA score". They use an **agentic value** score derived from Artificial Analysis terminal-bench, tau2-bench, IFBench, long-context reasoning and GPQA, divided by blended cost. Auto-defaults exclude batch routes, free routers and models above the per-role cost cap; expensive models remain available by explicit choice.

For **subscription providers** (OpenCode Go, Codex, Claude Pro/Max, Copilot, Cursor, etc.) token prices are reference values, not marginal cost. Defaults there are quality/capacity-first, the UI shows "included", and usage windows come from `omp usage`. OpenCode Go is curated to default to **DeepSeek V4.1 Flash 1017** for orchestrator/worker roles; MiniMax M3 and the rest stay selectable.

## Requirements

Windows 10/11 x64, Node.js 22+ (built with Node 24), git, and an OMP-authenticated provider.

## Run it

```powershell
npm install
npm run fetch:omp   # downloads omp-windows-x64.exe into vendor/omp (skips if present)
npm run dev
```

The app also detects an existing install at `%LOCALAPPDATA%\omp\omp.exe` or `omp.exe` on `PATH`. If none is found, Settings -> Engine can download it.

## Build a Windows installer

```powershell
npm run package
```

The NSIS installer is written to `dist/`. The OMP engine is bundled as an extra resource, so the installed app has its own runtime. The binary is excluded from git by `.gitignore` and fetched by `npm run fetch:omp`.

## Architecture

```text
React renderer
   | typed IPC (contextIsolation)
Electron main
   |- OMP Supervisor ---- one omp.exe session per active thread, RPC v2 framing
   |- Orchestrator ------ tree, host tools, scheduling, auto-reports, budgets
   |- MessageBus -------- envelopes, traces, questions, answers, directions
   |- GitService -------- status/diff/worktrees/branches/merge/PR
   |- MemoryService ----- per-node memory and recall
   |- ModelService ------ OMP catalog + AA daily refresh + agentic value defaults
   |- EnvironmentService  local env profiles + DPAPI secrets
   |- NotificationService Windows toasts / tray / inbox
   |- ShareService ------ read-only live transcript over 127.0.0.1
```

OMP session files remain the transcript source of truth. OMP Studio keeps a compact message/envelope log, a normalized transcript cache for fast paint, and app metadata in `%APPDATA%\omp-studio\omp-studio`.

## Workspace layout

Repositories are never created inside the app data directory. When a project or group is created without a path, OMP Studio uses `<workspace root>\<slug of name>` and appends `-2`, `-3`, ... if the folder already exists. The workspace root is detected on first run from an existing `~/code`, `~/Projects`, `~/source/repos`, `~/dev` or `~/Developer`, falling back to `~/code`, and can be changed in Settings -> General -> Workspace root. Existing nodes keep their current paths.

## Tree protocol (host tools)

`tree_list`, `tree_create_node`, `tree_create_thread`, `tree_message`, `tree_ask_parent`, `tree_report`, `tree_reply`, `tree_wait`, `tree_cancel`, `tree_git`, `tree_memory_write`, `tree_memory_read`, `tree_set_title`, `tree_update_node`, `tree_move_node`, `tree_delete_node`, `tree_create_environment`, `tree_update_environment`, `tree_assign_environment`, `tree_list_environments`, `tree_test_environment`.

A parent prompt says: state objective, constraints and definition of done; spawn a thread for independent work; create projects, environments and tree structure yourself; report upward at milestones and before finishing; ask blocking questions instead of guessing. A child prompt says: work only in your assignment, report evidence, never merge/push without permission. Tree-changing tools are limited to the caller's subtree; only root can restructure across branches, and deletes require explicit confirmation.

## Known scope and choices

- Environments are local only (env vars, secrets, setup scripts, services via commands). Docker/WSL/remote are intentionally deferred.
- Model scores come from the public Artificial Analysis leaderboard; the app fetches it daily and labels the source. No API key is required.
- The tree is logically unlimited, but concurrent OMP sessions are capped in Settings (default 8) and idle sessions are parked.
- Tool approval defaults to YOLO because the app is built for unattended orchestration. Change it per node from the chat toolbar, or set the app-wide default and apply it to all nodes in Settings -> General. Interactive questions from OMP are still surfaced; only permission prompts are auto-approved.
- Uncaught main-process errors are appended to `%APPDATA%\omp-studio\omp-studio\errors.log`; renderer errors show an in-app banner with the message and a reload action.
- Plan mode is disabled by policy. Goal mode, advisor, history/fork, artifacts, terminal, diffs and live sharing are exposed.
- Live sharing is read-only. Steering guests is not implemented.
- Provider login is driven through OMP's local CLI auth flow. OpenCode Go keys are validated before saving; other API-key providers rely on OMP's login behavior.

## Attribution

- OMP / oh-my-pi: MIT, https://github.com/can1357/oh-my-pi
- Artificial Analysis data: https://artificialanalysis.ai
