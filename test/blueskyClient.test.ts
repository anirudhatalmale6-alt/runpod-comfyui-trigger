/**
 * Bluesky adapter tests.
 *
 * The mock here asserts the EXACT wire format taken from the AT Protocol
 * documentation, not from what I assumed the format was. That distinction is
 * the whole lesson of the RunPod adapter earlier in this project: its mock
 * accepted a bare graph under `input`, the live container required
 * `input.workflow`, and 27 green tests said nothing about the only thing that
 * mattered.
 *
 * So there is also a LIVE test. It calls the real bsky.social with deliberately
 * invalid credentials and asserts the server rejects them for being wrong
 * rather than for being malformed. That proves the request shape reaches a real
 * server and is parsed by it — without needing the client's account, which
 * lives only in their Trigger.dev variables and has never passed through here.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BlueskySession } from '../src/utils/blueskyClient.ts';

/**
 * blueskyClient.ts imports "./contentRouting.js", which is the specifier the
 * CLIENT's repo uses everywhere and which their esbuild pipeline resolves. Node's
 * type-stripping runner cannot follow it, because no .js file exists here.
 *
 * Rather than change the shipped source to suit the test runner — the source has
 * to be right for THEIR build, not for mine — the test does what
 * sweepStorage.test.ts already does: copy the real file, rewrite only that one
 * specifier, and import the result. What is under test stays byte-for-byte the
 * file the client installs apart from an import extension.
 */
