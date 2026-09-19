/**
 * publishDoctor — proves each publishing lane's credentials WORK, without
 * publishing anything.
 *
 * configDoctor already answers "is the variable set". That is not the same
 * question, and the gap between them has cost this project real time twice:
 * a RunPod endpoint id that was set in the wrong environment, and a Telegram
 * chat id that was present, correctly formatted, and pointed at the bot itself.
 * Both looked fine to a presence check. Both failed on the first real call.
 *
 * So every check here makes ONE cheap READ-ONLY call to the platform and
 * reports what came back. Nothing posts. Nothing becomes public. The worst case
 * is a wasted API call.
 *
 * The Telegram check is the one that earns this file: it asks Telegram whether
 * the bot can actually SEE the channel and whether it is an administrator with
 * permission to post. That question, asked once, answers in seconds what
 * otherwise surfaces as a failed publish an hour later.
 *
 * SECRETS NEVER APPEAR IN THE OUTPUT. Not in `detail`, not in `problems`, not
 * in an error message. Telegram and Meta both put credentials in the URL, so
 * nothing here is ever built from a request URL.
 */

import { PLATFORMS, type PlatformId } from "./contentRouting.js";
import { inspectVar, type VarReport } from "./envReport.js";

export type Fetcher = typeof fetch;

export interface DoctorOptions {
  fetch?: Fetcher;
  env?: NodeJS.ProcessEnv;
  /** Skip the live calls and report configuration only. */
  offline?: boolean;
}

export interface LaneStatus {
  platform: PlatformId;
  label: string;
  /** Every required variable is present and non-blank. */
  configured: boolean;
  /**
   * Whether the live read-only call succeeded. `null` means it was not
   * attempted — either the lane is not configured, or offline was requested.
   * NULL IS NOT A PASS and must never be rendered as one.
   */
  reachable: boolean | null;
  /** One line a human can act on. Never contains a secret. */
  detail: string;
  problems: string[];
  /** Presence and length only, for spotting a truncated paste. */
  vars: VarReport[];
}

/** Read a JSON body without letting a non-JSON error page throw. */
async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function missingVars(names: readonly string[], env: NodeJS.ProcessEnv): VarReport[] {
  return names.map((name) => inspectVar(name, env));
}

function configProblems(vars: VarReport[], environmentType: string): string[] {
  const problems: string[] = [];
  for (const report of vars) {
    if (!report.present) {
      problems.push(
        `${report.name} is not set in the ${environmentType} environment. ` +
          `Trigger.dev variables are per-environment — set in Development is not set here.`,
      );
    } else if (report.blank) {
      problems.push(`${report.name} is set but empty.`);
    } else if (report.untrimmed) {
      problems.push(
        `${report.name} has leading or trailing whitespace — usually a copy-paste artefact, ` +
          `and it WILL break the value.`,
      );
    }
  }
  return problems;
}

/**
 * What a credential should roughly LOOK like.
 *
 * Added after a real run: the report showed FACEBOOK_PAGE_ACCESS_TOKEN at 32
 * characters and TIKTOK_ACCESS_TOKEN at 16. Both are far too short to be
 * tokens, and both had been wrong all along — but the doctor printed the
 * lengths without comment and it took a human noticing to spot it. A number
 * nobody knows how to interpret is not a diagnostic.
 *
 * Length only. Never the value. These are deliberately loose bounds — the point
 * is catching an App Secret or a placeholder pasted into a token field, not
 * validating a format that the platform may change.
 */
const VALUE_SHAPES: Readonly<Record<string, { minLength: number; hint: string }>> = Object.freeze({
  INSTAGRAM_ACCESS_TOKEN: {
    minLength: 100,
    hint: "a Meta access token is normally 150-300 characters",
  },
  FACEBOOK_PAGE_ACCESS_TOKEN: {
    minLength: 100,
    hint: "a Meta page access token is normally 150-300 characters",
  },
  TIKTOK_ACCESS_TOKEN: {
    minLength: 50,
    hint: "a TikTok access token is well over 100 characters",
  },
  REDDIT_CLIENT_SECRET: { minLength: 20, hint: "a Reddit app secret is around 27-30 characters" },
  BLUESKY_APP_PASSWORD: { minLength: 19, hint: "an app password is xxxx-xxxx-xxxx-xxxx" },
  TELEGRAM_BOT_TOKEN: { minLength: 40, hint: "a bot token is <digits>:<35+ character secret>" },
});

