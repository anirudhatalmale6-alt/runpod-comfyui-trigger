/**
 * Deliver a purchased content set out of Backblaze B2 without ever making the
 * bucket public.
 *
 * The shape this assumes, and the reason for it:
 *
 *   platform confirms a purchase  ->  webhook (HMAC-verified)  ->  deliverSet()
 *
 * Delivery is the LAST step, and it happens only after the platform that took
 * the money says the money arrived. Nothing here decides whether someone has
 * paid; it is handed an already-verified purchase and turns it into links.
 * Keeping that boundary sharp is what stops a bug in the chat layer from
 * becoming free content.
 *
 * Every URL is a time-limited presigned GET. Specifically NOT done here:
 *
 *   * making the cold bucket public, or any object in it public-read
 *   * proxying bytes through the app (a 200MB set would sit in task memory and
 *     burn compute minutes for something S3 does natively)
 *   * baking a permanent URL into a DM, which is forwardable forever
 *
 * A presigned URL is still a bearer token: anyone holding it can fetch until it
 * expires. That is the trade, and the mitigation is a short expiry plus an
 * audit record of what was issued to whom. Both are here.
 */

import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** A single file in a purchased set, with the link the buyer actually uses. */
export interface DeliveredFile {
  /** Object key in the cold bucket. Never shown to the buyer. */
  key: string;
  /** Leaf name, safe to show: "set-03/frame-01.png" -> "frame-01.png". */
  filename: string;
  /** Time-limited presigned GET. */
  url: string;
  /** Bytes, from HeadObject — lets a client show progress and spot truncation. */
  sizeBytes: number;
  contentType?: string;
}

export interface DeliveryResult {
  /** Echoed back so an audit line can be tied to the purchase that caused it. */
  purchaseId: string;
  /** The prefix that was served, e.g. "sets/premium-03/". */
  prefix: string;
  files: DeliveredFile[];
  /** Absolute expiry of every URL above. */
  expiresAt: Date;
  expiresInSeconds: number;
}

export interface DeliveryOptions {
  /**
   * How long the links live. Default 6 hours.
   *
   * Clamped to the SigV4 ceiling of 7 days; a value above it does not fail at
   * signing time, it produces a URL the server rejects later with an opaque
   * error, which is a miserable thing to debug from a customer complaint.
   */
  expiresInSeconds?: number;
  /** Hard cap on files returned, so a mis-typed prefix cannot emit 10k links. */
  maxFiles?: number;
  /** Injectable for tests. */
  client?: S3Client;
  bucket?: string;
  now?: () => number;
}

/** SigV4 presigned URLs cannot outlive this. Seven days, in seconds. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;

export const DEFAULT_EXPIRES_SECONDS = 6 * 60 * 60;
export const DEFAULT_MAX_FILES = 200;

/**
 * Build the cold-storage client from the same variables the sweeper uses.
 *
 * Deliberately reads BOTH the BACKBLAZE_AWS_* spelling the client's repo uses
 * and the shorter BACKBLAZE_* fallback. Getting this wrong once already cost a
 * round trip: a diagnostic that reads a variable nobody set reports "not
 * configured" against a perfectly good environment.
 */
export function coldClientFromEnv(env: NodeJS.ProcessEnv = process.env): S3Client {
  const endpoint = (env.BACKBLAZE_ENDPOINT ?? "").trim();
  const region = (env.BACKBLAZE_REGION ?? "").trim();
  const accessKeyId = (env.BACKBLAZE_AWS_ACCESS_KEY_ID ?? env.BACKBLAZE_ACCESS_KEY_ID ?? "").trim();
  const secretAccessKey = (
    env.BACKBLAZE_AWS_SECRET_ACCESS_KEY ??
    env.BACKBLAZE_SECRET_ACCESS_KEY ??
    ""
  ).trim();

  const missing = [
    ["BACKBLAZE_ENDPOINT", endpoint],
    ["BACKBLAZE_REGION", region],
    ["BACKBLAZE_AWS_ACCESS_KEY_ID", accessKeyId],
    ["BACKBLAZE_AWS_SECRET_ACCESS_KEY", secretAccessKey],
  ]
    .filter(([, v]) => v === "")
    .map(([n]) => n);

  if (missing.length > 0) {
    throw new Error(
      `Cannot deliver content: missing environment variable(s): ${missing.join(", ")}. ` +
        `Note these are per-environment in Trigger.dev — set in Development is not set in Production.`,
    );
  }

  // The endpoint must parse before the SDK touches it. A scheme-less value
  // throws a bare "TypeError: Invalid URL" on first use with nothing naming the
  // variable, which is exactly how an afternoon disappears.
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("not http(s)");
    }
  } catch {
    throw new Error(
      `BACKBLAZE_ENDPOINT is not a usable URL: "${endpoint}". ` +
        `It needs the https:// prefix, e.g. https://s3.us-east-005.backblazeb2.com`,
    );
  }

  return new S3Client({
    endpoint,
    region,
    credentials: { accessKeyId, secretAccessKey },
  });
}

