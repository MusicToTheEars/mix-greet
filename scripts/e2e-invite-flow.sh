#!/usr/bin/env bash
# Run the invite-flow end-to-end test against a throwaway Convex deployment.
#
#   scripts/e2e-invite-flow.sh
#
# It brings up an anonymous LOCAL Convex backend in a temp directory, pushes
# this repo's convex/ into it, seeds nothing but its own fixtures, runs
# scripts/e2e-invite-flow.mjs against it, and tears the whole thing down. No
# Convex login, no deploy key, and no way to reach production: the deployment
# is created by `CONVEX_AGENT_MODE=anonymous`, which never talks to the cloud.
#
#   E2E_KEEP=1   leave the deployment up and print its URLs (for poking at it)
#
# Requires Node 20, 22 or 24 somewhere on the machine. The local backend
# refuses to run "use node" actions (the Wallet pass and the QR renderer) on
# anything else. The repo's own npm install is not reused because node_modules
# inside Dropbox is a known source of phantom I/O errors.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- a Node the local backend will accept ------------------------------------
node_major() { "$1" -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/'; }
NODE_BIN=""
for candidate in \
  "$(command -v node || true)" \
  /opt/homebrew/opt/node@22/bin/node \
  /opt/homebrew/opt/node@20/bin/node \
  /usr/local/opt/node@22/bin/node \
  "$HOME/.nvm/versions/node/v22"*/bin/node \
  "$HOME/.nvm/versions/node/v20"*/bin/node
do
  [ -x "$candidate" ] || continue
  case "$(node_major "$candidate")" in
    20|22|24) NODE_BIN="$candidate"; break ;;
  esac
done
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: need Node 20, 22 or 24 for Convex 'use node' actions." >&2
  echo "       brew install node@22   (or nvm install 22), then re-run." >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "node: $(node -v) ($NODE_BIN)"

# --- a scratch copy of the backend, outside Dropbox --------------------------
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/mixgreet-e2e.XXXXXX")"
CONVEX_PID=""
cleanup() {
  local code=$?
  if [ -n "$CONVEX_PID" ] && kill -0 "$CONVEX_PID" 2>/dev/null; then
    kill "$CONVEX_PID" 2>/dev/null || true
    wait "$CONVEX_PID" 2>/dev/null || true
  fi
  if [ "${E2E_KEEP:-}" = "1" ]; then
    echo "kept: $WORKDIR"
  else
    rm -rf "$WORKDIR"
  fi
  exit $code
}
trap cleanup EXIT INT TERM

cp "$REPO/package.json" "$WORKDIR/"
mkdir -p "$WORKDIR/convex"
# _generated is rebuilt by the push; copying a stale one only confuses tsc.
(cd "$REPO" && tar cf - --exclude _generated convex) | (cd "$WORKDIR" && tar xf -)

# No --legacy-peer-deps and no copied lockfile: both have silently pruned
# convex-helpers here, which the Resend component's workpool imports, and the
# push then fails to bundle with an error that looks nothing like the cause.
echo "installing backend deps in $WORKDIR"
(cd "$WORKDIR" && npm install --no-audit --no-fund >/dev/null 2>&1) || {
  echo "ERROR: npm install failed in $WORKDIR" >&2
  (cd "$WORKDIR" && npm install --no-audit --no-fund 2>&1 | tail -20) >&2
  exit 1
}

# --- bring the deployment up --------------------------------------------------
echo "starting a local Convex deployment (anonymous, no login, no cloud)"
(
  cd "$WORKDIR"
  CONVEX_AGENT_MODE=anonymous npx convex dev --typecheck disable --tail-logs disable
) >"$WORKDIR/convex-dev.log" 2>&1 &
CONVEX_PID=$!

for _ in $(seq 1 90); do
  [ -f "$WORKDIR/.env.local" ] && grep -q CONVEX_SITE_URL "$WORKDIR/.env.local" && break
  kill -0 "$CONVEX_PID" 2>/dev/null || { echo "convex dev exited early:"; cat "$WORKDIR/convex-dev.log"; exit 1; }
  sleep 1
done
SITE_URL="$(grep '^CONVEX_SITE_URL=' "$WORKDIR/.env.local" | cut -d= -f2- | tr -d '"')"
if [ -z "$SITE_URL" ]; then
  echo "ERROR: the deployment never reported an HTTP actions URL." >&2
  cat "$WORKDIR/convex-dev.log" >&2
  exit 1
fi

if ! curl -sf --retry 60 --retry-delay 1 --retry-all-errors --retry-connrefused \
     -o /dev/null "$SITE_URL/api/events"; then
  echo "ERROR: $SITE_URL/api/events never answered." >&2
  tail -40 "$WORKDIR/convex-dev.log" >&2
  exit 1
fi
echo "deployment ready at $SITE_URL"

# --- the secrets the flow needs (fixtures, never real ones) -------------------
ADMIN_PASSWORD="e2e-door-pass"
(
  cd "$WORKDIR"
  npx convex env set UNSUB_SECRET "e2e-fixture-secret-not-for-production" >/dev/null
  npx convex env set ADMIN_PASSWORD "$ADMIN_PASSWORD" >/dev/null
  npx convex env set SITE_ORIGIN "http://127.0.0.1:8888" >/dev/null
  npx convex env set INVITE_ORIGIN "http://127.0.0.1:8888" >/dev/null
)

# --- the test -----------------------------------------------------------------
# E2E_MODULE_BASE is where the test resolves its QR decoders from: the scratch
# install, so the repo itself never needs node_modules to run this.
echo
API="$SITE_URL" ADMIN_PASSWORD="$ADMIN_PASSWORD" E2E_MODULE_BASE="$WORKDIR" \
  node "$REPO/scripts/e2e-invite-flow.mjs"