/** Exactly 32 characters of hex is a Meta App Secret, not a token. */
const META_TOKEN_VARS = ["INSTAGRAM_ACCESS_TOKEN", "FACEBOOK_PAGE_ACCESS_TOKEN"];

export function shapeProblems(vars: VarReport[]): string[] {
  const problems: string[] = [];
  for (const report of vars) {
    if (!report.present || report.blank) continue;
    const shape = VALUE_SHAPES[report.name];
    if (!shape) continue;

    if (report.length >= shape.minLength) continue;

    if (META_TOKEN_VARS.includes(report.name) && report.length === 32) {
      problems.push(
        `${report.name} is exactly 32 characters, which is the length of a Meta APP SECRET, ` +
          `not an access token. They sit next to each other on the dashboard. This will never ` +
          `work as a token, however many times it is retried.`,
      );
      continue;
    }

    problems.push(
      `${report.name} is only ${report.length} characters — too short to be valid, because ` +
        `${shape.hint}. This looks like the wrong value rather than an expired one, so ` +
        `regenerating it will not help until the right value is in there.`,
    );
  }
  return problems;
}

type Check = (
  env: NodeJS.ProcessEnv,
  fetcher: Fetcher,
) => Promise<{ reachable: boolean; detail: string; problems: string[] }>;

interface LaneSpec {
  platform: PlatformId;
  label: string;
  vars: readonly string[];
  check: Check;
}

/* -------------------------------------------------------------------------- */

