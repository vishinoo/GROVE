#!/bin/bash
#
# Makes the local certificate build.sh signs Grove with, once per Mac.
# Self-signed and only ever used here: it exists so the app's signature is the
# same from one build to the next, which is what keeps its permissions.

set -euo pipefail
if security find-identity -p codesigning 2>/dev/null | grep -q "Grove Local Signing"; then
  echo "Already there."; exit 0
fi
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
cat > "$tmp/cert.cnf" <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Grove Local Signing
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
CNF
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/key.pem" -out "$tmp/cert.pem" -days 3650 -config "$tmp/cert.cnf"
openssl pkcs12 -export -legacy -inkey "$tmp/key.pem" -in "$tmp/cert.pem" -out "$tmp/grove.p12" -passout pass:grove
security import "$tmp/grove.p12" -k ~/Library/Keychains/login.keychain-db -P grove -T /usr/bin/codesign
echo "Made Grove Local Signing."
