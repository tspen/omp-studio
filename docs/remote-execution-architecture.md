# Remote, mobile and cloud execution architecture

Date: 2026-11-17

Status: **partially implemented**. Remote server, pairing, PWA, Android/iOS projects, cold move, target registry, Docker/VPS runner and self-cleaning GC ship in this tree. See [`remote-implementation-status.md`](remote-implementation-status.md) for verified evidence and remaining gaps (iOS signing, warm/live moves, push).

Goals:

- one session model that can run locally, on a spare PC, on a VPS, or in a self-hosted cloud sandbox;
- reach it from the desktop app or phone anywhere, with no public exposure and no managed Pi relay;
- move sessions between places at turn boundaries;
- **frictionless setup and run-up**;
- **fast** start, reconnect, move and cleanup;
- **self-cleaning**, so containers, volumes, images, bundles and workspaces never accumulate.

## Recommendation in one sentence

Build **one Perch Runner**, register every place it can run as a **target**, move sessions as **portable bundles at turn boundaries**, and reach runners only through **networks the user controls** (a self-hosted relay, Cloudflare Tunnel + Access, or a private LAN). Default to a **user-owned cloud target** (VPS Docker runner); no proprietary managed sandbox is in the default path.

## What Codex Cloud validates

- Each task runs in its own isolated workspace/VM, not on the user's laptop.
- A **setup script** runs with internet access; the **agent phase is offline by default** behind an HTTP/HTTPS proxy.
- **Secrets are setup-only** and removed before the agent starts; network secrets are proxy-substituted.
- Container state is **cached up to 12 hours**, with a maintenance script on resume; tasks keep uncommitted files and installed tools.
- Current cloud environments are VMs (2 vCPU/8 GiB Plus, 4 vCPU/16 GiB/32 GiB Pro) and task state is recoverable for **7 days**.
- Internet allowlists, Tailscale VPN and OIDC credentials are first-class settings.

That is the bar: isolated workspace + setup phase + proxy + persistent task state.

## Sandbox options after excluding managed proprietary services

| Option | Open source | Runs on | Role |
| --- | --- | --- | --- |
| **Perch Runner (ours)** | Yes | Your PC/VPS | The thing we build. |
| **Docker / Podman** | Yes | VPS, home server, local WSL2 | Default self-hosted cloud target. |
| **Firecracker / CRIU** | Yes | Your hosts | Building blocks, not a product. |
| **Managed sandbox clouds** | Varies | Third party | Not in v1; they put code on someone else's infrastructure. |

No proprietary managed sandbox services, no Pi-hosted relay or compute.

## Five components

### 1. Perch Runner

One executable/container that owns Pi, worktrees, PTY, browser, checkpoints, secrets, targets and the outbound link.

Modes:

| Mode | Where | Setup |
| --- | --- | --- |
| Embedded | Desktop app | None; works today |
| Paired host | Spare PC/Mac/mini PC | One command + QR |
| Docker | VPS/home server | One command; auto-detects Docker |

The runner never needs an inbound port. It dials out and authenticates with a device key.

### 2. Target registry and moves

An `ExecutionTarget`:

```
id, name, kind: local | paired | docker
status: online | sleeping | provisioning | offline
os, arch, cpu, ram, disk, gpu
caps, reachability: tailscale | self-hosted-relay | cloudflare-tunnel | embedded
costPerHourUsd, idlePolicy, region, ownerControlled
```

Moves are explicit in v1:

- each node/session can have a preferred target; local is the default;
- constraints: repo, OS/toolchain, GPU, allowed secrets, network policy, cost, data residency;
- fallback: preferred -> local -> fail with a reason;
- no per-worker move dialog; the user picks a session and a machine when they want to move it;
- agents get `runtime_list`, `runtime_status`, `session_move`; moves that spend money or change data residency require consent.

### 3. Portable session bundle

| Layer | Contents | Move method |
| --- | --- | --- |
| Workspace | branch/commit, untracked + deleted files | git delta/push + untracked tar, or persistent volume |
| Agent state | Pi session JSONL, Store subset, goals/todos/memory refs | copy session dir + store snapshot |
| Runtime | shells, dev servers, processes | stop/restart; or whole-VM resume |

