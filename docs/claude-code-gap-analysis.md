# Claude Code ecosystem deep dive

Date: 2026-11-17

Scope: compare Perch with Claude Code's own 2026 feature surface and the most visible Claude Code ecosystem projects, then list what Perch does not have. Excludes the previously agreed non-goals: built-in code editor, side chats, cloud/remote execution, cloud VMs and mobile control.

Method: read Anthropic's Claude Code docs (features overview, hooks, plugins, agent teams, agent view, subagents, output styles, statusline, commands, checkpoints, code intelligence, workflows) and surveyed the main curated lists plus the leading orchestration, review, usage and remote-control projects.

## Where Perch already matches or leads

- Tree hierarchy root -> groups -> projects -> workers, typed durable envelopes, lateral messages, forced upward reporting, recovery/Continue, worktree isolation.
- Real PTY terminal, dev-server preview, in-app browser with console/network/element picker, visual diff, mobile viewports, tabbed pane host with pop-outs.
- Diff review with line comments and hunk rejection; PR/CI panel, failed logs, re-run, merge, fix-failures.
- Sites publishing (local, Cloudflare Pages, GitHub Pages, custom domains, Access allow-list), Cloudflare MCP, OAuth/token connectors.
- Automations, budgets, sandbox policy + audit, idle compaction, background thread execution, usage/cost view, share/export PDF/DOCX.
- Android emulator control, desktop computer use, skills CRUD, MCP management, codebase symbol/text search.

Most ecosystem tools are thin wrappers over worktrees plus an agent CLI. Perch's tree is a stronger coordination model than most of them. The gaps below are mostly **primitives and product surfaces**, not core orchestration.

## Missing Claude Code primitives

| Gap | What Claude Code has | Perch today | Impact |
| --- | --- | --- | --- |
| Hooks | ~33 lifecycle events (`PreToolUse`, `PostToolUse`, `PermissionRequest`, `SessionStart`, `Stop`, `SubagentStop`, `PreCompact`, `WorktreeCreate`, `TaskCreated`, `TeammateIdle`, etc.) with command/HTTP/MCP/prompt/agent handlers, matchers, exit-code and JSON decisions. | Approvals, audit log and notifications exist, but no user-defined hooks. | High. Deterministic automation, formatters, policy enforcement, team comms, CI gates. |
| Plugins + marketplaces | Bundles skills, agents, hooks, MCP/LSP servers, bin, themes, statusline and settings. `.claude-plugin/plugin.json`, `marketplace.json`, install scopes, updates, `/reload-plugins`, security/context-cost review. | Skills CRUD, MCP add/remove/import. No plugin packaging, install, marketplace or validation. | High. Distribution and reuse; a plugin can replace a folder of manuals. |
| Agent teams | Lead + independent sessions, shared task list with dependencies and file-locked claiming, per-agent mailbox files, direct peer messages, idle notifications, plan approval messages, shutdown requests. | Tree with up/down/lateral envelopes and `tree_message`. No shared task list, no dependency/claiming, no peer idle notifications. | High for swarm-style work; natural extension of the tree. |
| Agent view / background tasks | `claude agents`, `--bg`, `/background`, `/tasks`, `/bashes`, dispatch/peek/reply/attach, background subagents, scheduled loops, session survives terminal. | Threads are async and survive the app; pane shows todo phases. No background shell/subagent task list, detach/peek/attach surface or run summaries. | Medium-high. Users need one place to see all running work. |
| Plan mode + plan review | EnterPlanMode/ExitPlanMode, plan approval gate, Plannotator intercepts ExitPlanMode with inline annotations, deletion requests, plan diffs and structured feedback. | Plan mode is disabled by policy. No visual plan approval or plan diff. | High. Prevents expensive wrong implementations and is a visible product surface. |
| File checkpoints / rewind | Automatic pre-edit file snapshots plus conversation; `/rewind` can restore code, conversation, or both; persists across sessions. | Thread history/fork/rewind at conversation level; Pi checkpoint tool exists but no app UI for code+conversation restore. | Medium-high. Safety net for autonomous edits. |
| Permission rule grammar | `allow` / `ask` / `deny` with `Bash(npm run *)`, `Read(./src/**)`, `mcp__.*`, additionalDirectories, managed policy, sandbox integration. | Per-tool approval plus command denylist and audit. No path/tool wildcard rules or policy layers. | High for safe autonomy. |
| Output styles | Built-in Proactive/Concise/Explanatory/Learning plus custom styles applied to every response; `outputStyle` setting. | No output style concept. | Medium. Terse/long-form/teaching modes are frequent requests. |
| Custom slash commands / skills invocation | `.claude/commands/*.md` and skills as `/<name>`, arguments, allowed-tools, model, bash execution, namespacing. | Skills CRUD and composer context, but no command palette or slash command surface. | Medium. Fast repeatable workflows. |
| Status line + subagent status line | `statusLine` command with JSON stdin, refresh interval, ANSI/OSC links; `subagentStatusLine` rows. | Fixed status bar. | Low-medium. Power-user customization. |
| Custom subagent library | `.claude/agents/*.md` with description/tools/model/permission/skills/memory/hooks; fork/resume; worktree isolation. | Pi subagents are used internally; no library/editor or per-agent permission UI. | Medium. Reusable specialist workers. |
| Code intelligence / LSP | Language-server plugins give diagnostics after edits, definitions, references, implementations, call hierarchy, workspace symbols. | Symbol scan and text search only; no live diagnostics or LSP. | High for large codebases. |
| Cross-session messaging | `ListAgents` + `SendMessage` across sessions on the machine, other machines and cloud; idle notices. | Tree-wide lateral messages and node targeting; no messaging outside the tree/session set. | Medium. Multi-workspace handoffs. |
| Dynamic workflows / `/batch` | Script-driven fan-out of tens to hundreds of subagents; `/batch` decomposes into 5-30 worktree-isolated units; `/workflows` progress. | Manual/LLM-driven spawning; no scripted workflow runtime or batch decomposition. | Medium-high for large migrations/audits. |
| Session artifacts | Publish session output as a private interactive web page that updates as the agent works; artifact comments trigger replies. | Sites publish static folders; share is read-only transcript; exports PDF/DOCX. | Medium. Client-facing reports and live dashboards. |

