/**
 * The standalone bundle must never go stale.
 *
 * A generated file that drifts from its sources is the same failure that has
 * already bitten this package twice through install.sh's hand-written file
 * list: everything looks fine, and the thing you are actually running is an
 * older version of what you think you are running. Here it would be worse —
 * the client deploys the bundle, so a stale bundle means fixes that exist in
 * src/ and tests that pass against src/ while production runs neither.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const bundlePath = new URL('../standalone/publishPipeline.standalone.ts', import.meta.url);

test('the committed bundle matches a fresh build of the sources', () => {
  const committed = readFileSync(bundlePath, 'utf8');
  execFileSync('node', ['scripts/build-standalone.mjs'], { cwd: root, stdio: 'pipe' });
  const rebuilt = readFileSync(bundlePath, 'utf8');
  assert.equal(
    rebuilt,
    committed,
    'standalone/ is out of date — run: node scripts/build-standalone.mjs, and commit the result',
  );
});

test('the bundle carries the safety rail and both adapters', () => {
  // Guards the ARTIFACT the client actually deploys, not the sources it came
  // from. A bundler bug that dropped the rail would leave a file that deploys
  // happily and publishes explicit content to six public platforms.
  const bundle = readFileSync(bundlePath, 'utf8');
  for (const needle of [
    'assertPublishAllowed',
    'BLOCKED: refusing to publish',
    'com.atproto.repo.createRecord',
    'sendPhoto',
    'idempotencyKey: post.idempotencyKey',
    'retry: { maxAttempts: 1 }',
  ]) {
    assert.ok(bundle.includes(needle), `the bundle is missing "${needle}"`);
  }
});

test('the bundle needs no dependency the project does not already have', () => {
  const bundle = readFileSync(bundlePath, 'utf8');
  // Parsed across the WHOLE file, not line by line. The @aws-sdk import is now
  // multi-line, and a line-based match silently found zero specifiers for it --
  // which made this test quietly assert less than it looked like it did.
  const imports = [...bundle.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["'];/gm)].map(
    (m) => m[1]!,
  );

  assert.deepEqual(imports.sort(), [
    '../utils/env.js',
    '../utils/storageClient.js',
    '@aws-sdk/client-s3',
    '@aws-sdk/s3-request-presigner',
    '@trigger.dev/sdk/v3',
  ]);

  // The presigner became REQUIRED when the Meta lanes landed: Instagram and
  // Facebook do not accept bytes, they fetch the media from a URL we supply,
  // and the bucket is private. This test previously asserted the OPPOSITE --
  // that the publish path needed no presigner -- which was true right up until
  // it wasn't. Leaving it would have been a green test asserting a stale fact.
  assert.ok(
    bundle.includes('getSignedUrl'),
    'Instagram and Facebook need presigned URLs; the bundle must import the presigner',
  );
});
