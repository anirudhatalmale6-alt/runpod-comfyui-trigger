#!/usr/bin/env bash
#
# install.sh — copy this integration INTO your Trigger.dev project.
#
#   bash install.sh /path/to/your/repo
#
# This repository is a source package, NOT a deployable Trigger.dev project.
# Deploying a clone of it directly will fail: there is no trigger.config.ts at
# its root, no tsconfig.json, and @trigger.dev/sdk is not a dependency here.
# The two source files belong in YOUR repo, alongside your existing tasks.

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "usage: bash install.sh /path/to/your/repo" >&2
  exit 1
fi
if [ ! -d "$TARGET" ]; then
  echo "error: $TARGET is not a directory" >&2
  exit 1
fi

HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=$(cd "$TARGET" && pwd)

if [ ! -f "$TARGET/package.json" ]; then
  echo "error: $TARGET has no package.json — that does not look like your repo root" >&2
  exit 1
fi

echo "Installing into: $TARGET"
echo ""

mkdir -p "$TARGET/src/utils" "$TARGET/src/trigger"

copy() {
  local from="$1" to="$2"
  if [ -f "$to" ]; then
    cp "$to" "$to.bak-$(date +%s)"
    echo "  backed up existing $(basename "$to") -> $(basename "$to").bak-*"
  fi
  cp "$from" "$to"
  echo "  installed $(basename "$to")"
}

copy "$HERE/src/utils/runpodClient.ts"        "$TARGET/src/utils/runpodClient.ts"
copy "$HERE/src/trigger/revenueGateRouter.ts" "$TARGET/src/trigger/revenueGateRouter.ts"

if [ ! -f "$TARGET/.env.example" ]; then
  cp "$HERE/.env.example" "$TARGET/.env.example"
  echo "  installed .env.example (placeholders only)"
fi

echo ""
echo "Still to do by hand — install.sh will not touch these:"
echo ""
echo "  1. package.json has no \"scripts\" block, so \`npm run build\` fails with"
echo "     'Missing script: build'. Merge config/package.scripts.json into it."
echo ""
echo "  2. trigger.config.ts: raise maxDuration above your polling deadline."
echo "     config/trigger.config.ts has a working version — put YOUR real"
echo "     project ref back in place of proj_YOUR_PROJECT_REF before using it."
echo ""
echo "  3. Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID in Trigger.dev under"
echo "     Project Settings > Environment Variables for the target environment."
echo "     Not in any file in the repo."
echo ""
echo "Then, from YOUR repo root:"
echo "  npm run build"
echo "  npx trigger.dev@3.3.17 deploy --config=\"./trigger.config.ts\" --skip-update-check"
echo ""
