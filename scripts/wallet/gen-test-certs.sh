#!/usr/bin/env bash
# Generates a THROWAWAY Pass Type ID certificate chain for local testing.
#
# This is not, and can never be, a substitute for the real Apple-issued
# certificate: iOS pins the chain to Apple's WWDR root, so a pass signed with
# these keys will be rejected on a device. That is fine and expected. What this
# chain proves is the half of the pipeline that lives in our code — that the zip
# is well-formed, that manifest.json hashes every file, that `signature` is a
# valid detached PKCS#7 over that manifest, and that a verifier walking the
# chain accepts it. Swapping in Apple's real leaf changes nothing structural.
#
# Everything lands in .wallet-test/certs, which is gitignored. The repo is
# public; no key ever goes near a commit.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="$ROOT/.wallet-test/certs"
mkdir -p "$OUT"

# Stand-in for Apple's WWDR intermediate. Self-signed here because there is no
# authority above it in a local chain; in production this file is Apple's.
if [ ! -f "$OUT/wwdr.pem" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$OUT/wwdr.key" -out "$OUT/wwdr.pem" \
    -subj "/C=US/O=Test Worldwide Developer Relations/CN=Test WWDR CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi

# The leaf: what Apple issues as "Pass Type ID Certificate". Two details are
# copied from a real one because a strict verifier looks for them —
# 1.2.840.113635.100.6.1.16 is Apple's Pass Type ID extension OID, and the UID
# component of the subject carries the pass type identifier.
PASS_TYPE_ID="${PASS_TYPE_ID:-pass.com.mixandgreet.test}"
TEAM_ID="${PASS_TEAM_ID:-TESTTEAM99}"

cat > "$OUT/leaf.cnf" <<EOF
[req]
distinguished_name=dn
prompt=no
[dn]
UID=$PASS_TYPE_ID
CN=Pass Type ID: $PASS_TYPE_ID
OU=$TEAM_ID
O=Mix and Greet Test
C=US
[ext]
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=emailProtection
1.2.840.113635.100.6.1.16=DER:0500
EOF

openssl req -new -newkey rsa:2048 -nodes \
  -keyout "$OUT/pass.key" -out "$OUT/pass.csr" \
  -config "$OUT/leaf.cnf" 2>/dev/null

openssl x509 -req -in "$OUT/pass.csr" \
  -CA "$OUT/wwdr.pem" -CAkey "$OUT/wwdr.key" -CAcreateserial \
  -out "$OUT/pass.pem" -days 825 \
  -extfile "$OUT/leaf.cnf" -extensions ext 2>/dev/null

# The builder reads these base64-encoded, because the Convex CLI cannot carry a
# multi-line PEM through an argv slot. Same shape locally as in production, so
# the harness exercises the same decode path.
b64() { openssl base64 -A -in "$1"; }
cat > "$OUT/env.sh" <<EOF
export PASS_TYPE_ID='$PASS_TYPE_ID'
export PASS_TEAM_ID='$TEAM_ID'
export PASS_CERT_B64='$(b64 "$OUT/pass.pem")'
export PASS_KEY_B64='$(b64 "$OUT/pass.key")'
export PASS_WWDR_B64='$(b64 "$OUT/wwdr.pem")'
EOF

echo "test chain written to $OUT"
openssl verify -CAfile "$OUT/wwdr.pem" "$OUT/pass.pem"
