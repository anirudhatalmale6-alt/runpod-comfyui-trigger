/**
 * configDoctor — a zero-cost diagnostic task.
 *
 * Trigger it from the Trigger.dev test console to find out what the runtime can
 * actually see, WITHOUT submitting a RunPod job and without spending a second of
 * GPU time. Use it whenever a run fails on configuration rather than on work.
 *
 * It answers the three questions that account for nearly every "but I set it"
 * report:
 *
 *   1. Which environment did this actually run in?
 *      Trigger.dev environment variables are scoped per environment. A value set
 *      in Development is simply not there in Production.
 *   2. Is the variable present at all?
 *   3. Is it present but empty, or padded with whitespace from a copy-paste?
 *
 * SECRETS ARE NEVER LOGGED. Only presence, length, and a coarse shape check.
 * Length alone is safe and is usually enough to spot a truncated paste.
 */

import { task, logger } from '@trigger.dev/sdk/v3';

import { inspectVar, problemsFor, loggableReport, type VarReport } from '@/utils/envReport';

const REQUIRED = ['RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID'] as const;
const OPTIONAL = ['RUNPOD_BASE_URL'] as const;

export type ConfigDoctorResult = {
  environment: { type: string; slug: string };
  ok: boolean;
  required: VarReport[];
  optional: VarReport[];
  problems: string[];
};

export const configDoctor = task({
  id: 'config-doctor',
  // Nothing here can fail transiently, so a retry would only repeat the answer.
  retry: { maxAttempts: 1 },
  run: async (_payload: unknown, { ctx }): Promise<ConfigDoctorResult> => {
    const required = REQUIRED.map((n) => inspectVar(n));
    const optional = OPTIONAL.map((n) => inspectVar(n));
    const environment = { type: ctx.environment.type, slug: ctx.environment.slug };

    const problems = problemsFor(required, environment.type);

    const ok = problems.length === 0;

    logger.info('config doctor', {
      environment,
      ok,
      // Presence and length only. No values.
      required: required.map(loggableReport),
      optional: optional.map(loggableReport),
      problems,
    });

    if (!ok) {
      logger.error('Configuration is incomplete for this environment', { problems });
    } else {
      logger.info(
        `All required variables are present in ${environment.type}. ` +
          `revenueGateRouter should get past its configuration check.`,
      );
    }

    // Deliberately returns rather than throws: a green run whose output lists
    // the problems is easier to read in the dashboard than a failed one, and
    // this task exists to report, not to gate.
    return { environment, ok, required, optional, problems };
  },
});
