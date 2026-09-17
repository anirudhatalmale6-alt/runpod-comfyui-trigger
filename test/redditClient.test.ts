/**
 * Reddit adapter tests.
 *
 * Two things here are worth more than all the others put together:
 *
 *   1. A REJECTED POST COMES BACK AS HTTP 200. Reddit puts the reason in
 *      json.errors. An adapter that trusts response.ok reports a banned,
 *      flair-less or rate-limited submission as published, the scheduler marks
 *      the slot used, and the post simply never exists. Several tests below
 *      exist only to make that impossible.
 *
 *   2. Explicit material is gated per SUBREDDIT, not per platform, because
 *      Reddit's rules are per-community. The platform rail and the subreddit
 *      gate are tested separately AND together.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let redditCredentialsFromEnv: any;
let defaultUserAgent: any;
let getAccessToken: any;
let submitPost: any;
let uploadMedia: any;
let publishToReddit: any;
let assertSubredditAccepts: any;
let describeRedditError: any;
let describeSubmitError: any;
let MAX_TITLE_LENGTH: number;
let REDDIT_AUTH_API: string;
let tempDir: string;

const SECRET = 'sUp3r-s3cret-client-value';
const PASSWORD = 'hunter2-not-in-any-message';
const CREDS = {
  clientId: 'abcdefghijklmn',
  clientSecret: SECRET,
  username: 'avaines',
  password: PASSWORD,
  userAgent: 'nodejs:com.avaautomation.publisher:v1.0 (by /u/avaines)',
};
const SESSION = { accessToken: 'bearer-token-value', expiresIn: 3600 };

const SAFE_SUB = { name: 'testingground4bots', allowsExplicit: false };

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-reddit');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'redditClient.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source, 'the import rewrite must have applied');
  assert.ok(rewritten.includes('assertPublishAllowed'), 'the platform rail must survive');
  assert.ok(rewritten.includes('json.errors'), 'the 200-with-errors comment must survive');
  writeFileSync(join(tempDir, 'redditClient.ts'), rewritten);

  const mod = await import(join(tempDir, 'redditClient.ts'));
  ({
    redditCredentialsFromEnv, defaultUserAgent, getAccessToken, submitPost, uploadMedia,
    publishToReddit, assertSubredditAccepts, describeRedditError, describeSubmitError,
    MAX_TITLE_LENGTH, REDDIT_AUTH_API,
  } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** Replays scripted responses and records every request. */
