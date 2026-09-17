/**
 * Reddit publishing, via the official OAuth API.
 *
 * Reddit replaces Telegram as the sixth lane at the client's request, and for
 * this business it is the better fit: a subreddit already has the audience,
 * where a Telegram channel only reaches people who found you some other way.
 *
 * It is also the most booby-trapped adapter in this project, for three reasons
 * that are all confirmed against the live API rather than taken from memory:
 *
 * 1. A FAILED SUBMISSION RETURNS HTTP 200. With `api_type=json` — which is the
 *    only sane way to call it — Reddit reports "that subreddit doesn't exist",
 *    "you must select a flair", "you are doing that too much" and so on inside
 *    `json.errors` of a 200 response. Any adapter that trusts `response.ok`
 *    reports every one of those as a successful post. That is the single most
 *    important thing in this file.
 *
 * 2. THE USER-AGENT CAN BE CHECKED BEFORE THE CREDENTIALS. Probed against
 *    www.reddit.com/api/v1/access_token with deliberately bogus credentials,
 *    three runs each, entirely consistent:
 *
 *      "nodejs:com.x:v1 (by /u/x)"        -> 401  credentials read and refused
 *      "curl/8.0"                         -> 401
 *      "Mozilla/5.0 (Macintosh...) Chrome/120..." -> 401
 *      "Mozilla/5.0"          (bare)      -> 403  never reaches the credentials
 *      ""                     (absent)    -> 403
 *
 *    So it is the BARE, generic string that is hard-blocked, not browser-shaped
 *    agents in general — a full browser User-Agent is let through to the
 *    credential check. Both blocked cases fail as 403 FORBIDDEN, which reads as
 *    "my app lacks permission" and sends you to the app settings page for an
 *    hour. It is a header problem.
 *
 *    The guard below is deliberately WIDER than the verified block: it refuses
 *    browser-shaped agents generally. That part is advice rather than a
 *    measured limit — Reddit keys its rate limiting on this string, so an agent
 *    shared with every other lazy client shares that client's throttling.
 *
 * 3. REDDIT IS NOT ONE DESTINATION. It is N subreddits with N sets of rules,
 *    and "is explicit content allowed here" is a property of the SUBREDDIT, not
 *    of Reddit. The platform-level rail in contentRouting cannot express that,
 *    so this file adds a second gate: every subreddit must declare itself, and
 *    explicit material requires that subreddit to have opted in by name. The
 *    default is safe-only, because the failure here is an account ban and there
 *    is no undo.
 *
 * Wire format: token from www.reddit.com, everything else from
 * oauth.reddit.com. Mixing those up 403s.
 */

import { assertPublishAllowed, classifyFromKey, type AssetRef } from "./contentRouting.js";

/** Tokens come from here, and ONLY tokens. */
export const REDDIT_AUTH_API = "https://www.reddit.com";
/** Everything authenticated goes here. Calling www with a bearer token 403s. */
export const REDDIT_OAUTH_API = "https://oauth.reddit.com";

/** Post titles are capped at 300 characters. Over is a TOO_LONG error. */
export const MAX_TITLE_LENGTH = 300;

/**
 * Reddit's image ceiling for a direct upload. Renders are far below this, but
 * checking costs nothing and an over-size upload fails at S3 with an XML body
 * that says nothing useful.
 */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export const REDDIT_IMAGE_TYPES: readonly string[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
]);

export type Fetcher = typeof fetch;

export interface RedditCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
  /** Required by Reddit, and see the note at the top of this file. */
  userAgent: string;
}

export interface RedditOptions {
  fetch?: Fetcher;
  authApi?: string;
  oauthApi?: string;
}

/**
 * A subreddit and what it will actually accept.
 *
 * This exists because Reddit's rules are per-community. A post that is fine in
 * one sub is a ban in another, and the API will not tell you in advance — it
 * tells you afterwards, in a 200.
 */
