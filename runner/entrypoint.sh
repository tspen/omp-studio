#!/bin/sh
set -e
cd /app
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp -ac &
export DISPLAY=:99
# Give the X server a moment before the first client connects.
sleep 1
exec node_modules/electron/dist/electron . --no-sandbox --disable-gpu --disable-dev-shm-usage
