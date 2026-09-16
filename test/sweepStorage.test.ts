/**
 * Tests the ACTUAL drop-in file, against a REAL S3 server.
 *
 * patches/storageSweeper.ts imports ../utils/storageClient.js and
 * ../utils/env.js, which live in the client's repo and not in this one. Rather
 * than keep a second copy of the logic here — which would drift from the file
 * actually shipped — the test rewrites only those two import lines into stubs
 * and imports the result. The functions under test are otherwise byte-for-byte
 * the file the client installs.
 *
 * Everything below runs against MinIO in a container, so a "dry run does not
 * delete" assertion means the object was genuinely still there afterwards, not
 * that a mock was never called.
 *
 * Skips itself with a clear message when no S3 server is reachable, rather than
 * passing silently.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const CREDS = { accessKeyId: 'rootuser', secretAccessKey: 'rootpass123' };
const HOT = 'sweep-hot';
const COLD = 'sweep-cold';

let available = false;
let sweepStorage: any;
let migrateObject: any;
let sweepDryRunFromEnv: any;
let tempDir: string | undefined;

const hot = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: CREDS });
const cold = new S3Client({ endpoint: ENDPOINT, region: 'us-east-1', forcePathStyle: true, credentials: CREDS });

/** Their uploadStream, reproduced exactly, so the injected dependency is real. */
async function uploadStream(options: any): Promise<void> {
  const upload = new Upload({
    client: options.client,
    params: {
      Bucket: options.bucket,
      Key: options.key,
      Body: options.body,
      ...(options.contentType ? { ContentType: options.contentType } : {}),
      ...(options.contentLength !== undefined ? { ContentLength: options.contentLength } : {}),
    },
    queueSize: options.queueSize ?? 2,
    partSize: options.partSize ?? 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await upload.done();
}

function deps() {
  return { hotClient: hot, coldClient: cold, hotBucket: HOT, coldBucket: COLD, upload: uploadStream };
}

async function ensureBucket(name: string) {
  try {
    await hot.send(new CreateBucketCommand({ Bucket: name }));
  } catch {
    /* already exists */
  }
}

async function emptyBucket(client: S3Client, bucket: string) {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  for (const item of listed.Contents ?? []) {
    if (item.Key) await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key }));
  }
}

async function put(bucket: string, key: string, body: string) {
  await hot.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: Buffer.from(body) }));
}

async function keysIn(client: S3Client, bucket: string): Promise<string[]> {
  const listed = await client.send(new ListObjectsV2Command({ Bucket: bucket }));
  return (listed.Contents ?? []).map((c) => c.Key!).sort();
}