export interface SubredditConfig {
  /** Without the "r/" prefix. */
  name: string;
  /**
   * Whether this subreddit permits explicit material. FALSE unless the client
   * has confirmed the specific sub by name. Defaulting this to true — or
   * inferring it from the sub's own NSFW flag — is how an account dies.
   */
  allowsExplicit: boolean;
  /**
   * Many subs REQUIRE a post flair and reject submissions without one, as a
   * SUBMIT_VALIDATION_FLAIR_REQUIRED error inside a 200 response.
   */
  flairId?: string;
  flairText?: string;
  /** Mark the post itself NSFW. Independent of whether the sub allows it. */
  markNsfw?: boolean;
}

/**
 * The subreddits this system is allowed to post to.
 *
 * ⚠️ THE CLIENT'S LIST GOES HERE. This is deliberately a table in code rather
 * than something the publish payload carries, because `allowsExplicit` is a
 * permission. If the payload could set it, anything able to trigger a task
 * could route explicit material into a SFW community by asking nicely — and
 * that failure is an account ban with no undo.
 *
 * A subreddit that is not in this table cannot be posted to at all.
 *
 * Seeded with Reddit's own sandbox subs so the lane can be proven end to end
 * before the real list exists. Both are safe-only, like everything here will be
 * until the client confirms specific subs by name.
 */
export const SUBREDDITS: Readonly<Record<string, SubredditConfig>> = Object.freeze({
  test: Object.freeze({ name: "test", allowsExplicit: false }),
  testingground4bots: Object.freeze({ name: "testingground4bots", allowsExplicit: false }),
}) as Readonly<Record<string, SubredditConfig>>;

/** Look a subreddit up, refusing anything not declared above. */
export function subredditConfig(name: string): SubredditConfig {
  const key = name.replace(/^\/?r\//, "").trim().toLowerCase();
  const found = SUBREDDITS[key];
  if (!found) {
    const known = Object.keys(SUBREDDITS);
    throw new Error(
      `r/${key} is not configured, so nothing will be posted to it. Known subreddits: ` +
        `${known.length > 0 ? known.join(", ") : "(none yet)"}. Each subreddit has to be added ` +
        `deliberately, with its own flair id and its own explicit-content decision.`,
    );
  }
  return found;
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
      `Cannot publish to Reddit: missing environment variable(s): ${missing.join(", ")}. ` +
        `Trigger.dev variables are per-environment — set in Development is not set in Production.`,
    );
  }
  return found;
}

/**
 * Build a User-Agent Reddit will accept.
 *
 * Reddit's documented form is platform:app-id:version (by /u/username). The
 * rate limiter is keyed on this, so a shared or generic value gets throttled
 * against everyone else using it.
 */
export function defaultUserAgent(username: string): string {
  return `nodejs:com.avaautomation.publisher:v1.0 (by /u/${username})`;
}

