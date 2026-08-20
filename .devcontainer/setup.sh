#!/usr/bin/env bash
# Runs once when the codespace/container is first created.
#
# Generates the secrets this container needs (they are per-container and never
# committed), applies the schema, and seeds the demo dataset.
set -euo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".devcontainer/.env.local"

npm ci --no-audit --no-fund

if [ ! -f "$ENV_FILE" ]; then
  echo "Generating local secrets → $ENV_FILE"
  KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')"
  ADMIN_PW="Setup-$(node -e 'process.stdout.write(require("node:crypto").randomBytes(9).toString("base64url"))')"
  cat > "$ENV_FILE" <<EOF
# Generated for this container only. Never commit this file.
export DATABASE_URL="\${DATABASE_URL:-postgres://mortgage:mortgage@db:5432/mortgage}"
export PGSSLMODE=disable
export DOCUMENT_ENCRYPTION_KEYS="v1:${KEY}"
export DOCUMENT_ENCRYPTION_ACTIVE_KEY=v1
export MALWARE_SCAN_MODE=disabled
export EMAIL_TRANSPORT=log
export ADMIN_EMAIL=admin@example.com
export ADMIN_PASSWORD="${ADMIN_PW}"
EOF
  chmod 600 "$ENV_FILE"
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

npm run migrate
npm run seed:demo
