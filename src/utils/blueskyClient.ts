/**
 * Bluesky (AT Protocol) publishing.
 *
 * Bluesky goes first among the six lanes for one reason: it needs no app review,
 * so the entire pipeline — render, route, schedule, pace, publish — can be
 * proven end to end against a real platform while Instagram and TikTok are
 * still sitting in their approval queues.
 *
 * Wire format taken from the AT Protocol documentation rather than from memory,
 * because the last adapter written on this project against an assumed format
 * had 27 passing tests and still failed on the first real call. The three calls:
 *
 *   POST /xrpc/com.atproto.server.createSession   {identifier, password}
 *                                                  -> {accessJwt, refreshJwt, did}
 *   POST /xrpc/com.atproto.repo.uploadBlob        raw bytes, Content-Type: <mime>
 *                                                  -> {$type:"blob", ref:{$link}, mimeType, size}
 *   POST /xrpc/com.atproto.repo.createRecord      {repo, collection, record}
 *
 * The limits below are the protocol's, not guesses, and they are enforced
 * BEFORE the request goes out. Finding out that a render is too large by
 * uploading it and reading the error wastes the upload and produces a message
 * that does not name the file.
 */

import { assertPublishAllowed, type AssetRef } from "./contentRouting.js";

export const BLUESKY_SERVICE = "https://bsky.social";

/**
 * A blob may not exceed 1,000,000 bytes. Note: one MILLION bytes, not one
 * mebibyte — 1048576 would be rejected. High-fidelity renders will exceed this
 * routinely, so the pipeline needs a downscaled derivative for this lane rather
 * than the master file.
 */
export const MAX_BLOB_BYTES = 1_000_000;

/** app.bsky.embed.images permits at most four. */
export const MAX_IMAGES_PER_POST = 4;

/** Post text limit, in graphemes. */
export const MAX_POST_GRAPHEMES = 300;

export const SUPPORTED_IMAGE_TYPES: readonly string[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export interface BlueskyCredentials {
  /** Handle or DID, e.g. "ava.bsky.social". */
  identifier: string;
  /**
   * An APP PASSWORD, never the account password. App passwords are revocable
   * individually and cannot change the account's own password, so a leak is
   * contained and fixed by deleting one entry.
   */
  appPassword: string;
  service?: string;
}

export interface BlueskySession {
  accessJwt: string;
  refreshJwt: string;
  did: string;
  handle?: string;
}

export interface BlobRef {
  $type: "blob";
  ref: { $link: string };
  mimeType: string;
  size: number;
}

export interface ImageAttachment {
  bytes: Uint8Array;
  mimeType: string;
  /**
   * Alt text. Required by the lexicon — an empty string is permitted but a
   * real description is not optional politeness, it is what makes the post
   * readable to screen readers and it is a ranking signal besides.
   */
  alt: string;
}

export type Fetcher = typeof fetch;

export interface BlueskyOptions {
  fetch?: Fetcher;
  service?: string;
  now?: () => Date;
}

/**
 * Read credentials from the environment.
 *
 * Names match what the client set in the Trigger.dev variables panel. The
 * password never passes through chat, a repo or a log — this function is the
 * only place it is read, and nothing here ever prints it.
 */
export function blueskyCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BlueskyCredentials {
  const identifier = (env.BLUESKY_HANDLE ?? "").trim();
  const appPassword = (env.BLUESKY_APP_PASSWORD ?? "").trim();

  const missing: string[] = [];
  if (identifier === "") missing.push("BLUESKY_HANDLE");
  if (appPassword === "") missing.push("BLUESKY_APP_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `Cannot publish to Bluesky: missing environment variable(s): ${missing.join(", ")}. ` +
        `Trigger.dev variables are per-environment — set in Development is not set in Production.`,
    );
  }

  // An account password would work here, which is exactly why this check
  // exists: it would work, and nobody would notice until it leaked. App
  // passwords are formatted xxxx-xxxx-xxxx-xxxx.
  if (!/^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/i.test(appPassword)) {
    throw new Error(
      `BLUESKY_APP_PASSWORD does not look like an app password (expected the form ` +
        `xxxx-xxxx-xxxx-xxxx). If you have put your real account password there, replace it: ` +
        `Settings > App Passwords. An app password is revocable on its own and cannot change ` +
        `the account password.`,
    );
  }

  return { identifier, appPassword, ...(env.BLUESKY_SERVICE ? { service: env.BLUESKY_SERVICE.trim() } : {}) };
}

