/**
 * Content delivery, tested against a REAL S3 server (MinIO in a container).
 *
 * The assertions that matter here actually FETCH the signed URL over HTTP,
 * because "getSignedUrl returned a string" proves nothing — presigning is pure
 * string manipulation that never contacts the server and never fails for a
 * missing object, a wrong bucket or a bad key. The only way to know a link
 * works is to use it.
 *
 * Skips loudly when no S3 is reachable rather than passing silently.
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';

import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';

import {
  DEFAULT_EXPIRES_SECONDS,
  MAX_PRESIGN_SECONDS,
  clampExpiry,
  deliverSet,
  deliveryAuditLine,
  normalisePrefix,
  coldClientFromEnv,
  coldBucketFromEnv,
} from '../src/utils/contentDelivery.ts';

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const CREDS = { accessKeyId: 'rootuser', secretAccessKey: 'rootpass123' };
const BUCKET = 'delivery-cold';

const client = new S3Client({
  endpoint: ENDPOINT,
  region: 'us-east-1',
  forcePathStyle: true,
  credentials: CREDS,
});

let available = false;

function requireS3(t: { skip: (m?: string) => void }): boolean {
  if (!available) {
    t.skip(`no S3 at ${ENDPOINT} — start MinIO to run this properly`);
    return false;
  }
  return true;
}

before(async () => {
  try {
    try {
      await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
    } catch {
      /* already exists */
    }
    const listed = await client.send(new ListObjectsV2Command({ Bucket: BUCKET }));
    for (const item of listed.Contents ?? []) {
      if (item.Key) await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: item.Key }));
    }
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'sets/premium-03/frame-02.png',
        Body: Buffer.from('second frame'),
        ContentType: 'image/png',
      }),
    );
    await client.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: 'sets/premium-03/frame-01.png',
        Body: Buffer.from('first'),
        ContentType: 'image/png',
      }),
    );
    // A directory marker: zero bytes, key ends in "/". Must never be delivered.
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'sets/premium-03/', Body: Buffer.from('') }),
    );
    // The sibling that a missing trailing slash would wrongly sweep in.
    await client.send(
      new PutObjectCommand({ Bucket: BUCKET, Key: 'sets/premium-030/leak.png', Body: Buffer.from('nope') }),
    );
    available = true;
  } catch {
    available = false;
  }
});

// --- pure helpers, no network ------------------------------------------------

test('normalisePrefix refuses to serve the whole bucket', () => {
  assert.throws(() => normalisePrefix(''), /prefix is required/);
  assert.throws(() => normalisePrefix('   '), /prefix is required/);
  assert.throws(() => normalisePrefix('/'), /prefix is required/);
  assert.throws(() => normalisePrefix('sets/../other'), /\.\./);
});

test('normalisePrefix strips a leading slash and forces a trailing one', () => {
  // A leading "/" makes a prefix listing silently return nothing.
  assert.equal(normalisePrefix('/sets/premium-03'), 'sets/premium-03/');
  // Without the trailing "/", prefix "premium-03" also matches "premium-030".
  assert.equal(normalisePrefix('sets/premium-03'), 'sets/premium-03/');
  assert.equal(normalisePrefix('sets/premium-03/'), 'sets/premium-03/');
});

test('clampExpiry defaults sanely and never exceeds the SigV4 ceiling', () => {
  assert.equal(clampExpiry(undefined), DEFAULT_EXPIRES_SECONDS);
  assert.equal(clampExpiry(0), DEFAULT_EXPIRES_SECONDS, 'zero is a mistake, not an instruction');
  assert.equal(clampExpiry(-5), DEFAULT_EXPIRES_SECONDS);
  assert.equal(clampExpiry(Number.NaN), DEFAULT_EXPIRES_SECONDS);
  assert.equal(clampExpiry(900), 900);
  // Above the ceiling the URL signs fine and then fails at fetch time with an
  // opaque error, which is far worse than being clamped here.
  assert.equal(clampExpiry(MAX_PRESIGN_SECONDS + 1), MAX_PRESIGN_SECONDS);
  assert.equal(clampExpiry(365 * 24 * 60 * 60), MAX_PRESIGN_SECONDS);
});

test('a missing credential names the variable rather than failing at first use', () => {
  assert.throws(
    () => coldClientFromEnv({ BACKBLAZE_ENDPOINT: 'https://s3.example.com' } as NodeJS.ProcessEnv),
    /BACKBLAZE_REGION/,
  );
  assert.throws(() => coldBucketFromEnv({} as NodeJS.ProcessEnv), /BACKBLAZE_BUCKET_NAME/);
});

test('a scheme-less endpoint is caught here, not as a bare "Invalid URL" later', () => {
  assert.throws(
    () =>
      coldClientFromEnv({
        BACKBLAZE_ENDPOINT: 's3.us-east-005.backblazeb2.com',
        BACKBLAZE_REGION: 'us-east-005',
        BACKBLAZE_AWS_ACCESS_KEY_ID: 'a'.repeat(25),
        BACKBLAZE_AWS_SECRET_ACCESS_KEY: 'b'.repeat(31),
      } as NodeJS.ProcessEnv),
    /needs the https:\/\/ prefix/,
  );
});

