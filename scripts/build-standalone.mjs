#!/usr/bin/env node
/**
 * Bundle the publishing pipeline into ONE file with no new dependencies.
 *
 * Why this exists: installing the pipeline properly means cloning a repo,
 * running install.sh, adding an npm dependency and then deploying. That is four
 * places for something to go wrong on someone else's machine, and it did.
 *
 * The standalone build is one file to drop into src/trigger/ and deploy.
 * Nothing to clone, nothing to install. It needs only what the project already
 * has: @trigger.dev/sdk, @aws-sdk/client-s3, and the repo's own storageClient
 * and env modules. (@aws-sdk/s3-request-presigner is NOT needed — that is used
 * only by contentDelivery.ts, which is the Fanvue purchase path, not this one.)
 *
 * GENERATED, never hand-edited. It is built from the same sources the test
 * suite runs against, so the two cannot drift: edit src/, re-run this.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

/** Order matters: each file may only depend on ones already above it. */
const MODULES = [
  "src/utils/contentRouting.ts",
  "src/utils/envReport.ts",
  "src/utils/captionGenerator.ts",
  "src/utils/publishScheduler.ts",
  "src/utils/blueskyClient.ts",
  "src/utils/telegramClient.ts",
  "src/utils/metaClient.ts",
  "src/utils/tiktokClient.ts",
  "src/utils/redditClient.ts",
  "src/utils/publishDoctor.ts",
  "src/trigger/publishPipeline.ts",
  // Rides along in the SAME file rather than becoming a second thing to paste.
  // Trigger.dev discovers every exported task in a file, so one paste gives the
  // client publish-one, publish-planner, copy-asset AND publish-doctor.
  "src/trigger/publishDoctorTask.ts",
];

/**
 * Modules that are NOT inlined and whose imports must therefore survive.
 *
 * Matched by SPECIFIER, and the import statements themselves are collected from
 * the sources rather than written out here. The previous version hard-coded the
 * full import lines; the moment a source file added CopyObjectCommand to its
 * @aws-sdk/client-s3 import, the bundler stripped the real statement and
 * re-added the stale one, producing a file that referenced three commands it
 * had never imported.
 *
 * That is the THIRD time a hand-written list in this package has gone quietly
 * stale (install.sh's file list, then its scripts list). Deriving beats listing.
 */
const EXTERNAL = [
  "@aws-sdk/client-s3",
  "@aws-sdk/s3-request-presigner",
  "@trigger.dev/sdk/v3",
  "../utils/storageClient.js",
  "../utils/env.js",
];

const sections = [];
/** Relative specifiers that were stripped, to be checked against MODULES. */
const stripped_specifiers = new Set();
/**
 * Bindings for non-inlined modules, collected PER SPECIFIER and merged.
 *
 * This used to dedupe whole import statements by exact text, which worked only
 * while exactly one source file imported any given external module. The moment
 * a second task file imported @trigger.dev/sdk/v3 with a different set of
 * bindings, both statements survived — and since they share `logger` and `task`
 * the bundle became a duplicate-declaration SyntaxError that would have failed
 * on deploy, not here.
 *
 * So: union the bindings and emit one statement per specifier. Type-only
 * imports are kept separate from value imports rather than folded together,
 * because `verbatimModuleSyntax` makes that distinction load-bearing.
 */
const externalImports = new Map();

function recordExternalImport(specifier, isTypeOnly, bindingText) {
  if (!externalImports.has(specifier)) {
    externalImports.set(specifier, { value: new Set(), type: new Set() });
  }
  const entry = externalImports.get(specifier);
  const target = isTypeOnly ? entry.type : entry.value;
  for (const binding of bindingText.split(",")) {
    const trimmed = binding.trim();
    // A trailing comma in the source leaves an empty segment.
    if (trimmed !== "") target.add(trimmed);
  }
}

function renderExternalImports() {
  const lines = [];
  for (const [specifier, { value, type }] of externalImports) {
    if (value.size > 0) {
      lines.push(`import { ${[...value].join(", ")} } from "${specifier}";`);
    }
    if (type.size > 0) {
      lines.push(`import type { ${[...type].join(", ")} } from "${specifier}";`);
    }
  }
  return lines;
}

