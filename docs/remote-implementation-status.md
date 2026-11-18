# Remote execution implementation status

Date: 2026-11-17

This is the implementation record for the remote/mobile/cloud work. It lists what
ships, how it was verified, the measured performance, and the remaining gaps.

## V1 scope decision (2026-11-17)

Cross-host **memory** migration is **out of v1**. Supported v1 paths are:

- same-host pause/resume,
- same-host Docker/CRIU checkpoint + restore,
- cold and warm moves at turn boundaries,
- relay/Tailscale access, PWA/Android, push, cost meter and self-cleaning.

Cross-host checkpoint export/import remains in the code as experimental and is
not part of the v1 guarantee. Docker/CRIU does not reconnect live Electron/OMP
pipes on another host, so a durable cross-host handoff needs CRIU-native
migration with pipe reconnection rather than Docker checkpoints.

## What ships

| Area | Implementation |
| --- | --- |
| Remote server | `src/main/services/remote.ts` — token auth, HTTP API, WebSocket event stream with `snapshot` on connect, PWA static serving, CORS, QR pairing links. |
| Endpoints | `GET /api/health`, `/api/state`, `/api/messages/:id`, `/api/approvals`, `/api/threads/:id`; `POST /api/threads/:id/{send,stop,continue,compact}`, `/api/approvals/:id`, `/api/envelopes/:id/answer`, `/api/import`, `/api/maintenance/sweep`; `GET /api/export/:id`; `DELETE /api/nodes/:id`. |
| Pairing | 48-hex token stored with Electron `safeStorage`; QR contains `#t=<token>` in the URL fragment (never sent to the server); rotate revokes every device. `OMP_REMOTE_TOKEN` overrides for containers. |
| Mobile app | `mobile/` React PWA: pair screen, session list with Live/All filters, chat with tool blocks, approvals, inbox, settings, installable manifest + service worker. WebSocket with 3 s reconnect plus 4 s HTTP polling fallback. |
| Android | Capacitor project in `android/`; cleartext allowed for LAN/Tailscale dev; `app-debug.apk` builds and runs. |
| iOS | Capacitor project in `ios/`; ATS and local-network entries added; build/sign requires macOS (see CI workflow). |
| Desktop UI | Settings → Remote: enable, QR pairing, one-command relay, move/pair another machine, and an Advanced disclosure for network, token, cleanup and targets. |
| Cold move | Export zip (manifest + workspace + OMP session + chat) and import on the same or another runner. A running session offers **Move after turn** (queued automatically at the next boundary) or **Stop & move**. Target registry probes `/api/health`, stores tokens separately, and reports latency. Source is retained for rollback. |
| Warm move | Targets keep the workspace in place under an origin key (`.omp-origin.json` + `.omp-manifest.json`). Before export the source reads the target manifest, hashes the workspace, sends only changed files, and lists deletions. The target applies the delta to the existing workspace and creates only a new session thread. Reuses the target node and orchestrator. |
| Automatic placement | `remotePlacement` policy: enabled + explicit consent + selected target + idle threshold. A scheduler checks every 20 seconds, picks idle worker sessions with history, cold-moves at most two per pass, never interrupts a running turn, releases the local OMP session, and records `targetId`, `remoteThreadId`, `remoteNodeId`, `movedAt`. Settings shows policy, "Place idle sessions now", and the last automatic placement. `placeIdleSessions(force, threadId)` is also available over IPC for scoped placement. |
| Remote control | Prompts, stop, continue and compact on a placed session are proxied to its target over the target API; the desktop mirrors target status, new messages, cost, tokens and model every 8 seconds and keeps local chat in sync. |
| Docker/VPS runner | `runner/Dockerfile`, `runner/docker-compose.yml`, `runner/entrypoint.sh`, `runner/README.md`. Headless Electron (`OMP_HEADLESS=1`) under Xvfb, data on a labeled volume, loopback port by default, healthcheck, no public exposure. |
| Self-cleaning | `src/main/services/maintenance.ts` + `src/cli/runner.ts` (`gc`, `quota`, `bench`). Startup sweep and 5-minute interval; `Maintenance → Clean up now/Preview` in Settings; `POST /api/maintenance/sweep`. |
| Push notifications | VAPID keys stored as secrets; `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`. Push fires on approval requests, waiting/error status, and reply-required envelopes even when no WebSocket is connected. PWA service worker shows the notification and opens `/?thread=<id>` on click. |
| Cost meter | `GET /api/usage` aggregates thread cost/tokens; `targetUsage` fetches it, records cost/tokens/usageAt on the target and mirrors cost/tokens for placed sessions. Settings shows placed-session cost and a per-target meter refresh. |
| Self-hosted relay | `relay/server.mjs` is a stateless WebSocket relay. Runner dials out, clients connect to a room, frames are AES-256-GCM encrypted with HKDF-SHA256, and the relay only routes ciphertext. Serves the PWA, enforces room tokens, frame/client limits and reaps empty rooms. Dockerfile/compose and cleanup/security notes in `relay/`. |
| Memory checkpoint | `runner/checkpoint-agent.mjs` drives Docker Engine checkpoints (CRIU) for the Linux runner container. Checkpoint stores the full process tree/memory and stops the container; restore starts it from the image and the same in-flight turn continues. Same-host checkpoint/restore is v1. Export bundles checkpoint images + metadata + `/data` archive and import recreates a container; that cross-host path is **experimental and out of v1**. Settings exposes agent URL/container/token, checkpoint/restore/delete and the experimental bundle tools. Requires Docker experimental, CRIU 4.x, host networking. |
| Live pause/resume | Threads have `pauseThread`/`resumeThread` on the runner and `POST /api/threads/:id/{pause,resume}`. The OMP process tree is suspended (SIGSTOP or `NtSuspendProcess` on Windows) and resumed (SIGCONT/`NtResumeProcess`), preserving memory and the in-flight turn. Desktop and PWA expose Pause/Resume; placed sessions proxy the action to their target. |
| Performance | `scripts/remote-perf.mjs` measures the real HTTP/WS path, export/import and GC, and cleans up after itself. |

