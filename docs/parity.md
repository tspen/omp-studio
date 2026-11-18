# Pi parity status

Date: 2026-11-18

Perch runs the bundled Pi coding agent. This is the current feature-parity record against the old OMP/oh-my-pi engine. It is intentionally explicit about what is done and what is not.

## Done

| Area | Status |
| --- | --- |
| Engine process | Pi `1.5.2` in `--mode rpc`, one process per active thread |
| Chat streaming | text/thinking deltas, tool cards, usage, stop reasons |
| Tools | Pi `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| Host tools | `tree_*`, browser, sites, dev servers, workspace, mobile, computer use via the local authenticated bridge |
| Approvals | Pi `tool_call` hook -> RPC extension UI -> Perch approval sheet; per-tool allow/deny/prompt policy |
| Sessions | Pi session JSONL, resume, fork/clone, compaction |
| Models | Pi catalog (1,600+ models), custom `models.json`, Pi `auth.json` |
| Provider setup | API keys write Pi `auth.json`; OAuth opens the Pi CLI in a terminal |
| Settings | Pi `settings.json` edited through the existing settings UI |
| Skills/MCP | Pi `pi-agent/skills` and `pi-agent/mcp.json` |
| Goal state | App-side create/pause/resume/drop; initial goal prompt is sent |
| Parallel tasks | `task` host tool fans out Perch worker threads and returns structured results |
| Rebrand | Perch window, tray, PWA, Android/iOS IDs, installer, repository, data dir |
| Data | `%APPDATA%\Perch`; 19 existing threads verified after migration |
| Remote | same-Wi-Fi QR, relay, pair-by-link, moves, PWA |
| Packaging | `dist/Perch-0.1.0-x64.exe`; packaged Pi session verified with a mock provider |

## Missing or partial

| Gap | Impact | Notes |
| --- | --- | --- |
| LSP / DAP | No `lsp` or `debug` tool for agents | Pi has no built-in LSP/DAP. Needs a language-server bridge. |
| Python / AST / notebook | No persistent Python kernel, `ast_grep`, `ast_edit`, `notebook` | Pi built-ins only. |
| Web search | No built-in `web_search` | Deliberately not added; use a chosen extension/provider. |
| Native subagent panel | OMP's in-process `task` frames are gone | `task` now creates normal Perch worker threads; the tree is the subagent UI. |
| Goal auto-continuation | Goal state exists, but a turn does not automatically continue forever | Needs a bounded continuation loop and completion detection. |
| Provider credentials | OMP credentials are not imported | Reconnect a provider once in Settings. |
| OMP-specific tooling | Hashes/hashline edits, summarized reads, Rust tool core | Not ported. |
| Pi Durable | Spike only, not default | See [`pi-durable.md`](pi-durable.md). |

## Verification

```text
npm run typecheck                      pass
npm run build                          pass
node scripts/pi-engine-selftest.mjs    "PERCH PI OK", 3 messages
node scripts/pi-durable-selftest.mjs   commit + reopen "PERCH DURABLE OK"
packaged Perch.exe                     Pi 1.5.2, completed Pi session
```