before(async () => {
  // Load the REAL shipped file with only its two repo-local imports stubbed.
  const source = readFileSync(new URL('../patches/storageSweeper.ts', import.meta.url), 'utf8');
  const rewritten = source
    .replace(
      /import \{[^}]*\} from "\.\.\/utils\/storageClient\.js";/,
      'const backblazeClient: any = null; const tigrisClient: any = null; const uploadStream: any = null;',
    )
    .replace(/import \{ requireEnv \} from "\.\.\/utils\/env\.js";/, 'const requireEnv = (n: string) => n;')
    // The scheduled-task wiring is not what these tests exercise; stub the SDK
    // so the module loads without Trigger.dev installed here.
    .replace(
      /import \{ schedules, logger \} from "@trigger\.dev\/sdk\/v3";/,
      'const schedules: any = { task: (d: any) => d };\n' +
        'const __logs: any[] = [];\n' +
        'const logger: any = {\n' +
        '  warn(m: string, d?: any) { __logs.push({ level: "warn", message: m, data: d }); },\n' +
        '  info(m: string, d?: any) { __logs.push({ level: "info", message: m, data: d }); },\n' +
        '  error(m: string, d?: any) { __logs.push({ level: "error", message: m, data: d }); },\n' +
        '};',
    );

  assert.ok(!rewritten.includes('utils/storageClient.js'), 'storageClient import must be stubbed');
  assert.ok(!rewritten.includes('utils/env.js'), 'env import must be stubbed');
  assert.ok(!rewritten.includes('@trigger.dev/sdk/v3'), 'sdk import must be stubbed');
  // Everything that matters must have survived the rewrite.
  assert.ok(rewritten.includes('DeleteObjectCommand'), 'delete path must still be present');
  assert.ok(rewritten.includes('HeadObjectCommand'), 'size check must still be present');

  // Must live INSIDE the package so node_modules resolves from it.
  tempDir = join(fileURLToPath(new URL('.', import.meta.url)), '.generated');
  mkdirSync(tempDir, { recursive: true });
  const file = join(tempDir, 'storageSweeper.ts');
  // Expose the captured log lines so the diagnostic banner can be asserted on.
  // The banner is the thing that has twice turned an open-ended round-trip loop
  // into a single screenshot; leaving it untested is how it drifts.
  writeFileSync(file, rewritten + '\nexport const __capturedLogs = __logs;\n');

  const mod = await import(file);
  sweepStorage = mod.sweepStorage;
  migrateObject = mod.migrateObject;
  sweepDryRunFromEnv = mod.sweepDryRunFromEnv;

  try {
    await ensureBucket(HOT);
    await ensureBucket(COLD);
    await keysIn(hot, HOT);
    available = true;
  } catch {
    available = false;
  }
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function requireS3(t: { skip: (m?: string) => void }): boolean {
  if (!available) {
    t.skip(`no S3 at ${ENDPOINT} — start MinIO to run this properly`);
    return false;
  }
  return true;
}

// --- the flag itself, no network needed -------------------------------------

test('dry run is the default; only the exact string "false" disables it', async () => {
  assert.equal(sweepDryRunFromEnv({}), true, 'unset must be safe');
  assert.equal(sweepDryRunFromEnv({ STORAGE_SWEEP_DRY_RUN: '' }), true);
  assert.equal(sweepDryRunFromEnv({ STORAGE_SWEEP_DRY_RUN: 'true' }), true);
  assert.equal(sweepDryRunFromEnv({ STORAGE_SWEEP_DRY_RUN: 'no' }), true, 'a typo must not delete');
  assert.equal(sweepDryRunFromEnv({ STORAGE_SWEEP_DRY_RUN: '0' }), true, 'a typo must not delete');
  assert.equal(sweepDryRunFromEnv({ STORAGE_SWEEP_DRY_RUN: 'false' }), false);
  assert.equal(sweepDryRunFromEnv({ STORAGE_SWEEP_DRY_RUN: ' FALSE ' }), false, 'trimmed and case-insensitive');
});

// --- against a real S3 server ------------------------------------------------

test('DRY RUN copies to cold, verifies size, and leaves hot INTACT', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'a.txt', 'alpha');
  await put(HOT, 'b.txt', 'bravo');

  const result = await sweepStorage(deps(), { dryRun: true, minAgeDays: 0 });

  assert.equal(result.dryRun, true);
  assert.equal(result.scanned, 2);
  assert.equal(result.migrated, 2, 'both were copied and size-checked');
  assert.equal(result.deleted, 0, 'nothing may be deleted in a dry run');
  assert.deepEqual(result.failed, []);

  // The assertions that actually matter: real state on a real server.
  assert.deepEqual(await keysIn(hot, HOT), ['a.txt', 'b.txt'], 'HOT MUST STILL HAVE EVERYTHING');
  assert.deepEqual(await keysIn(cold, COLD), ['a.txt', 'b.txt'], 'cold received the copies');

  const head = await cold.send(new HeadObjectCommand({ Bucket: COLD, Key: 'a.txt' }));
  assert.equal(head.ContentLength, 5, 'content really landed, not a zero-byte placeholder');
});

test('a LIVE run copies and then deletes from hot', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'c.txt', 'charlie');

  const result = await sweepStorage(deps(), { dryRun: false, minAgeDays: 0 });

  assert.equal(result.dryRun, false);
  assert.equal(result.migrated, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(await keysIn(hot, HOT), [], 'hot is emptied on a live run');
  assert.deepEqual(await keysIn(cold, COLD), ['c.txt']);
});

// The two env readers are each covered on their own above. This pins the
// COMPOSITION of them -- i.e. the exact variable pair set in the Production
// environment -- because that pairing is what actually arms deletion, and
// "each half is tested" is not the same claim as "together they delete".
//
// STORAGE_SWEEP_MIN_AGE_DAYS=0 is the temporary override used to prove the
// delete path without waiting for an object to age past the 7-day default.
test('env pair STORAGE_SWEEP_DRY_RUN=false + MIN_AGE_DAYS=0 really deletes', async (t) => {
  if (!requireS3(t)) return;
  const { sweepMinAgeDaysFromEnv } = await import(join(tempDir!, 'storageSweeper.ts'));
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'fresh-render.jpeg', 'seven!!');

  const env = { STORAGE_SWEEP_DRY_RUN: 'false', STORAGE_SWEEP_MIN_AGE_DAYS: '0' };
  const dryRun = sweepDryRunFromEnv(env);
  const minAgeDays = sweepMinAgeDaysFromEnv(env);
  assert.equal(dryRun, false, 'this pair must arm deletion');
  assert.equal(minAgeDays, 0, 'a just-written object must be eligible');

  const result = await sweepStorage(deps(), { dryRun, minAgeDays });

  assert.equal(result.scanned, 1);
  assert.equal(result.skippedTooNew, 0, 'the age filter must not hold back a fresh object at 0');
  assert.equal(result.migrated, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(result.failed, []);
  // Server state, not the return value.
  assert.deepEqual(await keysIn(hot, HOT), [], 'hot really is empty on the server');
  assert.deepEqual(await keysIn(cold, COLD), ['fresh-render.jpeg'], 'the file really is in cold');
});

