/**
 * Instagram and Facebook, both via the Meta Graph API.
 *
 * THESE TWO DO NOT TAKE BYTES. Meta's servers fetch the media themselves from a
 * URL you hand them, so the caller must supply a publicly reachable link rather
 * than a buffer. The renders live in a private bucket, so that link is a
 * short-lived presigned URL. It is the only lane in this project that works
 * that way, and getting it wrong reads as "the image failed to download" with
 * no indication of why.
 *
 * ⚠️ INSTAGRAM ACCEPTS JPEG ONLY. Not PNG, not WebP — "JPEG is the only image
 * format supported", per Meta's own documentation. The pipeline already writes
 * a `-web.jpg` derivative for Bluesky's size limit; Instagram needs that same
 * derivative for a completely different reason. A PNG master sent here fails
 * at Meta's end, after the container call has already succeeded.
 *
 * Instagram is a TWO-STEP publish: create a container, then publish it. The
 * container can still be processing when the first call returns, which is why
 * publishing is retried against its status rather than fired once and hoped for.
 */

import { assertPublishAllowed, type AssetRef } from "./contentRouting.js";

export const GRAPH_API = "https://graph.facebook.com";
export const GRAPH_VERSION = "v21.0";

/** Instagram: "JPEG is the only image format supported." */
export const INSTAGRAM_IMAGE_TYPES: readonly string[] = Object.freeze(["image/jpeg"]);

/** Instagram caption limit. */
export const INSTAGRAM_MAX_CAPTION = 2200;
/** Facebook caption limit, conservatively below the documented maximum. */
export const FACEBOOK_MAX_CAPTION = 2000;

export type Fetcher = typeof fetch;

export interface MetaOptions {
  fetch?: Fetcher;
  api?: string;
  version?: string;
  /** Injected in tests so container polling does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface InstagramCredentials {
  /** The Instagram professional account id (not the Facebook page id). */
  igUserId: string;
  accessToken: string;
  /**
   * The linked Facebook Page id, when known.
   *
   * Instagram publishing has the same requirement Facebook does: it wants a
   * PAGE access token, and a Business Manager system user token is a user
   * token. Given this, the page token can be derived; without it we send what
   * we were given, which is correct when that is already a page token.
   */
  pageId?: string;
}

export interface FacebookCredentials {
  pageId: string;
  /** A PAGE access token, not a user token. */
  pageAccessToken: string;
}

function requireVars(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = (env[name] ?? "").trim();
    if (value === "") missing.push(name);
    else found[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `Missing environment variable(s): ${missing.join(", ")}. ` +
        `Trigger.dev variables are per-environment — set in Development is not set in Production.`,
    );
  }
  return found;
}

export function instagramCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): InstagramCredentials {
  const vars = requireVars(env, ["INSTAGRAM_USER_ID", "INSTAGRAM_ACCESS_TOKEN"]);
  // A numeric-looking id is expected. A Facebook PAGE id pasted here instead of
  // the Instagram account id is the classic mix-up, and it fails as a confusing
  // permissions error rather than "wrong id", so say so up front.
  if (!/^\d+$/.test(vars.INSTAGRAM_USER_ID!)) {
    throw new Error(
      `INSTAGRAM_USER_ID should be the numeric Instagram professional account id. ` +
        `Got "${vars.INSTAGRAM_USER_ID}". Note this is NOT your @handle and NOT the ` +
        `Facebook page id — mixing those up surfaces as a permissions error, not a bad id.`,
    );
  }
  // Optional, and only used to derive a page token. Instagram still publishes
  // without it when the supplied token is already a page token.
  const pageId = (env.FACEBOOK_PAGE_ID ?? "").trim();

  return {
    igUserId: vars.INSTAGRAM_USER_ID!,
    accessToken: vars.INSTAGRAM_ACCESS_TOKEN!,
    ...(/^\d+$/.test(pageId) ? { pageId } : {}),
  };
}

