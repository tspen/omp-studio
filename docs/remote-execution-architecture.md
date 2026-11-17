# Remote, mobile and cloud execution architecture

Date: 2026-11-17

Status: **design only**. Nothing here is implemented in the app yet; there is no runner, relay, PWA, Sprites/E2B/Daytona dependency or remote execution code in `src/`. The only committed artifacts are this document and `docs/remote-phase1-spec.md`.

Goal: one execution model for OMP Studio where a session can run locally, on a spare VPS, on a home machine, or in a cloud sandbox; the user can reach it from the desktop app or phone anywhere; agents and the tree can move work between places; and the default is cloud.

## Recommendation in one sentence

Build **one OMP Runner**, register every place it can run as a **target**, move sessions as **portable bundles at turn boundaries**, and reach runners only through **networks the user controls** (Tailscale, a self-hosted relay, or a Cloudflare Tunnel with Access). Make a **user-owned cloud target** (their VPS, or self-hosted E2B Embed) the default cloud; Sprites is an optional convenience adapter, never required and never in the traffic path. No OMP-hosted relay or compute sees prompts, code or transcripts.

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

## Open-source and trust status

| Option | Open source? | Who runs it | Fit with "no exposure" |
| --- | --- | --- | --- |
| **OMP Runner (ours)** | Yes, by definition | You, on your PC/VPS | Best. This is the thing to build. |
| **Docker/VPS + Tailscale** | Yes | You | Best default "cloud" target. |
| **E2B Embed** | Apache-2.0, `e2b-dev/runtime`, Docker Compose / one Linux host, no account or license key | You | Good open-source self-hosted sandbox; heavier than plain Docker. |
| **E2B Cloud** | Runtime OSS, managed service proprietary | E2B | Opt-in only; code leaves your machine. |
| **Firecracker / CRIU** | OSS (AWS / community) | You | Building blocks, not a product. |
| **Fly Sprites** | **No.** Proprietary Fly.io managed service. Client SDKs (`@fly/sprites`, Go/TS/Elixir) are OSS, but the platform/orchestration is not. Fly announced an open-source local version at launch; it has not shipped. | Fly.io | **Not the default.** Convenience adapter only. |
| **Daytona** | Was AGPL-3.0; production core went closed-source June 2026. Community fork `Nightona` continues the last open release v0.190.0. | You / community | Possible, but churny. |
| **Cloudflare Containers** | Proprietary managed service; Workers runtime tooling is OSS | Cloudflare | Opt-in for Sites/preview only. |

**Are we using Sprites?** No. No source file references it and no dependency is installed. It appears only as a proposed optional adapter in these design documents.

**Does Sprites "just work"?** For a human with a Fly account, surprisingly close: `curl https://sprites.dev/install.sh | bash`, `sprite login`, `sprite create`, preinstalled Claude/Codex/Gemini, persistent disk, ~300 ms disk checkpoints, port forwarding, and a Tailscale-based mobile PWA. For OMP Studio it does **not** just work yet: we still need a runner image, OMP auth, git/secrets, pairing, relay/PWA, and a provider adapter. It also requires a Fly account/billing and puts code on a third-party VM, which conflicts with "I don't want to open myself up to anything".

**Plain English: Sprites vs E2B.** Sprites is a persistent cloud computer: it sleeps when idle, the disk survives, and you checkpoint the whole disk. E2B is a freeze button for a running sandbox: pause saves memory and running processes, resume brings them back. Sprites feels like a dev machine; E2B feels like pausing a program mid-execution. For coding agents a dev machine is usually the better fit.

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

### 4. Reachability: zero setup, no public exposure

**Locked decision:** no OMP-hosted relay, no public inbound ports, no third-party plaintext. Every path is a network the user controls.

**A. Tailscale (default)**

- Embed `tsnet` in the runner or install Tailscale next to it.
- App/phone joins the user's tailnet; `tailscale serve` provides an HTTPS PWA.
- No public exposure at all; access is enforced by tailnet ACLs.
- The runner still dials out, so no port forwarding or dynamic DNS.
- Cost: Tailscale install on each device; not quite zero-setup on iPhone, but closest to zero-trust.

**B. Self-hosted relay**

- A tiny relay the user runs on their own VPS (or on the same machine as the runner).
- Runner opens an outbound WebSocket to it; phone/desktop pair with QR code.
- End-to-end encryption means the relay never sees code, prompts or transcripts.
- No inbound ports on the runner; only the relay has a reachable endpoint, protected by device keys.
- This is the zero-app-store path for a phone, with no third-party service.

**C. Cloudflare Tunnel + Access**

- `cloudflared` connects outbound; Access enforces exact-email/SSO.
- Needs a Cloudflare account/domain (or a quick tunnel for testing).
- Best for a stable public hostname and team access.

Recommendation: **A for privacy, B for phone convenience, C for teams**. Never require port forwarding, and never ship a managed OMP relay. PWA push metadata never contains prompt or code content.

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

## FAQ: sessions on PCs and phone

