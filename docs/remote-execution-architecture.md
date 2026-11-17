# Remote, mobile and cloud execution architecture

Date: 2026-11-17

Goal: one execution model for OMP Studio where a session can run locally, on a spare VPS, on a home machine, or in a cloud sandbox; the user can reach it from the desktop app or phone anywhere; agents and the tree can move work between places; and the default is cloud.

## Recommendation in one sentence

Build **one OMP Runner**, register every place it can run as a **target**, move sessions as **portable bundles at turn boundaries**, and reach runners through an **outbound-only encrypted relay** (with Tailscale/Cloudflare Tunnel as bring-your-own alternatives). Use **Fly Sprites** as the first managed cloud target; keep Docker/VPS as the self-hosted target.

That is the "all in one" shape: placement is a property of a session, not a separate product.

## What Codex does (and what to copy)

Codex Cloud is the closest reference:

- Each task runs in its **own workspace/VM**, not on the user's laptop.
- A **setup script** runs with internet access to install dependencies; the **agent phase runs offline by default** behind an HTTP/HTTPS proxy.
- **Secrets are available to setup only** and removed before the agent starts; network secrets are substituted by the proxy for allowed HTTPS hosts.
- Container state is **cached for up to 12 hours**; resuming runs a maintenance script, and tasks keep their own files/uncommitted changes.
- Current cloud environments are VMs (2 vCPU/8 GiB for Plus, 4 vCPU/16 GiB/32 GiB disk for Pro/Enterprise) and task VM state is recoverable for **7 days**.
- Internet allowlists, Tailscale VPN access and OIDC cloud credentials are first-class environment settings.

So "Codex containers" is real: a cached, isolated workspace with a setup phase, a network proxy, secret injection, and persistent task state. That is the minimum bar for a credible cloud execution product.

## What Simon Willison's writing implies

- **Persistent computers beat ephemeral sandboxes for coding agents.** Fly's argument: agents want a real computer with a persistent filesystem, not a fresh container every time.
- **Sprites** are hardware-isolated Linux microVMs with a persistent disk, scale-to-zero, ~300 ms **checkpoints of the whole disk**, port forwarding, preinstalled agents, and an API. Simon measured roughly **46 cents for a 4-hour intensive session**.
- **YOLO mode belongs in a sandbox.** The "lethal trifecta" (private data + untrusted content + outbound channel) means running YOLO on the bare host is the wrong default.
- **Mobile is already solved with a persistent machine + Tailscale/PWA.** Fly's own mobile demo is a Sprite that sleeps, wakes in under a second, serves a PWA over Tailscale Serve, and calls Claude in YOLO mode.

Conclusion: for OMP Studio, the cloud target should be a **persistent, checkpointable computer**, not a cold ephemeral function. That favors Sprites, E2B paused sandboxes, or a VPS with a persistent volume.

## The five components

### 1. OMP Runner

One executable/container that owns:

- the OMP process and session files;
- git worktrees/branches for the tree;
- PTY sessions, dev servers, headless browser;
- checkpoints and workspace snapshots;
- local secrets and network policy;
- an outbound WebSocket to a relay/control plane.

It runs in four modes:

| Mode | Where | Purpose |
| --- | --- | --- |
| Embedded | Desktop app | Local sessions, today's behavior |
| Paired host | Spare PC/Mac/mini PC/VPS | Always-on personal computer |
| Container | Docker/Podman on a VPS | Cheap self-hosted cloud |
| Managed sandbox | Sprites/E2B/Modal/Vercel/Cloudflare | Zero-setup cloud default |

The runner never needs an inbound port. It dials out, authenticates with a device key, and exposes a local JSON-RPC API over the tunnel.

### 2. Target registry and placement

An `ExecutionTarget` describes a place that can run sessions:

```
id, name, kind: local | paired | docker | sprites | e2b | modal | vercel | cloudflare
status, region, os, arch, cpu, ram, disk, gpu
capabilities: browser, docker, gpu, tailscale, public-url
cost model, idle policy, data residency
reachability: relay | tailscale | cloudflare-tunnel | direct-lan
```

Placement rules:

- Each node/project/session has a **preferred target**, with `cloud` as the default when a cloud target exists.
- Constraints: repo size, OS/toolchain, GPU, allowed secrets, network policy, max cost, region.
- Fallback chain: preferred -> same provider -> local -> fail with a clear reason.
- The tree can mix placements: a root orchestrator local, one project on a VPS, another in cloud.
- Agents get `runtime_list`, `runtime_provision`, `session_place`, `session_move` host tools. Budget/data-egress moves require user consent; routine moves inside the current target are allowed.

### 3. Portable session bundle

Do not try to move a live process between providers first. Move three layers:

