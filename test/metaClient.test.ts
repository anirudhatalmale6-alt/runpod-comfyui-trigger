/**
 * Instagram and Facebook adapter tests.
 *
 * The distinctive risk in this lane is that Meta FETCHES the media rather than
 * receiving it, so several failures happen on Meta's side after our call has
 * already returned a success. The tests below pin the two that cost the most:
 * a PNG reaching Instagram (rejected only after a container id has been handed
 * back), and a container being published while still IN_PROGRESS.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let instagramCredentialsFromEnv: any;
let facebookCredentialsFromEnv: any;
let publishToInstagram: any;
let publishToFacebook: any;
let describeMetaError: any;
let INSTAGRAM_MAX_CAPTION: number;
let GRAPH_API: string;
let tempDir: string;

const TOKEN = 'EAABsomethinglongandsecret';
const IG = { igUserId: '17841400000000000', accessToken: TOKEN };
const FB = { pageId: '100000000000000', pageAccessToken: TOKEN };

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-meta');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'metaClient.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source);
  assert.ok(rewritten.includes('assertPublishAllowed'), 'the safety guard must survive');
  writeFileSync(join(tempDir, 'metaClient.ts'), rewritten);

  const mod = await import(join(tempDir, 'metaClient.ts'));
  ({
    instagramCredentialsFromEnv, facebookCredentialsFromEnv,
    publishToInstagram, publishToFacebook, describeMetaError,
    INSTAGRAM_MAX_CAPTION, GRAPH_API,
  } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** Replays a scripted sequence of responses and records every request. */