const telegramCheck: Check = async (env, fetcher) => {
  const token = (env.TELEGRAM_BOT_TOKEN ?? "").trim();
  const chatId = (env.TELEGRAM_CHANNEL_CHAT_ID ?? "").trim();
  const api = "https://api.telegram.org";
  const problems: string[] = [];

  // 1. Is the token a real bot?
  const meResponse = await fetcher(`${api}/bot${token}/getMe`);
  const me = await readJson(meResponse);
  if (!meResponse.ok || me.ok !== true) {
    return {
      reachable: false,
      detail: "The bot token was rejected by Telegram.",
      problems: [
        `TELEGRAM_BOT_TOKEN is not valid (getMe returned HTTP ${meResponse.status}). ` +
          `Check it was pasted whole — a truncated token fails as a 404.`,
      ],
    };
  }
  const bot = (me.result ?? {}) as { username?: string; id?: number };
  const botName = bot.username ? `@${bot.username}` : `bot ${bot.id ?? "?"}`;

  // 2. Can the bot SEE the channel? This is the question that matters.
  const chatResponse = await fetcher(
    `${api}/bot${token}/getChat?chat_id=${encodeURIComponent(chatId)}`,
  );
  const chat = await readJson(chatResponse);
  if (!chatResponse.ok || chat.ok !== true) {
    const description = String(
      (chat.description as string | undefined) ?? `HTTP ${chatResponse.status}`,
    );
    if (/bot.*not.*member|not found/i.test(description)) {
      problems.push(
        `${botName} cannot see ${chatId}. Either the id is wrong, or the bot has never been ` +
          `added to that channel. Add it from the BOT's profile: open the bot, tap its name, ` +
          `"Add to Group or Channel".`,
      );
    } else {
      problems.push(`Telegram refused getChat for ${chatId}: ${description}`);
    }
    return { reachable: false, detail: `${botName} cannot reach ${chatId}.`, problems };
  }

  const chatInfo = (chat.result ?? {}) as { title?: string; type?: string };

  // 3. Is it an administrator that may post? Membership alone is not enough.
  const memberResponse = await fetcher(
    `${api}/bot${token}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${bot.id ?? 0}`,
  );
  const member = await readJson(memberResponse);

  // A FAILED getChatMember is not a membership status. The first version
  // defaulted a missing status to "unknown" and then reported the bot as
  // 'a "unknown" in the channel, not an admin' — which reads like the bot is
  // present with a strange role, when in fact Telegram refused the question.
  //
  // The distinction is real and it matters here: getChat succeeds for any
  // PUBLIC channel whether or not the bot is in it, so seeing the channel name
  // come back proves nothing about membership. getChatMember is the call that
  // actually knows, and when it fails the honest answer is "not in the channel",
  // not an invented role.
  if (!memberResponse.ok || member.ok !== true) {
    problems.push(
      `${botName} is NOT in ${chatId}. Telegram could read the channel's details — that ` +
        `works for any public channel — but refused to report the bot's membership, which ` +
        `means it has never been added. Add it from the BOT's profile: open the bot, tap ` +
        `its name, "Add to Group or Channel", then enable "Post Messages".`,
    );
    return {
      reachable: false,
      detail: `${botName} is not a member of "${chatInfo.title ?? chatId}".`,
      problems,
    };
  }

  const status = String(((member.result ?? {}) as { status?: string }).status ?? "unknown");
  const canPost = ((member.result ?? {}) as { can_post_messages?: boolean }).can_post_messages;

  if (status === "left" || status === "kicked") {
    problems.push(
      `${botName} was in ${chatId} but is now "${status}" — removed or never accepted. ` +
        `Re-add it as an administrator with "Post Messages" enabled.`,
    );
    return {
      reachable: false,
      detail: `${botName} has been ${status} from "${chatInfo.title ?? chatId}".`,
      problems,
    };
  }

  if (status !== "administrator" && status !== "creator") {
    problems.push(
      `${botName} is in ${chatId} but its status is "${status}", not administrator. ` +
        `It must be an admin with "Post Messages" enabled or every publish returns 403.`,
    );
    return {
      reachable: false,
      detail: `${botName} is a "${status}" in "${chatInfo.title ?? chatId}", not an admin.`,
      problems,
    };
  }
  if (canPost === false) {
    problems.push(
      `${botName} is an administrator of ${chatId} but "Post Messages" is OFF. ` +
        `Turn it on in the channel's administrator settings.`,
    );
    return {
      reachable: false,
      detail: `${botName} is an admin but cannot post.`,
      problems,
    };
  }

  return {
    reachable: true,
    detail: `${botName} is an administrator of "${chatInfo.title ?? chatId}" and may post.`,
    problems,
  };
};

/**
 * Which permissions the TOKEN actually carries.
 *
 * This is the check that settles a Meta permissions failure, because it
 * distinguishes three cases that are indistinguishable from the publish error
 * alone: granted, declined, and not-offered-at-all. The third means the app
 * cannot ever have the permission — usually the wrong app TYPE — and no amount
 * of re-ticking boxes will change it.
 *
 * Best-effort: it needs a user token, so a Page token may refuse it. A refusal
 * is reported as "could not determine", never as "missing".
 */
async function metaScopes(
  token: string,
  fetcher: Fetcher,
): Promise<{ granted: Set<string>; declined: Set<string> } | null> {
  try {
    const response = await fetcher(
      `https://graph.facebook.com/v21.0/me/permissions?access_token=${encodeURIComponent(token)}`,
    );
    if (!response.ok) return null;
    const body = (await response.json().catch(() => ({}))) as {
      data?: Array<{ permission?: string; status?: string }>;
    };
    if (!Array.isArray(body.data)) return null;

    const granted = new Set<string>();
    const declined = new Set<string>();
    for (const entry of body.data) {
      if (!entry.permission) continue;
      if (entry.status === "granted") granted.add(entry.permission);
      else declined.add(entry.permission);
    }
    return { granted, declined };
  } catch {
    return null;
  }
}

/** Either name satisfies the requirement; the flows differ, the need does not. */
const INSTAGRAM_PUBLISH_SCOPES = ["instagram_content_publish", "instagram_business_content_publish"];