export function redditCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RedditCredentials {
  const vars = requireVars(env, [
    "REDDIT_CLIENT_ID",
    "REDDIT_CLIENT_SECRET",
    "REDDIT_USERNAME",
    "REDDIT_PASSWORD",
  ]);

  const username = vars.REDDIT_USERNAME!.replace(/^\/?u\//, "");
  const userAgent = (env.REDDIT_USER_AGENT ?? "").trim() || defaultUserAgent(username);

  // See point 2 in the file header. The bare string is VERIFIED to 403 before
  // the credentials are read, which reads as a permissions problem and is not
  // one. Called out separately from the general advice so the message does not
  // claim more than was measured.
  if (/^Mozilla\/[\d.]+$/i.test(userAgent)) {
    throw new Error(
      `REDDIT_USER_AGENT is the bare string "${userAgent}", which Reddit blocks outright: ` +
        `it returns 403 before it reads the credentials, so it surfaces as a permissions ` +
        `problem and is not one. Use the documented form: platform:app-id:version (by /u/username).`,
    );
  }
  if (/^Mozilla\//i.test(userAgent)) {
    throw new Error(
      `REDDIT_USER_AGENT must not impersonate a browser. A full browser agent does reach ` +
        `Reddit's credential check, so this one is about rate limiting rather than access: ` +
        `Reddit keys its limits on this string, and one shared with every other client using ` +
        `it shares their throttling. Use the documented form: ` +
        `platform:app-id:version (by /u/username).`,
    );
  }

  return {
    clientId: vars.REDDIT_CLIENT_ID!,
    clientSecret: vars.REDDIT_CLIENT_SECRET!,
    username,
    password: vars.REDDIT_PASSWORD!,
    userAgent,
  };
}

/**
 * Turn a Reddit failure into something that names the real cause.
 *
 * Never includes the password, the secret or the bearer token. Reddit's own
 * messages are terse and several of them are actively misleading about where
 * the problem is, so the common ones are spelled out.
 */
export function describeRedditError(step: string, status: number, detail: string): string {
  const base = `Reddit ${step} failed: HTTP ${status}${detail ? ` — ${detail}` : ""}`;

  if (status === 403) {
    return `${base}. A 403 from Reddit is usually the USER-AGENT, not permissions — an ` +
      `absent or browser-shaped agent is rejected before the credentials are read. ` +
      `Otherwise check the token went to oauth.reddit.com and not www.reddit.com.`;
  }
  if (status === 401) {
    return `${base}. The credentials were read and refused. Check the app is a "script" ` +
      `type app — the password grant only works for that type — and that the id and ` +
      `secret come from the same app. If the account has 2FA on, the password grant ` +
      `needs the code appended, which is why a dedicated app is easier.`;
  }
  if (status === 429) {
    return `${base}. Rate limited. Reddit keys its limits on the User-Agent, so a generic ` +
      `one is shared with every other caller using the same string.`;
  }
  return base;
}

/** The codes Reddit returns INSIDE a 200. Translated because several mislead. */
export function describeSubmitError(code: string, message: string): string {
  const base = `${code}: ${message}`;
  switch (code) {
    case "SUBREDDIT_NOEXIST":
      return `${base}. Check the spelling — this is the name without the "r/" prefix.`;
    case "SUBREDDIT_NOTALLOWED":
      return `${base}. The account cannot post here. Usually a minimum karma or account ` +
        `age rule, or the account is banned from the sub. Neither is fixable in code.`;
    case "SUBMIT_VALIDATION_FLAIR_REQUIRED":
    case "SUBMIT_VALIDATION_MISSING_FLAIR":
      return `${base}. This subreddit requires a post flair. Set flairId on the subreddit ` +
        `config — the id comes from the sub's flair list, not the label you see.`;
    case "RATELIMIT":
      return `${base}. Reddit throttles new or low-karma accounts hard, and the wait is ` +
        `per-account rather than per-app. The scheduler paces posts, so seeing this ` +
        `means the account itself is limited, not that we are posting too fast.`;
    case "NO_LINKS":
      return `${base}. This subreddit does not accept link or image posts.`;
    case "ALREADY_SUB":
      return `${base}. This exact URL has been submitted here before.`;
    case "IN_TIMEOUT":
      return `${base}. The account is in a posting timeout.`;
    case "TOO_LONG":
      return `${base}. The title is over ${MAX_TITLE_LENGTH} characters.`;
    default:
      return base;
  }
}

export interface RedditSession {
  accessToken: string;
  /** Seconds. Reddit's script tokens last 24h, but do not assume it. */
  expiresIn: number;
}

export async function getAccessToken(
  credentials: RedditCredentials,
  options: RedditOptions = {},
): Promise<RedditSession> {
  const fetcher = options.fetch ?? fetch;
  const authApi = options.authApi ?? REDDIT_AUTH_API;

  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString(
    "base64",
  );

  const response = await fetcher(`${authApi}/api/v1/access_token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": credentials.userAgent,
    },
    body: new URLSearchParams({
      grant_type: "password",
      username: credentials.username,
      password: credentials.password,
    }).toString(),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // The body of a failed token call can echo the request. Never pass it
    // through — send the status and our own explanation instead.
    throw new Error(describeRedditError("token request", response.status, ""));
  }

  let payload: { access_token?: string; expires_in?: number; error?: string };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new Error(
      `Reddit token request returned a non-JSON body (HTTP ${response.status}). ` +
        `This usually means the request reached an HTML error page rather than the API.`,
    );
  }

  if (payload.error || !payload.access_token) {
    throw new Error(
      `Reddit token request was refused: ${payload.error ?? "no access_token in the response"}. ` +
        `The most common cause is the app not being a "script" type app.`,
    );
  }

  return { accessToken: payload.access_token, expiresIn: payload.expires_in ?? 3600 };
}

/** Both gates: the platform rail, then this subreddit's own declaration. */
export function assertSubredditAccepts(subreddit: SubredditConfig, asset: AssetRef): void {
  const contentClass = classifyFromKey(asset.key);

  if (contentClass === null) {
    throw new Error(
      `BLOCKED: cannot classify "${asset.key}", so it is not going to r/${subreddit.name}. ` +
        `This is deliberate, not a bug — an unclassifiable asset routes nowhere.`,
    );
  }

  if (contentClass === "explicit" && !subreddit.allowsExplicit) {
    throw new Error(
      `BLOCKED: "${asset.key}" is explicit and r/${subreddit.name} has not been marked as ` +
        `accepting explicit material. Reddit's rules are per-community, so this has to be ` +
        `confirmed for each subreddit by name rather than assumed from the platform.`,
    );
  }
}