let BLUESKY_SERVICE: string;
let MAX_BLOB_BYTES: number;
let MAX_IMAGES_PER_POST: number;
let MAX_POST_GRAPHEMES: number;
let blueskyCredentialsFromEnv: any;
let createSession: any;
let graphemeLength: any;
let postUrlFromUri: any;
let publishPost: any;
let validateImage: any;
let validatePostText: any;
let tempDir: string;

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-bsky');
  mkdirSync(tempDir, { recursive: true });

  // contentRouting has no repo-local imports, so it is copied untouched.
  copyFileSync(join(here, '..', 'src', 'utils', 'contentRouting.ts'), join(tempDir, 'contentRouting.ts'));

  const source = readFileSync(join(here, '..', 'src', 'utils', 'blueskyClient.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source, 'the import specifier under rewrite must actually be present');
  // A bad regex that gutted the file would otherwise pass every test below.
  assert.ok(rewritten.includes('assertPublishAllowed'), 'the safety guard must survive the rewrite');
  assert.ok(rewritten.includes('com.atproto.repo.createRecord'), 'the publish path must survive');
  writeFileSync(join(tempDir, 'blueskyClient.ts'), rewritten);

  const mod = await import(join(tempDir, 'blueskyClient.ts'));
  ({
    BLUESKY_SERVICE,
    MAX_BLOB_BYTES,
    MAX_IMAGES_PER_POST,
    MAX_POST_GRAPHEMES,
    blueskyCredentialsFromEnv,
    createSession,
    graphemeLength,
    postUrlFromUri,
    publishPost,
    validateImage,
    validatePostText,
  } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

const SESSION: BlueskySession = {
  accessJwt: 'jwt-access',
  refreshJwt: 'jwt-refresh',
  did: 'did:plc:abc123',
  handle: 'ava.bsky.social',
};

const PNG = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mimeType: 'image/png', alt: 'a render' };

/** Records every request so the exact wire format can be asserted. */
function recordingFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[index++] ?? { body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// --- credentials -------------------------------------------------------------

test('missing credentials name the variables rather than failing at first use', () => {
  assert.throws(() => blueskyCredentialsFromEnv({} as NodeJS.ProcessEnv), /BLUESKY_HANDLE/);
  assert.throws(
    () => blueskyCredentialsFromEnv({ BLUESKY_HANDLE: 'ava.bsky.social' } as NodeJS.ProcessEnv),
    /BLUESKY_APP_PASSWORD/,
  );
});

test('an account password in the app-password slot is REFUSED', () => {
  // It would work, which is exactly the problem — nobody would notice until it
  // leaked, and an account password cannot be revoked without changing it.
  assert.throws(
    () =>
      blueskyCredentialsFromEnv({
        BLUESKY_HANDLE: 'ava.bsky.social',
        BLUESKY_APP_PASSWORD: 'MyRealPassword123!',
      } as NodeJS.ProcessEnv),
    /does not look like an app password/,
  );
});

test('a properly formatted app password is accepted', () => {
  const creds = blueskyCredentialsFromEnv({
    BLUESKY_HANDLE: 'ava.bsky.social',
    BLUESKY_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
  } as NodeJS.ProcessEnv);
  assert.equal(creds.identifier, 'ava.bsky.social');
  assert.equal(creds.appPassword, 'abcd-efgh-ijkl-mnop');
});

// --- validation before anything is spent -------------------------------------

test('the blob limit is one MILLION bytes, not one mebibyte', () => {
  // 1048576 would be rejected by the server. Getting this wrong means a render
  // that "should fit" fails after the upload has already been paid for.
  assert.equal(MAX_BLOB_BYTES, 1_000_000);

  const justOver = validateImage({ ...PNG, bytes: new Uint8Array(1_000_001) });
  assert.equal(justOver.length, 1);
  assert.match(justOver[0]!, /over the 1000000-byte limit/);
  assert.match(justOver[0]!, /downscaled derivative/, 'must say what to do about it');

  assert.deepEqual(validateImage({ ...PNG, bytes: new Uint8Array(1_000_000) }), []);
});

test('unsupported image types are caught before the upload', () => {
  const problems = validateImage({ ...PNG, mimeType: 'image/gif' });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /not supported by Bluesky/);
});

test('validateImage reports EVERY problem at once', () => {
  // Fixing one, re-running, and discovering the next is how five minutes
  // becomes an afternoon.
  const problems = validateImage({ bytes: new Uint8Array(0), mimeType: 'image/gif', alt: 'x' });
  assert.equal(problems.length, 2, 'wrong type AND zero bytes');
});

test('post text is measured in graphemes so an emoji is one character', () => {
  assert.equal(graphemeLength('hello'), 5);
  assert.equal(graphemeLength('👍'), 1);
  // A skin-tone modifier is several code points but one grapheme. Counting
  // code units would reject a post Bluesky would have accepted.
  assert.equal(graphemeLength('👍🏽'), 1);
  assert.equal(graphemeLength('👨‍👩‍👧'), 1, 'a ZWJ sequence is one grapheme');

  assert.deepEqual(validatePostText('a'.repeat(MAX_POST_GRAPHEMES)), []);
  assert.equal(validatePostText('a'.repeat(MAX_POST_GRAPHEMES + 1)).length, 1);
  assert.deepEqual(validatePostText('👍🏽'.repeat(MAX_POST_GRAPHEMES)), [], '300 emoji still fit');
});

// --- the exact wire format ---------------------------------------------------

test('createSession sends identifier and password to the documented endpoint', async () => {
  const { fetcher, calls } = recordingFetch([
    { body: { accessJwt: 'a', refreshJwt: 'r', did: 'did:plc:x' } },
  ]);

  await createSession(
    { identifier: 'ava.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' },
    { fetch: fetcher },
  );

  assert.equal(calls[0]!.url, `${BLUESKY_SERVICE}/xrpc/com.atproto.server.createSession`);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
    identifier: 'ava.bsky.social',
    // The field is "password" even though the value is an app password.
    password: 'abcd-efgh-ijkl-mnop',
  });
});

