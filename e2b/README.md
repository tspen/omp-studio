# E2B Embed target

This target runs the OMP runner inside a Firecracker microVM on a KVM host you
own, using the open-source E2B Runtime (Apache-2.0). No E2B account is required.

## Host requirements

- Linux x86-64/arm64 with `/dev/kvm`, `/dev/net/tun`, cgroup v2 and a 4 KiB-page
  kernel; **kernel 6.8 or newer**, Ubuntu 24.04 recommended.
- Docker Engine 27+ with Compose 2.24+.
- 12 GiB RAM and 20 GiB free disk recommended. Small hosts can lower
  `HUGEPAGES` and `PF_MIN_FREE_GIB` in the Embed `.env`, but one runner sandbox
  needs at least 1 GiB of guest memory.

WSL2 is **not supported** by E2B Embed: its default kernel is 5.15 and cgroup v2
is not mounted, so `preflight` refuses to start. Use a real Linux host (or a
cloud VM with nested virtualization enabled).

## Install E2B Embed (on the KVM host)

```bash
mkdir e2b && cd e2b
curl -fsSL --remote-name-all "https://raw.githubusercontent.com/e2b-dev/runtime/main/embed/compose/{compose.yaml,.env}"
# small host only:
#   echo HUGEPAGES=768 >> .env
#   echo PF_MIN_FREE_GIB=1 >> .env
docker compose up -d --wait
eval "$(docker compose exec ready cat /run/e2b/sdk.env)"
```

The stack prints `E2B_API_KEY`, `E2B_API_URL` and `E2B_DOMAIN`. Keep it private:
bind the dashboard/API/client-proxy to loopback and reach it over Tailscale or a
TLS proxy. The orchestrator control port must stay unreachable.

## Build the runner template

From an OMP Studio checkout on the same host (the Dockerfile builds the same
headless runner used by `runner/`):

```bash
export E2B_API_KEY=...        # from sdk.env
export E2B_API_URL=...        # usually http://127.0.0.1:3000
export E2B_DOMAIN=...         # usually localhost
npx -y @e2b/cli template create omp-runner \
  -p . -d runner/Dockerfile \
  -c "/app/runner/entrypoint.sh" \
  --memory-mb 2048 --cpu-count 2
```

Wait for the build to finish. The template runs the runner on port `43120`,
with `OMP_HEADLESS=1` and no inbound host port.

## Create a target in OMP Studio

Settings → Remote → **E2B Embed target**:

| Field | Value |
| --- | --- |
| API URL | `E2B_API_URL` (`http://127.0.0.1:3000` for a local stack) |
| Domain | `E2B_DOMAIN` (`localhost` locally, the Tailscale/TLS host remotely) |
| Template | `omp-runner` |
| API key | `E2B_API_KEY` |
| Timeout | sandbox lifetime in minutes |

Press **Create sandbox target**. The app creates a sandbox, passes a per-sandbox
`OMP_REMOTE_TOKEN`, waits for the runner health check through the sandbox port,
and registers the target. Sessions can then be placed or moved to it with the
normal cold/warm path.

**Terminate** kills the sandbox and removes the target. `docker compose down -v`
in the E2B directory removes its databases/seed state; the optional
`host-teardown` profile removes host config, hugepages and the MSS rule.

## Notes

- The target is a full runner, not a thin command sandbox: the adapter expects
  the `omp-runner` template to expose `/api/health` on port 43120.
- Sandbox timeout is enforced by E2B. A target whose sandbox expired shows
  offline; remove it and create a new one.
- E2B Embed is single-machine by design. No managed relay or account is in the
  path.
- The API key is stored with Electron `safeStorage`, never in settings JSON.
