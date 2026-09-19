# Facebook: the last step

**Roughly ten minutes.** Everything else is already built — this is one new app and
one token.

---

## Why a new app

Meta said it outright:

> All available use cases have been added to this app. **Create a new app if use
> cases you want to add aren't available.**

The existing app (`Ava Ines Creator Automation`, `1424052319603432`) was created
with a fixed set of use cases — Facebook Login and Ads Manager. Neither grants
Page posting, and Meta will not let you add one after the fact. That is why the
System User's permission list came back empty, and almost certainly why
`pages_manage_posts` never appeared in the Graph API Explorer dropdown either.

The permission was never hidden. It never existed for that app.

---

## What is already done (none of this needs repeating)

| Thing | State |
|---|---|
| Facebook Page `AvaInes` | In the **Dan** portfolio |
| Instagram `ava_ines_ai` | In the **Dan** portfolio |
| System user `ava-publisher` | Created, Employee access |
| Page + Instagram assigned to it | Full access |
| Old app moved out of Mahrkie into Dan | Done |
| Trigger.dev deploy `20260918.1` | Live, with `publish-doctor` |

The structural work — which was the hard part and took most of a day — carries
over completely.

---

## Step 1 — Create the app (3 minutes)

1. Go to **https://developers.facebook.com/apps**
2. Click **Create App**
3. When it asks what you want your app to do, choose the **Page** option. It is
   worded something like *"Manage everything on your Page"*. **This choice is the
   whole point** — it is what makes the posting permissions exist at all, and it
   cannot be changed later.
4. Name it something you will recognise: `ava-page-publisher`
5. **When it asks for a Business portfolio, choose `Dan`.**

> ⚠️ Step 5 matters. Creating it inside Dan means the app is owned by the same
> business that owns the Page from the very start — which skips the whole
> add-to-portfolio and release-from-Mahrkie dance we did last night.

> ⚠️ Do **not** create a Test app. The one we tried first was a test clone, and
> test apps are sandboxes that cannot post to a real Page.

---

## Step 2 — Give the system user the app (1 minute)

1. **https://business.facebook.com/latest/settings/system_users?business_id=1602575308237584**
2. Click **ava-publisher**
3. **Assign assets** → **Apps** → select your new app
4. Turn on **Develop app** only. Leave `Manage app` off — it is not needed to post.
5. Assign

---

## Step 3 — Generate the token (2 minutes)

Still on `ava-publisher`:

1. **Generate token**
2. Pick the new app
3. Tick:
   - `pages_show_list`
   - `pages_read_engagement`
   - `pages_manage_posts`
   - and `instagram_basic` / `instagram_content_publish` if they appear — that
     would mean Instagram works too
4. Generate

**Meta shows the token exactly once.** Copy it immediately.

---

## Step 4 — Store it and check (2 minutes)

1. Trigger.dev → **Environment Variables** → **Production**
2. Set `FACEBOOK_PAGE_ACCESS_TOKEN` to the new token
3. Run the **publish-doctor** task with `{}`

Expect:

```
OK   Facebook: Facebook authenticated as "AvaInes".
```

If it still says `CANNOT PUBLISH`, the doctor will now name which scope is
missing and whether it was declined or never offered — so that is a specific
answer, not another hunt.

---

## Then the real test

```json
{
  "key": "safe/affogato-2ce2f37b.jpeg",
  "kind": "image",
  "platform": "facebook",
  "text": "Testing the Facebook connection."
}
```

Run `publish-one` with that. If it posts, the Facebook lane is live — on the
platform doing 2,202 link clicks at $0.02 each, which is the one worth having.

---

## Afterwards, when there is no rush

Two bits of tidying, neither urgent:

1. **Trim the Page permission.** `ava-publisher` currently has *Full access* on
   the Page where it only needs *Content*. Reducing it does **not** require a new
   token — a system user's powers follow the current assignment.
2. **The `UnclaimedBusinessUser FromPool` account** in the Dan portfolio has full
   control and can delete the portfolio. It is a leftover from the portfolio being
   auto-created through Instagram. Worth removing once everything works.
