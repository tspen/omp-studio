# Perch

A Windows cockpit for the [Pi coding agent](https://pi.dev), built around a **tree of orchestrators**. The main chat is an orchestrator; it delegates down to groups, projects and worker threads, and every child sends typed messages back up.

Perch is the cockpit. Pi is the engine. There is no separate agent runtime, no hosted service in the path.

## What is in the box

- **Tree orchestrators**: Root -> Groups -> Projects -> Worker threads. Each level has its own Pi session, context, model, environment and memory.
- **Messages up and down**: `tree_*` host tools let orchestrators spawn nodes/threads, send tasks, ask blocking questions, report results, escalate blockers, wait, cancel and inspect git. Every envelope is durable and visible in the message bus.
- **Parallel tasks**: the `task` host tool fans out up to eight worker threads and returns structured results, so Pi agents get parallel task delegation without in-process subagents.
- **Pi under the hood**: Perch launches the bundled `@earendil-works/pi-coding-agent` in `--mode rpc`, uses Pi sessions, tools, skills, provider auth and compaction. It does not reimplement the agent loop.
- **Host tool bridge**: Perch's tree, browser, sites, dev-server, workspace, LSP and mobile tools are registered as Pi tools through a local authenticated extension. TypeScript/JavaScript/JSON diagnostics, definitions, references, hover and symbols are available without a separate agent engine.
- **Explicit model selection**: Per-thread model and thinking level, plus role defaults for root/group/project/worker/naming/memory.
- **Git-aware threads**: Project repositories, worker branches and worktrees, status, diffs, commit, merge and PR actions. Worktrees live outside the repository so unmerged work is not silently destroyed.
- **Memory**: Per-node durable memory, visible and editable. Orchestrators write through `tree_memory_write`; completed thread outcomes are auto-captured as low-importance entries.
- **Notifications**: Windows toasts, tray badge, in-app inbox, per-node mute, plus optional quiet interface chimes.
- **Permissions where you work**: tool approval is chosen in the chat toolbar (YOLO, auto-approve writes, ask always) and enforced by the Pi host extension.
- **Interrupted work resumes**: if the app closes mid-turn, affected threads load as interrupted with a Continue banner. Continue on a worker resumes that worker from its session. Continue on an orchestrator first clears finished banners, then resumes its interrupted child threads across the subtree.
- **Context management**: Pi auto-compacts history by default when the window fills. The app applies the auto-compact setting to live sessions, shows a compacting indicator and offers a manual **Compact now** action.
- **Thread history**: fork from an entry or rewind the leaf; live read-only share over a local token URL. Worker titles refresh using the cheap naming model.
- **In-app browser**: embedded panel with history, back/forward, element picker, console/network drawer, visual screenshot diffing and a pop-out window. Agents drive it with `app_browser_*` tools.
- **Sites**: publish any static folder from a project to a local URL with versioned copies, then deploy to Cloudflare Pages or GitHub Pages.
- **Persistent terminal and preview**: real PTY shells with tabs, profiles, resize and scrollback. Localhost URLs become preview chips and auto-open in the browser.
- **Context insertion**: `@file` and `@symbol` pickers plus full-text search, drag/drop and paste of text files and images.
- **Diff review**: reviewable diffs with per-line comments, per-hunk approve/reject and **Ask agent to fix comments**.
- **PR and CI**: GitHub CLI-driven checks, logs, re-run and **Fix failures**.
- **Automations**: scheduled prompts that spawn a fresh worker thread under a project.
- **Connectors**: encrypted tokens for GitHub, Cloudflare, Slack, Linear and Figma, MCP add/remove/import, and skill create/edit/delete.
- **Sandbox and audit**: command denylist enforced in app terminals and dev servers, path/network policy injected into agent guidance, and a JSONL audit trail.
- **Budgets**: app-level and per-node USD budgets with warn-only or pause-new-work enforcement.
- **File checkpoints**: a shadow git commit snapshots the checkout before each prompt. Restore code only, or code plus conversation, from Thread history.
- **Engine parity**: Pi Durable is an experimental opt-in harness, not the default. See [`docs/parity.md`](docs/parity.md) and [`docs/pi-durable.md`](docs/pi-durable.md).
- **Remote and mobile**: same-Wi-Fi QR pairing, an installable PWA, an encrypted self-hosted relay for away-from-home use, and session moves between machines.

## Requirements

Windows 10/11 x64, Node.js 22+ (built with Node 24), and git. Pi is installed as an npm dependency; no separate engine download is required.

## Run it

```bash
npm install
npm run dev
```

On first run Perch opens a setup wizard:

1. **Connect a provider**. Pick a Pi provider and paste an API key, or use the OAuth/device flow in the terminal window Perch opens.
2. **Pick models**. Root, worker and naming defaults are selected from the connected provider, with cost and quality hints.
3. **Ready**. Notifications, auto-naming and an optional first project.

Provider credentials are stored in the Perch data directory under `pi-agent/auth.json`; they are not sent to Perch.

## Build a Windows installer

```bash
npm run package
```

The NSIS installer is written to `dist/`. The Pi runtime is bundled from `node_modules/@earendil-works/pi-coding-agent` and unpacked from the asar archive.

## Remote, mobile and cloud

**Same Wi-Fi:** enable **Settings -> Remote** and scan the QR on your phone. No Tailscale, no firewall changes.

**Anywhere:** run the relay on a VPS you own and paste its HTTPS address in **Settings -> Remote -> More options -> Use away from home**:

```bash
docker run -d --restart unless-stopped --name perch-relay -p 43150:43150 ghcr.io/tspen/perch-relay:latest
```

Scan the relay QR once. The runner dials out; the relay only forwards AES-256-GCM frames. No inbound runner port, no managed relay.

- Phone app: installable PWA, or build the Capacitor Android/iOS projects in `android/` and `ios/`.
- Other machines: run the runner image and paste its pairing link under **More options**.
- Sessions move as portable bundles (workspace + Pi session + chat) at turn boundaries. Repeats to the same target are warm: only changed files plus the session are sent.

## Privacy

Perch runs Pi locally. Pi's install/update telemetry is disabled (`PI_TELEMETRY=0`), startup network calls are disabled (`PI_OFFLINE=1`), and Perch does not install keyless third-party search providers. Prompts go only to the model provider you configure. Tool and extension packages can execute code; install only sources you trust.

## Architecture

```
Renderer (React) ---- IPC ---- Main (Electron)
                                  |- Orchestrator ---- one Pi RPC session per active thread
                                  |- Host tools ------ tree_* / browser / sites / dev server / mobile
                                  |- Pi host bridge - authenticated local HTTP -> Pi extension
                                  |- ModelService ---- Pi catalog + AA daily refresh
                                  |- Git / worktrees / memory / checkpoints / artifacts / audit
                                  |- Remote server --- token HTTP + WebSocket + PWA
                                  |- Relay ----------- outbound AES-256-GCM frames
```

Pi session files are the transcript source of truth. Perch keeps a compact message/envelope log, a normalized transcript cache for fast paint, and app metadata in `%APPDATA%\Perch`. Existing data stays in place.

## Security notes

- The sandbox is a policy layer, not a kernel sandbox: it blocks configured command fragments in app terminals/dev servers, injects path and network rules into agent prompts, and records an audit trail. Pi's own shell still runs under your Windows account.
- Tool approval defaults to YOLO because the app is built for unattended orchestration. Change it per node from the chat toolbar, or set the app-wide default in Settings.
- Worker threads are capped (default 8); idle sessions are parked.

## Credits

- Pi: MIT, https://github.com/earendil-works/pi







