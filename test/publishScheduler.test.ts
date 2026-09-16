/**
 * Scheduler tests.
 *
 * The three properties that matter are determinism, staying inside human hours,
 * and spacing. Each is asserted directly rather than inferred, and the
 * determinism one matters most: if jitter came from Math.random() these tests
 * would pass by luck, and a crash-and-replan would produce a second,
 * differently-timed set of posts on top of the first.
 */

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { AssetRef, PlatformId } from '../src/utils/contentRouting.ts';

// publishScheduler imports "./contentRouting.js" — the specifier the client's
// repo uses and their esbuild resolves. Node's type stripper cannot follow it,
// so the test rewrites that one line into a generated copy, exactly as the
// bluesky and sweeper tests do. The shipped source stays right for THEIR build.
let planSchedule: any;
let duePosts: any;
let zonedParts: any;
let nextInsideWindow: any;
let isInsideWindow: any;
let deterministicUnit: any;
let DEFAULT_SCHEDULE: any;
let tempDir: string;

before(async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  tempDir = join(here, '.generated-sched');
  mkdirSync(tempDir, { recursive: true });
  copyFileSync(
    join(here, '..', 'src', 'utils', 'contentRouting.ts'),
    join(tempDir, 'contentRouting.ts'),
  );
  const source = readFileSync(join(here, '..', 'src', 'utils', 'publishScheduler.ts'), 'utf8');
  const rewritten = source.replace('from "./contentRouting.js"', 'from "./contentRouting.ts"');
  assert.notEqual(rewritten, source, 'the specifier under rewrite must be present');
  assert.ok(rewritten.includes('planSchedule'), 'the planner must survive the rewrite');
  writeFileSync(join(tempDir, 'publishScheduler.ts'), rewritten);

  const mod = await import(join(tempDir, 'publishScheduler.ts'));
  ({ planSchedule, duePosts, zonedParts, nextInsideWindow, isInsideWindow, deterministicUnit, DEFAULT_SCHEDULE } = mod);
});

after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

const IMAGE: AssetRef = { key: 'safe/2026-09-17/render-01.jpg', kind: 'image' };
const LANES: PlatformId[] = ['bluesky', 'telegram', 'instagram', 'facebook'];

/** 10:00 New York on a normal weekday, well inside the window. */
const NOON_ET = new Date('2026-09-17T14:00:00.000Z');

// --- determinism -------------------------------------------------------------

test('planning the same asset twice produces the IDENTICAL schedule', () => {
  const a = planSchedule([{ asset: IMAGE, destinations: LANES }], NOON_ET);
  const b = planSchedule([{ asset: IMAGE, destinations: LANES }], NOON_ET);

  assert.deepEqual(
    a.scheduled.map((p: any) => [p.platform, p.scheduledFor.toISOString()]),
    b.scheduled.map((p: any) => [p.platform, p.scheduledFor.toISOString()]),
    'a replan after a crash must not produce a second, differently-timed set of posts',
  );
});

test('jitter comes from the key, so different assets get different slots', () => {
  const one = planSchedule([{ asset: IMAGE, destinations: ['bluesky'] }], NOON_ET);
  const two = planSchedule(
    [{ asset: { key: 'safe/2026-09-17/render-02.jpg', kind: 'image' }, destinations: ['bluesky'] }],
    NOON_ET,
  );
  assert.notEqual(
    one.scheduled[0].scheduledFor.getTime(),
    two.scheduled[0].scheduledFor.getTime(),
    'two renders must not be scheduled for the same instant',
  );
});

test('deterministicUnit is stable and inside [0, 1)', () => {
  for (const key of ['a', 'bluesky:safe/x.jpg', '', 'telegram:safe/very/long/key.mp4']) {
    const v = deterministicUnit(key, 'jitter');
    assert.ok(v >= 0 && v < 1, `${key} -> ${v}`);
    assert.equal(v, deterministicUnit(key, 'jitter'), 'same input, same output, every time');
  }
  assert.notEqual(
    deterministicUnit('a', 'jitter'),
    deterministicUnit('a', 'order'),
    'the salt must actually change the result',
  );
});

