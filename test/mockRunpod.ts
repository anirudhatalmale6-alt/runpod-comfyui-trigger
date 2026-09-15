/**
 * A mock RunPod Serverless v2 endpoint.
 *
 * Real enough to exercise the client end to end: it enforces the Bearer token,
 * enforces the root-level `input` wrapper, walks jobs through IN_QUEUE ->
 * IN_PROGRESS -> a terminal state after a configurable number of polls, and can
 * be told to return 500s, 401s and malformed bodies on demand.
 */

import { createServer, type Server } from 'node:http';

export type JobScript = {
  /** Polls spent in IN_QUEUE before moving on. */
  queuePolls?: number;
  /** Polls spent IN_PROGRESS before reaching the terminal state. */
  progressPolls?: number;
  /** Where the job ends up. */
  terminal?: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';
  output?: unknown;
  error?: unknown;
};

export type MockOptions = {
  apiKey: string;
  endpointId: string;
  script?: JobScript;
  /** Fail the first N /run calls with this status before succeeding. */
  failSubmitTimes?: number;
  failSubmitStatus?: number;
  /** Fail the first N /status calls with this status before succeeding. */
  failStatusTimes?: number;
  failStatusStatus?: number;
  /** Return a body that is not JSON on the first /status call. */
  malformedStatusOnce?: boolean;
  /** Omit the id from the /run response. */
  submitWithoutId?: boolean;
};

export type MockHandle = {
  server: Server;
  baseUrl: string;
  /** Every request the mock received, in order. */
  requests: Array<{ method: string; path: string; auth: string | undefined; body: string }>;
  /** Bodies submitted to /run, parsed. */
  submissions: unknown[];
  cancels: string[];
  close: () => Promise<void>;
};

export async function startMockRunPod(options: MockOptions): Promise<MockHandle> {
  const script: Required<JobScript> = {
    queuePolls: options.script?.queuePolls ?? 1,
    progressPolls: options.script?.progressPolls ?? 1,
    terminal: options.script?.terminal ?? 'COMPLETED',
    output: options.script?.output ?? { images: ['s3://renders/scene-0042.png'] },
    error: options.script?.error ?? undefined,
  };

  const requests: MockHandle['requests'] = [];
  const submissions: unknown[] = [];
  const cancels: string[] = [];
  const pollCounts = new Map<string, number>();
  const cancelled = new Set<string>();

  let submitFailuresLeft = options.failSubmitTimes ?? 0;
  let statusFailuresLeft = options.failStatusTimes ?? 0;
  let malformedLeft = options.malformedStatusOnce ? 1 : 0;
  let jobSeq = 0;

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const path = (req.url ?? '/').split('?')[0];
      const auth = req.headers.authorization;
      requests.push({ method: req.method ?? 'GET', path, auth, body });

      const send = (status: number, payload: unknown) => {
        const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(text);
      };

      // --- auth -------------------------------------------------------
      if (auth !== `Bearer ${options.apiKey}`) {
        send(401, { error: 'Unauthorized' });
        return;
      }

      const prefix = `/v2/${options.endpointId}`;
      if (!path.startsWith(prefix)) {
        send(404, { error: 'endpoint not found' });
        return;
      }
      const rest = path.slice(prefix.length);

      // --- POST /run --------------------------------------------------
      if (rest === '/run' && req.method === 'POST') {
        if (submitFailuresLeft > 0) {
          submitFailuresLeft -= 1;
          send(options.failSubmitStatus ?? 500, { error: 'transient' });
          return;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          send(400, { error: 'body was not JSON' });
          return;
        }
        submissions.push(parsed);

        // Enforce the root-level input wrapper the brief requires.
        const asObj = parsed as Record<string, unknown>;
        if (!asObj || typeof asObj.input !== 'object' || asObj.input === null) {
          send(400, { error: 'payload must be wrapped in a root-level "input" object' });
          return;
        }

        if (options.submitWithoutId) {
          send(200, { status: 'IN_QUEUE' });
          return;
        }

        jobSeq += 1;
        const id = `job-${jobSeq}`;
        pollCounts.set(id, 0);
        send(200, { id, status: 'IN_QUEUE' });
        return;
      }

      // --- GET /status/{id} -------------------------------------------
      if (rest.startsWith('/status/') && req.method === 'GET') {
        const jobId = rest.slice('/status/'.length);

        if (malformedLeft > 0) {
          malformedLeft -= 1;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('<html>not json at all</html>');
          return;
        }
        if (statusFailuresLeft > 0) {
          statusFailuresLeft -= 1;
          send(options.failStatusStatus ?? 503, { error: 'transient' });
          return;
        }
        if (!pollCounts.has(jobId)) {
          send(404, { error: 'job not found' });
          return;
        }
        if (cancelled.has(jobId)) {
          send(200, { id: jobId, status: 'CANCELLED' });
          return;
        }

        const n = pollCounts.get(jobId)!;
        pollCounts.set(jobId, n + 1);

        if (n < script.queuePolls) {
          send(200, { id: jobId, status: 'IN_QUEUE' });
          return;
        }
        if (n < script.queuePolls + script.progressPolls) {
          send(200, { id: jobId, status: 'IN_PROGRESS' });
          return;
        }

        if (script.terminal === 'COMPLETED') {
          send(200, {
            id: jobId,
            status: 'COMPLETED',
            output: script.output,
            delayTime: 1200,
            executionTime: 34_500,
          });
          return;
        }
        send(200, {
          id: jobId,
          status: script.terminal,
          error: script.error ?? `job ended as ${script.terminal}`,
        });
        return;
      }

      // --- POST /cancel/{id} ------------------------------------------
      if (rest.startsWith('/cancel/') && req.method === 'POST') {
        const jobId = rest.slice('/cancel/'.length);
        cancels.push(jobId);
        cancelled.add(jobId);
        send(200, { id: jobId, status: 'CANCELLED' });
        return;
      }

      send(404, { error: `no route for ${req.method} ${path}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('mock failed to bind');

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    submissions,
    cancels,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
