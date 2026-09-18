/**
 * manualPostKit — the week's SAFE renders as download links.
 *
 * Instagram and Facebook are posted by hand through Meta Business Suite, which
 * wants a file from the user's own machine. The renders live in a private
 * bucket. Without this, every posting session starts with digging through a
 * storage console, which is exactly the sort of chore that stops getting done.
 *
 * So: one run, a list of links, click and save. The posting stays manual; the
 * boring half does not.
 *
 * ⚠️ SAFE CONTENT ONLY, AND THAT IS THE WHOLE POINT OF THIS FILE.
 *
 * These links are for posting to mainstream platforms. An explicit render
 * appearing in this list is one careless click away from ending the account —
 * the same catastrophe the routing rail exists to prevent, except a human is
 * the one doing the publishing and a human will not double-check a list that
 * looks authoritative.
 *
 * It is therefore guarded twice, on purpose:
 *   1. the listing is scoped to the safe/ prefix, and
 *   2. every key is independently re-classified before it is included.
 *
 * The second check is not redundant. A prefix is a string and someone will
 * eventually pass a different one; classifyFromKey is the rule.
 *
 * A presigned URL is a bearer token. Anyone holding it can fetch until it
 * expires, so the expiry is clamped and the URLs are never logged.
 */

import { GetObjectCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { CLASS_PREFIX, classifyFromKey } from "./contentRouting.js";

/** Long enough for one sitting; short enough that a leaked link dies quickly. */
export const DEFAULT_EXPIRY_SECONDS = 6 * 60 * 60;
export const MIN_EXPIRY_SECONDS = 60;
export const MAX_EXPIRY_SECONDS = 24 * 60 * 60;

/** Default number of renders returned. A week's posting, not an archive dump. */
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

export interface KitFile {
  key: string;
  /** Leaf name, which is what the browser saves it as. */
  filename: string;
  /** Time-limited presigned GET. NEVER logged. */
  url: string;
  sizeBytes: number;
  lastModified?: Date;
}

export interface KitResult {
  files: KitFile[];
  expiresInSeconds: number;
  expiresAt: Date;
  /** Keys that were listed but deliberately left out, and why. */
  skipped: Array<{ key: string; reason: string }>;
}

export interface KitOptions {
  limit?: number;
  expiresInSeconds?: number;
  /** Include the -web derivatives as separate entries. Off: they are duplicates. */
  includeDerivatives?: boolean;
  now?: () => Date;
  /**
   * Which prefix to list. Defaults to safe/ and production must never pass
   * anything else.
   *
   * It exists so the per-key classification guard below is REACHABLE. Scoped
   * only to safe/, that guard can never fire, which makes it decorative — and
   * a safety check nobody can prove works is worth very little. With this, a
   * test can point the listing at explicit/ and assert that every single object
   * is refused by the classifier rather than by the prefix.
   */
  prefix?: string;
}

export function clampExpiry(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_EXPIRY_SECONDS;
  return Math.min(MAX_EXPIRY_SECONDS, Math.max(MIN_EXPIRY_SECONDS, Math.floor(requested)));
}

export function clampLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(requested)));
}

export function isImageKey(key: string): boolean {
  const lower = key.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** "safe/2026-09-17/render-01-web.jpg" -> true */
export function isDerivativeKey(key: string): boolean {
  return /-web\.jpg$/i.test(key);
}

export function filenameFor(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

export async function buildManualPostKit(
  client: S3Client,
  bucket: string,
  options: KitOptions = {},
): Promise<KitResult> {
  const limit = clampLimit(options.limit);
  const expiresInSeconds = clampExpiry(options.expiresInSeconds);
  const now = options.now ?? (() => new Date());

  const skipped: Array<{ key: string; reason: string }> = [];
  const candidates: Array<{ key: string; size: number; lastModified?: Date }> = [];

  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        // Guard one: never even ask for anything outside the safe prefix.
        Prefix: options.prefix ?? CLASS_PREFIX.safe,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of page.Contents ?? []) {
      const key = object.Key;
      if (!key || key.endsWith("/")) continue;

      // Guard two: the prefix is a string someone can change. This is the rule.
      if (classifyFromKey(key) !== "safe") {
        skipped.push({ key, reason: "does not classify as safe content" });
        continue;
      }
      if (!isImageKey(key)) {
        skipped.push({ key, reason: "not an image" });
        continue;
      }
      if (!options.includeDerivatives && isDerivativeKey(key)) {
        skipped.push({ key, reason: "web derivative of another render" });
        continue;
      }

      candidates.push({
        key,
        size: object.Size ?? 0,
        ...(object.LastModified ? { lastModified: object.LastModified } : {}),
      });
    }

    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);

  // Newest first — the week's work is what someone wants to post.
  candidates.sort((a, b) => {
    const left = a.lastModified?.getTime() ?? 0;
    const right = b.lastModified?.getTime() ?? 0;
    return right - left;
  });

  const selected = candidates.slice(0, limit);

  const files: KitFile[] = [];
  for (const candidate of selected) {
    const url = await getSignedUrl(
      client,
      new GetObjectCommand({ Bucket: bucket, Key: candidate.key }),
      { expiresIn: expiresInSeconds },
    );
    files.push({
      key: candidate.key,
      filename: filenameFor(candidate.key),
      url,
      sizeBytes: candidate.size,
      ...(candidate.lastModified ? { lastModified: candidate.lastModified } : {}),
    });
  }

  return {
    files,
    expiresInSeconds,
    expiresAt: new Date(now().getTime() + expiresInSeconds * 1000),
    skipped,
  };
}

/**
 * An audit line safe to log.
 *
 * Counts and keys only. The URLs are working credentials for the life of the
 * expiry, and a log is exactly the place they would outlive their usefulness.
 */
export function kitAuditLine(result: KitResult): Record<string, unknown> {
  return {
    fileCount: result.files.length,
    keys: result.files.map((file) => file.key),
    totalBytes: result.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    expiresAt: result.expiresAt.toISOString(),
    skippedCount: result.skipped.length,
  };
}
