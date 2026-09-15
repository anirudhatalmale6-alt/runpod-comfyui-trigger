/**
 * RunPod Serverless API v2 client.
 *
 * Deliberately free of any Trigger.dev import so the whole thing can be driven
 * against a mock server in tests. The task file supplies the real `wait`.
 *
 * Endpoints used:
 *   POST {base}/v2/{endpointId}/run              submit, returns { id, status }
 *   GET  {base}/v2/{endpointId}/status/{jobId}   poll
 *   POST {base}/v2/{endpointId}/cancel/{jobId}   used to clean up on deadline
 *
 * Auth is a Bearer token, as specified.
 */

/** Every state RunPod can report. */
export type RunPodStatus =
  | 'IN_QUEUE'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMED_OUT';

/**
 * Terminal states.
 *
 * NOTE: the brief said to loop "until the status maps strictly to COMPLETED or
 * FAILED". That is not safe on its own — RunPod also returns CANCELLED and
 * TIMED_OUT, and a loop that only breaks on COMPLETED/FAILED will keep polling
 * a job that is already dead until the task's own deadline kills it. All four
 * are treated as terminal here.
 */
export const TERMINAL_STATUSES: readonly RunPodStatus[] = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'TIMED_OUT',
];

export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

export type RunPodConfig = {
  apiKey: string;
  endpointId: string;
  /** Override for tests. Defaults to the real API. */
  baseUrl?: string;
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout in ms. Defaults to 30s. */
  requestTimeoutMs?: number;
};

export type SubmitResponse = {
  id: string;
  status: string;
};

export type StatusResponse = {
  id: string;
  status: string;
  /** Present when COMPLETED. Shape is whatever the ComfyUI worker returns. */
  output?: unknown;
  /** Present when FAILED. */
  error?: unknown;
  delayTime?: number;
  executionTime?: number;
};

/**
 * Raised for anything the caller cannot fix by retrying — a 401, a 404 on the
 * endpoint id, a malformed body. The task turns these into AbortTaskRunError so
 * Trigger.dev stops instead of burning retries on a permanent failure.
 */
export class RunPodPermanentError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'RunPodPermanentError';
    this.status = status;
    this.body = body;
  }
}

/** Raised for 5xx / network faults, which are worth retrying. */
export class RunPodTransientError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = 'RunPodTransientError';
    this.status = status;
  }
}

function baseOf(config: RunPodConfig): string {
  return (config.baseUrl ?? 'https://api.runpod.ai').replace(/\/+$/, '');
}

