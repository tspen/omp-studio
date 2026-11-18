# Self-hosted Perch runner (Docker / VPS)

Run Perch on a VPS, spare PC or home server. The runner is the same app with the
Remote server bound inside the container. Pi is bundled; there is no separate
engine download.

## Quick start

```bash
docker compose -f runner/docker-compose.yml up -d --build
docker compose -f runner/docker-compose.yml logs runner | grep "pairing link"
```

The log prints:

```text
Perch Remote listening on 0.0.0.0:43120
Perch Remote pairing link: http://127.0.0.1:43120/#t=<token>
```

Paste that link into Perch → Settings → Remote → More options → Add another
machine, or open it on a phone on the same network. Replace `127.0.0.1` with the
machine's address before pasting from another host.

## Model and provider credentials

The runner needs a Pi provider before it can execute turns. Pass a provider key
into the environment, or store one in the persistent volume.

```bash
# Example: OpenCode Go
OPENCODE_API_KEY=... docker compose -f runner/docker-compose.yml up -d

# Example: Anthropic
ANTHROPIC_API_KEY=sk-ant-... docker compose -f runner/docker-compose.yml up -d
```

The compose file forwards `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `OPENCODE_API_KEY`, `DEEPSEEK_API_KEY`
and `XAI_API_KEY`. Pi stores credentials under `/data/pi-agent/auth.json` when
configured interactively.

Until a provider is configured, placed sessions show `Starting Pi...` and cannot
execute turns.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PERCH_RUNNER_BIND` | `127.0.0.1` | Host interface for the published port. Keep loopback and use Tailscale, or publish deliberately. |
| `PERCH_RUNNER_PORT` | `43120` | Host port. |
| `PERCH_REMOTE_TOKEN` | generated | Fixed pairing token. Set it once and reuse it on every device. |
| `PERCH_REMOTE_HOST` | `0.0.0.0` | Bind address inside the container. |
| `PERCH_USER_DATA` | `/data` | Persistent data directory. |

Generate a stable token before the first start:

```bash
PERCH_REMOTE_TOKEN=$(openssl rand -hex 24) docker compose -f runner/docker-compose.yml up -d
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
docker image rm perch-runner:local
```

Only the labeled `perch-runner` container/volume and the `perch-runner:local`
image are touched. No global `docker system prune`.

## Notes

- The image installs Node, Electron, git, Python and build tools. Pi ships in the
  image as `@earendil-works/pi-coding-agent`; no engine is downloaded at runtime.
- Terminals are optional in the Linux image. If the native `node-pty` build is
  unavailable, the rest of the runner still starts and reports terminals as
  unavailable instead of crashing.
- The container is stateless except for the `perch-data` volume.