function describeScopeGap(
  scopes: { granted: Set<string>; declined: Set<string> },
  needed: string[],
  label: string,
): string[] {
  if (needed.some((scope) => scopes.granted.has(scope))) return [];

  const wasDeclined = needed.filter((scope) => scopes.declined.has(scope));
  if (wasDeclined.length > 0) {
    return [
      `${label}: the token HAS ${wasDeclined.join(" / ")} but it is DECLINED, not granted. ` +
        `That happens by clicking through the Facebook approval dialog too quickly — ` +
        `regenerate the token and approve the Page and Instagram parts explicitly.`,
    ];
  }
  return [
    `${label}: the token carries NONE of ${needed.join(" / ")}, and they were not even ` +
      `offered. That usually means the app is the wrong TYPE — Instagram publishing needs a ` +
      `BUSINESS app, and a Consumer app never offers the permission however many times you ` +
      `tick it. Check App settings > Basic > App type, and that Instagram is in Products.`,
  ];
}

/**
 * Fields that PROVE the object is the right kind of thing.
 *
 * Asking for `name` is not enough, and this cost a real false pass: the doctor
 * reported `OK Facebook: authenticated as "ava-publisher"` — the name of the
 * SYSTEM USER, because FACEBOOK_PAGE_ID held the system user's id rather than
 * the Page's. The id resolved, the scopes were present, so every check passed
 * and a publish would still have gone nowhere.
 *
 * Nearly everything in the Graph API has a `name`. Only a Page has a category
 * or a fan count; only an Instagram account has a media count. At least one of
 * these must come back, or the id is pointing at the wrong kind of object.
 */
const PROOF_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Facebook: ["category", "fan_count"],
  Instagram: ["media_count"],
});

const metaCheck =
  (idVar: string, tokenVar: string, field: string, label: string): Check =>
  async (env, fetcher) => {
    const id = (env[idVar] ?? "").trim();
    const token = (env[tokenVar] ?? "").trim();
    const proof = PROOF_FIELDS[label] ?? [];
    const requested = [field, ...proof].join(",");
    const response = await fetcher(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(id)}?fields=${requested}&access_token=${encodeURIComponent(token)}`,
    );
    const body = await readJson(response);
    const error = (body.error ?? {}) as { message?: string; code?: number };

    if (!response.ok || error.code !== undefined) {
      const problems: string[] = [];
      if (error.code === 190) {
        problems.push(
          `${tokenVar} is invalid or expired. Page tokens derived from a short-lived user ` +
            `token expire in about an hour — you want a long-lived one.`,
        );
      } else if (error.code === 200 || error.code === 10) {
        problems.push(
          `${label} refused on PERMISSIONS, not a bad value. Instagram publishing needs ` +
            `instagram_business_content_publish; Facebook needs pages_manage_posts. ` +
            `Both need app review.`,
        );
      } else if (error.code === 803 || /does not exist/i.test(error.message ?? "")) {
        problems.push(
          `${idVar} does not resolve. For Instagram this must be the NUMERIC professional ` +
            `account id — not your @handle, and not the Facebook page id. Mixing those two ` +
            `up is the usual cause.`,
        );
      } else {
        problems.push(`${label} check failed: ${error.message ?? `HTTP ${response.status}`}`);
      }
      return { reachable: false, detail: `${label} rejected the credentials.`, problems };
    }

    // The account resolves. That is NOT the same as being able to publish to
    // it: reading an account needs instagram_basic, publishing needs a scope
    // that is granted separately and is the usual thing missing. Checking it
    // here turns "it failed when you tried to post" into "it will fail, and
    // here is the reason" — before a post is ever attempted.
    const needed = label === "Instagram" ? INSTAGRAM_PUBLISH_SCOPES : ["pages_manage_posts"];
    const scopes = await metaScopes(token, fetcher);
    const scopeProblems = scopes === null ? [] : describeScopeGap(scopes, needed, label);

    // The object resolved and has a name — but a name proves nothing about WHAT
    // it is. Require a field only the right kind of object carries.
    if (proof.length > 0 && !proof.some((f) => body[f] !== undefined)) {
      const what = label === "Facebook" ? "Facebook Page" : "Instagram account";
      return {
        reachable: false,
        detail:
          `${idVar} resolved to "${String(body[field] ?? id)}", but that is NOT a ${what}.`,
        problems: [
          `${idVar} points at the wrong kind of object. It resolved and it has a name, ` +
            `which is why this looked fine — but a ${what} always returns ` +
            `${proof.join(" or ")}, and this returned neither. Check you have not used the ` +
            `system user's id, the app id, or the other platform's id here.`,
        ],
      };
    }

    // Require the field we ASKED for. Falling back through name/username was
    // convenient and wrong: a Facebook Page returns `name`, an Instagram
    // account returns `username`, so the fallback would happily report an
    // Instagram account as a successfully-authenticated Facebook Page. The
    // whole job here is telling one object apart from another, and a fallback
    // that papers over the difference defeats it.
    if (body[field] === undefined) {
      return {
        reachable: false,
        detail: `${label} returned an object with no "${field}" — it is the wrong KIND of object.`,
        problems: [
          `${idVar} resolved, but the object has no "${field}" field, which means it is not a ` +
            `${label} ${label === "Facebook" ? "Page" : "account"}. A Facebook Page has "name"; ` +
            `an Instagram account has "username". Putting one id in the other's variable gets ` +
            `you here.`,
        ],
      };
    }

    const name = String(body[field]);
    if (scopeProblems.length > 0) {
      return {
        reachable: false,
        detail: `${label} authenticated as "${name}" but CANNOT PUBLISH — the token lacks the publishing permission.`,
        problems: scopeProblems,
      };
    }

    const caveat =
      scopes === null
        ? " Publishing permission could not be checked from this token, so it is unconfirmed."
        : "";
    return {
      reachable: true,
      detail: `${label} authenticated as "${name}".${caveat}`,
      problems: [],
    };
  };

