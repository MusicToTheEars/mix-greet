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
# Two ways in, and the difference is only how the backend binary is obtained.
#
# `convex dev --typecheck enable` is deliberate in both, and is why this step can
# take a minute: it runs tsc over the whole convex/ tree against freshly
# generated types. Nothing else in this repo typechecks the backend,
# convex/_generated is gitignored, and a push with types disabled will happily
# ship a function whose response shape no longer matches what the routes
# destructure. If tsc fails, so does this script, before a single assertion runs.
#
# ANONYMOUS (the default, and what a laptop uses): `CONVEX_AGENT_MODE=anonymous`
# lets the CLI pick and download the backend itself. It needs
# version.convex.dev, which is a plain version-lookup service.
#
# SELF-HOSTED (the fallback): on a sandboxed or firewalled machine
# version.convex.dev is often unreachable, and the CLI's anonymous path has no
# way to fall back to an already-downloaded binary — it fails at the lookup and
# never gets as far as the cache. So if a backend binary is present, this script
# runs it directly and drives it through Convex's own self-hosted mode. Same
# binary, same push, same typecheck; only the discovery step differs. Still no
# login, no deploy key, and nothing but 127.0.0.1 on the wire.
#
#   E2E_BACKEND_BIN=/path/to/convex-local-backend   use this binary explicitly
#
# Otherwise the newest binary already in the Convex CLI's own cache is used.
find_backend_bin() {
  if [ -n "${E2E_BACKEND_BIN:-}" ]; then
    [ -x "$E2E_BACKEND_BIN" ] && { echo "$E2E_BACKEND_BIN"; return; }
    echo "ERROR: E2E_BACKEND_BIN=$E2E_BACKEND_BIN is not executable." >&2
    exit 1
  fi
  local cache="${XDG_CACHE_HOME:-$HOME/.cache}/convex/binaries"
  [ -d "$cache" ] || return 0
  ls -1d "$cache"/*/ 2>/dev/null | sort | while read -r d; do
    [ -x "$d/convex-local-backend" ] && echo "$d/convex-local-backend"
  done | tail -1
}
BACKEND_BIN="$(find_backend_bin || true)"

ADMIN_PASSWORD="e2e-door-pass"

if [ -n "$BACKEND_BIN" ]; then
  # --- self-hosted: run the binary we already have ----------------------------
  echo "starting a local Convex backend (self-hosted, no login, no cloud)"
  echo "  binary: $BACKEND_BIN"
  INSTANCE="mixgreet-e2e"
  # Not a secret: this backend is bound to 127.0.0.1, lives in a temp directory
  # for the length of one test run, and is deleted with it. It is fixed rather
  # than random so a kept deployment (E2E_KEEP=1) can be poked at afterwards.
  INSTANCE_SECRET="$(printf '4%.0s' $(seq 1 64))"
  ADMIN_KEY="$("$BACKEND_BIN" keygen admin-key \
    --instance-name "$INSTANCE" --instance-secret "$INSTANCE_SECRET" | tail -1)"

  # --port 0 is not supported, so a free pair is picked up front.
  CLOUD_PORT="$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
  SITE_PORT="$(node -e 'const n=require("net"),s=n.createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"

  (
    cd "$WORKDIR"
    "$BACKEND_BIN" \
      --port "$CLOUD_PORT" --site-proxy-port "$SITE_PORT" \
      --interface 127.0.0.1 \
      --instance-name "$INSTANCE" --instance-secret "$INSTANCE_SECRET" \
      --do-not-require-ssl \
      --local-storage "$WORKDIR/storage" \
      "$WORKDIR/db.sqlite3"
  ) >"$WORKDIR/convex-dev.log" 2>&1 &
  CONVEX_PID=$!

  CLOUD_URL="http://127.0.0.1:$CLOUD_PORT"
  SITE_URL="http://127.0.0.1:$SITE_PORT"
  export CONVEX_SELF_HOSTED_URL="$CLOUD_URL"
  export CONVEX_SELF_HOSTED_ADMIN_KEY="$ADMIN_KEY"

  for _ in $(seq 1 90); do
    curl -sf -o /dev/null "$CLOUD_URL/version" && break
    kill -0 "$CONVEX_PID" 2>/dev/null || { echo "backend exited early:"; cat "$WORKDIR/convex-dev.log"; exit 1; }
    sleep 1
  done

  # The push is a separate, foreground step here: unlike `convex dev`, which
  # watches, this returns when the functions are live, so a failed typecheck
  # stops the script with its own output instead of being buried in a log.
  echo "pushing convex/ (typecheck enabled)"
  ( cd "$WORKDIR" && npx convex dev --once --typecheck enable ) || {
    echo "ERROR: the push failed — see the typecheck output above." >&2
    exit 1
  }
else
  # --- anonymous: let the CLI fetch and manage the backend --------------------
  echo "starting a local Convex deployment (anonymous, no login, no cloud)"
  (
    cd "$WORKDIR"
    CONVEX_AGENT_MODE=anonymous npx convex dev --typecheck enable --tail-logs disable
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
fi

if ! curl -sf --retry 60 --retry-delay 1 --retry-all-errors --retry-connrefused \
     -o /dev/null "$SITE_URL/api/events"; then
  echo "ERROR: $SITE_URL/api/events never answered." >&2
  tail -40 "$WORKDIR/convex-dev.log" >&2
  exit 1
fi
echo "deployment ready at $SITE_URL"

# --- the secrets the flow needs (fixtures, never real ones) -------------------
(
  cd "$WORKDIR"
  npx convex env set UNSUB_SECRET "e2e-fixture-secret-not-for-production" >/dev/null
  npx convex env set ADMIN_PASSWORD "$ADMIN_PASSWORD" >/dev/null
  npx convex env set SITE_ORIGIN "http://127.0.0.1:8888" >/dev/null
  npx convex env set INVITE_ORIGIN "http://127.0.0.1:8888" >/dev/null
  # The public routes are rate limited per caller, and every case in this suite
  # is the same caller — one loopback address with no x-forwarded-for, so all of
  # them share a single bucket. Production budgets would run out partway through
  # and the suite would start reporting 429s as flow failures. Raised here, and
  # the limiter itself is proved by its own case, which sets its route's budget
  # down to two and drives a real 429 out of the real middleware.
  npx convex env set RATE_LIMIT_RSVP "100000,100000" >/dev/null
  npx convex env set RATE_LIMIT_PASS "100000,100000" >/dev/null
  npx convex env set RATE_LIMIT_QR "100000,100000" >/dev/null
)

# The limiter case needs to change a budget mid-run, so it needs the CLI and the
# directory the deployment's admin key lives in. Exported rather than hardcoded
# in the test so the test stays a plain HTTP client with one exception.
export E2E_CONVEX_DIR="$WORKDIR"

# --- the test -----------------------------------------------------------------
# E2E_MODULE_BASE is where the test resolves its QR decoders from: the scratch
# install, so the repo itself never needs node_modules to run this.
echo
API="$SITE_URL" ADMIN_PASSWORD="$ADMIN_PASSWORD" E2E_MODULE_BASE="$WORKDIR" \
  E2E_CONVEX_DIR="$WORKDIR" \
  node "$REPO/scripts/e2e-invite-flow.mjs"
