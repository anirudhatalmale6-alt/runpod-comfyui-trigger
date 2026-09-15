import test from 'node:test';
import assert from 'node:assert/strict';

import {
  submitJob,
  getJobStatus,
  cancelJob,
  pollUntilTerminal,
  isTerminal,
  RunPodPermanentError,
  RunPodTransientError,
  RunPodDeadlineError,
  TERMINAL_STATUSES,
  type RunPodConfig,
} from '../src/utils/runpodClient.ts';
import { startMockRunPod, type MockOptions } from './mockRunpod.ts';

const API_KEY = 'rp_test_4f2c9a1b7e0d';
const ENDPOINT_ID = 'abcd1234efgh';

async function withMock<T>(
  opts: Partial<MockOptions>,
  fn: (config: RunPodConfig, mock: Awaited<ReturnType<typeof startMockRunPod>>) => Promise<T>,
): Promise<T> {
  const mock = await startMockRunPod({ apiKey: API_KEY, endpointId: ENDPOINT_ID, ...opts });
  const config: RunPodConfig = { apiKey: API_KEY, endpointId: ENDPOINT_ID, baseUrl: mock.baseUrl };
  try {
    return await fn(config, mock);
  } finally {
    await mock.close();
  }
}

/** No real sleeping: the interval is recorded and returns immediately. */
function stubWait(): { waitSeconds: (s: number) => Promise<void>; slept: number[] } {
  const slept: number[] = [];
  return {
    slept,
    waitSeconds: async (s: number) => {
      slept.push(s);
    },
  };
}

/** Virtual clock driven by whatever the stub wait "slept". */
function virtualClock(slept: number[]): () => number {
  return () => slept.reduce((a, b) => a + b, 0) * 1000;
}

// --- submission -------------------------------------------------------------

test('submitJob wraps the prompt in a root-level input object', async () => {
  await withMock({}, async (config, mock) => {
    const result = await submitJob(config, { '3': { class_type: 'KSampler' } });
    assert.equal(result.id, 'job-1');
    assert.equal(result.status, 'IN_QUEUE');
    assert.deepEqual(mock.submissions[0], { input: { '3': { class_type: 'KSampler' } } });
  });
});

test('submitJob does NOT double-wrap an already-wrapped payload', async () => {
  // Guards the one mistake that yields an empty prompt with a 200 OK.
  await withMock({}, async (config, mock) => {
    await submitJob(config, { prompt: { '3': {} } });
    assert.deepEqual(mock.submissions[0], { input: { prompt: { '3': {} } } });
  });
});

test('submitJob sends the API key as a Bearer token', async () => {
  await withMock({}, async (config, mock) => {
    await submitJob(config, { a: 1 });
    assert.equal(mock.requests[0].auth, `Bearer ${API_KEY}`);
  });
});

test('submitJob hits POST /v2/{endpointId}/run', async () => {
  await withMock({}, async (config, mock) => {
    await submitJob(config, { a: 1 });
    assert.equal(mock.requests[0].method, 'POST');
    assert.equal(mock.requests[0].path, `/v2/${ENDPOINT_ID}/run`);
  });
});

test('a wrong API key is a PERMANENT error, not retried forever', async () => {
  await withMock({}, async (config) => {
    const bad = { ...config, apiKey: 'rp_wrong' };
    await assert.rejects(() => submitJob(bad, { a: 1 }), (err: unknown) => {
      assert.ok(err instanceof RunPodPermanentError);
      assert.equal((err as RunPodPermanentError).status, 401);
      return true;
    });
  });
});

test('a wrong endpoint id is a PERMANENT error', async () => {
  await withMock({}, async (config) => {
    const bad = { ...config, endpointId: 'does-not-exist' };
    await assert.rejects(() => submitJob(bad, { a: 1 }), RunPodPermanentError);
  });
});

test('a 500 on submit is a TRANSIENT error', async () => {
  await withMock({ failSubmitTimes: 1, failSubmitStatus: 500 }, async (config) => {
    await assert.rejects(() => submitJob(config, { a: 1 }), RunPodTransientError);
  });
});

test('a 429 on submit is TRANSIENT', async () => {
  await withMock({ failSubmitTimes: 1, failSubmitStatus: 429 }, async (config) => {
    await assert.rejects(() => submitJob(config, { a: 1 }), RunPodTransientError);
  });
});

test('a 400 on submit is PERMANENT', async () => {
  await withMock({ failSubmitTimes: 1, failSubmitStatus: 400 }, async (config) => {
    await assert.rejects(() => submitJob(config, { a: 1 }), RunPodPermanentError);
  });
});

