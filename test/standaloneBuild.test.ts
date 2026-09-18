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

  // One statement per specifier. Two task files both import the SDK, and when
  // the bundler concatenated their imports instead of merging them the bundle
  // declared `logger` and `task` twice — a SyntaxError that would have surfaced
  // on the client's deploy rather than here.
  assert.equal(
    new Set(imports).size,
    imports.length,
    `a specifier is imported more than once: ${imports.join(', ')}`,
  );
});

test('the bundle actually PARSES, which text matching cannot tell you', async () => {
  // The duplicate-import bug produced a bundle that satisfied every string
  // assertion above and still could not load. The only way to know a generated
  // file is valid is to hand it to the engine.
  const bundle = readFileSync(bundlePath, 'utf8');

  // Stub the two imports that resolve inside the CLIENT's repo, not this one,
  // plus the SDK. Everything else must stand on its own.
  const runnable = bundle
    .replace(/^import \{[^}]*\} from "\.\.\/utils\/env\.js";$/m, 'const requireEnv = (n: string) => n;')
    .replace(
      /^import \{[^}]*\} from "\.\.\/utils\/storageClient\.js";$/m,
      'const tigrisClient: any = null;',
    )
    .replace(
      /^import \{([^}]*)\} from "@trigger\.dev\/sdk\/v3";$/m,
      'const logger: any = { info() {}, warn() {}, error() {} };\n' +
        'const task: any = (d: any) => d;\n' +
        'const schedules: any = { task: (d: any) => d };\n' +
        'class AbortTaskRunError extends Error {}',
    )
    .replace(/^import \{[^}]*\} from "@aws-sdk\/[^"]*";$/gm, '');

  assert.ok(!/^import /m.test(runnable), 'every import should now be stubbed');
  // Prove the stubbing did not gut the file before trusting a clean parse.
  assert.ok(runnable.includes('assertPublishAllowed'), 'the rail must survive stubbing');
  assert.ok(runnable.includes('"publish-doctor"'), 'the doctor task must survive stubbing');

  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'standalone-parse-'));
  try {
    const file = join(dir, 'bundle.ts');
    writeFileSync(file, runnable);
    // A duplicate declaration, an unbalanced brace or a stray specifier all
    // throw here. Missing AWS commands only matter at call time, so an import
    // is enough to prove the file is syntactically whole.
    const mod = await import(file);
    assert.ok(mod, 'the bundle loaded');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
