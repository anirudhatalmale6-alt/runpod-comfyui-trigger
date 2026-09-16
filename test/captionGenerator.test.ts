/**
 * Caption generator tests.
 *
 * The interesting cases are not "does it call the API" — they are what happens
 * when the model does something other than what it was told, which it will.
 * Asking for "only the caption" returns the caption most of the time; the rest
 * arrives wrapped in quotes, prefixed with "Caption:", or as a numbered list of
 * three options. Any of those posted verbatim to a public feed looks broken.
 *
 * Every limit is asserted on the RESULT, because a model asked for "under 300
 * characters" will hand back 340 without blinking.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AssetRef, PlatformId } from '../src/utils/contentRouting.ts';

let generateCaption: any;
let cleanModelOutput: any;
let truncateTo: any;
let measure: any;
let buildPrompt: any;
let fallbackCaption: any;
let openaiKeyFromEnv: any;
let CAPTION_LIMITS: any;
let tempDir: string;

const ASSET: AssetRef = { key: 'safe/2026-09-17/render-01.jpg', kind: 'image' };

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-caption');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'captionGenerator.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source, 'the specifier under rewrite must be present');
  writeFileSync(join(tempDir, 'captionGenerator.ts'), rewritten);

  const mod = await import(join(tempDir, 'captionGenerator.ts'));
  ({
    generateCaption, cleanModelOutput, truncateTo, measure,
    buildPrompt, fallbackCaption, openaiKeyFromEnv, CAPTION_LIMITS,
  } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function fakeOpenAI(content: string, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body =
      status === 200
        ? { choices: [{ message: { content } }] }
        : { error: { message: content } };
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// --- cleaning what the model actually returns ---------------------------------

test('wrapping quotes are stripped, straight and curly', () => {
  assert.equal(cleanModelOutput('"Golden hour on the balcony."'), 'Golden hour on the balcony.');
  assert.equal(cleanModelOutput('“Golden hour.”'), 'Golden hour.');
  assert.equal(cleanModelOutput("'Golden hour.'"), 'Golden hour.');
  // A quote INSIDE the text is not a wrapper and must survive.
  assert.equal(cleanModelOutput('She said "hello" once'), 'She said "hello" once');
});

test('a "Caption:" prefix is removed', () => {
  assert.equal(cleanModelOutput('Caption: Golden hour.'), 'Golden hour.');
  assert.equal(cleanModelOutput('caption - Golden hour.'), 'Golden hour.');
  assert.equal(cleanModelOutput('Post: Golden hour.'), 'Golden hour.');
});

test('a numbered list of options collapses to the FIRST one', () => {
  // Posting "1. Golden hour. 2. Sunset vibes. 3. ..." verbatim is the failure
  // this prevents.
  assert.equal(
    cleanModelOutput('1. Golden hour on the balcony.\n2. Sunset vibes.\n3. Rooftop glow.'),
    'Golden hour on the balcony.',
  );
  assert.equal(cleanModelOutput('- Golden hour.\n- Sunset.'), 'Golden hour.');
  assert.equal(cleanModelOutput('• Golden hour.\n• Sunset.'), 'Golden hour.');
});

test('a clean caption passes through untouched', () => {
  const clean = 'Golden hour on the balcony. Link in bio.';
  assert.equal(cleanModelOutput(clean), clean);
});

// --- limits are enforced on the RESULT ----------------------------------------

test('every platform limit is enforced after generation, not requested of the model', async () => {
  // The model was told "under 300 characters" and returned 500. That is normal
  // and must not reach a feed.
  const tooLong = 'word '.repeat(400).trim();

  for (const platform of Object.keys(CAPTION_LIMITS) as PlatformId[]) {
    const { fetcher } = fakeOpenAI(tooLong);
    const caption = await generateCaption(
      { asset: ASSET, platform },
      { fetch: fetcher, apiKey: 'sk-test' },
    );
    const limit = CAPTION_LIMITS[platform];
    assert.ok(
      measure(caption, limit.unit) <= limit.max,
      `${platform}: ${measure(caption, limit.unit)} > ${limit.max}`,
    );
  }
});

test('YouTube gets a 100-character TITLE, not a caption', () => {
  // The tightest limit by far, and the easiest to get wrong because every other
  // lane is 300+.
  assert.equal(CAPTION_LIMITS.youtube.max, 100);
  const cut = truncateTo('word '.repeat(60).trim(), CAPTION_LIMITS.youtube);
  assert.ok(cut.length <= 100);
});

test('truncation never splits an emoji', () => {
  // Slicing at a code-unit index lands inside a surrogate pair and renders as a
  // replacement glyph — which looks like a bug rather than a long caption.
  const emoji = '👍🏽'.repeat(200);
  const cut = truncateTo(emoji, { max: 50, unit: 'grapheme' });
  assert.ok(measure(cut, 'grapheme') <= 50);
  assert.ok(!cut.includes('�'), 'no replacement character');
  // Every grapheme kept must be whole.
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut.replace(/…$/, '')), 'no dangling high surrogate');
});

test('the ellipsis fits INSIDE the limit, not outside it', () => {
  // Off-by-one here means a caption that is exactly one character too long,
  // which the API rejects and which is maddening to diagnose.
  const cut = truncateTo('x'.repeat(500), { max: 100, unit: 'codeunit' });
  assert.ok(cut.length <= 100, `got ${cut.length}`);
  assert.ok(cut.endsWith('…'));
});

test('text already inside the limit is returned unchanged, with no ellipsis', () => {
  assert.equal(truncateTo('short', { max: 100, unit: 'codeunit' }), 'short');
});

// --- the prompt ---------------------------------------------------------------

test('the prompt carries the platform style and the link', () => {
  const prompt = buildPrompt({
    asset: ASSET,
    platform: 'youtube',
    linkUrl: 'https://example.com/ava',
    description: 'rooftop at sunset',
  });
  assert.match(prompt, /Shorts TITLE/, 'YouTube is a title, not a caption');
  assert.match(prompt, /https:\/\/example\.com\/ava/);
  assert.match(prompt, /rooftop at sunset/);
  assert.match(prompt, /Return ONLY the caption text/);
});

test('intensity changes the call to action, and it is the client\'s choice', () => {
  const base = { asset: ASSET, platform: 'instagram' as PlatformId, linkUrl: 'https://x.test' };
  assert.match(buildPrompt({ ...base, intensity: 'hard' }), /strong, explicit instruction/);
  assert.match(buildPrompt({ ...base, intensity: 'soft' }), /low-pressure/);
  assert.match(buildPrompt({ ...base, intensity: 'direct' }), /clear call to action/);
  assert.match(buildPrompt(base), /clear call to action/, 'direct is the default');
});

// --- failure is loud ----------------------------------------------------------

test('a failed generation THROWS rather than falling back silently', async () => {
  // A silent fallback to "New render" would publish for weeks before anyone
  // noticed the captions had stopped being written.
  const { fetcher } = fakeOpenAI('rate limit exceeded', 429);
  await assert.rejects(
    () => generateCaption({ asset: ASSET, platform: 'bluesky' }, { fetch: fetcher, apiKey: 'sk-test' }),
    /Caption generation failed: HTTP 429 — rate limit exceeded/,
  );
});

test('an empty model response throws', async () => {
  const { fetcher } = fakeOpenAI('   ');
  await assert.rejects(
    () => generateCaption({ asset: ASSET, platform: 'bluesky' }, { fetch: fetcher, apiKey: 'sk-test' }),
    /empty response/,
  );
});

test('the API key never appears in an error message', async () => {
  const { fetcher } = fakeOpenAI('some upstream failure', 500);
  const key = 'sk-super-secret-key-value';
  try {
    await generateCaption({ asset: ASSET, platform: 'bluesky' }, { fetch: fetcher, apiKey: key });
    assert.fail('should have thrown');
  } catch (error) {
    assert.ok(!String((error as Error).message).includes(key), 'the key leaked into the error');
  }
});

test('a missing OPENAI_API_KEY names the variable', () => {
  assert.throws(() => openaiKeyFromEnv({} as NodeJS.ProcessEnv), /OPENAI_API_KEY/);
  assert.throws(() => openaiKeyFromEnv({} as NodeJS.ProcessEnv), /per-environment/);
});

// --- the request itself -------------------------------------------------------

test('the key goes in the Authorization header, never the body', async () => {
  const { fetcher, calls } = fakeOpenAI('A caption.');
  await generateCaption({ asset: ASSET, platform: 'bluesky' }, { fetch: fetcher, apiKey: 'sk-test' });

  const headers = calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer sk-test');
  assert.ok(!String(calls[0]!.init.body).includes('sk-test'), 'the key must not be in the body');

  const body = JSON.parse(String(calls[0]!.init.body));
  // Variation is the point: identical captions across posts are a spam signal.
  assert.ok(body.temperature >= 0.7, 'captions must vary between posts');
});

// --- the opt-out, which is not a fallback -------------------------------------

test('fallbackCaption is deterministic and respects the limit', () => {
  const caption = fallbackCaption({
    asset: ASSET,
    platform: 'youtube',
    description: 'a very long description '.repeat(20),
  });
  assert.ok(caption.length <= CAPTION_LIMITS.youtube.max);
  assert.equal(
    caption,
    fallbackCaption({
      asset: ASSET,
      platform: 'youtube',
      description: 'a very long description '.repeat(20),
    }),
    'same input, same output',
  );
});

test('fallbackCaption includes the link when given one', () => {
  const caption = fallbackCaption({ asset: ASSET, platform: 'telegram', linkUrl: 'https://x.test' });
  assert.match(caption, /https:\/\/x\.test/);
});
