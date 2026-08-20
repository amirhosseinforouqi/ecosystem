#!/usr/bin/env bash
# Runs once when the codespace/container is first created.
#
# Generates the secrets this container needs (they are per-container and never
# committed), applies the schema, and seeds the demo dataset.
#
# Deliberately does NOT abort the whole container when seeding fails: a failed
# postCreateCommand stops postStartCommand from ever running, so the operator
# gets a 502 and no explanation. A missing schema is fatal; missing demo data
# is not.
set -uo pipefail
cd "$(dirname "$0")/.."

ENV_FILE=".devcontainer/.env.local"

fail() { echo; echo "SETUP FAILED: $*"; echo; exit 1; }

echo "==> Installing dependencies"
npm ci --no-audit --no-fund || fail "npm ci failed."

if [ ! -f "$ENV_FILE" ]; then
  echo "==> Generating this container's secrets → $ENV_FILE"
  # Passwords come from the application's own generator so they are guaranteed
  # to satisfy the password policy. A plain random base64 string has no digit
  # about one time in eight, which the policy rejects.
  KEY="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64"))')" \
    || fail "Could not generate an encryption key."
  ADMIN_PW="$(node -e 'process.stdout.write(require("./server/auth").generateTemporaryPassword(4))')" \
    || fail "Could not generate an administrator password."
  # The bootstrap password is single-use: the account is created with
  # must_change_password, so the first sign-in replaces it. Decide that
  # replacement here, up front, rather than letting the seeder invent one the
  # operator is never told about.
  DEMO_PW="$(node -e 'process.stdout.write(require("./server/auth").generateTemporaryPassword(4))')" \
    || fail "Could not generate an administrator password."
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
export DEMO_ADMIN_PASSWORD="${DEMO_PW}"
EOF
  chmod 600 "$ENV_FILE"
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

echo "==> Waiting for PostgreSQL"
for _ in $(seq 1 60); do
  if node -e 'require("./server/db").healthCheck().then(()=>process.exit(0)).catch(()=>process.exit(1))' 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "==> Applying the schema"
npm run migrate || fail "Could not apply the schema. Is the database container running? Try: npm run migrate"

echo "==> Seeding demo data"
if npm run seed:demo; then
  echo "==> Demo data ready."
  # The first sign-in consumed the bootstrap password. Record the one that
  # actually works now, so every later message — start.sh, the terminal
  # banner, the operator reading the file — shows a password that signs in.
  if [ -n "${DEMO_ADMIN_PASSWORD:-}" ]; then
    node -e '
      const fs = require("node:fs");
      const file = process.argv[1];
      const text = fs.readFileSync(file, "utf8")
        .replace(/^export ADMIN_PASSWORD=.*$/m, `export ADMIN_PASSWORD="${process.env.DEMO_ADMIN_PASSWORD}"`)
        .replace(/^export DEMO_ADMIN_PASSWORD=.*\n/m, "");
      fs.writeFileSync(file, text, { mode: 0o600 });
    ' "$ENV_FILE" && source "$ENV_FILE"
  fi
else
  echo
  echo "WARNING: demo data could not be seeded. The application itself is fine —"
  echo "sign in with the credentials in $ENV_FILE and create a client by hand,"
  echo "or run 'npm run seed:demo' again to see the error."
  echo
fi

echo
echo "----------------------------------------------------------"
echo "Setup complete. Sign-in details:"
echo "  Email:    ${ADMIN_EMAIL}"
echo "  Password: ${ADMIN_PASSWORD}"
echo "(also in ${ENV_FILE})"
echo ""
echo "Two-step verification is required for administrators. You do NOT need a"
echo "phone to try the demo — this prints the current 6-digit code:"
echo "  npm run code"
echo ""
echo "The client portal has no second step, so for a quick look try one of the"
echo "demo clients instead (passwords printed by the seeder above)." 
echo "----------------------------------------------------------"
