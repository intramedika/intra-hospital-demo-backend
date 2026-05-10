#!/usr/bin/env bash
set -euo pipefail

TARGET_ENV="${1:-development}"   # development | preview | production
ENV_FILE="${2:-}"

# Auto-detect env file if not provided
if [ -z "$ENV_FILE" ]; then
  for f in .env .env.local .env.production .env.development; do
    if [ -f "$f" ]; then
      ENV_FILE="$f"
      break
    fi
  done
fi

if [ -z "${ENV_FILE}" ] || [ ! -f "$ENV_FILE" ]; then
  echo "❌ No env file found. Tried: .env .env.local .env.production .env.development"
  exit 1
fi

# Never upload these
BLOCKLIST_REGEX='^(VERCEL_OIDC_TOKEN|VERCEL_TOKEN|NODE_ENV)$'

echo "🚀 Uploading env from $ENV_FILE to Vercel ($TARGET_ENV)"
echo "---------------------------------------------"

while IFS= read -r line || [ -n "$line" ]; do
  [[ "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" =~ ^[[:space:]]*$ ]] && continue
  [[ "$line" != *"="* ]] && continue

  KEY="${line%%=*}"
  VALUE="${line#*=}"

  KEY="$(echo "$KEY" | xargs)"
  VALUE="$(echo "$VALUE" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
    -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"

  [ -z "$KEY" ] && continue

  if [[ "$KEY" =~ $BLOCKLIST_REGEX ]]; then
    echo "⏭️  Skipping (blocked): $KEY"
    continue
  fi

  echo "➕ Setting $KEY"

  # Non-interactive: pipe value to stdin, overwrite with --force
  # Works with Vercel CLI 49.x
  printf "%s" "$VALUE" | vercel env add "$KEY" "$TARGET_ENV" --force
done < "$ENV_FILE"

echo "✅ Done."
echo "Next:"
echo "  vercel --prod   # deploy production"
echo "  vercel          # deploy preview"

