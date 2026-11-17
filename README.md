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
- **Interrupted work resumes**: if the app closes mid-turn, affected threads load as interrupted with a Continue banner. Continue on a worker resumes that worker from its session. Continue on an orchestrator first clears finished banners, then resumes its interrupted child threads across the subtree. It refuses overlapping work: threads sharing a checkout, branch, worktree or task stay paused under the concurrency cap, and the orchestrator is told to review reports and resolve finished threads rather than implement anything itself.
- **Context management**: OMP auto-compacts history by default when the window fills, including mid-turn. The app applies the auto-compact setting to live sessions, shows a compacting indicator and offers a manual **Compact now** action in the chat header. Thresholds and method order remain OMP config values. **Background idle compaction** also summarizes any session that has been idle for two minutes and sits above the configured context threshold (default 60%), one session at a time, without stopping it.
- **Thread history**: Fork from an entry or rewind the leaf; goal mode; live read-only share over a local token URL. Worker titles refresh every few turns using the cheap naming model, throttled so titles never dominate spend.
- **In-app browser**: embedded panel with history, back/forward, an element picker that inserts `tag`, selector and URL into the composer, a console/network drawer with errors, statuses, durations and failures, visual screenshot diffing, and a pop-out window. Agents can drive it with `app_browser_navigate`, `read`, `click`, `type`, `screenshot`, `app_browser_console`, `app_browser_network` and `app_browser_visual_diff`.
- **Sites**: publish any static folder from a project to a local URL (`http://127.0.0.1:4338/s/<siteId>/`) with versioned copies, then open it in the in-app Browser. Create, republish, copy the share URL or delete from the Sites panel; deploy to **Cloudflare Pages** (direct upload with blake3 content hashes) or **GitHub Pages**. Agents use `site_create`, `site_publish`, `site_list` and `site_deploy`, then verify with the browser tools.
- **Persistent terminal and preview**: real PTY shells (node-pty/ConPTY) with tabs, profiles, resize and scrollback. Localhost URLs printed by a command become clickable preview chips and auto-open in the browser. Agents start and stop dev servers with `dev_server_start`, `dev_server_stop` and `dev_server_list`; the app waits for the URL and verifies it with console/network.
- **Context insertion**: `@file` and `@symbol` pickers plus full-text search in the composer, drag/drop and paste of text files and images, and recent-file ordering. Images are copied into the artifact store so agents can inspect them.
- **Diff review**: read-only diffs become reviewable files with per-line comments, per-hunk approve/reject (reverse patch), and **Ask agent to fix comments**, which sends the reviewed comments back to the owning thread.
- **PR and CI**: a CI tab driven by the GitHub CLI shows the PR, mergeability, review state and status checks; failed logs, re-run failed jobs, PR comments, merge, and **Fix failures**, which sends the failing checks and logs to the agent.
- **Automations**: scheduled prompts that always spawn a fresh worker thread under a project, with enable/disable, run-now, results queue and last-run status.
- **Connectors**: encrypted tokens for GitHub, Cloudflare, Slack, Linear and Figma, one-click **Cloudflare MCP** (`https://mcp.cloudflare.com/mcp`), MCP add/remove/import from Claude and Codex configs, and skill create/edit/delete.
- **Sandbox and audit**: command denylist enforced in app terminals and dev servers, path/network policy injected into agent guidance, Windows computer-use toggle, and a JSONL audit trail of prompts, host tools, approvals and deploys.
- **Budgets**: app-level and per-node USD budgets with warn-only or pause-new-work enforcement.
- **Codebase intelligence**: workspace file index, symbol codemap, content search, and recent-file ranking exposed to both the UI and `workspace_search`/`workspace_map`.
- **Workspace panes**: draggable splitters for sidebar, chat, browser and rail, browser pop-out, and a maximized terminal/browser workflow without an in-app code editor.
- **Exports and extras**: thread export to PDF or DOCX, desktop screenshots and clicks/typing for Windows apps (opt-in), visual regression diffs from the browser, Android emulator/device control through adb (screenshot, tap, type, keys), and mobile viewport presets for responsive checks.
- **Tools and settings**: OMP tool matrix with per-tool approval, full dynamic OMP config browser, skills/MCP inventory, engine manager.

