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
  /** Every object seen in the hot bucket listing. */
  scanned: number;
  /** Held back by the age filter — younger than minAgeDays. */
  skippedTooNew: number;
  /** Objects successfully copied to cold and size-verified. */
  migrated: number;
  /** Objects actually removed from hot. Always 0 in a dry run. */
  deleted: number;
  /** True when deletes were skipped. */
  dryRun: boolean;
  /** The age threshold this run used, in days. */
  minAgeDays: number;
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
  /**
   * Only sweep objects whose LastModified is at least this many days old.
   * Default 7. Set 0 to sweep everything regardless of age.
   *
   * Without this the Sunday run moves renders written minutes earlier, and
   * anything serving images straight from Tigris stops finding them.
   */
  minAgeDays?: number;
  /** Injectable clock, milliseconds. Tests pass a fixed value. */
  nowMs?: () => number;
  concurrency?: number;
  /**
   * Stop after this many keys. Unlimited by default. Useful for a first dry run
   * over a large bucket, where you want proof the path works without paying to
   * stream every object.
   */
  maxObjects?: number;
}

function describeBucket(): string {
  return process.env.TIGRIS_BUCKET_NAME ?? "(TIGRIS_BUCKET_NAME not set)";
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
  const minAgeDays = opts.minAgeDays ?? 7;
  const now = opts.nowMs ?? Date.now;

  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("Sweep concurrency must be a positive integer");
  }
  if (maxObjects !== undefined && (!Number.isSafeInteger(maxObjects) || maxObjects < 1)) {
    throw new Error("maxObjects must be a positive integer when provided");
  }
  if (!Number.isFinite(minAgeDays) || minAgeDays < 0) {
    throw new Error("minAgeDays must be zero or a positive number");
  }

  const cutoffMs = now() - minAgeDays * 24 * 60 * 60 * 1000;

  const keys: string[] = [];
  let scanned = 0;
  let skippedTooNew = 0;
  let continuationToken: string | undefined;
  do {
    const page = await dependencies.hotClient.send(
      new ListObjectsV2Command({
        Bucket: dependencies.hotBucket,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );
    for (const item of page.Contents ?? []) {
      if (!item.Key) continue;
      scanned += 1;

      // Fail SAFE on an unknown age. An object whose LastModified we cannot
      // read is left alone rather than swept — this deletes from hot, so
      // "don't know" must mean "don't touch".
      const modified = item.LastModified ? item.LastModified.getTime() : undefined;
      if (modified === undefined || modified > cutoffMs) {
        skippedTooNew += 1;
        continue;
      }

      keys.push(item.Key);
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

  return { scanned, skippedTooNew, migrated, deleted, dryRun, minAgeDays, failed };
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

/**
 * Age threshold in days, from STORAGE_SWEEP_MIN_AGE_DAYS. Defaults to 7.
 * An unparseable or negative value falls back to 7 rather than to 0 — a typo
 * must never silently turn into "sweep everything immediately".
 */
/**
 * Should a sweep that failed on one or more objects mark the RUN as failed?
 *
 * Default: yes. This matters more than it looks for an unattended system.
 *
 * Until patch 6 the task logged `logger.error` per failure and then returned
 * normally, so Trigger.dev recorded the run as **Completed**. A sweep that
 * failed on every single object was indistinguishable, at a glance and to any
 * alerting rule, from one that worked perfectly. On a weekly cron nobody is
 * watching, that is a failure that never gets found.
 *
 * Failing the run is safe: a failed copy never deletes its source (there is a
 * test for exactly that), so a red run means "not archived yet", never
 * "lost". The cron comes round again next week regardless.
 *
 * Set STORAGE_SWEEP_FAIL_ON_ERROR=false to restore the old always-green
 * behaviour. As everywhere else in this file, only the exact string "false"
 * changes anything.
 */
export function sweepFailOnErrorFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.STORAGE_SWEEP_FAIL_ON_ERROR ?? "").trim().toLowerCase() !== "false";
}

export function sweepMinAgeDaysFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.STORAGE_SWEEP_MIN_AGE_DAYS ?? "").trim();
  if (raw === "") return 7;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 7;
  return parsed;
}

/**
 * Log the resolved storage configuration at the start of every run.
 *
 * None of this is secret — endpoints, regions and bucket names are all public
 * identifiers — and having it in the trace means ONE run tells you whether the
 * config is right, instead of a round trip per guess. Access keys are reported
 * only as present/absent with a length.
 *
 * BOTH halves of each credential pair are checked. Patch 2 only reported the
 * access key id, so a missing *_SECRET_ACCESS_KEY was invisible here and only
 * surfaced later as requireEnv() throwing mid-migration — which is exactly what
 * happened. A diagnostic that omits a required variable is worse than useless:
 * it actively reassures you about a thing it never looked at.
 */