| Layer | Contents | Move method |
| --- | --- | --- |
| Workspace | git branch/commit, untracked files, deleted files, optional ignored caches | `git bundle` + diff/tar, or a shared volume |
| Agent state | OMP session JSONL, app Store checkpoint, goals, todos, memory | copy session directory + store snapshot |
| Runtime state | shells, dev servers, running processes | stop/restart; or whole-VM snapshot |

Three move qualities:

1. **Cold move (default):** finish the current turn/checkpoint, export bundle, upload to target, resume. Seconds to a minute. Works across every provider.
2. **Warm move:** compute moves but the workspace stays on a persistent volume (Sprites disk, E2B paused sandbox, Fly volume). Fast, provider-specific.
3. **Live move:** checkpoint/restore of memory + devices (Firecracker snapshot, CRIU). Same host/instance type, provider-specific; use only when zero-downtime matters.

The append-only session event log is the source of truth. Clients resume from the last sequence number; runners replay unacknowledged events. That makes reconnects and device switches reliable.

### 4. Reachability: zero setup by default

Three options, in order of user experience:

**A. OMP relay (recommended default)**

- Runner opens an outbound WebSocket over TLS.
- Phone/desktop pair with a QR or 8-character code.
- Messages are end-to-end encrypted with per-device keys; the relay only sees ciphertext and routing metadata.
- No ports, DNS, certificates or VPN.
- Push notifications go through the relay to the PWA/native app.
- This is how Happy, T3 Code and several Claude remote projects work.

**B. Tailscale (bring your own network)**

- Embed `tsnet` in the runner or install Tailscale next to it.
- App/phone joins the tailnet; `tailscale serve` provides HTTPS PWA.
- No public exposure; good for privacy-conscious users.
- Requires installing Tailscale on each device (not truly zero setup on iPhone, but close).

**C. Cloudflare Tunnel + Access**

- `cloudflared` connects outbound to Cloudflare; Access enforces email/SSO.
- Needs a Cloudflare account and a domain (or a quick tunnel for testing).
- Good for a stable public hostname and team access.

Recommendation: ship A as the default, offer B/C as "bring your own tunnel". Never require port forwarding.

### 5. Clients

- **Desktop (Electron)**: target switcher, session placement, "Move to…", runner pairing, same tree.
- **PWA first for mobile**: reuse the React renderer with a responsive shell; installable, Web Push, QR pairing, session list, chat, approvals, diffs, terminal, screenshots. No app-store dependency.
- **Native wrapper later** only if PWA push/voice is insufficient.
- **CLI**: `omp-studio attach <session>` for terminal users.

Mobile must show: session state, last output, pending question/approval, target, and a reply box. Full tree is secondary on a phone.

## Cloud provider comparison

| Provider | Model | Persistence | Snapshot/move | Best for | Watch-outs |
| --- | --- | --- | --- | --- | --- |
| **Fly Sprites** | Persistent hardware-isolated Linux microVM | Disk persists while idle; scale-to-zero; idle free | ~300 ms whole-disk checkpoint/restore; API; port forwarding | Default agent computer, mobile, YOLO | Newer product; VM, not container; pricing per active resources |
| **E2B** | Firecracker microVM sandbox | Pause saves memory + filesystem indefinitely | Pause/resume (~1 s resume, ~4 s/GiB pause), snapshots, forks | Sessions that must keep processes; API sandboxes | Continuous runtime limits (24 h Pro); memory resume can fail if guest hung |
| **Modal Sandboxes** | gVisor/VM sandboxes | Filesystem snapshots 30 days; memory snapshots 7 days (experimental) | Snapshot, fork, mount directory images | Bursty parallel jobs, forking, data workloads | Memory snapshot limitations; not a persistent personal computer |
| **Vercel Sandbox** | Firecracker microVM | Persistent by default, snapshot | Create ~1.8 s, resume ~3.3 s measured | Vercel-centric teams, ephemeral previews | Region-limited; less "computer" feel |
| **Cloudflare Containers** | Serverless containers behind Durable Objects | Container + Durable Object state; inactivity timeout | No whole-VM checkpoint; image-based | Edge preview, Sites, short-lived execution | Workers Paid; container limits; not persistent microVM |
| **Self-hosted VPS + Docker** | Container on your machine | Volume + git + our checkpoints | Cold move; volume snapshot; no live migration | Cheapest, full control, spare VPS | You own patching, disk, uptime |
| **Home PC/Mac + runner** | Native process | Local disk | Cold move; Tailscale/relay access | Free always-on machine | Network/power reliability |

**Recommendation:** implement **Sprites first** as the managed default, **Docker/VPS** second, **E2B** third for memory-preserving pause/resume. Keep Cloudflare Containers for Sites/preview, not the main agent VM.

## Security model

Assume the agent is hostile or prompt-injected:

