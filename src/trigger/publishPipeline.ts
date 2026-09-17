/**
 * The pipeline: a finished render becomes scheduled posts.
 *
 *   publish-planner  (cron)  lists new assets, routes them, assigns slots,
 *                            and triggers one delayed child per destination
 *   publish-one      (child) wakes at its slot, re-checks the rail, publishes
 *
 * THERE IS NO QUEUE TABLE, on purpose. Trigger.dev's own `delay` and
 * `idempotencyKey` are the queue. That was verified by compiling against the
 * installed 3.3.17 SDK rather than assumed from the docs. It matters because a
 * queue I store myself is a queue I have to make crash-safe, and the platform
 * has already done that: a duplicate trigger with the same idempotency key is
 * refused server-side, so a planner that runs twice cannot double-post even if
 * my own logic is wrong.
 *
 * The planner is therefore safe to run as often as you like. Running it twice
 * is a no-op, not a second set of posts.
 */

import {
  ListObjectsV2Command,
  GetObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { logger, schedules, task, AbortTaskRunError } from "@trigger.dev/sdk/v3";

import {
  assertPublishAllowed,
  routeAsset,
  type AssetRef,
  type MediaKind,
  type PlatformId,
} from "../utils/contentRouting.js";
import {
  DEFAULT_SCHEDULE,
  planSchedule,
  type PlanInput,
} from "../utils/publishScheduler.js";
import {
  blueskyCredentialsFromEnv,
  createSession,
  publishPost,
  MAX_BLOB_BYTES,
} from "../utils/blueskyClient.js";
import {
  publishToTelegram,
  telegramCredentialsFromEnv,
} from "../utils/telegramClient.js";
import { generateCaption, fallbackCaption } from "../utils/captionGenerator.js";
import { tigrisClient } from "../utils/storageClient.js";
import { requireEnv } from "../utils/env.js";

/** Extension to media kind. An unknown extension is never guessed at. */
export function mediaKindFromKey(key: string): MediaKind | null {
  const lower = key.toLowerCase();
  if (/\.(jpe?g|png|webp)$/.test(lower)) return "image";
  if (/\.(mp4|mov|webm)$/.test(lower)) return "video";
  return null;
}

/** MIME type for the lanes that need one stated explicitly. */
export function mimeTypeFromKey(key: string): string | null {
  const lower = key.toLowerCase();
  if (/\.jpe?g$/.test(lower)) return "image/jpeg";
  if (/\.png$/.test(lower)) return "image/png";
  if (/\.webp$/.test(lower)) return "image/webp";
  if (/\.mp4$/.test(lower)) return "video/mp4";
  return null;
}

/** True for the downscaled derivative ComfyUI writes beside each master. */
export function isWebDerivative(key: string): boolean {
  return /-web\.[a-z0-9]+$/i.test(key);
}

/**
 * The `-web` sibling of a master key.
 *
 * "safe/2026-09-17/render-01.png" -> "safe/2026-09-17/render-01-web.jpg"
 *
 * The derivative is always JPEG, because that is what the ComfyUI workflow
 * writes and what keeps it under Bluesky's 1,000,000-byte ceiling.
 */
export function webDerivativeKey(masterKey: string): string {
  return masterKey.replace(/\.[a-z0-9]+$/i, "-web.jpg");
}

const HOT_BUCKET = () => requireEnv("TIGRIS_BUCKET_NAME");

/** Assets written in the last `hours`, excluding `-web` derivatives. */
export async function listRecentAssets(hours = 24): Promise<AssetRef[]> {
  const bucket = HOT_BUCKET();
  const cutoff = Date.now() - hours * 60 * 60 * 1000;
  const found: AssetRef[] = [];
  let token: string | undefined;

  do {
    const page = await tigrisClient.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    for (const item of page.Contents ?? []) {
      if (!item.Key || item.Key.endsWith("/")) continue;
      if (isWebDerivative(item.Key)) continue; // a derivative is not its own post
      if (!item.LastModified || item.LastModified.getTime() < cutoff) continue;

      const kind = mediaKindFromKey(item.Key);
      if (kind === null) {
        // Loudly, not silently: an unrecognised extension is a real thing to fix.
        logger.warn(
          `Skipping "${item.Key}": unrecognised extension, so its media kind cannot be ` +
            `determined. Nothing is guessed at here. Add the extension to mediaKindFromKey ` +
            `if this is a format we should publish.`,
        );
        continue;
      }
      found.push({ key: item.Key, kind });
    }
    token = page.NextContinuationToken;
  } while (token);

  return found.sort((a, b) => a.key.localeCompare(b.key));
}

async function bodyToBytes(body: unknown): Promise<Uint8Array> {
  const stream = body as { transformToByteArray?: () => Promise<Uint8Array> };
  if (typeof stream.transformToByteArray === "function") {
    return stream.transformToByteArray();
  }
  throw new Error("Unexpected S3 body type — cannot read the object.");
}

/**
 * Fetch the bytes a given platform should publish.
 *
 * For a size-constrained lane this prefers the `-web` derivative. If the
 * derivative is missing it falls back to the master and then fails the size
 * check with a message naming BOTH keys — because "image too large" without
 * saying which file and which derivative it wanted is a message that costs an
 * hour to act on.
 */
export async function fetchForPlatform(
  asset: AssetRef,
  platform: PlatformId,
): Promise<{ bytes: Uint8Array; mimeType: string; key: string }> {
  const bucket = HOT_BUCKET();
  const prefersDerivative = platform === "bluesky" && asset.kind === "image";

  const candidates = prefersDerivative
    ? [webDerivativeKey(asset.key), asset.key]
    : [asset.key];

  let lastError: unknown;
  for (const key of candidates) {
    try {
      const object = await tigrisClient.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      const bytes = await bodyToBytes(object.Body);
      const mimeType = object.ContentType ?? mimeTypeFromKey(key) ?? "application/octet-stream";

      if (prefersDerivative && key === asset.key && bytes.byteLength > MAX_BLOB_BYTES) {
        throw new AbortTaskRunError(
          `No web derivative for "${asset.key}" and the master is ${bytes.byteLength} bytes, ` +
            `over Bluesky's ${MAX_BLOB_BYTES}-byte limit. Expected to find ` +
            `"${webDerivativeKey(asset.key)}". Have the ComfyUI workflow write the -web copy ` +
            `(1600px longest edge, JPEG q85) alongside the master.`,
        );
      }
      return { bytes, mimeType, key };
    } catch (error) {
      if (error instanceof AbortTaskRunError) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `Could not read any of [${candidates.join(", ")}] from "${bucket}": ${String(lastError)}`,
  );
}

export interface PublishOnePayload {
  key: string;
  kind: MediaKind;
  platform: PlatformId;
  /**
   * Caption OVERRIDE. Omit it and one is generated for this platform.
   *
   * Supplying it explicitly is what makes a manual test run from the dashboard
   * console free and deterministic — no OpenAI call, no variation.
   */
  text?: string;
  altText?: string;
}

/**
 * Resolve the caption for a post.
 *
 * Generation failures THROW. A silent fall back to a placeholder would publish
 * "New image: render-01.jpg" for weeks before anyone noticed captions had
 * stopped being written — the same shape as a job that logs an error and
 * returns normally. Set CAPTIONS_ENABLED=false to opt out deliberately, which
 * is a different thing from failing.
 */
export async function resolveCaption(
  payload: PublishOnePayload,
  asset: AssetRef,
): Promise<string> {
  if (typeof payload.text === "string" && payload.text.trim() !== "") {
    return payload.text;
  }

  const context = {
    asset,
    platform: payload.platform,
    ...(process.env.PROMO_LINK_URL ? { linkUrl: process.env.PROMO_LINK_URL.trim() } : {}),
    ...(process.env.CAPTION_INTENSITY
      ? { intensity: process.env.CAPTION_INTENSITY.trim() as "soft" | "direct" | "hard" }
      : {}),
  };

  // Only the exact string "false" opts out, the same rule as every other flag
  // in this project, so a typo cannot silently disable caption generation.
  if ((process.env.CAPTIONS_ENABLED ?? "").trim().toLowerCase() === "false") {
    logger.info("Caption generation is disabled; using the plain fallback.");
    return fallbackCaption(context);
  }

  return generateCaption(context);
}

export const publishOne = task({
  id: "publish-one",
  // One attempt. A retry here re-enters run() from the top and would publish a
  // SECOND post — the same shape as the RunPod double-submission earlier in this
  // project, except the cost is a duplicate on a public feed. Trigger.dev's
  // idempotency key stops a duplicate TRIGGER; it does not stop a retry of an
  // attempt that already succeeded in posting before failing afterwards.
  retry: { maxAttempts: 1 },
  run: async (payload: PublishOnePayload) => {
    const asset: AssetRef = { key: payload.key, kind: payload.kind };

    // The rail, for the third and final time. Routing checked it, the adapter
    // checks it, and it is checked here before a single byte is read — because
    // this is the run that actually posts.
    assertPublishAllowed(payload.platform, asset);

    if (payload.platform !== "bluesky" && payload.platform !== "telegram") {
      throw new AbortTaskRunError(
        `No adapter is built for ${payload.platform} yet. Bluesky and Telegram are live; ` +
          `Instagram, Facebook, TikTok and YouTube are waiting on app review.`,
      );
    }

    const caption = await resolveCaption(payload, asset);
    const media = await fetchForPlatform(asset, payload.platform);
    logger.info("Publishing", {
      captionGenerated: payload.text === undefined,
      platform: payload.platform,
      assetKey: asset.key,
      bytesFrom: media.key,
      bytes: media.bytes.byteLength,
      usedWebDerivative: media.key !== asset.key,
    });

    if (payload.platform === "telegram") {
      // Telegram's photo ceiling is 10 MB against Bluesky's 1,000,000 bytes, so
      // this lane carries the master render and fetchForPlatform never reaches
      // for the -web derivative.
      const result = await publishToTelegram(telegramCredentialsFromEnv(), {
        bytes: media.bytes,
        filename: media.key.split("/").pop() ?? "render",
        mimeType: media.mimeType,
        kind: asset.kind,
        caption,
        asset,
      });
      logger.info(
        result.url
          ? `Published to Telegram: ${result.url}`
          : `Published to Telegram, message ${result.messageId} (private channel, no permalink)`,
        { messageId: result.messageId, url: result.url },
      );
      return { platform: payload.platform, messageId: result.messageId, url: result.url };
    }

    const session = await createSession(blueskyCredentialsFromEnv());
    const result = await publishPost(session, {
      text: caption,
      asset,
      langs: ["en"],
      ...(asset.kind === "image"
        ? {
            images: [
              {
                bytes: media.bytes,
                mimeType: media.mimeType,
                // Alt text is required by the lexicon. Falling back to the
                // caption is better than an empty string for a screen reader.
                alt: payload.altText ?? caption.slice(0, 280),
              },
            ],
          }
        : {}),
    });

    logger.info(`Published to Bluesky: ${result.url}`, { uri: result.uri, url: result.url });
    return { platform: payload.platform, uri: result.uri, url: result.url };
  },
});

/**
 * Move an asset into a classified location, without touching the storage console.
 *
 * Exists because getting a file under a prefix through a web console turned out
 * to be the single hardest step in this whole project for the person who has to
 * do it. Trigger.dev already holds the storage credentials, so a task can do it
 * with a button.
 *
 * IT NEVER CHOOSES THE CLASSIFICATION. The destination is supplied by a human
 * and must already be under safe/ or explicit/. Auto-filing a stray render into
 * safe/ would be exactly the unrecoverable mistake the routing rail exists to
 * prevent — a machine guessing that something is publishable.
 */
export const copyAsset = task({
  id: "copy-asset",
  retry: { maxAttempts: 1 },
  run: async (payload: { from: string; to: string; deleteOriginal?: boolean }) => {
    const bucket = HOT_BUCKET();
    const from = payload.from.replace(/^\/+/, "").trim();
    const to = payload.to.replace(/^\/+/, "").trim();

    if (from === "" || to === "") {
      throw new AbortTaskRunError("Both `from` and `to` are required.");
    }
    if (from === to) {
      throw new AbortTaskRunError("`from` and `to` are the same key — nothing to do.");
    }

    // The whole point of the guard: a destination nobody classified is not a
    // destination. Refusing here keeps the invariant that everything in a
    // publishable location was put there deliberately.
    const contentClass = classifyFromKey(to);
    if (contentClass === null) {
      throw new AbortTaskRunError(
        `Refusing to copy to "${to}": it is not under "safe/" or "explicit/". ` +
          `Choose the classification yourself — this task will not guess it for you, ` +
          `because guessing wrong is how explicit content reaches a public platform.`,
      );
    }

    const source = await tigrisClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: from }),
    );

    await tigrisClient.send(
      new CopyObjectCommand({
        Bucket: bucket,
        // CopySource is bucket + key, and the key must be URI-encoded or any
        // space or unusual character in the filename silently 404s.
        CopySource: `${bucket}/${encodeURIComponent(from)}`,
        Key: to,
      }),
    );

    // Verify it actually landed and is the same size. A copy that "succeeded"
    // and produced a zero-byte object would otherwise be reported as done.
    const copied = await tigrisClient.send(
      new HeadObjectCommand({ Bucket: bucket, Key: to }),
    );
    if (copied.ContentLength !== source.ContentLength) {
      throw new Error(
        `Copy verification failed: "${from}" is ${source.ContentLength} bytes but ` +
          `"${to}" is ${copied.ContentLength}. The original has NOT been deleted.`,
      );
    }

    let deleted = false;
    if (payload.deleteOriginal === true) {
      // Only after the copy is verified. A failed copy must never lose the file.
      await tigrisClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: from }));
      deleted = true;
    }

    logger.info(`Copied ${from} -> ${to}`, {
      bytes: copied.ContentLength,
      contentClass,
      originalDeleted: deleted,
    });

    return {
      from,
      to,
      bytes: copied.ContentLength ?? 0,
      contentClass,
      originalDeleted: deleted,
    };
  },
});

