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

# Scripts too. These were missed entirely on the first pass, which is why
# scripts/storage-doctor.mjs "did not exist" in the target repo despite being in
# this package. Same lesson as the source list: enumerate, do not hand-write.
mkdir -p "$TARGET/scripts"
SCRIPTS=0
for from in $(find "$HERE/scripts" -type f \( -name '*.mjs' -o -name '*.sh' \) 2>/dev/null | sort); do
  to="$TARGET/scripts/$(basename "$from")"
  copy "$from" "$to"
  chmod +x "$to" 2>/dev/null || true
  SCRIPTS=$((SCRIPTS + 1))
done
if [ "$SCRIPTS" -gt 0 ]; then
  echo ""
  echo "  $SCRIPTS script(s) installed into scripts/"
fi

if [ ! -f "$TARGET/.env.example" ]; then
  cp "$HERE/.env.example" "$TARGET/.env.example"
  echo "  installed .env.example (placeholders only)"
fi

# ---------------------------------------------------------------------------
# Dependency check.
#
# Copying a source file that imports a package the TARGET does not depend on
# produces "Cannot find module '…'" at deploy or run time — which reads as
# "the file you sent me is broken" rather than "run npm install". Same failure
# shape as the two omissions above, one layer out: the thing that is missing is
# invisible until something else tries to use it.
#
# Collect bare specifiers from the installed files and report any the target's
# package.json does not already list. Read-only: this never edits package.json
# or runs npm, because silently mutating someone's manifest is not install.sh's
# business.
# ---------------------------------------------------------------------------
NEEDED=$(grep -ho "from ['\"][^'\"]*['\"]" $(find "$HERE/src" -name '*.ts' -not -name '*.test.ts') 2>/dev/null \
  | sed "s/from ['\"]//; s/['\"]//" \
  | grep -v '^\.' \
  | grep -v '^node:' \
  | grep -v '^@trigger\.dev/' \
  | grep -v '^@/' \
  | sed 's|^\(@[^/]*/[^/]*\).*|\1|; s|^\([^@][^/]*\).*|\1|' \
  | sort -u)

MISSING=""
for pkg in $NEEDED; do
  if ! grep -q "\"$pkg\"" "$TARGET/package.json" 2>/dev/null; then
    MISSING="$MISSING $pkg"
  fi
done

if [ -n "$MISSING" ]; then
  echo ""
  echo "  ! these packages are imported by the files just installed but are NOT in"
  echo "    $TARGET/package.json. Without them the deploy fails with"
  echo "    \"Cannot find module\", which looks like broken code and is not:"
  echo ""
  echo "      npm install --save$MISSING"
  echo ""
else
  echo "  dependency check: every import is already in your package.json"
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
echo "  3. patches/storageSweeper.ts is a drop-in replacement for YOUR"
echo "     src/trigger/storageSweeper.ts, adding the dryRun flag. It is NOT"
echo "     copied automatically, because overwriting a file you wrote should be"
echo "     a deliberate act. When you want it:"
echo "       cp patches/storageSweeper.ts \"$TARGET/src/trigger/storageSweeper.ts\""
echo "     The scheduled task defaults to DRY RUN. Set STORAGE_SWEEP_DRY_RUN=false"
echo "     once you have seen a clean dry run."
echo ""
echo "  4. Set RUNPOD_API_KEY and RUNPOD_ENDPOINT_ID in Trigger.dev under"
echo "     Project Settings > Environment Variables for the target environment."
echo "     Not in any file in the repo."
echo ""
echo "Then, from YOUR repo root:"
echo "  npm run build"
echo "  npx trigger.dev@3.3.17 deploy --config=\"./trigger.config.ts\" --skip-update-check"
echo ""
