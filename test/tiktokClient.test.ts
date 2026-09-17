/**
 * TikTok adapter tests.
 *
 * The distinctive risks here are the transfer mode and the audit state. We use
 * FILE_UPLOAD deliberately because PULL_FROM_URL needs domain verification we
 * cannot obtain, so a test pins that the init call really says FILE_UPLOAD — a
 * silent switch would fail on every post with an error about an unverified URL
 * that reads like a broken link.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let tiktokCredentialsFromEnv: any;
let publishPhotoToTikTok: any;
let describeTikTokError: any;
let validatePhoto: any;
let TIKTOK_MAX_PHOTO_BYTES: number;
let TIKTOK_MAX_TITLE: number;
let TIKTOK_API: string;
let tempDir: string;

const TOKEN = 'act.exampleaccesstokenvalue';
const CREDS = { accessToken: TOKEN };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-tiktok');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'tiktokClient.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source);
  assert.ok(rewritten.includes('assertPublishAllowed'), 'the safety guard must survive');
  assert.ok(rewritten.includes('FILE_UPLOAD'), 'the transfer mode must survive');
  writeFileSync(join(tempDir, 'tiktokClient.ts'), rewritten);

  const mod = await import(join(tempDir, 'tiktokClient.ts'));
  ({
    tiktokCredentialsFromEnv, publishPhotoToTikTok, describeTikTokError,
    validatePhoto, TIKTOK_MAX_PHOTO_BYTES, TIKTOK_MAX_TITLE, TIKTOK_API,
  } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function scriptedFetch(steps: Array<{ status?: number; body?: unknown; raw?: boolean }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[index++] ?? { body: {} };
    if (step.raw) return new Response('', { status: step.status ?? 200 });
    return new Response(JSON.stringify(step.body ?? {}), {
      status: step.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// --- credentials -------------------------------------------------------------

test('a missing token names the variable and the per-environment trap', () => {
  assert.throws(() => tiktokCredentialsFromEnv({} as NodeJS.ProcessEnv), /TIKTOK_ACCESS_TOKEN/);
  assert.throws(() => tiktokCredentialsFromEnv({} as NodeJS.ProcessEnv), /per-environment/);
});

// --- the transfer mode, which is the whole design decision -------------------

test('init declares FILE_UPLOAD, never PULL_FROM_URL', async () => {
  // PULL_FROM_URL requires verifying ownership of the domain the file sits on.
  // The renders are on Tigris's domain, not the client's, so it can never be
  // verified. A silent switch here fails every post with a misleading error.
  const { fetcher, calls } = scriptedFetch([
    { body: { data: { publish_id: 'pub-1', upload_url: 'https://upload.test/x' } } },
    { raw: true, status: 200 },
  ]);

  await publishPhotoToTikTok(
    CREDS,
    { bytes: JPEG, mimeType: 'image/jpeg', title: 'hook' },
    { fetch: fetcher },
  );

  const init = JSON.parse(String(calls[0]!.init.body));
  assert.equal(init.source_info.source, 'FILE_UPLOAD');
  assert.equal(init.media_type, 'PHOTO');
  assert.equal(init.post_mode, 'DIRECT_POST');
  assert.equal(init.source_info.photo_images[0].image_size, JPEG.byteLength);
  assert.match(calls[0]!.url, /\/v2\/post\/publish\/content\/init\/$/);
});

test('the upload PUT carries a Content-Range covering the whole file', async () => {
  // Required even for a single chunk, and its absence fails with an error that
  // never mentions ranges.
  const { fetcher, calls } = scriptedFetch([
    { body: { data: { publish_id: 'pub-2', upload_url: 'https://upload.test/y' } } },
    { raw: true, status: 200 },
  ]);

  await publishPhotoToTikTok(
    CREDS,
    { bytes: JPEG, mimeType: 'image/jpeg', title: 'hook' },
    { fetch: fetcher },
  );

  const upload = calls[1]!;
  assert.equal(upload.url, 'https://upload.test/y');
  assert.equal(upload.init.method, 'PUT');
  const headers = upload.init.headers as Record<string, string>;
  assert.equal(headers['Content-Range'], `bytes 0-${JPEG.byteLength - 1}/${JPEG.byteLength}`);
  assert.equal(headers['Content-Type'], 'image/jpeg');
});

test('a failed upload says the post was initialised but nothing published', async () => {
  // The dangerous reading is "it got a publish_id, so it posted". It did not.
  const { fetcher } = scriptedFetch([
    { body: { data: { publish_id: 'pub-3', upload_url: 'https://upload.test/z' } } },
    { raw: true, status: 500 },
  ]);
  await assert.rejects(
    () =>
      publishPhotoToTikTok(
        CREDS,
        { bytes: JPEG, mimeType: 'image/jpeg', title: 'hook' },
        { fetch: fetcher },
      ),
    /bytes did not transfer, so nothing was published/,
  );
});

// --- validation before anything is spent -------------------------------------

test('photo posts are JPEG only, under 20 MB', () => {
  assert.equal(TIKTOK_MAX_PHOTO_BYTES, 20 * 1024 * 1024);
  assert.deepEqual(validatePhoto(JPEG, 'image/jpeg'), []);
  assert.equal(validatePhoto(JPEG, 'image/png').length, 1);
  assert.equal(validatePhoto(new Uint8Array(0), 'image/jpeg').length, 1);
  assert.equal(validatePhoto(new Uint8Array(TIKTOK_MAX_PHOTO_BYTES + 1), 'image/jpeg').length, 1);
});

test('an over-length title is refused before any call', async () => {
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      publishPhotoToTikTok(
        CREDS,
        { bytes: JPEG, mimeType: 'image/jpeg', title: 'x'.repeat(TIKTOK_MAX_TITLE + 1) },
        { fetch: fetcher },
      ),
    /over TikTok's 90 limit/,
  );
  assert.equal(calls.length, 0);
});

// --- errors ------------------------------------------------------------------

test('the audit-state error is translated, because it reads as a code fault', () => {
  assert.match(
    describeTikTokError('init', 403, 'unaudited_client_can_only_post_to_private_accounts', ''),
    /can only post PRIVATELY/,
  );
});

test('the domain-verification error flags that something switched transfer mode', () => {
  assert.match(
    describeTikTokError('init', 400, 'url_ownership_unverified', ''),
    /We use FILE_UPLOAD precisely to avoid it/,
  );
});

test('a file-format rejection points at the -web.jpg derivative', () => {
  assert.match(
    describeTikTokError('init', 400, 'file_format_check_failed', ''),
    /-web\.jpg derivative rather than a PNG master/,
  );
});

test('the access token never appears in an error message', () => {
  for (const code of ['rate_limit_exceeded', 'access_token_invalid', 'spam_risk_too_many_posts', '']) {
    const message = describeTikTokError('init', 400, code, 'some detail');
    assert.ok(!message.includes(TOKEN), `token leaked into the "${code}" message`);
  }
});

// --- the safety rail ---------------------------------------------------------

test('an EXPLICIT asset is refused with zero requests sent', async () => {
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      publishPhotoToTikTok(
        CREDS,
        {
          bytes: JPEG, mimeType: 'image/jpeg', title: 'hook',
          asset: { key: 'explicit/a.jpg', kind: 'image' },
        },
        { fetch: fetcher },
      ),
    /BLOCKED/,
  );
  assert.equal(calls.length, 0);
});

// --- against the REAL API ----------------------------------------------------

test('LIVE: open.tiktokapis.com parses our init body and rejects the TOKEN', async (t) => {
  let response: Response;
  try {
    response = await fetch(`${TIKTOK_API}/v2/post/publish/content/init/`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer not-a-real-token',
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify({
        media_type: 'PHOTO',
        post_mode: 'DIRECT_POST',
        post_info: { title: 't', privacy_level: 'SELF_ONLY' },
        source_info: { source: 'FILE_UPLOAD', photo_cover_index: 0, photo_images: [{ image_size: 6 }] },
      }),
    });
  } catch {
    t.skip(`no network to ${TIKTOK_API} — run with connectivity to prove the wire format`);
    return;
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: { code?: string; message?: string };
  };

  if (/rate.?limit/i.test(String(body.error?.code))) {
    t.skip('TikTok rate-limited us — inconclusive, re-run later');
    return;
  }

  // An access-token rejection means the URL, headers and JSON body were all
  // understood. A malformed body would come back as invalid_params instead.
  assert.ok(body.error?.code, 'a bogus token must not succeed');
  assert.match(
    String(body.error?.code),
    /access_token_invalid|scope_not_authorized|invalid_request/i,
    `expected a CREDENTIAL rejection, got ${body.error?.code}: ${body.error?.message}`,
  );
  assert.ok(
    !/invalid_params/i.test(String(body.error?.code)),
    `TikTok rejected the SHAPE of our request, not the token: ${body.error?.code}`,
  );
});
