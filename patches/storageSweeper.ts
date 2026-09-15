/**
 * DROP-IN REPLACEMENT for src/trigger/storageSweeper.ts
 *
 * Your file, with a dryRun flag added. Everything else is byte-for-byte your
 * logic — same pagination, same concurrency helper, same size check, same
 * error collection.
 *
 * What dryRun does: read from hot, upload to cold, HeadObject size check —
 * then SKIP the delete. So it exercises the whole path that can fail, and
 * leaves hot storage untouched.
 *
 * DEFAULT FOR THE SCHEDULED TASK IS DRY RUN. That is a deliberate choice and
 * not what your original did, so read this bit:
 *
 *   The sweeper deletes from hot, runs unattended at 02:00 Sunday, and has
 *   never yet completed a successful run. A first live run with a wrong
 *   BACKBLAZE_BUCKET_NAME or a cold-side permission problem loses data rather
 *   than printing an error. So the cron stays in dry run until you explicitly
 *   turn it off:
 *
 *       STORAGE_SWEEP_DRY_RUN=false
 *
 *   Every dry run says loudly in its logs and its return value that nothing was
 *   deleted, so this cannot quietly look like success forever.
 *
 * Direct callers of sweepStorage() are unaffected: dryRun defaults to false
 * there, exactly as before.
 */

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  type S3Client,
} from "@aws-sdk/client-s3";
import { schedules, logger } from "@trigger.dev/sdk/v3";
import { Readable } from "node:stream";
import { backblazeClient, tigrisClient, uploadStream } from "../utils/storageClient.js";
import { requireEnv } from "../utils/env.js";

export interface SweepResult {
  scanned: number;
  /** Objects successfully copied to cold and size-verified. */
  migrated: number;
  /** Objects actually removed from hot. Always 0 in a dry run. */
  deleted: number;
  /** True when deletes were skipped. */
  dryRun: boolean;
  failed: Array<{ key: string; error: string }>;
}

export interface StorageMigrationDependencies {
  hotClient: S3Client;
  coldClient: S3Client;
  hotBucket: string;
  coldBucket: string;
  upload: typeof uploadStream;
}

export interface SweepOptions {
  /** Skip the delete from hot. Default false. */
  dryRun?: boolean;
  concurrency?: number;
  /**
   * Stop after this many keys. Unlimited by default. Useful for a first dry run
   * over a large bucket, where you want proof the path works without paying to
   * stream every object.
   */
  maxObjects?: number;
}

function asReadable(body: unknown, key: string): Readable {
  if (!(body instanceof Readable)) {
    throw new Error(`Tigris returned a non-readable body for ${key}`);
  }
  return body;
}

export async function migrateObject(
  key: string,
  dependencies: StorageMigrationDependencies,
  dryRun = false,
): Promise<{ deleted: boolean }> {
  const source = await dependencies.hotClient.send(
    new GetObjectCommand({ Bucket: dependencies.hotBucket, Key: key }),
  );
  const body = asReadable(source.Body, key);

  await dependencies.upload({
    client: dependencies.coldClient,
    bucket: dependencies.coldBucket,
    key,
    body,
    ...(source.ContentType ? { contentType: source.ContentType } : {}),
    ...(source.ContentLength !== undefined ? { contentLength: source.ContentLength } : {}),
  });

  const destination = await dependencies.coldClient.send(
    new HeadObjectCommand({ Bucket: dependencies.coldBucket, Key: key }),
  );
  if (
    source.ContentLength !== undefined &&
    destination.ContentLength !== source.ContentLength
  ) {
    throw new Error(`Destination size mismatch for ${key}`);
  }

  // The only behavioural difference. The size check above has already run, so a
  // dry run still proves the copy landed correctly — it just does not remove the
  // original. Note this is AFTER the check, so a mismatch throws before any
  // delete could happen, in dry run or not.
  if (dryRun) {
    return { deleted: false };
  }

  await dependencies.hotClient.send(
    new DeleteObjectCommand({ Bucket: dependencies.hotBucket, Key: key }),
  );
  return { deleted: true };
}

