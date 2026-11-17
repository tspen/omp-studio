# Remote execution implementation status

Date: 2026-11-17

This is the implementation record for the remote/mobile/cloud work. It lists what
ships, how it was verified, the measured performance, and the remaining gaps.

## What ships

| Area | Implementation |
| --- | --- |
| Remote server | `src/main/services/remote.ts` — token auth, HTTP API, WebSocket event stream with `snapshot` on connect, PWA static serving, CORS, QR pairing links. |
| Endpoints | `GET /api/health`, `/api/state`, `/api/messages/:id`, `/api/approvals`, `/api/threads/:id`; `POST /api/threads/:id/{send,stop,continue,compact}`, `/api/approvals/:id`, `/api/envelopes/:id/answer`, `/api/import`, `/api/maintenance/sweep`; `GET /api/export/:id`; `DELETE /api/nodes/:id`. |
| Pairing | 48-hex token stored with Electron `safeStorage`; QR contains `#t=<token>` in the URL fragment (never sent to the server); rotate revokes every device. `OMP_REMOTE_TOKEN` overrides for containers. |
| Mobile app | `mobile/` React PWA: pair screen, session list with Live/All filters, chat with tool blocks, approvals, inbox, settings, installable manifest + service worker. WebSocket with 3 s reconnect plus 4 s HTTP polling fallback. |
| Android | Capacitor project in `android/`; cleartext allowed for LAN/Tailscale dev; `app-debug.apk` builds and runs. |
| iOS | Capacitor project in `ios/`; ATS and local-network entries added; build/sign requires macOS (see CI workflow). |
| Desktop UI | Settings → Remote: enable, bind host/port, keep-running toggles, URLs, token show/copy/rotate, QR, Tailscale steps, cleanup report, targets and cold move. |
| Cold move | Export zip (manifest + workspace + OMP session + chat) and import on the same or another runner. Target registry probes `/api/health`, stores tokens separately, and reports latency. Source is retained for rollback. |
| Warm move | Targets keep the workspace in place under an origin key (`.omp-origin.json` + `.omp-manifest.json`). Before export the source reads the target manifest, hashes the workspace, sends only changed files, and lists deletions. The target applies the delta to the existing workspace and creates only a new session thread. Reuses the target node and orchestrator. |
| Automatic placement | `remotePlacement` policy: enabled + explicit consent + selected target + idle threshold. A scheduler checks every 20 seconds, picks idle worker sessions with history, cold-moves at most two per pass, never interrupts a running turn, releases the local OMP session, and records `targetId`, `remoteThreadId`, `remoteNodeId`, `movedAt`. Settings shows policy, "Place idle sessions now", and the last automatic placement. `placeIdleSessions(force, threadId)` is also available over IPC for scoped placement. |
| Remote control | Prompts, stop, continue and compact on a placed session are proxied to its target over the target API; the desktop mirrors target status and new messages every 8 seconds and keeps local chat in sync. |
| Docker/VPS runner | `runner/Dockerfile`, `runner/docker-compose.yml`, `runner/entrypoint.sh`, `runner/README.md`. Headless Electron (`OMP_HEADLESS=1`) under Xvfb, data on a labeled volume, loopback port by default, healthcheck, no public exposure. |
| Self-cleaning | `src/main/services/maintenance.ts` + `src/cli/runner.ts` (`gc`, `quota`, `bench`). Startup sweep and 5-minute interval; `Maintenance → Clean up now/Preview` in Settings; `POST /api/maintenance/sweep`. |
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
- **Live migration**: moves are cold or warm at turn boundaries. Memory/device
  snapshot migration and paused-microVM (E2B Embed) resume are not implemented.
- **Push notifications and cost meter**: not implemented.
- **Relay**: Tailscale (or another user-owned reverse proxy) is the supported
  access path. No self-hosted encrypted relay service is included.
- **Docker image size**: includes Electron and build tooling; the OMP binary is
  downloaded on first use.

