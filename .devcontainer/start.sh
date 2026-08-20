#!/usr/bin/env bash
# Runs every time the codespace/container starts: launches the server in the
# background if it isn't already running. Idempotent, so re-attaching a
# running codespace never double-starts it.
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".devcontainer/.env.local"
if [ ! -f "$ENV_FILE" ]; then
  echo "$ENV_FILE is missing — container setup did not finish."
  echo "Run: bash .devcontainer/setup.sh"
  exit 1
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

# Inside a Codespace, port 3000 is reachable at a *-3000.app.github.dev host,
# not localhost — point activation/reset links there so they actually work
# when clicked from outside the container.
if [ -n "${CODESPACE_NAME:-}" ]; then
  export APP_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-app.github.dev}"
fi

if curl -sf http://127.0.0.1:3000/health > /dev/null 2>&1; then
  echo "Mortgage platform is already running at http://localhost:3000"
  exit 0
fi

# Detach into a new session, not just the background.
#
# postStartCommand's process tree is cleaned up when the command returns, and
# a plain "&" leaves the server in that tree — so it starts, reports healthy,
# and is then killed the moment this script exits. The symptom is a forwarded
# port with no running process behind it and a log that claims success.
# setsid moves it out of that tree entirely.
LOG=/tmp/mortgage-platform.log
if command -v setsid > /dev/null 2>&1; then
  setsid nohup npm start > "$LOG" 2>&1 < /dev/null &
else
  nohup npm start > "$LOG" 2>&1 < /dev/null &
fi
disown 2>/dev/null || true

for _ in $(seq 1 60); do
  sleep 0.5
  if curl -sf http://127.0.0.1:3000/ready > /dev/null 2>&1; then
    # Confirm it is still up a moment later. A server that answers once and
    # then disappears is the failure this whole block exists to catch.
    sleep 2
    if ! curl -sf http://127.0.0.1:3000/ready > /dev/null 2>&1; then
      echo "The server started and then exited. Its log:"
      tail -30 "$LOG"
      exit 1
    fi
    echo "----------------------------------------------------------"
    echo "Mortgage platform is running on port 3000."
    echo "  Broker portal:  /broker"
    echo "  Client portal:  /portal"
    echo "  Email:    ${ADMIN_EMAIL}"
    echo "  Password: ${ADMIN_PASSWORD}"
    echo ""
    echo "  Administrators need a two-step code. No phone required here:"
    echo "    npm run code        # prints the current 6-digit code"
    echo ""
    echo "Logs: $LOG   ·   Diagnose: npm run doctor"
    echo "----------------------------------------------------------"
    exit 0
  fi
done

# Never leave the operator staring at a 502 with no explanation.
echo "----------------------------------------------------------"
echo "The server did not come up. The last lines of its log:"
echo "----------------------------------------------------------"
tail -30 "$LOG"
echo "----------------------------------------------------------"
echo "Fix the cause above, then run: bash .devcontainer/start.sh"
exit 1
