#!/usr/bin/env node
/**
 * Run the storage diagnosis LOCALLY, without deploying anything.
 *
 *   TIGRIS_ENDPOINT=... TIGRIS_BUCKET=... TIGRIS_ACCESS_KEY_ID=... \
 *   TIGRIS_SECRET_ACCESS_KEY=... node scripts/storage-doctor.mjs
 *
 * Or put them in a .env file and:
 *   node --env-file=.env scripts/storage-doctor.mjs
 *
 * Optional:
 *   PREFIX=renders/     the prefix your sweeper actually lists
 *   PROBE_WRITE=1       also try a tiny write + delete (off by default)
 *
 * Read-only unless PROBE_WRITE is set. Credentials are never printed — only
 * whether they are present and how long they are.
 *
 * Requires @aws-sdk/client-s3 to be resolvable from here, which it is if you run
 * this from inside your project after install.sh.
 */

import { diagnose } from '../src/utils/storageDoctor.ts';

const PREFIX = process.env.PREFIX || undefined;
const PROBE_WRITE = process.env.PROBE_WRITE === '1';

function configFor(provider) {
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
    region: region ?? (provider === 'tigris' ? 'auto' : 'us-west-004'),
    prefix: PREFIX,
    probeWrite: PROBE_WRITE,
  };
}

const providers = ['tigris', 'backblaze'];
const configured = providers.map(configFor).filter(Boolean);

if (configured.length === 0) {
  console.error('');
  console.error('Nothing to probe. Set at least one provider:');
  console.error('  TIGRIS_ENDPOINT, TIGRIS_BUCKET, TIGRIS_ACCESS_KEY_ID, TIGRIS_SECRET_ACCESS_KEY');
  console.error('  BACKBLAZE_ENDPOINT, BACKBLAZE_BUCKET, BACKBLAZE_ACCESS_KEY_ID, BACKBLAZE_SECRET_ACCESS_KEY');
  console.error('');
  process.exit(2);
}

console.log('');
console.log(`  prefix     : ${PREFIX ?? '(none — listing bucket root)'}`);
console.log(`  write probe: ${PROBE_WRITE ? 'ON (will write then delete one tiny object)' : 'off'}`);
console.log('');

let allOk = true;

for (const config of configured) {
  const result = await diagnose(config);
  if (result.verdict !== 'ok') allOk = false;

  console.log(`  ${config.label}  (${config.endpoint}, bucket "${config.bucket}", region "${config.region}")`);
  console.log(`  ${'-'.repeat(70)}`);
  for (const step of result.steps) {
    const mark = step.ok ? 'ok  ' : 'FAIL';
    const detail = step.ok ? (step.message ?? '') : `${step.code ?? ''} ${step.httpStatus ?? ''} ${step.message ?? ''}`;
    console.log(`    ${mark} ${step.probe.padEnd(26)} ${detail.trim().slice(0, 110)}`);
  }
  console.log('');
  console.log(`    VERDICT: ${result.verdict}`);
  console.log('');
  for (const line of wrap(result.advice, 72)) console.log(`      ${line}`);
  console.log('');
}

const skipped = providers.filter((p) => !configured.some((c) => c.provider === p));
if (skipped.length > 0) {
  console.log(`  not configured, not probed: ${skipped.join(', ')}`);
  console.log('');
}

process.exit(allOk ? 0 : 1);

function wrap(text, width) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line.trim());
      line = word;
    } else {
      line += ' ' + word;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}