// --- human hours -------------------------------------------------------------

test('every scheduled slot falls inside the posting window', () => {
  // Plan from 04:00 New York, deliberately outside the window.
  const beforeDawn = new Date('2026-09-17T08:00:00.000Z');
  const result = planSchedule([{ asset: IMAGE, destinations: LANES }], beforeDawn);

  assert.ok(result.scheduled.length > 0);
  for (const post of result.scheduled) {
    const { hour } = zonedParts(post.scheduledFor, DEFAULT_SCHEDULE.timezone);
    assert.ok(
      hour >= DEFAULT_SCHEDULE.window.startHour && hour <= DEFAULT_SCHEDULE.window.endHour,
      `${post.platform} scheduled at ${hour}:00 ${DEFAULT_SCHEDULE.timezone}, outside the window`,
    );
  }
});

test('the window is evaluated in the configured timezone, not UTC', () => {
  // The same instant is 08:00 in New York and 12:00 in UTC. Against a 9-21
  // window that is OUTSIDE in one zone and INSIDE in the other, which is the
  // whole point: reading the clock in UTC would post at 4am for the audience.
  const instant = new Date('2026-09-17T12:00:00.000Z');
  assert.equal(zonedParts(instant, 'America/New_York').hour, 8);
  assert.equal(zonedParts(instant, 'UTC').hour, 12);
  assert.equal(isInsideWindow(instant, DEFAULT_SCHEDULE), false, '08:00 ET is before the window opens');
  assert.equal(isInsideWindow(instant, { ...DEFAULT_SCHEDULE, timezone: 'UTC' }), true);
});

test('a slot pushed past midnight lands the NEXT morning, not at 00:00', () => {
  // 21:30 ET is still INSIDE the window: endHour 21 means a post may start
  // during hour 21. Asserting that first, because getting it wrong here is how
  // you accidentally shorten the posting day by an hour.
  const lastHour = new Date('2026-09-18T01:30:00.000Z'); // 21:30 ET
  assert.equal(zonedParts(lastHour, DEFAULT_SCHEDULE.timezone).hour, 21);
  assert.equal(nextInsideWindow(lastHour, DEFAULT_SCHEDULE).getTime(), lastHour.getTime());

  // 23:00 ET genuinely is outside, so it must move to the next opening.
  const lateNight = new Date('2026-09-18T03:00:00.000Z'); // 23:00 ET
  assert.equal(isInsideWindow(lateNight, DEFAULT_SCHEDULE), false);
  const moved = nextInsideWindow(lateNight, DEFAULT_SCHEDULE);
  assert.equal(
    zonedParts(moved, DEFAULT_SCHEDULE.timezone).hour,
    DEFAULT_SCHEDULE.window.startHour,
    'opens at the start of the window, not at midnight',
  );
  assert.ok(moved.getTime() > lateNight.getTime());
});

test('an inverted window fails loudly instead of scheduling nothing', () => {
  // A window that never opens would otherwise silently produce no posts, which
  // reads as "nothing to publish" rather than "your config is wrong".
  assert.throws(
    () => nextInsideWindow(NOON_ET, { ...DEFAULT_SCHEDULE, window: { startHour: 21, endHour: 9 } }),
    /inverted/,
  );
});

// --- spacing -----------------------------------------------------------------

test('one render does NOT hit every platform at the same instant', () => {
  const result = planSchedule([{ asset: IMAGE, destinations: LANES }], NOON_ET);
  const times = result.scheduled.map((p: any) => p.scheduledFor.getTime());
  assert.equal(new Set(times).size, times.length, 'every slot is distinct');

  // The cross-posting fingerprint: identical content landing everywhere at once.
  const spread = Math.max(...times) - Math.min(...times);
  assert.ok(
    spread >= DEFAULT_SCHEDULE.minCrossPlatformGapMinutes * 60 * 1000,
    `slots span only ${spread / 60000} minutes`,
  );
});

