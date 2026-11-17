# OMP Studio roadmap

Every item from the Windows coding-agent parity checklist is either implemented or explicitly excluded by a user decision. Android device control is local through adb; iOS simulators and cloud/remote execution are out of scope for a Windows desktop app.

## Workspace and shipping loop

| Area | Status | Where |
| --- | --- | --- |
| Real PTY terminal, tabs, shell profile, scrollback, resize | Done | `src/main/services/pty.ts`, `TerminalPane.tsx` |
| Persistent command runs (quick runner) | Done | `TerminalService`, Terminal -> Command runs |
| Dev-server start/stop, URL detection, auto-open preview | Done | `PtyService.startDevServer`, `dev_server_*` |
| Browser preview with console, network, element picker | Done | `BrowserController`, `BrowserPanel` |
| Visual regression screenshots | Done | `BrowserController.compare`, `app_browser_visual_diff` |
| Responsive viewport presets | Done | Browser panel device selector |
| Pane host with tabs and pop-outs (terminal, diff, tasks) | Done | `PaneHost.tsx`, `pane:popout` |
| Pane resizing, bottom pane splitter and browser pop-out | Done | `App.tsx` splitters, `popOutBrowser` |
| `@file`, `@symbol`, full-text context, drag/drop and paste | Done | `WorkspaceService`, `ContextModal`, composer attach |
| Codebase index, symbol search, codemap | Done (on-demand cache) | `WorkspaceService`, `workspace_search`, `workspace_map` |

## Review and delivery

| Area | Status | Where |
| --- | --- | --- |
| Diff review with per-line comments | Done | `DiffReview` in `Modals.tsx` |
| Hunk approve/reject (reverse patch) | Done | `gitRejectHunk`, `GitService.applyReversePatch` |
| Ask agent to fix review comments | Done | `DiffReview` -> thread message |
| PR panel, checks, mergeability, review decision | Done | `PrService`, CI tab |
| Failed CI logs, re-run, PR comments, merge | Done | `PrService`, CI tab |
| Fix-failures loop, optional automatic | Done | CI tab + `autoFixCi` |
| Cloudflare Pages direct upload (blake3 manifest) | Done | `DeployService.deployCloudflare` |
| GitHub Pages deploy | Done | `DeployService.deployGithubPages` |
| Cloudflare Pages custom domains | Done | `DeployService.addCloudflareDomain` |
| Cloudflare Access app + allow-list policy | Done | `DeployService.configureCloudflareAccess` |
| Local Sites access token / protected links | Done | `SiteService.setAccess` |
| OAuth 2.0 connectors (GitHub, Slack, Linear, Figma) | Done - supply your own OAuth app credentials; loopback callback `127.0.0.1:43110` | `OAuthService` |
| Cloudflare MCP | Done | one-click config at `~/.omp/agent/mcp.json` |
| Cloudflare Access identity provider | External prerequisite in Cloudflare Zero Trust; app creates the app and allow policy | Cloudflare dashboard |

## Orchestration extras

| Area | Status | Where |
| --- | --- | --- |
| Scheduled automations that spawn fresh workers | Done | `Orchestrator.runDueAutomations` |
| Automation results queue | Done | Automations tab + threads |
| MCP add/remove/import from Claude and Codex | Done | `SettingsService.importAgentConfigs` |
| Skills create/edit/delete | Done | Settings -> Tools, `skills:*` |
| Encrypted token connectors + tests | Done | `safeStorage`, Settings -> Connectors |
| Background idle compaction | Done | `Orchestrator.compactIdleSessions` |
| Usage budgets with warn/pause | Done | `assertBudget`, Usage/This node |
| Command denylist sandbox + audit trail | Done (policy layer) | sandbox settings, `audit.log` |
| Windows computer use (screenshot/click/type/keys) | Done, opt-in | `ComputerService`, `computer_*` |
| Android emulators/devices (list, start, screenshot, tap, type, keys) | Done via adb | `MobileService`, Devices panel, `mobile_*` |
| PDF and DOCX thread export | Done | `ExportService` |
| Import from Claude/Codex configs | Done | Settings -> Connectors |

## Ecosystem gap analysis

A 2026-11-17 deep dive comparing OMP Studio with Claude Code and the wider ecosystem is in [`docs/claude-code-gap-analysis.md`](docs/claude-code-gap-analysis.md).

Implemented from the analysis:

- **Plugin installer**: preview and install Claude Code-style plugin folders from Git or disk; skills, commands-as-skills and MCP servers are installed, hooks are never executed, and removal cleans up.
- **File checkpoints**: automatic pre-prompt shadow-git snapshots with restore code / code+chat from Thread history.
- **Permission rules**: YOLO stays the default; optional allow/ask/deny patterns (tool and argument globs) act as exceptions and are audited.

Deliberately not pursued after user review: plan mode, lifecycle hooks, and a separate shared task board/mailbox (the tree already covers coordination for this workflow).

## Remote execution design

A full architecture for cloud/remote/mobile execution is in [`docs/remote-execution-architecture.md`](docs/remote-execution-architecture.md): one runner, target registry, portable session bundles, user-owned network access, Docker/VPS or self-hosted E2B Embed targets, self-cleaning resources, performance gates, mobile PWA and phased rollout. Phase 1 implementation details are in [`docs/remote-phase1-spec.md`](docs/remote-phase1-spec.md).

## Explicitly excluded

The user confirmed these exclusions on 2026-11-17:

- **iOS simulators** - require macOS and Xcode, so they cannot run in this Windows desktop app. Android simulators and devices are supported through adb, and the browser provides iPhone/Pixel/iPad viewport presets.
- **Cloud/remote execution, cloud VMs and mobile control** - the app is local-Windows-first. No hosted runner, phone dispatch, remote supervision, or cloud environments. Cloudflare deployment and MCP are supported because they do not run agent sessions remotely.
- **Built-in code editor and side chats** - intentionally excluded product decisions.
- **Kernel-level sandbox** - OMP runs under the Windows user account. The app enforces terminal command policy, path/network guidance in prompts, and an audit trail; it is not OS virtualization.
- **Semantic/embedding code index** - local file, symbol and text search are included; embeddings and cross-repository retrieval are not.