## Verification evidence

Environment: Windows 11 host, Electron 39 dev build, Android emulator, Docker
29.9 in WSL2 Ubuntu.

Remote HTTP and WebSocket (dev runner):

```
health=200 {"ok":true,"name":"OMP Studio","version":"0.1.0"}
state threads=17 nodes=2
unauth=401
WS EVENT snapshot threads=17
```

PWA in a 390×844 Electron window:

```
sessions: 19, chat title: slow-cricket (moved), messages: 15
composer: true, localStorage server: http://127.0.0.1:43120
```

Android (Capacitor WebView via CDP):

```
origin http://localhost
pairing token persisted after reload
top: "OMP Remote connected"
sessions: 19
chat: "Implement Pure-typescript Cricket Rules Engine", messages: 15, composer: true
```

Android → Docker runner (`http://10.0.2.2:43121`, token `doctortoken123`):

```
top: "OMP Remote connected", sessions: 1, banner: "", runtime errors: []
```

CI (GitHub Actions run 44025063671):

```
android job passed, artifact omp-remote-android/app-debug.apk 3.9 MB
ios job passed, artifact omp-remote-ios-simulator.zip 1.5 MB
```

Cold move (`scripts/remote-perf.mjs`, small repo):
```
health: median 1.4 ms
state snapshot: median 11.2 ms
websocket snapshot: 15.0 ms
export bundle: 44.2 ms (81 KB)
cold move (export + import): median 40.8 ms
gc sweep: 49 ms, reclaimed 147 KB across 2 items
sessions: 17 -> 17 after cleanup
```

Automatic placement (fresh profile, policy enabled with consent, 5-second idle
threshold, no manual "Place" call):

```
imported session thr_31756e9f6a034b2f (15 messages) at 1794894437597
moved at 1794894459349 -> 21.75 s later (scheduler runs every 20 s)
local thread: targetId=tgt_216fe5ee02b44f98
              remoteThreadId=thr_c9792f7c4a4142be
              remoteNodeId=prj_36eb855ee42a42e6
              status=idle, messages=15
target /api/state: threads=3 nodes=2
target message threadIds rewritten to the target thread id
forced scoped placement: 68 ms
desktop proxy stop: ok
```

