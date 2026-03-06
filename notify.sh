#!/bin/bash
set -eu

HOST="${HOST:-http://localhost:3000}"
[[ "$HOST" =~ ^https?:// ]] || HOST="http://$HOST"

if [ $# -lt 2 ]; then
  echo "Usage: $0 <device-id> <message>"
  exit 1
fi

device_id="$1"
message="$2"

curl -X POST "$HOST/notify" \
  -H "Content-Type: application/json" \
  -d "{\"deviceId\":\"$device_id\",\"message\":\"$message\"}"