Move qualities:

1. **Cold move (v1):** turn boundary, export, import, resume. Works everywhere.
2. **Warm move:** compute moves while workspace stays on a persistent volume (VPS volume). Fast.
3. **Live move:** memory/device snapshot; same host/instance type; not v1.

Use **git push to a bare repo on the target** plus a tar of untracked files instead of shipping a full workspace each time. For large repos, start the target from its existing cache and fetch only the delta.

### 4. Reachability: no exposure, near-zero setup

**A. Tailscale (default).** Embed `tsnet` or install Tailscale beside the runner; app/phone joins the tailnet; `tailscale serve` gives HTTPS PWA. No public exposure, no ports, no DNS setup. Requires Tailscale on devices.

**B. Self-hosted relay.** A small relay on the user's VPS; runner dials out; QR pairing; E2E encryption; relay sees only ciphertext. No inbound ports on the runner.

**C. Cloudflare Tunnel + Access.** `cloudflared` outbound plus exact-email/SSO Access. Needs a domain/account; best for teams.

No managed Pi relay and no public quick tunnels in production.

### 5. Clients

- Desktop app: target switcher, move, pairing, same tree.
- **PWA first** for phone: installable, Web Push, QR pairing, session cards, chat, approvals, diff, terminal, screenshots.
- CLI later.
- Push payloads contain only IDs and a nonce; content is fetched over E2E after unlock.

## Frictionless setup

### Local

The app already bundles Pi. A local session must start with **zero configuration** and no container.

### New PC or VPS

One command:

```
curl -fsSL https://get.omp.studio/runner | sh
```

Then:

1. detects OS/arch, Docker, KVM and Tailscale;
2. installs a user-space runner + service;
3. starts the runner and prints a QR/device code;
4. app scans/enters code, pairs, and the target appears;
5. optional Tailscale toggle; no ports/firewall steps.

No account, no cloud signup, no YAML. Docker is auto-detected; if missing, the script offers rootless Docker or runs the runner directly on Linux.

### First-run choices

Three buttons, no wizard:

- **Start here** — local target, immediate.
- **Connect this computer** — one command for another PC.
- **Connect a server** — VPS command + QR.

Cloud default turns on automatically after an always-on target is paired and consent is confirmed. No per-worker prompts afterward.

### Pairing

6-character code + QR; 5-minute expiry; Ed25519 device keys; user confirms device name; revocation rotates the session key. Tailscale/relay/tunnel paths share the same pairing flow.

## Fast by construction

Performance budget:

| Operation | Target |
| --- | --- |
| Local session start | < 300 ms |
| Warm target session start | < 1 s |
| Cold Docker start (prebuilt image + cache) | < 5 s |
| Reconnect to a running session | < 500 ms |
| Cold move, small repo | < 5 s |
| Cold move, 1 GB workspace | < 30 s |
| Cleanup sweep | < 100 ms |

Mechanisms:

- **Prebuilt runner image** with Pi, Node, Python, git, ripgrep and common tools; pinned digests; no build during setup.
- **Warm pool**: keep one idle runner container per active target, start sessions by cloning a prepared workspace.
- **Persistent volume first**: a session normally stays on the same target; UI reconnects, it does not restart.
- **Bare repo cache** on each target; hydrate via git fetch/push delta, not a full clone every time.
- **Copy-on-write workspaces** (overlayfs/ZFS/reflink) for fast forks; fallback to hardlinks/copy.
- **Checkpoint before prompt** locally; snapshot only for move/hibernate, not every keystroke.
- **Event log resume**: reconnect from `lastSeq`; no transcript refetch.
- **Background transfer**: start a move from the cached workspace, stream the delta in the background; block only on the final checkout.
- **Shared package caches** mounted read-only (npm/pnpm/pip/uv/cargo) to avoid duplicating `node_modules` per session.
- **Lazy asset hydration**: don't copy ignored caches unless the session needs them.
- **Keep the process alive**: a UI disconnect never stops an agent.

## Self-cleaning policy

Everything the runner creates is labeled `omp.managed=true`, `omp.runner=<id>`, `omp.session=<id>`, `omp.kind=<container|volume|network>`.

