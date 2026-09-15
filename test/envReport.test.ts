import test from 'node:test';
import assert from 'node:assert/strict';

import { inspectVar, problemsFor, loggableReport } from '../src/utils/envReport.ts';

test('a missing variable is reported as not present', () => {
  const r = inspectVar('RUNPOD_ENDPOINT_ID', {});
  assert.equal(r.present, false);
  assert.equal(r.length, 0);
});

test('a set variable is present with its length, never its value', () => {
  const r = inspectVar('RUNPOD_API_KEY', { RUNPOD_API_KEY: 'rp_abcdef123456' });
  assert.equal(r.present, true);
  assert.equal(r.length, 'rp_abcdef123456'.length);
  assert.equal(r.blank, false);
  assert.equal(r.untrimmed, false);
  // The report must not carry the secret anywhere.
  assert.equal(JSON.stringify(r).includes('rp_abcdef123456'), false);
});

test('an empty string is present but blank — the case a truthy check misses', () => {
  const r = inspectVar('RUNPOD_ENDPOINT_ID', { RUNPOD_ENDPOINT_ID: '' });
  assert.equal(r.present, true);
  assert.equal(r.blank, true);
});

test('whitespace-only is blank', () => {
  const r = inspectVar('RUNPOD_ENDPOINT_ID', { RUNPOD_ENDPOINT_ID: '   ' });
  assert.equal(r.blank, true);
});

test('a trailing newline from a paste is flagged as untrimmed', () => {
  const r = inspectVar('RUNPOD_API_KEY', { RUNPOD_API_KEY: 'rp_abc123\n' });
  assert.equal(r.untrimmed, true);
  assert.equal(r.blank, false);
  assert.equal(r.length, 10);
});

test('a leading space is flagged as untrimmed', () => {
  assert.equal(inspectVar('X', { X: ' abc' }).untrimmed, true);
});

test('problemsFor names the environment in a missing-variable message', () => {
  const problems = problemsFor([inspectVar('RUNPOD_ENDPOINT_ID', {})], 'PRODUCTION');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /RUNPOD_ENDPOINT_ID is NOT SET/);
  assert.match(problems[0], /PRODUCTION/);
  // The whole point: tell them which environment to tick.
  assert.match(problems[0], /PRODUCTION ticked/);
});

test('problemsFor reports the real error from this deploy', () => {
  // API key set, endpoint id missing — exactly what the client hit.
  const env = { RUNPOD_API_KEY: 'rp_live_xxxxxxxx' };
  const reports = ['RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID'].map((n) => inspectVar(n, env));
  const problems = problemsFor(reports, 'PRODUCTION');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /RUNPOD_ENDPOINT_ID/);
  assert.equal(problems.some((p) => p.includes('RUNPOD_API_KEY')), false, 'must not complain about the one that IS set');
});

test('problemsFor is silent when everything is well-formed', () => {
  const env = { RUNPOD_API_KEY: 'rp_live_abc', RUNPOD_ENDPOINT_ID: 'abcd1234' };
  const reports = ['RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID'].map((n) => inspectVar(n, env));
  assert.deepEqual(problemsFor(reports, 'PRODUCTION'), []);
});

test('a blank value produces a different message than a missing one', () => {
  const missing = problemsFor([inspectVar('A', {})], 'STAGING')[0];
  const blank = problemsFor([inspectVar('A', { A: '' })], 'STAGING')[0];
  assert.notEqual(missing, blank);
  assert.match(blank, /set but empty/);
});

test('an untrimmed value explains why the header would be rejected', () => {
  const p = problemsFor([inspectVar('RUNPOD_API_KEY', { RUNPOD_API_KEY: 'rp_abc ' })], 'PRODUCTION')[0];
  assert.match(p, /whitespace/);
  assert.match(p, /Authorization header/);
});

test('loggableReport never leaks a value', () => {
  const r = inspectVar('RUNPOD_API_KEY', { RUNPOD_API_KEY: 'super-secret-value' });
  const safe = loggableReport(r);
  assert.deepEqual(Object.keys(safe).sort(), ['length', 'name', 'present']);
  assert.equal(JSON.stringify(safe).includes('super-secret'), false);
});
