/**
 * Captions, generated per platform.
 *
 * One render fans out to several destinations, and posting the identical
 * caption to all of them is a cross-posting fingerprint in its own right —
 * the same reason the scheduler staggers the timing. So each platform gets its
 * own text, generated once per (asset, platform) pair.
 *
 * Every platform's own limit is enforced HERE, after generation, because a
 * model asked for "under 300 characters" will cheerfully return 340. The limit
 * is not a suggestion to the model, it is a hard truncation afterwards —
 * checked on graphemes for Bluesky and code units for Telegram, because that
 * is what each API actually counts.
 *
 * NOTHING HERE CAN PUBLISH. It returns strings. That matters: the model output
 * never chooses a destination, never sees a credential, and cannot cause a
 * post. If the model returns nonsense the worst case is a bad caption, not a
 * bad post to the wrong place.
 */

import { PLATFORMS, type AssetRef, type PlatformId } from "./contentRouting.js";

export const OPENAI_API = "https://api.openai.com/v1/chat/completions";

/** Per-platform caption limits, and what each API actually counts. */
export interface CaptionLimit {
  max: number;
  /** Bluesky counts graphemes; Telegram counts UTF-16 code units. */
  unit: "grapheme" | "codeunit";
}

export const CAPTION_LIMITS: Readonly<Record<PlatformId, CaptionLimit>> = Object.freeze({
  bluesky: { max: 300, unit: "grapheme" },
  telegram: { max: 1024, unit: "codeunit" },
  instagram: { max: 2200, unit: "codeunit" },
  facebook: { max: 2000, unit: "codeunit" },
  tiktok: { max: 2200, unit: "codeunit" },
  youtube: { max: 100, unit: "codeunit" },
  // Reddit's is a post TITLE, not a caption, and 300 is a hard API limit — over
  // it the submission comes back as a TOO_LONG error inside an HTTP 200.
  reddit: { max: 300, unit: "codeunit" },
  fanvue: { max: 1000, unit: "codeunit" },
});

export function measure(text: string, unit: CaptionLimit["unit"]): number {
  if (unit === "codeunit") return text.length;
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let count = 0;
    for (const _ of segmenter.segment(text)) count += 1;
    return count;
  }
  return [...text].length;
}

/**
 * Cut to length without splitting a grapheme or leaving a half-word.
 *
 * Slicing a string at a character index can land inside an emoji and produce a
 * replacement glyph, which looks like a bug in your feed rather than a long
 * caption. Backing off to the last space is cosmetic but free.
 */
export function truncateTo(text: string, limit: CaptionLimit): string {
  if (measure(text, limit.unit) <= limit.max) return text;

  let units: string[];
  if (limit.unit === "grapheme" && typeof Intl !== "undefined" && "Segmenter" in Intl) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    units = [...segmenter.segment(text)].map((s) => s.segment);
  } else {
    units = limit.unit === "grapheme" ? [...text] : text.split("");
  }

  // Leave room for the ellipsis so the RESULT is within the limit, not the
  // text before it.
  const room = Math.max(0, limit.max - 1);
  let cut = units.slice(0, room).join("");
  const lastSpace = cut.lastIndexOf(" ");
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

export interface CaptionContext {
  asset: AssetRef;
  platform: PlatformId;
  /** The link-in-bio or funnel URL this should drive traffic to. */
  linkUrl?: string;
  /** Free-form notes about the render: mood, setting, whatever helps. */
  description?: string;
  /** How hard the call to action pushes. The client's call, not mine. */
  intensity?: "soft" | "direct" | "hard";
}

/**
 * Per-platform style rules.
 *
 * These are about what each platform's audience and format reward, not about
 * what is allowed — the routing rail already decided the post is permitted
 * before this is ever called.
 */
export function styleFor(platform: PlatformId): string {
  switch (platform) {
    case "bluesky":
      return "Conversational and dry. No hashtags — they do almost nothing here. Under 300 characters.";
    case "telegram":
      return "Direct, like a message to people who already subscribed. A single clear call to action.";
    case "instagram":
      return "Visual-first, a line or two, then 3-5 relevant hashtags on their own line.";
    case "facebook":
      return "Slightly longer and warmer. Minimal hashtags.";
    case "tiktok":
      return "Short, hooky, front-loaded. 2-4 trending-style hashtags.";
    case "youtube":
      return "A Shorts TITLE, not a caption. Under 100 characters, hooky, no hashtags.";
    case "reddit":
      return (
        "A post TITLE, not a caption. Under 300 characters. Reddit punishes anything that " +
        "reads like an advert, so: no hashtags, no emoji spam, no 'link in bio'. Write it " +
        "the way a person posting to that community would write it."
      );
    case "fanvue":
      return "Speaking to paying subscribers who already bought. Warm, no hard sell.";
    default:
      return "Short and plain.";
  }
}

/**
 * Whether a promotional link belongs in the caption at all.
 *
 * Reddit is the exception and it is not a style preference: a post title
 * carrying a promo URL reads as advertising, and the outcome is removal by the
 * subreddit or a sitewide spam flag against the account. The traffic comes from
 * the profile instead. Putting the link in anyway would be the kind of mistake
 * that only shows up as posts quietly disappearing.
 */
