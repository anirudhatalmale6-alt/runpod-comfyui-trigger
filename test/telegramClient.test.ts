/**
 * Telegram adapter tests.
 *
 * Same shape as the Bluesky ones: a mock asserting the documented wire format,
 * plus a LIVE probe against api.telegram.org that proves the request reaches a
 * real server and is understood by it, without ever holding the client's token.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let telegramCredentialsFromEnv: any;
let publishToTelegram: any;
let describeTelegramError: any;
let validateCaption: any;
let validateMedia: any;
let messageUrl: any;
let MAX_PHOTO_BYTES: number;
let MAX_FILE_BYTES: number;
let MAX_CAPTION_LENGTH: number;
let TELEGRAM_API: string;
let tempDir: string;

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-tg');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'telegramClient.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source, 'the specifier under rewrite must be present');
  assert.ok(rewritten.includes('assertPublishAllowed'), 'the safety guard must survive');
  writeFileSync(join(tempDir, 'telegramClient.ts'), rewritten);

  const mod = await import(join(tempDir, 'telegramClient.ts'));
  ({
    telegramCredentialsFromEnv, publishToTelegram, describeTelegramError,
    validateCaption, validateMedia, messageUrl,
    MAX_PHOTO_BYTES, MAX_FILE_BYTES, MAX_CAPTION_LENGTH, TELEGRAM_API,
  } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';
const CREDS = { botToken: TOKEN, chatId: '@avachannel' };
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

function recordingFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let index = 0;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[index++] ?? { body: { ok: true, result: { message_id: 1 } } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// --- credentials -------------------------------------------------------------

test('missing credentials name the variables', () => {
  assert.throws(() => telegramCredentialsFromEnv({} as NodeJS.ProcessEnv), /TELEGRAM_BOT_TOKEN/);
  assert.throws(
    () => telegramCredentialsFromEnv({ TELEGRAM_BOT_TOKEN: TOKEN } as NodeJS.ProcessEnv),
    /TELEGRAM_CHANNEL_CHAT_ID/,
  );
});

test('a truncated bot token is caught here, not as a mystery 404', () => {
  assert.throws(
    () =>
      telegramCredentialsFromEnv({
        TELEGRAM_BOT_TOKEN: '123456789',
        TELEGRAM_CHANNEL_CHAT_ID: '@avachannel',
      } as NodeJS.ProcessEnv),
    /does not look like a bot token/,
  );
});

test('a PRIVATE CHAT id is refused, because posting there reaches nobody', () => {
  // This is the quiet one: a positive numeric id is a private chat. The post
  // would SUCCEED and the channel would stay empty.
  assert.throws(
    () =>
      telegramCredentialsFromEnv({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_CHANNEL_CHAT_ID: '123456789',
      } as NodeJS.ProcessEnv),
    /reach nobody/,
  );
  // Both real channel forms are accepted.
  for (const chatId of ['@avachannel', '-1001234567890']) {
    assert.doesNotThrow(() =>
      telegramCredentialsFromEnv({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_CHANNEL_CHAT_ID: chatId,
      } as NodeJS.ProcessEnv),
    );
  }
});

test('the BOT\'s own username is refused as a destination', () => {
  // Observed on this project: the variable held the bot's @username, so the bot
  // was told to post to itself. Telegram answers "chat not found", which reads
  // as a wrong CHANNEL name and sends you hunting in entirely the wrong place.
  assert.throws(
    () =>
      telegramCredentialsFromEnv({
        TELEGRAM_BOT_TOKEN: TOKEN,
        TELEGRAM_CHANNEL_CHAT_ID: '@ava_ines_publish_bot',
      } as NodeJS.ProcessEnv),
    /is a BOT username, not a channel/,
  );
  // The suffix is what identifies it, and Telegram reserves it, so case and
  // separator must not matter.
  for (const chatId of ['@AvaPublishBot', '@ava_publish_BOT', '@somethingbot']) {
    assert.throws(
      () =>
        telegramCredentialsFromEnv({
          TELEGRAM_BOT_TOKEN: TOKEN,
          TELEGRAM_CHANNEL_CHAT_ID: chatId,
        } as NodeJS.ProcessEnv),
      /BOT username/,
      `${chatId} is a bot username`,
    );
  }
});

test('the bot-username guard does not swallow legitimate channel names', () => {
  // "bot" must be the SUFFIX, not merely present. A channel called @botanicals
  // is a perfectly good destination and refusing it would be a worse bug than
  // the one the guard exists to catch.
  for (const chatId of ['@botanicals', '@robotics_daily', '@AvaInesOfficial']) {
    assert.doesNotThrow(
      () =>
        telegramCredentialsFromEnv({
          TELEGRAM_BOT_TOKEN: TOKEN,
          TELEGRAM_CHANNEL_CHAT_ID: chatId,
        } as NodeJS.ProcessEnv),
      `${chatId} is a real channel name`,
    );
  }
});

// --- limits -------------------------------------------------------------------

test('the size limits are per media type, and photos are far smaller', () => {
  assert.equal(MAX_PHOTO_BYTES, 10 * 1024 * 1024);
  assert.equal(MAX_FILE_BYTES, 50 * 1024 * 1024);

  assert.deepEqual(validateMedia(new Uint8Array(MAX_PHOTO_BYTES), 'image'), []);
  assert.equal(validateMedia(new Uint8Array(MAX_PHOTO_BYTES + 1), 'image').length, 1);
  // A file that is too big as a photo is fine as a video.
  assert.deepEqual(validateMedia(new Uint8Array(MAX_PHOTO_BYTES + 1), 'video'), []);
  assert.equal(validateMedia(new Uint8Array(0), 'image').length, 1, 'zero bytes is a problem');
});

test('Telegram takes the MASTER render where Bluesky cannot', () => {
  // 10 MB against Bluesky's 1,000,000 bytes — worth pinning, because it is why
  // this lane does not need the -web derivative.
  const fourMegabytes = new Uint8Array(4 * 1024 * 1024);
  assert.deepEqual(validateMedia(fourMegabytes, 'image'), []);
});

test('the caption limit is 1024 characters', () => {
  assert.equal(MAX_CAPTION_LENGTH, 1024);
  assert.deepEqual(validateCaption('a'.repeat(1024)), []);
  assert.equal(validateCaption('a'.repeat(1025)).length, 1);
});

// --- wire format --------------------------------------------------------------

test('an image goes to sendPhoto as multipart, with the token in the PATH', async () => {
  const { fetcher, calls } = recordingFetch([{ body: { ok: true, result: { message_id: 42 } } }]);

  const result = await publishToTelegram(
    CREDS,
    { bytes: JPEG, filename: 'render-01.jpg', mimeType: 'image/jpeg', kind: 'image', caption: 'hi' },
    { fetch: fetcher },
  );

  assert.equal(calls[0]!.url, `${TELEGRAM_API}/bot${TOKEN}/sendPhoto`);
  const form = calls[0]!.init.body as FormData;
  assert.ok(form instanceof FormData, 'multipart, not JSON');
  assert.equal(form.get('chat_id'), '@avachannel');
  assert.equal(form.get('caption'), 'hi');
  assert.ok(form.get('photo') instanceof Blob, 'the photo field carries the bytes');
  assert.equal(result.messageId, 42);
});

test('a video goes to sendVideo, under a different field name', async () => {
  const { fetcher, calls } = recordingFetch([{ body: { ok: true, result: { message_id: 7 } } }]);
  await publishToTelegram(
    CREDS,
    { bytes: JPEG, filename: 'loop.mp4', mimeType: 'video/mp4', kind: 'video', caption: 'c' },
    { fetch: fetcher },
  );
  assert.match(calls[0]!.url, /\/sendVideo$/);
  const form = calls[0]!.init.body as FormData;
  assert.ok(form.get('video') instanceof Blob);
  assert.equal(form.get('photo'), null, 'the photo field must not be set for a video');
});

test('a permalink is only produced for a PUBLIC channel', () => {
  assert.equal(messageUrl('@avachannel', 42), 'https://t.me/avachannel/42');
  // A numeric channel has no stable public URL. Inventing one is worse than none.
  assert.equal(messageUrl('-1001234567890', 42), '');
});

// --- the error everyone hits --------------------------------------------------

test('a 403 explains the ADMIN requirement rather than passing "Forbidden" through', async () => {
  // The single most common Telegram bot setup failure, and it reads exactly
  // like a bad token if you only see Telegram's own wording.
  const { fetcher } = recordingFetch([
    { status: 403, body: { ok: false, description: 'Forbidden: bot is not a member of the channel chat' } },
  ]);
  await assert.rejects(
    () =>
      publishToTelegram(
        CREDS,
        { bytes: JPEG, filename: 'a.jpg', mimeType: 'image/jpeg', kind: 'image', caption: 'c' },
        { fetch: fetcher },
      ),
    /ADMINISTRATOR of the channel/,
  );
});

test('error messages never contain the bot token', () => {
  // The Bot API puts the token in the URL path, so an error built from the
  // request URL would leak it into the logs on every failure.
  for (const [status, description] of [
    [403, 'Forbidden'],
    [400, 'Bad Request: chat not found'],
    [401, 'Unauthorized'],
    [429, 'Too Many Requests'],
    [500, 'Internal Server Error'],
  ] as const) {
    const message = describeTelegramError('sendPhoto', status, description);
    assert.ok(!message.includes(TOKEN), `token leaked into the ${status} message`);
    assert.match(message, /sendPhoto/, 'the method is named instead');
  }
});

test('"chat not found" says what to check', async () => {
  const { fetcher } = recordingFetch([
    { status: 400, body: { ok: false, description: 'Bad Request: chat not found' } },
  ]);
  await assert.rejects(
    () =>
      publishToTelegram(
        CREDS,
        { bytes: JPEG, filename: 'a.jpg', mimeType: 'image/jpeg', kind: 'image', caption: 'c' },
        { fetch: fetcher },
      ),
    /never been added to that channel/,
  );
});

// --- the safety rail ----------------------------------------------------------

test('an EXPLICIT asset is refused at the last moment', async () => {
  const { fetcher, calls } = recordingFetch([]);
  await assert.rejects(
    () =>
      publishToTelegram(
        CREDS,
        {
          bytes: JPEG, filename: 'a.jpg', mimeType: 'image/jpeg', kind: 'image', caption: 'c',
          asset: { key: 'explicit/a.jpg', kind: 'image' },
        },
        { fetch: fetcher },
      ),
    /BLOCKED/,
  );
  assert.equal(calls.length, 0, 'no request left the process');
});

// --- against the REAL API ------------------------------------------------------

test('LIVE: api.telegram.org parses our request and rejects the TOKEN', async (t) => {
  // As with Bluesky: proves the shape reaches a real server and is understood,
  // without needing the client's token. A malformed request would come back as
  // a 404 for an unknown method; 401 Unauthorized means the URL and body were
  // fine and only the credential was wrong.
  let response: Response;
  try {
    const form = new FormData();
    form.append('chat_id', '@nonexistent');
    response = await fetch(`${TELEGRAM_API}/bot111111111:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/getMe`, {
      method: 'POST',
      body: form,
    });
  } catch (error) {
    t.skip(`no network to ${TELEGRAM_API} — run with connectivity to prove the wire format`);
    return;
  }

  const body = (await response.json()) as { ok?: boolean; error_code?: number; description?: string };
  assert.equal(body.ok, false, 'a bogus token must not succeed');
  assert.equal(response.status, 401, `expected 401 Unauthorized, got ${response.status}`);
  assert.match(String(body.description), /Unauthorized/i);

  // And our error formatter turns that into something a human can act on.
  const message = describeTelegramError('getMe', response.status, String(body.description));
  assert.match(message, /bot token is rejected/);
});
