# Pi parity status

Date: 2026-11-18

Perch runs the bundled Pi coding agent. This is the current feature-parity record against the previous engine. It is intentionally explicit about what is done and what is not.

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
| Goal state | App-side create/pause/resume/drop, bounded auto-continuation (50 turns), token budget and `GOAL COMPLETE` detection |
| Parallel tasks | `task` host tool fans out Perch worker threads and returns structured results |
| Python | Persistent Python 3 kernel per thread, reset, timeout; `PERCH_PYTHON` or PATH discovery |
| Notebook | Read, edit and execute `.ipynb` cells through the persistent Python kernel |
| Rebrand | Perch window, tray, PWA, Android/iOS IDs, installer, repository, data dir |
| Data | `%APPDATA%\Perch`; 19 existing threads verified after migration |
| Remote | same-Wi-Fi QR, relay, pair-by-link, moves, PWA |
| Packaging | `dist/Perch-0.1.0-x64.exe`; packaged Pi session verified with a mock provider |

## Missing or partial

| Gap | Impact | Notes |
| --- | --- | --- |
| LSP / DAP | TypeScript/JavaScript/JSON LSP is bridged through `typescript-language-server`: diagnostics, definition, references, hover, symbols. DAP and other language servers are not wired. | `lsp` host tool; see `src/main/services/lsp.ts`. |
| AST editing | No `ast_grep` or `ast_edit` structural tools | Use language-server references plus Pi `grep`/`edit`; Python/notebook support is implemented. |
| Web search | No built-in `web_search` | Deliberately not added; use a chosen extension/provider. |
| Native subagent panel | The previous in-process `task` frames are gone | `task` now creates normal Perch worker threads; the tree is the subagent UI. |
| Provider credentials | Previous credentials are not imported | Reconnect a provider once in Settings. |
| Previous-engine tooling | Hashes/hashline edits, summarized reads, Rust tool core | Not ported. |
| Pi Durable | Spike only, not default | See [`pi-durable.md`](pi-durable.md). |

## Verification

```text
npm run typecheck                      pass
npm run build                          pass
node scripts/pi-engine-selftest.mjs    "PERCH PI OK", 3 messages
node scripts/pi-durable-selftest.mjs   commit + reopen "PERCH DURABLE OK"
python + notebook host tools           "PYTHON APP DONE", "NOTEBOOK APP DONE"
packaged Perch.exe                     Pi 1.5.2, Python + notebook tools, completed sessions
```



