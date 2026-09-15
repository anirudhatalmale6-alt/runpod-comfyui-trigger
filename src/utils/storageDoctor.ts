/**
 * S3 storage diagnostic — tells you WHICH of the several causes of
 * "AccessDenied" you are actually looking at.
 *
 * AccessDenied on ListObjectsV2 is one error code covering at least five
 * distinct problems, and guessing between them costs a deploy cycle each time.
 * This probes them in an order that separates them, using the real AWS SDK
 * against the real endpoint, and reports a single verdict.
 *
 * Every probe is read-only by default. Nothing here writes, deletes or lists
 * destructively. The optional write probe is opt-in and cleans up after itself.
 *
 * Credentials are never logged — only whether they are present and their length.
 */

import {
  S3Client,
  ListObjectsV2Command,
  HeadBucketCommand,
  ListBucketsCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

export type ProviderName = 'tigris' | 'backblaze' | 'other';

export type StorageProbeConfig = {
  provider: ProviderName;
  label: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Prefix the job actually lists. Prefix-scoped keys only permit their own. */
  prefix?: string;
  forcePathStyle?: boolean;
  /** Try a tiny write + delete. Off by default. */
  probeWrite?: boolean;
};

export type Verdict =
  | 'ok'
  | 'credentials_missing'
  | 'credentials_rejected'
  | 'signature_mismatch'
  | 'bucket_missing'
  | 'no_list_permission'
  | 'no_list_permission_or_prefix_restricted'
  | 'prefix_restricted'
  | 'endpoint_unreachable'
  | 'unknown';

export type ProbeResult = {
  label: string;
  provider: ProviderName;
  verdict: Verdict;
  /** What to actually do about it. */
  advice: string;
  /** Ordered log of each probe attempted and its raw outcome. */
  steps: Array<{ probe: string; ok: boolean; code?: string; httpStatus?: number; message?: string }>;
};

function errCode(err: unknown): { code: string; status?: number; message: string } {
  const e = err as {
    name?: string;
    Code?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    code: e?.Code ?? e?.name ?? 'Unknown',
    status: e?.$metadata?.httpStatusCode,
    message: typeof e?.message === 'string' ? e.message : String(err),
  };
}

export function buildClient(config: StorageProbeConfig): S3Client {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    // Backblaze and Tigris both work virtual-hosted, but a path-style override
    // is occasionally needed behind proxies, so it stays configurable.
    forcePathStyle: config.forcePathStyle ?? false,
  });
}

/**
 * Map a raw S3 error to a verdict.
 *
 * Exported and pure so the classification can be unit tested against recorded
 * error shapes without needing a live endpoint.
 */
export function classify(
  code: string,
  status: number | undefined,
  probe: string,
  message = '',
): Verdict | null {
  // The SDK wraps socket failures, so the error NAME is often just "Error" and
  // the real cause is only visible in the message. Verified against a refused
  // port: code came back "Error", not "ECONNREFUSED".
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|ETIMEDOUT|socket hang up/i.test(message)) {
    return 'endpoint_unreachable';
  }

  switch (code) {
    case 'InvalidAccessKeyId':
    case 'UnrecognizedClientException':
      return 'credentials_rejected';
    case 'SignatureDoesNotMatch':
      return 'signature_mismatch';
    case 'NoSuchBucket':
      return 'bucket_missing';
    case 'AccessDenied':
    case 'AccessDeniedException':
      // AccessDenied on HeadBucket but fine elsewhere usually means the key is
      // scoped to objects, not the bucket. The caller refines this using which
      // probe failed; on its own, list-denial is the best single guess.
      return probe === 'listObjects' ? 'no_list_permission' : null;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNREFUSED':
    case 'TimeoutError':
      return 'endpoint_unreachable';
    default:
      if (status === 403) return 'no_list_permission';
      if (status === 404) return 'bucket_missing';
      return null;
  }
}