export interface PlannerResult {
  assetsSeen: number;
  triggered: number;
  deferred: number;
  blocked: number;
}

export const publishPlanner = schedules.task({
  id: "publish-planner",
  // Hourly. Safe to run more often — a duplicate trigger is refused by the
  // idempotency key, so a second pass in the same hour is a no-op.
  cron: { pattern: "0 * * * *", timezone: "UTC" },
  run: async (): Promise<PlannerResult> => {
    const assets = await listRecentAssets(24);
    logger.info(`Planner found ${assets.length} candidate asset(s) in the last 24h`, {
      keys: assets.map((a) => a.key),
    });

    const inputs: PlanInput[] = [];
    let blocked = 0;

    for (const asset of assets) {
      const decision = routeAsset(asset);
      if (decision.blockedReason) {
        // Never silent. An unclassified asset is a thing somebody must fix.
        logger.error(`BLOCKED: ${asset.key}`, { reason: decision.blockedReason });
        blocked += 1;
        continue;
      }
      if (decision.destinations.length === 0) {
        logger.warn(`No destination for ${asset.key}`, {
          rejected: decision.rejected.map((r) => `${r.platform}: ${r.reason}`),
        });
        continue;
      }
      inputs.push({ asset, destinations: decision.destinations });
    }

    const plan = planSchedule(inputs, new Date(), [], DEFAULT_SCHEDULE);

    let triggered = 0;
    for (const post of plan.scheduled) {
      // Only lanes with a working adapter are dispatched. The rest are planned
      // and reported so the schedule is visible before the adapters exist.
      if (post.platform !== "bluesky" && post.platform !== "telegram") {
        logger.info(`Planned (no adapter yet): ${post.platform} ${post.asset.key}`, {
          scheduledFor: post.scheduledFor.toISOString(),
        });
        continue;
      }

      await publishOne.trigger(
        {
          key: post.asset.key,
          kind: post.asset.kind,
          platform: post.platform,
          // No text: publish-one generates a per-platform caption at its slot.
          // Generating here would produce one caption reused across every
          // destination, which is the cross-posting fingerprint the staggered
          // scheduling exists to avoid.
        },
        {
          delay: post.scheduledFor,
          // Server-side duplicate protection. This is what makes the planner
          // safe to re-run: the same asset and platform can only ever produce
          // one queued post, regardless of how many times this task runs.
          idempotencyKey: post.idempotencyKey,
        },
      );
      triggered += 1;
      logger.info(`Queued ${post.platform} ${post.asset.key}`, {
        scheduledFor: post.scheduledFor.toISOString(),
        idempotencyKey: post.idempotencyKey,
      });
    }

    for (const item of plan.deferred) {
      logger.info(`Deferred ${item.platform} ${item.asset.key}`, { reason: item.reason });
    }

    const result: PlannerResult = {
      assetsSeen: assets.length,
      triggered,
      deferred: plan.deferred.length,
      blocked,
    };

    if (blocked > 0) {
      // A blocked asset means a render is sitting in storage that will never be
      // published. The run stays green for the posts that worked, but this must
      // not be discoverable only by reading logs nobody opens.
      throw new Error(
        `${blocked} asset(s) could not be classified and were not published. ` +
          `See the BLOCKED lines above — each one names the key. Move them under safe/ or ` +
          `explicit/ and they will be picked up on the next pass.`,
      );
    }

    return result;
  },
});