function scriptedFetch(steps: Array<{ status?: number; body: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const step = steps[index++] ?? { body: {} };
    const body = step.text !== undefined ? step.text : JSON.stringify(step.body);
    return new Response(body, {
      status: step.status ?? 200,
      headers: { 'Content-Type': step.text !== undefined ? 'text/xml' : 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// --- credentials -------------------------------------------------------------

test('missing Reddit credentials name the variables and the per-environment trap', () => {
  assert.throws(() => redditCredentialsFromEnv({} as NodeJS.ProcessEnv), /REDDIT_CLIENT_ID/);
  assert.throws(() => redditCredentialsFromEnv({} as NodeJS.ProcessEnv), /REDDIT_PASSWORD/);
  assert.throws(() => redditCredentialsFromEnv({} as NodeJS.ProcessEnv), /per-environment/);
});

const withAgent = (userAgent: string) =>
  ({
    REDDIT_CLIENT_ID: 'x', REDDIT_CLIENT_SECRET: 'y',
    REDDIT_USERNAME: 'avaines', REDDIT_PASSWORD: 'z',
    REDDIT_USER_AGENT: userAgent,
  }) as NodeJS.ProcessEnv;

test('the BARE Mozilla/5.0 agent is refused, and says it is blocked outright', () => {
  // Verified live, three runs: this exact string returns 403 where a full
  // browser agent with the SAME bogus credentials returns 401. The bare generic
  // value is the one Reddit hard-blocks.
  assert.throws(() => redditCredentialsFromEnv(withAgent('Mozilla/5.0')), /blocks outright/);
});

test('a full browser agent is refused too, but for the RATE LIMIT reason', () => {
  // This one is our own policy, not a measured block — Reddit lets it through
  // to the credential check. The message must not claim otherwise, because a
  // wrong reason sends somebody debugging the wrong thing.
  const message = (() => {
    try {
      redditCredentialsFromEnv(withAgent('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0'));
      return '';
    } catch (error) {
      return (error as Error).message;
    }
  })();
  assert.match(message, /must not impersonate a browser/);
  assert.match(message, /about rate limiting rather than access/);
  assert.ok(!/blocks outright/.test(message), 'must not claim a block that was not measured');
});

test('a /u/ prefix on the username is tolerated, not passed through', () => {
  const creds = redditCredentialsFromEnv({
    REDDIT_CLIENT_ID: 'x', REDDIT_CLIENT_SECRET: 'y',
    REDDIT_USERNAME: '/u/avaines', REDDIT_PASSWORD: 'z',
  } as NodeJS.ProcessEnv);
  assert.equal(creds.username, 'avaines');
  assert.match(creds.userAgent, /by \/u\/avaines/);
});

test('the default User-Agent follows the documented form', () => {
  const ua = defaultUserAgent('avaines');
  assert.match(ua, /^[a-z]+:[\w.]+:v[\d.]+ \(by \/u\/avaines\)$/);
  assert.ok(!/^Mozilla/.test(ua));
});

// --- the token call ----------------------------------------------------------

test('the token call uses Basic auth, the password grant, and the User-Agent', async () => {
  const { fetcher, calls } = scriptedFetch([
    { body: { access_token: 'tok', expires_in: 86400 } },
  ]);
  const session = await getAccessToken(CREDS, { fetch: fetcher });

  assert.equal(session.accessToken, 'tok');
  assert.match(calls[0]!.url, /www\.reddit\.com\/api\/v1\/access_token$/);

  const headers = calls[0]!.init.headers as Record<string, string>;
  const expected = Buffer.from(`${CREDS.clientId}:${SECRET}`).toString('base64');
  assert.equal(headers.Authorization, `Basic ${expected}`);
  assert.equal(headers['User-Agent'], CREDS.userAgent);

  const body = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(body.get('grant_type'), 'password');
  assert.equal(body.get('username'), 'avaines');
});

test('a 403 on the token call blames the User-Agent, a 401 blames the app type', async () => {
  for (const [status, pattern] of [[403, /USER-AGENT/], [401, /"script" type app/]] as const) {
    const { fetcher } = scriptedFetch([{ status, body: {} }]);
    await assert.rejects(() => getAccessToken(CREDS, { fetch: fetcher }), pattern);
  }
});

test('a 200 token response with no access_token is not treated as a session', async () => {
  const { fetcher } = scriptedFetch([{ body: { error: 'invalid_grant' } }]);
  await assert.rejects(() => getAccessToken(CREDS, { fetch: fetcher }), /invalid_grant/);
});

// --- THE TRAP: a rejected post returns HTTP 200 ------------------------------

test('a 200 carrying json.errors THROWS rather than reporting a published post', async () => {
  const { fetcher } = scriptedFetch([
    {
      status: 200,
      body: { json: { errors: [['SUBREDDIT_NOEXIST', "that subreddit doesn't exist", 'sr']] } },
    },
  ]);
  await assert.rejects(
    () => submitPost(SESSION, CREDS, { subreddit: SAFE_SUB, title: 'hi' }, { fetch: fetcher }),
    /REJECTED/,
  );
});

test('the 200-with-errors message says the status was 200, so nobody hunts a 4xx', async () => {
  const { fetcher } = scriptedFetch([
    { status: 200, body: { json: { errors: [['RATELIMIT', 'you are doing that too much']] } } },
  ]);
  await assert.rejects(
    () => submitPost(SESSION, CREDS, { subreddit: SAFE_SUB, title: 'hi' }, { fetch: fetcher }),
    /answered HTTP 200/,
  );
});

test('every submit error code we translate stays translated', async () => {
  const cases: Array<[string, RegExp]> = [
    ['SUBREDDIT_NOEXIST', /without the "r\/" prefix/],
    ['SUBREDDIT_NOTALLOWED', /minimum karma or account age/],
    ['SUBMIT_VALIDATION_FLAIR_REQUIRED', /requires a post flair/],
    ['RATELIMIT', /the account itself is limited/],
    ['NO_LINKS', /does not accept link or image posts/],
    ['IN_TIMEOUT', /posting timeout/],
  ];
  for (const [code, pattern] of cases) {
    assert.match(describeSubmitError(code, 'some message'), pattern, `${code} lost its guidance`);
  }
  // An unknown code must still surface the raw text rather than vanishing.
  assert.match(describeSubmitError('WAT', 'unknown thing'), /WAT: unknown thing/);
});

test('a 200 with neither an error nor an id is NOT reported as published', async () => {
  // The quiet one: Reddit changes a response shape, errors is empty, and we
  // return a result object full of undefined while the post does not exist.
  const { fetcher } = scriptedFetch([{ status: 200, body: { json: { errors: [] } } }]);
  await assert.rejects(
    () => submitPost(SESSION, CREDS, { subreddit: SAFE_SUB, title: 'hi' }, { fetch: fetcher }),
    /Refusing to report this as published/,
  );
});

test('a genuinely successful submit returns the fullname, id and url', async () => {
  const { fetcher, calls } = scriptedFetch([
    {
      body: {
        json: {
          errors: [],
          data: { name: 't3_abc123', id: 'abc123', url: 'https://www.reddit.com/r/x/comments/abc123/t/' },
        },
      },
    },
  ]);
  const result = await submitPost(
    SESSION, CREDS, { subreddit: SAFE_SUB, title: 'a real title' }, { fetch: fetcher },
  );
  assert.equal(result.name, 't3_abc123');
  assert.equal(result.id, 'abc123');
  assert.match(result.url, /comments\/abc123/);
  assert.match(calls[0]!.url, /oauth\.reddit\.com\/api\/submit$/);
});

// --- submit parameters -------------------------------------------------------

test('api_type=json is always sent, because the errors only appear with it', async () => {
  const { fetcher, calls } = scriptedFetch([
    { body: { json: { errors: [], data: { name: 't3_a', id: 'a', url: 'u' } } } },
  ]);
  await submitPost(SESSION, CREDS, { subreddit: SAFE_SUB, title: 't' }, { fetch: fetcher });
  assert.equal(new URLSearchParams(String(calls[0]!.init.body)).get('api_type'), 'json');
});

test('flair, nsfw and resubmit ride along when the subreddit declares them', async () => {
  const { fetcher, calls } = scriptedFetch([
    { body: { json: { errors: [], data: { name: 't3_a', id: 'a', url: 'u' } } } },
  ]);
  await submitPost(
    SESSION, CREDS,
    {
      subreddit: { name: 'x', allowsExplicit: false, flairId: 'flair-uuid', flairText: 'OC', markNsfw: true },
      title: 't',
      imageUrl: 'https://i.redd.it/a.jpg',
    },
    { fetch: fetcher },
  );
  const body = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(body.get('flair_id'), 'flair-uuid');
  assert.equal(body.get('flair_text'), 'OC');
  assert.equal(body.get('nsfw'), 'true');
  assert.equal(body.get('kind'), 'image');
  assert.equal(body.get('url'), 'https://i.redd.it/a.jpg');
  // Without resubmit, posting the same image again is refused as ALREADY_SUB.
  assert.equal(body.get('resubmit'), 'true');
});

test('a title over 300 characters is refused before any call', async () => {
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      submitPost(
        SESSION, CREDS,
        { subreddit: SAFE_SUB, title: 'x'.repeat(MAX_TITLE_LENGTH + 1) },
        { fetch: fetcher },
      ),
    /over the 300 limit/,
  );
  assert.equal(calls.length, 0, 'no request left the process');
});

test('an empty title is refused, because Reddit requires one', async () => {
  const { fetcher } = scriptedFetch([]);
  await assert.rejects(
    () => submitPost(SESSION, CREDS, { subreddit: SAFE_SUB, title: '   ' }, { fetch: fetcher }),
    /title is empty/,
  );
});

// --- the per-subreddit gate --------------------------------------------------

test('explicit content is refused unless THIS subreddit has opted in by name', () => {
  const explicit = { key: 'explicit/a.jpg', kind: 'image' as const };
  assert.throws(
    () => assertSubredditAccepts({ name: 'somesub', allowsExplicit: false }, explicit),
    /has not been marked as accepting explicit/,
  );
  // And the opt-in works, so the gate is a gate rather than a wall.
  assert.doesNotThrow(() =>
    assertSubredditAccepts({ name: 'somesub', allowsExplicit: true }, explicit),
  );
});

test('an unclassifiable asset reaches no subreddit, opted in or not', () => {
  for (const allowsExplicit of [false, true]) {
    assert.throws(
      () => assertSubredditAccepts({ name: 'somesub', allowsExplicit }, { key: 'renders/x.jpg', kind: 'image' }),
      /cannot classify/,
    );
  }
});

test('the PLATFORM rail refuses explicit content even for an opted-in subreddit', async () => {
  // Defence in depth. PLATFORMS.reddit is safe-only today, so even a subreddit
  // marked allowsExplicit must not get explicit material until that platform
  // entry is widened deliberately.
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      submitPost(
        SESSION, CREDS,
        {
          subreddit: { name: 'somesub', allowsExplicit: true },
          title: 't',
          asset: { key: 'explicit/a.jpg', kind: 'image' },
        },
        { fetch: fetcher },
      ),
    /BLOCKED/,
  );
  assert.equal(calls.length, 0, 'no request left the process');
});

// --- media upload ------------------------------------------------------------

test('an image upload leases from Reddit, posts to S3, and reads the Location back', async () => {
  const { fetcher, calls } = scriptedFetch([
    {
      body: {
        args: {
          action: '//reddit-uploaded-media.s3-accelerate.amazonaws.com',
          fields: [
            { name: 'acl', value: 'private' },
            { name: 'key', value: 'abc/def.jpg' },
          ],
        },
      },
    },
    { text: '<PostResponse><Location>https%3A//i.redd.it/abc.jpg</Location></PostResponse>' },
  ]);

  const url = await uploadMedia(
    SESSION, CREDS,
    { bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg', filename: 'a.jpg' },
    { fetch: fetcher },
  );

  assert.match(calls[0]!.url, /oauth\.reddit\.com\/api\/media\/asset\.json$/);
  // Reddit hands back a protocol-relative URL; posting to "//host" would fail.
  assert.equal(calls[1]!.url, 'https://reddit-uploaded-media.s3-accelerate.amazonaws.com');
  assert.ok(calls[1]!.init.body instanceof FormData, 'S3 needs multipart, not urlencoded');

  const form = calls[1]!.init.body as FormData;
  assert.equal(form.get('acl'), 'private');
  assert.equal(form.get('key'), 'abc/def.jpg');
  assert.ok(form.get('file'), 'the bytes must be attached');

  // The Location comes back percent-encoded.
  assert.equal(url, 'https://i.redd.it/abc.jpg');
});

test('an S3 response with no Location is a FAILURE, not an empty success', async () => {
  const { fetcher } = scriptedFetch([
    { body: { args: { action: '//s3.test', fields: [{ name: 'k', value: 'v' }] } } },
    { text: '<PostResponse></PostResponse>' },
  ]);
  await assert.rejects(
    () =>
      uploadMedia(
        SESSION, CREDS,
        { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'a.jpg' },
        { fetch: fetcher },
      ),
    /no <Location>/,
  );
});

test('a lease with no fields is refused rather than posted to blindly', async () => {
  const { fetcher } = scriptedFetch([{ body: { args: { action: '//s3.test', fields: [] } } }]);
  await assert.rejects(
    () =>
      uploadMedia(
        SESSION, CREDS,
        { bytes: new Uint8Array([1]), mimeType: 'image/jpeg', filename: 'a.jpg' },
        { fetch: fetcher },
      ),
    /no action or no fields/,
  );
});

test('an unsupported type or zero bytes never reaches Reddit', async () => {
  const { fetcher, calls } = scriptedFetch([]);
  await assert.rejects(
    () =>
      uploadMedia(SESSION, CREDS, { bytes: new Uint8Array([1]), mimeType: 'image/webp', filename: 'a.webp' }, { fetch: fetcher }),
    /not one of/,
  );
  await assert.rejects(
    () =>
      uploadMedia(SESSION, CREDS, { bytes: new Uint8Array([]), mimeType: 'image/jpeg', filename: 'a.jpg' }, { fetch: fetcher }),
    /zero bytes/,
  );
  assert.equal(calls.length, 0);
});

// --- secrets -----------------------------------------------------------------

test('no error message contains the password, the secret or the bearer token', async () => {
  const messages: string[] = [];

  for (const status of [401, 403, 429, 500]) {
    const { fetcher } = scriptedFetch([{ status, body: { error: SECRET } }]);
    await getAccessToken(CREDS, { fetch: fetcher }).catch((e: Error) => messages.push(e.message));
  }
  const { fetcher } = scriptedFetch([
    { status: 200, body: { json: { errors: [['RATELIMIT', 'too much']] } } },
  ]);
  await submitPost(SESSION, CREDS, { subreddit: SAFE_SUB, title: 't' }, { fetch: fetcher })
    .catch((e: Error) => messages.push(e.message));

  assert.ok(messages.length >= 5, 'the failures must actually have been collected');
  for (const message of messages) {
    assert.ok(!message.includes(SECRET), `client secret leaked: ${message}`);
    assert.ok(!message.includes(PASSWORD), `password leaked: ${message}`);
    assert.ok(!message.includes(SESSION.accessToken), `bearer token leaked: ${message}`);
  }
});

test('describeRedditError never echoes a body back', () => {
  const message = describeRedditError('token request', 401, '');
  assert.ok(!message.includes(SECRET));
  assert.match(message, /token request/);
});

// --- the whole lane ----------------------------------------------------------

test('publishToReddit uploads then submits, in that order', async () => {
  const { fetcher, calls } = scriptedFetch([
    { body: { access_token: 'tok', expires_in: 3600 } },
    { body: { args: { action: '//s3.test', fields: [{ name: 'k', value: 'v' }] } } },
    { text: '<PostResponse><Location>https%3A//i.redd.it/z.jpg</Location></PostResponse>' },
    { body: { json: { errors: [], data: { name: 't3_z', id: 'z', url: 'https://reddit.test/z' } } } },
  ]);

  const result = await publishToReddit(
    CREDS,
    {
      subreddit: SAFE_SUB,
      title: 'a title',
      media: { bytes: new Uint8Array([1, 2]), mimeType: 'image/jpeg', filename: 'a.jpg' },
      asset: { key: 'safe/a.jpg', kind: 'image' },
    },
    { fetch: fetcher },
  );

  assert.equal(result.id, 'z');
  assert.match(calls[0]!.url, /access_token$/);
  assert.match(calls[3]!.url, /api\/submit$/);
  // The submitted url must be the one S3 returned, not the original asset key.
  assert.equal(new URLSearchParams(String(calls[3]!.init.body)).get('url'), 'https://i.redd.it/z.jpg');
});

// --- against the REAL API ----------------------------------------------------

test('LIVE: Reddit checks the User-Agent BEFORE the credentials', async (t) => {
  // This is the finding the whole User-Agent guard rests on, so it is verified
  // against the real endpoint rather than asserted from documentation. Bogus
  // credentials throughout — no client value is used.
  const body = new URLSearchParams({
    grant_type: 'password', username: 'x', password: 'y',
  }).toString();
  const basic = Buffer.from('notareal:clientsecret').toString('base64');

  const call = (userAgent: string) =>
    fetch(`${REDDIT_AUTH_API}/api/v1/access_token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
      },
      body,
    });

  let descriptive: Response;
  let bare: Response;
  let fullBrowser: Response;
  try {
    descriptive = await call('nodejs:com.avaautomation.publisher:v1.0 (by /u/testing)');
    bare = await call('Mozilla/5.0');
    fullBrowser = await call(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    );
  } catch {
    t.skip(`no network to ${REDDIT_AUTH_API} — run with connectivity to prove this`);
    return;
  }

  for (const response of [descriptive, bare, fullBrowser]) {
    if (response.status === 429) {
      t.skip('Reddit rate limited this probe — inconclusive rather than failing');
      return;
    }
  }

  assert.equal(descriptive.status, 401, 'a descriptive agent should reach the credential check');
  assert.equal(bare.status, 403, 'the BARE generic agent should be refused before it');
  // The distinction that corrected this file: browser-shaped is not the rule.
  assert.equal(
    fullBrowser.status,
    401,
    'a FULL browser agent does reach the credential check — the block is on the bare string',
  );
});