const ADVICE: Record<Verdict, string> = {
  ok: 'Listing works with these credentials against this bucket and prefix.',
  credentials_missing:
    'The access key or secret is empty. Check the environment variable names, and remember Trigger.dev scopes them per environment.',
  credentials_rejected:
    'The endpoint does not recognise this access key. The usual cause is the two providers\' keys being crossed over — a Tigris key sent to Backblaze, or the reverse.',
  signature_mismatch:
    'The key is recognised but the signature failed. Usually a wrong secret, a stray newline pasted into it, or the wrong region for the endpoint (Backblaze requires the region to match the endpoint exactly, e.g. us-west-004 with s3.us-west-004.backblazeb2.com).',
  bucket_missing:
    'The bucket does not exist at this endpoint. Check the name for typos, and check you are pointing at the right provider — a Tigris bucket name will not exist on Backblaze.',
  no_list_permission:
    'Credentials are valid but not allowed to LIST this bucket. On Backblaze an application key needs the listFiles capability; a key created for "read-only object access" can GET a known key but cannot enumerate. On Tigris the key needs list permission on the bucket. This is the single most common cause of AccessDenied on ListObjectsV2.',
  no_list_permission_or_prefix_restricted:
    'Listing is denied both for the requested prefix AND for the bucket root, which cannot distinguish two causes: either the key has no list permission at all, or it is scoped to a different name prefix. Both look identical from outside. Check the key\'s capabilities (Backblaze: listFiles) and its name-prefix restriction. If you know the permitted prefix, re-run this with that prefix — a success narrows it immediately.',
  prefix_restricted:
    'The key is restricted to a name prefix, and the prefix being listed is outside it. Either list within the permitted prefix, or issue a key that covers the whole bucket.',
  endpoint_unreachable: 'The endpoint host did not resolve or refused the connection. Check the URL.',
  unknown: 'Unrecognised error — see the steps below for the raw code and message.',
};

export async function diagnose(config: StorageProbeConfig): Promise<ProbeResult> {
  const steps: ProbeResult['steps'] = [];
  const finish = (verdict: Verdict): ProbeResult => ({
    label: config.label,
    provider: config.provider,
    verdict,
    advice: ADVICE[verdict],
    steps,
  });

  if (!config.accessKeyId || !config.secretAccessKey) {
    steps.push({ probe: 'credentials', ok: false, message: 'access key or secret is empty' });
    return finish('credentials_missing');
  }
  steps.push({ probe: 'credentials', ok: true, message: `keyId length ${config.accessKeyId.length}` });

  const client = buildClient(config);

  // Probe 1: list with the prefix the real job uses. This is the operation that
  // is actually failing, so try it first and take a success as the answer.
  try {
    await client.send(
      new ListObjectsV2Command({ Bucket: config.bucket, Prefix: config.prefix, MaxKeys: 1 }),
    );
    steps.push({ probe: 'listObjects', ok: true });
    return finish('ok');
  } catch (err) {
    const { code, status, message } = errCode(err);
    steps.push({ probe: 'listObjects', ok: false, code, httpStatus: status, message });

    const immediate = classify(code, status, 'listObjects', message);
    if (immediate && immediate !== 'no_list_permission') return finish(immediate);
  }

  // Probe 2: can we list the bucket root at all? If the prefixed list failed but
  // the root succeeds, or vice versa, the key is prefix-scoped.
  if (config.prefix) {
    try {
      await client.send(new ListObjectsV2Command({ Bucket: config.bucket, MaxKeys: 1 }));
      steps.push({ probe: 'listObjects(no prefix)', ok: true });
      // Root listable but the requested prefix denied => genuinely prefix-scoped.
      return finish('prefix_restricted');
    } catch (err) {
      const { code, status, message } = errCode(err);
      steps.push({ probe: 'listObjects(no prefix)', ok: false, code, httpStatus: status, message });
    }
  }

  // Probe 3: does the bucket exist and do the credentials work at all?
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    steps.push({ probe: 'headBucket', ok: true });
    // Bucket reachable, credentials fine, listing denied => permission.
    // If a prefix was requested and the ROOT list was denied too, this is
    // genuinely ambiguous between "no list permission at all" and "scoped to a
    // different prefix" — MinIO denies both for a prefix-conditioned policy, and
    // so do Backblaze and Tigris. Say so rather than picking one.
    return finish(config.prefix ? 'no_list_permission_or_prefix_restricted' : 'no_list_permission');
  } catch (err) {
    const { code, status, message } = errCode(err);
    steps.push({ probe: 'headBucket', ok: false, code, httpStatus: status, message });
    let verdict = classify(code, status, 'headBucket', message);
    // Same ambiguity as the success path: if a prefix was requested and BOTH the
    // prefixed and root listings were denied, "no list permission" and "scoped
    // to a different prefix" are indistinguishable from outside. Do not pick.
    if (verdict === 'no_list_permission' && config.prefix) {
      verdict = 'no_list_permission_or_prefix_restricted';
    }
    if (verdict) return finish(verdict);
  }

  // Probe 4: are the credentials valid for anything? ListBuckets is denied for
  // most scoped keys, so a denial here is not itself a fault — but
  // InvalidAccessKeyId here is decisive.
  try {
    await client.send(new ListBucketsCommand({}));
    steps.push({ probe: 'listBuckets', ok: true });
  } catch (err) {
    const { code, status, message } = errCode(err);
    steps.push({ probe: 'listBuckets', ok: false, code, httpStatus: status, message });
    if (code === 'InvalidAccessKeyId') return finish('credentials_rejected');
    if (code === 'SignatureDoesNotMatch') return finish('signature_mismatch');
  }

  // Probe 5 (opt-in): a write tells us the key works for objects even if not for
  // listing — which is exactly the read-only-object-key shape.
  if (config.probeWrite) {
    const key = `${config.prefix ?? ''}.storage-doctor-probe`;
    try {
      await client.send(
        new PutObjectCommand({ Bucket: config.bucket, Key: key, Body: new Uint8Array([1]) }),
      );
      steps.push({ probe: 'putObject', ok: true });
      try {
        await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
        steps.push({ probe: 'deleteObject(cleanup)', ok: true });
      } catch (err) {
        const { code, message } = errCode(err);
        steps.push({ probe: 'deleteObject(cleanup)', ok: false, code, message });
      }
      return finish('no_list_permission');
    } catch (err) {
      const { code, status, message } = errCode(err);
      steps.push({ probe: 'putObject', ok: false, code, httpStatus: status, message });
    }
  }

  return finish('unknown');
}


