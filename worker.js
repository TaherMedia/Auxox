/* ════════════════════════════════════════════════════════════════════════
 *  AUXOX — Business Automation Bot  (Cloudflare Workers port of bot.py)
 *  Single-file Worker · D1 storage · Telegram webhook · Cron name-clock
 *  Bot API business-mode (getBusinessConnection, setBusinessAccountName,
 *  readBusinessMessage, business_message / deleted_business_messages, …)
 *
 *  Secrets (wrangler secret put …):
 *    BOT_TOKEN    main bot token
 *    NOTIF_TOKEN  second bot — sends anti-delete alerts only
 *    PASSWORD     admin web-panel password
 *    SECRET       Telegram webhook secret token
 *    LOG_CHANNEL  optional numeric chat id — admin action log (may be empty)
 *    REVIEW_ID    optional numeric chat id — live business-message mirror
 *
 *  Bindings (wrangler.toml):
 *    DB           D1 database
 * ════════════════════════════════════════════════════════════════════════ */

// ═══════════════════════════ STATIC CONFIG ═══════════════════════════════
const SUPPORT_USERNAME = '@AuxoxSup';
const FONTS_PER_PAGE = 12;
const ADMIN_SESSION_MAX_IDLE_MIN = 30;
const AUTO_REPLY_COOLDOWN_MIN = 30;

const SETTINGS_DEFAULTS = {
  min_charge: '1',
  max_charge: '10000',
  broadcast_delay_ms: '40',
  name_auto_update_interval: '60',
  max_message_age_days: '30',
  rate_limit_1_limit: '10',
  rate_limit_1_interval: '10',
  rate_limit_1_block_secs: '30',
  rate_limit_2_limit: '40',
  rate_limit_2_interval: '60',
  rate_limit_2_block_mins: '5',
  price_per_day: '1',
};

const PREMIUM_PLANS = [
  { days: 3, label: '3 Days', canFree: true },
  { days: 7, label: '7 Days' },
  { days: 15, label: '15 Days' },
  { days: 30, label: '1 Month' },
  { days: 90, label: '3 Months' },
  { days: 180, label: '6 Months' },
  { days: 365, label: '1 Year' },
];

// ═══════════════════════════ FONTS (embedded) ═════════════════════════════
// Digit blocks where codepoint(base) === '0' and run sequentially to '9'.
function digitMapZeroBased(base) {
  const map = {};
  for (let d = 0; d <= 9; d++) map[String(d)] = String.fromCodePoint(base + d);
  return map;
}
// Digit blocks that only define '1'..'9' sequentially (base === '1'); '0' (if any) supplied separately.
function digitMapOneBased(base, zeroCp) {
  const map = {};
  for (let d = 1; d <= 9; d++) map[String(d)] = String.fromCodePoint(base + d - 1);
  if (zeroCp) map['0'] = String.fromCodePoint(zeroCp);
  return map;
}

function buildFonts() {
  return [
    { id: 0, name: 'Normal', sample: '12:30', prefix: '', suffix: '', map: null },
    { id: 1, name: 'Fullwidth', sample: '12:30', prefix: '', suffix: '',
      map: { ...digitMapZeroBased(0xFF10), ':': '\uFF1A' } },
    { id: 2, name: 'Circled', sample: '12:30', prefix: '', suffix: '',
      map: digitMapOneBased(0x2460, 0x24EA) },
    { id: 3, name: 'Double-Struck', sample: '12:30', prefix: '', suffix: '',
      map: digitMapZeroBased(0x1D7D8) },
    { id: 4, name: 'Sans', sample: '12:30', prefix: '', suffix: '',
      map: digitMapZeroBased(0x1D7E2) },
    { id: 5, name: 'Sans Bold', sample: '12:30', prefix: '', suffix: '',
      map: digitMapZeroBased(0x1D7EC) },
    { id: 6, name: 'Bold', sample: '12:30', prefix: '', suffix: '',
      map: digitMapZeroBased(0x1D7CE) },
    { id: 7, name: 'Monospace', sample: '12:30', prefix: '', suffix: '',
      map: digitMapZeroBased(0x1D7F6) },
    { id: 8, name: 'Subscript', sample: '12:30', prefix: '', suffix: '',
      map: digitMapZeroBased(0x2080) },
    { id: 9, name: 'Superscript', sample: '12:30', prefix: '', suffix: '',
      map: { '0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074',
              '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079' } },
    { id: 10, name: 'Clock', sample: '12:30', prefix: '\u{1F550} ', suffix: '', map: null },
    { id: 11, name: 'Brackets', sample: '12:30', prefix: '\u3010', suffix: '\u3011', map: null },
    { id: 12, name: 'Dotted', sample: '12:30', prefix: '\u2022 ', suffix: ' \u2022', map: null },
  ];
}
const FONTS = buildFonts();

function applyFont(text, fontId) {
  const font = FONTS.find((f) => f.id === fontId) || FONTS[0];
  const mapped = font.map ? [...text].map((ch) => font.map[ch] || ch).join('') : text;
  return `${font.prefix || ''}${mapped}${font.suffix || ''}`;
}

function cleanTime(name) {
  if (!name) return '';
  let out = name.replace(/\bTIME\(\d{1,2}:\d{2}\)/g, '');
  out = out.replace(/\s*\d{1,2}:\d{2}\s*$/, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

// ═══════════════════════════ D1 SCHEMA (self-migrating) ═══════════════════
const SCHEMA_STATEMENTS = [
`CREATE TABLE IF NOT EXISTS users (
  user_id          INTEGER PRIMARY KEY,
  username         TEXT    DEFAULT '',
  first_name       TEXT    DEFAULT '',
  last_name        TEXT    DEFAULT '',
  balance          REAL    DEFAULT 0,
  join_date        TEXT,
  is_banned        INTEGER DEFAULT 0,
  captcha_passed   INTEGER DEFAULT 0,
  free_trial_used  INTEGER DEFAULT 0,
  referral_by      INTEGER
)`,
`CREATE TABLE IF NOT EXISTS premium_bundles (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL,
  expires_at    TEXT    NOT NULL,
  duration_days INTEGER NOT NULL,
  is_active     INTEGER DEFAULT 1,
  is_queued     INTEGER DEFAULT 0
)`,
`CREATE INDEX IF NOT EXISTS idx_pb_user ON premium_bundles(user_id)`,
`CREATE TABLE IF NOT EXISTS transactions (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                    INTEGER NOT NULL,
  amount                     REAL    NOT NULL,
  type                       TEXT    NOT NULL,
  created_at                 TEXT    NOT NULL,
  telegram_payment_charge_id TEXT    DEFAULT ''
)`,
`CREATE TABLE IF NOT EXISTS invoices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  amount      INTEGER NOT NULL,
  payload     TEXT    UNIQUE NOT NULL,
  created_at  TEXT    NOT NULL,
  expires_at  TEXT    NOT NULL,
  paid        INTEGER DEFAULT 0
)`,
`CREATE TABLE IF NOT EXISTS checks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  code       TEXT    UNIQUE NOT NULL,
  amount     INTEGER NOT NULL,
  created_at TEXT    NOT NULL,
  max_uses   INTEGER NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS check_uses (
  check_id INTEGER NOT NULL,
  user_id  INTEGER NOT NULL,
  used_at  TEXT    NOT NULL,
  PRIMARY KEY (check_id, user_id)
)`,
`CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`,
`CREATE TABLE IF NOT EXISTS business_connections (
  user_id       INTEGER PRIMARY KEY,
  connection_id TEXT    NOT NULL,
  connected_at  TEXT    NOT NULL,
  is_active     INTEGER DEFAULT 1
)`,
`CREATE TABLE IF NOT EXISTS automation_settings (
  user_id                    INTEGER PRIMARY KEY,
  name_auto_enabled          INTEGER DEFAULT 0,
  tz_offset                  REAL    DEFAULT 0,
  font_id                    INTEGER DEFAULT 0,
  original_first_name        TEXT    DEFAULT '',
  original_last_name         TEXT    DEFAULT '',
  auto_read_enabled          INTEGER DEFAULT 0,
  anti_delete_enabled        INTEGER DEFAULT 0,
  auto_response_enabled      INTEGER DEFAULT 0,
  auto_response_chat_id      INTEGER DEFAULT 0,
  auto_response_message_id   INTEGER DEFAULT 0,
  auto_response_text         TEXT    DEFAULT '',
  last_auto_response         TEXT    DEFAULT ''
)`,
`CREATE TABLE IF NOT EXISTS notif_users (
  user_id    INTEGER PRIMARY KEY,
  started_at TEXT
)`,
`CREATE TABLE IF NOT EXISTS messages (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  business_connection_id TEXT    NOT NULL,
  chat_id                INTEGER NOT NULL,
  message_id             INTEGER NOT NULL,
  from_user_id           INTEGER DEFAULT 0,
  from_name              TEXT    DEFAULT '',
  from_username          TEXT    DEFAULT '',
  text                   TEXT    DEFAULT '',
  media_type             TEXT    DEFAULT 'text',
  file_id                TEXT    DEFAULT '',
  date                   TEXT    NOT NULL,
  saved_at               TEXT    NOT NULL,
  UNIQUE(business_connection_id, chat_id, message_id)
)`,
`CREATE INDEX IF NOT EXISTS idx_msgs_bc ON messages(business_connection_id, chat_id, message_id)`,
`CREATE INDEX IF NOT EXISTS idx_msgs_saved ON messages(saved_at)`,
// Per-user transient runtime state: captcha, multi-step "conversations", rate limiting.
// Replaces python-telegram-bot's in-memory ctx.user_data, which cannot survive
// across stateless Worker invocations.
`CREATE TABLE IF NOT EXISTS bot_state (
  user_id          INTEGER PRIMARY KEY,
  state            TEXT    DEFAULT '',
  state_data       TEXT    DEFAULT '',
  captcha_target   TEXT    DEFAULT '',
  pending_cb       TEXT    DEFAULT '',
  pending_check    TEXT    DEFAULT '',
  rl_count         INTEGER DEFAULT 0,
  rl_window_start  TEXT    DEFAULT '',
  rl_blocked_until TEXT    DEFAULT ''
)`,
// Web admin panel — sessions with 30-minute sliding idle expiry.
`CREATE TABLE IF NOT EXISTS admin_sessions (
  token          TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  last_active_at TEXT NOT NULL
)`,
// Login brute-force guard, keyed by caller IP.
`CREATE TABLE IF NOT EXISTS admin_login_attempts (
  ip            TEXT PRIMARY KEY,
  fail_count    INTEGER DEFAULT 0,
  first_fail_at TEXT    DEFAULT '',
  blocked_until TEXT    DEFAULT ''
)`,
// Progress marker for the long-running broadcast/forward admin actions.
`CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT    NOT NULL,
  total       INTEGER DEFAULT 0,
  sent        INTEGER DEFAULT 0,
  failed      INTEGER DEFAULT 0,
  done        INTEGER DEFAULT 0,
  started_at  TEXT    NOT NULL
)`,
];

let _schemaReady = false;
async function ensureSchema(env) {
  if (_schemaReady) return;
  for (const stmt of SCHEMA_STATEMENTS) {
    await env.DB.prepare(stmt).run();
  }
  for (const [k, v] of Object.entries(SETTINGS_DEFAULTS)) {
    await env.DB.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)').bind(k, v).run();
  }
  _schemaReady = true;
}

// ═══════════════════════════ SMALL UTILS ═══════════════════════════════
function nowIso() {
  return new Date().toISOString();
}
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function genCode(n = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < n; i++) out += chars[bytes[i] % chars.length];
  return out;
}
function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json;charset=UTF-8', ...extraHeaders },
  });
}
function isNumericId(raw) {
  return /^-?\d+$/.test(String(raw ?? '').trim());
}

// ═══════════════════════════ TELEGRAM API ═══════════════════════════════
// Raw fetch() calls — no bot-framework dependency, per project requirements.
async function tgCall(token, method, params) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params || {}),
  });
  const data = await res.json();
  if (!data.ok) {
    const err = new Error(`Telegram ${method} failed: ${data.description || res.status}`);
    err.telegram = data;
    throw err;
  }
  return data.result;
}
async function tgCallSafe(token, method, params) {
  try {
    return await tgCall(token, method, params);
  } catch (e) {
    console.warn(`[tg:${method}]`, e.message);
    return null;
  }
}
const tgBot = (env, method, params) => tgCall(env.BOT_TOKEN, method, params);
const tgBotSafe = (env, method, params) => tgCallSafe(env.BOT_TOKEN, method, params);
const tgNotifSafe = (env, method, params) => tgCallSafe(env.NOTIF_TOKEN, method, params);

async function logChannel(env, text) {
  if (!env.LOG_CHANNEL) return;
  await tgCallSafe(env.BOT_TOKEN, 'sendMessage', {
    chat_id: env.LOG_CHANNEL,
    text,
    parse_mode: 'HTML',
  });
}
async function reviewChannel(env, text) {
  if (!env.REVIEW_ID) return;
  await tgCallSafe(env.BOT_TOKEN, 'sendMessage', {
    chat_id: env.REVIEW_ID,
    text,
    parse_mode: 'HTML',
  });
}

// Deletes the tapped inline-keyboard message (if any) and sends a fresh one —
// mirrors the Python bot's `_replace_message` (delete-and-resend) pattern.
async function replaceMessage(env, update, text, kb) {
  const chatId = effectiveChatId(update);
  const cq = update.callback_query;
  if (cq && cq.message) {
    await tgBotSafe(env, 'deleteMessage', { chat_id: chatId, message_id: cq.message.message_id });
  }
  return tgBot(env, 'sendMessage', {
    chat_id: chatId,
    text,
    reply_markup: kb,
    parse_mode: 'HTML',
  });
}
function effectiveChatId(update) {
  if (update.callback_query) return update.callback_query.message?.chat.id ?? update.callback_query.from.id;
  if (update.message) return update.message.chat.id;
  return null;
}
function effectiveUser(update) {
  return update.callback_query?.from || update.message?.from || null;
}

// ═══════════════════════════ SETTINGS ═══════════════════════════════
async function settingGet(env, key, def = '') {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(key).first();
  return row ? row.value : def;
}
async function settingSet(env, key, value) {
  await env.DB.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').bind(key, String(value)).run();
}
async function settingsAll(env) {
  const { results } = await env.DB.prepare('SELECT key,value FROM settings').all();
  const out = { ...SETTINGS_DEFAULTS };
  for (const r of results) out[r.key] = r.value;
  return out;
}

// ═══════════════════════════ USERS ═══════════════════════════════
async function userGet(env, uid) {
  return env.DB.prepare('SELECT * FROM users WHERE user_id=?').bind(uid).first();
}
async function userUpsert(env, uid, username, first, last = '', ref = null) {
  await env.DB.prepare(`
    INSERT INTO users(user_id,username,first_name,last_name,join_date,referral_by)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET
      username=excluded.username, first_name=excluded.first_name, last_name=excluded.last_name
  `).bind(uid, username || '', first || '', last || '', nowIso(), ref).run();
}
async function balanceGet(env, uid) {
  const r = await userGet(env, uid);
  return r ? Number(r.balance) : 0;
}
async function balanceUpdate(env, uid, amount, type, chargeId = '') {
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET balance=balance+? WHERE user_id=?').bind(amount, uid),
    env.DB.prepare(
      'INSERT INTO transactions(user_id,amount,type,created_at,telegram_payment_charge_id) VALUES(?,?,?,?,?)'
    ).bind(uid, amount, type, nowIso(), chargeId),
  ]);
}
async function allUserIds(env) {
  const { results } = await env.DB.prepare('SELECT user_id FROM users WHERE is_banned=0').all();
  return results.map((r) => r.user_id);
}
async function referralCount(env, uid) {
  const r = await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE referral_by=?').bind(uid).first();
  return r ? r.n : 0;
}
async function notifUserExists(env, uid) {
  const r = await env.DB.prepare('SELECT 1 FROM notif_users WHERE user_id=?').bind(uid).first();
  return !!r;
}

// ═══════════════════════════ PREMIUM ═══════════════════════════════
async function premiumGetActive(env, uid) {
  return env.DB.prepare(`
    SELECT * FROM premium_bundles
    WHERE user_id=? AND is_active=1 AND is_queued=0 AND expires_at>?
    ORDER BY expires_at DESC LIMIT 1
  `).bind(uid, nowIso()).first();
}
async function premiumGetQueued(env, uid) {
  return env.DB.prepare(`
    SELECT * FROM premium_bundles WHERE user_id=? AND is_active=1 AND is_queued=1 ORDER BY id LIMIT 1
  `).bind(uid).first();
}
async function premiumIsActive(env, uid) {
  return !!(await premiumGetActive(env, uid));
}
async function premiumAdd(env, uid, days) {
  const active = await premiumGetActive(env, uid);
  let expires, queued;
  if (active) {
    expires = new Date(new Date(active.expires_at).getTime() + days * 86400000).toISOString();
    queued = 1;
  } else {
    expires = new Date(Date.now() + days * 86400000).toISOString();
    queued = 0;
  }
  await env.DB.prepare(
    'INSERT INTO premium_bundles(user_id,expires_at,duration_days,is_queued) VALUES(?,?,?,?)'
  ).bind(uid, expires, days, queued).run();
}
async function stopPremiumFeatures(env, uid) {
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE automation_settings SET name_auto_enabled=0, auto_read_enabled=0,
        anti_delete_enabled=0, auto_response_enabled=0 WHERE user_id=?
    `).bind(uid),
    env.DB.prepare('UPDATE premium_bundles SET is_active=0 WHERE user_id=?').bind(uid),
  ]);
}

// ═══════════════════════════ BUSINESS CONNECTIONS ═══════════════════════
async function bcGet(env, uid) {
  return env.DB.prepare('SELECT * FROM business_connections WHERE user_id=? AND is_active=1').bind(uid).first();
}
async function bcGetByConn(env, cid) {
  return env.DB.prepare('SELECT * FROM business_connections WHERE connection_id=? AND is_active=1').bind(cid).first();
}

// ═══════════════════════════ AUTOMATION SETTINGS ═════════════════════════
async function autoGet(env, uid) {
  return env.DB.prepare('SELECT * FROM automation_settings WHERE user_id=?').bind(uid).first();
}
async function autoEnsure(env, uid) {
  await env.DB.prepare('INSERT OR IGNORE INTO automation_settings(user_id) VALUES(?)').bind(uid).run();
}
async function autoSet(env, uid, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`).join(', ');
  await env.DB.prepare(`UPDATE automation_settings SET ${sets} WHERE user_id=?`)
    .bind(...keys.map((k) => fields[k]), uid).run();
}

