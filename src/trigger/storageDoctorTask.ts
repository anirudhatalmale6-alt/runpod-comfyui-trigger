/**
 * storage-doctor — diagnose S3 AccessDenied against Tigris and Backblaze B2.
 *
 * Trigger this instead of guessing. It runs read-only probes against whichever
 * of the two providers you have configured and reports, per provider, which of
 * the several causes of "AccessDenied" you are actually hitting.
 *
 * Costs nothing: no GPU, no writes (unless you opt in), no data transferred
 * beyond a single one-key listing.
 *
 * Credentials are never logged. Only presence and length.
 */

import { task, logger, AbortTaskRunError } from '@trigger.dev/sdk/v3';

import { diagnose, configFromEnv, envNamesFor, type StorageProbeConfig, type ProbeResult } from '@/utils/storageDoctor';
import { inspectVar, loggableReport } from '@/utils/envReport';

export type StorageDoctorPayload = {
  /** Prefix your sweeper actually lists, e.g. "renders/". */
  prefix?: string;
  /** Opt in to a tiny write+delete probe. Off by default. */
  probeWrite?: boolean;
};

export type StorageDoctorResult = {
  ok: boolean;
  results: ProbeResult[];
  notConfigured: string[];
};

export const storageDoctor = task({
  id: 'storage-doctor',
  retry: { maxAttempts: 1 },
  run: async (payload: StorageDoctorPayload, { ctx }): Promise<StorageDoctorResult> => {
    const prefix = payload?.prefix;
    const probeWrite = payload?.probeWrite === true;

    // Both spellings are accepted: the *_AWS_* / *_BUCKET_NAME names this
    // project actually uses, and the shorter fallbacks.
    const vars = [
      'TIGRIS_ENDPOINT', 'TIGRIS_REGION',
      'TIGRIS_AWS_ACCESS_KEY_ID', 'TIGRIS_ACCESS_KEY_ID',
      'TIGRIS_AWS_SECRET_ACCESS_KEY', 'TIGRIS_SECRET_ACCESS_KEY',
      'TIGRIS_BUCKET_NAME', 'TIGRIS_BUCKET',
      'BACKBLAZE_ENDPOINT', 'BACKBLAZE_REGION',
      'BACKBLAZE_AWS_ACCESS_KEY_ID', 'BACKBLAZE_ACCESS_KEY_ID',
      'BACKBLAZE_AWS_SECRET_ACCESS_KEY', 'BACKBLAZE_SECRET_ACCESS_KEY',
      'BACKBLAZE_BUCKET_NAME', 'BACKBLAZE_BUCKET',
    ].map((n) => inspectVar(n));

    logger.info('storage doctor: environment', {
      environment: { type: ctx.environment.type, slug: ctx.environment.slug },
      // Presence and length only — never a secret value.
      vars: vars.map(loggableReport),
      prefix: prefix ?? '(none)',
      probeWrite,
    });

    const configs: StorageProbeConfig[] = [];
    const notConfigured: string[] = [];

    for (const provider of ['tigris', 'backblaze'] as const) {
      const config = configFromEnv(provider, { prefix, probeWrite });
      if (config) configs.push(config);
      else notConfigured.push(provider);
    }

    if (configs.length === 0) {
      throw new AbortTaskRunError(
        `Neither Tigris nor Backblaze is configured in the ${ctx.environment.type} environment. ` +
          `tigris is missing: ${envNamesFor('tigris').missing.join('; ')}. ` +
          `backblaze is missing: ${envNamesFor('backblaze').missing.join('; ')}. ` +
          `Set them under Project Settings > Environment Variables with ` +
          `${ctx.environment.type} ticked.`,
      );
    }

    const results: ProbeResult[] = [];
    for (const config of configs) {
      const result = await diagnose(config);
      results.push(result);
      if (result.verdict === 'ok') {
        logger.info(`${result.label}: OK`, { steps: result.steps });
      } else {
        logger.error(`${result.label}: ${result.verdict}`, {
          advice: result.advice,
          steps: result.steps,
        });
      }
    }

    if (notConfigured.length > 0) {
      logger.warn('Not configured, so not probed', { providers: notConfigured });
    }

    const ok = results.every((r) => r.verdict === 'ok');

    // Returns rather than throws: a green run whose output lists the problems is
    // easier to read in the dashboard than a failed one. This reports, it does
    // not gate.
    return { ok, results, notConfigured };
  },
});
