#!/usr/bin/env bash
# Generates a self-signed CA and per-party certs for local development.
# Usage: bash certs/generate_certs.sh
# Requires: openssl

set -euo pipefail
cd "$(dirname "$0")"

DAYS=365
PARTIES=(party_0 party_1 party_2)

# CA
openssl req -x509 -newkey rsa:4096 -days "$DAYS" -nodes \
  -keyout ca.key -out ca.pem \
  -subj "/CN=MPC-CA"

# Per-party cert signed by the CA
for name in "${PARTIES[@]}"; do
  openssl req -newkey rsa:2048 -nodes \
    -keyout "${name}.key" -out "${name}.csr" \
    -subj "/CN=${name}"
  openssl x509 -req -in "${name}.csr" -CA ca.pem -CAkey ca.key \
    -CAcreateserial -out "${name}.pem" -days "$DAYS"
  rm "${name}.csr"
  echo "Generated ${name}.pem / ${name}.key"
done

echo "CA written to ca.pem"
