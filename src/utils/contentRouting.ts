/**
 * Which asset is allowed to go where.
 *
 * This is the safety rail for the whole publishing pipeline, and it is the one
 * part of the system where a mistake cannot be undone. Explicit material
 * reaching Instagram, TikTok, YouTube, Facebook or X does not get fixed by
 * deleting the post: the account is gone, and the audience with it. Every other
 * failure in this project is recoverable. This one is not.
 *
 * So the rule lives in code rather than in a naming convention someone has to
 * remember, and it is enforced TWICE — once when an asset is routed, and again
 * immediately before a publish call goes out. Two independent checks, because
 * the cost of the first one having a bug is permanent.
 *
 * Three principles, all of which this project has already learned the hard way:
 *
 *   1. FAIL CLOSED. An asset whose classification cannot be read goes NOWHERE.
 *      It never falls back to the social platforms. Same shape as the sweeper's
 *      dry-run flag: the dangerous direction requires an exact opt-in, so every
 *      typo lands on the safe side.
 *
 *   2. FAIL LOUDLY. "Goes nowhere" must never mean "silently skipped". An
 *      unroutable asset returns a stated reason so the caller can raise it. A
 *      job that logs a problem and returns normally is recorded as a success,
 *      and nobody ever finds out.
 *
 *   3. NO SUBSTRING MATCHING. Classification reads the FIRST PATH SEGMENT of the
 *      key and compares it exactly. "safe/explicit-pose/01.png" is safe — it is
 *      in the safe folder — and no amount of the word "explicit" appearing later
 *      in the key changes that.
 */

/** What an asset is, for routing purposes. Nothing else is a valid value. */
export type ContentClass = "safe" | "explicit";

/** What kind of media it is. Some platforms accept only one. */
export type MediaKind = "image" | "video";

export type PlatformId =
  | "bluesky"
  | "instagram"
  | "facebook"
  | "x"
  | "tiktok"
  | "youtube"
  | "fanvue";

export interface Platform {
  id: PlatformId;
  label: string;
  /** Content classes this destination may receive. */
  accepts: readonly ContentClass[];
  /** Media kinds this destination can publish at all. */
  media: readonly MediaKind[];
  /**
   * The platform's own published ceiling per 24h, where one exists, as a hard
   * backstop independent of the configured cadence. Undefined means "no
   * documented hard cap" — which is NOT the same as unlimited, so the
   * configured cadence still applies.
   */
  apiCeilingPerDay?: number;
  /** True for anything that is not a mainstream social network. */
  adultPlatform: boolean;
}

/**
 * Object.freeze is SHALLOW. Freezing the outer table leaves every platform
 * object inside it writable, so `PLATFORMS.instagram.accepts = [...]` would
 * still succeed — and that single line is the whole catastrophe this file
 * exists to prevent. A safety rule that can be edited at runtime is not a
 * safety rule. This was caught by the freeze test, not by reading the code.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

/**
 * Fansly is deliberately absent.
 *
 * It has no official developer API. Everything advertising itself as a "Fansly
 * API" is a third party that works by taking your Fansly session credentials —
 * for the account holding the earnings and payout details — and most are
 * scrapers besides. It stays a manual lane rather than an automated one.
 */
export const PLATFORMS: Readonly<Record<PlatformId, Platform>> = deepFreeze({
  bluesky: {
    id: "bluesky",
    label: "Bluesky",
    accepts: ["safe"],
    media: ["image", "video"],
    adultPlatform: false,
  },
  instagram: {
    id: "instagram",
    label: "Instagram",
    accepts: ["safe"],
    media: ["image", "video"],
    // Content Publishing API: 25 published posts per rolling 24 hours.
    apiCeilingPerDay: 25,
    adultPlatform: false,
  },
  facebook: {
    id: "facebook",
    label: "Facebook",
    accepts: ["safe"],
    media: ["image", "video"],
    adultPlatform: false,
  },
  x: {
    id: "x",
    label: "X",
    accepts: ["safe"],
    media: ["image", "video"],
    adultPlatform: false,
  },
  tiktok: {
    id: "tiktok",
    label: "TikTok",
    accepts: ["safe"],
    // Confirmed against the Content Posting API: photo posts are supported via
    // media_type PHOTO, 1-10 images, JPG/JPEG. So this lane needs no
    // image-to-video step.
    media: ["image", "video"],
    adultPlatform: false,
  },
  youtube: {
    id: "youtube",
    label: "YouTube Shorts",
    accepts: ["safe"],
    // Video only. A still image cannot be published as a Short at all.
    media: ["video"],
    // ~1600 quota units per upload against a 10,000/day default.
    apiCeilingPerDay: 6,
    adultPlatform: false,
  },
  fanvue: {
    id: "fanvue",
    label: "Fanvue",
    accepts: ["safe", "explicit"],
    media: ["image", "video"],
    adultPlatform: true,
  },
} as Record<PlatformId, Platform>);