export function facebookCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): FacebookCredentials {
  const vars = requireVars(env, ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"]);
  if (!/^\d+$/.test(vars.FACEBOOK_PAGE_ID!)) {
    throw new Error(
      `FACEBOOK_PAGE_ID should be the numeric page id. Got "${vars.FACEBOOK_PAGE_ID}".`,
    );
  }
  return {
    pageId: vars.FACEBOOK_PAGE_ID!,
    pageAccessToken: vars.FACEBOOK_PAGE_ACCESS_TOKEN!,
  };
}

/**
 * Turn a Graph API failure into something actionable.
 *
 * Never includes the access token. Meta's own error text is often generic
 * ("Unsupported post request"), so the common causes are spelled out instead of
 * passed through — each of these cost somebody an afternoon at some point.
 */
export function describeMetaError(
  method: string,
  status: number,
  body: { error?: { message?: string; code?: number; error_subcode?: number; type?: string } },
): string {
  const error = body.error ?? {};
  const base =
    `Meta ${method} failed: HTTP ${status}` +
    (error.message ? ` — ${error.message}` : "") +
    (error.code !== undefined ? ` (code ${error.code}` : "") +
    (error.error_subcode !== undefined ? `/${error.error_subcode})` : error.code !== undefined ? ")" : "");

  if (error.code === 190) {
    // Code 190 covers several unrelated faults and they need different fixes.
    // Saying "invalid or expired" for all of them sent the client looking at
    // token expiry when Meta had actually said it could not PARSE the value —
    // a wrong-value problem, not an aged-out one.
    if (/cannot parse|malformed/i.test(error.message ?? "")) {
      return `${base}. Meta could not PARSE the value as a token at all — this is not expiry, ` +
        `an expired token says so explicitly. Either the value is truncated, or it is not a ` +
        `token: the App ID and App Secret sit beside the token on the Meta dashboard and are ` +
        `the usual mix-up. A real token starts with "EAA" and is 150+ characters.`;
    }
    if (/expired|session has expired/i.test(error.message ?? "")) {
      return `${base}. The token has EXPIRED. Page tokens derived from a short-lived user ` +
        `token last about an hour — exchange it for a long-lived one rather than pasting a ` +
        `fresh short-lived token each time.`;
    }
    return `${base}. The token was rejected (code 190). Meta's own wording above is the useful ` +
      `part: "cannot parse" means a wrong or truncated VALUE, "expired" means expiry, and ` +
      `"session invalidated" means a password change or a revoked permission.`;
  }
  if (/publish_actions/i.test(error.message ?? "")) {
    // Meta's most misleading error, and it cost an evening. publish_actions was
    // removed in 2018 and nothing here has ever requested it — the real meaning
    // is "you are publishing with a USER token where a PAGE token is required".
    // A Business Manager system user token is a user token no matter how many
    // page permissions it carries.
    return `${base}. IGNORE the words "publish_actions" — that permission was removed in 2018 ` +
      `and nothing here asks for it. Meta says this when you publish with a USER token where ` +
      `a PAGE token is required. A Business Manager system user token IS a user token, however ` +
      `many page permissions it holds. Derive the page token first: ` +
      `GET /{page-id}?fields=access_token using the system user token, then publish with what ` +
      `that returns.`;
  }
  if (error.code === 200 || error.code === 10) {
    // Ordering here matters more than it looks. This used to lead with "requires
    // app review and business verification", which is true for PRODUCTION and
    // sends someone down a multi-week path — when the actual cause is usually a
    // token generated without the scope ticked, fixable in five minutes.
    // Leading with the expensive fix is its own kind of wrong answer.
    return `${base}. This is a PERMISSIONS problem, not a bad request — and the usual cause ` +
      `is the TOKEN rather than the app: a token generated without the publishing scope ` +
      `produces this even when everything else is correct. Regenerate it in Graph API ` +
      `Explorer with the scope ticked. Instagram publishing needs instagram_content_publish ` +
      `(for an account linked through a Facebook Page) or instagram_business_content_publish ` +
      `(for the newer Instagram Login flow); Facebook page posting needs pages_manage_posts. ` +
      `While the app is in DEVELOPMENT mode this works for accounts that hold a role on the ` +
      `app, with no review needed. App review and business verification are required only to ` +
      `serve accounts that do not hold a role, or once the app goes Live.`;
  }
  if (error.code === 100 && error.error_subcode === 33) {
    // Observed live: the client had a 16-digit id starting 1348 in
    // INSTAGRAM_USER_ID, which was an App or Page id. Meta's own wording lists
    // three possible causes and commits to none, so it reads as "something is
    // broken" rather than "that is the wrong number".
    return `${base}. This almost always means the ID is the WRONG KIND of object — Meta ` +
      `cannot tell a wrong id from one you lack permission to see, so it lists both. For ` +
      `Instagram this must be the Instagram professional account id, which is a different ` +
      `number from your App ID and from your Facebook Page ID. Find it with: ` +
      `GET /me/accounts?fields=name,instagram_business_account — the id INSIDE ` +
      `instagram_business_account is the one. If that field is absent, the Instagram account ` +
      `is not linked to the Page yet.`;
  }
  if (error.code === 4 || error.code === 17 || error.code === 32) {
    return `${base}. Rate limited by Meta. The scheduler paces posts, so this suggests ` +
      `something is retrying in a loop.`;
  }
  if (error.code === 9004 || /media.*(download|fetch|retriev)/i.test(error.message ?? "")) {
    return `${base}. Meta could not DOWNLOAD the media from the URL we gave it. The link is ` +
      `presigned and short-lived — if it expired before Meta fetched it, raise the expiry. ` +
      `Also check the file is genuinely reachable and is a JPEG.`;
  }
  return base;
}

async function graphPost(
  fetcher: Fetcher,
  url: string,
  params: Record<string, string>,
  method: string,
): Promise<Record<string, unknown>> {
  const form = new URLSearchParams(params);
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  let payload: Record<string, unknown> = {};
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    /* fall through to a status-only message */
  }

  if (!response.ok || payload.error) {
    throw new Error(describeMetaError(method, response.status, payload as never));
  }
  return payload;
}

