/**
 * publishDoctor tests.
 *
 * The thing this file is really defending is the difference between "we did not
 * ask" and "it passed". A doctor that renders an unattempted check as OK is
 * worse than no doctor, because it converts an unknown into a false assurance —
 * and the whole reason this exists is that a presence check already did exactly
 * that.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let runPublishDoctor: any;
let summarise: any;
let LANES: any[];
let tempDir: string;

const FULL_ENV = {
  BLUESKY_HANDLE: 'ava.bsky.social',
  BLUESKY_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
  TELEGRAM_BOT_TOKEN: '123456:AAbbCCddEEffGGhhIIjjKKllMMnnOOpp',
  TELEGRAM_CHANNEL_CHAT_ID: '@AvaInesOfficial',
  INSTAGRAM_USER_ID: '17841400000000000',
  INSTAGRAM_ACCESS_TOKEN: 'EAAsecretinstagram',
  FACEBOOK_PAGE_ID: '100000000000000',
  FACEBOOK_PAGE_ACCESS_TOKEN: 'EAAsecretfacebook',
  TIKTOK_ACCESS_TOKEN: 'act.secrettiktok',
  REDDIT_CLIENT_ID: 'abcdefghijklmn',
  REDDIT_CLIENT_SECRET: 'secretreddit',
  REDDIT_USERNAME: 'avaines',
  REDDIT_PASSWORD: 'secretpassword',
} as NodeJS.ProcessEnv;

const SECRETS = [
  'abcd-efgh-ijkl-mnop', 'AAbbCCddEEffGGhhIIjjKKllMMnnOOpp', 'EAAsecretinstagram',
  'EAAsecretfacebook', 'act.secrettiktok', 'secretreddit', 'secretpassword',
];

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-doctor');
  mkdirSync(tempDir, { recursive: true });
  for (const name of ['contentRouting', 'envReport']) {
    copyFileSync(join(here, '..', 'src', 'utils', `${name}.ts`), join(tempDir, `${name}.ts`));
  }
  const source = readFileSync(join(here, '..', 'src', 'utils', 'publishDoctor.ts'), 'utf8');
  const rewritten = source.replace(/from "\.\/([A-Za-z]+)\.js"/g, 'from "./$1.ts"');
  assert.notEqual(rewritten, source);
  assert.ok(rewritten.includes('getChatMember'), 'the Telegram admin check must survive');
  writeFileSync(join(tempDir, 'publishDoctor.ts'), rewritten);

  const mod = await import(join(tempDir, 'publishDoctor.ts'));
  ({ runPublishDoctor, summarise, LANES } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

/** Routes by URL substring so lanes can be scripted independently. */
function routedFetch(routes: Array<[RegExp, { status?: number; body: unknown }]>) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    calls.push(href);
    for (const [pattern, response] of routes) {
      if (pattern.test(href)) {
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({}), { status: 500 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const HAPPY: Array<[RegExp, { status?: number; body: unknown }]> = [
  [/createSession/, { body: { handle: 'ava.bsky.social', did: 'did:plc:x' } }],
  [/getMe/, { body: { ok: true, result: { id: 123456, username: 'ava_ines_publish_bot' } } }],
  [/getChat\?/, { body: { ok: true, result: { title: 'Ava Ines Official', type: 'channel' } } }],
  [/getChatMember/, { body: { ok: true, result: { status: 'administrator', can_post_messages: true } } }],
  [/17841400000000000/, { body: { username: 'avaines' } }],
  [/100000000000000/, { body: { name: 'Ava Ines Page' } }],
  [/open\.tiktokapis\.com/, { body: { data: { user: { display_name: 'Ava' } } } }],
  [/access_token$/, { body: { access_token: 'tok', expires_in: 3600 } }],
  [/api\/v1\/me/, { body: { name: 'avaines' } }],
];

// --- the central distinction --------------------------------------------------

test('an UNCONFIGURED lane is never reported as reachable', async () => {
  const { fetcher, calls } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', { env: {} as NodeJS.ProcessEnv, fetch: fetcher });

  for (const lane of report.lanes) {
    assert.equal(lane.configured, false, `${lane.label} should be unconfigured`);
    assert.equal(lane.reachable, null, `${lane.label} must be null, not false and not true`);
  }
  assert.deepEqual(report.ready, [], 'nothing is ready');
  assert.deepEqual(report.broken, [], 'unconfigured is NOT broken — it is "not asked"');
  assert.equal(report.unconfigured.length, LANES.length);
  assert.equal(calls.length, 0, 'no network call may be made for an unconfigured lane');
});

test('offline mode makes no calls and still reports null rather than OK', async () => {
  const { fetcher, calls } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', {
    env: FULL_ENV, fetch: fetcher, offline: true,
  });
  assert.equal(calls.length, 0);
  assert.ok(report.lanes.every((l: any) => l.configured === true));
  assert.ok(report.lanes.every((l: any) => l.reachable === null));
  assert.deepEqual(report.ready, [], 'a configured lane that was never asked is not ready');
});

test('the summary has FOUR states and never collapses "not asked" into either neighbour', async () => {
  // Reporting an unchecked lane as OK invents an assurance. Reporting it as
  // FAIL sends somebody debugging a lane that was never tested. Both are wrong,
  // and the first version of this function did the second one.
  const { fetcher } = routedFetch(HAPPY);

  const skipped = summarise(
    await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher, offline: true }),
  );
  assert.ok(
    skipped.every((line: string) => line.startsWith('SKIP')),
    `configured but unchecked must read SKIP, got: ${skipped[0]}`,
  );
  assert.ok(skipped.every((line: string) => !line.startsWith('OK')));
  assert.ok(skipped.every((line: string) => !line.startsWith('FAIL')));

  // Not configured at all is a fourth state again — not a failure.
  const absent = summarise(
    await runPublishDoctor('prod', { env: {} as NodeJS.ProcessEnv, fetch: fetcher }),
  );
  assert.ok(absent.every((line: string) => line.startsWith('-')), 'unset must read "-"');

  const online = summarise(await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher }));
  assert.ok(online.every((line: string) => line.startsWith('OK')), 'a real pass should read OK');

  // And a genuine refusal must read FAIL, or the state is unreachable.
  const { fetcher: broken } = routedFetch([
    [/open\.tiktokapis\.com/, { status: 401, body: { error: { code: 'access_token_invalid' } } }],
    ...HAPPY,
  ]);
  const mixed = summarise(await runPublishDoctor('prod', { env: FULL_ENV, fetch: broken }));
  assert.ok(mixed.some((line: string) => line.startsWith('FAIL TikTok')), 'a refusal reads FAIL');
});

