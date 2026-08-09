#!/usr/bin/env bash
# Deploy the Mix & Greet Convex backend to production (good-labrador-980).
# Cloud-portable: reads the Production Deploy Key from 1Password (or the env),
# so it runs from any device without relying on a local `convex login`.
#
# Usage:
#   scripts/deploy.sh                 # reads key from 1Password at $CONVEX_DEPLOY_KEY_OP
#   CONVEX_DEPLOY_KEY=prod:... scripts/deploy.sh   # or pass the key directly via env
#
# Prereqs: Node 22 (nvm use 22), npm install already run.
set -euo pipefail

cd "$(dirname "$0")/.."

# 1Password reference for the client's Convex Production Deploy Key.
# Override by exporting CONVEX_DEPLOY_KEY_OP.
: "${CONVEX_DEPLOY_KEY_OP:=op://Security/cvo457rdrh6e5e6wu6j4kizqai/Convex Deploy Key}"

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  if command -v op >/dev/null 2>&1; then
    echo "Reading Convex deploy key from 1Password: ${CONVEX_DEPLOY_KEY_OP}"
    CONVEX_DEPLOY_KEY="$(op read "${CONVEX_DEPLOY_KEY_OP}")"
  fi
fi

if [ -z "${CONVEX_DEPLOY_KEY:-}" ]; then
  echo "ERROR: no CONVEX_DEPLOY_KEY. Generate a Production Deploy Key in the Convex"
  echo "dashboard (Project Settings > Deploy Keys), store it at ${CONVEX_DEPLOY_KEY_OP}"
  echo "in 1Password, or export CONVEX_DEPLOY_KEY before running this script." >&2
  exit 1
fi

export CONVEX_DEPLOY_KEY
echo "Deploying Convex functions + schema to production..."
npx convex deploy --yes

echo "Done. HTTP Actions URL: https://good-labrador-980.convex.site"
