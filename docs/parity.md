# Pi parity status

Date: 2026-11-18

Perch runs the bundled Pi coding agent. This is the current feature-parity record against the previous engine. It is intentionally explicit about what is done and what is not.

## Done

| Area | Status |
| --- | --- |
| Engine process | Pi `1.5.2` in `--mode rpc`, one process per active thread |
| Chat streaming | text/thinking deltas, tool cards, usage, stop reasons |
| Tools | Pi `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| Host tools | `tree_*`, browser, sites, dev servers, workspace, LSP, AST, Python, notebook, web search, mobile and computer use via the local authenticated bridge |
| Approvals | Pi `tool_call` hook -> RPC extension UI -> Perch approval sheet; per-tool allow/deny/prompt policy |
| Sessions | Pi session JSONL, resume, fork/clone, compaction |
| Models | Pi catalog (1,600+ models), custom `models.json`, Pi `auth.json` |
| Provider setup | API keys write Pi `auth.json`; OAuth opens the Pi CLI in a terminal |
| Settings | Pi `settings.json` edited through the existing settings UI |
| Skills/MCP | Pi `pi-agent/skills` and `pi-agent/mcp.json` |
| Goal state | App-side create/pause/resume/drop, bounded auto-continuation (50 turns), token budget and `GOAL COMPLETE` detection |
| Parallel tasks | `task` host tool fans out Perch worker threads and returns structured results |
| Subagent panel | `task` workers appear in a dedicated **Subagents** section in the right rail, with status, model, branch and their full worker transcript |
| Provider migration | `scripts/import-auth-db.mjs` imports API keys and OAuth credentials from a legacy SQLite auth store into Pi `auth.json` (Node 24+) |
| Tool core | Pi-native `read`, `edit`, `bash`, `grep`, `find` and `ls` replace the previous hashline/summarized-read/Rust implementation; user-visible tool cards and approvals are unchanged |
| Python | Persistent Python 3 kernel per thread, reset, timeout; `PERCH_PYTHON` or PATH discovery |
| Notebook | Read, edit and execute `.ipynb` cells through the persistent Python kernel |
| AST editing | Structural `ast_grep`/`ast_edit` for JavaScript, TypeScript, TSX, HTML and CSS via `@ast-grep/napi`, plus Python expressions, single statements, `$CAPTURE` and variadic argument/body captures via the Python AST bridge |
| Web search | Configurable `web_search` host tool: Brave, Tavily, SearXNG or Exa; disabled until a provider is configured |
| Debugging | `launch`/`debug` DAP host tools for breakpoints, stepping, threads, stack, scopes, variables and evaluate; adapters come from PATH or `PERCH_DAP_<LANGUAGE>` |
| Rebrand | Perch window, tray, PWA, Android/iOS IDs, installer, repository, data dir |
| Brand audit | No legacy engine runtime, path, label, env var, image or ID remains in source, docs, installer or app data |
| Data | `%APPDATA%\Perch`; 19 existing threads verified; historical transcript paths rebranded |
| Remote | same-Wi-Fi QR, relay, pair-by-link, moves, PWA |
| Packaging | `dist/Perch-0.1.0-x64.exe`; packaged Pi session verified with a mock provider |

## Missing or partial

| Gap | Impact | Notes |
| --- | --- | --- |
| External language servers | TypeScript/JavaScript/JSON LSP is bundled. Python, Rust, Go, C/C++, Java, C#, Ruby and PHP use an installed language server or `PERCH_LSP_*` override. | `lsp` host tool; see `src/main/services/lsp.ts`. |
| AST editing in other languages | `ast_grep`/`ast_edit` cover JavaScript, TypeScript, TSX, HTML, CSS and Python | Go, Rust, Java, C/C++ and other languages use Pi `grep`/`edit`. |

## Decisions

| Item | Decision |
| --- | --- |
| Pi Durable | Spike passed commit + reopen, but it is not the default or an exposed engine mode. API stability, replay-safe host tools, mid-turn crash tests and performance gates are still required. See [`pi-durable.md`](pi-durable.md). |

## Verification

```text
npm run typecheck                      pass
npm run build                          pass
node scripts/pi-engine-selftest.mjs    "PERCH PI OK", 3 messages
node scripts/pi-durable-selftest.mjs   commit + reopen "PERCH DURABLE OK"
python + notebook host tools           "PYTHON APP DONE", "NOTEBOOK APP DONE"
ast_grep + ast_edit                    "AST APP DONE", "AST EDIT APP DONE"
web_search (SearXNG mock)              "WEB SEARCH APP DONE"
LSP TypeScript + external server       symbols from bundled TS and a fake Python server
DAP launch/control (fake adapter)      threads, stack, scopes, variables, evaluate; packaged "DEBUG APP DONE"
legacy auth import                     3 providers ready: openrouter, opencode-go, openai-codex
subagent rail                          "Subagents" section with a task worker and full transcript
Pi read + edit tools                   "READ APP DONE", "EDIT APP DONE"; file updated to "hello world"
Python AST grep + edit                 packaged "PY AST APP DONE", "PY AST EDIT APP DONE"; print($A) -> logger.info(...), greet($$$ARGS) captured arguments
packaged Perch.exe                     Pi 1.5.2; subagent rail, 443 authenticated provider models, Pi read/edit, Python AST, Python/notebook/LSP/web search/DAP
```



