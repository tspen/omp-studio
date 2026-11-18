# Remote execution implementation status

Date: 2026-11-18

This is the implementation record for the remote/mobile/cloud work. It lists what
ships, how it was verified, the measured performance, and the remaining gaps.

## V1 scope decision (2026-11-17)

Cross-host **memory** migration is **out of v1**. Supported v1 paths are:

- same-host pause/resume,
- cold and warm moves at turn boundaries,
- relay access, PWA/Android, push and self-cleaning.

## What ships

| Area | Implementation |
| --- | --- |
| Remote server | `src/main/services/remote.ts` — token auth, HTTP API, WebSocket event stream with `snapshot` on connect, PWA static serving, CORS, QR pairing links. |
| Endpoints | `GET /api/health`, `/api/state`, `/api/messages/:id`, `/api/approvals`, `/api/threads/:id`; `POST /api/threads/:id/{send,stop,continue,compact}`, `/api/approvals/:id`, `/api/envelopes/:id/answer`, `/api/import`, `/api/maintenance/sweep`; `GET /api/export/:id`; `DELETE /api/nodes/:id`. |
| Pairing | 48-hex token stored with Electron `safeStorage`; QR contains `#t=<token>` in the URL fragment (never sent to the server); rotate revokes every device. `OMP_REMOTE_TOKEN` overrides for containers. |
| Mobile app | `mobile/` React PWA: pair screen, session list with Live/All filters, chat with tool blocks, approvals, inbox, settings, installable manifest + service worker. WebSocket with 3 s reconnect plus 4 s HTTP polling fallback. |
| Android | Capacitor project in `android/`; cleartext allowed for LAN/Tailscale dev; `app-debug.apk` builds and runs. |
| iOS | Capacitor project in `ios/`; ATS and local-network entries added; build/sign requires macOS (see CI workflow). |
| Desktop UI | Settings → Remote: one **Use your phone** card with QR pairing, a **Your machines** card only when targets exist, and a collapsed **More options** disclosure for relay, server, adding machines and cleanup. |
| Cold move | Export zip (manifest + workspace + OMP session + chat) and import on the same or another runner. A running session offers **Move after turn** (queued automatically at the next boundary) or **Stop & move**. Target registry probes `/api/health`, stores tokens separately, and reports latency. Source is retained for rollback. |
| Warm move | Targets keep the workspace in place under an origin key (`.omp-origin.json` + `.omp-manifest.json`). Before export the source reads the target manifest, hashes the workspace, sends only changed files, and lists deletions. The target applies the delta to the existing workspace and creates only a new session thread. Reuses the target node and orchestrator. |
| Remote control | Prompts, stop, continue and compact on a placed session are proxied to its target over the target API; the desktop mirrors target status, new messages, cost, tokens and model every 8 seconds and keeps local chat in sync. |
| Docker/VPS runner | `runner/Dockerfile`, `runner/docker-compose.yml`, `runner/entrypoint.sh`, `runner/README.md`. Headless Electron (`OMP_HEADLESS=1`) under Xvfb, data on a labeled volume, loopback port by default, healthcheck, no public exposure. |
| Self-cleaning | `src/main/services/maintenance.ts` + `src/cli/runner.ts` (`gc`, `quota`, `bench`). Startup sweep and 5-minute interval; `Maintenance → Clean up now/Preview` in Settings; `POST /api/maintenance/sweep`. |
| Push notifications | VAPID keys stored as secrets; `GET /api/push/key`, `POST /api/push/subscribe`, `POST /api/push/unsubscribe`, `POST /api/push/test`. Push fires on approval requests, waiting/error status, and reply-required envelopes even when no WebSocket is connected. PWA service worker shows the notification and opens `/?thread=<id>` on click. |
| Self-hosted relay | `relay/server.mjs` is a stateless WebSocket relay. Runner dials out, clients connect to a room, frames are AES-256-GCM encrypted with HKDF-SHA256, and the relay only routes ciphertext. Serves the PWA, enforces room tokens, frame/client limits and reaps empty rooms. Dockerfile/compose and cleanup/security notes in `relay/`. |
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
