export const ALL_PLATFORMS: readonly PlatformId[] = Object.freeze(
  Object.keys(PLATFORMS) as PlatformId[],
);

/**
 * The six mainstream lanes — the ones where a wrong post is unrecoverable.
 *
 * Derived from the flag rather than hand-listed, so adding a platform above
 * cannot leave this list quietly stale. A hand-written list in this package has
 * already gone out of date once, in install.sh, and nobody noticed until the
 * file it omitted turned out not to exist in the target repo.
 */
export const SOCIAL_PLATFORMS: readonly PlatformId[] = Object.freeze(
  ALL_PLATFORMS.filter((id) => !PLATFORMS[id].adultPlatform),
);

/** Storage prefixes that carry the classification. Exact, lowercase, no aliases. */
export const CLASS_PREFIX: Readonly<Record<ContentClass, string>> = Object.freeze({
  safe: "safe/",
  explicit: "explicit/",
});

export interface AssetRef {
  /** Object key in the hot bucket, e.g. "safe/2026-09-16/render-01.png". */
  key: string;
  kind: MediaKind;
}

/**
 * Read the classification off an object key.
 *
 * Returns null — never a guess — when the first path segment is not exactly
 * "safe" or "explicit". Case matters: S3 keys are case-sensitive, and being
 * lenient here is only ever dangerous in one direction. Treating "Safe/" as
 * safe would route a mislabelled asset to six public platforms; refusing it
 * means nothing posts and somebody notices. The second outcome is recoverable
 * and the first is not, so this is strict.
 */
export function classifyFromKey(key: string): ContentClass | null {
  const normalised = key.replace(/^\/+/, "");
  const firstSegment = normalised.slice(0, normalised.indexOf("/") + 1);
  if (firstSegment === CLASS_PREFIX.safe) return "safe";
  if (firstSegment === CLASS_PREFIX.explicit) return "explicit";
  return null;
}

export interface RoutingDecision {
  /** Destinations this asset may be published to. Empty is a valid answer. */
  destinations: PlatformId[];
  contentClass: ContentClass | null;
  /**
   * Every destination that was considered and rejected, with the reason.
   * Present so a run can say WHY nothing was published rather than reporting
   * an empty list as though it were a normal result.
   */
  rejected: Array<{ platform: PlatformId; reason: string }>;
  /**
   * Set when the asset cannot be routed at all. The caller must treat this as
   * an error, not as "nothing to do".
   */
  blockedReason?: string;
}

/**
 * Decide where an asset is allowed to go.
 *
 * `requested` narrows the candidates; omitting it considers every platform.
 * Narrowing can only ever REMOVE destinations — a caller cannot ask for a
 * destination the rules forbid and get it.
 */
export function routeAsset(
  asset: AssetRef,
  requested: readonly PlatformId[] = ALL_PLATFORMS,
): RoutingDecision {
  const contentClass = classifyFromKey(asset.key);
  const rejected: RoutingDecision["rejected"] = [];

  if (contentClass === null) {
    return {
      destinations: [],
      contentClass: null,
      rejected: [],
      blockedReason:
        `Cannot classify "${asset.key}": its first path segment is neither ` +
        `"${CLASS_PREFIX.safe}" nor "${CLASS_PREFIX.explicit}". Nothing is published for an ` +
        `asset whose classification is unknown — this is deliberate, not a bug. ` +
        `Move it under the correct prefix and re-queue it.`,
    };
  }

  const destinations: PlatformId[] = [];
  for (const id of requested) {
    const platform = PLATFORMS[id];
    if (!platform) {
      rejected.push({ platform: id, reason: `unknown platform "${id}"` });
      continue;
    }
    if (!platform.accepts.includes(contentClass)) {
      rejected.push({
        platform: id,
        reason: `${platform.label} accepts ${platform.accepts.join("/")} content only, this asset is ${contentClass}`,
      });
      continue;
    }
    if (!platform.media.includes(asset.kind)) {
      rejected.push({
        platform: id,
        reason: `${platform.label} cannot publish ${asset.kind} (accepts ${platform.media.join("/")})`,
      });
      continue;
    }
    destinations.push(id);
  }

  return { destinations, contentClass, rejected };
}

