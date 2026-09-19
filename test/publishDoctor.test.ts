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

const GRANTED_SCOPES = {
  data: [
    { permission: 'instagram_basic', status: 'granted' },
    { permission: 'instagram_content_publish', status: 'granted' },
    { permission: 'pages_manage_posts', status: 'granted' },
  ],
};

const HAPPY: Array<[RegExp, { status?: number; body: unknown }]> = [
  [/me\/permissions/, GRANTED_SCOPES],
  [/createSession/, { body: { handle: 'ava.bsky.social', did: 'did:plc:x' } }],
  [/getMe/, { body: { ok: true, result: { id: 123456, username: 'ava_ines_publish_bot' } } }],
  [/getChat\?/, { body: { ok: true, result: { title: 'Ava Ines Official', type: 'channel' } } }],
  [/getChatMember/, { body: { ok: true, result: { status: 'administrator', can_post_messages: true } } }],
  [/17841400000000000/, { body: { username: 'avaines', media_count: 2 } }],
  [/100000000000000/, { body: { name: 'Ava Ines Page', category: 'Public Figure' } }],
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
    ['bluesky', 'facebook', 'instagram', 'telegram', 'tiktok'],
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

// --- value shape --------------------------------------------------------------

test('a token too SHORT to be a token is called out, not just printed', async () => {
  // From a real run: FACEBOOK_PAGE_ACCESS_TOKEN was 32 chars and
  // TIKTOK_ACCESS_TOKEN was 16. The report showed both lengths and said
  // nothing about them, so it took a human noticing. A number nobody knows how
  // to interpret is not a diagnostic.
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', {
    env: { ...FULL_ENV, TIKTOK_ACCESS_TOKEN: 'act.short' } as NodeJS.ProcessEnv,
    fetch: fetcher,
  });
  const tiktok = report.lanes.find((l: any) => l.platform === 'tiktok');
  assert.match(tiktok.problems.join(' '), /too short to be valid/);
  assert.match(tiktok.problems.join(' '), /wrong value rather than an expired one/);
});

test('exactly 32 characters in a Meta token field is named as an APP SECRET', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', {
    env: { ...FULL_ENV, FACEBOOK_PAGE_ACCESS_TOKEN: 'a'.repeat(32) } as NodeJS.ProcessEnv,
    fetch: fetcher,
  });
  const facebook = report.lanes.find((l: any) => l.platform === 'facebook');
  assert.match(facebook.problems.join(' '), /APP SECRET/);
  assert.ok(
    !/too short to be valid/.test(facebook.problems.join(' ')),
    'the 32-char case has its own specific message, not the generic one',
  );
});

test('a wrong-shaped value is still CONFIGURED, so the live check still runs', async () => {
  // "Present but wrong" must not be reported as "not set up" — that would
  // skip the platform's own verdict and lose the more authoritative answer.
  const { fetcher, calls } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', {
    env: { ...FULL_ENV, TIKTOK_ACCESS_TOKEN: 'tiny' } as NodeJS.ProcessEnv,
    fetch: fetcher,
  });
  const tiktok = report.lanes.find((l: any) => l.platform === 'tiktok');
  assert.equal(tiktok.configured, true, 'present-but-wrong is configured, not unconfigured');
  assert.ok(!report.unconfigured.includes('tiktok'));
  assert.ok(calls.some((u) => /tiktokapis/.test(u)), 'the live check must still have run');
});

test('a plausible value produces no shape complaint', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', {
    env: { ...FULL_ENV, TIKTOK_ACCESS_TOKEN: `act.${'x'.repeat(120)}` } as NodeJS.ProcessEnv,
    fetch: fetcher,
  });
  const tiktok = report.lanes.find((l: any) => l.platform === 'tiktok');
  assert.deepEqual(tiktok.problems, [], 'a normal-looking token must not be flagged');
});

// --- Telegram membership vs a refused question --------------------------------

