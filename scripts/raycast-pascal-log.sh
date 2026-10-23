#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Pascal Log
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 📝
# @raycast.argument1 { "type": "text", "placeholder": "What to log..." }
# @raycast.packageName Pascal

# Documentation:
# @raycast.description Send text to Pascal for ingestion, opens draft in browser
# @raycast.author peatiscoding

PASCAL_URL="${PASCAL_URL:-http://tiny.hippo-caiman.ts.net:7600}"
PASCAL_WEB="${PASCAL_WEB:-http://tiny.hippo-caiman.ts.net:7601}"

response=$(curl -s -w "\n%{http_code}" -X POST "$PASCAL_URL/api/ingest/text" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$1\", \"source\": \"raycast\"}")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "202" ]; then
  queue_id=$(echo "$body" | grep -o '"queue_id":[0-9]*' | cut -d: -f2)
  open "$PASCAL_WEB/#draft/$queue_id"
  echo "Queued (#$queue_id)"
else
  echo "Error: $body"
fi
