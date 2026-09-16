/**
 * Telegram channel publishing, via the Bot API.
 *
 * The second lane that can go live without waiting on an app review, so it is
 * worth having early even though it is milestone 6 in the plan.
 *
 * Limits below are the Bot API's own, confirmed against its documentation, and
 * enforced before a request is sent:
 *
 *   photo        10 MB via multipart/form-data
 *   other files  50 MB (so video)
 *   caption      1024 characters
 *
 * Note that Telegram's photo limit is TEN times Bluesky's, so this lane can
 * carry the master render rather than the -web derivative.
 *
 * THE SETUP MISTAKE EVERYONE MAKES: the bot must be added to the channel as an
 * administrator with permission to post. Without that every call returns 403
 * and it reads exactly like a bad token. The error handler below says so
 * explicitly rather than passing Telegram's terse "Forbidden" through.
 */

import { assertPublishAllowed, type AssetRef } from "./contentRouting.js";

export const TELEGRAM_API = "https://api.telegram.org";

/** 10 MB, for sendPhoto via multipart. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
/** 50 MB, for every other file type via multipart. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** Characters, not graphemes — the Bot API counts UTF-16 code units here. */
export const MAX_CAPTION_LENGTH = 1024;

export interface TelegramCredentials {
  botToken: string;
  /** "@channelusername" or a numeric id, which for a channel starts -100. */
  chatId: string;
}

export type Fetcher = typeof fetch;

export interface TelegramOptions {
  fetch?: Fetcher;
  api?: string;
}

/**
 * Read credentials from the environment.
 *
 * The token is never logged, never returned in an error message and never
 * placed in a URL that gets printed — which needs care here, because the Bot
 * API puts the token IN THE PATH. Every error message below is built from the
 * method name rather than from the request URL for exactly that reason.
 */
export function telegramCredentialsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelegramCredentials {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env.TELEGRAM_CHANNEL_CHAT_ID ?? "").trim();

  const missing: string[] = [];
  if (botToken === "") missing.push("TELEGRAM_BOT_TOKEN");
  if (chatId === "") missing.push("TELEGRAM_CHANNEL_CHAT_ID");
  if (missing.length > 0) {
    throw new Error(
      `Cannot publish to Telegram: missing environment variable(s): ${missing.join(", ")}. ` +
        `Trigger.dev variables are per-environment — set in Development is not set in Production.`,
    );
  }

  // Bot tokens are <numeric bot id>:<secret>. Checking the shape catches a
  // half-pasted value now rather than as a 404 later, and a 404 from this API
  // is indistinguishable from a wrong method name.
  if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(botToken)) {
    throw new Error(
      `TELEGRAM_BOT_TOKEN does not look like a bot token (expected <digits>:<secret>). ` +
        `Check it was pasted whole — a truncated token fails as a 404, which reads like a bug ` +
        `in the code rather than a bad credential.`,
    );
  }

  // A channel is either @username or a numeric id beginning -100. A bare
  // positive number is a private chat, not a channel, and posting to it would
  // succeed while reaching nobody — the worst kind of wrong.
  if (!/^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(chatId) && !/^-100\d+$/.test(chatId)) {
    throw new Error(
      `TELEGRAM_CHANNEL_CHAT_ID "${chatId}" is not a channel identifier. Use either ` +
        `@yourchannel or the numeric id, which for a channel begins with -100. A plain ` +
        `positive number is a private chat: posting there would succeed and reach nobody.`,
    );
  }

  return { botToken, chatId };
}

export function validateCaption(caption: string): string[] {
  if (caption.length > MAX_CAPTION_LENGTH) {
    return [
      `caption is ${caption.length} characters, over Telegram's ${MAX_CAPTION_LENGTH} limit`,
    ];
  }
  return [];
}

export function validateMedia(bytes: Uint8Array, kind: "image" | "video"): string[] {
  const problems: string[] = [];
  const limit = kind === "image" ? MAX_PHOTO_BYTES : MAX_FILE_BYTES;
  if (bytes.byteLength === 0) problems.push("media is zero bytes");
  if (bytes.byteLength > limit) {
    problems.push(
      `${kind} is ${bytes.byteLength} bytes, over Telegram's ${limit}-byte limit for this type`,
    );
  }
  return problems;
}