// ═══════════════════════════ RUNTIME STATE (bot_state) ═══════════════════
// Stands in for python-telegram-bot's in-memory ctx.user_data, which cannot
// survive across stateless webhook invocations on Workers.
async function stateGet(env, uid) {
  let row = await env.DB.prepare('SELECT * FROM bot_state WHERE user_id=?').bind(uid).first();
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO bot_state(user_id) VALUES(?)').bind(uid).run();
    row = await env.DB.prepare('SELECT * FROM bot_state WHERE user_id=?').bind(uid).first();
  }
  return { ...row, data: row.state_data ? JSON.parse(row.state_data) : {} };
}
async function statePatch(env, uid, patch) {
  await stateGet(env, uid); // ensure row exists
  const fields = { ...patch };
  if ('data' in fields) {
    fields.state_data = JSON.stringify(fields.data);
    delete fields.data;
  }
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k}=?`).join(', ');
  await env.DB.prepare(`UPDATE bot_state SET ${sets} WHERE user_id=?`)
    .bind(...keys.map((k) => fields[k]), uid).run();
}
async function stateClearConversation(env, uid) {
  await statePatch(env, uid, { state: '', data: {}, captcha_target: '', pending_cb: '', pending_check: '' });
}

// ═══════════════════════════ RATE LIMITER ═══════════════════════════════
// Faithful two-tier port of the Python sliding-window limiter, persisted in
// D1 instead of ctx.user_data. A single fixed-window counter approximates
// the original per-timestamp list closely enough for practical throttling.
async function rateCheck(env, uid) {
  const s = await settingsAll(env);
  const st = await stateGet(env, uid);
  const now = Date.now();
  const blockedUntil = st.rl_blocked_until ? new Date(st.rl_blocked_until).getTime() : 0;
  if (blockedUntil > now) {
    return { ok: false, msg: `\u23F3 Rate limited \u2014 retry in ${Math.ceil((blockedUntil - now) / 1000)}s.` };
  }
  const windowStart = st.rl_window_start ? new Date(st.rl_window_start).getTime() : 0;
  const longWindowMs = Number(s.rate_limit_2_interval) * 1000;
  const shortWindowMs = Number(s.rate_limit_1_interval) * 1000;
  let count = st.rl_count || 0;
  let newWindowStart = windowStart;
  if (!windowStart || now - windowStart > longWindowMs) {
    count = 0;
    newWindowStart = now;
  }
  // Short-burst tier: reuse the same counter; once past its shorter interval
  // portion of the window it only ever adds up toward the long-tier limit.
  const withinShort = now - newWindowStart <= shortWindowMs;
  count += 1;
  if (withinShort && count >= Number(s.rate_limit_1_limit)) {
    const until = new Date(now + Number(s.rate_limit_1_block_secs) * 1000).toISOString();
    await statePatch(env, uid, { rl_count: 0, rl_window_start: '', rl_blocked_until: until });
    return { ok: false, msg: `\u23F3 Slow down \u2014 blocked for ${s.rate_limit_1_block_secs}s.` };
  }
  if (count >= Number(s.rate_limit_2_limit)) {
    const until = new Date(now + Number(s.rate_limit_2_block_mins) * 60000).toISOString();
    await statePatch(env, uid, { rl_count: 0, rl_window_start: '', rl_blocked_until: until });
    return { ok: false, msg: `\u26D4 Too many requests \u2014 try again in ${s.rate_limit_2_block_mins}m.` };
  }
  await statePatch(env, uid, { rl_count: count, rl_window_start: new Date(newWindowStart).toISOString() });
  return { ok: true, msg: '' };
}

// ═══════════════════════════ KEYBOARDS ═══════════════════════════════
// NB: the Python source tagged buttons with an `api_kwargs: {style: ...}`
// value. That isn't a real Telegram Bot API field — inline buttons have no
// client-side colour styling in Telegram — so it was inert. Dropped here;
// meaning is carried by the button glyphs/emoji instead, as it already was.
function btn(text, cb) {
  return { text, callback_data: cb };
}
function urlBtn(text, url) {
  return { text, url };
}
function kb(rows) {
  return { inline_keyboard: rows };
}
function kbMain(premiumActive) {
  return kb([
    [btn('\u{1F464}  Profile', 'menu_account'), btn('\u{1F4B3}  Top Up', 'menu_charge')],
    [btn(premiumActive ? '\u2726 Premium \u00B7 Active' : '\u2726 Upgrade to Premium', 'menu_premium')],
    [btn('\u{1F465}  Referrals', 'menu_referrals'), btn('\u{1F4AC}  Support', 'menu_support')],
    [btn('\u2699\uFE0F  Automation', 'menu_automation')],
  ]);
}
function kbAutomation(auto) {
  const t = (f) => (f ? '\u2705' : '\u25CB');
  const na = auto ? !!auto.name_auto_enabled : false;
  const ar = auto ? !!auto.auto_read_enabled : false;
  const ad = auto ? !!auto.anti_delete_enabled : false;
  const rs = auto ? !!auto.auto_response_enabled : false;
  return kb([
    [btn(`${t(na)}  Name Clock`, 'auto_name'), btn(`${t(ar)}  Auto Read`, 'auto_read')],
    [btn(`${t(ad)}  Anti-Delete`, 'auto_antidelete'), btn(`${t(rs)}  Auto Reply`, 'auto_response')],
    [btn('\u2039 Back', 'back_main')],
  ]);
}
function kbPremiumPlans(freeUsed, ppd) {
  const rows = [];
  let pair = [];
  for (const p of PREMIUM_PLANS) {
    let text;
    if (p.canFree && !freeUsed) text = `\u{1F381}  ${p.label}  \u2014  Free Trial`;
    else text = `\u2B50  ${p.label}  \u2014  ${p.days * ppd} XTR`;
    pair.push(btn(text, `prem_${p.days}`));
    if (pair.length === 2) { rows.push(pair); pair = []; }
  }
  if (pair.length) rows.push(pair);
  rows.push([btn('\u2039 Back', 'back_main')]);
  return kb(rows);
}
function kbBack(cb_ = 'back_main') {
  return kb([[btn('\u2039 Back', cb_)]]);
}
function kbCancel() {
  return kb([[btn('\u2715  Cancel', 'cancel_conv')]]);
}
function kbConfirm(yesCb, noCb) {
  return kb([[btn('\u2705  Confirm', yesCb), btn('\u2715  Cancel', noCb)]]);
}
function fontKb(page = 0) {
  const start = page * FONTS_PER_PAGE;
  const chunk = FONTS.slice(start, start + FONTS_PER_PAGE);
  const rows = [];
  let pair = [];
  for (const f of chunk) {
    const sample = applyFont(f.sample, f.id);
    pair.push(btn(`${f.name}: ${sample}`, `nfont_${f.id}`));
    if (pair.length === 2) { rows.push(pair); pair = []; }
  }
  if (pair.length) rows.push(pair);
  const nav = [];
  if (page > 0) nav.push(btn('\u25C0 Prev', `nfont_page_${page - 1}`));
  if (start + FONTS_PER_PAGE < FONTS.length) nav.push(btn('Next \u25B6', `nfont_page_${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([btn('\u2715 Cancel', 'cancel_conv')]);
  return kb(rows);
}

// ═══════════════════════════ CAPTCHA ═══════════════════════════════
const COLORS = ['\u{1F7E2} Green', '\u{1F535} Blue', '\u{1F534} Red'];
const COL_CB = { '\u{1F7E2} Green': 'cap_green', '\u{1F535} Blue': 'cap_blue', '\u{1F534} Red': 'cap_red' };
const CB_COL = Object.fromEntries(Object.entries(COL_CB).map(([k, v]) => [v, k]));

function captchaKb(target) {
  const opts = [...COLORS].sort(() => Math.random() - 0.5);
  return kb([opts.map((c) => btn(c, COL_CB[c]))]);
}
async function sendCaptcha(env, update) {
  const uid = effectiveUser(update).id;
  const target = COLORS[Math.floor(Math.random() * COLORS.length)];
  await statePatch(env, uid, { captcha_target: target });
  const word = target.split(' ')[1];
  const text =
    '\u{1F510} <b>Security Verification</b>\n\n' +
    "Please confirm you're human to continue.\n\n" +
    `Tap the <b>${word}</b> button below:`;
  if (update.message) {
    await tgBot(env, 'sendMessage', { chat_id: update.message.chat.id, text, reply_markup: captchaKb(target), parse_mode: 'HTML' });
  } else if (update.callback_query) {
    await tgBotSafe(env, 'deleteMessage', { chat_id: effectiveChatId(update), message_id: update.callback_query.message.message_id });
    await tgBot(env, 'sendMessage', { chat_id: effectiveChatId(update), text, reply_markup: captchaKb(target), parse_mode: 'HTML' });
  }
}

// ═══════════════════════════ GUARDS ═══════════════════════════════
// Returns a short-circuit response object {blocked:bool} and sends the
// appropriate notice itself, mirroring the Python decorator stack
// (rate_limit → require_not_banned → require_captcha → require_premium).
async function guardChain(env, update, { needCaptcha = true, needPremium = false } = {}) {
  const u = effectiveUser(update);
  if (!u) return { blocked: true };

  const rl = await rateCheck(env, u.id);
  if (!rl.ok) {
    if (update.callback_query) await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: rl.msg, show_alert: true });
    else if (update.message) await tgBotSafe(env, 'sendMessage', { chat_id: update.message.chat.id, text: rl.msg });
    return { blocked: true };
  }

  const row = await userGet(env, u.id);
  if (row && row.is_banned) {
    const msg = '\u{1F6AB} Your access has been suspended.';
    if (update.callback_query) await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: msg, show_alert: true });
    else if (update.message) await tgBotSafe(env, 'sendMessage', { chat_id: update.message.chat.id, text: msg });
    return { blocked: true };
  }

  if (needCaptcha && (!row || !row.captcha_passed)) {
    if (update.callback_query) await statePatch(env, u.id, { pending_cb: update.callback_query.data });
    await sendCaptcha(env, update);
    return { blocked: true };
  }

  if (needPremium && !(await premiumIsActive(env, u.id))) {
    const text =
      '\u{1F451} <b>Premium Required</b>\n\n' +
      'This feature is available to premium members only.\n' +
      'Upgrade to unlock all automation tools.';
    const kbUp = kb([[btn('\u2726 Upgrade to Premium', 'menu_premium')]]);
    if (update.callback_query) {
      await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: '\u{1F451} Premium only', show_alert: true });
      await replaceMessage(env, update, text, kbUp);
    } else if (update.message) {
      await tgBot(env, 'sendMessage', { chat_id: update.message.chat.id, text, reply_markup: kbUp, parse_mode: 'HTML' });
    }
    return { blocked: true };
  }

  return { blocked: false, user: u, row };
}

// ═══════════════════════════ MAIN MENU ═══════════════════════════════
async function showMainMenu(env, update) {
  const u = effectiveUser(update);
  const prem = await premiumGetActive(env, u.id);
  const status = prem
    ? `\u2726 Premium \u00B7 expires ${new Date(prem.expires_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}`
    : 'Standard \u00B7 No active plan';
  const text =
    `\u{1F3E0} <b>Auxox</b>  \u00B7  Business Automation\n` +
    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `Hello, <b>${escapeHtml(u.first_name)}</b>\n` +
    `<i>${status}</i>\n` +
    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `Select an option below:`;
  const markup = kbMain(!!prem);
  if (update.callback_query) {
    await tgBotSafe(env, 'deleteMessage', { chat_id: effectiveChatId(update), message_id: update.callback_query.message.message_id });
    await tgBot(env, 'sendMessage', { chat_id: effectiveChatId(update), text, reply_markup: markup, parse_mode: 'HTML' });
  } else if (update.message) {
    await tgBot(env, 'sendMessage', { chat_id: update.message.chat.id, text, reply_markup: markup, parse_mode: 'HTML' });
  }
}

// ═══════════════════════════ /start ═══════════════════════════════
async function cmdStart(env, update) {
  const u = update.message.from;
  const text = (update.message.text || '').trim();
  const argsPart = text.split(' ').slice(1).join(' ');
  const args = argsPart ? argsPart.split(' ') : [];

  // Check-redemption deep link: /start check=<code>
  if (args[0] && args[0].startsWith('check=')) {
    const code = args[0].slice(6);
    const existing = await env.DB.prepare('SELECT captcha_passed,is_banned FROM users WHERE user_id=?').bind(u.id).first();
    if (!existing) await userUpsert(env, u.id, u.username, u.first_name, u.last_name);
    if (existing && existing.is_banned) {
      await tgBot(env, 'sendMessage', { chat_id: update.message.chat.id, text: '\u{1F6AB} Your access has been suspended.' });
      return;
    }
    const row = await userGet(env, u.id);
    if (!row || !row.captcha_passed) {
      await statePatch(env, u.id, { pending_check: code });
      await sendCaptcha(env, update);
    } else {
      await promptRedeemCheck(env, update, code);
    }
    return;
  }

  // Referral param: /start ref=<id>
  let refBy = null;
  if (args[0] && args[0].startsWith('ref=')) {
    const n = parseInt(args[0].slice(4), 10);
    if (Number.isFinite(n) && n !== u.id) refBy = n;
  }

  const existing = await env.DB.prepare('SELECT captcha_passed,is_banned FROM users WHERE user_id=?').bind(u.id).first();
  if (!existing) await userUpsert(env, u.id, u.username, u.first_name, u.last_name, refBy);
  if (existing && existing.is_banned) {
    await tgBot(env, 'sendMessage', { chat_id: update.message.chat.id, text: '\u{1F6AB} Your access has been suspended.' });
    return;
  }

  const row = await userGet(env, u.id);
  if (!row || !row.captcha_passed) {
    await sendCaptcha(env, update);
    return;
  }
  const st = await stateGet(env, u.id);
  if (st.pending_check) {
    const code = st.pending_check;
    await statePatch(env, u.id, { pending_check: '' });
    await promptRedeemCheck(env, update, code);
  } else {
    await showMainMenu(env, update);
  }
}

// ═══════════════════════════ CAPTCHA CALLBACK ═══════════════════════════
async function cbCaptcha(env, update) {
  const cq = update.callback_query;
  const u = cq.from;
  const g = await guardChain(env, update, { needCaptcha: false });
  if (g.blocked) return;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const st = await stateGet(env, u.id);
  const pressed = CB_COL[cq.data];
  if (pressed === st.captcha_target) {
    await env.DB.prepare('UPDATE users SET captcha_passed=1 WHERE user_id=?').bind(u.id).run();
    await statePatch(env, u.id, { pending_cb: '' });
    await showMainMenu(env, update);
  } else {
    await tgBotSafe(env, 'deleteMessage', { chat_id: effectiveChatId(update), message_id: cq.message.message_id });
    await statePatch(env, u.id, { captcha_target: '' });
    await sendCaptcha(env, update);
  }
}

// ═══════════════════════════ CHECK REDEMPTION ═══════════════════════════
async function promptRedeemCheck(env, update, code) {
  const check = await env.DB.prepare('SELECT * FROM checks WHERE code=?').bind(code).first();
  const chatId = update.message.chat.id;
  if (!check) {
    await tgBot(env, 'sendMessage', { chat_id: chatId, text: '\u274C <b>Invalid Check</b>\n\nThis check code does not exist.', parse_mode: 'HTML', reply_markup: kbBack() });
    return;
  }
  const usedRow = await env.DB.prepare('SELECT COUNT(*) n FROM check_uses WHERE check_id=?').bind(check.id).first();
  const uses = usedRow.n;
  if (uses >= check.max_uses) {
    await tgBot(env, 'sendMessage', { chat_id: chatId, text: '\u274C <b>Check Exhausted</b>\n\nThis check has reached its maximum redemptions.', parse_mode: 'HTML', reply_markup: kbBack() });
    return;
  }
  const uid = update.message.from.id;
  const already = await env.DB.prepare('SELECT 1 FROM check_uses WHERE check_id=? AND user_id=?').bind(check.id, uid).first();
  if (already) {
    await tgBot(env, 'sendMessage', { chat_id: chatId, text: '\u26A0\uFE0F <b>Already Redeemed</b>\n\nYou have already used this check.', parse_mode: 'HTML', reply_markup: kbBack() });
    return;
  }
  const markup = kb([[btn('\u2705  Redeem Now', `check_confirm_${code}`), btn('\u2715  Cancel', 'back_main')]]);
  const text =
    `\u{1F39F} <b>Gift Check</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `\u{1F4B0}  Amount:      <b>${check.amount} \u2B50</b>\n` +
    `\u{1F465}  Uses left:   <b>${check.max_uses - uses}</b>\n` +
    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nTap <b>Redeem Now</b> to add these Stars to your balance.`;
  await tgBot(env, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: markup });
}

