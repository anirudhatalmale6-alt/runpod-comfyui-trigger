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
      'const schedules: any = { task: (d: any) => d };\nconst logger: any = { warn() {}, info() {}, error() {} };',
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
  writeFileSync(file, rewritten);

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

  const result = await sweepStorage(deps(), { dryRun: true });

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

  const result = await sweepStorage(deps(), { dryRun: false });

  assert.equal(result.dryRun, false);
  assert.equal(result.migrated, 1);
  assert.equal(result.deleted, 1);
  assert.deepEqual(await keysIn(hot, HOT), [], 'hot is emptied on a live run');
  assert.deepEqual(await keysIn(cold, COLD), ['c.txt']);
});

test('dryRun defaults to FALSE for direct callers, preserving the original behaviour', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'd.txt', 'delta');

  const result = await sweepStorage(deps());

  assert.equal(result.dryRun, false);
  assert.equal(result.deleted, 1);
  assert.deepEqual(await keysIn(hot, HOT), []);
});

test('the old positional concurrency argument still works', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await emptyBucket(cold, COLD);
  await put(HOT, 'e.txt', 'echo');

  const result = await sweepStorage(deps(), 2);
  assert.equal(result.migrated, 1);
});

test('a cold-side failure does NOT delete the source', async (t) => {
  if (!requireS3(t)) return;
  await emptyBucket(hot, HOT);
  await put(HOT, 'f.txt', 'foxtrot');

  const broken = { ...deps(), coldBucket: 'bucket-that-does-not-exist' };
  const result = await sweepStorage(broken, { dryRun: false });

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

  const result = await sweepStorage(deps(), { dryRun: true, maxObjects: 2 });

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
  assert.deepEqual(result, { scanned: 0, migrated: 0, deleted: 0, dryRun: true, failed: [] });
});

test('invalid options are rejected before anything is listed', async () => {
  await assert.rejects(() => sweepStorage(deps(), { concurrency: 0 }), /positive integer/);
  await assert.rejects(() => sweepStorage(deps(), { maxObjects: 0 }), /positive integer/);
});