export function validateMetaCaption(caption: string, max: number, platform: string): string[] {
  if (caption.length > max) {
    return [`caption is ${caption.length} characters, over ${platform}'s ${max} limit`];
  }
  return [];
}

export interface MetaPostResult {
  /** The published post or photo id. */
  id: string;
  /** Browsable link where one can be derived; empty otherwise. */
  url: string;
}

export interface InstagramPostRequest {
  /** PUBLICLY REACHABLE url — Meta fetches this itself. Must be a JPEG. */
  imageUrl: string;
  caption: string;
  asset?: AssetRef;
  /** Set when the caller knows the source content type, for the JPEG check. */
  mimeType?: string;
}

/**
 * Publish a single image to Instagram.
 *
 * Two steps, and the gap between them is real: a container can be PUBLISHED,
 * IN_PROGRESS, ERROR or EXPIRED. Publishing an IN_PROGRESS container fails, so
 * the status is polled briefly rather than assumed ready.
 */
export async function publishToInstagram(
  credentials: InstagramCredentials,
  request: InstagramPostRequest,
  options: MetaOptions = {},
): Promise<MetaPostResult> {
  const fetcher = options.fetch ?? fetch;
  const api = options.api ?? GRAPH_API;
  const version = options.version ?? GRAPH_VERSION;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  if (request.asset) assertPublishAllowed("instagram", request.asset);

  // Caught here rather than by Meta, because Meta's failure for a PNG arrives
  // AFTER the container call has already returned an id, which reads as a
  // publish bug rather than a format problem.
  if (request.mimeType && !INSTAGRAM_IMAGE_TYPES.includes(request.mimeType)) {
    throw new Error(
      `Refusing to publish to Instagram: JPEG is the only image format Instagram accepts, ` +
        `and this is ${request.mimeType}. Use the -web.jpg derivative rather than the master.`,
    );
  }

  const problems = validateMetaCaption(request.caption, INSTAGRAM_MAX_CAPTION, "Instagram");
  if (problems.length > 0) {
    throw new Error(`Refusing to publish to Instagram: ${problems.join("; ")}`);
  }

  // Same trap as Facebook: publishing wants a PAGE token, and a system user
  // token is a user token. Derive one when the linked page id is known; keep
  // the supplied token otherwise, since it may already be a page token.
  const token = credentials.pageId
    ? ((await derivePageAccessToken(
        fetcher,
        api,
        version,
        credentials.pageId,
        credentials.accessToken,
      )) ?? credentials.accessToken)
    : credentials.accessToken;

  const container = await graphPost(
    fetcher,
    `${api}/${version}/${credentials.igUserId}/media`,
    {
      image_url: request.imageUrl,
      caption: request.caption,
      access_token: token,
    },
    "create media container",
  );

  const creationId = String(container.id ?? "");
  if (creationId === "") {
    throw new Error("Instagram container creation returned no id.");
  }

  // Poll briefly. Meta fetches the image during this window, so the wait is
  // doing real work rather than being superstition.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const statusResponse = await fetcher(
      `${api}/${version}/${creationId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`,
    );
    const status = (await statusResponse.json().catch(() => ({}))) as {
      status_code?: string;
      status?: string;
      error?: unknown;
    };

    if (status.status_code === "FINISHED" || status.status_code === undefined) break;
    if (status.status_code === "ERROR" || status.status_code === "EXPIRED") {
      throw new Error(
        `Instagram container ${creationId} is ${status.status_code}: ${status.status ?? "no detail"}. ` +
          `This almost always means Meta could not download or could not accept the image.`,
      );
    }
    await sleep(2000);
  }

  const published = await graphPost(
    fetcher,
    `${api}/${version}/${credentials.igUserId}/media_publish`,
    { creation_id: creationId, access_token: token },
    "publish media",
  );

  const id = String(published.id ?? "");
  if (id === "") throw new Error("Instagram media_publish returned no id.");
  return { id, url: `https://www.instagram.com/p/${id}` };
}

