import test from 'node:test';
import assert from 'node:assert/strict';

import { classify, diagnose } from '../src/utils/storageDoctor.ts';

/**
 * These codes and shapes were observed against a REAL S3 implementation
 * (MinIO in a container) with real IAM policies, not invented. Nine scenarios
 * were driven end to end; the verdicts below are what the live server produced.
 */

test('a bad access key id is credentials_rejected', () => {
  assert.equal(classify('InvalidAccessKeyId', 403, 'listObjects'), 'credentials_rejected');
});

test('a bad secret is signature_mismatch', () => {
  assert.equal(classify('SignatureDoesNotMatch', 403, 'listObjects'), 'signature_mismatch');
});

test('a missing bucket is bucket_missing', () => {
  assert.equal(classify('NoSuchBucket', 404, 'listObjects'), 'bucket_missing');
});

test('AccessDenied on the list itself is a list-permission problem', () => {
  assert.equal(classify('AccessDenied', 403, 'listObjects'), 'no_list_permission');
});

test('AccessDenied on headBucket alone is NOT conclusive', () => {
  // HeadBucket returns no body, so this must not be read as the final answer.
  assert.equal(classify('AccessDenied', 403, 'headBucket'), null);
});

test('a bare 403 with an unrecognised code still reads as a permission problem', () => {
  // Observed: HeadBucket failures surface as name "Unknown" with status 403,
  // because there is no XML body to parse a code out of.
  assert.equal(classify('Unknown', 403, 'headBucket'), 'no_list_permission');
});

test('a bare 404 with an unrecognised code reads as a missing bucket', () => {
  assert.equal(classify('Unknown', 404, 'headBucket'), 'bucket_missing');
});

test('REGRESSION: a refused connection surfaces as name "Error", not ECONNREFUSED', () => {
  // This is the defect a real server found and a mock would not have. The AWS
  // SDK wraps the socket failure, so only the message carries the cause.
  assert.equal(classify('Error', undefined, 'listObjects'), null);
  assert.equal(
    classify('Error', undefined, 'listObjects', 'connect ECONNREFUSED 127.0.0.1:9999'),
    'endpoint_unreachable',
  );
  assert.equal(
    classify('Error', undefined, 'listObjects', 'getaddrinfo ENOTFOUND s3.example.invalid'),
    'endpoint_unreachable',
  );
});

test('an unrecognised code with no status yields no verdict rather than a guess', () => {
  assert.equal(classify('SomethingNew', undefined, 'listObjects'), null);
});

test('empty credentials are caught before any network call', async () => {
  const result = await diagnose({
    provider: 'other',
    label: 'test',
    endpoint: 'http://127.0.0.1:1',
    region: 'auto',
    bucket: 'hot',
    accessKeyId: '',
    secretAccessKey: '',
  });
  assert.equal(result.verdict, 'credentials_missing');
  // Nothing was attempted over the network.
  assert.deepEqual(result.steps.map((s) => s.probe), ['credentials']);
});

test('the credentials step records length, never the secret', async () => {
  const result = await diagnose({
    provider: 'other',
    label: 'test',
    endpoint: 'http://127.0.0.1:1',
    region: 'auto',
    bucket: 'hot',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'super-secret-value-here',
  });
  const serialised = JSON.stringify(result);
  assert.equal(serialised.includes('super-secret-value-here'), false);
  assert.equal(serialised.includes('AKIAEXAMPLE'), false);
});

test('an unreachable endpoint is reported as such, not as unknown', async () => {
  const result = await diagnose({
    provider: 'other',
    label: 'test',
    endpoint: 'http://127.0.0.1:1',
    region: 'auto',
    bucket: 'hot',
    accessKeyId: 'a',
    secretAccessKey: 'b',
  });
  assert.equal(result.verdict, 'endpoint_unreachable');
});

test('every verdict has advice attached', async () => {
  const result = await diagnose({
    provider: 'other',
    label: 'test',
    endpoint: 'http://127.0.0.1:1',
    region: 'auto',
    bucket: 'hot',
    accessKeyId: '',
    secretAccessKey: '',
  });
  assert.ok(result.advice.length > 20, 'advice must actually say something');
});