export function validateRedditTitle(title: string): string[] {
  const problems: string[] = [];
  if (title.trim() === "") problems.push("the title is empty, and Reddit requires one");
  if (title.length > MAX_TITLE_LENGTH) {
    problems.push(`title is ${title.length} characters, over the ${MAX_TITLE_LENGTH} limit`);
  }
  return problems;
}

export interface MediaAsset {
  bytes: Uint8Array;
  mimeType: string;
  /** Used only as the upload filename; Reddit does not show it. */
  filename: string;
}

/**
 * Upload an image and return the URL to submit.
 *
 * Three calls, not one: ask Reddit for an S3 lease, POST the bytes to S3 with
 * the exact fields it handed back, then read the location out of S3's XML. The
 * fields must be sent in the order given and BEFORE the file part, which is an
 * S3 requirement rather than a Reddit one.
 */
export async function uploadMedia(
  session: RedditSession,
  credentials: RedditCredentials,
  media: MediaAsset,
  options: RedditOptions = {},
): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const oauthApi = options.oauthApi ?? REDDIT_OAUTH_API;

  if (!REDDIT_IMAGE_TYPES.includes(media.mimeType)) {
    throw new Error(
      `Refusing to upload to Reddit: "${media.mimeType}" is not one of ` +
        `${REDDIT_IMAGE_TYPES.join(", ")}.`,
    );
  }
  if (media.bytes.byteLength === 0) throw new Error("Refusing to upload zero bytes to Reddit.");
  if (media.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(
      `Refusing to upload to Reddit: ${media.bytes.byteLength} bytes is over the ` +
        `${MAX_IMAGE_BYTES}-byte limit.`,
    );
  }

  const leaseResponse = await fetcher(`${oauthApi}/api/media/asset.json`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": credentials.userAgent,
    },
    body: new URLSearchParams({
      filepath: media.filename,
      mimetype: media.mimeType,
    }).toString(),
  });

  if (!leaseResponse.ok) {
    throw new Error(describeRedditError("media upload lease", leaseResponse.status, ""));
  }

  const lease = (await leaseResponse.json().catch(() => ({}))) as {
    args?: { action?: string; fields?: Array<{ name: string; value: string }> };
  };
  const action = lease.args?.action ?? "";
  const fields = lease.args?.fields ?? [];
  if (action === "" || fields.length === 0) {
    throw new Error("Reddit returned an upload lease with no action or no fields.");
  }

  // Reddit hands back a protocol-relative URL.
  const uploadUrl = action.startsWith("//") ? `https:${action}` : action;

  const form = new FormData();
  for (const field of fields) form.append(field.name, field.value);
  form.append("file", new Blob([Buffer.from(media.bytes)], { type: media.mimeType }), media.filename);

  const uploadResponse = await fetcher(uploadUrl, { method: "POST", body: form });
  if (!uploadResponse.ok) {
    throw new Error(
      `Reddit media upload to S3 failed: HTTP ${uploadResponse.status}. The lease is ` +
        `short-lived, so this is usually a delay between asking for it and using it.`,
    );
  }

  const xml = await uploadResponse.text().catch(() => "");
  const location = /<Location>([^<]+)<\/Location>/.exec(xml)?.[1];
  if (!location) {
    throw new Error(
      "Reddit media upload succeeded but S3 returned no <Location>, so there is no URL to " +
        "submit. Not treating this as a success.",
    );
  }
  // S3 percent-encodes the path in that element.
  return decodeURIComponent(location);
}

