#!/bin/sh
# Build the OMP runner template on an E2B Embed host.
# Run from an OMP Studio checkout after `eval "$(docker compose exec ready cat /run/e2b/sdk.env)"`
# inside the E2B Embed directory.
set -eu

: "${E2B_API_KEY:?run: eval \"$(docker compose exec ready cat /run/e2b/sdk.env)\"}"
: "${E2B_API_URL:?missing E2B_API_URL from sdk.env}"
: "${E2B_DOMAIN:?missing E2B_DOMAIN from sdk.env}"

npx -y @e2b/cli template create omp-runner \
  -p . \
  -d runner/Dockerfile \
  -c "/app/runner/entrypoint.sh" \
  --memory-mb 2048 \
  --cpu-count 2
