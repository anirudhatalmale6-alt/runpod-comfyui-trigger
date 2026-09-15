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

import { diagnose, type StorageProbeConfig, type ProbeResult } from '@/utils/storageDoctor';
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

/**
 * Both providers are read from environment variables, per environment, exactly
 * like the RunPod ones. Nothing is read from a file in the repo.
 */
function configFor(
  provider: 'tigris' | 'backblaze',
  prefix: string | undefined,
  probeWrite: boolean,
): StorageProbeConfig | null {
  const P = provider.toUpperCase();
  const endpoint = process.env[`${P}_ENDPOINT`];
  const bucket = process.env[`${P}_BUCKET`];
  const accessKeyId = process.env[`${P}_ACCESS_KEY_ID`];
  const secretAccessKey = process.env[`${P}_SECRET_ACCESS_KEY`];
  const region = process.env[`${P}_REGION`];

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;

  return {
    provider,
    label: provider,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    // Tigris uses "auto"; Backblaze REQUIRES the region to match the endpoint.
    region: region ?? (provider === 'tigris' ? 'auto' : 'us-west-004'),
    prefix,
    probeWrite,
  };
}

export const storageDoctor = task({
  id: 'storage-doctor',
  retry: { maxAttempts: 1 },
  run: async (payload: StorageDoctorPayload, { ctx }): Promise<StorageDoctorResult> => {
    const prefix = payload?.prefix;
    const probeWrite = payload?.probeWrite === true;

    const vars = [
      'TIGRIS_ENDPOINT',
      'TIGRIS_BUCKET',
      'TIGRIS_ACCESS_KEY_ID',
      'TIGRIS_SECRET_ACCESS_KEY',
      'TIGRIS_REGION',
      'BACKBLAZE_ENDPOINT',
      'BACKBLAZE_BUCKET',
      'BACKBLAZE_ACCESS_KEY_ID',
      'BACKBLAZE_SECRET_ACCESS_KEY',
      'BACKBLAZE_REGION',
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
      const config = configFor(provider, prefix, probeWrite);
      if (config) configs.push(config);
      else notConfigured.push(provider);
    }

    if (configs.length === 0) {
      throw new AbortTaskRunError(
        `Neither Tigris nor Backblaze is configured in the ${ctx.environment.type} environment. ` +
          `Each needs <PROVIDER>_ENDPOINT, _BUCKET, _ACCESS_KEY_ID and _SECRET_ACCESS_KEY ` +
          `(TIGRIS_* and BACKBLAZE_*), set under Project Settings > Environment Variables ` +
          `with ${ctx.environment.type} ticked.`,
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