test('a FAILED getChatMember reads as "not in the channel", not an invented role', async () => {
  // getChat succeeds for any PUBLIC channel whether or not the bot is in it,
  // so the channel name coming back proves nothing. The first version defaulted
  // the missing status to "unknown" and reported the bot as 'a "unknown" in the
  // channel' — which reads as present-with-a-strange-role.
  const { fetcher } = routedFetch([
    [/getChatMember/, { status: 400, body: { ok: false, description: 'Bad Request: user not found' } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const telegram = report.lanes.find((l: any) => l.platform === 'telegram');

  assert.equal(telegram.reachable, false);
  assert.match(telegram.detail, /not a member of/);
  assert.ok(!/unknown/.test(telegram.detail), 'must not invent a role');
  assert.match(telegram.problems.join(' '), /works for any public channel/);
  assert.match(telegram.problems.join(' '), /Add to Group or Channel/);
});

test('a bot that was REMOVED is distinguished from one never added', async () => {
  const { fetcher } = routedFetch([
    [/getChatMember/, { body: { ok: true, result: { status: 'kicked' } } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const telegram = report.lanes.find((l: any) => l.platform === 'telegram');
  assert.match(telegram.detail, /has been kicked/);
  assert.match(telegram.problems.join(' '), /Re-add it/);
});

test('a NAME is not proof of type: the system user id in FACEBOOK_PAGE_ID is caught', async () => {
  // The real false pass. The doctor reported
  //   OK Facebook: authenticated as "ava-publisher"
  // because FACEBOOK_PAGE_ID held the SYSTEM USER's id. It resolved, it had a
  // name, the scopes were present — so every check passed and a publish would
  // still have gone nowhere. Nearly everything in the Graph API has a name.
  const { fetcher } = routedFetch([
    [/100000000000000/, { body: { name: 'ava-publisher', id: '100000000000000' } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const facebook = report.lanes.find((l: any) => l.platform === 'facebook');

  assert.equal(facebook.reachable, false, 'a named non-Page must not read as OK');
  assert.match(facebook.detail, /NOT a Facebook Page/);
  assert.match(facebook.problems.join(' '), /category or fan_count/);
  assert.match(facebook.problems.join(' '), /system user's id/);
});

test('a real Page passes on either category or fan_count', async () => {
  // Not every Page returns both, so requiring both would reject working setups.
  for (const proof of [{ category: 'Public Figure' }, { fan_count: 12 }]) {
    const { fetcher } = routedFetch([
      [/100000000000000/, { body: { name: 'AvaInes', ...proof } }],
      ...HAPPY,
    ]);
    const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
    const facebook = report.lanes.find((l: any) => l.platform === 'facebook');
    assert.equal(facebook.reachable, true, `a Page with ${Object.keys(proof)[0]} must pass`);
    assert.match(facebook.detail, /AvaInes/);
  }
});

test('an Instagram account with no media_count is rejected as the wrong object', async () => {
  const { fetcher } = routedFetch([
    [/17841400000000000/, { body: { username: 'ava_ines_ai' } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const instagram = report.lanes.find((l: any) => l.platform === 'instagram');
  assert.equal(instagram.reachable, false);
  assert.match(instagram.detail, /NOT a Instagram account/);
});

test('media_count of ZERO still counts as proof', async () => {
  // A brand new account has no posts. Testing presence, not truthiness — 0 is
  // a perfectly good answer and `if (!body.media_count)` would reject it.
  const { fetcher } = routedFetch([
    [/17841400000000000/, { body: { username: 'ava_ines_ai', media_count: 0 } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  assert.ok(report.ready.includes('instagram'), 'an empty account is still an account');
});

test('an Instagram account in the FACEBOOK_PAGE_ID slot is caught, not renamed', async () => {
  // A Page returns "name"; an Instagram account returns "username". The first
  // version fell back through both, so an Instagram account in the Facebook
  // variable reported as a happily-authenticated Page. Telling one object from
  // another is the entire job here.
  const { fetcher } = routedFetch([
    [/100000000000000/, { body: { username: 'ava_ines_ai', id: '100000000000000' } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const facebook = report.lanes.find((l: any) => l.platform === 'facebook');

  assert.equal(facebook.reachable, false, 'a username-only object is not a Page');
  // The type-proof check now fires first and gives the more specific answer —
  // it names what a Page must return, rather than only which field is absent.
  assert.match(facebook.detail, /NOT a Facebook Page/);
  assert.match(facebook.problems.join(' '), /category or fan_count/);
  assert.ok(
    !/authenticated as "ava_ines_ai"/.test(facebook.detail),
    'must not report the Instagram handle as a working Facebook Page',
  );
});

test('the correct field still passes normally', async () => {
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const facebook = report.lanes.find((l: any) => l.platform === 'facebook');
  assert.equal(facebook.reachable, true);
  assert.match(facebook.detail, /Ava Ines Page/);
});

// --- Meta publishing scopes ---------------------------------------------------

test('a Meta account that RESOLVES but cannot publish is reported as FAIL', async () => {
  // The trap this exists for: reading the account needs one permission and
  // publishing needs another. Without the scope check the doctor says OK and
  // the first real post fails — which is the whole failure mode the doctor was
  // written to remove.
  const { fetcher } = routedFetch([
    [/me\/permissions/, { body: { data: [{ permission: 'instagram_basic', status: 'granted' }] } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const instagram = report.lanes.find((l: any) => l.platform === 'instagram');

  assert.equal(instagram.reachable, false, 'resolving is not the same as being able to publish');
  assert.match(instagram.detail, /CANNOT PUBLISH/);
  assert.match(instagram.problems.join(' '), /wrong TYPE/, 'not-offered means the app type');
});

test('a DECLINED scope is distinguished from one that was never offered', async () => {
  // Different causes, different fixes. Declined means regenerate the token and
  // approve properly; absent means the app can never have it.
  const { fetcher } = routedFetch([
    [
      /me\/permissions/,
      { body: { data: [{ permission: 'instagram_content_publish', status: 'declined' }] } },
    ],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const instagram = report.lanes.find((l: any) => l.platform === 'instagram');

  assert.match(instagram.problems.join(' '), /DECLINED, not granted/);
  assert.match(instagram.problems.join(' '), /approval dialog too quickly/);
  assert.ok(
    !/wrong TYPE/.test(instagram.problems.join(' ')),
    'a declined scope is NOT an app-type problem and must not say so',
  );
});

test('either Instagram publishing scope name satisfies the requirement', async () => {
  // Two flows, two names. Accepting only one would report a working setup as
  // broken for whichever flow we did not name.
  for (const permission of ['instagram_content_publish', 'instagram_business_content_publish']) {
    const { fetcher } = routedFetch([
      [/me\/permissions/, { body: { data: [{ permission, status: 'granted' }] } }],
      ...HAPPY,
    ]);
    const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
    assert.ok(report.ready.includes('instagram'), `${permission} should satisfy the check`);
  }
});

test('an unreadable permissions list is UNCONFIRMED, never reported as fine', async () => {
  // A Page token cannot read /me/permissions. That is not evidence of a
  // problem, and it is not evidence of health either — say so rather than
  // picking whichever is convenient.
  const { fetcher } = routedFetch([
    [/me\/permissions/, { status: 400, body: { error: { code: 100 } } }],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const instagram = report.lanes.find((l: any) => l.platform === 'instagram');

  assert.equal(instagram.reachable, true, 'the account did resolve, so this is not a failure');
  assert.match(instagram.detail, /could not be checked/);
  assert.match(instagram.detail, /unconfirmed/);
});

test('Facebook is checked against pages_manage_posts, not the Instagram scope', async () => {
  const { fetcher } = routedFetch([
    [
      /me\/permissions/,
      { body: { data: [{ permission: 'instagram_content_publish', status: 'granted' }] } },
    ],
    ...HAPPY,
  ]);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });
  const facebook = report.lanes.find((l: any) => l.platform === 'facebook');
  assert.equal(facebook.reachable, false, 'the Instagram scope does not authorise Facebook');
  assert.match(facebook.problems.join(' '), /pages_manage_posts/);
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

test('a RETIRED lane is not checked at all — not broken, not unconfigured', async () => {
  // Reddit was dropped on 19 Sep 2026. Reporting it as "needs attention"
  // afterwards is noise, and noise is what trains people to stop reading the
  // report. The lane list is DERIVED from the platform table, so retiring a
  // platform removes it here with no second edit.
  const { fetcher } = routedFetch(HAPPY);
  const report = await runPublishDoctor('prod', { env: FULL_ENV, fetch: fetcher });

  assert.equal(
    report.lanes.find((l: any) => l.platform === 'reddit'),
    undefined,
    'a retired platform is not a lane',
  );
  assert.ok(!report.broken.includes('reddit'));
  assert.ok(!report.unconfigured.includes('reddit'));
  assert.ok(!report.ready.includes('reddit'));
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