const tiktokCheck: Check = async (env, fetcher) => {
  const token = (env.TIKTOK_ACCESS_TOKEN ?? "").trim();
  const response = await fetcher(
    "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const body = await readJson(response);
  const error = (body.error ?? {}) as { code?: string; message?: string };

  if (!response.ok || (error.code && error.code !== "ok")) {
    const problems: string[] = [];
    if (error.code === "access_token_invalid" || response.status === 401) {
      problems.push(
        `TIKTOK_ACCESS_TOKEN is invalid or expired. TikTok access tokens are short-lived — ` +
          `if this worked yesterday it has simply aged out, and the refresh token is what ` +
          `renews it.`,
      );
    } else if (error.code === "scope_not_authorized") {
      problems.push(
        `The token is valid but lacks the scope. Publishing needs video.publish, and the ` +
          `app has to be approved for it.`,
      );
    } else {
      problems.push(
        `TikTok check failed: ${error.code ?? `HTTP ${response.status}`}` +
          `${error.message ? ` — ${error.message}` : ""}`,
      );
    }
    return { reachable: false, detail: "TikTok rejected the access token.", problems };
  }

  const user = ((body.data ?? {}) as { user?: { display_name?: string } }).user ?? {};
  return {
    reachable: true,
    detail: `TikTok authenticated as "${user.display_name ?? "unknown user"}".`,
    problems: [],
  };
};

const blueskyCheck: Check = async (env, fetcher) => {
  const response = await fetcher("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: (env.BLUESKY_HANDLE ?? "").trim(),
      password: (env.BLUESKY_APP_PASSWORD ?? "").trim(),
    }),
  });
  const body = await readJson(response);
  if (!response.ok) {
    return {
      reachable: false,
      detail: "Bluesky rejected the handle or app password.",
      problems: [
        `Bluesky refused the login: ${String(body.error ?? `HTTP ${response.status}`)}. ` +
          `BLUESKY_APP_PASSWORD must be an APP password (xxxx-xxxx-xxxx-xxxx), not the ` +
          `account password.`,
      ],
    };
  }
  return {
    reachable: true,
    detail: `Bluesky authenticated as ${String(body.handle ?? body.did ?? "unknown")}.`,
    problems: [],
  };
};