test('uploadBlob sends RAW BYTES with the image mime type, not JSON', async () => {
  const { fetcher, calls } = recordingFetch([
    { body: { blob: { $type: 'blob', ref: { $link: 'bafkrei1' }, mimeType: 'image/png', size: 4 } } },
    { body: { uri: 'at://did:plc:abc123/app.bsky.feed.post/3k1', cid: 'cid1' } },
  ]);

  await publishPost(SESSION, { text: 'hello', images: [PNG] }, { fetch: fetcher });

  const upload = calls[0]!;
  assert.equal(upload.url, `${BLUESKY_SERVICE}/xrpc/com.atproto.repo.uploadBlob`);
  const headers = upload.init.headers as Record<string, string>;
  assert.equal(headers['Content-Type'], 'image/png', 'the blob content type is the IMAGE type');
  assert.equal(headers.Authorization, 'Bearer jwt-access');
  const body = upload.init.body as Blob;
  assert.ok(body instanceof Blob, 'raw bytes, never a JSON wrapper');
  assert.equal(body.size, PNG.bytes.byteLength, 'every byte, unmodified');
});

test('createRecord matches the documented record and embed shape exactly', async () => {
  const blob = { $type: 'blob', ref: { $link: 'bafkrei1' }, mimeType: 'image/png', size: 4 };
  const { fetcher, calls } = recordingFetch([
    { body: { blob } },
    { body: { uri: 'at://did:plc:abc123/app.bsky.feed.post/3k1', cid: 'cid1' } },
  ]);

  await publishPost(
    SESSION,
    { text: 'a caption', images: [PNG], langs: ['en'] },
    { fetch: fetcher, now: () => new Date('2026-09-17T09:00:00.000Z') },
  );

  const create = calls[1]!;
  assert.equal(create.url, `${BLUESKY_SERVICE}/xrpc/com.atproto.repo.createRecord`);
  const body = JSON.parse(String(create.init.body));

  assert.equal(body.repo, 'did:plc:abc123', 'repo is the DID from the session');
  assert.equal(body.collection, 'app.bsky.feed.post');
  assert.equal(body.record.$type, 'app.bsky.feed.post');
  assert.equal(body.record.text, 'a caption');
  // ISO 8601 with a Z suffix, per the docs.
  assert.equal(body.record.createdAt, '2026-09-17T09:00:00.000Z');
  assert.match(body.record.createdAt, /Z$/);
  assert.deepEqual(body.record.langs, ['en']);

  assert.deepEqual(body.record.embed, {
    $type: 'app.bsky.embed.images',
    images: [{ alt: 'a render', image: blob }],
  });
});

test('alt text is always present, because the lexicon requires it', async () => {
  const blob = { $type: 'blob', ref: { $link: 'b' }, mimeType: 'image/png', size: 4 };
  const { fetcher, calls } = recordingFetch([
    { body: { blob } },
    { body: { uri: 'at://did:plc:abc123/app.bsky.feed.post/3k1', cid: 'c' } },
  ]);

  await publishPost(SESSION, { text: 't', images: [{ ...PNG, alt: '' }] }, { fetch: fetcher });

  const embed = JSON.parse(String(calls[1]!.init.body)).record.embed;
  assert.equal(embed.images[0].alt, '', 'an empty string is allowed; an ABSENT field is not');
  assert.ok('alt' in embed.images[0], 'the key must exist even when empty');
});

test('a post with no images carries no embed key at all', async () => {
  const { fetcher, calls } = recordingFetch([
    { body: { uri: 'at://did:plc:abc123/app.bsky.feed.post/3k1', cid: 'c' } },
  ]);
  await publishPost(SESSION, { text: 'text only' }, { fetch: fetcher });
  const record = JSON.parse(String(calls[0]!.init.body)).record;
  assert.ok(!('embed' in record), 'an empty embed object would be a validation error');
});

test('more than four images is refused before anything is uploaded', async () => {
  const { fetcher, calls } = recordingFetch([]);
  await assert.rejects(
    () => publishPost(SESSION, { text: 't', images: Array(5).fill(PNG) }, { fetch: fetcher }),
    /maximum is 4/,
  );
  assert.equal(calls.length, 0, 'nothing was uploaded — the check runs first');
  assert.equal(MAX_IMAGES_PER_POST, 4);
});

