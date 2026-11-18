# Remote execution Phase 1 spec

Date: 2026-11-17

Locked decisions from the architecture review:

- No managed OMP relay, no public inbound ports, no OMP-hosted compute in the traffic path.
- Tailscale first, self-hosted relay second, Cloudflare Tunnel + Access third. E2E encryption regardless.
- Docker/VPS is the default cloud target. No managed provider is required.
- Cloud becomes the default only after a user-owned target is paired and consent is given.
- Placement is automatic; no per-session "pick a place" dialog.
- Cold move at turn boundaries only; no live migration.
- PWA first for mobile.
- No proprietary managed sandbox adapter. Docker/VPS is the only sandbox target in v1.
- Setup must be one command + QR; local sessions need no setup.
- Everything the runner creates is labeled and garbage-collected automatically.
- Performance gates: local start <300 ms, warm start <1 s, cold Docker <5 s, reconnect <500 ms, move small repo <5 s.

## 1. Refactor: shared core

Today the tree, sessions, git, PTY, sites, checkpoints and audit live under `src/main` and assume Electron. Phase 1 pulls the reusable parts into `src/core`:

```
src/core/
  store.ts            # persisted state, no electron imports
  orchestrator.ts
  message-bus.ts
  session.ts          # OMP RPC session
  git.ts
  pty.ts
  workspace.ts
  sites.ts
  checkpoints.ts
  permissions.ts
  audit.ts
  target.ts           # execution targets and placement
  bundle.ts           # session export/import
  policy.ts
```

Electron `safeStorage` stays behind an injectable `Secrets` interface. Filesystem paths come from an injectable `Paths` interface. The desktop app and runner both construct a `Core` with different implementations.

This is the prerequisite. Everything else is a thin adapter over it.

## 2. OMP Runner

New package: `src/runner` and a distributable `omp-runner` binary/container.

Responsibilities:

- own a `Core` instance;
- run OMP sessions and worktrees;
- serve a local JSON-RPC/WebSocket API;
- hold device keys and paired client keys;
- register itself with a target registry;
- dial out to Tailscale/relay/tunnel;
- export/import session bundles;
- checkpoint before moves;
- report heartbeats, load and cost.

CLI:

```
omp-runner init --name "office-pc" --data ~/.omp-studio/runner
omp-runner pair                       # prints QR / device code
omp-runner serve                      # foreground
omp-runner service install            # Windows service / systemd / launchd
omp-runner target self-test
```

Docker:

```
docker run -d --name omp-runner \
  -v omp-data:/data -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/tspen/omp-studio/runner:latest pair
```

The Docker socket is optional and used only for nested workspaces, never mounted into an agent sandbox.

## 3. Protocol

Shared types in `src/shared/protocol.ts`. JSON-RPC 2.0 over WebSocket, resumable by `seq`.

```ts
type Message =
  | { type: "hello"; runnerId: string; publicKey: string; capabilities: string[] }
  | { type: "pair.request"; code: string; deviceName: string; devicePublicKey: string }
  | { type: "pair.approved"; runnerId: string; deviceId: string; token: string }
  | { type: "target.list" }
  | { type: "session.create"; targetId: string; nodeId: string; brief: string; model?: string }
  | { type: "session.attach"; sessionId: string; lastSeq: number }
  | { type: "session.event"; sessionId: string; seq: number; kind: string; payload: unknown }
  | { type: "session.prompt"; sessionId: string; text: string; attachments?: Attachment[] }
  | { type: "session.approval"; sessionId: string; requestId: string; response: unknown }
  | { type: "session.checkpoint"; sessionId: string; label: string }
  | { type: "session.move"; sessionId: string; toTargetId: string; mode: "cold" }
  | { type: "session.terminate"; sessionId: string; keepVolume: boolean }
  | { type: "target.heartbeat"; load: number; sessions: number; costUsd: number }
  | { type: "error"; code: string; message: string };
```

Every payload is encrypted with a session key derived from the runner/device key pair. The transport sees only `{ runnerId, deviceId, envelope }`.