// ---------------------------------------------------------------------------
// patch 6: the dry-run flag diagnoses itself, and a failed sweep fails the RUN.
// ---------------------------------------------------------------------------

test('STORAGE_SWEEP_FAIL_ON_ERROR: only the exact string "false" keeps a broken run green', async () => {
  const { sweepFailOnErrorFromEnv } = await import(join(tempDir!, 'storageSweeper.ts'));
  assert.equal(sweepFailOnErrorFromEnv({}), true, 'unset must FAIL the run, so a silent breakage is impossible');
  assert.equal(sweepFailOnErrorFromEnv({ STORAGE_SWEEP_FAIL_ON_ERROR: '' }), true);
  assert.equal(sweepFailOnErrorFromEnv({ STORAGE_SWEEP_FAIL_ON_ERROR: 'true' }), true);
  assert.equal(sweepFailOnErrorFromEnv({ STORAGE_SWEEP_FAIL_ON_ERROR: 'nope' }), true, 'a typo must not silence it');
  assert.equal(sweepFailOnErrorFromEnv({ STORAGE_SWEEP_FAIL_ON_ERROR: 'false' }), false);
  assert.equal(sweepFailOnErrorFromEnv({ STORAGE_SWEEP_FAIL_ON_ERROR: ' FALSE ' }), false, 'trimmed, case-insensitive');
});

// The real-world case this exists for: the dashboard showed `false`, the run
// still reported DRY RUN, and nothing in the trace explained the contradiction.
// Every invisible cause is visible in the LENGTH.
test('the banner explains WHY a dry-run flag that looks right did not arm deletion', async () => {
  const mod: any = await import(join(tempDir!, 'storageSweeper.ts'));
  const logs = mod.__capturedLogs;

  const bannerFor = (value: string | undefined) => {
    logs.length = 0;
    const previous = process.env.STORAGE_SWEEP_DRY_RUN;
    if (value === undefined) delete process.env.STORAGE_SWEEP_DRY_RUN;
    else process.env.STORAGE_SWEEP_DRY_RUN = value;
    mod.logResolvedConfig();
    if (previous === undefined) delete process.env.STORAGE_SWEEP_DRY_RUN;
    else process.env.STORAGE_SWEEP_DRY_RUN = previous;
    const entry = logs.find((l: any) => l.message === 'Storage configuration in use');
    assert.ok(entry, 'the banner must always be logged');
    return entry.data;
  };

  const clean = bannerFor('false');
  assert.equal(clean.dryRun, false);
  assert.match(clean.STORAGE_SWEEP_DRY_RUN, /DELETION IS ARMED/);

  // Quotes survive a paste and are invisible in a dashboard text box.
  const quoted = bannerFor('"false"');
  assert.equal(quoted.dryRun, true, 'strictness is deliberate: a destructive flag is never guessed at');
  assert.match(quoted.STORAGE_SWEEP_DRY_RUN, /DRY RUN/);
  assert.match(quoted.STORAGE_SWEEP_DRY_RUN, /length 7/, 'the length is what gives the cause away');
  assert.match(quoted.STORAGE_SWEEP_DRY_RUN, /CONTAINS "false" but is not equal/);

  // Measured, not assumed. trim() is more capable than it looks: it DOES strip
  // U+00A0, U+FEFF and U+2007, so those must arm deletion rather than be flagged.
  // Written as escapes on purpose -- an invisible character in source is one
  // careless copy away from becoming an ordinary space.
  for (const [name, ch] of [['U+00A0', '\u00A0'], ['U+FEFF', '\uFEFF'], ['U+2007', '\u2007']] as const) {
    const trimmed = bannerFor('false' + ch);
    assert.equal(trimmed.dryRun, false, `trim() handles ${name}, so this must still arm deletion`);
    assert.match(trimmed.STORAGE_SWEEP_DRY_RUN, /DELETION IS ARMED/);
  }

  // A zero-width space is what actually survives trim().
  const zwsp = bannerFor('false\u200B');
  assert.equal(zwsp.dryRun, true, 'U+200B is not whitespace to trim()');
  assert.match(zwsp.STORAGE_SWEEP_DRY_RUN, /length 6/);

  const comma = bannerFor('false,');
  assert.equal(comma.dryRun, true);
  assert.match(comma.STORAGE_SWEEP_DRY_RUN, /length 6/);

  const unset = bannerFor(undefined);
  assert.equal(unset.dryRun, true);
  assert.match(unset.STORAGE_SWEEP_DRY_RUN, /not set/);

  // Ordinary whitespace IS trimmed, so this one must genuinely arm deletion.
  const padded = bannerFor('  FALSE\n');
  assert.equal(padded.dryRun, false, 'plain whitespace and case are handled, and must not be flagged');
  assert.match(padded.STORAGE_SWEEP_DRY_RUN, /DELETION IS ARMED/);
});

