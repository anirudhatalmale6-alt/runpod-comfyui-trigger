# Instagram (and Facebook) setup

You are further along than this document makes it look. Two of the three
problems are already solved — the token is valid and the account ID is right.
What is left is one permission.

**Start at step 1. It is a single link and it tells us which of two problems you
have, so you do not have to guess.**

---

## Step 1 — Find out what your token can actually do

Open this in your browser, with your own token on the end:

```
https://graph.facebook.com/v21.0/me/permissions?access_token=PASTE_YOUR_TOKEN
```

You will get back a list like this:

```json
{"data":[
  {"permission":"instagram_basic","status":"granted"},
  {"permission":"instagram_content_publish","status":"declined"},
  {"permission":"pages_show_list","status":"granted"}
]}
```

Look for the line containing **instagram_content_publish**. There are exactly
three things you can see, and each means something different:

| What you see | What it means | Go to |
|---|---|---|
| `"status":"granted"` | The token is fine. Something else is wrong. | Step 4 |
| `"status":"declined"` | It exists but was not approved when you generated the token. | Step 2 |
| **not in the list at all** | Your app cannot offer this permission. | Step 3 |

That third case is the one I suspect, and it is the one where ticking boxes
forever will never help — the box is not there to tick.

You do not need to send me the output. Just tell me which of the three you see.

---

## Step 2 — It says "declined"

The permission exists, but you did not approve it when the token was made. This
usually happens by clicking through the approval dialog quickly.

1. Go to https://developers.facebook.com/tools/explorer/
2. Select your app, top right.
3. Tick `instagram_basic`, `instagram_content_publish`, `pages_show_list`,
   `pages_read_engagement`.
4. Click **Generate Access Token**.
5. **On the Facebook dialog that opens, do not click through quickly.** If it
   offers a list of Pages, select your Page explicitly. If it asks about
   Instagram, say yes. Declining any part of it here is what produced the
   "declined" status.
6. Put the new token in `INSTAGRAM_ACCESS_TOKEN` and re-run.

Then repeat Step 1 to confirm it now says `granted`. Do not skip that — a token
that was declined once looks identical to a working one from the outside.

---

## Step 3 — It is not in the list at all

This means your app is not eligible for the permission, which is almost always
the **app type**. Instagram publishing requires a **Business** type app. An app
created as "Consumer" is never offered `instagram_content_publish`, no matter
what you tick.

Check it:

1. https://developers.facebook.com/apps/ → select your app
2. Left sidebar → **App settings** → **Basic**
3. Scroll to the bottom. There is an **App type** row.

If it does not say Business, that is our answer. Meta does not let you change
the type freely once products are added — in practice it is faster to create a
new app of the right type than to fight the existing one. That sounds worse than
it is: it is the same form you filled in before, and the token and ID you have
already sorted out are the hard parts.

Also check, in the left sidebar, that **Instagram** appears in your list of
Products. If it does not, add it — the permission is not offered until the
product is.

---

## Step 4 — Everything says "granted" and it still fails

Then it is one of these, in order of likelihood:

1. **Your Instagram account is not a professional account.** Personal accounts
   cannot be published to by any API. In the Instagram app: Settings → Account
   type → switch to Business or Creator. This is free and reversible.
2. **The Instagram account is not linked to the Facebook Page.** Check on the
   Page: Settings → Linked accounts → Instagram.
3. **Your app is in Live mode without review.** Development mode is actually the
   easier place to be while it is only your own account. Live mode is what
   requires the review.

---

## About token expiry

The token from Graph API Explorer lasts about an hour. That is fine for proving
this works — but once it does, tell me and I will set up the long-lived one so
it stops expiring. That is a single call, not another process.

If Instagram works today and mysteriously stops tomorrow, this is why, and it is
not a new bug.

---

## If this stays stubborn

Instagram is the hardest of the six lanes by a wide margin — more trouble than
the other five put together. It is one lane, and it does not block any of the
others. If it fights, we park it, get Telegram, TikTok, Reddit and Bluesky
running, and come back to it.

Bluesky already posts. That path is proven end to end.