const redditCheck: Check = async (env, fetcher) => {
  const clientId = (env.REDDIT_CLIENT_ID ?? "").trim();
  const clientSecret = (env.REDDIT_CLIENT_SECRET ?? "").trim();
  const username = (env.REDDIT_USERNAME ?? "").trim().replace(/^\/?u\//, "");
  const password = (env.REDDIT_PASSWORD ?? "").trim();
  const userAgent =
    (env.REDDIT_USER_AGENT ?? "").trim() ||
    `nodejs:com.avaautomation.publisher:v1.0 (by /u/${username})`;

  const tokenResponse = await fetcher("https://www.reddit.com/api/v1/access_token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body: new URLSearchParams({ grant_type: "password", username, password }).toString(),
  });

  if (!tokenResponse.ok) {
    const problems: string[] =
      tokenResponse.status === 403
        ? [
            `Reddit returned 403 on the token call. That is usually the USER-AGENT rather ` +
              `than permissions — Reddit blocks a bare or absent agent before it reads the ` +
              `credentials.`,
          ]
        : [
            `Reddit refused the credentials (HTTP ${tokenResponse.status}). The app must be a ` +
              `"script" type app — the password login only works for that type. If the ` +
              `account has 2FA on, this login method cannot work at all.`,
          ];
    return { reachable: false, detail: "Reddit rejected the credentials.", problems };
  }

  const token = String((await readJson(tokenResponse)).access_token ?? "");
  if (token === "") {
    return {
      reachable: false,
      detail: "Reddit returned no access token.",
      problems: ["Reddit accepted the request but issued no token."],
    };
  }

  // A token being ISSUED is not the same as it reaching anything.
  const meResponse = await fetcher("https://oauth.reddit.com/api/v1/me", {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": userAgent },
  });
  if (!meResponse.ok) {
    return {
      reachable: false,
      detail: "Reddit issued a token that cannot read the account.",
      problems: [`A token was issued but /api/v1/me returned HTTP ${meResponse.status}.`],
    };
  }
  const me = await readJson(meResponse);
  return {
    reachable: true,
    detail: `Reddit authenticated as u/${String(me.name ?? username)}.`,
    problems: [],
  };
};

/* -------------------------------------------------------------------------- */

const ALL_LANES: readonly LaneSpec[] = Object.freeze([
  {
    platform: "bluesky" as PlatformId,
    label: "Bluesky",
    vars: ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"],
    check: blueskyCheck,
  },
  {
    platform: "telegram" as PlatformId,
    label: "Telegram",
    vars: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHANNEL_CHAT_ID"],
    check: telegramCheck,
  },
  {
    platform: "instagram" as PlatformId,
    label: "Instagram",
    vars: ["INSTAGRAM_USER_ID", "INSTAGRAM_ACCESS_TOKEN"],
    check: metaCheck("INSTAGRAM_USER_ID", "INSTAGRAM_ACCESS_TOKEN", "username", "Instagram"),
  },
  {
    platform: "facebook" as PlatformId,
    label: "Facebook",
    vars: ["FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN"],
    check: metaCheck("FACEBOOK_PAGE_ID", "FACEBOOK_PAGE_ACCESS_TOKEN", "name", "Facebook"),
  },
  {
    platform: "tiktok" as PlatformId,
    label: "TikTok",
    vars: ["TIKTOK_ACCESS_TOKEN"],
    check: tiktokCheck,
  },
  {
    platform: "reddit" as PlatformId,
    label: "Reddit",
    vars: ["REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD"],
    check: redditCheck,
  },
]);