async function xrpc(
  fetcher: Fetcher,
  service: string,
  method: string,
  init: RequestInit,
): Promise<Response> {
  return fetcher(`${service}/xrpc/${method}`, init);
}

/** Turn a non-2xx XRPC response into an error that names the method and reason. */
async function xrpcError(method: string, response: Response): Promise<Error> {
  let detail = "";
  try {
    const body = (await response.json()) as { error?: string; message?: string };
    detail = [body.error, body.message].filter(Boolean).join(": ");
  } catch {
    detail = (await response.text().catch(() => "")).slice(0, 300);
  }
  return new Error(
    `Bluesky ${method} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
  );
}

export async function createSession(
  credentials: BlueskyCredentials,
  options: BlueskyOptions = {},
): Promise<BlueskySession> {
  const fetcher = options.fetch ?? fetch;
  const service = options.service ?? credentials.service ?? BLUESKY_SERVICE;

  const response = await xrpc(fetcher, service, "com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: credentials.identifier,
      password: credentials.appPassword,
    }),
  });

  if (!response.ok) throw await xrpcError("createSession", response);

  const session = (await response.json()) as BlueskySession;
  if (!session.accessJwt || !session.did) {
    throw new Error("Bluesky createSession returned no accessJwt or did.");
  }
  return session;
}

/**
 * Validate an image before it costs an upload.
 *
 * Returns the reasons rather than throwing so a caller can report all of them
 * at once; a caller that fixes one problem, re-runs, and discovers the next is
 * how a five-minute job becomes an afternoon.
 */
export function validateImage(image: ImageAttachment): string[] {
  const problems: string[] = [];
  if (!SUPPORTED_IMAGE_TYPES.includes(image.mimeType)) {
    problems.push(
      `mimeType "${image.mimeType}" is not supported by Bluesky (accepts ${SUPPORTED_IMAGE_TYPES.join(", ")})`,
    );
  }
  if (image.bytes.byteLength > MAX_BLOB_BYTES) {
    problems.push(
      `image is ${image.bytes.byteLength} bytes, over the ${MAX_BLOB_BYTES}-byte limit. ` +
        `Note that is one MILLION bytes, not one mebibyte. Publish a downscaled derivative ` +
        `to this lane rather than the master render.`,
    );
  }
  if (image.bytes.byteLength === 0) {
    problems.push("image is zero bytes");
  }
  if (typeof image.alt !== "string") {
    problems.push("alt text is required by the lexicon (an empty string is allowed)");
  }
  return problems;
}

/** Count graphemes, so an emoji is one character rather than two or four. */
export function graphemeLength(text: string): number {
  // Intl.Segmenter is in Node 18+. Falling back to [...text] would count an
  // emoji with a skin-tone modifier as several characters and reject a post
  // that Bluesky would have accepted.
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}

export function validatePostText(text: string): string[] {
  const length = graphemeLength(text);
  if (length > MAX_POST_GRAPHEMES) {
    return [`post text is ${length} graphemes, over the ${MAX_POST_GRAPHEMES} limit`];
  }
  return [];
}

export async function uploadBlob(
  session: BlueskySession,
  image: ImageAttachment,
  options: BlueskyOptions = {},
): Promise<BlobRef> {
  const fetcher = options.fetch ?? fetch;
  const service = options.service ?? BLUESKY_SERVICE;

  const problems = validateImage(image);
  if (problems.length > 0) {
    throw new Error(`Refusing to upload to Bluesky: ${problems.join("; ")}`);
  }

  const response = await xrpc(fetcher, service, "com.atproto.repo.uploadBlob", {
    method: "POST",
    headers: {
      "Content-Type": image.mimeType,
      Authorization: `Bearer ${session.accessJwt}`,
    },
    // A bare Uint8Array is not assignable to BodyInit under the current DOM lib
    // types (TS2322) — caught by typechecking in the client's own tsconfig
    // rather than here, which is the only reason it did not ship. A Blob is
    // unambiguous, and the explicit Content-Type header above still wins.
    // Buffer.from rather than the Uint8Array directly: a bare Uint8Array is
    // typed as Uint8Array<ArrayBufferLike>, which might be backed by a
    // SharedArrayBuffer and so is not assignable to BlobPart/BodyInit (TS2322).
    // Buffer is always ArrayBuffer-backed. Found by typechecking in the
    // client's own tsconfig, not here — twice in a row on this one line.
    body: new Blob([Buffer.from(image.bytes)], { type: image.mimeType }),
  });

  if (!response.ok) throw await xrpcError("uploadBlob", response);

  const body = (await response.json()) as { blob?: BlobRef };
  if (!body.blob?.ref?.$link) {
    throw new Error("Bluesky uploadBlob returned no blob reference.");
  }
  return body.blob;
}

export interface PostResult {
  uri: string;
  cid: string;
  /** Derived from the AT URI, so a human can open the post from a trace. */
  url: string;
}

export interface PostRequest {
  text: string;
  images?: ImageAttachment[];
  /** The asset this post is publishing, for the last-moment safety check. */
  asset?: AssetRef;
  /** ISO language codes, e.g. ["en"]. Improves reach and accessibility. */
  langs?: string[];
}

/**
 * Publish a post.
 *
 * Calls assertPublishAllowed first when an asset is supplied. That check has
 * already run at routing time; running it again here is deliberate duplication,
 * because it is the last point at which a routing bug can still be stopped, and
 * the thing it stops is unrecoverable.
 */
export async function publishPost(
  session: BlueskySession,
  request: PostRequest,
  options: BlueskyOptions = {},
): Promise<PostResult> {
  const fetcher = options.fetch ?? fetch;
  const service = options.service ?? BLUESKY_SERVICE;
  const now = options.now ?? (() => new Date());

  if (request.asset) {
    assertPublishAllowed("bluesky", request.asset);
  }

  const textProblems = validatePostText(request.text);
  if (textProblems.length > 0) {
    throw new Error(`Refusing to publish to Bluesky: ${textProblems.join("; ")}`);
  }

  const images = request.images ?? [];
  if (images.length > MAX_IMAGES_PER_POST) {
    throw new Error(
      `Refusing to publish to Bluesky: ${images.length} images, maximum is ${MAX_IMAGES_PER_POST}.`,
    );
  }

  const blobs: BlobRef[] = [];
  for (const image of images) {
    blobs.push(await uploadBlob(session, image, { ...options, service }));
  }

  const record: Record<string, unknown> = {
    $type: "app.bsky.feed.post",
    text: request.text,
    // Must be ISO 8601 with a Z suffix. toISOString() produces exactly that.
    createdAt: now().toISOString(),
    ...(request.langs ? { langs: request.langs } : {}),
  };

  if (blobs.length > 0) {
    record.embed = {
      $type: "app.bsky.embed.images",
      images: blobs.map((blob, index) => ({
        // alt is REQUIRED by the lexicon. An absent alt is a validation error
        // from the server, not a silently-omitted field.
        alt: images[index]!.alt ?? "",
        image: blob,
      })),
    };
  }

  const response = await xrpc(fetcher, service, "com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessJwt}`,
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record,
    }),
  });

  if (!response.ok) throw await xrpcError("createRecord", response);

  const body = (await response.json()) as { uri?: string; cid?: string };
  if (!body.uri || !body.cid) {
    throw new Error("Bluesky createRecord returned no uri or cid.");
  }

  return { uri: body.uri, cid: body.cid, url: postUrlFromUri(body.uri, session.handle) };
}

/**
 * Turn an AT URI into a browsable link.
 *
 * at://did:plc:abc/app.bsky.feed.post/3kabc -> https://bsky.app/profile/<handle or did>/post/3kabc
 * Returns the AT URI unchanged if it does not have the expected shape, rather
 * than producing a confidently wrong link.
 */
export function postUrlFromUri(uri: string, handle?: string): string {
  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/.exec(uri);
  if (!match) return uri;
  const [, did, rkey] = match;
  return `https://bsky.app/profile/${handle ?? did}/post/${rkey}`;
}