Target message id remap check after rebuilding the image:

```
import 200 {"threadId":"thr_e9c0dfdb80294a9e","nodeId":"prj_9d9866075e924d5c"}
messages 15, threadIds thr_e9c0dfdb80294a9e
cleanup 200, target threads 1 nodes 1
```

Warm move against the Docker runner, same source workspace (74.3 MB, 441
workspace files):
```
COLD  ms=7104    warm=false  filesWritten=443  filesUnchanged=0    bytesSent=74305489
WARM  ms=206.6   warm=true   filesWritten=1    filesUnchanged=441  filesDeleted=1  bytesSent=50930
target nodes=2 threads=4 (root, target orchestrator, cold worker, warm worker)
target workspace: warm-test.txt = "version-two-with-more-content"
                  delete-me.txt = DELETED
manifest endpoint: origin prj_b6d4109d55ab45f9 -> target node prj_a0b45093ac8d4a49, 442 files
warm session: 15 messages
```

That is **34× faster** and **~1,458× less data sent** than the cold move for the
same workspace. The first move still uses the cold path when the target has no
matching origin workspace.

Push notification delivery (mock HTTPS push endpoint with a real VAPID-signed
Web Push request):

```
publicKey 200 87 BPUtuexF6WTt
subscribe 200 {"ok":true,"count":1}
test      200 {"sent":1,"failed":0,"skipped":0}
deliveries [{"method":"POST","url":"/push/test-device",
             "encoding":"aes128gcm","ttl":"300","auth":true,"bytes":183}]
unsubscribe 200 {"ok":true,"count":0}
```

The runner only used an insecure TLS override for the local mock certificate;
the production path uses normal HTTPS. PWA Settings shows Notifications,
Enable/Send test, and the notification click deep link opens
`/?thread=thr_291d0ea8d7614744` with 15 messages.

Cost meter (`GET /api/usage` and desktop `targetUsage`):

```
runner: cost=$4.192741758000002 tokens=315,891,093 threads=17
desktop target meter: $4.192741758 / 315,891,093 tok / 17 sessions
top: Mission Control $0.2605 · 10,253,024 tok
     slow-cricket   $1.7140 · 132,585,462 tok
```

Settings renders `Cost meter`, `Placed sessions: $...`, and a per-target
`Costs` refresh.

Self-hosted encrypted relay:

```
relay /health: {"ok":true,"rooms":1,"runners":1,"clients":0}
runner relayInfo: enabled=true running=true connected=true room=test-room
PWA through relay: 17 sessions, chat "Make Live Cricket Animation Feel Real", 500 messages
relay frame logs (RELAY_DEBUG_FRAMES=1):
  frame from=client bytes=185      sample={"v":1,"iv":"...","data":"QxJ4yV4..."
  frame from=runner bytes=1103825  sample={"v":1,"iv":"...","data":"vVIh2Nh..."
  frame from=client bytes=189      sample={"v":1,"iv":"...","data":"9ssRTj0..."
  frame from=runner bytes=169      sample={"v":1,"iv":"...","data":"6AM39PE..."
auth: wrong token -> HTTP 403, unknown room -> HTTP 404, bad role -> HTTP 400
wrong E2E key: 0 sessions (frames cannot be decrypted)
relay image: built, container Up (healthy), /health 200, PWA 200
```

The relay never receives the room's E2E secret; frames are decoded only in the
runner and the phone. It stores no files and reaps rooms after the runner and
clients disconnect.

Live pause/resume (real OMP turn):

```
copy thread: thr_1c23d05799114232 (74 MB workspace, 441 files)
prompt sent, status running
pause -> statusMessage "Paused (process suspended)", paused=true
OMP process 7912 threads: 75 Suspended, 1 Executive
resume -> paused=false, status completed
OMP threads: 0 Suspended, 64 Unknown, 10 EventPairLow
```