async function executeRedeemCheck(env, update, code) {
  const uid = effectiveUser(update).id;
  const check = await env.DB.prepare('SELECT * FROM checks WHERE code=?').bind(code).first();
  if (!check) {
    await tgBot(env, 'sendMessage', { chat_id: uid, text: '\u274C Check not found.', parse_mode: 'HTML', reply_markup: kbMain(await premiumIsActive(env, uid)) });
    return;
  }
  const usedRow = await env.DB.prepare('SELECT COUNT(*) n FROM check_uses WHERE check_id=?').bind(check.id).first();
  if (usedRow.n >= check.max_uses) {
    await tgBot(env, 'sendMessage', { chat_id: uid, text: '\u274C <b>Check Exhausted</b>\n\nAll redemptions have been used up.', parse_mode: 'HTML', reply_markup: kbMain(await premiumIsActive(env, uid)) });
    return;
  }
  const already = await env.DB.prepare('SELECT 1 FROM check_uses WHERE check_id=? AND user_id=?').bind(check.id, uid).first();
  if (already) {
    await tgBot(env, 'sendMessage', { chat_id: uid, text: '\u26A0\uFE0F You have already redeemed this check.', parse_mode: 'HTML', reply_markup: kbMain(await premiumIsActive(env, uid)) });
    return;
  }
  await env.DB.prepare('INSERT INTO check_uses(check_id,user_id,used_at) VALUES(?,?,?)').bind(check.id, uid, nowIso()).run();
  await balanceUpdate(env, uid, check.amount, 'check');
  const bal = await balanceGet(env, uid);
  await tgBot(env, 'sendMessage', {
    chat_id: uid,
    text: `\u2705 <b>Check Redeemed</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F4B0}  Added:       <b>+${check.amount} \u2B50</b>\n\u{1F4B3}  New Balance: <b>${bal.toFixed(0)} \u2B50</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
    parse_mode: 'HTML',
    reply_markup: kbMain(await premiumIsActive(env, uid)),
  });
  await logChannel(env, `\u{1F39F} <b>Check Redeemed</b>\n\u{1F464} <code>${uid}</code>  \u00B7  <b>+${check.amount} \u2B50</b>`);
}

async function cbCheckConfirm(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const code = cq.data.replace('check_confirm_', '');
  await tgBotSafe(env, 'deleteMessage', { chat_id: effectiveChatId(update), message_id: cq.message.message_id });
  await executeRedeemCheck(env, update, code);
}

// ═══════════════════════════ ACCOUNT / SUPPORT / REFERRALS ═══════════════
async function cbAccount(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const u = cq.from;
  const r = await userGet(env, u.id);
  if (!r) return;
  let joinDt = '\u2014';
  try { joinDt = new Date(r.join_date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }); } catch { /* noop */ }
  const active = await premiumGetActive(env, u.id);
  const premLine = active
    ? `\u{1F451}  Premium:    <b>Active  \u00B7  ${new Date(active.expires_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>`
    : '\u{1F451}  Premium:    <i>Not active</i>';
  const bc = await bcGet(env, u.id);
  const refs = await referralCount(env, u.id);
  const text =
    `\u{1F464} <b>Account Profile</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `\u{1F194}  User ID:    <code>${u.id}</code>\n` +
    `\u{1F464}  Name:       ${escapeHtml(u.first_name)} ${escapeHtml(u.last_name || '')}\n` +
    `\u{1F4DB}  Username:   ${u.username ? '@' + escapeHtml(u.username) : '\u2014'}\n` +
    `\u{1F4C5}  Joined:     ${joinDt}\n` +
    `\u{1F4B0}  Balance:    <b>${Number(r.balance).toFixed(0)} \u2B50</b>\n` +
    `${premLine}\n` +
    `\u{1F465}  Referrals:  ${refs}\n` +
    `\u{1F517}  Business:   ${bc ? '\u{1F7E2} Connected' : '\u{1F534} Not connected'}\n` +
    `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
  await replaceMessage(env, update, text, kbBack());
}

async function cbSupport(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id });
  const markup = kb([[urlBtn('\u2709\uFE0F  Contact Support', `https://t.me/${SUPPORT_USERNAME.replace(/^@/, '')}`)], [btn('\u2039 Back', 'back_main')]]);
  const text =
    `\u{1F4AC} <b>Support</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
    `For help with your account, premium, billing, or\nany other issues, reach out to our support team.\n\n` +
    `\u{1F4E9}  ${SUPPORT_USERNAME}\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<i>Typical response time: under 24 hours</i>`;
  await replaceMessage(env, update, text, markup);
}

async function cbReferrals(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id });
  await replaceMessage(
    env, update,
    '\u{1F465} <b>Referral Program</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F6A7}  Coming soon\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n<i>Stay tuned for updates.</i>',
    kbBack()
  );
}

// ═══════════════════════════ AUTOMATION MENU ═══════════════════════════
async function cbAutomationMenu(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  const bc = await bcGet(env, uid);
  if (!bc) {
    await replaceMessage(
      env, update,
      '\u{1F517} <b>Business Connection Required</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
      'Connect your Telegram Business account to use automation.\n\n' +
      '<code>Settings \u203A Business \u203A Chatbots \u203A Add this bot</code>',
      kbBack()
    );
    return;
  }
  await autoEnsure(env, uid);
  const auto = await autoGet(env, uid);
  await replaceMessage(
    env, update,
    '\u2699\uFE0F <b>Chat Automation</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
    'All features operate via your connected Business account.\nTap a feature to toggle or configure it:',
    kbAutomation(auto)
  );
}

async function cbAutoRead(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  await autoEnsure(env, uid);
  const cur = await autoGet(env, uid);
  const newVal = cur && cur.auto_read_enabled ? 0 : 1;
  await autoSet(env, uid, { auto_read_enabled: newVal });
  const auto = await autoGet(env, uid);
  await replaceMessage(
    env, update,
    `\u2699\uFE0F <b>Chat Automation</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F441}  Auto Read is now <b>${newVal ? '\u2705 On' : '\u25CB Off'}</b>`,
    kbAutomation(auto)
  );
}

async function cbAntiDelete(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  await autoEnsure(env, uid);
  const cur = await autoGet(env, uid);
  const newVal = cur && cur.anti_delete_enabled ? 0 : 1;
  await autoSet(env, uid, { anti_delete_enabled: newVal });
  const auto = await autoGet(env, uid);
  let note = '';
  if (newVal) {
    const notifMe = await tgCallSafe(env.NOTIF_TOKEN, 'getMe', {});
    note = notifMe ? `\n\n\u{1F4E9} Start @${notifMe.username} to receive deletion alerts.` : '';
  }
  await replaceMessage(
    env, update,
    `\u2699\uFE0F <b>Chat Automation</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F6E1}  Anti-Delete is now <b>${newVal ? '\u2705 On' : '\u25CB Off'}</b>${note}`,
    kbAutomation(auto)
  );
}

// ═══════════════════════════ AUTO REPLY ═══════════════════════════════
async function cbAutoResponse(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  await autoEnsure(env, uid);
  const auto = await autoGet(env, uid);
  if (auto && auto.auto_response_enabled) {
    await autoSet(env, uid, { auto_response_enabled: 0 });
    const updated = await autoGet(env, uid);
    await replaceMessage(
      env, update,
      '\u2699\uFE0F <b>Chat Automation</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F4AC}  Auto Reply is now <b>\u25CB Off</b>',
      kbAutomation(updated)
    );
    return;
  }
  await statePatch(env, uid, { state: 'auto_resp' });
  await replaceMessage(
    env, update,
    '\u{1F4AC} <b>Auto Reply Setup</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
    'Send the message you want to auto-reply with.\n\n' +
    'Supports: text, bold, links, photos, videos, stickers, voice\u2026\nThe exact message will be copied to every new chat.',
    kbCancel()
  );
}
async function handleAutoResponseTextInput(env, msg, uid) {
  await autoEnsure(env, uid);
  await autoSet(env, uid, {
    auto_response_enabled: 1,
    auto_response_chat_id: msg.chat.id,
    auto_response_message_id: msg.message_id,
    auto_response_text: msg.text || msg.caption || '',
  });
  await stateClearConversation(env, uid);
  const auto = await autoGet(env, uid);
  await tgBot(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: '\u2705 <b>Auto Reply Enabled</b>\n\nYour message has been saved and will be sent exactly as-is.',
    parse_mode: 'HTML',
    reply_markup: kbAutomation(auto),
  });
}

// ═══════════════════════════ NAME CLOCK ═══════════════════════════════
async function cbNameAuto(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  await autoEnsure(env, uid);
  const auto = await autoGet(env, uid);
  if (auto && auto.name_auto_enabled) {
    await autoSet(env, uid, { name_auto_enabled: 0 });
    const updated = await autoGet(env, uid);
    await replaceMessage(
      env, update,
      '\u2699\uFE0F <b>Chat Automation</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F550}  Name Clock is now <b>\u25CB Off</b>',
      kbAutomation(updated)
    );
    return;
  }
  await statePatch(env, uid, { state: 'name_tz' });
  await replaceMessage(
    env, update,
    '\u{1F550} <b>Name Clock \u00B7 Step 1 of 2</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
    'Enter your <b>UTC offset</b>.\nExamples: <code>+3</code>  <code>-5</code>  <code>+5.5</code>  <code>0</code>',
    kbCancel()
  );
}
async function handleNameTzInput(env, msg, uid) {
  const raw = (msg.text || '').trim();
  const tz = parseFloat(raw.replace(/^\+/, ''));
  if (!Number.isFinite(tz) || tz < -12 || tz > 14) {
    await tgBot(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '\u26A0\uFE0F Invalid offset. Enter a number between <code>-12</code> and <code>+14</code>.',
      parse_mode: 'HTML', reply_markup: kbCancel(),
    });
    return;
  }
  await statePatch(env, uid, { state: 'name_font', data: { name_tz: tz } });
  await tgBot(env, 'sendMessage', {
    chat_id: msg.chat.id,
    text: '\u{1F524} <b>Name Clock \u00B7 Step 2 of 2</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nChoose a font style for the clock:',
    parse_mode: 'HTML', reply_markup: fontKb(0),
  });
}
async function cbNameFontPage(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const page = parseInt(cq.data.split('_')[2], 10);
  await tgBotSafe(env, 'editMessageReplyMarkup', {
    chat_id: effectiveChatId(update), message_id: cq.message.message_id, reply_markup: fontKb(page),
  });
}
async function cbNameFontSelect(env, update) {
  const g = await guardChain(env, update, { needPremium: true });
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const fontId = parseInt(cq.data.split('_')[1], 10);
  const uid = cq.from.id;
  const st = await stateGet(env, uid);
  const tzOff = typeof st.data.name_tz === 'number' ? st.data.name_tz : 0;
  const bco = await bcGet(env, uid);
  let origFirst = '', origLast = '';
  if (bco) {
    const info = await tgBotSafe(env, 'getBusinessConnection', { business_connection_id: bco.connection_id });
    if (info) {
      origFirst = info.user.first_name || '';
      origLast = cleanTime(info.user.last_name || '');
    }
  }
  await autoEnsure(env, uid);
  await autoSet(env, uid, {
    name_auto_enabled: 1, tz_offset: tzOff, font_id: fontId,
    original_first_name: origFirst, original_last_name: origLast,
  });
  await stateClearConversation(env, uid);
  const fname = (FONTS.find((f) => f.id === fontId) || FONTS[0]).name;
  const sign = tzOff >= 0 ? '+' : '';
  const auto = await autoGet(env, uid);
  await tgBotSafe(env, 'deleteMessage', { chat_id: effectiveChatId(update), message_id: cq.message.message_id });
  await tgBot(env, 'sendMessage', {
    chat_id: effectiveChatId(update),
    text:
      `\u2705 <b>Name Clock Enabled</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
      `\u{1F310}  Timezone:  <b>UTC${sign}${tzOff}</b>\n\u{1F524}  Font:      <b>${fname}</b>\n` +
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nYour display name updates every minute.`,
    parse_mode: 'HTML', reply_markup: kbAutomation(auto),
  });
}

// ═══════════════════════════ TOP UP (Stars invoice) ═══════════════════════
async function cbChargeStart(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const s = await settingsAll(env);
  await statePatch(env, cq.from.id, { state: 'charge_amt' });
  await replaceMessage(
    env, update,
    `\u{1F4B3} <b>Top Up Balance</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nEnter the number of \u2B50 Stars to add.\nRange: <b>${s.min_charge} \u2013 ${s.max_charge} Stars</b>`,
    kbCancel()
  );
}
async function handleChargeAmountInput(env, msg, uid) {
  const s = await settingsAll(env);
  const raw = (msg.text || '').trim();
  const n = Number(raw);
  const mn = Number(s.min_charge), mx = Number(s.max_charge);
  if (!/^\d+$/.test(raw) || n < mn || n > mx) {
    await tgBot(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `\u26A0\uFE0F Enter a whole number between <b>${mn}</b> and <b>${mx}</b>.`,
      parse_mode: 'HTML', reply_markup: kbCancel(),
    });
    return;
  }
  const payload = `charge_${uid}_${genCode(10)}`;
  const expires = new Date(Date.now() + 3 * 3600000).toISOString();
  await env.DB.prepare('INSERT INTO invoices(user_id,amount,payload,created_at,expires_at) VALUES(?,?,?,?,?)')
    .bind(uid, n, payload, nowIso(), expires).run();
  await stateClearConversation(env, uid);
  await tgBot(env, 'sendInvoice', {
    chat_id: msg.chat.id,
    title: `Auxox \u00B7 ${n} \u2B50 Balance`,
    description: `Add ${n} Telegram Stars to your Auxox balance.\nInvoice expires in 3 hours.`,
    payload,
    currency: 'XTR',
    prices: [{ label: `${n} Stars`, amount: n }],
  });
}

async function handlePreCheckout(env, pcq) {
  const payload = pcq.invoice_payload;
  if (payload.startsWith('premium_')) {
    await tgBot(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: pcq.id, ok: true });
    return;
  }
  if (payload.startsWith('charge_')) {
    const row = await env.DB.prepare('SELECT paid,expires_at FROM invoices WHERE payload=?').bind(payload).first();
    if (row && row.paid === 0 && row.expires_at > nowIso()) {
      await tgBot(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: pcq.id, ok: true });
    } else {
      await tgBot(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: pcq.id, ok: false, error_message: 'Invoice expired or already paid.' });
    }
    return;
  }
  await tgBot(env, 'answerPreCheckoutQuery', { pre_checkout_query_id: pcq.id, ok: false, error_message: 'Unknown invoice.' });
}

async function handleSuccessfulPayment(env, msg) {
  const pmt = msg.successful_payment;
  const payload = pmt.invoice_payload;
  const uid = msg.from.id;
  const chargeId = pmt.telegram_payment_charge_id;

  if (payload.startsWith('charge_')) {
    const row = await env.DB.prepare('SELECT * FROM invoices WHERE payload=?').bind(payload).first();
    if (!row || row.paid !== 0) return; // unknown or duplicate notification
    const amount = row.amount;
    await env.DB.prepare('UPDATE invoices SET paid=1 WHERE payload=?').bind(payload).run();
    await balanceUpdate(env, uid, amount, 'topup', chargeId);
    const bal = await balanceGet(env, uid);
    await tgBot(env, 'sendMessage', {
      chat_id: msg.chat.id,
      text: `\u2705 <b>Top-Up Successful</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F4B0}  Added:       <b>+${amount} \u2B50</b>\n\u{1F4B3}  New Balance: <b>${bal.toFixed(0)} \u2B50</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      parse_mode: 'HTML', reply_markup: kbMain(await premiumIsActive(env, uid)),
    });
    await logChannel(env, `\u{1F4B3} <b>Top-Up</b>\n\u{1F464} <code>${uid}</code>  \u00B7  +${amount} \u2B50\n\u{1F511} <code>${chargeId}</code>`);
  } else if (payload.startsWith('premium_')) {
    const parts = payload.split('_');
    if (parts.length < 3) return;
    const days = parseInt(parts[2], 10);
    const existingTxn = await env.DB.prepare('SELECT id FROM transactions WHERE telegram_payment_charge_id=?').bind(chargeId).first();
    if (existingTxn) return; // duplicate
    await premiumAdd(env, uid, days);
    await env.DB.prepare(
      'INSERT INTO transactions(user_id,amount,type,created_at,telegram_payment_charge_id) VALUES(?,?,?,?,?)'
    ).bind(uid, days, 'premium_stars', nowIso(), chargeId).run();
    const active = await premiumGetActive(env, uid);
    const queued = await premiumGetQueued(env, uid);
    let text;
    if (queued && active && queued.id !== active.id) {
      text = `\u{1F451} <b>Premium Queued</b>\n\nA plan is already running. Your <b>${days}-day</b> bundle will activate automatically when the current plan ends.`;
    } else {
      const exp = active ? new Date(active.expires_at) : new Date();
      text =
        `\u{1F451} <b>Premium Activated</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F5D3}  Duration:  <b>${days} days</b>\n` +
        `\u{1F4C5}  Expires:   <b>${exp.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })} UTC</b>\n` +
        `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
    }
    await tgBot(env, 'sendMessage', { chat_id: msg.chat.id, text, parse_mode: 'HTML', reply_markup: kbMain(true) });
    await logChannel(env, `\u2B50 <b>Premium Purchase</b>\n\u{1F464} <code>${uid}</code>  \u00B7  ${days} days\n\u{1F511} <code>${chargeId}</code>`);
  }
}

// ═══════════════════════════ PREMIUM MENU ═══════════════════════════════
async function cbPremiumMenu(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  const ppd = Number(await settingGet(env, 'price_per_day', '1'));
  const active = await premiumGetActive(env, uid);
  const queued = await premiumGetQueued(env, uid);
  let status;
  if (active) {
    status = `\u2705 Active  \u00B7  expires <b>${new Date(active.expires_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>`;
    if (queued) status += `\n\u{1F504} Queued bundle  \u00B7  until <b>${new Date(queued.expires_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>`;
  } else {
    status = '\u25CB No active plan';
  }
  const u = await userGet(env, uid);
  const freeUsed = !!(u && u.free_trial_used);
  const text =
    `\u{1F451} <b>Premium Plans</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nStatus:  ${status}\nPrice:   <b>${ppd} \u2B50 / day</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nChoose a plan below:`;
  await replaceMessage(env, update, text, kbPremiumPlans(freeUsed, ppd));
}

async function cbPremiumSelect(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  const days = parseInt(cq.data.split('_')[1], 10);
  const plan = PREMIUM_PLANS.find((p) => p.days === days);
  const u = await userGet(env, uid);
  const freeUsed = !!(u && u.free_trial_used);
  const ppd = Number(await settingGet(env, 'price_per_day', '1'));

  if (plan && plan.canFree && !freeUsed) {
    await env.DB.prepare('UPDATE users SET free_trial_used=1 WHERE user_id=?').bind(uid).run();
    await premiumAdd(env, uid, days);
    const active = await premiumGetActive(env, uid);
    const exp = active ? new Date(active.expires_at) : new Date();
    await replaceMessage(
      env, update,
      `\u{1F381} <b>Free Trial Activated</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F5D3}  Duration:  <b>${days} days</b>\n` +
      `\u{1F4C5}  Expires:   <b>${exp.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>\n` +
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      kbBack()
    );
    await logChannel(env, `\u{1F381} <b>Free Trial</b>\n\u{1F464} <code>${uid}</code>  \u00B7  ${days} days`);
    return;
  }

  const cost = days * ppd;
  const balance = await balanceGet(env, uid);
  await statePatch(env, uid, { data: { prem_days: days, prem_cost: cost } });
  if (balance >= cost) {
    await replaceMessage(
      env, update,
      `\u{1F451} <b>Confirm Purchase</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F5D3}  Plan:      <b>${days} days</b>\n` +
      `\u{1F4B8}  Cost:      <b>${cost} \u2B50</b>\n\u{1F4B3}  Balance:   <b>${balance.toFixed(0)} \u2B50</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      kbConfirm('prem_confirm', 'menu_premium')
    );
  } else {
    const markup = kb([[btn(`\u2B50  Pay ${cost} Stars directly`, `prem_pay_${days}`)], [btn('\u2039 Back', 'menu_premium')]]);
    await replaceMessage(
      env, update,
      `\u{1F4B3} <b>Insufficient Balance</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F5D3}  Plan:      <b>${days} days  \u00B7  ${cost} \u2B50</b>\n` +
      `\u{1F4B3}  Balance:   <b>${balance.toFixed(0)} \u2B50</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\nPay directly with Telegram Stars:`,
      markup
    );
  }
}

async function cbPremiumConfirm(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  const st = await stateGet(env, uid);
  const days = st.data.prem_days, cost = st.data.prem_cost;
  if (!days || !cost) {
    await replaceMessage(env, update, '\u274C Session expired. Please try again.', kbBack());
    return;
  }
  const balance = await balanceGet(env, uid);
  if (balance < cost) {
    await replaceMessage(env, update, '\u26A0\uFE0F Your balance changed. Insufficient funds now.', kbBack('menu_premium'));
    return;
  }
  await balanceUpdate(env, uid, -cost, 'premium_balance');
  await premiumAdd(env, uid, days);
  const active = await premiumGetActive(env, uid);
  const queued = await premiumGetQueued(env, uid);
  let msgText;
  if (queued && active && queued.id !== active.id) {
    msgText = `\u{1F451} <b>Bundle Queued</b>\n\n<b>${cost} \u2B50</b> deducted. Your <b>${days}-day</b> bundle will activate when the current plan ends.`;
  } else {
    const exp = active ? new Date(active.expires_at) : new Date();
    msgText =
      `\u{1F451} <b>Premium Activated</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F5D3}  Plan:      <b>${days} days</b>\n` +
      `\u{1F4B8}  Deducted:  <b>${cost} \u2B50</b>\n\u{1F4C5}  Expires:   <b>${exp.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}</b>\n` +
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`;
  }
  await replaceMessage(env, update, msgText, kbBack());
  await logChannel(env, `\u2B50 <b>Premium (Balance)</b>\n\u{1F464} <code>${uid}</code>  \u00B7  ${days} days  \u00B7  -${cost} \u2B50`);
}

async function cbPremiumPay(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  const cq = update.callback_query;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  const uid = cq.from.id;
  const days = parseInt(cq.data.split('_')[2], 10);
  const cost = days * Number(await settingGet(env, 'price_per_day', '1'));
  const payload = `premium_${uid}_${days}_${genCode(6)}`;
  await tgBot(env, 'sendInvoice', {
    chat_id: uid,
    title: `Auxox Premium \u00B7 ${days} Days`,
    description: `Activate ${days}-day Auxox Premium plan.\nIncludes: Name Clock, Auto Read, Anti-Delete, Auto Reply.`,
    payload, currency: 'XTR', prices: [{ label: `${days}-Day Premium`, amount: cost }],
  });
  await replaceMessage(
    env, update,
    `\u{1F4E9} Invoice sent for <b>${cost} \u2B50</b>.\nComplete the payment in the chat to activate your <b>${days}-day</b> plan.`,
    kbBack('menu_premium')
  );
}

async function cbBackMain(env, update) {
  const g = await guardChain(env, update);
  if (g.blocked) return;
  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id });
  await showMainMenu(env, update);
}
async function cbCancel(env, update) {
  const uid = effectiveUser(update)?.id;
  if (uid) await stateClearConversation(env, uid);
  if (update.callback_query) {
    await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: update.callback_query.id });
    await showMainMenu(env, update);
  } else if (update.message) {
    await tgBot(env, 'sendMessage', { chat_id: update.message.chat.id, text: '\u2715 Cancelled.', reply_markup: kbMain(await premiumIsActive(env, uid)) });
  }
}

// ═══════════════════════════ BUSINESS CONNECTION ═══════════════════════
async function onBusinessConnection(env, bc) {
  const ownerId = bc.user.id; // the Telegram user who owns/connected the Business account
  await userUpsert(env, ownerId, bc.user.username, bc.user.first_name, bc.user.last_name);
  await env.DB.prepare(`
    INSERT INTO business_connections(user_id,connection_id,connected_at,is_active)
    VALUES(?,?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET connection_id=excluded.connection_id, is_active=excluded.is_active
  `).bind(ownerId, bc.id, nowIso(), bc.is_enabled ? 1 : 0).run();
  await autoEnsure(env, ownerId);
  if (bc.is_enabled) {
    await tgBotSafe(env, 'sendMessage', {
      chat_id: bc.user_chat_id,
      text:
        '\u{1F517} <b>Business Account Connected</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
        'Your Telegram Business account is now linked.\nOpen \u2699\uFE0F Automation in the main menu to enable features.',
      parse_mode: 'HTML',
    });
  } else {
    await stopPremiumFeatures(env, ownerId);
  }
}

// ═══════════════════════════ BUSINESS MESSAGE ═══════════════════════════
function extractMedia(msg) {
  if (msg.photo && msg.photo.length) return { type: 'photo', fileId: msg.photo[msg.photo.length - 1].file_id };
  if (msg.video) return { type: 'video', fileId: msg.video.file_id };
  if (msg.voice) return { type: 'voice', fileId: msg.voice.file_id };
  if (msg.video_note) return { type: 'video_note', fileId: msg.video_note.file_id };
  if (msg.audio) return { type: 'audio', fileId: msg.audio.file_id };
  if (msg.document) return { type: 'document', fileId: msg.document.file_id };
  if (msg.sticker) return { type: 'sticker', fileId: msg.sticker.file_id };
  if (msg.animation) return { type: 'animation', fileId: msg.animation.file_id };
  return { type: 'text', fileId: '' };
}
async function cacheMessage(env, msg, bcId) {
  const media = extractMedia(msg);
  const text = msg.text || msg.caption || '';
  const maxAgeDays = Number(await settingGet(env, 'max_message_age_days', '30'));
  const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO messages(business_connection_id,chat_id,message_id,from_user_id,from_name,from_username,text,media_type,file_id,date,saved_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(business_connection_id,chat_id,message_id) DO UPDATE SET text=excluded.text
    `).bind(
      bcId, msg.chat.id, msg.message_id,
      msg.from?.id || 0, msg.from ? `${msg.from.first_name || ''} ${msg.from.last_name || ''}`.trim() : 'Unknown',
      msg.from?.username || '', text, media.type, media.fileId,
      new Date(msg.date * 1000).toISOString(), nowIso()
    ),
    env.DB.prepare('DELETE FROM messages WHERE saved_at < ?').bind(cutoff),
  ]);
}

async function sendAutoReply(env, connectionId, targetChatId, auto) {
  if (auto.auto_response_chat_id && auto.auto_response_message_id) {
    const ok = await tgCallSafe(env.BOT_TOKEN, 'copyMessage', {
      business_connection_id: connectionId, chat_id: targetChatId,
      from_chat_id: auto.auto_response_chat_id, message_id: auto.auto_response_message_id,
    });
    if (ok) return true;
  }
  if (auto.auto_response_text) {
    return !!(await tgCallSafe(env.BOT_TOKEN, 'sendMessage', {
      business_connection_id: connectionId, chat_id: targetChatId, text: auto.auto_response_text,
    }));
  }
  return false;
}

let _botIdCache = null;
async function getBotId(env) {
  if (_botIdCache) return _botIdCache;
  const me = await tgBotSafe(env, 'getMe', {});
  _botIdCache = me ? me.id : null;
  return _botIdCache;
}

async function onBusinessMessage(env, msg) {
  const connectionId = msg.business_connection_id;
  const owner = await bcGetByConn(env, connectionId);
  if (!owner) return;
  const ownerId = owner.user_id;
  await cacheMessage(env, msg, connectionId);
  if (env.REVIEW_ID) {
    const who = msg.from ? `${escapeHtml(msg.from.first_name || '')}${msg.from.username ? ' @' + escapeHtml(msg.from.username) : ''}` : 'Unknown';
    const preview = (msg.text || msg.caption || `[${extractMedia(msg).type}]`).slice(0, 300);
    await reviewChannel(
      env,
      `\u{1F441} <b>Business Message</b>\n\u{1F464} Owner: <code>${ownerId}</code>\n\u{1F4E8} From: ${who} (<code>${msg.from?.id || 0}</code>)\n\u{1F4AC} ${escapeHtml(preview)}`
    );
  }
  if (!msg.from || msg.from.id === ownerId) return; // outgoing (owner's own device) — cache only, no auto-read/reply

  const auto = await autoGet(env, ownerId);
  if (!auto) return;
  const ownerRow = await userGet(env, ownerId);
  const premActive = await premiumIsActive(env, ownerId);
  if (!premActive || (ownerRow && ownerRow.is_banned)) {
    if (auto.auto_read_enabled || auto.anti_delete_enabled || auto.auto_response_enabled || auto.name_auto_enabled) {
      await stopPremiumFeatures(env, ownerId);
    }
    return;
  }

  if (auto.auto_read_enabled) {
    await tgCallSafe(env.BOT_TOKEN, 'readBusinessMessage', {
      business_connection_id: connectionId, chat_id: msg.chat.id, message_id: msg.message_id,
    });
  }
  if (auto.auto_response_enabled) {
    const last = auto.last_auto_response ? new Date(auto.last_auto_response).getTime() : 0;
    if (Date.now() - last >= AUTO_REPLY_COOLDOWN_MIN * 60000) {
      // Cooldown is marked before sending (fire-and-forget), matching the
      // source: a transient send failure should not trigger a retry storm.
      await autoSet(env, ownerId, { last_auto_response: nowIso() });
      await sendAutoReply(env, connectionId, msg.chat.id, auto);
    }
  }
}

// ═══════════════════════════ DELETED BUSINESS MESSAGES (anti-delete) ═════
async function onDeletedBusinessMessages(env, del) {
  const connectionId = del.business_connection_id;
  const owner = await bcGetByConn(env, connectionId);
  if (!owner) return;
  const ownerId = owner.user_id;
  const ownerRow = await userGet(env, ownerId);
  if (ownerRow && ownerRow.is_banned) return;
  const auto = await autoGet(env, ownerId);
  if (!auto || !auto.anti_delete_enabled) return;
  if (!(await premiumIsActive(env, ownerId))) {
    await stopPremiumFeatures(env, ownerId);
    return;
  }
  if (!(await notifUserExists(env, ownerId))) {
    const notifMe = await tgCallSafe(env.NOTIF_TOKEN, 'getMe', {});
    await tgBotSafe(env, 'sendMessage', {
      chat_id: ownerId,
      text: `\u{1F5D1} <b>Deletion Alert</b>\n\nTo receive deletion notifications, please start <b>@${notifMe ? notifMe.username : 'the alerts bot'}</b> first.`,
      parse_mode: 'HTML',
    });
    return;
  }
  const botId = await getBotId(env);

  for (const messageId of del.message_ids) {
    const cached = await env.DB.prepare(
      'SELECT * FROM messages WHERE business_connection_id=? AND chat_id=? AND message_id=?'
    ).bind(connectionId, del.chat.id, messageId).first();
    if (!cached || cached.from_user_id === botId) continue; // skip the bot's own auto-replies
    const who = cached.from_username ? `@${escapeHtml(cached.from_username)}` : escapeHtml(cached.from_name || 'Unknown');
    let sentStr = cached.date;
    try {
      sentStr = new Date(cached.date).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
    } catch { /* keep raw */ }
    const content = cached.text || `[${cached.media_type[0].toUpperCase()}${cached.media_type.slice(1)}]`;
    const body =
      `\u{1F5D1} <b>Deleted Message</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n` +
      `\u{1F464}  From:    ${who}\n\u{1F4C5}  Sent:    <code>${sentStr}</code>\n` +
      `\u{1F4CE}  Type:    ${cached.media_type[0].toUpperCase()}${cached.media_type.slice(1)}\n` +
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n\u{1F4AC}  Content:\n${escapeHtml(content)}`;
    await tgNotifSafe(env, 'sendMessage', { chat_id: ownerId, text: body, parse_mode: 'HTML' });
    if (cached.media_type !== 'text' && cached.file_id) {
      const sendMethod = { photo: 'sendPhoto', video: 'sendVideo', voice: 'sendVoice', video_note: 'sendVideoNote', audio: 'sendAudio', document: 'sendDocument', sticker: 'sendSticker', animation: 'sendAnimation' }[cached.media_type];
      if (sendMethod) {
        const fileField = cached.media_type === 'photo' ? 'photo' : cached.media_type;
        await tgNotifSafe(env, sendMethod, { chat_id: ownerId, [fileField]: cached.file_id });
      }
    }
  }
}

// ═══════════════════════════ UPDATE ROUTER ═══════════════════════════════
async function handleMessage(env, msg) {
  if (msg.successful_payment) return handleSuccessfulPayment(env, msg);
  if (!msg.from) return; // channel posts etc. — not applicable to this bot
  const uid = msg.from.id;

  if (msg.text && msg.text.startsWith('/start')) return cmdStart(env, { message: msg });
  if (msg.text === '/cancel') return cbCancel(env, { message: msg });

  // Multi-step "conversation" resume, persisted in bot_state (see rationale above).
  const st = await stateGet(env, uid);
  if (st.state) {
    const g = await guardChain(env, { message: msg });
    if (g.blocked) return;
    switch (st.state) {
      case 'charge_amt': return handleChargeAmountInput(env, msg, uid);
      case 'name_tz': return handleNameTzInput(env, msg, uid);
      case 'auto_resp': return handleAutoResponseTextInput(env, msg, uid);
      default: await stateClearConversation(env, uid);
    }
  }
  // No recognised command/state — show main menu (mirrors python fallback).
  const g = await guardChain(env, { message: msg });
  if (g.blocked) return;
  await showMainMenu(env, { message: msg });
}

async function handleCallbackQuery(env, cq) {
  const update = { callback_query: cq };
  const data = cq.data || '';

  if (data.startsWith('cap_')) return cbCaptcha(env, update);
  if (data === 'back_main') return cbBackMain(env, update);
  if (data === 'cancel_conv') return cbCancel(env, update);
  if (data === 'menu_account') return cbAccount(env, update);
  if (data === 'menu_support') return cbSupport(env, update);
  if (data === 'menu_referrals') return cbReferrals(env, update);
  if (data === 'menu_charge') return cbChargeStart(env, update);
  if (data === 'menu_premium') return cbPremiumMenu(env, update);
  if (data === 'menu_automation') return cbAutomationMenu(env, update);
  if (data === 'auto_read') return cbAutoRead(env, update);
  if (data === 'auto_antidelete') return cbAntiDelete(env, update);
  if (data === 'auto_response') return cbAutoResponse(env, update);
  if (data === 'auto_name') return cbNameAuto(env, update);
  if (data.startsWith('nfont_page_')) return cbNameFontPage(env, update);
  if (data.startsWith('nfont_')) return cbNameFontSelect(env, update);
  if (data.startsWith('check_confirm_')) return cbCheckConfirm(env, update);
  if (data === 'prem_confirm') return cbPremiumConfirm(env, update);
  if (data.startsWith('prem_pay_')) return cbPremiumPay(env, update);
  if (data.startsWith('prem_')) return cbPremiumSelect(env, update);

  await tgBotSafe(env, 'answerCallbackQuery', { callback_query_id: cq.id });
}

async function handleUpdate(env, ctx, update) {
  try {
    if (update.message) await handleMessage(env, update.message);
    else if (update.callback_query) await handleCallbackQuery(env, update.callback_query);
    else if (update.pre_checkout_query) await handlePreCheckout(env, update.pre_checkout_query);
    else if (update.business_connection) await onBusinessConnection(env, update.business_connection);
    else if (update.business_message) await onBusinessMessage(env, update.business_message);
    else if (update.edited_business_message) await onBusinessMessage(env, update.edited_business_message);
    else if (update.deleted_business_messages) await onDeletedBusinessMessages(env, update.deleted_business_messages);
  } catch (e) {
    console.error('handleUpdate error:', e.stack || e.message);
  }
}

// ═══════════════════════════ NOTIF BOT (registers alert recipients) ══════
// The alerts bot only needs to know who has started it; it has no other
// commands or menus of its own.
async function handleNotifUpdate(env, update) {
  const msg = update.message;
  if (!msg || !msg.from) return;
  if (msg.text && msg.text.startsWith('/start')) {
    await env.DB.prepare('INSERT OR REPLACE INTO notif_users(user_id,started_at) VALUES(?,?)')
      .bind(msg.from.id, nowIso()).run();
    await tgCallSafe(env.NOTIF_TOKEN, 'sendMessage', {
      chat_id: msg.chat.id,
      text: '\u2705 <b>Alerts Enabled</b>\n\nYou will receive a copy here whenever a message is deleted from your Business chats (Anti-Delete must also be turned on in the main bot).',
      parse_mode: 'HTML',
    });
  }
}

// ═══════════════════════════ CRON: NAME CLOCK ═══════════════════════════
// Fires every minute (wrangler.toml). `name_auto_update_interval` lets the
// admin slow this to every Nth minute without touching the cron schedule.
async function runNameClockJob(env) {
  const interval = Number(await settingGet(env, 'name_auto_update_interval', '60'));
  const stepMin = Math.max(1, Math.round(interval / 60));
  const minutesSinceEpoch = Math.floor(Date.now() / 60000);
  if (minutesSinceEpoch % stepMin !== 0) return;

  const { results } = await env.DB.prepare(`
    SELECT a.user_id, a.tz_offset, a.font_id, a.original_first_name, a.original_last_name, b.connection_id
    FROM automation_settings a JOIN business_connections b ON a.user_id = b.user_id
    WHERE a.name_auto_enabled = 1 AND b.is_active = 1
  `).all();

  for (const r of results) {
    const uid = r.user_id;
    if (!(await premiumIsActive(env, uid))) { await stopPremiumFeatures(env, uid); continue; }
    const userRow = await userGet(env, uid);
    if (userRow && userRow.is_banned) { await stopPremiumFeatures(env, uid); continue; }
    try {
      const offsetMs = Number(r.tz_offset) * 3600000;
      const local = new Date(Date.now() + offsetMs);
      const timeStr = `${String(local.getUTCHours()).padStart(2, '0')}:${String(local.getUTCMinutes()).padStart(2, '0')}`;
      const formatted = applyFont(timeStr, Number(r.font_id));

      let first = r.original_first_name || '';
      let origLast = r.original_last_name || '';
      const bcInfo = await tgCallSafe(env.BOT_TOKEN, 'getBusinessConnection', { business_connection_id: r.connection_id });
      if (bcInfo) {
        const curFirst = bcInfo.user.first_name || '';
        const curLast = cleanTime(bcInfo.user.last_name || '');
        if (curFirst !== first || curLast !== origLast) {
          first = curFirst;
          origLast = curLast;
          await autoSet(env, uid, { original_first_name: first, original_last_name: origLast });
        }
      }
      const newLast = origLast ? `${origLast} ${formatted}`.trim() : formatted;
      await tgCall(env.BOT_TOKEN, 'setBusinessAccountName', {
        business_connection_id: r.connection_id,
        first_name: first || ' ',
        last_name: newLast,
      });
    } catch (e) {
      console.warn(`Name clock user ${uid}:`, e.message);
    }
  }
}

// ═══════════════════════════ CRON: PREMIUM EXPIRY ═══════════════════════
async function runPremiumExpiryJob(env) {
  const now = nowIso();
  await env.DB.prepare('UPDATE premium_bundles SET is_active=0 WHERE is_active=1 AND expires_at<?').bind(now).run();

  const { results: queuedRows } = await env.DB.prepare(
    'SELECT user_id, id FROM premium_bundles WHERE is_queued=1 AND is_active=1'
  ).all();
  for (const row of queuedRows) {
    const hasActive = await env.DB.prepare(`
      SELECT 1 FROM premium_bundles WHERE user_id=? AND is_active=1 AND is_queued=0 AND expires_at>? LIMIT 1
    `).bind(row.user_id, now).first();
    if (!hasActive) {
      await env.DB.prepare('UPDATE premium_bundles SET is_queued=0 WHERE id=?').bind(row.id).run();
    }
  }

  const twoMinAgo = new Date(Date.now() - 2 * 60000).toISOString();
  const { results: recentlyExpired } = await env.DB.prepare(`
    SELECT DISTINCT user_id FROM premium_bundles WHERE is_active=0 AND expires_at BETWEEN ? AND ?
  `).bind(twoMinAgo, now).all();
  for (const row of recentlyExpired) {
    const uid = row.user_id;
    if (!(await premiumIsActive(env, uid))) {
      await stopPremiumFeatures(env, uid);
      await tgBotSafe(env, 'sendMessage', {
        chat_id: uid,
        text:
          '\u{1F451} <b>Premium Expired</b>\n\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\n' +
          'Your plan has ended. All automation features are paused.\n\nRenew anytime from the Premium menu.',
        parse_mode: 'HTML',
        reply_markup: kbMain(false),
      });
    }
  }
}

// ═══════════════════════════ CRON: INVOICE SWEEP ═══════════════════════
// Python scheduled this per-invoice via a one-off JobQueue callback; Workers
// has no per-item delayed jobs, so a periodic sweep is the stateless
// equivalent — same outcome (stale unpaid invoices closed out).
async function runInvoiceExpirySweep(env) {
  await env.DB.prepare("UPDATE invoices SET paid=-1 WHERE paid=0 AND expires_at<?").bind(nowIso()).run();
}

async function runScheduledJobs(env) {
  await ensureSchema(env);
  await runPremiumExpiryJob(env);
  await runNameClockJob(env);
  await runInvoiceExpirySweep(env);
}

// ═══════════════════════════════════════════════════════════════════════
//                            ADMIN WEB PANEL
// ═══════════════════════════════════════════════════════════════════════

// ---------- helpers ----------
function timingSafeEqual(a, b) {
  const sa = String(a), sb = String(b);
  if (sa.length !== sb.length) {
    // still scan `sa` length to avoid a trivial length-based short-circuit
    let dummy = 0;
    for (let i = 0; i < sa.length; i++) dummy |= sa.charCodeAt(i);
    return false;
  }
  let diff = 0;
  for (let i = 0; i < sa.length; i++) diff |= sa.charCodeAt(i) ^ sb.charCodeAt(i);
  return diff === 0;
}
function parseCookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}
function sessionCookieHeader(token, maxAgeSec) {
  return `admin_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAgeSec}`;
}
const CLEAR_COOKIE = 'admin_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0';

// ---------- brute-force guard ----------
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_FAIL_WINDOW_MIN = 10;
const LOGIN_LOCKOUT_MIN = 15;

async function loginAttemptCheck(env, ip) {
  const row = await env.DB.prepare('SELECT * FROM admin_login_attempts WHERE ip=?').bind(ip).first();
  if (row && row.blocked_until && row.blocked_until > nowIso()) {
    const secs = Math.ceil((new Date(row.blocked_until).getTime() - Date.now()) / 1000);
    return { blocked: true, retryAfterSec: secs };
  }
  return { blocked: false };
}
async function loginAttemptRecord(env, ip, success) {
  if (success) {
    await env.DB.prepare('DELETE FROM admin_login_attempts WHERE ip=?').bind(ip).run();
    return;
  }
  const row = await env.DB.prepare('SELECT * FROM admin_login_attempts WHERE ip=?').bind(ip).first();
  const now = Date.now();
  let failCount = 1, firstFailAt = nowIso();
  if (row && row.first_fail_at && now - new Date(row.first_fail_at).getTime() < LOGIN_FAIL_WINDOW_MIN * 60000) {
    failCount = row.fail_count + 1;
    firstFailAt = row.first_fail_at;
  }
  let blockedUntil = '';
  if (failCount >= LOGIN_FAIL_THRESHOLD) {
    blockedUntil = new Date(now + LOGIN_LOCKOUT_MIN * 60000).toISOString();
    failCount = 0; // reset counter once a lockout is issued
  }
  await env.DB.prepare(`
    INSERT INTO admin_login_attempts(ip,fail_count,first_fail_at,blocked_until) VALUES(?,?,?,?)
    ON CONFLICT(ip) DO UPDATE SET fail_count=excluded.fail_count, first_fail_at=excluded.first_fail_at, blocked_until=excluded.blocked_until
  `).bind(ip, failCount, firstFailAt, blockedUntil).run();
}

// ---------- sessions ----------
async function createAdminSession(env) {
  const token = randomToken();
  await env.DB.prepare('INSERT INTO admin_sessions(token,created_at,last_active_at) VALUES(?,?,?)')
    .bind(token, nowIso(), nowIso()).run();
  return token;
}
async function requireAdminSession(request, env) {
  const token = parseCookie(request, 'admin_session');
  if (!token) return { ok: false };
  const row = await env.DB.prepare('SELECT * FROM admin_sessions WHERE token=?').bind(token).first();
  if (!row) return { ok: false };
  const idleMs = Date.now() - new Date(row.last_active_at).getTime();
  if (idleMs > ADMIN_SESSION_MAX_IDLE_MIN * 60000) {
    await env.DB.prepare('DELETE FROM admin_sessions WHERE token=?').bind(token).run();
    return { ok: false, expired: true };
  }
  await env.DB.prepare('UPDATE admin_sessions SET last_active_at=? WHERE token=?').bind(nowIso(), token).run();
  // Opportunistic cleanup of long-idle rows so the table stays small.
  const staleCutoff = new Date(Date.now() - ADMIN_SESSION_MAX_IDLE_MIN * 60000 * 4).toISOString();
  await env.DB.prepare('DELETE FROM admin_sessions WHERE last_active_at < ?').bind(staleCutoff).run();
  return { ok: true, token, remainingSec: ADMIN_SESSION_MAX_IDLE_MIN * 60 };
}

// ---------- auth routes ----------
async function apiLogin(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const guard = await loginAttemptCheck(env, ip);
  if (guard.blocked) return json({ error: `Too many attempts. Try again in ${Math.ceil(guard.retryAfterSec / 60)}m.` }, 429);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  if (!body.password || !timingSafeEqual(body.password, env.PASSWORD)) {
    await loginAttemptRecord(env, ip, false);
    return json({ error: 'Incorrect password.' }, 401);
  }
  await loginAttemptRecord(env, ip, true);
  const token = await createAdminSession(env);
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(token, 86400) });
}
async function apiLogout(request, env) {
  const token = parseCookie(request, 'admin_session');
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token=?').bind(token).run();
  return json({ ok: true }, 200, { 'Set-Cookie': CLEAR_COOKIE });
}
async function apiSession(request, env) {
  const sess = await requireAdminSession(request, env);
  if (!sess.ok) return json({ authenticated: false }, 200);
  return json({ authenticated: true, idleTimeoutSec: sess.remainingSec });
}

// ---------- stats ----------
async function apiStats(env) {
  const totalUsers = (await env.DB.prepare('SELECT COUNT(*) n FROM users').first()).n;
  const bannedUsers = (await env.DB.prepare('SELECT COUNT(*) n FROM users WHERE is_banned=1').first()).n;
  const premiumActive = (await env.DB.prepare('SELECT COUNT(*) n FROM premium_bundles WHERE is_active=1 AND is_queued=0 AND expires_at>?').bind(nowIso()).first()).n;
  const connected = (await env.DB.prepare('SELECT COUNT(*) n FROM business_connections WHERE is_active=1').first()).n;
  const totalBalance = (await env.DB.prepare('SELECT COALESCE(SUM(balance),0) s FROM users').first()).s;
  const topupSum = (await env.DB.prepare("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='topup'").first()).s;
  const premiumRevenue = (await env.DB.prepare("SELECT COUNT(*) n FROM transactions WHERE type IN ('premium_stars','premium_balance')").first()).n;
  const checksCount = (await env.DB.prepare('SELECT COUNT(*) n FROM checks').first()).n;
  const cachedMsgs = (await env.DB.prepare('SELECT COUNT(*) n FROM messages').first()).n;
  return json({
    totalUsers, bannedUsers, premiumActive, connected,
    totalBalance, topupSum, premiumRevenue, checksCount, cachedMsgs,
  });
}

// ---------- users ----------
async function apiUsersList(request, env) {
  const url = new URL(request.url);
  const search = (url.searchParams.get('q') || '').trim();
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage = 25;
  let rows, total;
  if (search) {
    const like = `%${search}%`;
    const isId = isNumericId(search);
    total = (await env.DB.prepare(
      `SELECT COUNT(*) n FROM users WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ? ${isId ? 'OR user_id=?' : ''}`
    ).bind(...(isId ? [like, like, like, search] : [like, like, like])).first()).n;
    const stmt = `SELECT * FROM users WHERE username LIKE ? OR first_name LIKE ? OR last_name LIKE ? ${isId ? 'OR user_id=?' : ''} ORDER BY join_date DESC LIMIT ? OFFSET ?`;
    const args = isId ? [like, like, like, search, perPage, (page - 1) * perPage] : [like, like, like, perPage, (page - 1) * perPage];
    rows = (await env.DB.prepare(stmt).bind(...args).all()).results;
  } else {
    total = (await env.DB.prepare('SELECT COUNT(*) n FROM users').first()).n;
    rows = (await env.DB.prepare('SELECT * FROM users ORDER BY join_date DESC LIMIT ? OFFSET ?').bind(perPage, (page - 1) * perPage).all()).results;
  }
  const uids = rows.map((r) => r.user_id);
  const enriched = [];
  for (const u of rows) {
    const prem = await premiumGetActive(env, u.user_id);
    const bc = await bcGet(env, u.user_id);
    enriched.push({ ...u, premium_active: !!prem, premium_expires: prem ? prem.expires_at : null, business_connected: !!bc });
  }
  return json({ users: enriched, total, page, perPage });
}

async function apiUserDetail(env, uid) {
  const u = await userGet(env, uid);
  if (!u) return json({ error: 'User not found.' }, 404);
  const auto = await autoGet(env, uid);
  const bc = await bcGet(env, uid);
  const active = await premiumGetActive(env, uid);
  const queued = await premiumGetQueued(env, uid);
  const { results: txns } = await env.DB.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY id DESC LIMIT 20').bind(uid).all();
  return json({
    user: u, automation: auto || null, business_connection: bc || null,
    premium_active: active || null, premium_queued: queued || null,
    referrals: await referralCount(env, uid), notif_started: await notifUserExists(env, uid),
    recent_transactions: txns,
  });
}

async function apiUserCreate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const userId = parseInt(body.user_id, 10);
  const connectionId = (body.business_connection_id || '').trim();
  if (!Number.isFinite(userId) || !connectionId) return json({ error: 'user_id and business_connection_id are required.' }, 400);

  const info = await tgCallSafe(env.BOT_TOKEN, 'getBusinessConnection', { business_connection_id: connectionId });
  if (!info) return json({ error: 'Telegram rejected that business_connection_id — it may be invalid or expired.' }, 400);
  if (info.user.id !== userId) return json({ error: `That connection belongs to user ${info.user.id}, not ${userId}.` }, 400);

  await userUpsert(env, userId, info.user.username, info.user.first_name, info.user.last_name);
  await env.DB.prepare(`
    INSERT INTO business_connections(user_id,connection_id,connected_at,is_active) VALUES(?,?,?,1)
    ON CONFLICT(user_id) DO UPDATE SET connection_id=excluded.connection_id, is_active=1
  `).bind(userId, connectionId, nowIso()).run();
  await autoEnsure(env, userId);
  return json({ ok: true, user: await userGet(env, userId) });
}

async function apiUserBan(request, env, uid) {
  let body; try { body = await request.json(); } catch { body = {}; }
  const banned = body.banned ? 1 : 0;
  await env.DB.prepare('UPDATE users SET is_banned=? WHERE user_id=?').bind(banned, uid).run();
  if (banned) await stopPremiumFeatures(env, uid);
  await logChannel(env, `${banned ? '\u{1F6AB}' : '\u2705'} <b>${banned ? 'Banned' : 'Unbanned'} (Admin Panel)</b>\n\u{1F464} <code>${uid}</code>`);
  return json({ ok: true });
}

async function apiUserBalance(request, env, uid) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount === 0) return json({ error: 'amount must be a non-zero number.' }, 400);
  const user = await userGet(env, uid);
  if (!user) return json({ error: 'User not found.' }, 404);
  await balanceUpdate(env, uid, amount, amount > 0 ? 'admin_credit' : 'admin_debit');
  await logChannel(env, `\u{1F4B0} <b>Balance Adjusted (Admin Panel)</b>\n\u{1F464} <code>${uid}</code>  \u00B7  ${amount > 0 ? '+' : ''}${amount} \u2B50`);
  return json({ ok: true, balance: await balanceGet(env, uid) });
}

async function apiUserAutomation(request, env, uid) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  await autoEnsure(env, uid);
  const patch = {};
  if ('name_auto_enabled' in body) patch.name_auto_enabled = body.name_auto_enabled ? 1 : 0;
  if ('auto_read_enabled' in body) patch.auto_read_enabled = body.auto_read_enabled ? 1 : 0;
  if ('anti_delete_enabled' in body) patch.anti_delete_enabled = body.anti_delete_enabled ? 1 : 0;
  if ('auto_response_enabled' in body) patch.auto_response_enabled = body.auto_response_enabled ? 1 : 0;
  if ('tz_offset' in body) patch.tz_offset = Number(body.tz_offset) || 0;
  if ('font_id' in body) patch.font_id = parseInt(body.font_id, 10) || 0;
  if ('auto_response_text' in body) {
    patch.auto_response_text = String(body.auto_response_text || '');
    // Admin-set replies are plain text; clear any stale copy-source pointer
    // so sendAutoReply() falls through to the text path (see sendAutoReply).
    patch.auto_response_chat_id = 0;
    patch.auto_response_message_id = 0;
  }
  if (!Object.keys(patch).length) return json({ error: 'No recognised fields.' }, 400);
  await autoSet(env, uid, patch);
  return json({ ok: true, automation: await autoGet(env, uid) });
}

// ---------- broadcast / forward (background via ctx.waitUntil) ----------
async function runBroadcastJob(env, jobId, text) {
  const delayMs = Number(await settingGet(env, 'broadcast_delay_ms', '40'));
  const uids = await allUserIds(env);
  let sent = 0, failed = 0;
  for (const uid of uids) {
    const ok = await tgCallSafe(env.BOT_TOKEN, 'sendMessage', { chat_id: uid, text, parse_mode: 'HTML' });
    if (ok) sent++; else failed++;
    await env.DB.prepare('UPDATE broadcast_jobs SET sent=?, failed=? WHERE id=?').bind(sent, failed, jobId).run();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  await env.DB.prepare('UPDATE broadcast_jobs SET done=1 WHERE id=?').bind(jobId).run();
}
async function runForwardJob(env, jobId, fromChatId, messageId) {
  const delayMs = Number(await settingGet(env, 'broadcast_delay_ms', '40'));
  const uids = await allUserIds(env);
  let sent = 0, failed = 0;
  for (const uid of uids) {
    const ok = await tgCallSafe(env.BOT_TOKEN, 'forwardMessage', { chat_id: uid, from_chat_id: fromChatId, message_id: messageId });
    if (ok) sent++; else failed++;
    await env.DB.prepare('UPDATE broadcast_jobs SET sent=?, failed=? WHERE id=?').bind(sent, failed, jobId).run();
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
  }
  await env.DB.prepare('UPDATE broadcast_jobs SET done=1 WHERE id=?').bind(jobId).run();
}
async function apiBroadcast(request, env, ctx) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  if (!body.text || !String(body.text).trim()) return json({ error: 'text is required.' }, 400);
  const total = (await allUserIds(env)).length;
  const { meta } = await env.DB.prepare('INSERT INTO broadcast_jobs(kind,total,started_at) VALUES(?,?,?)').bind('broadcast', total, nowIso()).run();
  const jobId = meta.last_row_id;
  ctx.waitUntil(runBroadcastJob(env, jobId, String(body.text)));
  return json({ ok: true, jobId, total });
}
async function apiForward(request, env, ctx) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const fromChatId = body.from_chat_id, messageId = parseInt(body.message_id, 10);
  if (!fromChatId || !Number.isFinite(messageId)) return json({ error: 'from_chat_id and message_id are required.' }, 400);
  const total = (await allUserIds(env)).length;
  const { meta } = await env.DB.prepare('INSERT INTO broadcast_jobs(kind,total,started_at) VALUES(?,?,?)').bind('forward', total, nowIso()).run();
  const jobId = meta.last_row_id;
  ctx.waitUntil(runForwardJob(env, jobId, fromChatId, messageId));
  return json({ ok: true, jobId, total });
}
async function apiBroadcastStatus(env, jobId) {
  const row = await env.DB.prepare('SELECT * FROM broadcast_jobs WHERE id=?').bind(jobId).first();
  if (!row) return json({ error: 'Job not found.' }, 404);
  return json({ job: row });
}

// ---------- pricing / settings ----------
async function apiPrice(request, env) {
  if (request.method === 'GET') return json({ price_per_day: await settingGet(env, 'price_per_day', '1') });
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const price = Number(body.price_per_day);
  if (!Number.isFinite(price) || price <= 0) return json({ error: 'price_per_day must be a positive number.' }, 400);
  await settingSet(env, 'price_per_day', price);
  return json({ ok: true });
}
async function apiSettingsGet(env) {
  return json({ settings: await settingsAll(env) });
}
async function apiSettingsSet(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const allowedKeys = Object.keys(SETTINGS_DEFAULTS);
  for (const [k, v] of Object.entries(body)) {
    if (allowedKeys.includes(k)) await settingSet(env, k, v);
  }
  return json({ ok: true, settings: await settingsAll(env) });
}

// ---------- checks (gift codes) ----------
async function apiChecksList(env) {
  const { results } = await env.DB.prepare('SELECT * FROM checks ORDER BY id DESC').all();
  const enriched = [];
  for (const c of results) {
    const used = (await env.DB.prepare('SELECT COUNT(*) n FROM check_uses WHERE check_id=?').bind(c.id).first()).n;
    enriched.push({ ...c, used });
  }
  return json({ checks: enriched });
}
async function apiCheckCreate(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const amount = parseInt(body.amount, 10), maxUses = parseInt(body.max_uses, 10);
  if (!Number.isFinite(amount) || amount <= 0) return json({ error: 'amount must be a positive integer.' }, 400);
  if (!Number.isFinite(maxUses) || maxUses <= 0) return json({ error: 'max_uses must be a positive integer.' }, 400);
  const code = genCode(8);
  await env.DB.prepare('INSERT INTO checks(code,amount,created_at,max_uses) VALUES(?,?,?,?)').bind(code, amount, nowIso(), maxUses).run();
  await logChannel(env, `\u{1F39F} <b>Check Created (Admin Panel)</b>\n\u{1F511} <code>${code}</code>  \u00B7  ${amount} \u2B50  \u00B7  ${maxUses} uses`);
  // Deep-link "start" payloads only allow [A-Za-z0-9_-], so "check=<code>"
  // can't be a clickable t.me link — it's redeemed as a typed command,
  // exactly like the source's ctx.args parsing expects.
  return json({ ok: true, code, redeem_command: `/start check=${code}` });
}
async function apiCheckDelete(env, code) {
  const check = await env.DB.prepare('SELECT id FROM checks WHERE code=?').bind(code).first();
  if (!check) return json({ error: 'Check not found.' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM check_uses WHERE check_id=?').bind(check.id),
    env.DB.prepare('DELETE FROM checks WHERE id=?').bind(check.id),
  ]);
  return json({ ok: true });
}

// ---------- refunds (Telegram Stars) ----------
async function apiRefundLookup(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return json({ matches: [] });
  const isId = isNumericId(q);
  const stmt = isId
    ? env.DB.prepare("SELECT * FROM transactions WHERE user_id=? AND telegram_payment_charge_id!='' ORDER BY id DESC LIMIT 20").bind(q)
    : env.DB.prepare("SELECT * FROM transactions WHERE telegram_payment_charge_id LIKE ? ORDER BY id DESC LIMIT 20").bind(`%${q}%`);
  const { results } = await stmt.all();
  return json({ matches: results });
}
async function apiRefundConfirm(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  const userId = parseInt(body.user_id, 10);
  const chargeId = (body.charge_id || '').trim();
  if (!Number.isFinite(userId) || !chargeId) return json({ error: 'user_id and charge_id are required.' }, 400);
  try {
    await tgCall(env.BOT_TOKEN, 'refundStarPayment', { user_id: userId, telegram_payment_charge_id: chargeId });
  } catch (e) {
    return json({ error: `Telegram refund failed: ${e.message}` }, 400);
  }
  const original = await env.DB.prepare('SELECT amount FROM transactions WHERE telegram_payment_charge_id=? ORDER BY id DESC LIMIT 1').bind(chargeId).first();
  const amt = original ? Math.abs(original.amount) : 0;
  await env.DB.prepare('INSERT INTO transactions(user_id,amount,type,created_at,telegram_payment_charge_id) VALUES(?,?,?,?,?)')
    .bind(userId, -amt, 'refund', nowIso(), chargeId).run();
  await logChannel(env, `\u21A9\uFE0F <b>Refund Issued (Admin Panel)</b>\n\u{1F464} <code>${userId}</code>  \u00B7  ${amt} \u2B50\n\u{1F511} <code>${chargeId}</code>`);
  return json({ ok: true });
}

// ---------- webhook management ----------
async function apiWebhookStatus(env) {
  const info = await tgCallSafe(env.BOT_TOKEN, 'getWebhookInfo', {});
  const notifInfo = await tgCallSafe(env.NOTIF_TOKEN, 'getWebhookInfo', {});
  return json({ main: info, notif: notifInfo });
}
async function apiWebhookSet(request, env) {
  let body; try { body = await request.json(); } catch { return json({ error: 'Invalid request.' }, 400); }
  if (!body.secret || !timingSafeEqual(body.secret, env.SECRET)) {
    return json({ error: 'Secret does not match SECRET.' }, 401);
  }
  if (!body.base_url) return json({ error: 'base_url is required, e.g. https://your-worker.workers.dev' }, 400);
  const base = String(body.base_url).replace(/\/+$/, '');
  const mainRes = await tgCallSafe(env.BOT_TOKEN, 'setWebhook', {
    url: `${base}/webhook`,
    secret_token: env.SECRET,
    allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'business_connection', 'business_message', 'edited_business_message', 'deleted_business_messages'],
  });
  const notifRes = await tgCallSafe(env.NOTIF_TOKEN, 'setWebhook', {
    url: `${base}/webhook/notif`,
    secret_token: env.SECRET,
    allowed_updates: ['message'],
  });
  if (!mainRes) return json({ error: 'Telegram rejected the main bot webhook — check BOT_TOKEN and base_url.' }, 400);
  return json({ ok: true, main_set: !!mainRes, notif_set: !!notifRes });
}

// ---------- message review ----------
async function apiMessageReview(request, env) {
  const url = new URL(request.url);
  const uid = url.searchParams.get('user_id');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
  const perPage = 30;
  let rows, total;
  if (uid) {
    const bc = await bcGet(env, parseInt(uid, 10));
    if (!bc) return json({ messages: [], total: 0 });
    total = (await env.DB.prepare('SELECT COUNT(*) n FROM messages WHERE business_connection_id=?').bind(bc.connection_id).first()).n;
    rows = (await env.DB.prepare('SELECT * FROM messages WHERE business_connection_id=? ORDER BY id DESC LIMIT ? OFFSET ?')
      .bind(bc.connection_id, perPage, (page - 1) * perPage).all()).results;
  } else {
    total = (await env.DB.prepare('SELECT COUNT(*) n FROM messages').first()).n;
    rows = (await env.DB.prepare('SELECT * FROM messages ORDER BY id DESC LIMIT ? OFFSET ?').bind(perPage, (page - 1) * perPage).all()).results;
  }
  return json({ messages: rows, total, page, perPage });
}

// ---------- admin API router ----------
async function routeAdminApi(request, env, ctx, url) {
  const path = url.pathname.replace(/^\/api\/admin/, '') || '/';
  const method = request.method;

  if (path === '/login' && method === 'POST') return apiLogin(request, env);

  const sess = await requireAdminSession(request, env);
  if (!sess.ok) return json({ error: 'Unauthorized', expired: !!sess.expired }, 401);

  if (path === '/logout' && method === 'POST') return apiLogout(request, env);
  if (path === '/session' && method === 'GET') return apiSession(request, env);
  if (path === '/stats' && method === 'GET') return apiStats(env);

  if (path === '/users' && method === 'GET') return apiUsersList(request, env);
  if (path === '/users' && method === 'POST') return apiUserCreate(request, env);
  const userMatch = path.match(/^\/users\/(-?\d+)(\/(ban|balance|automation))?$/);
  if (userMatch) {
    const uid = parseInt(userMatch[1], 10);
    const sub = userMatch[3];
    if (!sub && method === 'GET') return apiUserDetail(env, uid);
    if (sub === 'ban' && method === 'POST') return apiUserBan(request, env, uid);
    if (sub === 'balance' && method === 'POST') return apiUserBalance(request, env, uid);
    if (sub === 'automation' && method === 'POST') return apiUserAutomation(request, env, uid);
  }

  if (path === '/broadcast' && method === 'POST') return apiBroadcast(request, env, ctx);
  if (path === '/forward' && method === 'POST') return apiForward(request, env, ctx);
  const jobMatch = path.match(/^\/broadcast-status\/(\d+)$/);
  if (jobMatch && method === 'GET') return apiBroadcastStatus(env, parseInt(jobMatch[1], 10));

  if (path === '/price' && (method === 'GET' || method === 'POST')) return apiPrice(request, env);
  if (path === '/settings' && method === 'GET') return apiSettingsGet(env);
  if (path === '/settings' && method === 'POST') return apiSettingsSet(request, env);

  if (path === '/checks' && method === 'GET') return apiChecksList(env);
  if (path === '/checks' && method === 'POST') return apiCheckCreate(request, env);
  const checkMatch = path.match(/^\/checks\/([A-Za-z0-9]+)$/);
  if (checkMatch && method === 'DELETE') return apiCheckDelete(env, checkMatch[1]);

  if (path === '/refund/lookup' && method === 'GET') return apiRefundLookup(request, env);
  if (path === '/refund' && method === 'POST') return apiRefundConfirm(request, env);

  if (path === '/webhook' && method === 'GET') return apiWebhookStatus(env);
  if (path === '/webhook' && method === 'POST') return apiWebhookSet(request, env);

  if (path === '/messages' && method === 'GET') return apiMessageReview(request, env);

  return json({ error: 'Not found' }, 404);
}

// ═══════════════════════════ ADMIN PANEL: HTML/CSS ═══════════════════════
const ADMIN_HTML_HEAD = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Auxox &middot; Admin</title>
<style>
:root{
  --bg:#0b0e14; --panel:#12161f; --panel2:#171c28; --border:#232a3a;
  --text:#e7ebf3; --muted:#8b93a7; --accent:#5b8cff; --accent2:#7c5bff;
  --good:#33c481; --bad:#ef5a6f; --warn:#e6b95c;
  --radius:10px; --shadow:0 8px 24px rgba(0,0,0,.35);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);min-height:100vh}
a{color:var(--accent)}
.hidden{display:none !important}
button{font:inherit;cursor:pointer}
input,select,textarea,button{border-radius:8px;border:1px solid var(--border);background:var(--panel2);color:var(--text);padding:9px 12px;font-size:14px}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}
textarea{resize:vertical;font-family:inherit}
.btn{background:linear-gradient(135deg,var(--accent),var(--accent2));border:none;color:#fff;font-weight:600;padding:10px 16px;transition:opacity .15s}
.btn:hover{opacity:.9}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.secondary{background:var(--panel2);border:1px solid var(--border);color:var(--text)}
.btn.danger{background:linear-gradient(135deg,#e04a5f,#c23350)}
.btn.sm{padding:6px 10px;font-size:12.5px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);padding:20px}
.muted{color:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.row{display:flex;gap:10px;align-items:center}
.row.wrap{flex-wrap:wrap}
.grid{display:grid;gap:16px}
.badge{display:inline-block;padding:3px 9px;border-radius:20px;font-size:12px;font-weight:600}
.badge.good{background:rgba(51,196,129,.15);color:var(--good)}
.badge.bad{background:rgba(239,90,111,.15);color:var(--bad)}
.badge.warn{background:rgba(230,185,92,.15);color:var(--warn)}
.badge.neutral{background:rgba(139,147,167,.15);color:var(--muted)}
.toast{position:fixed;bottom:20px;right:20px;background:var(--panel2);border:1px solid var(--border);padding:12px 18px;border-radius:8px;box-shadow:var(--shadow);z-index:999;max-width:320px;font-size:14px}
.toast.err{border-color:var(--bad);color:#ffb4be}
.toast.ok{border-color:var(--good);color:#a8f0cf}

/* ---- login ---- */
#loginView{min-height:100vh;display:flex;align-items:center;justify-content:center}
.loginBox{width:340px;padding:36px 32px}
.loginBox h1{margin:0 0 4px;font-size:22px}
.loginBox p{margin:0 0 22px;color:var(--muted);font-size:13.5px}
.loginBox input{width:100%;margin-bottom:14px}
.loginBox .btn{width:100%}
.loginErr{color:var(--bad);font-size:13px;min-height:18px;margin-top:-4px;margin-bottom:10px}

/* ---- shell ---- */
#appShell{display:none;min-height:100vh;grid-template-columns:230px 1fr}
#appShell.show{display:grid}
.sidebar{background:var(--panel);border-right:1px solid var(--border);padding:20px 14px;display:flex;flex-direction:column}
.sidebar h1{font-size:17px;margin:4px 8px 20px}
.sidebar h1 span{color:var(--accent)}
.navitem{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;color:var(--muted);cursor:pointer;font-size:14px;font-weight:500;margin-bottom:2px}
.navitem:hover{background:var(--panel2);color:var(--text)}
.navitem.active{background:rgba(91,140,255,.12);color:var(--accent)}
.sidebar .spacer{flex:1}
.session{font-size:12px;color:var(--muted);padding:10px 12px}
.main{padding:26px 32px;overflow-y:auto;max-height:100vh}
.topbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:22px}
.topbar h2{margin:0;font-size:20px}
.view{display:none}
.view.active{display:block}
.statgrid{grid-template-columns:repeat(auto-fit,minmax(180px,1fr));margin-bottom:24px}
.stat .n{font-size:26px;font-weight:700}
.stat .l{color:var(--muted);font-size:12.5px;margin-top:4px}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.03em;padding:8px 10px;border-bottom:1px solid var(--border)}
td{padding:10px;border-bottom:1px solid var(--border)}
tr:hover td{background:rgba(255,255,255,.02)}
.clickable{cursor:pointer}
.copyid{cursor:pointer;border-bottom:1px dashed var(--muted)}
.modalOverlay{position:fixed;inset:0;background:rgba(0,0,0,.55);display:none;align-items:flex-start;justify-content:center;padding:5vh 20px;z-index:100;overflow-y:auto}
.modalOverlay.show{display:flex}
.modal{background:var(--panel);border:1px solid var(--border);border-radius:var(--radius);width:560px;max-width:100%;padding:26px;box-shadow:var(--shadow)}
.modal h3{margin-top:0}
.closeX{float:right;cursor:pointer;color:var(--muted);font-size:20px;line-height:1}
.field{margin-bottom:14px}
.field label{display:block;font-size:12.5px;color:var(--muted);margin-bottom:5px;font-weight:600}
.field input,.field select,.field textarea{width:100%}
.toggle{display:flex;align-items:center;justify-content:space-between;padding:11px 0;border-bottom:1px solid var(--border)}
.toggle:last-child{border-bottom:none}
.switch{position:relative;width:42px;height:24px;background:var(--border);border-radius:20px;cursor:pointer;transition:background .15s;flex:none}
.switch.on{background:var(--good)}
.switch::after{content:'';position:absolute;top:3px;left:3px;width:18px;height:18px;background:#fff;border-radius:50%;transition:left .15s}
.switch.on::after{left:21px}
.pagebar{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:14px}
.progressbar{height:8px;background:var(--panel2);border-radius:6px;overflow:hidden;margin-top:10px}
.progressbar .fill{height:100%;background:linear-gradient(135deg,var(--accent),var(--accent2));width:0%;transition:width .2s}
.section{margin-bottom:24px}
.section h3{font-size:14px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;margin-bottom:10px}
</style>
</head>`;

const ADMIN_HTML_BODY = `<body>
<div id="loginView">
  <div class="loginBox card">
    <h1>Auxox <span>Admin</span></h1>
    <p>Enter the admin password to continue.</p>
    <div class="loginErr" id="loginErr"></div>
    <input type="password" id="loginPw" placeholder="Password" autocomplete="current-password">
    <button class="btn" id="loginBtn">Sign In</button>
  </div>
</div>

<div id="appShell">
  <div class="sidebar">
    <h1>Auxox <span>Admin</span></h1>
    <div class="navitem" data-view="dashboard">\u{1F4CA}&nbsp;&nbsp;Dashboard</div>
    <div class="navitem" data-view="users">\u{1F465}&nbsp;&nbsp;Users</div>
    <div class="navitem" data-view="createuser">\u2795&nbsp;&nbsp;Create User</div>
    <div class="navitem" data-view="checks">\u{1F39F}&nbsp;&nbsp;Checks</div>
    <div class="navitem" data-view="broadcast">\u{1F4E2}&nbsp;&nbsp;Broadcast</div>
    <div class="navitem" data-view="review">\u{1F50E}&nbsp;&nbsp;Message Review</div>
    <div class="navitem" data-view="settings">\u2699\uFE0F&nbsp;&nbsp;Settings</div>
    <div class="spacer"></div>
    <div class="session" id="sessionInfo">Session active</div>
    <button class="btn secondary" id="logoutBtn" style="width:100%">Log Out</button>
  </div>

  <div class="main">
    <!-- Dashboard -->
    <div class="view" data-view="dashboard">
      <div class="topbar"><h2>Dashboard</h2><button class="btn secondary sm" id="refreshStats">Refresh</button></div>
      <div class="grid statgrid" id="statGrid"></div>
      <div class="card"><p class="muted" style="margin:0">Auxox Business Automation \u00B7 admin panel. All Telegram-bot-side admin commands have been moved here.</p></div>
    </div>

    <!-- Users -->
    <div class="view" data-view="users">
      <div class="topbar"><h2>Users</h2></div>
      <div class="row wrap" style="margin-bottom:16px">
        <input id="userSearch" placeholder="Search name, @username, or user ID" style="flex:1;min-width:220px">
        <button class="btn secondary" id="userSearchBtn">Search</button>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Name</th><th>Username</th><th>User ID</th><th>Balance</th><th>Premium</th><th>Connected</th><th>Status</th></tr></thead>
          <tbody id="usersTbody"></tbody>
        </table>
      </div>
      <div class="pagebar">
        <button class="btn secondary sm" id="usersPrev">\u2039 Prev</button>
        <span class="muted" id="usersPageLabel" style="font-size:13px"></span>
        <button class="btn secondary sm" id="usersNext">Next \u203A</button>
      </div>
    </div>

    <!-- Create User -->
    <div class="view" data-view="createuser">
      <div class="topbar"><h2>Create User</h2></div>
      <div class="card" style="max-width:480px">
        <p class="muted" style="margin-top:0;font-size:13.5px">Manually register a business connection. The connection ID is verified against Telegram before saving.</p>
        <div class="field"><label>Telegram User ID</label><input id="cuUserId" placeholder="e.g. 123456789"></div>
        <div class="field"><label>Business Connection ID</label><input id="cuConnId" placeholder="paste the connection id"></div>
        <button class="btn" id="cuSubmit">Verify &amp; Create</button>
        <div id="cuResult" style="margin-top:14px;font-size:13.5px"></div>
      </div>
    </div>

    <!-- Checks -->
    <div class="view" data-view="checks">
      <div class="topbar"><h2>Gift Checks</h2></div>
      <div class="card" style="max-width:480px;margin-bottom:20px">
        <div class="row wrap">
          <div class="field" style="flex:1;min-width:120px"><label>Amount (Stars)</label><input id="checkAmount" type="number" min="1"></div>
          <div class="field" style="flex:1;min-width:120px"><label>Max Uses</label><input id="checkUses" type="number" min="1" value="1"></div>
        </div>
        <button class="btn" id="checkCreateBtn">Generate Check</button>
        <div id="checkCreateResult" style="margin-top:12px;font-size:13.5px"></div>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Code</th><th>Amount</th><th>Uses</th><th>Created</th><th></th></tr></thead>
          <tbody id="checksTbody"></tbody>
        </table>
      </div>
    </div>

    <!-- Broadcast -->
    <div class="view" data-view="broadcast">
      <div class="topbar"><h2>Broadcast</h2></div>
      <div class="grid" style="grid-template-columns:1fr 1fr;align-items:start">
        <div class="card">
          <h3 style="margin-top:0;font-size:14px;color:var(--muted);text-transform:uppercase">Send Message to All Users</h3>
          <div class="field"><textarea id="bcText" rows="6" placeholder="HTML formatting supported: <b>bold</b>, <i>italic</i>, <a href=...>link</a>"></textarea></div>
          <button class="btn" id="bcSendBtn">Send Broadcast</button>
          <div id="bcProgress" class="hidden">
            <div class="progressbar"><div class="fill" id="bcFill"></div></div>
            <p class="muted" id="bcStatus" style="font-size:12.5px;margin-bottom:0"></p>
          </div>
        </div>
        <div class="card">
          <h3 style="margin-top:0;font-size:14px;color:var(--muted);text-transform:uppercase">Forward an Existing Message</h3>
          <p class="muted" style="font-size:12.5px;margin-top:0">Post the message in your log/review channel first, then forward it here by chat ID + message ID.</p>
          <div class="row wrap">
            <div class="field" style="flex:1"><label>From Chat ID</label><input id="fwChatId" placeholder="-100..."></div>
            <div class="field" style="flex:1"><label>Message ID</label><input id="fwMsgId" placeholder="e.g. 42"></div>
          </div>
          <button class="btn" id="fwSendBtn">Forward to All</button>
          <div id="fwProgress" class="hidden">
            <div class="progressbar"><div class="fill" id="fwFill"></div></div>
            <p class="muted" id="fwStatus" style="font-size:12.5px;margin-bottom:0"></p>
          </div>
        </div>
      </div>
    </div>

    <!-- Message Review -->
    <div class="view" data-view="review">
      <div class="topbar"><h2>Message Review</h2></div>
      <div class="row wrap" style="margin-bottom:16px">
        <input id="reviewUserId" placeholder="Filter by owner user ID (optional)" style="flex:1;min-width:220px">
        <button class="btn secondary" id="reviewFilterBtn">Filter</button>
        <button class="btn secondary" id="reviewClearBtn">Clear</button>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Date</th><th>From</th><th>Type</th><th>Content</th></tr></thead>
          <tbody id="reviewTbody"></tbody>
        </table>
      </div>
      <div class="pagebar">
        <button class="btn secondary sm" id="reviewPrev">\u2039 Prev</button>
        <span class="muted" id="reviewPageLabel" style="font-size:13px"></span>
        <button class="btn secondary sm" id="reviewNext">Next \u203A</button>
      </div>
    </div>

    <!-- Settings -->
    <div class="view" data-view="settings">
      <div class="topbar"><h2>Settings</h2></div>

      <div class="section card">
        <h3>Pricing</h3>
        <div class="row wrap">
          <div class="field" style="flex:1;min-width:160px"><label>Price per Day (Stars)</label><input id="priceInput" type="number" min="0.01" step="0.01"></div>
          <button class="btn" id="priceSaveBtn" style="align-self:flex-end;margin-bottom:14px">Save</button>
        </div>
      </div>

      <div class="section card">
        <h3>Webhook</h3>
        <div id="webhookStatus" class="muted" style="font-size:13px;margin-bottom:14px">Loading\u2026</div>
        <div class="field"><label>Worker Base URL</label><input id="whBaseUrl" placeholder="https://your-worker.your-subdomain.workers.dev"></div>
        <div class="field"><label>Confirm Webhook Secret</label><input id="whSecret" type="password" placeholder="Enter SECRET to confirm"></div>
        <button class="btn" id="whSetBtn">Set Webhooks</button>
        <div id="whResult" style="margin-top:10px;font-size:13.5px"></div>
      </div>

      <div class="section card">
        <h3>Advanced</h3>
        <div id="advSettingsGrid" class="grid" style="grid-template-columns:1fr 1fr;gap:12px"></div>
        <button class="btn secondary" id="advSaveBtn" style="margin-top:14px">Save Advanced Settings</button>
      </div>
    </div>
  </div>
</div>

<div class="modalOverlay" id="userModalOverlay">
  <div class="modal" id="userModal"></div>
</div>

<script>__ADMIN_JS__</script>
</body>
</html>`;

// ═══════════════════════════ ADMIN PANEL: CLIENT JS ═══════════════════════
const ADMIN_JS = "(function () {\n  'use strict';\n  const $ = (sel, root) => (root || document).querySelector(sel);\n  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));\n\n  // ---------- api helper ----------\n  async function api(path, opts) {\n    opts = opts || {};\n    const res = await fetch('/api/admin' + path, {\n      method: opts.method || 'GET',\n      headers: opts.body ? { 'content-type': 'application/json' } : undefined,\n      body: opts.body ? JSON.stringify(opts.body) : undefined,\n      credentials: 'same-origin',\n    });\n    if (res.status === 401) {\n      showLogin('Session expired. Please sign in again.');\n      throw new Error('unauthorized');\n    }\n    const data = await res.json().catch(() => ({}));\n    if (!res.ok) throw new Error(data.error || ('Request failed (' + res.status + ')'));\n    return data;\n  }\n\n  function toast(msg, kind) {\n    const t = document.createElement('div');\n    t.className = 'toast ' + (kind || '');\n    t.textContent = msg;\n    document.body.appendChild(t);\n    setTimeout(() => t.remove(), 4000);\n  }\n\n  function fmtDate(iso) {\n    if (!iso) return '\\u2014';\n    try {\n      const d = new Date(iso);\n      return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +\n        ' ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });\n    } catch (e) { return iso; }\n  }\n  function escapeHtml(s) {\n    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');\n  }\n  function copyText(text) {\n    navigator.clipboard && navigator.clipboard.writeText(text).then(() => toast('Copied: ' + text, 'ok'));\n  }\n\n  // ---------- login / shell ----------\n  function showLogin(err) {\n    $('#appShell').classList.remove('show');\n    $('#loginView').style.display = 'flex';\n    if (err) $('#loginErr').textContent = err;\n  }\n  function showApp() {\n    $('#loginView').style.display = 'none';\n    $('#appShell').classList.add('show');\n    switchView('dashboard');\n  }\n\n  $('#loginBtn').addEventListener('click', doLogin);\n  $('#loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });\n  async function doLogin() {\n    const pw = $('#loginPw').value;\n    $('#loginErr').textContent = '';\n    if (!pw) return;\n    try {\n      const res = await fetch('/api/admin/login', {\n        method: 'POST', headers: { 'content-type': 'application/json' },\n        body: JSON.stringify({ password: pw }), credentials: 'same-origin',\n      });\n      const data = await res.json().catch(() => ({}));\n      if (!res.ok) { $('#loginErr').textContent = data.error || 'Login failed.'; return; }\n      $('#loginPw').value = '';\n      showApp();\n    } catch (e) { $('#loginErr').textContent = 'Network error.'; }\n  }\n  $('#logoutBtn').addEventListener('click', async () => {\n    await api('/logout', { method: 'POST' }).catch(() => {});\n    showLogin();\n  });\n\n  const views = { dashboard: loadDashboard, users: () => loadUsers(1), createuser: null, checks: loadChecks, broadcast: loadWebhookStatusQuiet, review: () => loadReview(1), settings: loadSettingsView };\n  function switchView(name) {\n    $$('.navitem').forEach((n) => n.classList.toggle('active', n.dataset.view === name));\n    $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));\n    const loader = views[name];\n    if (loader) loader();\n  }\n  $$('.navitem').forEach((n) => n.addEventListener('click', () => switchView(n.dataset.view)));\n\n  // ---------- dashboard ----------\n  async function loadDashboard() {\n    try {\n      const s = await api('/stats');\n      const cards = [\n        ['Total Users', s.totalUsers], ['Banned', s.bannedUsers], ['Premium Active', s.premiumActive],\n        ['Business Connected', s.connected], ['Total Balance (\\u2B50)', Math.round(s.totalBalance)],\n        ['Lifetime Top-Ups (\\u2B50)', Math.round(s.topupSum)], ['Premium Sales', s.premiumRevenue],\n        ['Active Checks', s.checksCount], ['Cached Messages', s.cachedMsgs],\n      ];\n      $('#statGrid').innerHTML = cards.map(([l, n]) =>\n        '<div class=\"card stat\"><div class=\"n\">' + n + '</div><div class=\"l\">' + l + '</div></div>'\n      ).join('');\n    } catch (e) { toast(e.message, 'err'); }\n  }\n  $('#refreshStats').addEventListener('click', loadDashboard);\n\n  // ---------- users ----------\n  let usersPage = 1, usersQuery = '';\n  async function loadUsers(page) {\n    usersPage = page || usersPage;\n    try {\n      const data = await api('/users?page=' + usersPage + '&q=' + encodeURIComponent(usersQuery));\n      $('#usersTbody').innerHTML = data.users.map(rowForUser).join('') ||\n        '<tr><td colspan=\"7\" class=\"muted\" style=\"text-align:center;padding:24px\">No users found.</td></tr>';\n      $$('.openUser').forEach((el) => el.addEventListener('click', () => openUserModal(parseInt(el.dataset.uid, 10))));\n      $$('.copyid').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); copyText(el.dataset.id); }));\n      const totalPages = Math.max(1, Math.ceil(data.total / data.perPage));\n      $('#usersPageLabel').textContent = 'Page ' + data.page + ' of ' + totalPages + ' \\u00B7 ' + data.total + ' users';\n    } catch (e) { toast(e.message, 'err'); }\n  }\n  function rowForUser(u) {\n    const name = escapeHtml((u.first_name || '') + ' ' + (u.last_name || '')).trim() || '\\u2014';\n    const uname = u.username ? '@' + escapeHtml(u.username) : '\\u2014';\n    const prem = u.premium_active ? '<span class=\"badge good\">Active</span>' : '<span class=\"badge neutral\">None</span>';\n    const conn = u.business_connected ? '<span class=\"badge good\">Yes</span>' : '<span class=\"badge neutral\">No</span>';\n    const status = u.is_banned ? '<span class=\"badge bad\">Banned</span>' : '<span class=\"badge good\">OK</span>';\n    return '<tr class=\"clickable openUser\" data-uid=\"' + u.user_id + '\">' +\n      '<td>' + name + '</td><td>' + uname + '</td>' +\n      '<td class=\"mono copyid\" data-id=\"' + u.user_id + '\" title=\"Click to copy\">' + u.user_id + '</td>' +\n      '<td>' + Math.round(u.balance) + ' \\u2B50</td><td>' + prem + '</td><td>' + conn + '</td><td>' + status + '</td></tr>';\n  }\n  $('#userSearchBtn').addEventListener('click', () => { usersQuery = $('#userSearch').value.trim(); loadUsers(1); });\n  $('#userSearch').addEventListener('keydown', (e) => { if (e.key === 'Enter') { usersQuery = $('#userSearch').value.trim(); loadUsers(1); } });\n  $('#usersPrev').addEventListener('click', () => loadUsers(Math.max(1, usersPage - 1)));\n  $('#usersNext').addEventListener('click', () => loadUsers(usersPage + 1));\n\n  const FONT_NAMES = ['Normal','Fullwidth','Circled','Double-Struck','Sans','Sans Bold','Bold','Monospace','Subscript','Superscript','Clock','Brackets','Dotted'];\n\n  async function openUserModal(uid) {\n    const overlay = $('#userModalOverlay'), modal = $('#userModal');\n    modal.innerHTML = '<p class=\"muted\">Loading\\u2026</p>';\n    overlay.classList.add('show');\n    try {\n      const d = await api('/users/' + uid);\n      renderUserModal(d);\n    } catch (e) {\n      modal.innerHTML = '<span class=\"closeX\" id=\"umErrClose\">&times;</span><p>' + escapeHtml(e.message) + '</p>';\n      $('#umErrClose').addEventListener('click', () => overlay.classList.remove('show'));\n    }\n  }\n  overlayCloseWiring();\n  function overlayCloseWiring() {\n    $('#userModalOverlay').addEventListener('click', (e) => { if (e.target.id === 'userModalOverlay') e.target.classList.remove('show'); });\n  }\n\n  function renderUserModal(d) {\n    const u = d.user, a = d.automation || {};\n    const name = escapeHtml((u.first_name || '') + ' ' + (u.last_name || '')).trim() || '\\u2014';\n    const modal = $('#userModal');\n    modal.innerHTML =\n      '<span class=\"closeX\" id=\"umClose\">&times;</span>' +\n      '<h3>' + name + ' <span class=\"muted mono\" style=\"font-size:13px;font-weight:400\">#' + u.user_id + '</span></h3>' +\n      '<div class=\"row wrap\" style=\"margin-bottom:16px\">' +\n        '<span class=\"badge neutral\">' + (u.username ? '@' + escapeHtml(u.username) : 'no username') + '</span>' +\n        (d.business_connection ? '<span class=\"badge good\">Business Connected</span>' : '<span class=\"badge neutral\">Not Connected</span>') +\n        (d.premium_active ? '<span class=\"badge good\">Premium \\u00B7 ' + fmtDate(d.premium_active.expires_at) + '</span>' : '<span class=\"badge neutral\">No Premium</span>') +\n      '</div>' +\n\n      '<div class=\"section\"><h3>Ban</h3><div class=\"toggle\"><span>Account banned</span>' +\n        '<div class=\"switch ' + (u.is_banned ? 'on' : '') + '\" id=\"banSwitch\"></div></div></div>' +\n\n      '<div class=\"section\"><h3>Balance \\u00B7 ' + Math.round(u.balance) + ' \\u2B50</h3>' +\n        '<div class=\"row\"><input id=\"balAmount\" type=\"number\" placeholder=\"e.g. 50 or -20\" style=\"flex:1\"><button class=\"btn sm\" id=\"balApply\">Apply</button></div></div>' +\n\n      '<div class=\"section\"><h3>Automation (acting as this user)</h3>' +\n        '<div class=\"toggle\"><span>\\u{1F550} Name Clock</span><div class=\"switch ' + (a.name_auto_enabled ? 'on' : '') + '\" data-field=\"name_auto_enabled\"></div></div>' +\n        '<div class=\"row wrap\" style=\"margin:8px 0\"><input id=\"tzInput\" type=\"number\" step=\"0.5\" placeholder=\"UTC offset\" value=\"' + (a.tz_offset || 0) + '\" style=\"width:120px\">' +\n          '<select id=\"fontInput\" style=\"flex:1\">' + FONT_NAMES.map((f, i) => '<option value=\"' + i + '\"' + (a.font_id === i ? ' selected' : '') + '>' + f + '</option>').join('') + '</select>' +\n          '<button class=\"btn secondary sm\" id=\"nameSaveBtn\">Save</button></div>' +\n        '<div class=\"toggle\"><span>\\u{1F441} Auto Read</span><div class=\"switch ' + (a.auto_read_enabled ? 'on' : '') + '\" data-field=\"auto_read_enabled\"></div></div>' +\n        '<div class=\"toggle\"><span>\\u{1F6E1} Anti-Delete</span><div class=\"switch ' + (a.anti_delete_enabled ? 'on' : '') + '\" data-field=\"anti_delete_enabled\"></div></div>' +\n        '<div class=\"toggle\"><span>\\u{1F4AC} Auto Reply</span><div class=\"switch ' + (a.auto_response_enabled ? 'on' : '') + '\" data-field=\"auto_response_enabled\"></div></div>' +\n        '<div class=\"field\" style=\"margin-top:10px\"><label>Auto-reply text (plain text; overrides any rich media reply)</label>' +\n          '<textarea id=\"autoReplyText\" rows=\"3\">' + escapeHtml(a.auto_response_text || '') + '</textarea>' +\n          '<button class=\"btn secondary sm\" id=\"autoReplySaveBtn\" style=\"margin-top:8px\">Save Reply Text</button></div></div>' +\n\n      '<div class=\"section\"><h3>Recent Transactions</h3>' +\n      '<table><tbody>' + (d.recent_transactions.length ? d.recent_transactions.map((t) =>\n        '<tr><td>' + fmtDate(t.created_at) + '</td><td>' + escapeHtml(t.type) + '</td><td>' + (t.amount > 0 ? '+' : '') + t.amount + ' \\u2B50</td></tr>'\n      ).join('') : '<tr><td class=\"muted\">No transactions yet.</td></tr>') + '</tbody></table></div>';\n\n    $('#umClose').addEventListener('click', () => $('#userModalOverlay').classList.remove('show'));\n    $('#banSwitch').addEventListener('click', async (e) => {\n      const nowOn = !e.target.classList.contains('on');\n      try { await api('/users/' + u.user_id + '/ban', { method: 'POST', body: { banned: nowOn } }); e.target.classList.toggle('on', nowOn); toast('Updated.', 'ok'); loadUsers(); }\n      catch (err) { toast(err.message, 'err'); }\n    });\n    $('#balApply').addEventListener('click', async () => {\n      const amt = Number($('#balAmount').value);\n      if (!amt) return toast('Enter a non-zero amount.', 'err');\n      try { const r = await api('/users/' + u.user_id + '/balance', { method: 'POST', body: { amount: amt } }); toast('New balance: ' + Math.round(r.balance) + ' \\u2B50', 'ok'); openUserModal(u.user_id); loadUsers(); }\n      catch (err) { toast(err.message, 'err'); }\n    });\n    $$('.switch[data-field]', modal).forEach((sw) => sw.addEventListener('click', async () => {\n      const field = sw.dataset.field, nowOn = !sw.classList.contains('on');\n      try { await api('/users/' + u.user_id + '/automation', { method: 'POST', body: { [field]: nowOn } }); sw.classList.toggle('on', nowOn); toast('Updated.', 'ok'); }\n      catch (err) { toast(err.message, 'err'); }\n    }));\n    $('#nameSaveBtn').addEventListener('click', async () => {\n      try { await api('/users/' + u.user_id + '/automation', { method: 'POST', body: { tz_offset: Number($('#tzInput').value) || 0, font_id: parseInt($('#fontInput').value, 10) } }); toast('Saved.', 'ok'); }\n      catch (err) { toast(err.message, 'err'); }\n    });\n    $('#autoReplySaveBtn').addEventListener('click', async () => {\n      try { await api('/users/' + u.user_id + '/automation', { method: 'POST', body: { auto_response_text: $('#autoReplyText').value } }); toast('Saved.', 'ok'); }\n      catch (err) { toast(err.message, 'err'); }\n    });\n  }\n\n  // ---------- checks ----------\n  async function loadChecks() {\n    try {\n      const data = await api('/checks');\n      $('#checksTbody').innerHTML = data.checks.map((c) =>\n        '<tr><td class=\"mono\">' + c.code + '</td><td>' + c.amount + ' \\u2B50</td><td>' + c.used + ' / ' + c.max_uses + '</td>' +\n        '<td>' + fmtDate(c.created_at) + '</td><td><button class=\"btn danger sm delCheck\" data-code=\"' + c.code + '\">Delete</button></td></tr>'\n      ).join('') || '<tr><td colspan=\"5\" class=\"muted\" style=\"text-align:center;padding:20px\">No checks yet.</td></tr>';\n      $$('.delCheck').forEach((b) => b.addEventListener('click', async () => {\n        if (!confirm('Delete check ' + b.dataset.code + '?')) return;\n        try { await api('/checks/' + b.dataset.code, { method: 'DELETE' }); loadChecks(); toast('Deleted.', 'ok'); }\n        catch (e) { toast(e.message, 'err'); }\n      }));\n    } catch (e) { toast(e.message, 'err'); }\n  }\n  $('#checkCreateBtn').addEventListener('click', async () => {\n    const amount = parseInt($('#checkAmount').value, 10), maxUses = parseInt($('#checkUses').value, 10);\n    try {\n      const r = await api('/checks', { method: 'POST', body: { amount, max_uses: maxUses } });\n      $('#checkCreateResult').innerHTML = 'Created \\u2014 share this command with the recipient:<br>' +\n        '<span class=\"mono copyid\" id=\"redeemCmd\" style=\"font-size:14px\">' + escapeHtml(r.redeem_command) + '</span>';\n      $('#redeemCmd').addEventListener('click', () => copyText(r.redeem_command));\n      loadChecks();\n    } catch (e) { toast(e.message, 'err'); }\n  });\n\n  // ---------- create user ----------\n  $('#cuSubmit').addEventListener('click', async () => {\n    const userId = $('#cuUserId').value.trim(), connId = $('#cuConnId').value.trim();\n    if (!userId || !connId) return toast('Both fields are required.', 'err');\n    $('#cuResult').textContent = 'Verifying with Telegram\\u2026';\n    try {\n      const r = await api('/users', { method: 'POST', body: { user_id: userId, business_connection_id: connId } });\n      $('#cuResult').innerHTML = '<span class=\"badge good\">Success</span> Linked ' + escapeHtml(r.user.first_name || '') + ' (#' + r.user.user_id + ')';\n      $('#cuUserId').value = ''; $('#cuConnId').value = '';\n    } catch (e) { $('#cuResult').innerHTML = '<span class=\"badge bad\">Failed</span> ' + escapeHtml(e.message); }\n  });\n\n  // ---------- broadcast ----------\n  $('#bcSendBtn').addEventListener('click', async () => {\n    const text = $('#bcText').value.trim();\n    if (!text) return toast('Message is empty.', 'err');\n    if (!confirm('Send this message to every user?')) return;\n    try {\n      const r = await api('/broadcast', { method: 'POST', body: { text } });\n      $('#bcProgress').classList.remove('hidden');\n      pollJob(r.jobId, r.total, 'bcFill', 'bcStatus');\n    } catch (e) { toast(e.message, 'err'); }\n  });\n  $('#fwSendBtn').addEventListener('click', async () => {\n    const fromChatId = $('#fwChatId').value.trim(), msgId = $('#fwMsgId').value.trim();\n    if (!fromChatId || !msgId) return toast('Both fields are required.', 'err');\n    if (!confirm('Forward this message to every user?')) return;\n    try {\n      const r = await api('/forward', { method: 'POST', body: { from_chat_id: fromChatId, message_id: msgId } });\n      $('#fwProgress').classList.remove('hidden');\n      pollJob(r.jobId, r.total, 'fwFill', 'fwStatus');\n    } catch (e) { toast(e.message, 'err'); }\n  });\n  function pollJob(jobId, total, fillId, statusId) {\n    const timer = setInterval(async () => {\n      try {\n        const d = await api('/broadcast-status/' + jobId);\n        const j = d.job;\n        const pct = total ? Math.round(((j.sent + j.failed) / total) * 100) : 100;\n        $('#' + fillId).style.width = pct + '%';\n        $('#' + statusId).textContent = j.sent + ' sent, ' + j.failed + ' failed of ' + total + (j.done ? ' \\u2014 done' : '\\u2026');\n        if (j.done) clearInterval(timer);\n      } catch (e) { clearInterval(timer); }\n    }, 1500);\n  }\n\n  // ---------- message review ----------\n  let reviewPage = 1, reviewUserId = '';\n  async function loadReview(page) {\n    reviewPage = page || reviewPage;\n    try {\n      const q = reviewUserId ? '&user_id=' + encodeURIComponent(reviewUserId) : '';\n      const data = await api('/messages?page=' + reviewPage + q);\n      $('#reviewTbody').innerHTML = data.messages.map((m) =>\n        '<tr><td>' + fmtDate(m.date) + '</td><td>' + escapeHtml(m.from_username ? '@' + m.from_username : m.from_name) + '</td>' +\n        '<td>' + escapeHtml(m.media_type) + '</td><td>' + escapeHtml((m.text || '').slice(0, 120)) + '</td></tr>'\n      ).join('') || '<tr><td colspan=\"4\" class=\"muted\" style=\"text-align:center;padding:20px\">No messages.</td></tr>';\n      const totalPages = Math.max(1, Math.ceil(data.total / data.perPage));\n      $('#reviewPageLabel').textContent = 'Page ' + data.page + ' of ' + totalPages + ' \\u00B7 ' + data.total + ' messages';\n    } catch (e) { toast(e.message, 'err'); }\n  }\n  $('#reviewFilterBtn').addEventListener('click', () => { reviewUserId = $('#reviewUserId').value.trim(); loadReview(1); if (reviewUserId) openUserModal(parseInt(reviewUserId, 10)); });\n  $('#reviewClearBtn').addEventListener('click', () => { reviewUserId = ''; $('#reviewUserId').value = ''; loadReview(1); });\n  $('#reviewPrev').addEventListener('click', () => loadReview(Math.max(1, reviewPage - 1)));\n  $('#reviewNext').addEventListener('click', () => loadReview(reviewPage + 1));\n\n  // ---------- settings ----------\n  const ADV_FIELDS = [\n    ['min_charge', 'Min Top-Up (Stars)'], ['max_charge', 'Max Top-Up (Stars)'],\n    ['broadcast_delay_ms', 'Broadcast Delay (ms/user)'], ['name_auto_update_interval', 'Name Clock Interval (sec)'],\n    ['max_message_age_days', 'Message Retention (days)'],\n    ['rate_limit_1_limit', 'Burst Limit \\u00B7 max actions'], ['rate_limit_1_interval', 'Burst Limit \\u00B7 window (sec)'], ['rate_limit_1_block_secs', 'Burst Limit \\u00B7 block (sec)'],\n    ['rate_limit_2_limit', 'Sustained Limit \\u00B7 max actions'], ['rate_limit_2_interval', 'Sustained Limit \\u00B7 window (sec)'], ['rate_limit_2_block_mins', 'Sustained Limit \\u00B7 block (min)'],\n  ];\n  async function loadSettingsView() {\n    try {\n      const [{ price_per_day }, { settings }] = await Promise.all([api('/price'), api('/settings')]);\n      $('#priceInput').value = price_per_day;\n      $('#advSettingsGrid').innerHTML = ADV_FIELDS.map(([key, label]) =>\n        '<div class=\"field\"><label>' + label + '</label><input class=\"advField\" data-key=\"' + key + '\" type=\"number\" step=\"any\" value=\"' + escapeHtml(settings[key]) + '\"></div>'\n      ).join('');\n    } catch (e) { toast(e.message, 'err'); }\n    loadWebhookStatus();\n  }\n  $('#priceSaveBtn').addEventListener('click', async () => {\n    try { await api('/price', { method: 'POST', body: { price_per_day: Number($('#priceInput').value) } }); toast('Saved.', 'ok'); }\n    catch (e) { toast(e.message, 'err'); }\n  });\n  $('#advSaveBtn').addEventListener('click', async () => {\n    const body = {};\n    $$('.advField').forEach((el) => { body[el.dataset.key] = el.value; });\n    try { await api('/settings', { method: 'POST', body }); toast('Advanced settings saved.', 'ok'); }\n    catch (e) { toast(e.message, 'err'); }\n  });\n\n  async function loadWebhookStatus() {\n    try {\n      const d = await api('/webhook');\n      const line = (label, info) => '<div>' + label + ': ' +\n        (info && info.url ? '<span class=\"badge good\">Set</span> <span class=\"mono\" style=\"font-size:12px\">' + escapeHtml(info.url) + '</span>' : '<span class=\"badge warn\">Not set</span>') +\n        (info && info.last_error_message ? '<br><span class=\"muted\" style=\"font-size:12px\">Last error: ' + escapeHtml(info.last_error_message) + '</span>' : '') + '</div>';\n      $('#webhookStatus').innerHTML = line('Main bot', d.main) + line('Alerts bot', d.notif);\n    } catch (e) { $('#webhookStatus').textContent = 'Could not load status.'; }\n  }\n  async function loadWebhookStatusQuiet() { /* broadcast view has no webhook UI; placeholder for nav map */ }\n  $('#whSetBtn').addEventListener('click', async () => {\n    const base_url = $('#whBaseUrl').value.trim(), secret = $('#whSecret').value;\n    if (!base_url || !secret) return toast('Both fields are required.', 'err');\n    try {\n      const r = await api('/webhook', { method: 'POST', body: { base_url, secret } });\n      $('#whResult').innerHTML = '<span class=\"badge good\">Webhooks set</span>';\n      $('#whSecret').value = '';\n      loadWebhookStatus();\n    } catch (e) { $('#whResult').innerHTML = '<span class=\"badge bad\">Failed</span> ' + escapeHtml(e.message); }\n  });\n\n  // ---------- boot ----------\n  (async function init() {\n    try {\n      const s = await api('/session');\n      if (s.authenticated) showApp(); else showLogin();\n    } catch (e) { showLogin(); }\n  })();\n})();\n";
const ADMIN_HTML = ADMIN_HTML_HEAD + ADMIN_HTML_BODY.replace('__ADMIN_JS__', () => ADMIN_JS);

// ═══════════════════════════ ROOT FETCH / SCHEDULED ═══════════════════════
async function handleWebhookRoute(request, env, ctx, isNotif) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secretHeader = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.SECRET || secretHeader !== env.SECRET) return new Response('Forbidden', { status: 403 });
  let update;
  try { update = await request.json(); } catch { return new Response('Bad request', { status: 400 }); }
  if (isNotif) {
    ctx.waitUntil(handleNotifUpdate(env, update));
  } else {
    ctx.waitUntil(handleUpdate(env, ctx, update));
  }
  return new Response('OK', { status: 200 });
}

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env);
      const url = new URL(request.url);

      if (url.pathname === '/webhook') return handleWebhookRoute(request, env, ctx, false);
      if (url.pathname === '/webhook/notif') return handleWebhookRoute(request, env, ctx, true);

      if (url.pathname.startsWith('/api/admin/')) return routeAdminApi(request, env, ctx, url);

      if (url.pathname === '/' || url.pathname === '/admin') {
        return new Response(ADMIN_HTML, { headers: { 'content-type': 'text/html;charset=UTF-8' } });
      }

      return new Response('Not found', { status: 404 });
    } catch (e) {
      console.error('fetch handler error:', e.stack || e.message);
      return new Response('Internal error', { status: 500 });
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduledJobs(env).catch((e) => console.error('scheduled error:', e.stack || e.message)));
  },
};