/**
 * Read provider configuration from the environment.
 *
 * Reads the names THIS PROJECT actually uses — `TIGRIS_AWS_ACCESS_KEY_ID`,
 * `TIGRIS_BUCKET_NAME` and friends, as seen in src/utils/storageClient.ts — and
 * falls back to the shorter `TIGRIS_ACCESS_KEY_ID` / `TIGRIS_BUCKET` spellings.
 *
 * Getting this wrong is not harmless: a diagnostic that reads the wrong variable
 * names reports "not configured" against a perfectly configured environment, and
 * sends you hunting for a problem that is not there.
 */
export function configFromEnv(
  provider: 'tigris' | 'backblaze',
  options: { prefix?: string; probeWrite?: boolean } = {},
  env: NodeJS.ProcessEnv = process.env,
): StorageProbeConfig | null {
  const P = provider.toUpperCase();
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = env[name];
      if (value && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };

  const accessKeyId = pick(`${P}_AWS_ACCESS_KEY_ID`, `${P}_ACCESS_KEY_ID`);
  const secretAccessKey = pick(`${P}_AWS_SECRET_ACCESS_KEY`, `${P}_SECRET_ACCESS_KEY`);
  const bucket = pick(`${P}_BUCKET_NAME`, `${P}_BUCKET`);
  const region = pick(`${P}_REGION`);
  const endpoint =
    pick(`${P}_ENDPOINT`) ??
    (provider === 'tigris'
      ? 'https://fly.storage.tigris.dev'
      : `https://s3.${region ?? 'us-west-004'}.backblazeb2.com`);

  if (!accessKeyId || !secretAccessKey || !bucket) return null;

  return {
    provider,
    label: provider,
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    region: region ?? (provider === 'tigris' ? 'auto' : 'us-west-004'),
    // Mirror the real clients: Tigris virtual-hosted, Backblaze path-style.
    forcePathStyle: provider === 'backblaze',
    ...(options.prefix ? { prefix: options.prefix } : {}),
    probeWrite: options.probeWrite ?? false,
  };
}

/** Which env var names were actually found, for reporting. Values never included. */
export function envNamesFor(provider: 'tigris' | 'backblaze', env: NodeJS.ProcessEnv = process.env): {
  found: string[];
  missing: string[];
} {
  const P = provider.toUpperCase();
  const groups: Array<[string, string[]]> = [
    ['access key', [`${P}_AWS_ACCESS_KEY_ID`, `${P}_ACCESS_KEY_ID`]],
    ['secret', [`${P}_AWS_SECRET_ACCESS_KEY`, `${P}_SECRET_ACCESS_KEY`]],
    ['bucket', [`${P}_BUCKET_NAME`, `${P}_BUCKET`]],
  ];
  const found: string[] = [];
  const missing: string[] = [];
  for (const [, names] of groups) {
    const hit = names.find((n) => env[n] && env[n]!.trim().length > 0);
    if (hit) found.push(hit);
    else missing.push(names.join(" or "));
  }
  return { found, missing };
}