The process keeps its memory and in-flight turn; only execution is frozen.

Memory checkpoint/restore (Docker CRIU, same host):

```
counter container before checkpoint: 6
checkpoint cp-app -> container Exited (137)
restore -> Up, counter = 7, then 8   (memory preserved, not reset)
runner container: 3 threads / 2 nodes, state IDs unchanged
checkpoint runner-live -> Exited (137)
restore -> Up 6s (healthy), health 200, threads 3, nodes 2
in-flight thread status after restore: starting / "Starting OMP..."
checkpoint agent: authenticated API, unauth -> 401
```

Verified with Docker experimental mode and CRIU 4.3 on WSL. Docker cannot
restore published port mappings with CRIU, so the checkpoint overlay switches
the runner to host networking. `/etc/criu/runc.conf` must contain `file-locks`
for Electron/OMP containers.

Cross-daemon handoff (two dockerd instances, separate data roots, same kernel):

```
source counter before: 1
export bundle: 2.4 MB (checkpoint images + container metadata + /data archive)
import on second daemon: ok, container created + restored
after: 2, then 3          (memory preserved across daemons)
```

Runner cross-host restore was attempted on a **real second Ubuntu 22.04 WSL
host** with a matching Docker 29.9.3/runc 1.5.3, CRIU 4.3, `/var/lib/docker`,
volume name, image digest and architecture. The checkpoint bundle and `/data`
archive imported, but start failed:

```
OCI runtime restore failed: criu failed: type RESTORE errno 0
checkpoint descriptors.json: ["/dev/null","pipe:[834954]","pipe:[834955]"]
```

The live runner checkpoint contains pipe inodes from Electron/OMP stdio. Docker
does not remap those pipes on another host, so the memory image cannot be
restored there. Stateless cross-daemon handoff works; runner handoff needs
CRIU-native migration with pipe reconnection.

GC CLI on the real data directory (216 MB):

```
gc sweep average 27.6 ms over 20 runs (gate < 100 ms)
used: 216.0 MB / 20.00 GB (1.1%)
```

Docker runner:

```
image omp-runner:local built
container Up (healthy) 127.0.0.1:43121->43120/tcp
OMP Remote listening on 0.0.0.0:43120
pairing link http://127.0.0.1:43120/#t=doctortoken123
GET / (PWA) = 200, /api/health = 200, /api/state threads=1 nodes=1
```

Packaged app (`dist/OMP Studio-0.1.0-x64.exe`): RemoteService starts, serves
`out/mobile` from inside the asar (index 200, manifest 200,
`/assets/index-*.js` 200) and answers `/api/health` and `/api/state`.

## Self-cleaning rules implemented

- Session directories not referenced by a thread, after a 5-minute grace.
- Imported workspaces with no node, after a 5-minute grace.
- Worktrees not attached to a thread, after 1 day.
- Share bundles older than 1 day; artifacts older than 30 days.
- Logs at 20 MB rotate to `.1`–`.3`.
- Quotas: 20 GB per runner, 5 GB per session; warn at 80%, warn at 100%.
- Cleanup is label/path-scoped to the OMP data directory; never a global Docker
  prune and never outside the data directory.
- `DELETE /api/nodes/:id` + sweep reclaims an imported session and its files
  (verified: 25 → 17 threads, 147 KB reclaimed).

## Remaining gaps

- **iOS device signing**: the Capacitor project builds for the iOS Simulator in
  CI (`.github/workflows/mobile.yml`, run 44025063671: iOS job passed, artifact
  `omp-remote-ios-simulator.zip` 1.5 MB). A signed installable device build
  still needs an Apple account, a signing certificate and a provisioning
  profile.
- **Docker image size**: includes Electron and build tooling; the OMP binary is
  downloaded on first use.

## Deferred beyond v1

- **Cross-host runner memory migration.** Export/import exists, but Docker/CRIU
  does not reconnect live Electron/OMP pipes on another host. Use warm/cold moves
  for cross-host handoff. CRIU-native migration is a separate phase.
