export interface FacebookPostRequest {
  /** PUBLICLY REACHABLE url — Meta fetches this itself. */
  imageUrl: string;
  caption: string;
  asset?: AssetRef;
}

/** Publish a single photo to a Facebook Page. One step, unlike Instagram. */
/**
 * Exchange whatever token we hold for the PAGE's own access token.
 *
 * Posting to /{page-id}/photos must be done AS THE PAGE. A page token does
 * that; a user token does not — and a Business Manager system user token is a
 * user token, however many page permissions it carries.
 *
 * Meta's refusal for this is spectacularly unhelpful:
 *
 *   (#200) The permission(s) publish_actions are not available.
 *          It has been deprecated.
 *
 * publish_actions was removed in 2018 and nothing here ever asked for it. The
 * real meaning is "you are trying to publish with a user token". Nothing in
 * that message says so, which is how it cost an evening.
 *
 * GET /{page-id}?fields=access_token returns the page token, given a user token
 * with pages_show_list that can see the page. Returns null when the field is
 * absent — which is the normal answer if the caller already handed us a PAGE
 * token, since a page token asking about its own page gets no access_token
 * back. In that case the original token is already the right one.
 */
export async function derivePageAccessToken(
  fetcher: Fetcher,
  api: string,
  version: string,
  pageId: string,
  token: string,
): Promise<string | null> {
  const response = await fetcher(
    `${api}/${version}/${encodeURIComponent(pageId)}?fields=access_token&access_token=${encodeURIComponent(token)}`,
  );
  if (!response.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { access_token?: string };
  const derived = (body.access_token ?? "").trim();
  return derived === "" ? null : derived;
}

export async function publishToFacebook(
  credentials: FacebookCredentials,
  request: FacebookPostRequest,
  options: MetaOptions = {},
): Promise<MetaPostResult> {
  const fetcher = options.fetch ?? fetch;
  const api = options.api ?? GRAPH_API;
  const version = options.version ?? GRAPH_VERSION;

  if (request.asset) assertPublishAllowed("facebook", request.asset);

  const problems = validateMetaCaption(request.caption, FACEBOOK_MAX_CAPTION, "Facebook");
  if (problems.length > 0) {
    throw new Error(`Refusing to publish to Facebook: ${problems.join("; ")}`);
  }

  // Use the page's own token when we can get one. Falling back to the supplied
  // token covers the case where it IS already a page token.
  const pageToken =
    (await derivePageAccessToken(
      fetcher,
      api,
      version,
      credentials.pageId,
      credentials.pageAccessToken,
    )) ?? credentials.pageAccessToken;

  const result = await graphPost(
    fetcher,
    `${api}/${version}/${credentials.pageId}/photos`,
    {
      url: request.imageUrl,
      caption: request.caption,
      published: "true",
      access_token: pageToken,
    },
    "publish page photo",
  );

  // The endpoint returns both a photo id and a post id; the post id is the one
  // that corresponds to something a human can open.
  const postId = String(result.post_id ?? result.id ?? "");
  if (postId === "") throw new Error("Facebook photo post returned no id.");
  return { id: postId, url: `https://www.facebook.com/${postId}` };
}
