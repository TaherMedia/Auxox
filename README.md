# Auxox — Cloudflare Workers port

Single-file rewrite of `bot.py` for Cloudflare Workers: D1 for storage, a
Telegram webhook instead of polling, Cron Triggers for the name-clock and
premium-expiry jobs, and a password-protected web admin panel replacing the
old Telegram-native admin menu entirely.

**Files:**
- `worker.js` — everything: bot logic, business-mode automation, cron jobs,
  admin API, and the admin panel's HTML/CSS/JS, all in one file. The schema
  is embedded too and self-creates on first request (`CREATE TABLE IF NOT
  EXISTS…`) — there's no separate `schema.sql` to run.
- `wrangler.toml` — Cloudflare project config (D1 binding, cron schedule).
  This can't be JS — it's Cloudflare's own project-config format, required
  for any Workers + D1 project.

I tested this against a real SQLite engine (Node's `node:sqlite`) standing
in for D1, with Telegram's API mocked, exercising the full webhook →
captcha → premium → business-connection → auto-read/auto-reply/anti-delete
→ cron → admin-panel path end to end. That catches logic bugs; it can't
catch everything a live Telegram/Cloudflare environment might surface, so
treat first deployment as a test pass, ideally with a second bot token
before pointing it at real users.

## 1. Prerequisites

- Node.js and `npm install -g wrangler` (or `npx wrangler`)
- A Cloudflare account (Workers + D1)
- **Two** Telegram bots from [@BotFather](https://t.me/BotFather): your main
  bot, and a second "alerts" bot used only to deliver anti-delete
  notifications (`NOTIF_TOKEN`) — this mirrors `bot.py`'s design exactly.

## 2. Create the D1 database

```
wrangler d1 create auxox-db
```

Copy the `database_id` it prints into `wrangler.toml`.

## 3. Set secrets

```
wrangler secret put BOT_TOKEN      # main bot token from BotFather
wrangler secret put NOTIF_TOKEN    # second bot token, alerts-only
wrangler secret put PASSWORD       # admin panel login password
wrangler secret put SECRET         # any random string — webhook auth token
wrangler secret put LOG_CHANNEL    # optional: chat id for admin-action logs
wrangler secret put REVIEW_ID      # optional: chat id for live message mirror
```

`LOG_CHANNEL`/`REVIEW_ID` can be set to an empty string if you don't want
them yet — both bots need to be added to those chats as admins if you use
them, same as in `bot.py`.

## 4. Deploy

```
wrangler deploy
```

Note the `https://….workers.dev` URL it gives you.

## 5. Set the webhooks

Open `https://your-worker.workers.dev/`, log in with `PASSWORD`, go to
**Settings → Webhook**, enter your worker's base URL and re-enter `SECRET`
to confirm, then **Set Webhooks**. This registers *both* bots:
`BOT_TOKEN` → `/webhook`, `NOTIF_TOKEN` → `/webhook/notif`.

(If you'd rather do it by hand: `POST` to
`https://api.telegram.org/bot<TOKEN>/setWebhook` with `url` and
`secret_token` — the panel just does this for you and adds the
`allowed_updates` list business mode needs, in particular
`business_connection`, `business_message`, and `deleted_business_messages`,
which Telegram won't send unless you ask for them.)

## 6. You're live

Message your main bot with `/start`. The old `/admin` Telegram command is
gone by design (see §9 below) — all admin work happens on the web panel.

---

## Operational limits worth knowing

- **Free Workers plan: 10ms CPU time per invocation**, including Cron
  Triggers. The name-clock job and the broadcast loop both do real work per
  user (a D1 query, a Telegram API call). Once you have more than a
  handful of active users, 10ms won't be enough and ticks will start
  failing partway through. `wrangler.toml` sets `cpu_ms = 300000`, but that
  only takes effect on a **Workers Paid** plan ($5/mo) — the free plan's
  cap can't be raised. Budget for Paid plan for anything beyond testing.
- **Free plan: 50 subrequests per invocation** (10,000 on Paid). Broadcasting
  to more than ~50 users needs Paid regardless of CPU time.
- Broadcast/forward run in the background via `ctx.waitUntil` after the
  admin panel gets an immediate "started" response, with progress polled
  from the panel. For very large user bases (thousands), a single
  invocation could still be tight even on Paid — there's no multi-invocation
  batching here; if you hit that scale, that's the piece to extend next.

## Notes on fidelity to `bot.py`

Ported feature-for-feature, with these adjustments — all necessary
consequences of moving from a long-running polling process with in-memory
state to a stateless, per-request Worker:

- **Conversation state** (top-up amount, name-clock timezone/font, auto-reply
  capture) used to live in `ctx.user_data` in memory. It now lives in a
  `bot_state` D1 row per user, since nothing persists between webhook
  calls. Functionally identical from the user's side.
- **Rate limiting** used an in-memory sliding timestamp list; it's now a
  two-tier fixed-window counter in the same `bot_state` row. Same practical
  effect (burst + sustained caps), simpler storage.
- **The per-invoice expiry job** was a Python `run_once` callback scheduled
  3 hours out per invoice. Workers cron can't schedule arbitrary one-off
  future jobs, so the per-minute cron sweeps for `paid=0 AND expires_at <
  now` instead — same outcome, different mechanism.
- **Button "style" metadata** (`api_kwargs={"style": ...}`) in the Python
  source wasn't a real Telegram Bot API field — Telegram has no client-side
  button coloring — so it was already inert. Dropped; the emoji/wording on
  each button still carries the meaning it always did.
- **Fonts** are generated from Unicode math-alphanumeric code-point ranges
  at startup rather than loaded from `fonts.json`, per your request to keep
  everything in the one file. 13 styles, same idea as the original.

## New admin-panel features (not in `bot.py`)

These were requested but have no Python-side equivalent to port, so here's
what each one actually does:

- **Create User** calls Telegram's `getBusinessConnection` with the ID you
  provide and only saves it if the returned connection's owner matches the
  user ID you typed. Useful for support/recovery — re-linking an account if
  its row is somehow lost — but note a legitimate end user never sees
  their own `business_connection_id` anywhere in Telegram's UI to hand you,
  since it's an internal identifier Telegram only delivers to your bot's
  webhook. It's meant for you as the operator, not something to solicit
  from users at large.
- **Per-user automation control** writes to the exact same
  `automation_settings` row the Telegram-side menu writes to — toggling it
  from the panel is indistinguishable from the user toggling it themselves.
  The one difference: an admin-set auto-reply is plain text only (a web
  textarea can't capture a Telegram message's rich media), while a
  user-set one can be any message type via copy. Both are honored.
- **Message Review** lists the same `messages` table anti-delete reads
  from, filterable by owner. If `REVIEW_ID` is set, every incoming business
  message is also mirrored there live, separate from the deletion-alert
  flow.
- **Gift checks** are redeemed via a typed `/start check=<code>` command,
  not a tappable link — Telegram's deep-link `start` parameter only allows
  `A-Za-z0-9_-`, so `check=` (with an `=`) can't be encoded into a `t.me`
  link. The panel gives you the exact command to share.

## Admin session security

- Password check is timing-safe-compared against `PASSWORD`.
- Sessions are 30-minute sliding-idle: any admin action refreshes it,
  inactivity expires it, matching what you asked for.
- Login is rate-limited: 5 wrong attempts within 10 minutes locks that IP
  out for 15 minutes.
- The panel is unauthenticated-readable at `/` (it's just the login
  screen — no data loads without a valid session), so there's no secrecy
  in the URL itself; `PASSWORD` is the actual gate. Consider adding
  Cloudflare Access in front of the `*.workers.dev` URL if you want a
  second layer.