- Default network **off** or allowlisted during agent phase; setup phase can have broader access.
- Egress through a proxy that supports **network secret substitution** and logs destinations.
- No host filesystem mounts into the sandbox; no host Docker socket.
- Per-session secrets, short-lived tokens, no long-lived git credentials inside the sandbox.
- MicroVM isolation for YOLO; local YOLO runs in WSL2/Docker, not the Windows host.
- E2E encrypted relay; device keys with revocation; runner identity pinned on first pairing.
- Snapshots encrypted at rest; retention and deletion controls; audit per target.
- Data residency: a target's region and provider are visible before a session moves; cloud default is opt-in at onboarding.

The "lethal trifecta" rule: never let one context hold private code, untrusted content and an unrestricted outbound channel at once. Network policy is the main lever.

## Suggested protocol

JSON-RPC over WebSocket, resumable and idempotent:

```
runner.register   { runnerId, capabilities, targets, publicKey }
runner.heartbeat  { load, sessions, cost }
target.list       {}
target.provision   { kind, region, size, image, ttl }
session.create    { targetId, repo, baseRef, model, policy, placement }
session.attach    { sessionId, lastSeq }
session.event     { sessionId, seq, type, payload }   // append-only
session.checkpoint{ sessionId, label } -> { checkpointId, sha }
session.move      { sessionId, targetId, mode: cold|warm|live }
session.terminate { sessionId, keepVolume }
```

All payloads are E2E encrypted between client and runner; the relay forwards envelopes. Session events are the durable log; runner state is reconstructable.

## Phased plan

### Phase 1 — one runner, one relay, desktop + PWA (2-4 weeks)

- `omp-runner` executable/container with OMP, worktrees, PTY, checkpoints.
- Outbound relay with QR pairing and E2E encryption.
- Target registry: local + paired host + Docker/VPS.
- Cold session move: export/import bundle; stop at turn boundary.
- PWA with session list, chat, approvals, push notifications.
- Tailscale/Cloudflare Tunnel instructions as BYO.

### Phase 2 — cloud default (2-3 weeks)

- Sprites adapter: create computer, install runner, pair, suspend/resume, checkpoints, port forwarding.
- Onboarding: "Start a cloud computer" (Sprites) or "Connect a machine".
- Placement UI: target switcher, per-node defaults, "Move to…", cost meter, idle policy.
- Push notifications and mobile session cards.
- Agent host tools for listing/moving sessions within policy.

### Phase 3 — move anything, anywhere (3-5 weeks)

- E2B adapter for memory-preserving pause/resume; Modal for parallel forks.
- Warm moves on persistent volumes; live moves only on provider-supported snapshots.
- Tree-level placement policy: groups pinned to targets, budget/data-residency guards.
- Shared team targets and access control.

### Not in v1

- Building our own hypervisor or scheduler.
- Live migration between providers.
- Native mobile app before PWA proves the flow.
- Kubernetes or multi-region orchestration.
- Running cloud by default without a configured target or explicit consent.

## Key product decisions to make

1. **Managed relay vs BYO-only.** Managed relay is the only true zero-setup path; it costs infrastructure and requires trust. Recommendation: managed relay with E2E, plus BYO tunnels.
2. **Default cloud provider.** Sprites is the best fit for persistent agent computers; E2B is the best "pause everything including memory" API. Recommendation: Sprites first, E2B second.
3. **What "default cloud" means at onboarding.** Recommend: cloud default once a target is connected; otherwise local. Never silently upload code.
4. **Secrets in snapshots.** Never include raw secrets in session bundles; re-inject per target.
5. **Live migration scope.** Cold move at turn boundaries is enough for v1 and works across all providers.

## Sources

- OpenAI Codex Cloud environments: https://developers.openai.com/codex/environments/cloud-environments
- OpenAI Codex Cloud legacy environments (setup/agent phases, caching, proxy, secrets): https://developers.openai.com/codex/cloud/environments
- Simon Willison on Sprites: https://simonwillison.net/2026/Jan/9/sprites-dev/
- Fly Sprites: https://fly.io/sprites/ and https://docs.fly.io/sprites
- Fly "Run Claude Code from your phone with Sprites": https://fly.io/blog/how-sprites-accidentally-solved-mobile-development
- Fly "Code and let live" (persistent computers vs ephemeral sandboxes): https://fly.io/blog/code-and-let-live/
- E2B sandbox persistence: https://e2b.dev/docs/sandbox/persistence
- Modal sandbox snapshots: https://modal.com/docs/guide/sandbox-snapshots
- Cloudflare Containers: https://developers.cloudflare.com/containers/
- Vercel sandbox comparison: https://vercel.com/i/ai-sandbox-providers
- Firecracker snapshotting: https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md
- CRIU: https://criu.org/
- Simon Willison lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Happy remote client: https://github.com/slopus/happy
- T3 Code: https://github.com/pingdotgg/t3code
- Tailscale: https://tailscale.com/
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- pi-daemon (persistent Pi + PWA via Tailscale/Cloudflare Access): https://github.com/SASUKE40/pi-daemon