Event kinds: `message`, `tool`, `status`, `approval`, `checkpoint`, `git`, `pty`, `browser`, `notification`, `usage`. Clients replay from `lastSeq` after reconnect.

## 4. Pairing

1. Runner generates Ed25519 identity and a 6-character pairing code, valid 5 minutes.
2. Desktop app or PWA shows a QR containing `{ relayOrHost, runnerId, code, publicKey }`.
3. Client generates its own device key and sends `pair.request`.
4. User confirms the device name on the runner/desktop.
5. Runner returns a short-lived capability token; client stores its device key.
6. All future traffic is E2E encrypted and scoped to allowed sessions.

Revocation is a first-class UI action: removing a device invalidates its token and rotates the runner session key.

Tailscale path: QR contains the tailnet hostname plus the same pairing code; no relay involved.

Cloudflare Tunnel path: QR contains the Access-protected URL plus the same pairing code.

## 5. Session bundle

```
bundle/
  manifest.json        # schema, sessionId, tree node, model, effort, policy, placement
  workspace.bundle     # git bundle of the branch/commit
  untracked.tar        # untracked + deleted files, no ignored caches unless requested
  omp-session/         # JSONL session files
  store.json           # app Store subset: goals, todos, memory refs, envelopes
  checkpoints.json     # checkpoint ids + hashes
  events.jsonl         # append-only log up to the pause point
```

Rules:

- secrets are never in the bundle; the destination re-injects them from its own vault;
- ignored caches are optional and off by default;
- bundles are encrypted with a key derived from the user's device key;
- R2/S3/self-hosted object storage or direct runner-to-runner transfer;
- `manifest.json` includes `sourceTarget`, `createdAt`, `ompVersion` and `checksum`.

Cold move algorithm:

1. Wait for a safe boundary: turn finished, no running tool, no pending approval.
2. Create a file checkpoint.
3. Export bundle.
4. Upload to destination runner or object store.
5. Destination validates checksum, imports git bundle, restores untracked files, loads OMP session.
6. Start a new session on the destination from the OMP JSONL.
7. Replay unacknowledged events.
8. Mark source as archived/moved; keep its volume for rollback for N days.
9. Update `targetId` on the thread and emit `session.moved`.

The tree and envelopes are already durable in the app/control plane, so they do not move with the bundle.

## 6. Target registry

Persisted in the app Store, synced to paired runners:

```ts
interface ExecutionTarget {
  id: string;
  name: string;
  kind: "local" | "paired" | "docker";
  runnerId?: string;
  status: "online" | "offline" | "sleeping" | "provisioning";
  region?: string;
  os?: string;
  cpu?: number;
  ramMb?: number;
  gpu?: boolean;
  caps: string[];
  reachability: "tailscale" | "self-hosted-relay" | "cloudflare-tunnel" | "embedded";
  costPerHourUsd?: number;
  idlePolicy: "sleep" | "stay-awake";
  pairedAt: number;
  ownerControlled: boolean;
}
```

Placement policy (automatic):

```ts
interface PlacementPolicy {
  defaultTargetId: string | null;      // cloud after pairing + consent
  fallbackTargetId: string | null;     // local
  maxCostPerHourUsd?: number;
  allowedRegions?: string[];
  dataResidency: "any" | "user-owned" | "local-only";
  requireSecretsLocally: boolean;
  agentCanMove: boolean;
}
```

Scheduler picks a target by: explicit node override -> policy constraints -> default target -> fallback. No dialog per worker.

## 7. Agent and tree tools

Host tools:

- `runtime_list` — available targets, status, capabilities, cost.
- `runtime_status` — one target's load and sessions.
- `session_place` — create a new worker on a named target, if policy allows.
- `session_move` — cold-move a session to another target, if policy allows.
- `session_checkpoint` — explicit checkpoint before a risky operation.

Policy guard: moves that change `dataResidency`, cross a cost cap, or use a non-user-owned provider require user consent. Everything else is automatic.

The tree keeps its typed envelopes; moving a session does not change parent/child relationships.

## 8. PWA

`src/renderer/pwa/` entry point sharing `src/renderer/src/store.ts` and components.

Screens:

