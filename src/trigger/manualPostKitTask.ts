/**
 * manual-post-kit — this week's safe renders, as links you can click.
 *
 * Instagram and Facebook are posted by hand through Meta Business Suite, which
 * wants a file from your own machine. Without this, every posting session
 * starts by digging through a storage console.
 *
 * Run it with {} for the default 20 newest, or {"limit": 5}.
 *
 * The links are time-limited and safe-content only. They are printed in the
 * log because that is the entire point — but they are NOT included in the
 * audit line, so the structured record of what was issued does not carry
 * working credentials around with it.
 */

import { logger, task } from "@trigger.dev/sdk/v3";

import { tigrisClient } from "../utils/storageClient.js";
import { requireEnv } from "../utils/env.js";
import {
  buildManualPostKit,
  kitAuditLine,
  type KitResult,
} from "../utils/manualPostKit.js";

export interface ManualPostKitPayload {
  /** How many renders. Default 20, capped at 100. */
  limit?: number;
  /** Link lifetime in seconds. Default 6 hours, capped at 24. */
  expiresInSeconds?: number;
  /** Include the -web.jpg derivatives as separate entries. */
  includeDerivatives?: boolean;
}

export const manualPostKit = task({
  id: "manual-post-kit",
  // Re-running is harmless, but a retry would mint a second set of links for
  // the same files and only confuse whoever is reading the log.
  retry: { maxAttempts: 1 },
  run: async (payload: ManualPostKitPayload | undefined): Promise<KitResult> => {
    const bucket = requireEnv("TIGRIS_BUCKET_NAME");

    const result = await buildManualPostKit(tigrisClient, bucket, {
      ...(payload?.limit !== undefined ? { limit: payload.limit } : {}),
      ...(payload?.expiresInSeconds !== undefined
        ? { expiresInSeconds: payload.expiresInSeconds }
        : {}),
      ...(payload?.includeDerivatives !== undefined
        ? { includeDerivatives: payload.includeDerivatives }
        : {}),
    });

    if (result.files.length === 0) {
      logger.warn(
        "No safe renders found. Either nothing has been produced yet, or the files are " +
          "not under the safe/ prefix — an unclassified render is deliberately invisible here.",
        { skipped: result.skipped.length },
      );
      return result;
    }

    logger.info(
      `${result.files.length} render(s) ready to download. Links expire ${result.expiresAt.toISOString()}.`,
    );

    // One line per file, so they are easy to click out of the log.
    for (const file of result.files) {
      logger.info(`${file.filename}  (${Math.round(file.sizeBytes / 1024)} KB)\n${file.url}`);
    }

    if (result.skipped.length > 0) {
      // Say what was left out. A silent omission reads as "that was everything".
      logger.info(`${result.skipped.length} object(s) skipped`, {
        skipped: result.skipped.slice(0, 20),
      });
    }

    logger.info("manual post kit", kitAuditLine(result));
    return result;
  },
});