## Missing ecosystem product surfaces

| Gap | Examples | Why it matters |
| --- | --- | --- |
| Kanban board over agent work | Vibe Kanban, Kanbanbots, Nimbalyst | Plan issues as cards, drag to in-progress, per-card branch/terminal/dev server, inline diff comments, PR. Our tree is hierarchical, not board-shaped. |
| Plan/spec review surface | Plannotator, Claude Code plan mode | Annotate plans before implementation; plan diffs across revisions. We only review code after the fact. |
| Org chart + goals + heartbeats + ticket system | Paperclip, Multica, Crewmark | Roles/reporting lines, mission->project->agent->task lineage, scheduled heartbeats, assignment/mentions, per-agent budgets and approvals. Our tree has hierarchy and budgets, but no goal lineage, ticket board or heartbeat policy. |
| Job-board manager agent | Agent 007 | A manager agent posts jobs, workers open PRs from worktrees, manager reviews/merges. We have orchestrators but no visual job board or automated PR merge review. |
| Hook-based inter-agent comms dashboard | HCOM, claude-intercom, OpenRig | @mention targeting, live dashboard, persistent team snapshots, cross-machine message relay. |
| Model router / fallback gateway | claude-code-router, LiteLLM | Route by complexity/background task, local models, failover, spend caps. We select models by role, not per request. |
| Usage analytics and live quota alerts | ccusage, codeburn, Claude-Code-Usage-Monitor | Historical per-day/project/model reports, 5-hour block live view, threshold alerts/blocking. We show current totals and budgets. |
| Template and skills catalogs | claude-code-templates, SuperClaude, skills.sh/superpowers, plugin marketplaces | One-command scaffolds for CLAUDE.md/agents/commands/hooks/MCP; thousands of skills/plugins with discovery and versioning. We only create/import skills manually. |
| MCP gateway / tool compression | airis-mcp-gateway, gateway patterns | Aggregate dozens of MCP servers behind meta-tools to cut context. We mount servers directly. |
| Semantic memory / shared brain | claude-context, claude-brain, tree-ring-memory, Artel | Embedding search, cross-machine memory sync, team-shared memory. We have per-node memory and lexical search. |
| Security review automation | claude-code-security-review, security-guidance plugin, `/security-review` | Diff-aware vulnerability findings inline in PRs and fix loop. We review general correctness, not security. |
| Container sandbox per agent | container-use (Dagger), CloudCLI Docker sandbox | Stronger isolation than our policy layer, plus a branch/container per agent. |
| Plugin security and context-cost review | Claude Code plugin details, context-cost estimates, hooks/mod trust | Installing third-party hooks/mods is code execution; marketplaces need review, signing, pinning and cost estimates. |
| IDE/editor integrations | VS Code, JetBrains, Neovim, Zed extensions | Meet developers where they edit. User excluded an in-app editor, not external integrations. |
| Team collaboration | Shared sites/boards, comments, roles, multi-user orgs | Perch is single-user. Paperclip/Multica/Vibe Kanban add team review and shared workspaces. |
| Remote/mobile control | Claude Remote Control, Happy, T3 Code, Omnara | Excluded by user decision; listed for completeness. |