test('two posts to the SAME platform are at least the minimum gap apart', () => {
  const assets = [
    { asset: IMAGE, destinations: ['bluesky' as PlatformId] },
    { asset: { key: 'safe/2026-09-17/render-02.jpg', kind: 'image' as const }, destinations: ['bluesky' as PlatformId] },
    { asset: { key: 'safe/2026-09-17/render-03.jpg', kind: 'image' as const }, destinations: ['bluesky' as PlatformId] },
  ];
  const result = planSchedule(assets, NOON_ET);
  const times = result.scheduled
    .filter((p: any) => p.platform === 'bluesky')
    .map((p: any) => p.scheduledFor.getTime())
    .sort((a: number, b: number) => a - b);

  assert.equal(times.length, 3);
  for (let i = 1; i < times.length; i += 1) {
    const gap = (times[i] - times[i - 1]) / 60000;
    assert.ok(
      gap >= DEFAULT_SCHEDULE.minGapMinutes,
      `only ${gap} minutes between posts ${i - 1} and ${i}`,
    );
  }
});

// --- limits and idempotency ---------------------------------------------------

test('the daily limit defers rather than drops, and says so', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({
    asset: { key: `safe/2026-09-17/r-${i}.jpg`, kind: 'image' as const },
    destinations: ['bluesky' as PlatformId],
  }));
  const result = planSchedule(many, NOON_ET);

  assert.equal(result.scheduled.length, DEFAULT_SCHEDULE.cadence.maxPostsPerDay, 'capped at the cadence');
  assert.equal(result.deferred.length, 8 - DEFAULT_SCHEDULE.cadence.maxPostsPerDay);
  // "Deferred" must never read as "dropped" — it is picked up next pass.
  assert.match(result.deferred[0].reason, /Deferred, not dropped/);
});

test('an already-queued post is never scheduled twice', () => {
  const first = planSchedule([{ asset: IMAGE, destinations: ['bluesky'] }], NOON_ET);
  const again = planSchedule([{ asset: IMAGE, destinations: ['bluesky'] }], NOON_ET, first.scheduled);

  assert.equal(again.scheduled.length, 0, 'nothing new');
  assert.equal(again.deferred.length, 1);
  assert.match(again.deferred[0].reason, /already scheduled/);
});

test('posts already in the queue count toward the daily limit', () => {
  // Without this the limits mean nothing: every planning pass would think the
  // day was empty.
  const existing = planSchedule(
    Array.from({ length: 5 }, (_, i) => ({
      asset: { key: `safe/2026-09-17/prior-${i}.jpg`, kind: 'image' as const },
      destinations: ['bluesky' as PlatformId],
    })),
    NOON_ET,
  ).scheduled;

  const next = planSchedule([{ asset: IMAGE, destinations: ['bluesky'] }], NOON_ET, existing);
  assert.equal(next.scheduled.length, 0);
  assert.match(next.deferred[0].reason, /already has 5 post\(s\)/);
});

test('YouTube refuses an image at the planning stage via a zero limit', () => {
  const result = planSchedule([{ asset: IMAGE, destinations: ['youtube'] }], NOON_ET);
  assert.equal(result.scheduled.length, 0);
  assert.match(result.deferred[0].reason, /limit for image is 0/);
});

// --- draining -----------------------------------------------------------------

test('duePosts returns only what is due, oldest first', () => {
  const queue = planSchedule([{ asset: IMAGE, destinations: LANES }], NOON_ET).scheduled;
  const earliest = queue[0].scheduledFor;

  assert.deepEqual(duePosts(queue, new Date(earliest.getTime() - 1000)), [], 'nothing before its time');

  const atFirst = duePosts(queue, earliest);
  assert.equal(atFirst.length, 1, 'due at exactly its scheduled instant');

  const all = duePosts(queue, new Date(NOON_ET.getTime() + 48 * 60 * 60 * 1000));
  assert.equal(all.length, queue.length);
  for (let i = 1; i < all.length; i += 1) {
    assert.ok(all[i].scheduledFor.getTime() >= all[i - 1].scheduledFor.getTime(), 'oldest first');
  }
});