function scriptedFetch(steps: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[index++] ?? { body: {} };
    return new Response(JSON.stringify(step.body), {
      status: step.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const noSleep = async () => {};

// --- credentials -------------------------------------------------------------

test('missing Meta credentials name the variables and the per-environment trap', () => {
  assert.throws(() => instagramCredentialsFromEnv({} as NodeJS.ProcessEnv), /INSTAGRAM_USER_ID/);
  assert.throws(() => instagramCredentialsFromEnv({} as NodeJS.ProcessEnv), /per-environment/);
  assert.throws(() => facebookCredentialsFromEnv({} as NodeJS.ProcessEnv), /FACEBOOK_PAGE_ID/);
});

test('an @handle in INSTAGRAM_USER_ID is refused with the reason', () => {
  // Pasting the handle, or the Facebook page id, is the classic mix-up here and
  // it surfaces from Meta as a permissions error rather than a bad id.
  assert.throws(
    () =>
      instagramCredentialsFromEnv({
        INSTAGRAM_USER_ID: '@avaines',
        INSTAGRAM_ACCESS_TOKEN: TOKEN,
      } as NodeJS.ProcessEnv),
    /numeric Instagram professional account id/,
  );
});

// --- the JPEG-only rule ------------------------------------------------------

test('a PNG is refused BEFORE the container call, not after', async () => {
  // Meta rejects a PNG only after returning a container id, so without this
  // check the failure looks like a publish bug rather than a format problem.
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      publishToInstagram(
        IG,
        { imageUrl: 'https://example.test/a.png', caption: 'hi', mimeType: 'image/png' },
        { fetch: fetcher, sleep: noSleep },
      ),
    /JPEG is the only image format/,
  );
  assert.equal(calls.length, 0, 'no request left the process');
});

test('a JPEG passes the format check', async () => {
  const { fetcher } = scriptedFetch([
    { body: { id: '1789' } },
    { body: { status_code: 'FINISHED' } },
    { body: { id: '9999' } },
  ]);
  const result = await publishToInstagram(
    IG,
    { imageUrl: 'https://example.test/a.jpg', caption: 'hi', mimeType: 'image/jpeg' },
    { fetch: fetcher, sleep: noSleep },
  );
  assert.equal(result.id, '9999');
});

// --- the two-step flow -------------------------------------------------------

test('Instagram creates a container, waits for FINISHED, then publishes', async () => {
  const { fetcher, calls } = scriptedFetch([
    { body: { id: 'container-1' } },
    { body: { status_code: 'IN_PROGRESS' } },
    { body: { status_code: 'FINISHED' } },
    { body: { id: 'post-1' } },
  ]);

  const result = await publishToInstagram(
    IG,
    { imageUrl: 'https://example.test/a.jpg', caption: 'a caption' },
    { fetch: fetcher, sleep: noSleep },
  );

  assert.match(calls[0]!.url, /\/17841400000000000\/media$/);
  const created = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(created.get('image_url'), 'https://example.test/a.jpg');
  assert.equal(created.get('caption'), 'a caption');
  assert.equal(created.get('access_token'), TOKEN);

  // It must NOT have published while the container was still IN_PROGRESS.
  assert.match(calls[1]!.url, /container-1\?fields=status_code/);
  assert.match(calls[2]!.url, /container-1\?fields=status_code/);

  assert.match(calls[3]!.url, /\/media_publish$/);
  assert.equal(new URLSearchParams(String(calls[3]!.init.body)).get('creation_id'), 'container-1');
  assert.equal(result.id, 'post-1');
});

test('a container that goes to ERROR explains what it usually means', async () => {
  const { fetcher } = scriptedFetch([
    { body: { id: 'container-2' } },
    { body: { status_code: 'ERROR', status: 'Media download failed' } },
  ]);
  await assert.rejects(
    () =>
      publishToInstagram(
        IG,
        { imageUrl: 'https://example.test/a.jpg', caption: 'c' },
        { fetch: fetcher, sleep: noSleep },
      ),
    /could not download or could not accept the image/,
  );
});

test('Facebook posts a page photo in ONE step, with published=true', async () => {
  const { fetcher, calls } = scriptedFetch([{ body: { id: 'photo-1', post_id: 'page_post-1' } }]);

  const result = await publishToFacebook(
    FB,
    { imageUrl: 'https://example.test/a.jpg', caption: 'hello' },
    { fetch: fetcher },
  );

  assert.equal(calls.length, 1, 'Facebook is one call, unlike Instagram');
  assert.match(calls[0]!.url, /\/100000000000000\/photos$/);
  const body = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(body.get('url'), 'https://example.test/a.jpg');
  assert.equal(body.get('published'), 'true');
  // post_id is the one a human can open; id is the photo object.
  assert.equal(result.id, 'page_post-1');
});

// --- errors ------------------------------------------------------------------

test('the access token never appears in an error message', () => {
  for (const code of [190, 200, 10, 4, 9004, 1]) {
    const message = describeMetaError('publish media', 400, {
      error: { message: 'Unsupported post request', code },
    });
    assert.ok(!message.includes(TOKEN), `token leaked into the code ${code} message`);
    assert.match(message, /publish media/, 'the step is named instead');
  }
});

test('Meta error codes are translated into causes, not passed through', () => {
  assert.match(
    describeMetaError('x', 400, { error: { code: 190, message: 'Invalid OAuth' } }),
    /expire in about an hour/,
  );
  assert.match(
    describeMetaError('x', 403, { error: { code: 200, message: 'Permissions error' } }),
    /PERMISSIONS problem, not a bad request/,
  );
  assert.match(
    describeMetaError('x', 400, { error: { code: 9004, message: 'media fetch' } }),
    /presigned and short-lived/,
  );
});

test('a caption over the limit is refused before any call', async () => {
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      publishToInstagram(
        IG,
        { imageUrl: 'https://example.test/a.jpg', caption: 'x'.repeat(INSTAGRAM_MAX_CAPTION + 1) },
        { fetch: fetcher, sleep: noSleep },
      ),
    /over Instagram's 2200 limit/,
  );
  assert.equal(calls.length, 0);
});

// --- the safety rail ---------------------------------------------------------

test('an EXPLICIT asset is refused on both Meta lanes', async () => {
  const explicit = { key: 'explicit/a.jpg', kind: 'image' as const };
  for (const [fn, creds] of [[publishToInstagram, IG], [publishToFacebook, FB]] as const) {
    const { fetcher, calls } = scriptedFetch([]);
    await assert.rejects(
      () =>
        fn(creds as never, {
          imageUrl: 'https://example.test/a.jpg', caption: 'c', asset: explicit,
        } as never, { fetch: fetcher, sleep: noSleep }),
      /BLOCKED/,
    );
    assert.equal(calls.length, 0, 'no request left the process');
  }
});

// --- against the REAL API ----------------------------------------------------

test('LIVE: graph.facebook.com parses our request and rejects the TOKEN', async (t) => {
  // Same technique as the Bluesky and Telegram probes: prove the request shape
  // reaches a real server and is understood, using no client credentials. A
  // malformed request gives a different error class than a bad token.
  let response: Response;
  try {
    response = await fetch(`${GRAPH_API}/v21.0/me?access_token=definitely-not-a-real-token`);
  } catch {
    t.skip(`no network to ${GRAPH_API} — run with connectivity to prove the wire format`);
    return;
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: number; type?: string };
  };

  assert.ok(body.error, 'a bogus token must not succeed');
  assert.equal(body.error?.code, 190, `expected OAuth code 190, got ${body.error?.code}`);
  assert.match(String(body.error?.type), /OAuthException/);

  // And our formatter turns that into something actionable.
  const message = describeMetaError('me', response.status, body as never);
  assert.match(message, /access token is invalid or expired/);
});
