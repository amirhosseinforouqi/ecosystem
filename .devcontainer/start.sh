#!/usr/bin/env bash
# Runs every time the codespace/container starts: launches the server in the
# background if it isn't already running. Idempotent, so re-attaching a
# running codespace never double-starts it.
set -e
cd "$(dirname "$0")/.."

# Inside a Codespace, port 3000 is reachable at a *-3000.app.github.dev host,
# not localhost — point activation/reset links there so they actually work
# when clicked from outside the container.
if [ -n "$CODESPACE_NAME" ]; then
  export APP_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi

if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then
  echo "Mortgage platform is already running at http://localhost:3000"
  exit 0
fi

nohup npm start > /tmp/mortgage-platform.log 2>&1 &
disown

for i in $(seq 1 20); do
  sleep 0.5
  if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then
    echo "Mortgage platform is running. Logs: /tmp/mortgage-platform.log"
    exit 0
  fi
done

echo "Server did not come up in time — check /tmp/mortgage-platform.log"