export function coldBucketFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const bucket = (env.BACKBLAZE_BUCKET_NAME ?? "").trim();
  if (bucket === "") {
    throw new Error("Cannot deliver content: BACKBLAZE_BUCKET_NAME is not set.");
  }
  return bucket;
}

/**
 * Normalise a set prefix.
 *
 * Two rules, both of which have bitten this project already:
 *   * never a leading "/" — "/sets/x" and "sets/x" are DIFFERENT keys in S3, and
 *     a leading slash makes a prefix listing silently return nothing;
 *   * always a trailing "/" — without it, prefix "set-1" also matches "set-10",
 *     which quietly delivers the wrong set's files alongside the right ones.
 */
export function normalisePrefix(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new Error("A delivery prefix is required — refusing to serve the whole bucket.");
  }
  if (trimmed.includes("..")) {
    throw new Error(`Refusing a delivery prefix containing "..": ${raw}`);
  }
  const withoutLeading = trimmed.replace(/^\/+/, "");
  if (withoutLeading === "") {
    throw new Error("A delivery prefix is required — refusing to serve the whole bucket.");
  }
  return withoutLeading.endsWith("/") ? withoutLeading : `${withoutLeading}/`;
}

export function clampExpiry(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_EXPIRES_SECONDS;
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_EXPIRES_SECONDS;
  return Math.min(Math.floor(requested), MAX_PRESIGN_SECONDS);
}

/**
 * Turn a verified purchase into a set of time-limited download links.
 *
 * Throws rather than returning an empty list when the prefix matches nothing:
 * a buyer who has paid and receives zero files is an incident, not a result,
 * and it must not be silently logged and returned as success.
 */
export async function deliverSet(
  purchaseId: string,
  setPrefix: string,
  options: DeliveryOptions = {},
): Promise<DeliveryResult> {
  if (purchaseId.trim() === "") {
    throw new Error("deliverSet requires a purchaseId so delivery can be audited.");
  }

  const client = options.client ?? coldClientFromEnv();
  const bucket = options.bucket ?? coldBucketFromEnv();
  const prefix = normalisePrefix(setPrefix);
  const expiresInSeconds = clampExpiry(options.expiresInSeconds);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const now = options.now ?? Date.now;

  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    for (const item of page.Contents ?? []) {
      // A "directory marker" is a zero-byte object whose key ends in "/".
      // Presigning one produces a link to nothing.
      if (!item.Key || item.Key.endsWith("/")) continue;
      keys.push(item.Key);
      if (keys.length >= maxFiles) break;
    }
    continuationToken = keys.length >= maxFiles ? undefined : page.NextContinuationToken;
  } while (continuationToken);

  if (keys.length === 0) {
    throw new Error(
      `Purchase ${purchaseId} matched no files: nothing in "${bucket}" under prefix "${prefix}". ` +
        `The buyer has paid, so this needs a human — check the prefix against the tier mapping.`,
    );
  }

  keys.sort();

  const files: DeliveredFile[] = [];
  for (const key of keys) {
    // HeadObject before signing: it confirms the object is really there and
    // gives the size. Signing never fails for a missing key — presigning is
    // pure string work — so without this a deleted object becomes a link that
    // 404s in the buyer's hands.
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
    files.push({
      key,
      filename: key.slice(key.lastIndexOf("/") + 1),
      url,
      sizeBytes: head.ContentLength ?? 0,
      ...(head.ContentType ? { contentType: head.ContentType } : {}),
    });
  }

  return {
    purchaseId,
    prefix,
    files,
    expiresAt: new Date(now() + expiresInSeconds * 1000),
    expiresInSeconds,
  };
}

/**
 * An audit line for a delivery.
 *
 * Contains NO signed URLs. A presigned URL is a working credential for the
 * lifetime of its expiry, so putting one in a log hands anyone with log access
 * the paid content. Keys, counts and sizes are enough to answer "what did this
 * buyer receive", which is the question an audit trail exists for.
 */
export function deliveryAuditLine(result: DeliveryResult): Record<string, unknown> {
  return {
    purchaseId: result.purchaseId,
    prefix: result.prefix,
    fileCount: result.files.length,
    totalBytes: result.files.reduce((sum, f) => sum + f.sizeBytes, 0),
    keys: result.files.map((f) => f.key),
    expiresAt: result.expiresAt.toISOString(),
    expiresInSeconds: result.expiresInSeconds,
  };
}
