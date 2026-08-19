#!/usr/bin/env bash
# Runs once when the codespace/container is first created: seeds demo data
# so there's something to look at immediately (skips silently if data
# already exists — e.g. a rebuilt container that kept its volume).
set -e
cd "$(dirname "$0")/.."

export ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
export ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin1234}"

npm run seed:demo