/**
 * Turn a Bot API failure into something actionable.
 *
 * Deliberately never includes the request URL, because the token is in the
 * path. The method name is enough to locate the call.
 */
export function describeTelegramError(
  method: string,
  status: number,
  description: string,
): string {
  const base = `Telegram ${method} failed: HTTP ${status}${description ? ` — ${description}` : ""}`;

  if (status === 403) {
    return (
      `${base}. This almost always means the bot is not an ADMINISTRATOR of the channel, ` +
      `or lacks permission to post. Add it: channel > Administrators > Add Administrator > ` +
      `your bot, with "Post Messages" enabled. It reads like a bad token but it is not one.`
    );
  }
  if (status === 400 && /chat not found/i.test(description)) {
    return (
      `${base}. The chat id is wrong, or the bot has never been added to that channel. ` +
      `For a public channel use @username; for a private one use the numeric -100… id.`
    );
  }
  if (status === 401) {
    return `${base}. The bot token is rejected — check TELEGRAM_BOT_TOKEN is current and whole.`;
  }
  if (status === 429) {
    return `${base}. Rate limited. The scheduler paces posts, so this suggests something is retrying in a loop.`;
  }
  return base;
}

async function callBotApi(
  credentials: TelegramCredentials,
  method: string,
  form: FormData,
  options: TelegramOptions = {},
): Promise<Record<string, unknown>> {
  const fetcher = options.fetch ?? fetch;
  const api = options.api ?? TELEGRAM_API;

  const response = await fetcher(`${api}/bot${credentials.botToken}/${method}`, {
    method: "POST",
    body: form,
  });

  let payload: { ok?: boolean; description?: string; result?: Record<string, unknown> } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    /* fall through to the status-based message */
  }

  if (!response.ok || payload.ok !== true) {
    throw new Error(
      describeTelegramError(method, response.status, payload.description ?? ""),
    );
  }
  return payload.result ?? {};
}

export interface TelegramPostResult {
  messageId: number;
  /** Browsable link when the channel is public; empty for a private one. */
  url: string;
}

export function messageUrl(chatId: string, messageId: number): string {
  // Only a public @username channel has a t.me/<name>/<id> permalink. For a
  // numeric id there is no stable public URL, and inventing one would be worse
  // than returning nothing.
  if (chatId.startsWith("@")) return `https://t.me/${chatId.slice(1)}/${messageId}`;
  return "";
}

export interface TelegramPostRequest {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
  kind: "image" | "video";
  caption: string;
  /** The asset being published, for the last-moment safety check. */
  asset?: AssetRef;
}

/**
 * Post media to the channel.
 *
 * As with Bluesky, assertPublishAllowed runs here as well as at routing time.
 * Telegram is on the safe-only list, so an explicit render must be refused at
 * the last possible moment regardless of what queued it.
 */
export async function publishToTelegram(
  credentials: TelegramCredentials,
  request: TelegramPostRequest,
  options: TelegramOptions = {},
): Promise<TelegramPostResult> {
  if (request.asset) {
    assertPublishAllowed("telegram", request.asset);
  }

  const problems = [
    ...validateMedia(request.bytes, request.kind),
    ...validateCaption(request.caption),
  ];
  if (problems.length > 0) {
    throw new Error(`Refusing to publish to Telegram: ${problems.join("; ")}`);
  }

  const method = request.kind === "image" ? "sendPhoto" : "sendVideo";
  const field = request.kind === "image" ? "photo" : "video";

  const form = new FormData();
  form.append("chat_id", credentials.chatId);
  form.append("caption", request.caption);
  form.append(
    field,
    new Blob([Buffer.from(request.bytes)], { type: request.mimeType }),
    request.filename,
  );

  const result = await callBotApi(credentials, method, form, options);
  const messageId = Number(result.message_id);
  if (!Number.isFinite(messageId)) {
    throw new Error(`Telegram ${method} returned no message_id.`);
  }

  return { messageId, url: messageUrl(credentials.chatId, messageId) };
}
