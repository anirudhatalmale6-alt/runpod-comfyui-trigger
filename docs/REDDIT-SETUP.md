# Reddit setup

Four steps. Do them in order. Nothing here needs the terminal.

Total time is about ten minutes, and most of that is step 4 waiting on Reddit.

---

## Step 1 — Create the Reddit app (2 minutes)

This is how the system gets permission to post as your account. It does not
give anyone else access, and you can delete it at any time.

1. Sign in to Reddit as the account that will be posting.
2. Go to **https://www.reddit.com/prefs/apps**
3. Scroll to the bottom. Click **"are you a developer? create an app..."**
4. Fill the form in exactly like this:

   | Field | What to put |
   |---|---|
   | **name** | `ava-publisher` (any name, it is only a label) |
   | **type** | Select **script**. ⚠️ This one matters — see below. |
   | **description** | Leave blank |
   | **about url** | Leave blank |
   | **redirect uri** | `http://localhost:8080` |

5. Click **create app**.

> ⚠️ **It must be "script".** The other types use a different login flow that
> will not work here, and the failure shows up later as a confusing 401 that
> looks like a wrong password. If you pick the wrong one, just delete the app
> and make another — there is no penalty.

---

## Step 2 — Find the two values

After creating it, the app appears in a box on that same page.

- The **client id** is the short string directly **under the app name**, near
  the words "personal use script". It is about 14 characters. It has no label
  next to it, which is why people miss it.
- The **client secret** is on the line labelled **secret**.

Keep that page open for the next step.

---

## Step 3 — Put them into Trigger.dev

Go to your Trigger.dev project → **Environment Variables**, and add these four.

**Set them in Production.** Also set them in Development if you want to test
from your own machine later — Trigger.dev keeps the two completely separate, and
a variable set in one is genuinely missing in the other. That exact thing has
cost us time twice on this project already.

| Variable | Value |
|---|---|
| `REDDIT_CLIENT_ID` | the short string under the app name |
| `REDDIT_CLIENT_SECRET` | the value on the `secret` line |
| `REDDIT_USERNAME` | your Reddit username, without `u/` |
| `REDDIT_PASSWORD` | your Reddit account password |

Do not paste any of these into chat. I never need to see them — they go
straight from you into Trigger.dev, and the code reads them there.

> **If the account has two-factor authentication on**, the password login will
> not work on its own. Tell me and I will switch that lane to a different login
> method. Do not turn 2FA off for this.

---

## Step 4 — Tell me the subreddits

Send me the **names only**, for example:

```
r/somesubreddit
r/anothersubreddit
```

I add each one to the code deliberately, because three things have to be decided
per subreddit and none of them can be guessed safely:

1. **Whether explicit content is allowed there.** Reddit's rules are
   per-community. The same photo can be fine in one sub and a permanent ban in
   another, so no subreddit accepts explicit material until you have confirmed
   that specific one by name.
2. **Whether it requires post flair.** Many do, and a post without the right
   flair is rejected outright.
3. **Whether the account can post there at all.** Most creator subs have
   minimum account age and karma rules.

---

## What I have already handled

You do not need to do anything about these.

- **Reddit reports rejected posts as successes.** If a sub needs flair, or the
  account is too new, or you have posted too often, Reddit answers with an
  HTTP 200 and buries the real reason in the response body. Written the ordinary
  way, this system would have told you fifty posts went out when none existed.
  It treats that as a failure now, loudly, with the reason translated.
- **No promo links in titles.** Reddit treats that as advertising and pulls the
  post. Captions for this lane are generated without the Fanvue link — the
  traffic goes via your profile instead.
- **Title length.** Reddit's limit is 300 characters and captions are cut to fit
  before sending, rather than being rejected after.
- **Image format.** Reddit takes JPEG, PNG and GIF but not WebP. The pipeline
  prefers the `-web.jpg` derivative and explains itself if it cannot.

---

## Things that will need you, and cannot be automated by anyone

- **Verification posts.** Most NSFW creator subs require a one-off photo
  holding a handwritten sign with your username and the date. It is a human
  check by the moderators. You do it once per sub, by hand.
- **Karma and account age.** Some subs will not accept posts from a new account
  regardless of what the API does. If we hit that, the error will say so
  clearly rather than failing silently.

---

## Testing before any of your real subs are involved

`r/test` and `r/testingground4bots` are configured as sandboxes, so the lane can
be proven end to end without touching your audience. Once the four variables
above are set, one test payload attempts a post there.

Both are seeded as *candidates*, not as verified-working. Reddit blocks
unauthenticated reads from my server, so I could not check from here whether
either accepts image posts from a brand-new account — some testing subs are
text-only, and some have their own karma rules. If the first run comes back with
`NO_LINKS` or `SUBREDDIT_NOTALLOWED`, that is this, not a bug: the adapter
translates the reason and we pick a different sandbox. It costs one run to find
out.

For the same reason, the exact button wording in step 1 may have shifted since I
last saw that page — I could not load it from here to check. The shape of the
flow is right even if a label reads slightly differently.