export interface RedditPostResult {
  /** The t3_ fullname. */
  name: string;
  id: string;
  url: string;
}

export interface RedditSubmitRequest {
  subreddit: SubredditConfig;
  title: string;
  /** Set for an image post; omit for a self post. */
  imageUrl?: string;
  /** Body text for a self post. */
  text?: string;
  asset?: AssetRef;
}

/**
 * Submit a post.
 *
 * The success check here is doing the real work: Reddit answers a rejected
 * submission with HTTP 200 and the reason buried in json.errors. Reading
 * `response.ok` alone would report every one of those as a published post, and
 * the scheduler would move on believing the slot was used.
 */
export async function submitPost(
  session: RedditSession,
  credentials: RedditCredentials,
  request: RedditSubmitRequest,
  options: RedditOptions = {},
): Promise<RedditPostResult> {
  const fetcher = options.fetch ?? fetch;
  const oauthApi = options.oauthApi ?? REDDIT_OAUTH_API;

  if (request.asset) {
    assertPublishAllowed("reddit", request.asset);
    assertSubredditAccepts(request.subreddit, request.asset);
  }

  const problems = validateRedditTitle(request.title);
  if (problems.length > 0) {
    throw new Error(`Refusing to submit to r/${request.subreddit.name}: ${problems.join("; ")}`);
  }

  const params: Record<string, string> = {
    api_type: "json",
    sr: request.subreddit.name,
    title: request.title,
    // Without this, re-posting the same image URL is refused as ALREADY_SUB.
    resubmit: "true",
    sendreplies: "false",
  };

  if (request.imageUrl) {
    params.kind = "image";
    params.url = request.imageUrl;
  } else {
    params.kind = "self";
    params.text = request.text ?? "";
  }

  if (request.subreddit.markNsfw) params.nsfw = "true";
  if (request.subreddit.flairId) params.flair_id = request.subreddit.flairId;
  if (request.subreddit.flairText) params.flair_text = request.subreddit.flairText;

  const response = await fetcher(`${oauthApi}/api/submit`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": credentials.userAgent,
    },
    body: new URLSearchParams(params).toString(),
  });

  if (!response.ok) {
    throw new Error(describeRedditError(`submit to r/${request.subreddit.name}`, response.status, ""));
  }

  const payload = (await response.json().catch(() => ({}))) as {
    json?: {
      errors?: Array<[string, string, string?]>;
      data?: { name?: string; id?: string; url?: string };
    };
  };

  // THE TRAP. A 200 is not a success.
  const errors = payload.json?.errors ?? [];
  if (errors.length > 0) {
    const described = errors
      .map(([code, message]) => describeSubmitError(code ?? "UNKNOWN", message ?? ""))
      .join("; ");
    throw new Error(
      `Reddit REJECTED the post to r/${request.subreddit.name} (it answered HTTP 200 and ` +
        `reported the failure in the body): ${described}`,
    );
  }

  const data = payload.json?.data ?? {};
  if (!data.name && !data.url) {
    throw new Error(
      `Reddit returned neither an error nor a post id for r/${request.subreddit.name}. ` +
        `Refusing to report this as published.`,
    );
  }

  const name = data.name ?? "";
  return {
    name,
    id: data.id ?? name.replace(/^t3_/, ""),
    url: data.url ?? `https://www.reddit.com/comments/${data.id ?? ""}`,
  };
}

/** Upload if needed, then submit. The whole lane in one call. */
export async function publishToReddit(
  credentials: RedditCredentials,
  request: RedditSubmitRequest & { media?: MediaAsset },
  options: RedditOptions = {},
): Promise<RedditPostResult> {
  if (request.asset) {
    assertPublishAllowed("reddit", request.asset);
    assertSubredditAccepts(request.subreddit, request.asset);
  }

  const session = await getAccessToken(credentials, options);

  let imageUrl = request.imageUrl;
  if (request.media) {
    imageUrl = await uploadMedia(session, credentials, request.media, options);
  }

  return submitPost(session, credentials, { ...request, imageUrl }, options);
}