async function request(
  config: RunPodConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const doFetch = config.fetchImpl ?? fetch;
  const url = `${baseOf(config)}${path}`;
  const timeoutMs = config.requestTimeoutMs ?? 30_000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await doFetch(url, {
      method,
      headers: {
        // Bearer, as specified.
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RunPodTransientError(`network failure calling ${method} ${path}: ${message}`, null);
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok) {
    // 408/429 and 5xx are worth another go. Everything else is a real problem
    // with the request itself and retrying just wastes the run.
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    const snippet = text.slice(0, 500);
    if (retryable) {
      throw new RunPodTransientError(
        `RunPod returned ${response.status} for ${method} ${path}: ${snippet}`,
        response.status,
      );
    }
    throw new RunPodPermanentError(
      `RunPod returned ${response.status} for ${method} ${path}: ${snippet}`,
      response.status,
      snippet,
    );
  }

  if (text.trim() === '') return {};

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RunPodTransientError(
      `RunPod returned non-JSON for ${method} ${path}: ${text.slice(0, 200)}`,
      response.status,
    );
  }
}

/**
 * Submit an asynchronous job.
 *
 * The payload is wrapped in a root-level `input` object, as required. Callers
 * pass the ComfyUI prompt graph and it is nested for them — passing an already
 * wrapped object would produce `{input:{input:{...}}}`, which the worker would
 * silently treat as an empty prompt, so this is the only place the wrapping
 * happens.
 */
export async function submitJob(
  config: RunPodConfig,
  promptPayload: Record<string, unknown>,
): Promise<SubmitResponse> {
  const raw = await request(config, 'POST', `/v2/${config.endpointId}/run`, {
    input: promptPayload,
  });

  const parsed = raw as { id?: unknown; status?: unknown; error?: unknown };

  if (typeof parsed.id !== 'string' || parsed.id === '') {
    throw new RunPodPermanentError(
      `RunPod accepted the submission but returned no job id: ${JSON.stringify(raw).slice(0, 300)}`,
      200,
      JSON.stringify(raw).slice(0, 300),
    );
  }

  return {
    id: parsed.id,
    status: typeof parsed.status === 'string' ? parsed.status : 'IN_QUEUE',
  };
}

export async function getJobStatus(config: RunPodConfig, jobId: string): Promise<StatusResponse> {
  const raw = await request(config, 'GET', `/v2/${config.endpointId}/status/${jobId}`);
  const parsed = raw as Record<string, unknown>;

  if (typeof parsed.status !== 'string') {
    throw new RunPodTransientError(
      `status response had no status field: ${JSON.stringify(raw).slice(0, 300)}`,
      200,
    );
  }

  return {
    id: typeof parsed.id === 'string' ? parsed.id : jobId,
    status: parsed.status,
    output: parsed.output,
    error: parsed.error,
    delayTime: typeof parsed.delayTime === 'number' ? parsed.delayTime : undefined,
    executionTime: typeof parsed.executionTime === 'number' ? parsed.executionTime : undefined,
  };
}

/** Best-effort cancellation, used when the polling deadline is hit. */
export async function cancelJob(config: RunPodConfig, jobId: string): Promise<boolean> {
  try {
    await request(config, 'POST', `/v2/${config.endpointId}/cancel/${jobId}`);
    return true;
  } catch {
    // A failed cancel must never mask the real reason the run is ending.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export type PollOptions = {
  /** Called to sleep. The task passes Trigger.dev's wait.for; tests pass a stub. */
  waitSeconds: (seconds: number) => Promise<void>;
  /**
   * Interval schedule in seconds. The last entry repeats for the rest of the
   * run. ComfyUI renders exceed 30s, so polling every 2s just burns checkpoints
   * with nothing to show; this starts moderate and backs off.
   */
  intervals?: number[];
  /** Give up after this long. Must sit under the task's maxDuration. */
  deadlineSeconds?: number;
  /** Monotonic clock in ms. Injectable so tests need no real time. */
  nowMs?: () => number;
  /** Cancel the RunPod job if the deadline is reached. Default true. */
  cancelOnDeadline?: boolean;
  onPoll?: (attempt: number, status: string, elapsedSeconds: number) => void;
};

export class RunPodDeadlineError extends Error {
  readonly jobId: string;
  readonly lastStatus: string;
  readonly elapsedSeconds: number;
  readonly cancelled: boolean;
  constructor(jobId: string, lastStatus: string, elapsedSeconds: number, cancelled: boolean) {
    super(
      `RunPod job ${jobId} did not finish within ${elapsedSeconds}s (last status: ${lastStatus}); ` +
        `cancel ${cancelled ? 'succeeded' : 'failed or was skipped'}`,
    );
    this.name = 'RunPodDeadlineError';
    this.jobId = jobId;
    this.lastStatus = lastStatus;
    this.elapsedSeconds = elapsedSeconds;
    this.cancelled = cancelled;
  }
}

export const DEFAULT_INTERVALS = [5, 5, 10, 10, 15];

/**
 * Poll until the job reaches a terminal state or the deadline passes.
 *
 * Returns the terminal StatusResponse for ANY terminal state, including FAILED
 * — deciding what a failure means is the caller's job, not the poller's.
 */
export async function pollUntilTerminal(
  config: RunPodConfig,
  jobId: string,
  options: PollOptions,
): Promise<StatusResponse> {
  const intervals = options.intervals?.length ? options.intervals : DEFAULT_INTERVALS;
  const deadlineSeconds = options.deadlineSeconds ?? 600;
  const now = options.nowMs ?? Date.now;
  const started = now();

  let attempt = 0;
  let lastStatus = 'UNKNOWN';

  for (;;) {
    const elapsedSeconds = Math.round((now() - started) / 1000);

    if (elapsedSeconds >= deadlineSeconds) {
      const cancelled =
        options.cancelOnDeadline === false ? false : await cancelJob(config, jobId);
      throw new RunPodDeadlineError(jobId, lastStatus, elapsedSeconds, cancelled);
    }

    const snapshot = await getJobStatus(config, jobId);
    lastStatus = snapshot.status;
    attempt += 1;
    options.onPoll?.(attempt, snapshot.status, elapsedSeconds);

    if (isTerminal(snapshot.status)) return snapshot;

    const interval = intervals[Math.min(attempt - 1, intervals.length - 1)];
    await options.waitSeconds(interval);
  }
}
