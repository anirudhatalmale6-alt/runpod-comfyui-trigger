/**
 * TikTok Content Posting API.
 *
 * TikTok offers two ways to hand over media:
 *
 *   PULL_FROM_URL   TikTok downloads it from your URL — but ONLY from a domain
 *                   you have verified ownership of in the developer portal.
 *   FILE_UPLOAD     TikTok gives you an upload URL and you PUT the bytes.
 *
 * This uses FILE_UPLOAD, deliberately. The renders sit on Tigris's domain, not
 * the client's, so domain verification is impossible — the verification widget
 * requires proving you own the host. PULL_FROM_URL would fail every time with
 * an "unverified URL" error that reads like a bad link rather than a policy.
 *
 * So the three lanes now move media three different ways: Bluesky and Telegram
 * take raw bytes directly, Instagram and Facebook are handed a link they fetch
 * themselves, and TikTok takes bytes but to a URL it nominates.
 *
 * Photo posts use /v2/post/publish/content/init/ with media_type PHOTO; videos
 * use /v2/post/publish/video/init/. Both then need the upload step.
 */

import { assertPublishAllowed, type AssetRef } from "./contentRouting.js";

export const TIKTOK_API = "https://open.tiktokapis.com";

/** Photo posts: 1-10 images, JPG/JPEG, each under 20 MB. */
export const TIKTOK_MAX_PHOTO_BYTES = 20 * 1024 * 1024;
export const TIKTOK_PHOTO_TYPES: readonly string[] = Object.freeze(["image/jpeg"]);
/** Title limit for a post. */
export const TIKTOK_MAX_TITLE = 90;
/** Description limit. */
export const TIKTOK_MAX_DESCRIPTION = 4000;

export type Fetcher = typeof fetch;

export interface TikTokOptions {
  fetch?: Fetcher;
  api?: string;
}

export interface TikTokCredentials {
  /** A user access token with video.publish scope. */
  accessToken: string;
}

export function tiktokCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TikTokCredentials {
  const accessToken = (env.TIKTOK_ACCESS_TOKEN ?? "").trim();
  if (accessToken === "") {
    throw new Error(
      "Cannot publish to TikTok: TIKTOK_ACCESS_TOKEN is not set. " +
        "Trigger.dev variables are per-environment — set in Development is not set in Production.",
    );
  }
  return { accessToken };
}

/**
 * Turn a TikTok API failure into something actionable.
 *
 * Never includes the access token. TikTok's error codes are specific and worth
 * translating, because several of them are approval-state problems that read
 * like code faults.
 */
export function describeTikTokError(
  step: string,
  status: number,
  errorCode: string,
  message: string,
): string {
  const base = `TikTok ${step} failed: HTTP ${status}${errorCode ? ` — ${errorCode}` : ""}${message ? `: ${message}` : ""}`;

  if (/unaudited_client|spam_risk|unaudited/i.test(errorCode)) {
    return `${base}. The app has not passed TikTok's content-posting audit, so it can only ` +
      `post PRIVATELY to your own account. Public posting needs the audited scope.`;
  }
  if (/url_ownership_unverified/i.test(errorCode)) {
    return `${base}. This is the PULL_FROM_URL domain-verification error. We use FILE_UPLOAD ` +
      `precisely to avoid it, so seeing this means something switched the transfer mode.`;
  }
  if (/access_token_invalid|scope_not_authorized/i.test(errorCode)) {
    return `${base}. The token is invalid or lacks the video.publish scope.`;
  }
  if (/rate_limit/i.test(errorCode)) {
    return `${base}. Rate limited. The scheduler paces posts, so this suggests a retry loop.`;
  }
  if (/file_format_check_failed|picture_size_check_failed/i.test(errorCode)) {
    return `${base}. TikTok rejected the file itself. Photos must be JPEG and under 20 MB — ` +
      `use the -web.jpg derivative rather than a PNG master.`;
  }
  return base;
}

interface InitResponse {
  data?: {
    publish_id?: string;
    upload_url?: string;
  };
  error?: { code?: string; message?: string };
}