// --- the safety rail, at the last possible moment -----------------------------

test('publishing an EXPLICIT asset to Bluesky is refused even here', async () => {
  const { fetcher, calls } = recordingFetch([]);
  await assert.rejects(
    () =>
      publishPost(
        SESSION,
        { text: 't', asset: { key: 'explicit/a.png', kind: 'image' } },
        { fetch: fetcher },
      ),
    /BLOCKED/,
  );
  assert.equal(calls.length, 0, 'no request left the process');
});

test('an unclassifiable asset is refused too', async () => {
  const { fetcher } = recordingFetch([]);
  await assert.rejects(
    () =>
      publishPost(
        SESSION,
        { text: 't', asset: { key: 'renders/a.png', kind: 'image' } },
        { fetch: fetcher },
      ),
    /classification cannot be read/,
  );
});

// --- errors name the method ---------------------------------------------------

test('a failed call reports the method, status and the server reason', async () => {
  const { fetcher } = recordingFetch([
    { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } },
  ]);
  await assert.rejects(
    () => createSession({ identifier: 'a', appPassword: 'abcd-efgh-ijkl-mnop' }, { fetch: fetcher }),
    /createSession failed: HTTP 401 — AuthenticationRequired: Invalid identifier or password/,
  );
});

test('postUrlFromUri builds a browsable link, or returns the URI untouched', () => {
  assert.equal(
    postUrlFromUri('at://did:plc:abc/app.bsky.feed.post/3k1', 'ava.bsky.social'),
    'https://bsky.app/profile/ava.bsky.social/post/3k1',
  );
  assert.equal(
    postUrlFromUri('at://did:plc:abc/app.bsky.feed.post/3k1'),
    'https://bsky.app/profile/did:plc:abc/post/3k1',
  );
  // Never produce a confidently wrong link.
  assert.equal(postUrlFromUri('not-an-at-uri'), 'not-an-at-uri');
});

// --- against the REAL server --------------------------------------------------

test('LIVE: bsky.social parses our createSession body and rejects the CREDENTIALS', async (t) => {
  // The point of this test: a mock only proves the code agrees with my beliefs.
  // This proves the request shape reaches the real server and is understood by
  // it. If the body were malformed we would get InvalidRequest; getting an
  // authentication error means the shape was fine and only the password was
  // wrong — which is exactly what we want to establish without holding the
  // client's credentials.
  let error: Error;
  try {
    await createSession({
      // A handle that cannot exist: .invalid is reserved by RFC 2606.
      identifier: 'no-such-account.invalid',
      appPassword: 'aaaa-bbbb-cccc-dddd',
    });
    assert.fail('bogus credentials must not succeed');
  } catch (caught) {
    error = caught as Error;
  }

  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(error.message)) {
    t.skip(`no network to ${BLUESKY_SERVICE} — run this with connectivity to prove the wire format`);
    return;
  }

  // A 429 is inconclusive, not a failure: the server understood us perfectly
  // and declined to answer. Failing the suite on it would mean a red build
  // caused by how often the suite itself has run, which teaches nobody
  // anything. It is also a reminder that this test calls a shared public
  // service — it should be run, but not hammered.
  if (/RateLimitExceeded|HTTP 429/i.test(error.message)) {
    t.skip(`${BLUESKY_SERVICE} rate-limited us — inconclusive, re-run later`);
    return;
  }

  assert.match(error.message, /createSession failed/);
  assert.match(
    error.message,
    /AuthenticationRequired|InvalidLogin|Invalid identifier or password|Unable to resolve handle/i,
    `expected a CREDENTIAL rejection, got: ${error.message}. An InvalidRequest here would mean ` +
      `our request body does not match what the server expects.`,
  );
  assert.ok(
    !/InvalidRequest|Malformed/i.test(error.message),
    `the server rejected the SHAPE of our request, not the credentials: ${error.message}`,
  );
});