for (const relative of MODULES) {
  const source = readFileSync(join(root, relative), "utf8");

  // Drop every import of a module that is being inlined. Matches both single
  // line and multi-line forms. Anything in KEEP is re-added at the top instead.
  const stripped = source.replace(
    /^import\s+(type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["'];\s*$/gm,
    (match, typeKeyword, bindings, specifier) => {
      if (EXTERNAL.includes(specifier)) {
        // Bindings are taken from what the source actually imports today, then
        // merged across files so one specifier yields one statement.
        recordExternalImport(specifier, Boolean(typeKeyword), bindings);
      } else if (specifier.startsWith(".")) {
        stripped_specifiers.add(specifier);
      }
      return "";
    },
  );

  sections.push(
    `// ${"=".repeat(74)}\n` +
      `// ${relative}\n` +
      `// ${"=".repeat(74)}\n\n` +
      stripped.trim(),
  );
}

const header = `/**
 * PUBLISHING PIPELINE — standalone build.
 *
 * Drop this single file into src/trigger/ and deploy. Nothing to clone,
 * nothing to npm install: it uses only @trigger.dev/sdk and
 * @aws-sdk/client-s3, which this project already has, plus your own
 * utils/storageClient and utils/env.
 *
 * It registers two tasks:
 *
 *   publish-planner   hourly cron. Lists new renders in Tigris, routes them
 *                     through the safety rail, assigns staggered slots inside
 *                     your posting window, and queues one delayed job each.
 *
 *   publish-one       wakes at its slot, re-checks the rail, and publishes.
 *                     Bluesky and Telegram are live; the other lanes abort
 *                     with a clear message until their adapters exist.
 *
 * Environment variables it reads (Trigger.dev > Environment Variables, and
 * remember they are PER ENVIRONMENT):
 *
 *   TIGRIS_BUCKET_NAME
 *   BLUESKY_HANDLE, BLUESKY_APP_PASSWORD
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_CHAT_ID
 *
 * DO NOT EDIT THIS FILE. It is generated from src/ by
 * scripts/build-standalone.mjs, and it is the same code the 185-test suite
 * runs against. Edit the sources and rebuild, or the two will drift.
 */

${renderExternalImports().sort().join("\n")}
`;

let output = `${header}\n${sections.join("\n\n")}\n`;

// Collapse identical top-level type aliases.
//
// `export type Fetcher = typeof fetch;` is declared in BOTH the Bluesky and
// Telegram adapters. Separate modules, no problem; inlined into one file it is
// TS2300 Duplicate identifier. Found by typechecking the bundle in the client's
// own tsconfig, not by reading it.
//
// Exact duplicates collapse to the first. Two declarations that SHARE A NAME
// but differ in body are a real conflict and fail the build, because silently
// keeping one would change behaviour depending on file order.
{
  const seen = new Map();
  const conflicts = [];
  const lines = output.split("\n");
  const kept = [];
  for (const line of lines) {
    const match = /^export type (\w+) = (.+);$/.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    const [, name, body] = match;
    if (!seen.has(name)) {
      seen.set(name, body);
      kept.push(line);
    } else if (seen.get(name) !== body) {
      conflicts.push(`${name}: "${seen.get(name)}" vs "${body}"`);
      kept.push(line);
    }
    // exact duplicate: drop silently, it is the same declaration
  }
  if (conflicts.length > 0) {
    console.error(
      `BUILD FAILED — same type name, different definitions:\n  ${conflicts.join("\n  ")}\n` +
        `Rename one at the source; collapsing these would make behaviour depend on file order.`,
    );
    process.exit(1);
  }
  output = kept.join("\n");
}

mkdirSync(join(root, "standalone"), { recursive: true });
const target = join(root, "standalone", "publishPipeline.standalone.ts");
writeFileSync(target, output);

// EVERY stripped relative import must correspond to a module that was inlined.
//
// Without this, adding a new file to src/ and forgetting to list it in MODULES
// produces a bundle where its import is removed and its functions are simply
// undefined at runtime — no build error, no missing import to spot, just a
// crash on the first call in production. That happened the moment
// captionGenerator.ts was added, and neither existing guard noticed.
{
  const inlined = new Set(
    MODULES.map((m) => m.split("/").pop().replace(/\.ts$/, "")),
  );
  const orphans = [...stripped_specifiers].filter((specifier) => {
    if (EXTERNAL.includes(specifier)) return false;
    const name = specifier.split("/").pop().replace(/\.(js|ts)$/, "");
    return !inlined.has(name);
  });
  if (orphans.length > 0) {
    console.error(
      `BUILD FAILED — these imports were stripped but never inlined:\n  ${orphans.join("\n  ")}\n` +
        `Add the module to MODULES (in dependency order) or to EXTERNAL. Leaving it out produces a ` +
        `bundle whose functions are undefined at runtime with no build error.`,
    );
    process.exit(1);
  }
}

// No two inlined modules may export the same top-level NAME.
//
// `Fetcher` collided as a type alias and was collapsed because both
// declarations were identical. `validateCaption` then collided as a FUNCTION,
// where telegramClient takes (caption) and metaClient took
// (caption, max, platform) — genuinely different behaviour behind one name.
// Collapsing that would silently pick whichever came last in MODULES order.
//
// So functions and consts are never collapsed: the build fails and the name is
// fixed at the source. Caught here rather than as a tsc error inside the
// client's project, which is where the previous one surfaced.
{
  const declarations = new Map();
  const collisions = [];
  // `export` is OPTIONAL in this pattern, and that is the fix for a real bug:
  // metaClient and redditClient each had a PRIVATE `requireVars` helper. Both
  // were invisible to an export-only check, both landed in one file, and the
  // bundle became "Identifier 'requireVars' has already been declared" — a
  // SyntaxError that every string-matching test in the suite passed straight
  // over, and which would have surfaced on the client's deploy. Module privacy
  // stops existing the moment two modules become one file.
  for (const match of output.matchAll(
    /^(?:export\s+)?(?:async\s+)?(?:function|const|class)\s+(\w+)/gm,
  )) {
    const name = match[1];
    declarations.set(name, (declarations.get(name) ?? 0) + 1);
  }
  for (const [name, count] of declarations) {
    if (count > 1) collisions.push(`${name} (declared ${count} times)`);
  }
  if (collisions.length > 0) {
    console.error(
      `BUILD FAILED — duplicate top-level declaration(s) across inlined modules:\n  ${collisions.join("\n  ")}\n` +
        `Rename one at the source. These are not collapsed automatically because a shared name ` +
        `with different behaviour would silently resolve to whichever module comes last.`,
    );
    process.exit(1);
  }
}

// Guards. A bundler that silently drops the safety rail would produce a file
// that deploys happily and publishes explicit content to six platforms.
const required = [
  "assertPublishAllowed",
  "BLOCKED: refusing to publish",
  "publish-planner",
  "publish-one",
  "idempotencyKey: post.idempotencyKey",
  "com.atproto.repo.createRecord",
  "sendPhoto",
];
const missing = required.filter((needle) => !output.includes(needle));
if (missing.length > 0) {
  console.error(`BUILD FAILED — these must survive bundling: ${missing.join(", ")}`);
  process.exit(1);
}

// No leftover relative import can remain, or the file will not resolve.
//
// Checked LINE BY LINE. The first version used [\s\S]*? across a multiline
// regex, which happily matched from the first import all the way down to the
// first relative one and reported three false failures. A guard that cries
// wolf gets disabled, so it is worth getting right.
// Checked by SPECIFIER rather than by matching the whole statement text. The
// statement-text version silently stopped working the moment imports began
// being merged, and reported every legitimate external as unresolved.
const unexpected = output
  .split("\n")
  .filter((line) => /^import\b/.test(line) && /from\s+["']\./.test(line))
  .filter((line) => {
    const specifier = /from\s+["']([^"']+)["']/.exec(line)?.[1];
    return specifier === undefined || !externalImports.has(specifier);
  });
if (unexpected.length > 0) {
  console.error(`BUILD FAILED — unresolved relative import(s):\n${unexpected.join("\n")}`);
  process.exit(1);
}

console.log(`built ${target}`);
console.log(`  ${output.split("\n").length} lines, ${MODULES.length} modules inlined`);
