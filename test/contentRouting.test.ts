/**
 * The routing safety rail.
 *
 * Every other failure in this project is recoverable. Explicit material reaching
 * a mainstream platform is not — the account goes and the audience with it — so
 * this file is deliberately exhaustive rather than representative. The headline
 * test walks EVERY content class against EVERY platform and asserts the whole
 * matrix, so a platform added later with the wrong `accepts` cannot slip past by
 * simply not having a test written for it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ALL_PLATFORMS,
  CLASS_PREFIX,
  DEFAULT_CADENCE,
  PLATFORMS,
  RETIRED_PLATFORMS,
  SOCIAL_PLATFORMS,
  assertPublishAllowed,
  classifyFromKey,
  dailyLimitFor,
  publishIdempotencyKey,
  routeAsset,
  type ContentClass,
  type MediaKind,
  type PlatformId,
} from '../src/utils/contentRouting.ts';

// --- classification ----------------------------------------------------------

test('classifyFromKey reads the first path segment, exactly', () => {
  assert.equal(classifyFromKey('safe/2026-09-16/render-01.png'), 'safe');
  assert.equal(classifyFromKey('explicit/2026-09-16/render-01.png'), 'explicit');
  assert.equal(classifyFromKey('safe/a/b/c/deep.png'), 'safe');
  // A leading slash is a different key in S3, but must not defeat classification.
  assert.equal(classifyFromKey('/safe/x.png'), 'safe');
});

test('classifyFromKey NEVER substring-matches', () => {
  // The word "explicit" further down a safe path must not reclassify it, and
  // more importantly the reverse must not happen either.
  assert.equal(classifyFromKey('safe/explicit-pose/01.png'), 'safe');
  assert.equal(classifyFromKey('explicit/safe-for-teaser/01.png'), 'explicit');
  // "safe" appearing anywhere other than the first segment is not a class.
  assert.equal(classifyFromKey('renders/safe/01.png'), null);
  assert.equal(classifyFromKey('unsafe/01.png'), null);
  assert.equal(classifyFromKey('safety/01.png'), null);
});

test('classifyFromKey is strict about case, and that asymmetry is deliberate', () => {
  // Reading "Safe/" as safe would route a mislabelled asset to six public
  // platforms — unrecoverable. Refusing it means nothing posts and somebody
  // notices — recoverable. So: strict.
  assert.equal(classifyFromKey('Safe/x.png'), null);
  assert.equal(classifyFromKey('SAFE/x.png'), null);
  assert.equal(classifyFromKey('Explicit/x.png'), null);
});

test('classifyFromKey returns null for anything it cannot read', () => {
  assert.equal(classifyFromKey(''), null);
  assert.equal(classifyFromKey('render-01.png'), null, 'a bare filename has no class');
  assert.equal(classifyFromKey('safe'), null, 'a segment with no slash is not a prefix');
  assert.equal(classifyFromKey('safe.png'), null);
  assert.equal(classifyFromKey('/'), null);
});

// --- the whole matrix --------------------------------------------------------

test('EVERY class against EVERY platform: explicit reaches no mainstream lane', () => {
  const classes: ContentClass[] = ['safe', 'explicit'];
  const kinds: MediaKind[] = ['image', 'video'];

  for (const contentClass of classes) {
    for (const kind of kinds) {
      const asset = { key: `${CLASS_PREFIX[contentClass]}2026/a.bin`, kind };
      const decision = routeAsset(asset);

      assert.equal(decision.contentClass, contentClass);

      for (const id of decision.destinations) {
        const platform = PLATFORMS[id];
        assert.ok(
          platform.accepts.includes(contentClass),
          `${id} was routed ${contentClass} content it does not accept`,
        );
        assert.ok(
          platform.media.includes(kind),
          `${id} was routed ${kind} it cannot publish`,
        );
      }

      if (contentClass === 'explicit') {
        for (const social of SOCIAL_PLATFORMS) {
          assert.ok(
            !decision.destinations.includes(social),
            `explicit ${kind} must never route to ${social}`,
          );
        }
      }
    }
  }
});

test('the platform table itself: no mainstream lane may ever accept explicit', () => {
  // Guards the DATA, not just the logic. A future edit that adds "explicit" to
  // Instagram's accepts list would pass every routing test above, because the
  // logic would be faithfully doing what the table said.
  for (const id of SOCIAL_PLATFORMS) {
    assert.deepEqual(
      [...PLATFORMS[id].accepts],
      ['safe'],
      `${id} is a mainstream platform and must accept safe content only`,
    );
  }
  assert.ok(PLATFORMS.fanvue.accepts.includes('explicit'), 'fanvue is the explicit destination');
});

test('SOCIAL_PLATFORMS is the six LIVE mainstream lanes', () => {
  // Fanvue is excluded as the adult lane; YouTube as a retired one.
  assert.deepEqual(
    [...SOCIAL_PLATFORMS].sort(),
    ['bluesky', 'facebook', 'instagram', 'reddit', 'telegram', 'tiktok'],
  );
  assert.ok(!SOCIAL_PLATFORMS.includes('fanvue'), 'fanvue is not a mainstream lane');
  assert.ok(!SOCIAL_PLATFORMS.includes('youtube'), 'youtube was dropped from the plan');
  assert.equal(SOCIAL_PLATFORMS.length, 6);
});

test('Reddit is safe-only at the PLATFORM level, whatever its communities allow', () => {
  // Reddit does permit explicit material, and that is precisely the trap: it
  // permits it in SOME communities. The platform-level flag cannot express
  // "yes in r/a, no in r/b", so it stays closed and redditClient.ts gates per
  // subreddit. If this ever reads ["safe", "explicit"], the per-sub gate has
  // become the only thing standing between explicit content and a SFW sub.
  assert.deepEqual([...PLATFORMS.reddit.accepts], ['safe']);
  const decision = routeAsset({ key: 'explicit/a.jpg', kind: 'image' });
  assert.ok(!decision.destinations.includes('reddit'));
});

test('Fansly is absent from the platform table entirely', () => {
  // It has no official API. Everything calling itself one is a third party that
  // wants the account's session credentials. It is a manual lane, and leaving it
  // out of the table is what makes that structural rather than a note in a file.
  assert.ok(!ALL_PLATFORMS.includes('fansly' as PlatformId));
});

// --- fail closed, fail loud --------------------------------------------------

test('an unclassifiable asset goes NOWHERE and says why', () => {
  const decision = routeAsset({ key: 'renders/oops.png', kind: 'image' });
  assert.deepEqual(decision.destinations, [], 'no destination at all');
  assert.equal(decision.contentClass, null);
  assert.ok(decision.blockedReason, 'must state a reason — silence would read as "nothing to do"');
  assert.match(decision.blockedReason!, /Cannot classify/);
  assert.match(decision.blockedReason!, /deliberate, not a bug/);
});

test('an unclassifiable asset does not quietly fall back to the safe lanes', () => {
  // The specific catastrophe: treating "unknown" as "probably fine".
  for (const key of ['renders/x.png', 'Safe/x.png', 'x.png', '']) {
    const decision = routeAsset({ key, kind: 'image' });
    assert.deepEqual(decision.destinations, [], `"${key}" must route nowhere`);
  }
});

test('requesting a forbidden destination cannot obtain it', () => {
  // Narrowing may only ever REMOVE destinations. A caller asking explicitly for
  // Instagram with explicit content still gets refused, with the reason.
  const decision = routeAsset({ key: 'explicit/a.png', kind: 'image' }, ['instagram', 'fanvue']);
  assert.deepEqual(decision.destinations, ['fanvue']);
  const refusal = decision.rejected.find((r) => r.platform === 'instagram');
  assert.ok(refusal, 'the refusal must be reported, not silently dropped');
  assert.match(refusal!.reason, /safe content only/);
});

test('a RETIRED platform is no destination, for any class or kind', () => {
  // YouTube was dropped by the client. The entry stays in the table, so the
  // thing that has to be true is that it can never be routed to again.
  assert.ok(RETIRED_PLATFORMS.includes('youtube'), 'youtube is the retired one');
  for (const key of ['safe/a.mp4', 'explicit/a.mp4', 'safe/a.png']) {
    for (const kind of ['image', 'video'] as const) {
      const decision = routeAsset({ key, kind });
      assert.ok(
        !decision.destinations.includes('youtube'),
        `${key} as ${kind} must not route to a retired platform`,
      );
    }
  }
  // And it says why, rather than dropping it silently.
  const video = routeAsset({ key: 'safe/a.mp4', kind: 'video' });
  assert.ok(
    video.rejected.some((r) => r.platform === 'youtube' && /dropped from the plan/.test(r.reason)),
  );
});

test('retirement is not the same as incapability, and both are still recorded', () => {
  // YouTube is the only single-media platform in the table, which makes it the
  // only thing proving the "cannot publish this kind" path refuses anything.
  // That is why the entry was retired rather than deleted — the constraint is
  // load-bearing for the tests even though the lane is dead.
  assert.deepEqual([...PLATFORMS.youtube.media], ['video'], 'a Short cannot be a still image');
  assert.equal(dailyLimitFor('youtube', 'image'), 0, 'a kind it cannot publish is a zero limit');

  const singleMedia = ALL_PLATFORMS.filter((id) => PLATFORMS[id].media.length === 1);
  assert.ok(
    singleMedia.length > 0,
    'if this ever empties, the media-capability path has no live subject and these ' +
      'assertions have quietly stopped testing anything',
  );
});

test('TikTok accepts images — confirmed against the Content Posting API', () => {
  const decision = routeAsset({ key: 'safe/a.jpg', kind: 'image' });
  assert.ok(
    decision.destinations.includes('tiktok'),
    'photo posts are supported, so this lane needs no image-to-video step',
  );
});

// --- the second, independent check -------------------------------------------

test('assertPublishAllowed blocks explicit content at every mainstream lane', () => {
  for (const id of SOCIAL_PLATFORMS) {
    assert.throws(
      () => assertPublishAllowed(id, { key: 'explicit/a.mp4', kind: 'video' }),
      /BLOCKED/,
      `${id} must refuse explicit content at publish time even if something queued it`,
    );
  }
});

test('assertPublishAllowed is independent of routeAsset', () => {
  // The whole point: it catches a routing bug rather than trusting the router.
  // Hand it something no correct router would ever produce.
  assert.throws(
    () => assertPublishAllowed('instagram', { key: 'explicit/a.png', kind: 'image' }),
    /refusing to publish explicit content to Instagram/,
  );
  assert.throws(
    () => assertPublishAllowed('instagram', { key: 'renders/unknown.png', kind: 'image' }),
    /classification cannot be read/,
  );
  // Telegram takes video, so this exercises the media check on a LIVE lane
  // rather than on the retired one, which now fails earlier for another reason.
  assert.throws(
    () => assertPublishAllowed('telegram', { key: 'explicit/a.mp4', kind: 'video' }),
    /BLOCKED/,
  );
});

test('assertPublishAllowed refuses a retired platform before anything else', () => {
  // Deliberately handed content the platform WOULD have accepted when it was
  // live. Retirement has to win, or a stale queue entry still publishes.
  assert.throws(
    () => assertPublishAllowed('youtube', { key: 'safe/a.mp4', kind: 'video' }),
    /dropped from the plan/,
  );
});

test('assertPublishAllowed permits what it should', () => {
  assert.doesNotThrow(() => assertPublishAllowed('instagram', { key: 'safe/a.png', kind: 'image' }));
  assert.doesNotThrow(() => assertPublishAllowed('fanvue', { key: 'explicit/a.png', kind: 'image' }));
  assert.doesNotThrow(() => assertPublishAllowed('fanvue', { key: 'safe/a.png', kind: 'image' }));
  assert.doesNotThrow(() => assertPublishAllowed('telegram', { key: 'safe/a.mp4', kind: 'video' }));
});

// --- cadence -----------------------------------------------------------------

test('the daily limit is the stricter of the cadence and the API ceiling', () => {
  // Configured 5 posts/day is below Instagram's 25, so the cadence wins.
  assert.equal(dailyLimitFor('instagram', 'image'), 5);
  // Configured 4 videos/day is below YouTube's ~6, so the cadence wins there too.
  // 4 rather than 5 deliberately: 5 uploads is 8000 of 10,000 quota units and
  // leaves nothing for metadata calls or the retry of a failed upload.
  assert.equal(dailyLimitFor('youtube', 'video'), 4);
  // Raising the cadence past a ceiling must clamp, not exceed it.
  // Instagram's documented ceiling is 100 API-published posts per 24h, so a
  // cadence of 100 is not clamped. (This asserted 25 until the official docs
  // were checked; the old figure was from an outdated source.)
  assert.equal(dailyLimitFor('instagram', 'image', { maxPostsPerDay: 100, maxVideosPerDay: 100 }), 100);
  assert.equal(dailyLimitFor('instagram', 'image', { maxPostsPerDay: 250, maxVideosPerDay: 250 }), 100);
  assert.equal(dailyLimitFor('youtube', 'video', { maxPostsPerDay: 100, maxVideosPerDay: 100 }), 6);
  // No documented ceiling does not mean unlimited — the cadence still applies.
  assert.equal(dailyLimitFor('bluesky', 'image', { maxPostsPerDay: 4, maxVideosPerDay: 1 }), 4);
  // The video cadence must leave YouTube quota headroom rather than sitting on
  // the ceiling. If this ever fails, someone raised it without a quota increase.
  assert.ok(
    DEFAULT_CADENCE.maxVideosPerDay < PLATFORMS.youtube.apiCeilingPerDay!,
    'video cadence must stay strictly under YouTube\'s ceiling, not equal to it',
  );
});

test('a platform that cannot publish a kind has a limit of zero, not the cadence', () => {
  assert.equal(dailyLimitFor('youtube', 'image'), 0);
});

test('the agreed cadence sits below every ceiling in the table', () => {
  // If this ever fails, the configured rhythm has drifted above what an API
  // will accept and the limiter has quietly become the thing blocking posts.
  for (const id of ALL_PLATFORMS) {
    const ceiling = PLATFORMS[id].apiCeilingPerDay;
    if (ceiling === undefined) continue;
    assert.ok(
      DEFAULT_CADENCE.maxPostsPerDay <= ceiling,
      `cadence ${DEFAULT_CADENCE.maxPostsPerDay}/day exceeds ${id}'s ceiling of ${ceiling}`,
    );
  }
});

// --- idempotency -------------------------------------------------------------

test('the idempotency key is per asset AND per destination', () => {
  const asset = { key: 'safe/a.png', kind: 'image' as MediaKind };
  const bsky = publishIdempotencyKey(asset, 'bluesky');
  const tg = publishIdempotencyKey(asset, 'telegram');

  assert.notEqual(bsky, tg, 'one asset fanning out must not share a key across platforms');
  // Otherwise a retry after "succeeded on Bluesky, failed on X" either
  // double-posts to Bluesky or never retries X, with no way to have neither.
  assert.equal(bsky, publishIdempotencyKey({ ...asset }, 'bluesky'), 'stable across calls');
  assert.notEqual(
    bsky,
    publishIdempotencyKey({ key: 'safe/b.png', kind: 'image' }, 'bluesky'),
    'different assets must not collide',
  );
});

// --- the table cannot be mutated at runtime ----------------------------------

test('the platform table is frozen', () => {
  // A safety rule that can be edited at runtime is not a safety rule.
  assert.throws(() => {
    // @ts-expect-error deliberately violating the type to prove the freeze
    PLATFORMS.instagram.accepts = ['safe', 'explicit'];
  });
  assert.deepEqual([...PLATFORMS.instagram.accepts], ['safe']);
});