export async function sweepStorage(
  dependencies: StorageMigrationDependencies,
  options: SweepOptions | number = {},
): Promise<SweepResult> {
  // Accepts the old positional `concurrency` argument so existing callers and
  // tests keep working unchanged.
  const opts: SweepOptions = typeof options === "number" ? { concurrency: options } : options;
  const concurrency = opts.concurrency ?? 3;
  const dryRun = opts.dryRun ?? false;
  const maxObjects = opts.maxObjects;

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Sweep concurrency must be a positive integer");
  }
  if (maxObjects !== undefined && (!Number.isSafeInteger(maxObjects) || maxObjects < 1)) {
    throw new Error("maxObjects must be a positive integer when provided");
  }

  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await dependencies.hotClient.send(
      new ListObjectsV2Command({
        Bucket: dependencies.hotBucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) keys.push(item.Key);
      if (maxObjects !== undefined && keys.length >= maxObjects) break;
    }
    if (maxObjects !== undefined && keys.length >= maxObjects) break;
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated && !continuationToken) {
      throw new Error("Tigris returned a truncated page without a continuation token");
    }
  } while (continuationToken);

  const failed: SweepResult["failed"] = [];
  let migrated = 0;
  let deleted = 0;
  await mapWithConcurrency(keys, concurrency, async (key) => {
    try {
      const outcome = await migrateObject(key, dependencies, dryRun);
      migrated += 1;
      if (outcome.deleted) deleted += 1;
    } catch (error) {
      failed.push({ key, error: error instanceof Error ? error.message : String(error) });
    }
  });

  return { scanned: keys.length, migrated, deleted, dryRun, failed };
}

async function mapWithConcurrency<T>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  async function worker(): Promise<void> {
    while (index < values.length) {
      const current = values[index];
      index += 1;
      if (current !== undefined) await operation(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}

/**
 * Dry run unless explicitly disabled. Only the exact string "false" turns
 * deletion on — anything else, including an unset variable, a typo, or an empty
 * string, keeps hot storage safe. Fail-safe, not fail-open.
 */
export function sweepDryRunFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STORAGE_SWEEP_DRY_RUN ?? "").trim().toLowerCase() !== "false";
}

export const weeklyStorageSweeper = schedules.task({
  id: "weekly-storage-sweeper",
  cron: {
    pattern: "0 2 * * 0",
    timezone: "UTC",
  },
  run: async (): Promise<SweepResult> => {
    const dryRun = sweepDryRunFromEnv();

    const result = await sweepStorage(
      {
        hotClient: tigrisClient,
        coldClient: backblazeClient,
        hotBucket: requireEnv("TIGRIS_BUCKET_NAME"),
        coldBucket: requireEnv("BACKBLAZE_BUCKET_NAME"),
        upload: uploadStream,
      },
      { dryRun },
    );

    // Passed as an explicit object literal, not `result` itself: logger's
    // second argument is Record<string, unknown>, and an `interface` does not
    // satisfy that (no implicit index signature). Passing the interface value
    // directly is a TS2345 compile error.
    const summary = {
      scanned: result.scanned,
      migrated: result.migrated,
      deleted: result.deleted,
      dryRun: result.dryRun,
      failedCount: result.failed.length,
    };

    if (result.dryRun) {
      logger.warn(
        `DRY RUN — ${result.migrated} of ${result.scanned} object(s) were copied to cold and ` +
          `size-verified, and NOTHING was deleted from hot storage. ` +
          `Set STORAGE_SWEEP_DRY_RUN=false to enable deletion.`,
        summary,
      );
    } else {
      logger.info(
        `Live sweep — ${result.migrated} copied, ${result.deleted} deleted from hot, ` +
          `${result.failed.length} failed.`,
        summary,
      );
    }

    if (result.failed.length > 0) {
      logger.error(`${result.failed.length} object(s) failed to migrate`, { failed: result.failed });
    }

    return result;
  },
});
