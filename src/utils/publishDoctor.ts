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

import type { PlatformId } from "./contentRouting.js";
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
  const status = String(
    ((member.result ?? {}) as { status?: string }).status ?? "unknown",
  );
  const canPost = ((member.result ?? {}) as { can_post_messages?: boolean }).can_post_messages;

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

const metaCheck =
  (idVar: string, tokenVar: string, field: string, label: string): Check =>
  async (env, fetcher) => {
    const id = (env[idVar] ?? "").trim();
    const token = (env[tokenVar] ?? "").trim();
    const response = await fetcher(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(id)}?fields=${field}&access_token=${encodeURIComponent(token)}`,
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

    const name = String(body[field] ?? body.name ?? body.username ?? id);
    return { reachable: true, detail: `${label} authenticated as "${name}".`, problems: [] };
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

export const LANES: readonly LaneSpec[] = Object.freeze([
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
