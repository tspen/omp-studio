# Self-hosted OMP runner (Docker / VPS)

One command, no public ports, no managed relay. The runner is the same app with
the Remote server bound to the container.

## Quick start

```bash
docker compose -f runner/docker-compose.yml up -d --build
docker compose -f runner/docker-compose.yml logs runner | grep "pairing link"
```

The log prints:

```
OMP Remote listening on 0.0.0.0:43120
OMP Remote pairing link: http://127.0.0.1:43120/#t=<token>
```

Open that link from a device on the same private network, or put Tailscale in
front of it:

```bash
tailscale serve --bg 43120            # HTTPS on your tailnet, no inbound port
docker compose -f runner/docker-compose.yml logs runner | grep "pairing link"
```

Replace `127.0.0.1` with the machine's Tailscale name in the link, or scan the QR
from Settings → Remote on the desktop app.

## Model and provider credentials

A runner cannot run turns until the OMP engine has a provider. Either pass the
provider key into the container or persist an OMP login in the data volume:

```bash
# Environment key (example: Anthropic)
ANTHROPIC_API_KEY=sk-ant-... docker compose -f runner/docker-compose.yml up -d

# Or log in once; HOME points at the persistent /data volume
docker compose -f runner/docker-compose.yml exec runner \
  /data/omp-studio/engine/omp
```

The engine is downloaded into `/data/omp-studio/engine/omp` on first use. Until a
provider is configured, placed sessions show `Starting OMP...` and cannot
execute turns.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OMP_RUNNER_BIND` | `127.0.0.1` | Host interface for the published port. Keep loopback and use Tailscale. |
| `OMP_RUNNER_PORT` | `43120` | Host port. |
| `OMP_REMOTE_TOKEN` | generated | Fixed pairing token. Set it once and reuse it on every device. |
| `OMP_REMOTE_HOST` | `0.0.0.0` | Bind address inside the container. |
| `OMP_STUDIO_USER_DATA` | `/data` | Persistent volume path. |

Generate a stable token before the first start:

```bash
OMP_REMOTE_TOKEN=$(openssl rand -hex 24) docker compose -f runner/docker-compose.yml up -d
```

## Cleanup

Everything the runner creates inside `/data` is garbage-collected by the app at
startup and every five minutes. Preview or run a sweep manually:

```bash
docker compose -f runner/docker-compose.yml exec runner \
  node out/runner/cli/runner.js gc --dry-run
```

Stop the container but keep sessions:

```bash
docker compose -f runner/docker-compose.yml down
```

Remove the runner and its volume completely:

```bash
docker compose -f runner/docker-compose.yml down -v
docker image rm omp-runner:local
```

Only the labeled `omp-runner` container/volume and the `omp-runner:local` image
are touched. No global `docker system prune`.

## Notes

- The image installs Node, Electron, git, Python and build tools; OMP itself is
  downloaded on first use into the data volume (or bake `vendor/omp`).
- Terminals are optional in the Linux image. If the native `node-pty` build is
  unavailable, the rest of the runner still starts and reports terminals as
  unavailable instead of crashing.
- The container is stateless except for the `omp-data` volume.
