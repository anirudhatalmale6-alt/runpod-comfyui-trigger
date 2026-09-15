/**
 * revenueGateRouter — routes inbound payloads into an asynchronous RunPod
 * Serverless ComfyUI worker and returns the rendered assets.
 *
 * Shape of the run:
 *   1. read + validate configuration (fails closed, no retries on misconfig)
 *   2. POST /run                        -> job id
 *   3. poll GET /status/{id} using Trigger.dev's wait.for between polls
 *   4. resolve COMPLETED / FAILED / CANCELLED / TIMED_OUT
 *
 * No `while (Date.now() - start < x)` busy loop anywhere: every gap between
 * polls is a `wait.for`, so the run checkpoints instead of holding the worker.
 */

import { task, wait, logger, AbortTaskRunError } from '@trigger.dev/sdk/v3';

import {
  submitJob,
  pollUntilTerminal,
  RunPodDeadlineError,
  RunPodPermanentError,
  type RunPodConfig,
  type StatusResponse,
} from '@/utils/runpodClient';

export type RevenueGatePayload = {
  /**
   * The ComfyUI prompt graph. Passed through untouched and wrapped in the
   * root-level `input` object by the client — do NOT wrap it here as well.
   */
  prompt: Record<string, unknown>;
  /** Optional per-run override of the polling deadline. */
  deadlineSeconds?: number;
};

export type RevenueGateResult = {
  jobId: string;
  status: string;
  output: unknown;
  polls: number;
  delayTime?: number;
  executionTime?: number;
};

/**
 * Config comes from Trigger.dev's environment variables
 * (Project Settings > Environment Variables), never from a file in the repo.
 * `.env.example` carries placeholders only.
 *
 * A missing key is a deployment mistake, not a transient fault, so this throws
 * AbortTaskRunError — retrying it six times would just produce six identical
 * failures and obscure the real message.
 */
function loadConfig(): RunPodConfig {
  const apiKey = process.env.RUNPOD_API_KEY;
  const endpointId = process.env.RUNPOD_ENDPOINT_ID;

  const missing: string[] = [];
  if (!apiKey) missing.push('RUNPOD_API_KEY');
  if (!endpointId) missing.push('RUNPOD_ENDPOINT_ID');

  if (missing.length > 0) {
    throw new AbortTaskRunError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `Set them in Trigger.dev under Project Settings > Environment Variables for this environment.`,
    );
  }

  return {
    apiKey: apiKey as string,
    endpointId: endpointId as string,
    baseUrl: process.env.RUNPOD_BASE_URL,
  };
}

export const revenueGateRouter = task({
  id: 'revenue-gate-router',
  // Cap the retries: a ComfyUI render is expensive, and re-running the whole
  // task re-submits a brand new RunPod job rather than resuming the old one.
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 2_000,
    maxTimeoutInMs: 30_000,
    factor: 2,
  },
  run: async (payload: RevenueGatePayload): Promise<RevenueGateResult> => {
    const config = loadConfig();

    if (!payload?.prompt || typeof payload.prompt !== 'object') {
      throw new AbortTaskRunError(
        'payload.prompt is required and must be the ComfyUI prompt graph object',
      );
    }

    // --- 1. submit -------------------------------------------------------
    const submission = await submitJob(config, payload.prompt);
    logger.info('RunPod job submitted', {
      jobId: submission.id,
      initialStatus: submission.status,
      endpointId: config.endpointId,
    });

    // --- 2. poll ---------------------------------------------------------
    let polls = 0;
    let terminal: StatusResponse;

    try {
      terminal = await pollUntilTerminal(config, submission.id, {
        // This is the whole point of the design: the sleep between polls is
        // Trigger.dev's own wait, so the run suspends rather than spinning.
        waitSeconds: (seconds) => wait.for({ seconds }),
        deadlineSeconds: payload.deadlineSeconds ?? 600,
        onPoll: (attempt, status, elapsedSeconds) => {
          polls = attempt;
          logger.info('RunPod poll', { jobId: submission.id, attempt, status, elapsedSeconds });
        },
      });
    } catch (err) {
      if (err instanceof RunPodDeadlineError) {
        // Deadline reached. The job was asked to cancel so it does not keep
        // burning GPU minutes after we have stopped listening.
        logger.error('RunPod job exceeded the polling deadline', {
          jobId: err.jobId,
          lastStatus: err.lastStatus,
          elapsedSeconds: err.elapsedSeconds,
          cancelled: err.cancelled,
        });
      }
      if (err instanceof RunPodPermanentError) {
        throw new AbortTaskRunError(err.message);
      }
      throw err;
    }

    // --- 3. resolve ------------------------------------------------------
    logger.info('RunPod job reached a terminal state', {
      jobId: terminal.id,
      status: terminal.status,
      polls,
      delayTime: terminal.delayTime,
      executionTime: terminal.executionTime,
    });

    if (terminal.status !== 'COMPLETED') {
      // FAILED / CANCELLED / TIMED_OUT all land here. Only COMPLETED yields
      // output, so anything else is surfaced as a failed run with RunPod's own
      // error text attached rather than swallowed.
      const detail =
        terminal.error === undefined ? '(no error detail returned)' : JSON.stringify(terminal.error);
      throw new Error(`RunPod job ${terminal.id} ended as ${terminal.status}: ${detail}`);
    }

    if (terminal.output === undefined || terminal.output === null) {
      throw new Error(
        `RunPod job ${terminal.id} reported COMPLETED but returned no output key. ` +
          `This usually means the ComfyUI workflow ran but saved nothing — check the ` +
          `SaveImage node in the prompt graph.`,
      );
    }

    return {
      jobId: terminal.id,
      status: terminal.status,
      output: terminal.output,
      polls,
      delayTime: terminal.delayTime,
      executionTime: terminal.executionTime,
    };
  },
});