## Highest-value additions for Perch

1. **Lifecycle hooks** with a UI and audit integration. Start with `PreToolUse`, `PostToolUse`, `SessionStart`, `Stop`, `PreCompact`, `TaskCompleted`, plus command hooks. This unlocks formatters, policy gates, notifications, auto-review and team comms without changing the core.
2. **Shared task board + peer mailbox**. Add tasks with status/dependencies/claiming to the tree, expose `task_claim`/`task_complete`, idle notifications and peer messages. This closes most of the Agent Teams gap while preserving the tree.
3. **Plan review mode**. Re-enable plan mode for orchestrators, add a plan pane with annotations, approve/send-feedback, and plan diffs. This is the largest visible UX gap and fits our pane/diff/comment infrastructure.
4. **Plugin system + marketplace**. Package skills/agents/hooks/MCP, install from Git, verify/pin, show context cost and hooks before install. Reuse existing skill/MCP directories.
5. **Permission rule engine**. Path/tool wildcard allow/ask/deny, additional directories, managed policy, and an explain view. Combine with the existing sandbox denylist and audit.
6. **Kanban/goal board**. A board view over the same nodes/threads with goals, priorities, assignments and heartbeat automation; not a separate storage model.
7. **LSP diagnostics**. Spawn common language servers, show new diagnostics after edits, expose definitions/references to agents. Complements symbol search.
8. **File-level checkpoints**. Snapshot before edits, restore code/conversation separately, show a rewind timeline.
9. **Usage analytics**. Historical daily/project/model reports, 5-hour windows, threshold alerts, export. Add ccusage-style reports from local Pi sessions.
10. **Security review**. A `/security-review` flow plus PR inline comments, severity, and "fix findings" loop.

## Nice-to-have next

- Custom output styles and slash commands.
- Custom status line and subagent status rows.
- Scripted dynamic workflows and `/batch` decomposition.
- MCP gateway/meta-tools to reduce context.
- Semantic/embedding memory.
- Template/skills registry browser.
- Container-per-agent sandbox.
- External IDE integrations.
- Cross-session messaging beyond the tree.

## Status updates after review (2026-11-17)

Implemented since this analysis:

- **File checkpoints**: automatic shadow-git snapshot before each prompt, restore code or code+conversation, 50 per thread.
- **Permission rules**: YOLO remains the default; optional `allow` / `ask` / `deny` rules with tool+argument globs are evaluated before auto-approval and audited.
- **Plugin installer**: preview/install from Git or local folders; installs skills, commands-as-skills and MCP servers, counts agents/hooks, never executes hooks, and uninstalls cleanly.

Deliberately skipped after user review: plan mode, lifecycle hooks, and a separate shared task board/mailbox.

## Sources

- Claude Code features overview: https://code.claude.com/docs/en/features-overview
- Plugins overview: https://code.claude.com/docs/en/plugins
- Plugin marketplaces: https://code.claude.com/docs/en/discover-plugins
- Hooks reference: https://code.claude.com/docs/en/hooks
- Agent teams: https://code.claude.com/docs/en/agent-teams
- Agent view: https://code.claude.com/docs/en/agent-view
- Subagents: https://code.claude.com/docs/en/sub-agents
- Output styles: https://code.claude.com/docs/en/output-styles
- Status line: https://code.claude.com/docs/en/statusline
- Commands: https://code.claude.com/docs/en/commands
- Checkpointing: https://code.claude.com/docs/en/checkpointing
- Code intelligence: https://code.claude.com/docs/en/plugins/code-intelligence
- Dynamic workflows: https://code.claude.com/docs/en/workflows
- Cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- awesome-claude-code: https://github.com/hesreallyhim/awesome-claude-code
- awesome-claude-code-toolkit: https://github.com/rohitg00/awesome-claude-code-toolkit
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban
- Plannotator: https://plannotator.ai/ and https://github.com/backnotprop/plannotator
- Paperclip: https://github.com/paperclipai/paperclip
- Claude Squad: https://github.com/smtg-ai/claude-squad
- claude-code-router: https://github.com/musistudio/claude-code-router
- ccusage: https://github.com/ryoppippi/ccusage
- claude-code-security-review: https://github.com/anthropics/claude-code-security-review
- Happy: https://github.com/slopus/happy
- Conductor / Claude Squad / Vibe Kanban comparison: https://gitta.io/guides/parallel-coding-agent-tools
- Orchestration tools comparison: https://crewmark.ai/blog/claude-code-orchestration-tools
