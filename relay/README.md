# Self-hosted encrypted relay

The relay lets a phone reach a runner without opening a port on the runner and
without a managed relay in the traffic path. The runner dials out; the phone
connects to the relay; the relay forwards **AES-256-GCM ciphertext** only.

## Quick start

```bash
npm run build:mobile
docker build -f relay/Dockerfile -t omp-relay .
docker run --rm --name omp-relay -p 127.0.0.1:43150:43150 omp-relay
```

or:

```bash
docker compose -f relay/docker-compose.yml up -d --build
```

Open the relay PWA at `http://127.0.0.1:43150`. In OMP Studio → Settings → Remote
→ **Self-hosted relay**, set the relay URL and save. The app generates a room,
room token and E2E secret, connects outbound, and prints a QR/link.

On the phone, scan the QR or open the link. The PWA stores the room, token and
E2E key in the URL fragment, then talks only through encrypted frames.

## Tailscale / TLS

The relay binds loopback by default. Keep it private:

```bash
tailscale serve --bg 43150
```

or put it behind a TLS reverse proxy you control. Never expose it directly to
the public internet. Web Push requires HTTPS in production; use the relay's
Tailscale/HTTPS URL for notifications.

## Security model

- **E2E encryption.** Frames are AES-256-GCM encrypted with a key derived via
  HKDF-SHA256 from the pairing secret. The relay never receives the secret or
  plaintext.
- **Room authentication.** The runner registers a room with a SHA-256 hash of
  the room token. Clients must present the same token; wrong token → 403,
  unknown room → 404, wrong role → 400.
- **No storage.** The relay keeps rooms, sockets and counters in memory only.
  It writes nothing to disk. Restarting it drops every room.
- **Limits.** 32 MB max frame, 8 clients per room, room reaped 5 minutes after
  the runner and clients disconnect.
- **Metadata.** The relay sees room IDs, client IDs, frame sizes, timing,
  connection counts and the room auth token used to join. It does not see the
  E2E secret, prompts, files, the runner API token or responses.
- **No inbound runner port.** The runner is a WebSocket client.
- **Availability trust.** Frames are confidentiality/integrity protected, but a
  malicious relay could drop or replay old ciphertext (request IDs prevent
  response mixups). Treat the relay as trusted for availability, not for
  confidentiality.
- **Cleanup.** Stop the container; no volumes are created. `docker compose -f
  relay/docker-compose.yml down` removes everything the relay owns.

## Runner environment

For a headless runner, pass the same values instead of using the desktop UI:

```bash
OMP_RELAY_URL=https://relay.tailnet-name.ts.net \
OMP_RELAY_ROOM=my-room \
OMP_RELAY_TOKEN=... \
OMP_RELAY_SECRET=... \
docker compose -f runner/docker-compose.yml up -d
```

`OMP_RELAY_URL` enables the relay client even when the saved desktop setting is
off.

## Verification

```bash
# relay health
curl http://127.0.0.1:43150/health

# wrong token is rejected
# ws://127.0.0.1:43150/ws?role=client&room=test-room&token=wrong -> HTTP 403
```

With `RELAY_DEBUG_FRAMES=1`, the relay logs frame sizes and ciphertext prefixes
only; use it to confirm no plaintext is present, then leave it off.