## Connectors and OAuth

Settings → Connectors stores GitHub, Cloudflare, Slack, Linear and Figma credentials. Tokens and client secrets are encrypted with Electron `safeStorage` (Windows DPAPI). For OAuth, create an OAuth app with the provider and register `http://127.0.0.1:43110/oauth/callback` as the callback URL, then paste the client ID and secret and press **Connect with OAuth**. The app opens the system browser, receives the loopback callback, exchanges the code and stores the token. Cloudflare's full API is available through the one-click **Cloudflare MCP** (`https://mcp.cloudflare.com/mcp`), which uses OAuth on first tool use in OMP.

## Sites deployment

Sites publish locally first. **Deploy to Cloudflare Pages** performs a direct upload: blake3 content hashes (`content + extension`, wrangler-compatible), an upload token, asset batches, then a deployment manifest. **Deploy to GitHub Pages** pushes the published snapshot to `gh-pages` and enables Pages. Cloudflare custom domains are added from the site card; DNS for zones outside Cloudflare still has to be pointed at the Pages project.

## Android devices

The Devices panel uses `adb` and the Android emulator. List devices and AVDs, start an emulator, take screenshots, click the screenshot to tap, type text and send key events. Agents get the same capability through `mobile_devices`, `mobile_start_avd`, `mobile_screenshot`, `mobile_tap`, `mobile_text` and `mobile_key`. iOS simulators require macOS and are not supported on Windows.

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

`tree_list`, `tree_create_node`, `tree_create_thread`, `tree_message`, `tree_ask_parent`, `tree_report`, `tree_reply`, `tree_wait`, `tree_cancel`, `tree_git`, `tree_memory_write`, `tree_memory_read`, `tree_set_title`, `tree_update_node`, `tree_move_node`, `tree_delete_node`, `tree_create_environment`, `tree_update_environment`, `tree_assign_environment`, `tree_list_environments`, `tree_test_environment`, `workspace_search`, `workspace_map`, `site_list`, `site_create`, `site_publish`, `site_deploy`, `dev_server_start`, `dev_server_stop`, `dev_server_list`, `app_browser_*` and `computer_*`.

A parent prompt says: state objective, constraints and definition of done; spawn a thread for independent work; create projects, environments and tree structure yourself; report upward at milestones and before finishing; ask blocking questions instead of guessing. Root and group prompts are dispatcher-only: they never implement or inspect repositories. Project prompts delegate implementation to workers and limit themselves to planning, review and merging. A child prompt says: work only in your assignment, report evidence, never merge/push without permission. Tree-changing tools are limited to the caller's subtree; only root can restructure across branches, and deletes require explicit confirmation. Child `progress` messages are queued for the parent's next turn instead of waking it; only results, questions and escalations interrupt.

## Known scope and choices

- Environments are local only (env vars, secrets, setup scripts, services via commands). Docker/WSL/remote are intentionally deferred.
- Sites are served locally on `127.0.0.1:4338` from `%APPDATA%\omp-studio\omp-studio\sites`. Each publish snapshots the folder (skipping `node_modules` and `.git`), keeps the last 12 versions and serves localhost only. Cloudflare Pages and GitHub Pages deploys are supported; custom domains and Cloudflare Access are configured in Cloudflare itself.
- The sandbox is a policy layer, not a kernel sandbox: it blocks configured command fragments in app terminals/dev servers, injects path and network rules into agent prompts, and records an audit trail. OMP's own shell still runs under your Windows account.
- Windows computer use and desktop input are opt-in and disabled by default. iOS/Android simulators, mobile control and cloud VMs are not implemented.
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

## License

MIT. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
