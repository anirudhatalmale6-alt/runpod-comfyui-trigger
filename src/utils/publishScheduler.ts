/**
 * When each post actually goes out.
 *
 * At 3-5 posts a day the volume is never the risk — the timing is. Six
 * destinations receiving the identical asset in the same minute, every time, is
 * the clearest automation signal there is, and it is exactly the pattern spam
 * filters look for. So one render fans out to many destinations, but the slots
 * are spread across a posting window with jitter, and no two land together.
 *
 * Three properties this has to have, and each one is a test below:
 *
 *   DETERMINISTIC. The jitter is derived from the idempotency key, not from
 *   Math.random(). The same asset therefore always gets the same slot, so
 *   re-planning after a crash produces the identical schedule instead of a
 *   second, differently-timed set of posts. It also means the tests are not
 *   flaky, which is the only reason anyone would believe them.
 *
 *   INSIDE HUMAN HOURS. Three posts at 03:00 reads as a bot however modest the
 *   count. Slots fall inside a configured window, in the audience's timezone,
 *   never outside it.
 *
 *   SPACED. A minimum gap between consecutive posts to the same platform, so a
 *   burst cannot form even if a backlog drains at once.
 */

import {
  DEFAULT_CADENCE,
  PLATFORMS,
  dailyLimitFor,
  publishIdempotencyKey,
  type AssetRef,
  type Cadence,
  type PlatformId,
} from "./contentRouting.js";

export interface PostingWindow {
  /** First hour a post may land, 0-23, in the configured timezone. */
  startHour: number;
  /** Last hour a post may START in, 0-23 inclusive. */
  endHour: number;
}

export interface ScheduleConfig {
  /**
   * IANA timezone the window is expressed in. US Eastern by default: it covers
   * both American coasts sensibly, since evening in New York is late afternoon
   * in Los Angeles.
   */
  timezone: string;
  window: PostingWindow;
  /** Minimum gap between two posts to the SAME platform. */
  minGapMinutes: number;
  /**
   * Minimum gap between the same asset landing on two DIFFERENT platforms.
   * This is the cross-posting fingerprint, so it matters more than it looks.
   */
  minCrossPlatformGapMinutes: number;
  cadence: Cadence;
}

export const DEFAULT_SCHEDULE: Readonly<ScheduleConfig> = Object.freeze({
  timezone: "America/New_York",
  window: Object.freeze({ startHour: 9, endHour: 21 }),
  minGapMinutes: 90,
  minCrossPlatformGapMinutes: 7,
  cadence: DEFAULT_CADENCE,
});

export interface ScheduledPost {
  asset: AssetRef;
  platform: PlatformId;
  /** When this should publish. */
  scheduledFor: Date;
  /** Stable across re-planning; the queue dedupes on it. */
  idempotencyKey: string;
}

export interface PlanInput {
  asset: AssetRef;
  destinations: readonly PlatformId[];
}

export interface PlanResult {
  scheduled: ScheduledPost[];
  /** Destinations dropped because the day is already full, with the reason. */
  deferred: Array<{ platform: PlatformId; asset: AssetRef; reason: string }>;
}

/**
 * A small deterministic hash. FNV-1a: not cryptographic, and it does not need
 * to be — it only has to spread keys evenly and give the same answer every run.
 */
