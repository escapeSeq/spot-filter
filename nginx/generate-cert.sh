#!/bin/sh
set -e

apk add --no-cache openssl > /dev/null 2>&1

CERT_DIR=/etc/nginx/certs

if [ ! -f "$CERT_DIR/selfsigned.crt" ]; then
  echo "Generating self-signed certificate..."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout "$CERT_DIR/selfsigned.key" \
    -out "$CERT_DIR/selfsigned.crt" \
    -subj "/CN=localhost"
  echo "Certificate generated."
fi

exec nginx -g 'daemon off;'
