/**
 * manualPostKit tests, against a REAL S3 server (MinIO), not a mock.
 *
 * The thing under test is mostly "does it ever hand a human a link to explicit
 * content", and that question deserves a real ListObjectsV2 with real prefixes
 * rather than an object literal I wrote to match my own expectations.
 *
 * Skips as inconclusive when MinIO is not running. A skipped safety test must
 * never read as a passing one.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, CreateBucketCommand, PutObjectCommand } from '@aws-sdk/client-s3';

let buildManualPostKit: any;
let clampExpiry: any;
let clampLimit: any;
let isDerivativeKey: any;
let kitAuditLine: any;
let tempDir: string;
let client: S3Client;
let available = false;

const ENDPOINT = process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010';
const CREDS = { accessKeyId: 'rootuser', secretAccessKey: 'rootpass123' };
const BUCKET = 'kit-test';

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-kit');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'manualPostKit.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source);
  assert.ok(rewritten.includes('classifyFromKey'), 'the second guard must survive');
  writeFileSync(join(tempDir, 'manualPostKit.ts'), rewritten);

  ({ buildManualPostKit, clampExpiry, clampLimit, isDerivativeKey, kitAuditLine } = await import(
    join(tempDir, 'manualPostKit.ts')
  ));

  client = new S3Client({
    endpoint: ENDPOINT,
    region: 'us-east-1',
    credentials: CREDS,
    forcePathStyle: true,
  });

  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (error) {
    const name = (error as { name?: string }).name ?? '';
    if (!/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(name)) {
      return; // leave available = false
    }
  }

  const put = (Key: string, Body: string) =>
    client.send(new PutObjectCommand({ Bucket: BUCKET, Key, Body }));

  try {
    await put('safe/2026-09-17/render-01.png', 'aaa');
    await put('safe/2026-09-17/render-01-web.jpg', 'bb');
    await put('safe/2026-09-18/render-02.jpeg', 'cccc');
    await put('safe/notes.txt', 'not an image');
    // The one that must NEVER appear in the output.
    await put('explicit/2026-09-18/secret-01.png', 'nope');
    available = true;
  } catch {
    available = false;
  }
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function requireS3(t: any): boolean {
  if (!available) {
    t.skip(`no S3 at ${ENDPOINT} — start MinIO to run this properly`);
    return false;
  }
  return true;
}

// --- the safety property ------------------------------------------------------

test('EXPLICIT content never appears in the kit', async (t) => {
  if (!requireS3(t)) return;
  const result = await buildManualPostKit(client, BUCKET);

  for (const file of result.files) {
    assert.ok(
      file.key.startsWith('safe/'),
      `${file.key} is not safe content and must never be handed to a human for posting`,
    );
    assert.ok(!file.key.includes('explicit'), 'no explicit key, by any route');
  }
  // And prove the explicit object genuinely exists, or this asserts nothing.
  assert.ok(result.files.length > 0, 'the kit must actually have found something');
});

test('the CLASSIFIER refuses explicit content, not just the prefix', async (t) => {
  if (!requireS3(t)) return;
  // Scoped to safe/, the per-key classification guard can never fire — which
  // makes it decorative, and a safety check nobody can prove works is worth
  // very little. Point the listing straight at explicit/ and the classifier
  // has to be the thing that stops it.
  const result = await buildManualPostKit(client, BUCKET, { prefix: 'explicit/' });

  assert.deepEqual(result.files, [], 'not one explicit object may come back');
  assert.ok(result.skipped.length > 0, 'and it must have actually seen some, or this proves nothing');
  assert.ok(
    result.skipped.every((s: any) => /does not classify as safe/.test(s.reason)),
    `every refusal must come from the classifier: ${JSON.stringify(result.skipped)}`,
  );
  assert.ok(result.skipped.some((s: any) => s.key.includes('secret-01')));
});

test('a non-image is left out, with a reason rather than silently', async (t) => {
  if (!requireS3(t)) return;
  const result = await buildManualPostKit(client, BUCKET);
  assert.ok(!result.files.some((f: any) => f.key.endsWith('.txt')));
  assert.ok(
    result.skipped.some((s: any) => s.key.endsWith('.txt') && /not an image/.test(s.reason)),
    'a silent omission looks identical to "there was nothing there"',
  );
});

test('web derivatives are excluded by default, includable on request', async (t) => {
  if (!requireS3(t)) return;

  const without = await buildManualPostKit(client, BUCKET);
  assert.ok(
    !without.files.some((f: any) => isDerivativeKey(f.key)),
    'a derivative alongside its master is a confusing duplicate',
  );

  const with_ = await buildManualPostKit(client, BUCKET, { includeDerivatives: true });
  assert.ok(with_.files.some((f: any) => isDerivativeKey(f.key)));
});

// --- ordering and limits ------------------------------------------------------

test('newest first, because that is the week you want to post', async (t) => {
  if (!requireS3(t)) return;
  const result = await buildManualPostKit(client, BUCKET);
  const times = result.files
    .map((f: any) => f.lastModified?.getTime() ?? 0)
    .filter((n: number) => n > 0);
  const sorted = [...times].sort((a, b) => b - a);
  assert.deepEqual(times, sorted, 'files must come back newest first');
});

test('the limit is respected and clamped', async (t) => {
  if (!requireS3(t)) return;
  const one = await buildManualPostKit(client, BUCKET, { limit: 1 });
  assert.equal(one.files.length, 1);

  assert.equal(clampLimit(undefined), 20);
  assert.equal(clampLimit(0), 1, 'zero would return nothing and read as "no renders"');
  assert.equal(clampLimit(9999), 100);
  assert.equal(clampLimit(5), 5);
});

test('the expiry is clamped at both ends', () => {
  assert.equal(clampExpiry(undefined), 6 * 60 * 60);
  assert.equal(clampExpiry(1), 60, 'a link that dies before you click it is useless');
  assert.equal(clampExpiry(99999999), 24 * 60 * 60, 'a bearer token must not live for a week');
  assert.equal(clampExpiry(3600), 3600);
});

// --- the links actually work --------------------------------------------------

test('a link in the kit downloads the right bytes', async (t) => {
  if (!requireS3(t)) return;
  const result = await buildManualPostKit(client, BUCKET, { limit: 50 });
  const file = result.files.find((f: any) => f.key === 'safe/2026-09-17/render-01.png');
  assert.ok(file, 'the render must be in the kit');

  const response = await fetch(file.url);
  assert.equal(response.status, 200, 'the presigned link must actually work');
  assert.equal(await response.text(), 'aaa', 'and return that exact object');
});

test('the same key WITHOUT a signature is refused — the bucket is not public', async (t) => {
  if (!requireS3(t)) return;
  const response = await fetch(`${ENDPOINT}/${BUCKET}/safe/2026-09-17/render-01.png`);
  assert.ok(
    response.status === 403 || response.status === 401,
    `an unsigned fetch must be refused, got ${response.status}`,
  );
});

// --- secrets ------------------------------------------------------------------

test('the audit line carries keys and counts but NO signed URLs', async (t) => {
  if (!requireS3(t)) return;
  const result = await buildManualPostKit(client, BUCKET);
  const line = kitAuditLine(result);
  const serialised = JSON.stringify(line);

  assert.ok(serialised.includes('safe/'), 'keys are useful and safe to log');
  assert.ok(!/X-Amz-Signature/i.test(serialised), 'a signed URL must never reach a log');
  assert.ok(!serialised.includes('http'), 'no URL of any kind');
  assert.equal(line.fileCount, result.files.length);
});
