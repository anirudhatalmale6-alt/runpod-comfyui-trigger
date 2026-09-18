/**
 * publish-doctor — "are my tokens right?", answered in one run.
 *
 * Trigger it from the Trigger.dev test console with an empty payload. It checks
 * every publishing lane and tells you, per platform, whether the credentials
 * actually work. It PUBLISHES NOTHING — every call is a read.
 *
 * Run this before testing a lane, not after it fails.
 */

import { logger, task } from "@trigger.dev/sdk/v3";

import {
  runPublishDoctor,
  summarise,
  type DoctorReport,
} from "../utils/publishDoctor.js";

export interface PublishDoctorPayload {
  /** Report configuration only, making no network calls at all. */
  offline?: boolean;
}

export const publishDoctor = task({
  id: "publish-doctor",
  // Nothing here fails transiently in a way a retry would fix, and retrying six
  // authentication calls is how an account gets rate limited.
  retry: { maxAttempts: 1 },
  run: async (payload: PublishDoctorPayload | undefined, { ctx }): Promise<DoctorReport> => {
    const report = await runPublishDoctor(ctx.environment.type, {
      offline: payload?.offline === true,
    });

    // The summary first, because it is the bit worth reading.
    for (const line of summarise(report)) logger.info(line);

    logger.info("Publishing lanes", {
      environment: ctx.environment.type,
      ready: report.ready,
      broken: report.broken,
      unconfigured: report.unconfigured,
    });

    for (const lane of report.lanes) {
      if (lane.problems.length > 0) {
        logger.error(`${lane.label} needs attention`, {
          platform: lane.platform,
          problems: lane.problems,
          // Presence and length only — never a value.
          vars: lane.vars,
        });
      }
    }

    if (report.broken.length > 0) {
      logger.error(
        `${report.broken.length} lane(s) are configured but the platform refused them: ` +
          report.broken.join(", "),
      );
    }
    if (report.ready.length === 0) {
      logger.warn(
        "No lane is currently able to publish. If you expected otherwise, check you are " +
          "looking at the same environment this ran in: " + ctx.environment.type,
      );
    }

    return report;
  },
});
