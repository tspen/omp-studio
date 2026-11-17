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

- **iOS build/signature**: the generated Capacitor project cannot be compiled on
  Windows. `.github/workflows/mobile.yml` builds an unsigned simulator app on a
  macOS runner; a signed device build needs an Apple account and macOS signing.
- **Warm and live moves**: v1 only does cold move at turn boundaries. Paused
  microVM (E2B Embed) and memory snapshot migration are not implemented.
- **Automatic placement**: targets are registered and sessions can be moved, but
  new sessions still start on the local runner. There is no policy engine that
  silently chooses a cloud target yet.
- **Push notifications and cost meter**: not implemented.
- **Relay**: Tailscale (or another user-owned reverse proxy) is the supported
  access path. No self-hosted encrypted relay service is included.
- **Docker image size**: includes Electron and build tooling; the OMP binary is
  downloaded on first use.