/**
 * The lanes actually worth checking.
 *
 * DERIVED from the platform table rather than hand-listed, so retiring a
 * platform removes it from the doctor automatically. Hand-maintained lists
 * have gone stale four times on this project; this one cannot.
 *
 * A retired lane is not "broken" and not "unconfigured" — it is not a lane.
 * Reporting Reddit as needing attention after the client dropped it would be
 * noise that trains people to ignore the report.
 */
export const LANES: readonly LaneSpec[] = Object.freeze(
  ALL_LANES.filter((lane) => PLATFORMS[lane.platform]?.retired !== true),
);

/** Kept for the record, so a retired lane can still be inspected deliberately. */
export const RETIRED_LANES: readonly LaneSpec[] = Object.freeze(
  ALL_LANES.filter((lane) => PLATFORMS[lane.platform]?.retired === true),
);

export async function checkLane(
  lane: LaneSpec,
  environmentType: string,
  options: DoctorOptions = {},
): Promise<LaneStatus> {
  const env = options.env ?? process.env;
  const fetcher = options.fetch ?? fetch;

  const vars = missingVars(lane.vars, env);
  const problems = configProblems(vars, environmentType);
  const configured = problems.length === 0;

  // Shape problems do NOT make a lane unconfigured — the value is present, it
  // is just wrong. Keeping them separate means the live check still runs and
  // the platform's own verdict still gets reported alongside our suspicion.
  problems.push(...shapeProblems(vars));

  const base: LaneStatus = {
    platform: lane.platform,
    label: lane.label,
    configured,
    reachable: null,
    detail: configured
      ? "Configured. Live check not attempted."
      : "Not configured — the live check was skipped.",
    problems,
    vars,
  };

  if (!configured || options.offline) return base;

  try {
    const result = await lane.check(env, fetcher);
    return {
      ...base,
      reachable: result.reachable,
      detail: result.detail,
      problems: [...problems, ...result.problems],
    };
  } catch (error) {
    // A thrown check is NOT a pass. Report it as unreachable with the reason.
    return {
      ...base,
      reachable: false,
      detail: "The live check could not complete.",
      problems: [
        ...problems,
        `${lane.label} check threw: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

export interface DoctorReport {
  environmentType: string;
  lanes: LaneStatus[];
  /** Lanes that are configured AND answered. Safe to publish to. */
  ready: PlatformId[];
  /** Configured but the platform refused. These need a fix. */
  broken: PlatformId[];
  /** Not configured at all. Nothing is wrong, they are just not set up. */
  unconfigured: PlatformId[];
}

export async function runPublishDoctor(
  environmentType: string,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  // Sequential on purpose: six concurrent auth calls from one IP is exactly the
  // shape that gets an account rate limited, and this runs rarely.
  const lanes: LaneStatus[] = [];
  for (const lane of LANES) {
    lanes.push(await checkLane(lane, environmentType, options));
  }

  return {
    environmentType,
    lanes,
    ready: lanes.filter((l) => l.reachable === true).map((l) => l.platform),
    // reachable === null is NOT broken and NOT ready. It is "we did not ask".
    broken: lanes.filter((l) => l.configured && l.reachable === false).map((l) => l.platform),
    unconfigured: lanes.filter((l) => !l.configured).map((l) => l.platform),
  };
}

/**
 * A plain-language summary, for someone who does not want to read a JSON blob.
 *
 * FOUR states, not two, and the distinction is the entire point of this file:
 *
 *   OK    checked, and the platform answered
 *   FAIL  checked, and the platform refused
 *   SKIP  configured, but NOT checked — an unknown, not a pass and not a failure
 *   -     not set up at all, which is not a fault
 *
 * Collapsing SKIP into either neighbour is how a doctor starts lying. Reporting
 * it as OK invents an assurance nobody earned; reporting it as FAIL sends
 * somebody debugging a lane that was never tested.
 */
export function summarise(report: DoctorReport): string[] {
  return report.lanes.map((lane) => {
    const mark =
      lane.reachable === true
        ? "OK  "
        : lane.reachable === false
          ? "FAIL"
          : lane.configured
            ? "SKIP"
            : "-   ";
    return `${mark} ${lane.label}: ${lane.detail}`;
  });
}