// --- the happy path ----------------------------------------------------------

test('every lane green reports every platform ready', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  assert.deepEqual(
    [...report.ready].sort(),
    ['bluesky', 'facebook', 'instagram', 'reddit', 'telegram', 'tiktok'],
  );
  assert.deepEqual(report.broken, []);
});

// --- Telegram, the lane this file was written for ----------------------------

test('Telegram: a bot that is only a MEMBER is reported broken, not ready', async () => {
  // The exact trap: it can see the channel, so getChat succeeds. Membership is
  // not permission, and a publish would 403.
  const { fetcher } = routedFetch([
    ...HAPPY.filter(([p]) => !/getChatMember/.test(p.source)),
    [/getChatMember/, { body: { ok: true, result: { status: 'member' } } }],
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const telegram = report.lanes.find((l: any) => l.platform === 'telegram');

  assert.equal(telegram.reachable, false);
  assert.ok(report.broken.includes('telegram'));
  assert.match(telegram.problems.join(' '), /not administrator/);
});

test('Telegram: an admin with Post Messages OFF is reported broken', async () => {
  const { fetcher } = routedFetch([
    ...HAPPY.filter(([p]) => !/getChatMember/.test(p.source)),
    [/getChatMember/, { body: { ok: true, result: { status: 'administrator', can_post_messages: false } } }],
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const telegram = report.lanes.find((l: any) => l.platform === 'telegram');
  assert.equal(telegram.reachable, false);
  assert.match(telegram.problems.join(' '), /"Post Messages" is OFF/);
});

test('Telegram: "chat not found" names the real fix, not the channel spelling', async () => {
  // This is the failure that cost an evening. The bot could not see the chat
  // because the id was the bot itself.
  const { fetcher } = routedFetch([
    ...HAPPY.filter(([p]) => !/getChat\\\?/.test(p.source) && !/getChat\?/.test(p.source)),
    [/getChat\?/, { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } }],
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const telegram = report.lanes.find((l: any) => l.platform === 'telegram');
  assert.equal(telegram.reachable, false);
  assert.match(telegram.problems.join(' '), /never been added to that channel/);
});

test('Telegram: a bad TOKEN is distinguished from a bad CHANNEL', async () => {
  const { fetcher } = routedFetch([[/getMe/, { status: 401, body: { ok: false } }]]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const telegram = report.lanes.find((l: any) => l.platform === 'telegram');
  assert.match(telegram.problems.join(' '), /TELEGRAM_BOT_TOKEN is not valid/);
  assert.ok(!/channel/i.test(telegram.detail), 'must not blame the channel for a token fault');
});

// --- Meta and TikTok ----------------------------------------------------------

test('Meta code 190 is reported as an EXPIRED TOKEN, not a bad id', async () => {
  const { fetcher } = routedFetch([
    ...HAPPY,
    [/17841400000000000/, { status: 400, body: { error: { code: 190, message: 'Invalid OAuth' } } }],
  ].reverse() as any);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const instagram = report.lanes.find((l: any) => l.platform === 'instagram');
  assert.equal(instagram.reachable, false);
  assert.match(instagram.problems.join(' '), /invalid or expired/);
});

test('Meta code 200 is reported as PERMISSIONS, which needs app review', async () => {
  const { fetcher } = routedFetch([
    [/100000000000000/, { status: 403, body: { error: { code: 200, message: 'Permissions' } } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const facebook = report.lanes.find((l: any) => l.platform === 'facebook');
  assert.match(facebook.problems.join(' '), /PERMISSIONS, not a bad value/);
  assert.match(facebook.problems.join(' '), /app review/);
});

test('TikTok reports an expired token as aged out rather than wrong', async () => {
  const { fetcher } = routedFetch([
    [/open\.tiktokapis\.com/, { status: 401, body: { error: { code: 'access_token_invalid' } } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const tiktok = report.lanes.find((l: any) => l.platform === 'tiktok');
  assert.equal(tiktok.reachable, false);
  assert.match(tiktok.problems.join(' '), /short-lived/);
});

test('Reddit: a token that is ISSUED but cannot read the account is NOT ready', async () => {
  // "A token was issued" is not "a token that reaches anything".
  const { fetcher } = routedFetch([
    [/api\/v1\/me/, { status: 403, body: {} }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const reddit = report.lanes.find((l: any) => l.platform === 'reddit');
  assert.equal(reddit.reachable, false);
  assert.match(reddit.problems.join(' '), /token was issued but/);
});

// --- robustness ---------------------------------------------------------------

test('a lane that THROWS is reported unreachable, never skipped or passed', async () => {
  const exploding = (async () => {
    throw new Error('socket hang up');
  }) as unknown as typeof fetch;
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: exploding });
  assert.deepEqual(report.ready, [], 'a thrown check is not a pass');
  assert.equal(report.broken.length, LANES.length);
  assert.ok(report.lanes.every((l: any) => /threw: socket hang up/.test(l.problems.join(' '))));
});

test('one broken lane does not stop the others being checked', async () => {
  const { fetcher } = routedFetch([
    [/open\.tiktokapis\.com/, { status: 500, body: {} }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  assert.ok(report.broken.includes('tiktok'));
  assert.ok(report.ready.includes('bluesky'), 'the other lanes still ran');
  assert.ok(report.ready.includes('telegram'));
});

test('whitespace on a value is caught, because it silently breaks the value', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', {
    env: { ...FULL_ENV, TIKTOK_ACCESS_TOKEN: ' act.secrettiktok ' } as NodeJS.ProcessEnv,
    fetch: fetcher,
  });
  const tiktok = report.lanes.find((l: any) => l.platform === 'tiktok');
  assert.equal(tiktok.configured, false);
  assert.match(tiktok.problems.join(' '), /leading or trailing whitespace/);
});

test('a missing variable names the ENVIRONMENT, because that is the usual cause', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const env = { ...FULL_ENV };
  delete (env as Record<string, unknown>).INSTAGRAM_ACCESS_TOKEN;
  const report = await runPublishDoctor('prod', { env, fetch: fetcher });
  const instagram = report.lanes.find((l: any) => l.platform === 'instagram');
  assert.match(instagram.problems.join(' '), /not set in the prod environment/);
  assert.match(instagram.problems.join(' '), /per-environment/);
});

// --- secrets ------------------------------------------------------------------

test('NO secret appears anywhere in the report', async () => {
  const { fetcher } = routedFetch([
    [/getMe/, { status: 401, body: { ok: false } }],
    [/open\.tiktokapis\.com/, { status: 401, body: { error: { code: 'access_token_invalid' } } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const serialised = JSON.stringify(report) + summarise(report).join(' ');

  for (const secret of SECRETS) {
    assert.ok(!serialised.includes(secret), `secret leaked into the report: ${secret}`);
  }
});

test('the report carries variable LENGTH but never the value', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const tiktok = report.lanes.find((l: any) => l.platform === 'tiktok');
  const record = tiktok.vars.find((v: any) => v.name === 'TIKTOK_ACCESS_TOKEN');
  assert.equal(record.present, true);
  assert.equal(record.length, 'act.secrettiktok'.length, 'length is the safe diagnostic');
  assert.ok(!('value' in record), 'there must be no value field at all');
});