- paired runners / targets;
- sessions with status, target and last output;
- chat with approvals, images, @file context;
- diff and terminal panes (read-only first);
- push notification settings;
- "Move to…" action;
- device revocation.

Web Push payloads contain only `sessionId`, `kind` and a nonce; the app fetches content over the E2E channel after unlock.

## 9. Security

- E2E encryption with per-device keys; transport never sees plaintext.
- No inbound ports on runners.
- Tailscale ACLs or Cloudflare Access exact-email policy, not public quick tunnels in production.
- Network egress allowlist during agent phase; proxy substitution for secrets.
- No host mounts into agent sandboxes; Docker socket only in the runner control process.
- Signed runner releases; pinned image digests.
- Snapshots encrypted at rest; explicit retention/deletion.
- Audit entries for pairing, placement, moves, approvals and revocations.
- Lethal trifecta: never combine private code, untrusted content and unrestricted egress in one context.

## 10. Frictionless setup

Local: zero config, embedded runner.

New PC or VPS:

```
curl -fsSL https://get.omp.studio/runner | sh
```

The script:

1. detects OS/arch, Docker/Podman, KVM, Tailscale;
2. installs a user-space runner and system service;
3. starts it and prints a QR + 6-character code;
4. app scans, confirms the device, target appears;
5. optional Tailscale toggle, no port/firewall setup.

No account, no YAML, no cloud signup. If Docker is missing, offer rootless Docker or a direct Linux runner.

First-run has three buttons: **Start here**, **Connect this computer**, **Connect a server**. Cloud default turns on only after an always-on target is paired and consented.

## 11. Self-cleaning

Label every created resource:

```
omp.managed=true
omp.runner=<runnerId>
omp.session=<sessionId>
omp.kind=container|volume|network
```

| Resource | Policy |
| --- | --- |
| Session workspace | delete on terminate, 5-minute trash, startup reconciliation |
| Ephemeral container | `--rm`, max 2 warm per target, stop at 10 min idle, remove at 30 min |
| Pinned container | stop at 30 min idle, remove at 24 h unless pinned |
| Session volume | delete at 7 days idle unless pinned |
| Checkpoints | last 5 per session, 50 per thread |
| Moved bundles | last 3, source deleted 24 h after move |
| Images | 2 pinned digests max, prune unused, never global `docker system prune` |
| Package caches | LRU, 10 GB cap |
| Logs | rotate at 20 MB, 3 files |
| Orphans | sweep at startup + every 5 min, remove after 1 h |
| Disk quota | 20 GB/runner, 5 GB/session, warn 80%, deny 100% |

Expose `omp-runner gc --dry-run` and a "Clean up now" UI action. Cleanup is always label-scoped.

## 12. Performance

| Operation | Gate |
| --- | --- |
| Local session start | <300 ms |
| Warm target start | <1 s |
| Cold Docker start | <5 s |
| Reconnect | <500 ms |
| Cold move, small repo | <5 s |
| Cold move, 1 GB | <30 s |
| GC sweep | <100 ms |

Mechanisms: prebuilt runner image, warm pool, persistent volume first, bare repo cache + git delta, copy-on-write workspaces, event-log resume, background transfer, shared package caches, never restart a running agent on UI disconnect.

## 13. Milestones and evidence

1. **Core extraction** — typecheck passes with no Electron imports in `src/core`.
2. **Runner boots locally** — `omp-runner serve` starts a Core, creates a thread, runs a prompt, streams events.
3. **Pairing** — QR + device code, E2E round trip, revocation.
4. **Tailscale path** — PWA loads over `tailscale serve`, chat + approval works.
5. **Self-hosted relay** — runner dials out, phone PWA pairs, no inbound port on runner.
6. **Cold move** — create session on target A, checkpoint, export bundle, import on target B, resume from same conversation state; git diff matches.
7. **Placement** — default target applied automatically to a new worker; budget/data-residency guard blocks an invalid move.
8. **Performance and cleanup gates** - measure start/reconnect/move, run GC dry-run, verify no orphaned managed resources after terminate, crash, and move.

Out of scope: live migration, managed relay, native mobile, Kubernetes, multi-region scheduling.
