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

copy() {
  from="$1"
  to="$2"
  if [ -f "$to" ]; then
    # Backups go OUTSIDE the target tree. A .bak file left next to a .ts inside
    # a trigger dir would be harmless, but anything the CLI's glob can match
    # (*.js, *.mjs, *.cjs) becomes a second entry point and breaks the build
    # with "Two output files share the same path". Keeping backups out of the
    # tree entirely removes the question.
    mkdir -p "$BACKUP_DIR/$(dirname "${to#$TARGET/}")"
    cp "$to" "$BACKUP_DIR/${to#$TARGET/}"
    echo "  backed up existing ${to#$TARGET/} -> $BACKUP_DIR/${to#$TARGET/}"
  fi
  cp "$from" "$to"
  echo "  installed ${to#$TARGET/}"
}

# Walk src/ rather than listing files by hand.
#
# The hand-written list silently went stale once already: configDoctor.ts and
# envReport.ts were added to this package after install.sh was written, so they
# were never copied, and the config-doctor task simply did not exist in the
# target repo even though it had been deployed. Enumerating the directory means
# a new source file cannot be forgotten.
BACKUP_DIR="$TARGET/.runpod-install-backup"
INSTALLED=0

for from in $(find "$HERE/src" -name '*.ts' -not -name '*.test.ts' | sort); do
  rel=${from#$HERE/}
  to="$TARGET/$rel"
  mkdir -p "$(dirname "$to")"
  copy "$from" "$to"
  INSTALLED=$((INSTALLED + 1))
done

if [ "$INSTALLED" -eq 0 ]; then
  echo "error: found no .ts files under $HERE/src — is this a complete clone?" >&2
  exit 1
fi
echo ""
echo "  $INSTALLED source file(s) installed"

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