test('the banner never lets a typo in MIN_AGE_DAYS read as 0', async () => {
  const mod: any = await import(join(tempDir!, 'storageSweeper.ts'));
  const logs = mod.__capturedLogs;
  const previous = process.env.STORAGE_SWEEP_MIN_AGE_DAYS;

  logs.length = 0;
  process.env.STORAGE_SWEEP_MIN_AGE_DAYS = 'seven';
  mod.logResolvedConfig();
  const data = logs.find((l: any) => l.message === 'Storage configuration in use').data;

  if (previous === undefined) delete process.env.STORAGE_SWEEP_MIN_AGE_DAYS;
  else process.env.STORAGE_SWEEP_MIN_AGE_DAYS = previous;

  assert.equal(data.minAgeDays, 7, 'a typo falls back to 7, never to 0');
  assert.match(data.STORAGE_SWEEP_MIN_AGE_DAYS, /not a usable number/);
});

test('dryRun defaults to FALSE for direct callers, preserving the original behaviour', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'd.txt', 'delta');

  const result = await sweepStorage(deps(), { minAgeDays: 0 });

  assert.equal(result.dryRun, false);
  assert.equal(result.deleted, 1);
  assert.deepEqual(await keysIn(hot, HOT), []);
});

test('the old positional concurrency argument still works', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'e.txt', 'echo');

  const result = await sweepStorage(deps(), { concurrency: 2, minAgeDays: 0 });
  assert.equal(result.migrated, 1);
});

test('a cold-side failure does NOT delete the source', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await put(HOT, 'f.txt', 'foxtrot');

  const broken = { ...deps(), coldBucket: 'bucket-that-does-not-exist' };
  const result = await sweepStorage(broken, { dryRun: false, minAgeDays: 0 });

  assert.equal(result.migrated, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(await keysIn(hot, HOT), ['f.txt'], 'a failed copy must never lose the original');
});

test('maxObjects bounds a first dry run over a large bucket', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  for (const k of ['g1.txt', 'g2.txt', 'g3.txt', 'g4.txt', 'g5.txt']) await put(HOT, k, 'golf');

  const result = await sweepStorage(deps(), { dryRun: true, maxObjects: 2, minAgeDays: 0 });

  assert.equal(result.scanned, 2, 'only two keys were considered');
  assert.equal(result.deleted, 0);
  assert.equal((await keysIn(hot, HOT)).length, 5, 'all five still in hot');
});

test('migrateObject reports whether it deleted', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'h.txt', 'hotel');

  const dry = await migrateObject('h.txt', deps(), true);
  assert.deepEqual(dry, { deleted: false });
  assert.deepEqual(await keysIn(hot, HOT), ['h.txt']);

  const live = await migrateObject('h.txt', deps(), false);
  assert.deepEqual(live, { deleted: true });
  assert.deepEqual(await keysIn(hot, HOT), []);
});

test('an empty hot bucket is a clean no-op', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  const result = await sweepStorage(deps(), { dryRun: true });
  assert.deepEqual(result, {
    scanned: 0, skippedTooNew: 0, migrated: 0, deleted: 0,
    dryRun: true, minAgeDays: 7, failed: [],
  });
});

// --- the 7-day age filter ---------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