**Can I see my sessions from another PC or on my phone?** Yes, in the design. Every paired device shows the same session list, status, last output and pending approvals because the session registry and append-only event log are shared. The transcript/code itself stays on the runner that owns the session; your phone streams it over the E2E channel instead of holding a copy.

**What about many PCs?** Each PC is a target. Sessions running on a laptop that is asleep/offline show as `offline` until it wakes; they are not visible as live streams. That is exactly why the default should be an always-on user-owned target (VPS/home server/cloud VM), not the laptop you close. A cold move can relocate an offline session to an always-on target once the source is reachable again.

**Do I have to pick a place for each agent?** No. Placement is automatic: a policy plus the orchestrator choose the target from defaults, budget and data-residency constraints. You set the default once; routine worker placement is invisible. You can still use "Move to…" manually.

**Can the agent move itself?** Yes, through `runtime_list` / `session_move` host tools, subject to policy. Moves that spend money or change data residency require consent.

**Is this implemented today?** No. It is a design. The current app is local Windows only.

## Phased plan

### Phase 1 — one runner, one relay, desktop + PWA (2-4 weeks)

- `omp-runner` executable/container with OMP, worktrees, PTY, checkpoints.
- Outbound-only connectivity through Tailscale, a self-hosted relay, or Cloudflare Tunnel + Access. No managed OMP relay.
- Device pairing with QR/device code; E2E encryption; push metadata only.
- Target registry: local + paired host + Docker/VPS.
- Cold session move: export/import bundle; stop at turn boundary.
- PWA with session list, chat, approvals, push notifications.
- Automatic placement policy; no per-session placement dialog.

### Phase 2 - user-owned cloud default (2-3 weeks)

- Self-hosted cloud target: Docker Compose / E2B Embed on a VPS, with Tailscale or a self-hosted relay.
- Onboarding: "Connect a machine" (VPS/home PC) first. Cloud becomes the default only after that target is paired and consent is given; the target stays user-owned.
- Placement UI: target switcher, per-node defaults, "Move to…", cost meter, idle policy. Placement decisions themselves are automatic.
- Push notifications and mobile session cards.
- Sprites adapter as a later **optional plugin**, not part of the default path.
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
- A managed OMP relay or OMP-hosted compute in the traffic path.

## Decisions (2026-11-17)

1. **No exposure.** No managed relay, no public inbound ports, no OMP-hosted compute in the traffic path. Use Tailscale, a self-hosted relay, or Cloudflare Tunnel + Access. E2E encryption regardless of transport. Cloud default applies only to a target the user explicitly pairs; code is never uploaded silently.
2. **Sprites vs E2B.** Sprites = a persistent cloud computer with a sleeping disk and whole-disk checkpoints; proprietary Fly.io service, not open source. E2B = freeze/resume of a running sandbox including RAM and processes; runtime and Embed are Apache-2.0. Because "no exposure" wins, **user-owned Docker/VPS or self-hosted E2B Embed is the default cloud target**. Sprites is an optional convenience adapter, never required.
3. **Seamless placement.** No "which session goes to cloud?" dialog per worker. A placement policy plus the orchestrator choose automatically; the user sets defaults, budget and data-residency constraints once. Agents can request a move through host tools, but routine placement is invisible.
4. **No live migration.** Cold move at turn boundaries is enough for v1. No scheduler, hypervisor or CRIU/Firecracker live-move work until there is a real multi-user reason for it.

## Remaining product defaults

1. **Tailscale vs self-hosted relay vs both.** Recommend both, Tailscale first.
2. **Default cloud provider.** A user-owned cloud target first: Docker/VPS runner or self-hosted E2B Embed. Sprites is a later opt-in convenience adapter only.
3. **What "default cloud" means at onboarding.** Cloud default once a user-owned target is paired; otherwise local. Never silently upload code.
4. **Secrets in snapshots.** Never include raw secrets in session bundles; re-inject per target.
5. **Live migration scope.** Explicitly out of v1.

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
- E2B open source and self-hosting: https://github.com/e2b-dev/E2B , https://e2b.dev/open-source , https://e2b.dev/docs/self-hosting
- E2B Embed (Apache-2.0, one-machine self-host): https://e2b.dev/resources/introducing-e2b-embed
- Fly Sprites SDK (client only, platform proprietary): https://www.npmjs.com/package/@fly/sprites
- Fly Sprites open-source local version announcement/status: https://www.devclass.com/ai-ml/2026/01/13/flyio-introduces-sprites-lightweight-persistent-vms-to-isolate-agentic-ai/4079557
- Daytona open-source history and Nightona fork: https://github.com/OpenSystemsLab/daytona , https://github.com/nightona-co/nightona
- Simon Willison lethal trifecta: https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/
- Happy remote client: https://github.com/slopus/happy
- T3 Code: https://github.com/pingdotgg/t3code
- Tailscale: https://tailscale.com/
- Cloudflare Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/
- pi-daemon (persistent Pi + PWA via Tailscale/Cloudflare Access): https://github.com/SASUKE40/pi-daemon