export function acceptsLinkInCaption(platform: PlatformId): boolean {
  return platform !== "reddit";
}

export function buildPrompt(context: CaptionContext): string {
  const intensity = context.intensity ?? "direct";
  const linkAllowed = acceptsLinkInCaption(context.platform);

  const cta = !linkAllowed
    ? "Do NOT include any URL, and do not mention a link, a bio or subscribing. Write the title only."
    : intensity === "hard"
      ? "End with a strong, explicit instruction to click the link and subscribe."
      : intensity === "soft"
        ? "End with a light, low-pressure mention of the link."
        : "End with a clear call to action pointing at the link.";

  return [
    `Write a single caption for a post on ${PLATFORMS[context.platform]?.label ?? context.platform}.`,
    `Style: ${styleFor(context.platform)}`,
    context.description ? `About the image: ${context.description}` : "",
    context.linkUrl && linkAllowed ? `Link to drive traffic to: ${context.linkUrl}` : "",
    cta,
    "Return ONLY the caption text. No quotes, no preamble, no explanation, no alternatives.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Strip the things a chat model adds even when told not to.
 *
 * Asking for "only the caption" gets you the caption about nine times in ten.
 * The tenth comes wrapped in quotes, or prefixed with "Caption:", or as a
 * numbered list of three options. Cleaning that up is cheaper than a retry and
 * far cheaper than posting `"Caption: 1. ..."` to a public feed.
 */
export function cleanModelOutput(raw: string): string {
  let text = raw.trim();

  // A numbered or bulleted list: take the first item only.
  const listMatch = /^(?:\d+[.)]|[-*•])\s+(.+?)(?:\n|$)/s.exec(text);
  if (listMatch) text = listMatch[1]!.trim();

  text = text.replace(/^(?:caption|post|text)\s*[:\-—]\s*/i, "").trim();

  // Matching wrapping quotes, straight or curly.
  const quoted = /^(["'“”‘’])([\s\S]*)\1$/.exec(text);
  if (quoted) text = quoted[2]!.trim();
  if (/^"[\s\S]*"$/.test(text)) text = text.slice(1, -1).trim();
  if (/^“[\s\S]*”$/.test(text)) text = text.slice(1, -1).trim();

  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export type Fetcher = typeof fetch;

export interface CaptionOptions {
  fetch?: Fetcher;
  apiKey?: string;
  model?: string;
  api?: string;
}

export function openaiKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const key = (env.OPENAI_API_KEY ?? "").trim();
  if (key === "") {
    throw new Error(
      "Cannot generate captions: OPENAI_API_KEY is not set. Trigger.dev variables are " +
        "per-environment — set in Development is not set in Production.",
    );
  }
  return key;
}

/**
 * Generate one caption.
 *
 * Throws rather than returning a placeholder when the model fails. A silent
 * fallback to "New render" would publish for weeks before anyone noticed the
 * captions had stopped being written.
 */
export async function generateCaption(
  context: CaptionContext,
  options: CaptionOptions = {},
): Promise<string> {
  const fetcher = options.fetch ?? fetch;
  const apiKey = options.apiKey ?? openaiKeyFromEnv();
  const model = options.model ?? "gpt-4o-mini";
  const api = options.api ?? OPENAI_API;

  const response = await fetcher(api, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: buildPrompt(context) }],
      // Some variation is the point — identical captions across posts are a
      // spam signal on every one of these platforms.
      temperature: 0.9,
      max_tokens: 400,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body.error?.message ?? "";
    } catch {
      /* status alone will have to do */
    }
    // Never include the key, which is in the Authorization header.
    throw new Error(
      `Caption generation failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`,
    );
  }

  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = body.choices?.[0]?.message?.content;
  if (!raw || raw.trim() === "") {
    throw new Error("Caption generation returned an empty response.");
  }

  const cleaned = cleanModelOutput(raw);
  if (cleaned === "") {
    throw new Error(`Caption generation returned nothing usable: ${JSON.stringify(raw.slice(0, 200))}`);
  }

  const limit = CAPTION_LIMITS[context.platform];
  return limit ? truncateTo(cleaned, limit) : cleaned;
}

/**
 * A deterministic caption, for when generation is not wanted or not available.
 *
 * Deliberately plain. It exists so the pipeline can be tested without spending
 * OpenAI calls, and so a caller can opt out of generation — NOT as a silent
 * fallback when generation fails. Failure throws; this has to be asked for.
 */
export function fallbackCaption(context: CaptionContext): string {
  const name = context.asset.key.split("/").pop() ?? "render";
  const base = context.description?.trim() || `New ${context.asset.kind}: ${name}`;
  const withLink = context.linkUrl ? `${base}\n${context.linkUrl}` : base;
  const limit = CAPTION_LIMITS[context.platform];
  return limit ? truncateTo(withLink, limit) : withLink;
}