test('AGE FILTER: a fresh object is NOT swept', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'fresh.txt', 'brand new');

  // Real clock: the object was created moments ago, so it is younger than 7 days.
  const result = await sweepStorage(deps(), { dryRun: true, minAgeDays: 7 });

  assert.equal(result.scanned, 1);
  assert.equal(result.skippedTooNew, 1, 'held back by the filter');
  assert.equal(result.migrated, 0);
  assert.equal(result.minAgeDays, 7);
  assert.deepEqual(await keysIn(hot, HOT), ['fresh.txt'], 'still in hot');
  assert.deepEqual(await keysIn(cold, COLD), [], 'never copied to cold');
});

test('AGE FILTER: an object older than the threshold IS swept', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'old.txt', 'aged');

  // Move the clock forward 30 days rather than fake the object's timestamp, so
  // the real LastModified from the server is what gets compared.
  const result = await sweepStorage(deps(), {
    dryRun: true,
    minAgeDays: 7,
    nowMs: () => Date.now() + 30 * DAY,
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.skippedTooNew, 0);
  assert.equal(result.migrated, 1);
  assert.deepEqual(await keysIn(cold, COLD), ['old.txt'], 'copied to cold');
  assert.deepEqual(await keysIn(hot, HOT), ['old.txt'], 'dry run left hot alone');
});

test('AGE FILTER: mixed ages — only the old ones go', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'a.txt', 'one');
  await put(HOT, 'b.txt', 'two');

  // 10 days on: both are older than 7. Then 3 days on: neither is.
  const swept = await sweepStorage(deps(), { dryRun: true, minAgeDays: 7, nowMs: () => Date.now() + 10 * DAY });
  assert.equal(swept.migrated, 2);

  await emptyBucket(cold, COLD);
  const held = await sweepStorage(deps(), { dryRun: true, minAgeDays: 7, nowMs: () => Date.now() + 3 * DAY });
  assert.equal(held.migrated, 0);
  assert.equal(held.skippedTooNew, 2);
  assert.deepEqual(await keysIn(cold, COLD), [], 'nothing copied when all are too new');
});

test('AGE FILTER: minAgeDays 0 sweeps everything, preserving the old behaviour', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'now.txt', 'immediate');

  const result = await sweepStorage(deps(), { dryRun: true, minAgeDays: 0 });
  assert.equal(result.skippedTooNew, 0);
  assert.equal(result.migrated, 1);
});

test('AGE FILTER: the default is 7 days, not 0', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'default.txt', 'x');

  // No minAgeDays passed at all. A fresh object must be held back.
  const result = await sweepStorage(deps(), { dryRun: true });
  assert.equal(result.minAgeDays, 7, 'default must be 7');
  assert.equal(result.migrated, 0);
  assert.deepEqual(await keysIn(hot, HOT), ['default.txt']);
});

test('AGE FILTER: a LIVE run still respects it — fresh files are not deleted', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'keepme.txt', 'fresh and must survive');

  const result = await sweepStorage(deps(), { dryRun: false, minAgeDays: 7 });

  assert.equal(result.deleted, 0);
  assert.deepEqual(await keysIn(hot, HOT), ['keepme.txt'], 'a live run must not delete a fresh file');
});

test('AGE FILTER: env parsing defaults to 7 and refuses to fail open', async () => {
  const { sweepMinAgeDaysFromEnv } = await import(join(tempDir!, 'storageSweeper.ts'));
  assert.equal(sweepMinAgeDaysFromEnv({}), 7, 'unset -> 7');
  assert.equal(sweepMinAgeDaysFromEnv({ STORAGE_SWEEP_MIN_AGE_DAYS: '' }), 7);
  assert.equal(sweepMinAgeDaysFromEnv({ STORAGE_SWEEP_MIN_AGE_DAYS: 'banana' }), 7, 'a typo must not mean 0');
  assert.equal(sweepMinAgeDaysFromEnv({ STORAGE_SWEEP_MIN_AGE_DAYS: '-3' }), 7, 'negative must not mean 0');
  assert.equal(sweepMinAgeDaysFromEnv({ STORAGE_SWEEP_MIN_AGE_DAYS: '14' }), 14);
  assert.equal(sweepMinAgeDaysFromEnv({ STORAGE_SWEEP_MIN_AGE_DAYS: '0' }), 0, 'explicit 0 is honoured');
});

test('invalid options are rejected before anything is listed', async () => {
  await assert.rejects(() => sweepStorage(deps(), { concurrency: 0 }), /positive integer/);
  await assert.rejects(() => sweepStorage(deps(), { maxObjects: 0 }), /positive integer/);
  await assert.rejects(() => sweepStorage(deps(), { minAgeDays: -1 }), /zero or a positive number/);
});