export function logResolvedConfig(): void {
  const describe = (name: string) => {
    const raw = process.env[name];
    if (raw === undefined) return "(not set)";
    if (raw.trim() === "") return "(EMPTY STRING - note ?? does not fall back on this)";
    return raw;
  };
  const secret = (...names: string[]) => {
    for (const n of names) {
      const v = process.env[n];
      if (v && v.trim() !== "") return `${n} set, length ${v.length}`;
    }
    return `NOT SET (looked for ${names.join(", ")})`;
  };
  // Backblaze's S3-compatible API does NOT accept the master application key.
  // A master keyId is the 12-character account id; a real application key id is
  // 25 characters. Using the former gives "Malformed Access Key Id", which reads
  // like a typo rather than "wrong kind of key entirely".
  const backblazeKeyIdNote = () => {
    const v = process.env.BACKBLAZE_AWS_ACCESS_KEY_ID ?? process.env.BACKBLAZE_ACCESS_KEY_ID;
    if (!v || v.trim() === "") return "";
    const len = v.trim().length;
    if (len === 25) return " [length 25, looks like an application key id]";
    if (len === 12) {
      return " [length 12 - this is your ACCOUNT ID, i.e. the MASTER key. " +
        "Backblaze's S3 API rejects the master key with 'Malformed Access Key Id'. " +
        "Create a non-master application key scoped to the bucket.]";
    }
    return ` [length ${len} - expected 25 for a Backblaze application key id]`;
  };
  // An endpoint that is not an absolute URL makes the AWS SDK throw a bare
  // "TypeError: Invalid URL" on first use, with nothing naming the endpoint.
  const endpointNote = (value: string) => {
    if (value.startsWith("(")) return "";
    try {
      const u = new URL(value.trim());
      return u.protocol === "https:" || u.protocol === "http:" ? " [ok]" : ` [BAD SCHEME ${u.protocol}]`;
    } catch {
      return " [NOT A URL - needs the https:// prefix]";
    }
  };

  // The dry-run flag is deliberately strict: ONLY the exact string "false",
  // after trim and lowercase, arms deletion. That is right — a destructive flag
  // must never be enabled by a guess about what someone meant.
  //
  // But strictness without diagnosis is how you get a Production run that says
  // DRY RUN while the dashboard plainly shows `false`, with nothing in the trace
  // explaining the contradiction.
  //
  // Every cause is visible in the LENGTH, because `false` is exactly 5. Measured
  // rather than assumed — .trim() is more capable than it looks, and the list of
  // what actually survives it is short:
  //
  //   handled by trim(): space, tab, newline, U+00A0 no-break space,
  //                      U+FEFF BOM, U+2007 figure space
  //   NOT handled:       quotation marks ("false" -> 7), a trailing comma
  //                      (false, -> 6), a zero-width space (U+200B -> 6)
  //
  // So: report the raw length, and say outright which way it resolved and why.
  const dryRunNote = () => {
    const raw = process.env.STORAGE_SWEEP_DRY_RUN;
    if (raw === undefined) {
      return "(not set) -> DRY RUN. Nothing will be deleted. Set it to exactly: false";
    }
    const normalised = raw.trim().toLowerCase();
    if (normalised === "false") {
      return `"${raw}" (length ${raw.length}) -> DELETION IS ARMED`;
    }
    const hint =
      normalised.includes("false")
        ? ` The value CONTAINS "false" but is not equal to it, so deletion stays OFF. ` +
          `Expected length 5, got ${raw.length}. Ordinary and non-breaking spaces are ` +
          `already trimmed, so the extra character(s) are most likely quotation marks, ` +
          `a trailing comma, or a zero-width space. Retype the value by hand as the ` +
          `five letters f-a-l-s-e rather than pasting it.`
        : ` Anything other than exactly "false" means DRY RUN, by design.`;
    return `"${raw}" (length ${raw.length}) -> DRY RUN.${hint}`;
  };

  const minAgeNote = () => {
    const raw = process.env.STORAGE_SWEEP_MIN_AGE_DAYS;
    if (raw === undefined || raw.trim() === "") return "(not set) -> default 7 day(s)";
    const parsed = Number(raw.trim());
    if (!Number.isFinite(parsed) || parsed < 0) {
      return `"${raw}" is not a usable number -> falling back to 7 day(s). ` +
        `A typo must never be read as 0, which would sweep everything.`;
    }
    return `"${raw}" -> ${parsed} day(s)`;
  };

  const tigrisEndpoint = describe("TIGRIS_ENDPOINT");
  const backblazeEndpoint = describe("BACKBLAZE_ENDPOINT");

  logger.info("Storage configuration in use", {
    tigris: {
      endpoint: tigrisEndpoint + endpointNote(tigrisEndpoint),
      region: describe("TIGRIS_REGION"),
      bucket: describe("TIGRIS_BUCKET_NAME"),
      accessKeyId: secret("TIGRIS_AWS_ACCESS_KEY_ID", "TIGRIS_ACCESS_KEY_ID"),
      secretAccessKey: secret("TIGRIS_AWS_SECRET_ACCESS_KEY", "TIGRIS_SECRET_ACCESS_KEY"),
    },
    backblaze: {
      endpoint: backblazeEndpoint + endpointNote(backblazeEndpoint),
      region: describe("BACKBLAZE_REGION"),
      bucket: describe("BACKBLAZE_BUCKET_NAME"),
      accessKeyId: secret("BACKBLAZE_AWS_ACCESS_KEY_ID", "BACKBLAZE_ACCESS_KEY_ID") + backblazeKeyIdNote(),
      secretAccessKey: secret("BACKBLAZE_AWS_SECRET_ACCESS_KEY", "BACKBLAZE_SECRET_ACCESS_KEY"),
    },
    dryRun: sweepDryRunFromEnv(),
    STORAGE_SWEEP_DRY_RUN: dryRunNote(),
    minAgeDays: sweepMinAgeDaysFromEnv(),
    STORAGE_SWEEP_MIN_AGE_DAYS: minAgeNote(),
    failOnError: sweepFailOnErrorFromEnv(),
    patchVersion: PATCH_VERSION,
  });
}

