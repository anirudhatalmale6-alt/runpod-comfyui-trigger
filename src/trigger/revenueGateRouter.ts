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
import {
  validateWorkflow,
  availableModelsFromEnv,
  extractAvailableFromError,
  type AvailableModels,
} from '@/utils/workflowValidator';

export type RevenueGatePayload = {
  /**
   * The ComfyUI workflow graph.
   *
   * Sent as `input.workflow` — the live container rejects a bare graph with
   * "Missing 'workflow' parameter". Pass the graph itself here, NOT an object
   * that already has a `workflow` or `input` key.
   */
  workflow: Record<string, unknown>;
  /**
   * Anything else the worker image expects alongside the graph (images, S3
   * settings, and so on). Merged into `input` next to `workflow`.
   */
  extraInput?: Record<string, unknown>;
  /**
   * Models this endpoint actually carries, so a graph naming a model it does
   * not have is rejected locally instead of after a GPU cold start.
   *
   * Overrides RUNPOD_AVAILABLE_CHECKPOINTS and friends. A field left out is not
   * checked at all — silence means "not told", never "nothing available".
   */
  availableModels?: AvailableModels;
  /** Optional per-run override of the polling deadline. */
  deadlineSeconds?: number;
  /**
   * Retry the whole task when RunPod reports the job FAILED. Default false.
   *
   * Off by default because a retry re-submits a NEW RunPod job and bills a new
   * cold start, and the overwhelmingly common cause of a FAILED job is a
   * malformed workflow, which will fail identically every time. Turn it on only
   * if your failures are genuinely transient (worker OOM, for instance).
   */
  retryOnRunPodFailure?: boolean;
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
function loadConfig(environmentLabel: string): RunPodConfig {
  const apiKey = process.env.RUNPOD_API_KEY;
  const endpointId = process.env.RUNPOD_ENDPOINT_ID;

  const missing: string[] = [];
  const present: string[] = [];
  (
    [
      ['RUNPOD_API_KEY', apiKey],
      ['RUNPOD_ENDPOINT_ID', endpointId],
    ] as const
  ).forEach(([name, value]) => (value ? present.push(name) : missing.push(name)));

  if (missing.length > 0) {
    // Naming the environment matters: Trigger.dev environment variables are
    // scoped per environment, so the usual cause of this error is the value
    // being set in DEVELOPMENT while the run happened in PRODUCTION. Listing
    // what IS present makes a partial setup obvious at a glance.
    throw new AbortTaskRunError(
      `Missing required environment variable(s): ${missing.join(', ')}. ` +
        `This run executed in the ${environmentLabel} environment` +
        (present.length > 0 ? `, where ${present.join(' and ')} ${present.length === 1 ? 'is' : 'are'} set` : '') +
        `. Trigger.dev environment variables are per-environment: set them under ` +
        `Project Settings > Environment Variables and make sure ${environmentLabel} is ticked, ` +
        `not just Development.`,
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
  // ONE attempt, deliberately.
  //
  // There is no way to retry this task cheaply: a retry re-enters run() from the
  // top, so it calls submitJob again and bills a brand new RunPod job and cold
  // start. It does NOT resume the job already in flight. With maxAttempts: 3 a
  // single bad workflow quietly cost three GPU submissions.
  //
  // If you want retries, the right shape is to split submission and polling into
  // two tasks so a polling failure can be retried without re-submitting. Ask and
  // I will do it.
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: RevenueGatePayload, { ctx }): Promise<RevenueGateResult> => {
    const config = loadConfig(ctx.environment.type);

    if (!payload?.workflow || typeof payload.workflow !== 'object' || Array.isArray(payload.workflow)) {
      throw new AbortTaskRunError(
        'payload.workflow is required and must be the ComfyUI workflow graph object. ' +
          'It is sent as input.workflow; the container rejects a bare graph with ' +
          '"Missing \'workflow\' parameter".',
      );
    }

    if (payload.extraInput && 'workflow' in payload.extraInput) {
      throw new AbortTaskRunError(
        'payload.extraInput must not contain a "workflow" key — pass the graph as payload.workflow. ' +
          'Having it in both places is ambiguous and the wrong one would silently win.',
      );
    }

    // --- 0. validate the graph locally, before spending anything ---------
    //
    // A graph naming a model the worker image lacks is rejected by ComfyUI's
    // own validator, but only AFTER the container is up. A real run of ours
    // spent 22.5s of queue plus 2.6s of execution to learn that. This check is
    // free and instant, so it happens first.
    const availableModels = payload.availableModels ?? availableModelsFromEnv();
    const workflowProblems = validateWorkflow(payload.workflow, availableModels);

    if (workflowProblems.length > 0) {
      logger.error('Workflow rejected before submission', { problems: workflowProblems });
      throw new AbortTaskRunError(
        `Workflow references ${workflowProblems.length} model(s) this endpoint does not have, ` +
          `so it was NOT submitted and no GPU time was used:\n` +
          workflowProblems.map((p) => `  • ${p.message}`).join('\n'),
      );
    }

    // --- 1. submit -------------------------------------------------------
    // Body becomes {"input": {...extraInput, "workflow": {...}}}.
    // workflow is spread LAST so extraInput can never clobber it.
    const submission = await submitJob(config, {
      ...(payload.extraInput ?? {}),
      workflow: payload.workflow,
    });
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
      let message = `RunPod job ${terminal.id} ended as ${terminal.status}: ${detail}`;

      // ComfyUI's validation errors name the models the endpoint DOES have.
      // Surface that as config the caller can paste in, so the same cold start
      // is never paid for twice.
      const learned = extractAvailableFromError(terminal.error);
      if (learned.length > 0 && Object.keys(availableModels).length === 0) {
        message +=
          `\n\nThis endpoint reports these models available: ${learned.join(', ')}. ` +
          `Set RUNPOD_AVAILABLE_CHECKPOINTS to that list (or pass payload.availableModels) ` +
          `and a graph naming anything else will be rejected locally, before it costs a cold start.`;
        logger.info('Learned available models from the failure', { available: learned });
      }

      // AbortTaskRunError by default, so Trigger.dev does NOT retry. A retry
      // would submit a fresh RunPod job and bill another cold start, and a
      // workflow the worker rejects will be rejected identically every time.
      throw payload.retryOnRunPodFailure ? new Error(message) : new AbortTaskRunError(message);
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
