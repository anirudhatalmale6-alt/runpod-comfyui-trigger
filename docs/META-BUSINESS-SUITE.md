# Posting Instagram and Facebook without the API

This is the way round Meta's developer dashboard. No app, no permissions, no
review, no code. It is free and it is Meta's own tool.

It is not automation — you click the buttons. But you can sit down once a week
and queue up the whole week, which at your current volume is a few minutes.

**You already had the right page open.** `business.facebook.com` is exactly it.

---

## One-time setup

1. Go to **https://business.facebook.com**
2. Click **Continue with Facebook** — not "Continue with Instagram". You want
   the Facebook account that manages your Page, because that is what has both
   the Page and the Instagram account attached to it.
3. If it asks which Business Portfolio to use, pick the one with your Page in it.
   If you have never made one it will offer to create one — that is fine, it is
   a name and a click.
4. Once inside, check the account switcher at the top left shows both your
   Facebook Page and your Instagram account. If Instagram is missing, there is a
   **Connect Instagram** option in Settings — that link is the only thing that
   has to be in place.

That is the whole setup. Nothing to approve, nothing to wait for.

---

## Scheduling a post

1. Left sidebar → **Content**
2. Click **Create post** (or **Create reel** for video)
3. At the top it asks where to post. **Tick both Facebook and Instagram.** One
   composer, both platforms, one action.
4. Add the image, write the caption.
5. Instead of clicking Publish, click the **arrow next to it** and choose
   **Schedule**. Pick the date and time.
6. Done. It appears in **Planner** where you can drag it to a different slot or
   delete it.

**Planner** is the view worth knowing about — left sidebar → Content → Planner.
It is a calendar of everything queued, and it is where a week's posting takes a
few minutes rather than seven separate visits.

---

## Captions

The system already writes captions for the automated lanes. If you want them for
these two as well, say so and I will add a task that generates a batch you can
paste in — you would get the same wording the automated lanes use, so
Instagram and Bluesky do not read like two different people.

---

## Getting the images out of storage

Your renders live in Tigris, and Business Suite wants a file from your computer.

Two options:

1. **Tigris console** — open the bucket, tick the files, download. Fine for a
   handful.
2. **Tell me and I will build a download task** — one run, and you get a list of
   links for the week's `safe/` renders that you click and save. Better if this
   becomes a weekly habit.

Do not spend long on this by hand. If it is annoying more than once, it is worth
me automating the boring half even though the posting itself stays manual.

---

## What this does and does not change

**Does not change:** Bluesky, Telegram, Reddit and TikTok still automate
properly. This is only for the two lanes Meta has made difficult.

**Does not throw anything away:** the Instagram code is written, tested and
sitting in the repo. The day the app is set up correctly, it starts working —
nothing needs rebuilding.

**Worth revisiting when:** you are posting often enough that doing it by hand is
genuinely a chore. At that point the API is worth the paperwork. Right now it
is not, which is the whole reason we are here.
