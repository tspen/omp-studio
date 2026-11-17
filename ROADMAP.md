# OMP Studio roadmap

Status of the Windows coding-agent parity list. Items marked **Done** are implemented in this repository; **Partial** means a deliberate scope boundary; **Deferred** means it needs infrastructure outside a local Windows app.

## Workspace and shipping loop

| Area | Status | Where |
| --- | --- | --- |
| Real PTY terminal, tabs, shell profile, scrollback, resize | Done | `src/main/services/pty.ts`, `TerminalPane.tsx`, `TerminalModal` |
| Persistent command runs (legacy quick runner) | Done | `TerminalService`, Terminal → Command runs |
| Dev-server start/stop, URL detection, auto-open preview | Done | `PtyService.startDevServer`, `dev_server_*` host tools |
| Browser preview with console, network, element picker | Done | `BrowserController`, `BrowserPanel` devtools |
| Visual regression screenshots | Done | `BrowserController.compare`, `app_browser_visual_diff` |
| Responsive/mobile viewport presets | Done | Browser panel device selector |
| Pane resizing and browser pop-out | Done | `App.tsx` splitters, `popOutBrowser` |
| `@file`, `@symbol`, full-text context, drag/drop and paste images | Done | `WorkspaceService`, `ContextModal`, composer `attach()` |
| Codebase index, symbol search, codemap | Done (on-demand cache) | `WorkspaceService`, `workspace_search`, `workspace_map` |

## Review and delivery

| Area | Status | Where |
| --- | --- | --- |
| Diff review with per-line comments | Done | `DiffReview` in `Modals.tsx` |
| Hunk approve/reject (reverse patch) | Done | `gitRejectHunk`, `GitService.applyReversePatch` |
| Ask agent to fix review comments | Done | `DiffReview` → thread message |
| PR panel, checks, mergeability, review decision | Done | `PrService`, CI tab |
| Failed CI logs, re-run failed jobs, PR comments, merge | Done | `PrService`, CI tab |
| Fix-failures loop (optional automatic) | Done | CI tab + `autoFixCi` setting |
| Cloudflare Pages direct upload (blake3 manifest) | Done | `DeployService.deployCloudflare` |
| GitHub Pages deploy | Done | `DeployService.deployGithubPages` |
| Local Sites access token / protected share links | Done | `SiteService.setAccess` |
| OAuth apps for Slack/Linear/Figma | Partial — token/webhook credentials are supported; OAuth consent flows need per-provider app registration |
| Custom domains / Cloudflare Access policy authoring | Deferred — configure in Cloudflare; the app deploys and links |

## Orchestration extras

| Area | Status | Where |
| --- | --- | --- |
| Scheduled automations that spawn fresh workers | Done | `Orchestrator.runDueAutomations`, Settings → Automations |
| Results queue | Done | Automations tab, threads under the project |
| Cloudflare MCP one-click registration | Done | Settings → Connectors, `~/.omp/agent/mcp.json` |
| MCP add/remove and import from Claude/Codex | Done | `SettingsService.importAgentConfigs` |
| Skills create/edit/delete | Done | Settings → Tools, `skills:*` IPC |
| Token connectors + tests (GitHub, Cloudflare, Slack, Linear, Figma) | Done | Settings → Connectors, encrypted with `safeStorage` |
| Background idle compaction | Done | `Orchestrator.compactIdleSessions` |
| Usage budgets with warn/pause | Done | `assertBudget`, Settings → Usage / This node |
| Command denylist sandbox + audit trail | Done (policy layer) | `sandbox` settings, `audit.log` |
| Windows computer use (screenshot/click/type/keys) | Done, opt-in | `ComputerService`, `computer_*` host tools |
| PDF and DOCX thread export | Done | `ExportService` |

## Deferred by design

- **Cloud/remote execution, cloud VMs and mobile control** — the app is local-Windows-first. No remote runner, phone dispatch, or hosted environments.
- **iOS/Android simulators** — requires platform SDKs; the browser provides device viewport presets instead.
- **Built-in code editor and side chats** — intentionally excluded from the product.
- **Kernel-level sandbox** — OMP runs under the Windows user account; the app enforces terminal command policy, path/network guidance and auditing, not OS isolation.
- **Semantic code index** — file/symbol/text search is local and fast; embeddings and cross-repository retrieval are not included.