export interface TikTokPostRequest {
  bytes: Uint8Array;
  mimeType: string;
  /** Short hook, shown as the post title. */
  title: string;
  description?: string;
  asset?: AssetRef;
  /**
   * SELF_ONLY keeps the post private. Default is PUBLIC_TO_EVERYONE, but an
   * unaudited app is forced to SELF_ONLY by TikTok regardless of what is asked.
   */
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
}

export function validatePhoto(bytes: Uint8Array, mimeType: string): string[] {
  const problems: string[] = [];
  if (!TIKTOK_PHOTO_TYPES.includes(mimeType)) {
    problems.push(`TikTok photo posts accept JPEG only, not ${mimeType}`);
  }
  if (bytes.byteLength === 0) problems.push("media is zero bytes");
  if (bytes.byteLength > TIKTOK_MAX_PHOTO_BYTES) {
    problems.push(
      `photo is ${bytes.byteLength} bytes, over TikTok's ${TIKTOK_MAX_PHOTO_BYTES}-byte limit`,
    );
  }
  return problems;
}

export function validateTitle(title: string): string[] {
  if (title.length > TIKTOK_MAX_TITLE) {
    return [`title is ${title.length} characters, over TikTok's ${TIKTOK_MAX_TITLE} limit`];
  }
  return [];
}

export interface TikTokPostResult {
  publishId: string;
}

/**
 * Publish a photo post.
 *
 * Init, then PUT the bytes to the URL TikTok nominates. The PUT must carry a
 * Content-Range header covering the whole file even for a single-chunk upload —
 * omitting it fails in a way that does not mention ranges.
 */
export async function publishPhotoToTikTok(
  credentials: TikTokCredentials,
  request: TikTokPostRequest,
  options: TikTokOptions = {},
): Promise<TikTokPostResult> {
  const fetcher = options.fetch ?? fetch;
  const api = options.api ?? TIKTOK_API;

  if (request.asset) assertPublishAllowed("tiktok", request.asset);

  const problems = [
    ...validatePhoto(request.bytes, request.mimeType),
    ...validateTitle(request.title),
  ];
  if (problems.length > 0) {
    throw new Error(`Refusing to publish to TikTok: ${problems.join("; ")}`);
  }

  const initResponse = await fetcher(`${api}/v2/post/publish/content/init/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${credentials.accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      media_type: "PHOTO",
      post_mode: "DIRECT_POST",
      post_info: {
        title: request.title,
        description: request.description ?? request.title,
        privacy_level: request.privacyLevel ?? "PUBLIC_TO_EVERYONE",
      },
      source_info: {
        source: "FILE_UPLOAD",
        photo_cover_index: 0,
        photo_images: [{ image_size: request.bytes.byteLength }],
      },
    }),
  });

  const init = (await initResponse.json().catch(() => ({}))) as InitResponse;
  if (!initResponse.ok || (init.error?.code && init.error.code !== "ok")) {
    throw new Error(
      describeTikTokError("init", initResponse.status, init.error?.code ?? "", init.error?.message ?? ""),
    );
  }

  const publishId = init.data?.publish_id ?? "";
  const uploadUrl = init.data?.upload_url ?? "";
  if (publishId === "" || uploadUrl === "") {
    throw new Error("TikTok init returned no publish_id or upload_url.");
  }

  const total = request.bytes.byteLength;
  const upload = await fetcher(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": request.mimeType,
      // Required even for a single chunk. Without it the upload fails with an
      // error that says nothing about ranges.
      "Content-Range": `bytes 0-${total - 1}/${total}`,
    },
    body: new Blob([Buffer.from(request.bytes)], { type: request.mimeType }),
  });

  if (!upload.ok) {
    throw new Error(
      `TikTok media upload failed: HTTP ${upload.status}. The post was initialised ` +
        `(publish_id ${publishId}) but the bytes did not transfer, so nothing was published.`,
    );
  }

  return { publishId };
}
