# Pi Durable: spike and integration assessment

Perch v1 uses the **Pi coding agent** (`@earendil-works/pi-coding-agent`) over its RPC mode. Pi Durable is a separate experimental harness package (`@earendil-works/pi-durable`) with its own conversation/task/storage model.

We shipped both packages and verified Pi Durable end to end in a standalone spike.

## What was verified

`node scripts/pi-durable-selftest.mjs`

The spike:

1. opens JSONL storage in a temp directory,
2. creates a root durable conversation with a faux model,
3. submits an input and waits for the durable generation task,
4. commits the assistant entry,
5. closes the harness,
6. reopens the same storage and reads the committed answer back.

Result:

```
{
  "ok": true,
  "answer": {
    "kind": "pi.assistant",
    "model": [{ "role": "assistant", "content": [{ "type": "text", "text": "PERCH DURABLE OK" }] }]
  },
  "reopenedAnswer": "PERCH DURABLE OK"
}
```

That proves durable commit + reopen works on this machine. SQLite storage (`openNodeSqliteStorage`) is also available and is the recommended backend for long-running agents.

## Why it is not the default engine yet

Pi Durable is not a drop-in replacement for the coding-agent RPC session:

- Pi Durable is a **library harness**. The app owns the conversation loop, tools, environment, model registry and storage.
- The coding agent already provides tools, skills, compaction, prompt sections, extension UI and RPC. Rebuilding those on Pi Durable is a second engine, not a config switch.
- Durable tool calls are only safe when the tool declares it can be re-run. Perch's host tools include file writes, git operations, browser actions and deploys; each needs an idempotency policy.
- The experimental API changes between minor releases.

## Integration path

If Perch adds a durable mode, it should be a separate engine behind the existing session interface:

1. One Pi Durable conversation per thread, SQLite under the app data directory.
2. Tools split into:
   - re-runnable reads (`read`, `grep`, `find`, `ls`, `tree_list`),
   - intent-recorded writes (`edit`, `write`, `bash`, `git`),
   - never-auto-retry side effects (`deploy`, `site_deploy`, outbound messages).
3. Compaction and fork map to Pi Durable's `compact()` and `fork()`.
4. The desktop/PWA continue to read the same normalized transcript; the durable store is the engine's source of truth.
5. Crash recovery is tested by killing the process during a model call and while a tool is running.

The current RPC engine already survives app restarts at turn boundaries because Pi persists session JSONL and Perch reconciles the transcript. Pi Durable would add mid-turn crash recovery and replay-safe tools.
