/**
 * Pipeline helper tests.
 *
 * publishPipeline.ts imports the Trigger.dev SDK plus two files that live in the
 * CLIENT's repo (storageClient, env), none of which exist here. Same technique
 * as the sweeper and Bluesky tests: rewrite only the imports that cannot
 * resolve, into a generated copy, and assert the rewrite did not gut the file.
 * What is under test stays the shipped source.
 *
 * The helpers are small but they are where the real risk sits: an extension
 * matcher that guesses, or a derivative name that does not match what ComfyUI
 * writes, fails silently by publishing nothing or by publishing the wrong file.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let mediaKindFromKey: any;
let mimeTypeFromKey: any;
let isWebDerivative: any;
let webDerivativeKey: any;
let tempDir: string;

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-pipeline');
  mkdirSync(tempDir, { recursive: true });

  for (const name of ['contentRouting', 'publishScheduler', 'blueskyClient', 'telegramClient', 'captionGenerator', 'metaClient', 'tiktokClient', 'redditClient']) {
    const src = readFileSync(join(here, '..', 'src', 'utils', `${name}.ts`), 'utf8');
    writeFileSync(
      join(tempDir, `${name}.ts`),
      src.replace(/from "\.\/([A-Za-z]+)\.js"/g, 'from "./$1.ts"'),
    );
  }

  const source = readFileSync(join(here, '..', 'src', 'trigger', 'publishPipeline.ts'), 'utf8');
  const rewritten = source
    .replace(/from "\.\.\/utils\/([A-Za-z]+)\.js"/g, 'from "./$1.ts"')
    .replace(
      /import \{ tigrisClient \} from "\.\/storageClient\.ts";/,
      'const tigrisClient: any = null;',
    )
    .replace(/import \{ requireEnv \} from "\.\/env\.ts";/, 'const requireEnv = (n: string) => n;')
    .replace(
      /import \{ logger, schedules, task, AbortTaskRunError \} from "@trigger\.dev\/sdk\/v3";/,
      'const logger: any = { info() {}, warn() {}, error() {} };\n' +
        'const task: any = (d: any) => ({ ...d, trigger: async () => ({}) });\n' +
        'const schedules: any = { task: (d: any) => d };\n' +
        'class AbortTaskRunError extends Error {}',
    );

  assert.ok(!rewritten.includes('@trigger.dev/sdk'), 'the SDK import must be stubbed');
  assert.ok(!rewritten.includes('utils/storageClient'), 'storageClient must be stubbed');
  // If a regex gutted the file these would vanish and every test below would
  // pass against nothing.
  assert.ok(rewritten.includes('assertPublishAllowed'), 'the safety rail must survive');
  assert.ok(rewritten.includes('idempotencyKey: post.idempotencyKey'), 'the dedupe key must survive');

  writeFileSync(join(tempDir, 'publishPipeline.ts'), rewritten);
  const mod = await import(join(tempDir, 'publishPipeline.ts'));
  ({ mediaKindFromKey, mimeTypeFromKey, isWebDerivative, webDerivativeKey } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

test('media kind is read from the extension, and never guessed', () => {
  assert.equal(mediaKindFromKey('safe/a/render-01.png'), 'image');
  assert.equal(mediaKindFromKey('safe/a/render-01.jpg'), 'image');
  assert.equal(mediaKindFromKey('safe/a/render-01.jpeg'), 'image');
  assert.equal(mediaKindFromKey('safe/a/render-01.webp'), 'image');
  assert.equal(mediaKindFromKey('explicit/a/loop.mp4'), 'video');
  assert.equal(mediaKindFromKey('explicit/a/loop.mov'), 'video');

  // An unknown extension must be null so the planner skips it LOUDLY rather
  // than publishing something as the wrong kind.
  assert.equal(mediaKindFromKey('safe/a/notes.txt'), null);
  assert.equal(mediaKindFromKey('safe/a/render'), null, 'no extension at all');
  assert.equal(mediaKindFromKey('safe/a/render.gif'), null, 'gif is not in the supported set');
});

test('extension matching is anchored to the END of the key', () => {
  // "render.png.bak" is not a PNG. A non-anchored regex would say it is.
  assert.equal(mediaKindFromKey('safe/a/render.png.bak'), null);
  // A directory named ".mp4" must not make a text file a video.
  assert.equal(mediaKindFromKey('safe/.mp4/notes.txt'), null);
});

test('extension matching is case-insensitive, because S3 keys vary', () => {
  assert.equal(mediaKindFromKey('safe/a/RENDER-01.PNG'), 'image');
  assert.equal(mediaKindFromKey('safe/a/LOOP.MP4'), 'video');
});

test('mime types match the extensions the adapters accept', () => {
  assert.equal(mimeTypeFromKey('a/x.jpg'), 'image/jpeg');
  assert.equal(mimeTypeFromKey('a/x.jpeg'), 'image/jpeg');
  assert.equal(mimeTypeFromKey('a/x.png'), 'image/png');
  assert.equal(mimeTypeFromKey('a/x.webp'), 'image/webp');
  assert.equal(mimeTypeFromKey('a/x.mp4'), 'video/mp4');
  assert.equal(mimeTypeFromKey('a/x.tiff'), null, 'unknown stays null rather than a wrong guess');
});

test('a -web derivative is recognised and never treated as its own post', () => {
  assert.equal(isWebDerivative('safe/2026-09-17/render-01-web.jpg'), true);
  assert.equal(isWebDerivative('safe/2026-09-17/render-01.png'), false);
  // The suffix must be immediately before the extension, not anywhere in the key.
  assert.equal(isWebDerivative('safe/web-shoot/render-01.png'), false);
  assert.equal(isWebDerivative('safe/a/render-website.png'), false);
});

test('the derivative key matches what the ComfyUI workflow writes', () => {
  // 1600px longest edge, JPEG q85, -web suffix — agreed with the client. If this
  // and the workflow ever disagree, Bluesky silently falls back to the master
  // and then fails the 1MB check, so it is worth pinning.
  assert.equal(
    webDerivativeKey('safe/2026-09-17/render-01.png'),
    'safe/2026-09-17/render-01-web.jpg',
  );
  assert.equal(
    webDerivativeKey('safe/2026-09-17/render-01.jpeg'),
    'safe/2026-09-17/render-01-web.jpg',
    'the derivative is always .jpg whatever the master is',
  );
  assert.equal(webDerivativeKey('safe/a.b.c/render.01.png'), 'safe/a.b.c/render.01-web.jpg');
});

test('a derivative key is itself recognised as a derivative', () => {
  // Otherwise the planner could pick one up as a fresh asset and post it twice.
  assert.equal(isWebDerivative(webDerivativeKey('safe/a/render-01.png')), true);
});