test('a 200 with no job id is treated as permanent, not silently accepted', async () => {
  await withMock({ submitWithoutId: true }, async (config) => {
    await assert.rejects(() => submitJob(config, { a: 1 }), (err: unknown) => {
      assert.ok(err instanceof RunPodPermanentError);
      assert.match((err as Error).message, /returned no job id/);
      return true;
    });
  });
});

// --- terminal state handling ------------------------------------------------

test('all four RunPod terminal states are recognised', () => {
  // The brief said to break only on COMPLETED or FAILED. These two would have
  // polled until the deadline.
  assert.equal(isTerminal('CANCELLED'), true);
  assert.equal(isTerminal('TIMED_OUT'), true);
  assert.equal(isTerminal('COMPLETED'), true);
  assert.equal(isTerminal('FAILED'), true);
  assert.equal(isTerminal('IN_QUEUE'), false);
  assert.equal(isTerminal('IN_PROGRESS'), false);
  assert.equal(TERMINAL_STATUSES.length, 4);
});

// --- polling ----------------------------------------------------------------

test('polls through IN_QUEUE and IN_PROGRESS to COMPLETED', async () => {
  await withMock(
    { script: { queuePolls: 2, progressPolls: 2, terminal: 'COMPLETED', output: { images: ['a.png'] } } },
    async (config) => {
      const { waitSeconds, slept } = stubWait();
      const seen: string[] = [];
      const result = await pollUntilTerminal(config, (await submitJob(config, { a: 1 })).id, {
        waitSeconds,
        nowMs: virtualClock(slept),
        onPoll: (_a, status) => seen.push(status),
      });
      assert.equal(result.status, 'COMPLETED');
      assert.deepEqual(result.output, { images: ['a.png'] });
      assert.deepEqual(seen, ['IN_QUEUE', 'IN_QUEUE', 'IN_PROGRESS', 'IN_PROGRESS', 'COMPLETED']);
    },
  );
});

test('the wait between polls backs off and never busy-loops', async () => {
  await withMock({ script: { queuePolls: 3, progressPolls: 3 } }, async (config) => {
    const { waitSeconds, slept } = stubWait();
    await pollUntilTerminal(config, (await submitJob(config, { a: 1 })).id, {
      waitSeconds,
      nowMs: virtualClock(slept),
    });
    // DEFAULT_INTERVALS = [5,5,10,10,15], last value repeats.
    assert.deepEqual(slept, [5, 5, 10, 10, 15, 15]);
    assert.ok(slept.every((s) => s > 0), 'every gap must be a real wait');
  });
});

test('a FAILED job is returned as terminal, not thrown by the poller', async () => {
  await withMock({ script: { queuePolls: 0, progressPolls: 1, terminal: 'FAILED', error: 'OOM on the GPU' } }, async (config) => {
    const { waitSeconds, slept } = stubWait();
    const result = await pollUntilTerminal(config, (await submitJob(config, { a: 1 })).id, {
      waitSeconds,
      nowMs: virtualClock(slept),
    });
    assert.equal(result.status, 'FAILED');
    assert.equal(result.error, 'OOM on the GPU');
  });
});

test('CANCELLED terminates the loop instead of polling forever', async () => {
  await withMock({ script: { queuePolls: 0, progressPolls: 0, terminal: 'CANCELLED' } }, async (config) => {
    const { waitSeconds, slept } = stubWait();
    const result = await pollUntilTerminal(config, (await submitJob(config, { a: 1 })).id, {
      waitSeconds,
      nowMs: virtualClock(slept),
    });
    assert.equal(result.status, 'CANCELLED');
    assert.equal(slept.length, 0, 'terminal on first poll means no wait at all');
  });
});

test('TIMED_OUT terminates the loop', async () => {
  await withMock({ script: { queuePolls: 0, progressPolls: 0, terminal: 'TIMED_OUT' } }, async (config) => {
    const { waitSeconds, slept } = stubWait();
    const result = await pollUntilTerminal(config, (await submitJob(config, { a: 1 })).id, {
      waitSeconds,
      nowMs: virtualClock(slept),
    });
    assert.equal(result.status, 'TIMED_OUT');
  });
});