export function hashKey(key: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic value in [0, 1) derived from a key and a salt. */
export function deterministicUnit(key: string, salt: string): number {
  return hashKey(`${salt}:${key}`) / 0x100000000;
}

/**
 * The hour and minute a Date falls on in a given timezone.
 *
 * Done with Intl rather than by adding an offset, because a fixed offset is
 * wrong for half the year in any zone that observes daylight saving — and
 * "wrong for half the year" is the kind of bug that surfaces as posts drifting
 * an hour in March and nobody connecting it to the code.
 */
export function zonedParts(date: Date, timezone: string): { hour: number; minute: number } {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // Intl renders midnight as "24" in some environments.
  return { hour: hour === 24 ? 0 : hour, minute };
}

export function isInsideWindow(date: Date, config: ScheduleConfig): boolean {
  const { hour } = zonedParts(date, config.timezone);
  return hour >= config.window.startHour && hour <= config.window.endHour;
}

/**
 * Move a candidate time forward until it falls inside the posting window.
 *
 * Steps in whole hours and re-checks, rather than computing an offset, so it
 * stays correct across a daylight-saving boundary. Bounded at 48 iterations so
 * a misconfigured window (endHour before startHour, say) fails fast with a
 * clear error instead of looping forever.
 */
export function nextInsideWindow(from: Date, config: ScheduleConfig): Date {
  if (config.window.startHour > config.window.endHour) {
    throw new Error(
      `Posting window is inverted: startHour ${config.window.startHour} is after endHour ` +
        `${config.window.endHour}. A window that never opens would silently schedule nothing.`,
    );
  }
  let candidate = new Date(from.getTime());
  for (let i = 0; i < 48; i += 1) {
    if (isInsideWindow(candidate, config)) return candidate;
    // Advance to the top of the next hour.
    candidate = new Date(candidate.getTime() + 60 * 60 * 1000);
    candidate.setUTCSeconds(0, 0);
  }
  throw new Error(
    `Could not find a slot inside ${config.window.startHour}:00-${config.window.endHour}:59 ` +
      `${config.timezone} within 48 hours of ${from.toISOString()}.`,
  );
}

/**
 * Plan where a batch of assets lands.
 *
 * `alreadyScheduled` is what the queue already holds for the next 24 hours, so
 * the daily limits and the spacing account for posts planned by an earlier run.
 * Without it every invocation would think the day was empty and the limits
 * would mean nothing.
 */
export function planSchedule(
  inputs: readonly PlanInput[],
  now: Date,
  alreadyScheduled: readonly ScheduledPost[] = [],
  config: ScheduleConfig = DEFAULT_SCHEDULE,
): PlanResult {
  const scheduled: ScheduledPost[] = [];
  const deferred: PlanResult["deferred"] = [];

  // Per-platform view of the next 24h, seeded with what is already queued.
  const horizonMs = now.getTime() + 24 * 60 * 60 * 1000;
  const taken = new Map<PlatformId, Date[]>();
  for (const post of alreadyScheduled) {
    if (post.scheduledFor.getTime() > horizonMs) continue;
    const list = taken.get(post.platform) ?? [];
    list.push(post.scheduledFor);
    taken.set(post.platform, list);
  }

  const seen = new Set(alreadyScheduled.map((p) => p.idempotencyKey));

  for (const input of inputs) {
    // Cross-platform offset is per asset, so the same render does not hit
    // every destination at once. Order is deterministic but varies by asset,
    // so it is not always Bluesky first.
    const ordered = [...input.destinations].sort(
      (a, b) =>
        deterministicUnit(input.asset.key, a) - deterministicUnit(input.asset.key, b),
    );

    let crossOffsetMinutes = 0;
    for (const platform of ordered) {
      const idempotencyKey = publishIdempotencyKey(input.asset, platform);

      if (seen.has(idempotencyKey)) {
        deferred.push({
          platform,
          asset: input.asset,
          reason: `already scheduled — ${idempotencyKey} is in the queue, not duplicating it`,
        });
        continue;
      }

      const limit = dailyLimitFor(platform, input.asset.kind, config.cadence);
      const existing = taken.get(platform) ?? [];
      if (existing.length >= limit) {
        deferred.push({
          platform,
          asset: input.asset,
          reason:
            `${PLATFORMS[platform].label} already has ${existing.length} post(s) in the next 24h ` +
            `and the limit for ${input.asset.kind} is ${limit}. Deferred, not dropped — it will be ` +
            `picked up by the next planning pass.`,
        });
        continue;
      }

      // Start from the later of: now plus the cross-platform stagger, or the
      // last post to this platform plus the minimum gap.
      const lastForPlatform = existing.length
        ? Math.max(...existing.map((d) => d.getTime()))
        : 0;
      const earliest = Math.max(
        now.getTime() + crossOffsetMinutes * 60 * 1000,
        lastForPlatform ? lastForPlatform + config.minGapMinutes * 60 * 1000 : 0,
      );

      // Jitter derived from the key, never from a clock or a random source, so
      // the same asset always lands in the same slot.
      const jitterMinutes = Math.floor(
        deterministicUnit(idempotencyKey, "jitter") * config.minGapMinutes,
      );
      const candidate = new Date(earliest + jitterMinutes * 60 * 1000);
      const slot = nextInsideWindow(candidate, config);

      scheduled.push({ asset: input.asset, platform, scheduledFor: slot, idempotencyKey });
      seen.add(idempotencyKey);
      taken.set(platform, [...existing, slot]);

      crossOffsetMinutes += config.minCrossPlatformGapMinutes;
    }
  }

  scheduled.sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
  return { scheduled, deferred };
}

/** Posts whose time has come. Everything else stays queued. */
export function duePosts(queue: readonly ScheduledPost[], now: Date): ScheduledPost[] {
  return queue
    .filter((post) => post.scheduledFor.getTime() <= now.getTime())
    .sort((a, b) => a.scheduledFor.getTime() - b.scheduledFor.getTime());
}
