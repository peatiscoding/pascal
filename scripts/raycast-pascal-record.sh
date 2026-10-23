#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Pascal Record
# @raycast.mode compact

# Optional parameters:
# @raycast.icon 📋
# @raycast.argument1 { "type": "text", "placeholder": "Title" }
# @raycast.argument2 { "type": "text", "placeholder": "Scope (e.g. Personal|Finance)", "optional": true }
# @raycast.packageName Pascal

# Documentation:
# @raycast.description Create a structured record in Pascal
# @raycast.author peatiscoding

PASCAL_URL="${PASCAL_URL:-http://tiny.hippo-caiman.ts.net:7600}"

title="$1"
scope="${2:-Uncategorized}"

response=$(curl -s -w "\n%{http_code}" -X POST "$PASCAL_URL/api/ingest/record" \
  -H "Content-Type: application/json" \
  -d "{\"tl\": \"$title\", \"sc\": \"$scope\", \"st\": 1, \"tags\": [], \"values\": []}")

http_code=$(echo "$response" | tail -1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" = "201" ]; then
  echo "Recorded: $title"
else
  echo "Error: $body"
fi