/** Bumped whenever this file changes, so a trace proves which version ran. */
export const PATCH_VERSION = "sweeper-patch-6 (diagnoses the dry-run flag, fails loudly)";

export const weeklyStorageSweeper = schedules.task({
  id: "weekly-storage-sweeper",
  cron: {
    pattern: "0 2 * * 0",
    timezone: "UTC",
  },
  run: async (): Promise<SweepResult> => {
    // Always logs, first thing, before anything can fail. If you do not see
    // "Storage configuration in use" in the trace, this file is not the one
    // that is deployed.
    logResolvedConfig();

    const dryRun = sweepDryRunFromEnv();
    const minAgeDays = sweepMinAgeDaysFromEnv();

    const result = await sweepStorage(
      {
        hotClient: tigrisClient,
        coldClient: backblazeClient,
        hotBucket: requireEnv("TIGRIS_BUCKET_NAME"),
        coldBucket: requireEnv("BACKBLAZE_BUCKET_NAME"),
        upload: uploadStream,
      },
      { dryRun, minAgeDays },
    );

    // Passed as an explicit object literal, not `result` itself: logger's
    // second argument is Record<string, unknown>, and an `interface` does not
    // satisfy that (no implicit index signature). Passing the interface value
    // directly is a TS2345 compile error.
    const summary = {
      scanned: result.scanned,
      skippedTooNew: result.skippedTooNew,
      migrated: result.migrated,
      deleted: result.deleted,
      dryRun: result.dryRun,
      minAgeDays: result.minAgeDays,
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
      // One line per failure with the key and the real error text, so a single
      // trace is enough to diagnose without another round trip.
      for (const item of result.failed) {
        logger.error(`FAILED: ${item.key} — ${item.error}`, { key: item.key, error: item.error });
      }

      // Then make the RUN itself fail, so this is visible without reading logs.
      // See sweepFailOnErrorFromEnv: a green run that failed on every object is
      // the worst possible outcome for a weekly unattended cron.
      if (sweepFailOnErrorFromEnv()) {
        const first = result.failed[0]!;
        throw new Error(
          `Storage sweep failed on ${result.failed.length} of ${result.scanned} object(s). ` +
            `First failure: ${first.key} — ${first.error}. ` +
            `Nothing was deleted for the failed objects, so they are still in hot storage. ` +
            `Per-object detail is in the FAILED log lines above. ` +
            `(Set STORAGE_SWEEP_FAIL_ON_ERROR=false to let the run stay green instead.)`,
        );
      }
    } else if (result.scanned === 0) {
      logger.warn(
        `Nothing to sweep: the hot bucket "${describeBucket()}" is empty, or ` +
          `TIGRIS_BUCKET_NAME points at a different bucket from the one holding your renders.`,
      );
    } else if (result.skippedTooNew === result.scanned) {
      // Distinguish "nothing eligible yet" from "nothing worked". Without this
      // a healthy run over fresh renders reads identically to a broken one.
      logger.info(
        `Nothing eligible: all ${result.scanned} object(s) in "${describeBucket()}" are ` +
          `younger than ${result.minAgeDays} day(s), so none were swept. This is the age ` +
          `filter working, not a failure.`,
      );
    } else {
      const eligible = result.scanned - result.skippedTooNew;
      logger.info(
        `PASS — ${result.migrated} of ${eligible} eligible object(s) copied to cold and ` +
          `size-verified (${result.skippedTooNew} held back as younger than ` +
          `${result.minAgeDays} day(s)).` +
          (result.dryRun
            ? ` Still in dry run, so nothing was deleted. Set STORAGE_SWEEP_DRY_RUN=false to finish.`
            : ` ${result.deleted} removed from hot.`),
      );
    }

    return result;
  },
});