| Resource | Policy |
| --- | --- |
| Session workspace dir | Deleted on terminate; 5-minute trash grace; crash reconciliation on startup |
| Ephemeral container | `--rm`; max 2 warm per target; stop after 10 min idle; remove after 30 min |
| Persistent container | Only if pinned; stop after 30 min idle; remove after 24 h unless pinned |
| Session volume | One per persistent session; delete after 7 days idle unless pinned |
| Snapshots/checkpoints | Last 5 per session; checkpoints pruned at 50/thread; provider snapshots 7 days |
| Moved bundles | Keep last 3; delete source copy 24 h after successful move; rollback window |
| Images | Two pinned runner images max; prune unused digests, never `docker system prune` globally |
| Package caches | LRU with 10 GB cap per runner; evict oldest |
| Logs | Rotate at 20 MB, keep 3 files |
| Orphans | Startup sweep + every 5 min; any managed resource with no live session is removed after 1 h |
| Disk quota | 20 GB per runner default, 5 GB per session; warn at 80%, refuse new sessions at 100% |

Cleanup is **label-scoped**, never global. The runner exposes `omp-runner gc --dry-run` and a UI "Clean up now" action. A crash cannot leave permanent debris because the next start reconciles by labels and session registry.

## Move algorithm (cold)

1. Wait for a turn boundary and checkpoint.
2. Build/refresh the bare repo on the target via git push; tar untracked/deleted files.
3. Copy Pi session JSONL + Store subset.
4. Validate checksum and Pi version.
5. Start the destination session; replay unacknowledged events.
6. Mark source `moved`; keep its volume 24 h for rollback, then delete.
7. Update `targetId` on the thread; emit `session.moved`.

Secrets are never in the bundle; the target injects its own.

## Security

- E2E encryption; no managed relay; no inbound ports.
- Tailscale ACLs / Access exact-email; no public quick tunnels.
- Network egress allowlist during agent phase; proxy substitution for secrets.
- No host mounts or Docker socket inside agent sandboxes.
- MicroVM/container isolation for YOLO; local YOLO in WSL2/Docker.
- Signed runner images; pinned digests; audit pairing, moves, approvals, revocations.
- Lethal trifecta: never combine private code, untrusted content and unrestricted egress in one context.

## FAQ: sessions on PCs and phone

**Can I see my sessions from another PC or phone?** Yes, in the design. The session registry and append-only event log are shared, so every paired device sees the same list, status, last output and approvals. The transcript/code stays on the owning runner; the phone streams it E2E.

**Many PCs?** Each is a target. A sleeping laptop's sessions show offline; move them to an always-on target when it wakes. This is why the default is an always-on user-owned target.

**Do I pick a place per agent?** No. Sessions stay local until you explicitly move one.

**Implemented today?** Partly: the remote server, PWA, Android build, cold move, target registry, Docker runner and GC are implemented. Warm/live moves and push are not. See [`remote-implementation-status.md`](remote-implementation-status.md).

## Phases

**Phase 1 (2-4 weeks):** core extraction; `omp-runner` local/VPS; Tailscale/self-hosted relay; QR pairing; PWA; cold move; GC and quotas; performance gates.

**Phase 2 (2-3 weeks):** user-owned cloud default (VPS Docker); push; move UI.

**Phase 3 (3-5 weeks):** warm moves; tree-level move policy; team targets.

**Not in v1:** managed sandbox services, managed relay, live migration, native mobile, Kubernetes, multi-region scheduling.

## Sources

- OpenAI Codex Cloud environments: https://developers.openai.com/codex/environments/cloud-environments
- Legacy Codex environments (setup/agent phases, cache, proxy, secrets): https://developers.openai.com/codex/cloud/environments
- Fly "Code and let live" (persistent vs ephemeral computers): https://fly.io/blog/code-and-let-live/
- Simon Willison lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Firecracker snapshotting: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- CRIU: https://criu.org/
- Tailscale: https://tailscale.com/
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- pi-daemon (persistent agent + PWA via Tailscale/Cloudflare Access): https://github.com/SASUKE40/pi-daemon