test('the client reads the BACKBLAZE_AWS_* spelling the project actually uses', () => {
  // Reading a variable nobody set reports "not configured" against a correct
  // environment. That has already cost this project a round trip once.
  assert.doesNotThrow(() =>
    coldClientFromEnv({
      BACKBLAZE_ENDPOINT: 'https://s3.us-east-005.backblazeb2.com',
      BACKBLAZE_REGION: 'us-east-005',
      BACKBLAZE_AWS_ACCESS_KEY_ID: 'a'.repeat(25),
      BACKBLAZE_AWS_SECRET_ACCESS_KEY: 'b'.repeat(31),
    } as NodeJS.ProcessEnv),
  );
});

// --- against a real S3 server ------------------------------------------------

test('a delivered URL actually downloads the right bytes', async (t) => {
  if (!requireS3(t)) return;

  const result = await deliverSet('purchase_abc', 'sets/premium-03', {
    client,
    bucket: BUCKET,
    expiresInSeconds: 300,
  });

  assert.equal(result.files.length, 2, 'the directory marker and the sibling set are excluded');
  assert.deepEqual(
    result.files.map((f) => f.filename),
    ['frame-01.png', 'frame-02.png'],
    'sorted, and leaf names only',
  );

  // The assertion that matters: fetch it.
  const first = result.files[0]!;
  const response = await fetch(first.url);
  assert.equal(response.status, 200, 'the signed URL must really work');
  assert.equal(await response.text(), 'first');
  assert.equal(first.sizeBytes, 5, 'size comes from HeadObject, not from a guess');
  assert.equal(first.contentType, 'image/png');
});

test('the bucket is NOT public — the same key without a signature is refused', async (t) => {
  if (!requireS3(t)) return;

  const unsigned = `${ENDPOINT}/${BUCKET}/sets/premium-03/frame-01.png`;
  const response = await fetch(unsigned);
  assert.notEqual(response.status, 200, 'an unsigned fetch must not succeed');
  assert.ok(response.status === 403 || response.status === 401, `got ${response.status}`);
});

test('a trailing-slash-less prefix does not leak the neighbouring set', async (t) => {
  if (!requireS3(t)) return;

  const result = await deliverSet('purchase_def', 'sets/premium-03', { client, bucket: BUCKET });
  assert.ok(
    !result.files.some((f) => f.key.includes('premium-030')),
    'premium-030 must not be delivered to a premium-03 buyer',
  );
});

test('an expired URL stops working', async (t) => {
  if (!requireS3(t)) return;

  // One second, then wait it out. Proves expiry is real server-side behaviour
  // and not just a number carried in the query string.
  const result = await deliverSet('purchase_exp', 'sets/premium-03', {
    client,
    bucket: BUCKET,
    expiresInSeconds: 1,
  });
  const url = result.files[0]!.url;

  assert.equal((await fetch(url)).status, 200, 'works immediately');
  await new Promise((r) => setTimeout(r, 2500));
  const after = await fetch(url);
  assert.notEqual(after.status, 200, 'must stop working once expired');
});

test('a paid purchase that matches nothing THROWS rather than returning empty', async (t) => {
  if (!requireS3(t)) return;

  // The buyer has already paid. Silently returning zero files would be logged
  // as a success and nobody would ever find out.
  await assert.rejects(
    () => deliverSet('purchase_ghi', 'sets/does-not-exist', { client, bucket: BUCKET }),
    /matched no files/,
  );
});

test('maxFiles bounds a mis-typed prefix', async (t) => {
  if (!requireS3(t)) return;

  const result = await deliverSet('purchase_jkl', 'sets/premium-03', {
    client,
    bucket: BUCKET,
    maxFiles: 1,
  });
  assert.equal(result.files.length, 1);
});

test('the audit line records what was delivered and NO signed URLs', async (t) => {
  if (!requireS3(t)) return;

  const result = await deliverSet('purchase_mno', 'sets/premium-03', { client, bucket: BUCKET });
  const line = deliveryAuditLine(result);
  const serialised = JSON.stringify(line);

  assert.equal(line.purchaseId, 'purchase_mno');
  assert.equal(line.fileCount, 2);
  assert.equal(line.totalBytes, 5 + 'second frame'.length);

  // A presigned URL is a working credential until it expires. It must never
  // reach a log, where anyone with log access can simply use it.
  assert.ok(!serialised.includes('X-Amz-Signature'), 'no signature in the audit line');
  assert.ok(!serialised.includes('X-Amz-Credential'), 'no credential in the audit line');
  assert.ok(!serialised.includes('rootuser'), 'no access key in the audit line');
  for (const file of result.files) {
    assert.ok(!serialised.includes(file.url), 'no full URL in the audit line');
  }
});