/**
 * The second, independent check. Adapters call this immediately before the
 * publish request goes out.
 *
 * It duplicates work routeAsset already did, on purpose. A routing bug that
 * slipped an explicit asset into the Instagram queue is caught here instead of
 * on Instagram, and the cost of the duplication is a few microseconds against
 * a permanent ban.
 *
 * Throws rather than returning false: there is no sensible way for a caller to
 * ignore this, so it should not be possible to ignore it by forgetting an if.
 */
export function assertPublishAllowed(platformId: PlatformId, asset: AssetRef): void {
  const platform = PLATFORMS[platformId];
  if (!platform) {
    throw new Error(`Refusing to publish: unknown platform "${platformId}".`);
  }

  const contentClass = classifyFromKey(asset.key);
  if (contentClass === null) {
    throw new Error(
      `Refusing to publish "${asset.key}" to ${platform.label}: its classification cannot be ` +
        `read from the key. An unclassified asset is never published anywhere.`,
    );
  }

  if (!platform.accepts.includes(contentClass)) {
    throw new Error(
      `BLOCKED: refusing to publish ${contentClass} content to ${platform.label}. ` +
        `Key "${asset.key}". This would risk permanent loss of the account, so it is ` +
        `refused at the last possible moment regardless of what queued it.`,
    );
  }

  if (!platform.media.includes(asset.kind)) {
    throw new Error(
      `Refusing to publish ${asset.kind} to ${platform.label}, which accepts ` +
        `${platform.media.join("/")} only. Key "${asset.key}".`,
    );
  }
}

/** Per-platform posting cadence. The configured rate, not the platform's ceiling. */
export interface Cadence {
  maxPostsPerDay: number;
  maxVideosPerDay: number;
}

/**
 * The agreed cadence: 2-3 posts or 1 video per day, per platform.
 *
 * Chosen by the client to look like a person rather than a feed, and it sits far
 * below every API ceiling. That is worth being explicit about, because it
 * changes what the rate limiter is FOR: it is not a throttle holding the
 * account back, it is a backstop against this code misbehaving — a retry storm,
 * a duplicated fan-out, a scheduling bug draining the queue at once.
 */
export const DEFAULT_CADENCE: Readonly<Cadence> = Object.freeze({
  maxPostsPerDay: 3,
  maxVideosPerDay: 1,
});

/**
 * The effective daily limit for a platform and media kind: the stricter of the
 * configured cadence and the platform's own documented ceiling.
 *
 * Taking the minimum rather than trusting either alone means raising the
 * cadence later can never accidentally exceed what the API will accept, and a
 * platform loosening its ceiling does not silently change the posting rhythm.
 */
export function dailyLimitFor(
  platformId: PlatformId,
  kind: MediaKind,
  cadence: Cadence = DEFAULT_CADENCE,
): number {
  const platform = PLATFORMS[platformId];
  if (!platform) throw new Error(`Unknown platform "${platformId}".`);
  if (!platform.media.includes(kind)) return 0;

  const configured = kind === "video" ? cadence.maxVideosPerDay : cadence.maxPostsPerDay;
  const ceiling = platform.apiCeilingPerDay;
  return ceiling === undefined ? configured : Math.min(configured, ceiling);
}

/**
 * A stable idempotency key for one publish attempt.
 *
 * Keyed on asset AND destination, not the asset alone. One asset now fans out
 * to several platforms, so an attempt that succeeded on Bluesky and failed on X
 * must be able to retry X without re-posting to Bluesky. Keying on the asset
 * alone gives you exactly one of those two bugs and no way to have neither.
 */
export function publishIdempotencyKey(asset: AssetRef, platformId: PlatformId): string {
  return `${platformId}:${asset.key}`;
}
