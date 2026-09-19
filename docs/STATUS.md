# Where this actually stands

Written 19 Sep 2026, and deliberately strict about the difference between
**configured**, **authenticated** and **proven**. Those three have been
confused repeatedly on this project and each confusion cost hours.

- **configured** — the variables are set. Proves nothing.
- **authenticated** — the platform accepts the credentials. Still proves
  nothing about publishing: a token authenticated perfectly for two days while
  being unable to post.
- **proven** — something was actually published and a human could see it.

---

## Lanes

| Lane | State | Notes |
|---|---|---|
| **Bluesky** | ✅ **PROVEN** | A real post exists. The only lane that has genuinely published. |
| **Facebook** | 🟡 authenticated | Doctor reports the correct Page (`AvaInes`). Blocked tonight by the page-token bug, fixed in `e6ad295`. Untested since. |
| **Instagram** | 🟡 authenticated | Reports `ava_ines_ai`. Same fix applies. Never published. |
| **Telegram** | 🟡 authenticated | Bot is an administrator of the channel and may post. Never published. |
| **TikTok** | ❌ broken | `TIKTOK_ACCESS_TOKEN` is 16 characters; a real one is 100+. Wrong value, not expired. |
| **Reddit** | ❌ not set up | Client id is 3 chars, secret 4 — placeholders. Username has whitespace. See `REDDIT-SETUP.md`. |

**Four lanes authenticate. One has ever published.** That gap is the next job.

---

## Next session, in order

1. **Redeploy.** The page-token fix is not in production yet.
   ```
   curl -fL -o src/trigger/publishPipeline.standalone.ts \
     https://raw.githubusercontent.com/anirudhatalmale6-alt/runpod-comfyui-trigger/main/standalone/publishPipeline.standalone.ts
   md5 -q src/trigger/publishPipeline.standalone.ts   # b946a898af0de8a4f3d688e7ce1bb40d
   ```
   then deploy.

2. **Three posts**, same payload with `platform` swapped:
   ```json
   { "key": "safe/affogato-2ce2f37b.jpeg", "kind": "image",
     "platform": "facebook", "text": "Testing the Facebook connection." }
   ```
   facebook → instagram → telegram.

3. **TikTok and Reddit** credentials. Ordinary setup now; both are understood.

---

## The Meta situation, resolved

Three days were lost to Meta, and the causes were nested. Recording them so
nobody re-derives this:

1. The Facebook Page lived in a business portfolio (**Dan**) that the client did
   not realise was separate. The app lived in a *different* one (**Mahrkie**). A
   system user can only issue tokens for apps in its own portfolio.
2. The app had only **Facebook Login** and **Ads Manager** use cases. In Meta's
   current model, permissions do not exist until a use case declares them — so
   `pages_manage_posts` was not hidden or declined, it had never existed for
   that app. Meta refuses to add a use case after the fact.
3. A new app, created **inside the Dan portfolio** with the *Manage everything
   on your Page* and *Manage messaging & content on Instagram* use cases, made
   every permission appear immediately.
4. Then my own bug: publishing used the system user token directly. Meta wants
   a **page** token, and answers a user token with
   `(#200) publish_actions ... deprecated` — a permission removed in 2018 that
   nothing had requested. Fixed by deriving the page token first.

Theories that were **wrong** along the way, recorded so they are not revisited:
the app type, a scrolling bug in the Explorer permission picker, a declined
scope, and the Instagram account itself. Every one was a guess at *why a
permission was absent*; the answer was that nothing had ever declared it.

---

## Current identifiers

| Thing | Value |
|---|---|
| Business portfolio (owns Page, Instagram, system user) | `Dan` — `1602575308237584` |
| App in use | `Ava_Ines_Creator` — `1413541724088446` |
| System user | `ava-publisher` — `61594557598547` |
| Facebook Page | `AvaInes` |
| Instagram | `ava_ines_ai` |
| Deployed version at time of writing | `20260918.1` (predates the page-token fix) |

Dead: app `1424052319603432` (old, no Page use case), app `1032053316532403`
(test clone).

---

## Not yet built

- **Fanvue purchase → delivery.** The "selling it" half. `contentDelivery.ts`
  exists and is tested; the webhook that triggers it does not.
- **Failure alerts.** Nothing tells anyone when a scheduled post fails. This is
  what makes unattended running real, and it does not exist.
- **The scheduler has never driven a real post.** Both live Bluesky posts were
  triggered by hand. `publish-planner` is tested but unproven in anger.
- **No GPU render has ever reached storage.** Every file tested so far was
  placed by hand.

---

## Deferred tidy-ups

Neither urgent, both worth doing once posting works:

1. `ava-publisher` has *Full access* on the Page where it needs only *Content*,
   and extra app permissions beyond `Develop app`. Reducing them needs **no new
   token** — a system user's powers follow the current assignment.
2. `UnclaimedBusinessUser FromPool` in the Dan portfolio has full control and
   can delete the portfolio. A leftover from the portfolio being auto-created
   through Instagram.