test('the deadline is enforced and the job is cancelled on the way out', async () => {
  // A job that never leaves the queue.
  await withMock({ script: { queuePolls: 10_000, progressPolls: 0 } }, async (config, mock) => {
    const { waitSeconds, slept } = stubWait();
    const jobId = (await submitJob(config, { a: 1 })).id;
    await assert.rejects(
      () =>
        pollUntilTerminal(config, jobId, {
          waitSeconds,
          nowMs: virtualClock(slept),
          deadlineSeconds: 30,
        }),
      (err: unknown) => {
        assert.ok(err instanceof RunPodDeadlineError);
        const e = err as RunPodDeadlineError;
        assert.equal(e.jobId, jobId);
        assert.equal(e.lastStatus, 'IN_QUEUE');
        assert.equal(e.cancelled, true, 'the GPU job must be cancelled, not abandoned');
        return true;
      },
    );
    assert.deepEqual(mock.cancels, [jobId], 'exactly one cancel call for the abandoned job');
  });
});

test('cancelOnDeadline:false leaves the job running and says so', async () => {
  await withMock({ script: { queuePolls: 10_000 } }, async (config, mock) => {
    const { waitSeconds, slept } = stubWait();
    const jobId = (await submitJob(config, { a: 1 })).id;
    await assert.rejects(
      () =>
        pollUntilTerminal(config, jobId, {
          waitSeconds,
          nowMs: virtualClock(slept),
          deadlineSeconds: 20,
          cancelOnDeadline: false,
        }),
      (err: unknown) => {
        assert.equal((err as RunPodDeadlineError).cancelled, false);
        return true;
      },
    );
    assert.deepEqual(mock.cancels, []);
  });
});

test('a failed cancel does not mask the deadline error', async () => {
  await withMock({ script: { queuePolls: 10_000 } }, async (config) => {
    const { waitSeconds, slept } = stubWait();
    const jobId = (await submitJob(config, { a: 1 })).id;
    // Point cancellation at a dead port so it throws internally.
    const broken = { ...config, baseUrl: 'http://127.0.0.1:1' };
    await assert.rejects(
      () =>
        pollUntilTerminal(broken, jobId, {
          waitSeconds,
          nowMs: virtualClock(slept),
          deadlineSeconds: 0,
        }),
      RunPodDeadlineError,
    );
  });
});

test('custom intervals are honoured', async () => {
  await withMock({ script: { queuePolls: 2, progressPolls: 0 } }, async (config) => {
    const { waitSeconds, slept } = stubWait();
    await pollUntilTerminal(config, (await submitJob(config, { a: 1 })).id, {
      waitSeconds,
      nowMs: virtualClock(slept),
      intervals: [1, 2, 3],
    });
    assert.deepEqual(slept, [1, 2]);
  });
});

// --- status endpoint --------------------------------------------------------

test('getJobStatus hits GET /v2/{endpointId}/status/{jobId}', async () => {
  await withMock({}, async (config, mock) => {
    const id = (await submitJob(config, { a: 1 })).id;
    await getJobStatus(config, id);
    const last = mock.requests[mock.requests.length - 1];
    assert.equal(last.method, 'GET');
    assert.equal(last.path, `/v2/${ENDPOINT_ID}/status/${id}`);
  });
});

test('a non-JSON status body is transient, not a crash', async () => {
  await withMock({ malformedStatusOnce: true }, async (config) => {
    const id = (await submitJob(config, { a: 1 })).id;
    await assert.rejects(() => getJobStatus(config, id), RunPodTransientError);
  });
});

test('a 503 on status is transient', async () => {
  await withMock({ failStatusTimes: 1, failStatusStatus: 503 }, async (config) => {
    const id = (await submitJob(config, { a: 1 })).id;
    await assert.rejects(() => getJobStatus(config, id), RunPodTransientError);
  });
});

test('an unknown job id is a permanent 404', async () => {
  await withMock({}, async (config) => {
    await assert.rejects(() => getJobStatus(config, 'nope'), RunPodPermanentError);
  });
});

test('cancelJob returns false rather than throwing when it cannot reach RunPod', async () => {
  const dead: RunPodConfig = { apiKey: API_KEY, endpointId: ENDPOINT_ID, baseUrl: 'http://127.0.0.1:1' };
  assert.equal(await cancelJob(dead, 'job-1'), false);
});

// --- network ----------------------------------------------------------------

test('a network failure is transient', async () => {
  const dead: RunPodConfig = { apiKey: API_KEY, endpointId: ENDPOINT_ID, baseUrl: 'http://127.0.0.1:1' };
  await assert.rejects(() => submitJob(dead, { a: 1 }), RunPodTransientError);
});

test('a hung endpoint is abandoned at the request timeout', async () => {
  const server = (await import('node:http')).createServer(() => {
    /* never respond */
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('bind failed');
  const config: RunPodConfig = {
    apiKey: API_KEY,
    endpointId: ENDPOINT_ID,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requestTimeoutMs: 250,
  };
  try {
    await assert.rejects(() => submitJob(config, { a: 1 }), RunPodTransientError);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
