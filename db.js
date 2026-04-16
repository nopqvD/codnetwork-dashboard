/**
 * Database module — PostgreSQL (pg) with JSON file fallback
 * Set DATABASE_URL in .env to enable PostgreSQL mode.
 */
const fs   = require('fs');
const path = require('path');

const DB_PATH    = path.join(__dirname, 'db.json');
const usePostgres = !!process.env.DATABASE_URL;

/* ─── File-based helpers (fallback) ─────────────────────────────────────── */
function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return {}; }
}
function saveDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data)); }
  catch (e) { console.error('[DB] Save error:', e.message); }
}

/* ─── PostgreSQL Pool (only created when DATABASE_URL is present) ────────── */
let pool = null;
if (usePostgres) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost')
        ? false
        : { rejectUnauthorized: false },
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    pool.on('error', (err) => console.error('[DB] Idle client error:', err.message));
    console.log('[DB] PostgreSQL pool created.');
  } catch (e) {
    console.error('[DB] pg module not found or pool creation failed:', e.message);
    console.error('[DB] Falling back to file storage. Run: npm install pg');
  }
}

async function query(sql, params = []) {
  if (!pool) throw new Error('PostgreSQL pool not available');
  const client = await pool.connect();
  try {
    return await client.query(sql, params);
  } finally {
    client.release();
  }
}

/* ─── Crypto helper (for token_hash) ────────────────────────────────────── */
const crypto = require('crypto');
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/* ══════════════════════════════════════════════════════════════════════════
   USER AUTH (PostgreSQL only)
   ══════════════════════════════════════════════════════════════════════════ */

let bcrypt = null;
try { bcrypt = require('bcryptjs'); } catch {}

async function createUser(email, password, apiToken, name) {
  if (!pool || !bcrypt) throw new Error('PostgreSQL and bcryptjs required');
  const hash = await bcrypt.hash(password, 10);
  const res = await query(
    `INSERT INTO users(email, password_hash, api_token, name)
     VALUES($1, $2, $3, $4) RETURNING id, email, name, created_at`,
    [email.toLowerCase().trim(), hash, apiToken, name || '']
  );
  return res.rows[0];
}

async function getUserByEmail(email) {
  if (!pool) return null;
  const res = await query(
    'SELECT id, email, password_hash, api_token, name, created_at FROM users WHERE email=$1',
    [email.toLowerCase().trim()]
  );
  return res.rows[0] || null;
}

async function getUserById(id) {
  if (!pool) return null;
  const res = await query(
    'SELECT id, email, api_token, name, created_at FROM users WHERE id=$1',
    [id]
  );
  return res.rows[0] || null;
}

async function updateUserApiToken(userId, apiToken) {
  if (!pool) return;
  await query('UPDATE users SET api_token=$1, updated_at=NOW() WHERE id=$2', [apiToken, userId]);
}

async function verifyPassword(plainPassword, hash) {
  if (!bcrypt) throw new Error('bcryptjs not available');
  return bcrypt.compare(plainPassword, hash);
}

/* ── Sessions ──────────────────────────────────────────────────────────── */

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

async function createSession(userId, daysValid = 30) {
  if (!pool) throw new Error('PostgreSQL required');
  const token = generateSessionToken();
  const expires = new Date(Date.now() + daysValid * 24 * 60 * 60 * 1000);
  await query(
    'INSERT INTO sessions(user_id, session_token, expires_at) VALUES($1, $2, $3)',
    [userId, token, expires]
  );
  return { sessionToken: token, expiresAt: expires };
}

async function getSession(sessionToken) {
  if (!pool) return null;
  const res = await query(
    `SELECT s.user_id, s.expires_at, u.email, u.api_token, u.name
     FROM sessions s JOIN users u ON s.user_id = u.id
     WHERE s.session_token=$1 AND s.expires_at > NOW()`,
    [sessionToken]
  );
  return res.rows[0] || null;
}

async function deleteSession(sessionToken) {
  if (!pool) return;
  await query('DELETE FROM sessions WHERE session_token=$1', [sessionToken]);
}

async function cleanExpiredSessions() {
  if (!pool) return;
  await query('DELETE FROM sessions WHERE expires_at < NOW()');
}

/* ══════════════════════════════════════════════════════════════════════════
   NOTIFICATIONS
   ══════════════════════════════════════════════════════════════════════════ */

async function createNotification(userId, type, title, message, sku) {
  if (!pool) return null;
  const res = await query(
    `INSERT INTO notifications(user_id, type, title, message, sku)
     VALUES($1, $2, $3, $4, $5) RETURNING id, type, title, message, sku, is_read, created_at`,
    [userId, type, title, message, sku || null]
  );
  return res.rows[0];
}

async function getNotifications(userId, limit = 50) {
  if (!pool) return [];
  const res = await query(
    `SELECT id, type, title, message, sku, is_read, created_at
     FROM notifications WHERE user_id=$1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return res.rows;
}

async function getUnreadNotificationCount(userId) {
  if (!pool) return 0;
  const res = await query(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id=$1 AND is_read=FALSE',
    [userId]
  );
  return parseInt(res.rows[0].count) || 0;
}

async function markNotificationRead(userId, notifId) {
  if (!pool) return;
  await query(
    'UPDATE notifications SET is_read=TRUE WHERE id=$1 AND user_id=$2',
    [notifId, userId]
  );
}

async function markAllNotificationsRead(userId) {
  if (!pool) return;
  await query('UPDATE notifications SET is_read=TRUE WHERE user_id=$1 AND is_read=FALSE', [userId]);
}

/**
 * Smart stock notifications based on Coverage Days vs Shipping Time.
 *
 * @param {number} userId
 * @param {Array}  coverageData — array of { groupName, co, coverageDays, shippingDays, stock, dailyUse, sku }
 *
 * Alert levels (buffer = coverageDays - shippingDays):
 *   buffer 6–10  → "prepare"    جهّز الطلب
 *   buffer 1–5   → "urgent"     طلب مخزون إجباري
 *   buffer ≤ 0   → "critical"   خطر — أطلب الآن!
 */
async function checkAndNotifyCoverage(userId, coverageData) {
  if (!pool) return [];
  const newNotifs = [];

  for (const item of (coverageData || [])) {
    const buffer = item.coverageDays - item.shippingDays;
    let type = null;
    let title = '';
    let message = '';

    if (buffer <= 0) {
      type = 'critical';
      title = '🔴 خطر — أطلب الآن!';
      message = `${item.groupName} (${item.co}): المخزون ${item.stock} قطعة يكفي ${item.coverageDays} يوم فقط، ووقت الشحن ${item.shippingDays} يوم. أطلب فوراً!`;
    } else if (buffer <= 5) {
      type = 'urgent';
      title = '🟠 طلب مخزون جديد إجباري';
      message = `${item.groupName} (${item.co}): المخزون يكفي ${item.coverageDays} يوم، ووقت الشحن ${item.shippingDays} يوم. المتبقي ${buffer} يوم فقط — اطلب الآن!`;
    } else if (buffer <= 10) {
      type = 'prepare';
      title = '🟡 جهّز الطلب';
      message = `${item.groupName} (${item.co}): المخزون يكفي ${item.coverageDays} يوم، ووقت الشحن ${item.shippingDays} يوم. المتبقي ${buffer} يوم — جهّز طلب التوريد.`;
    }

    if (!type) continue; // buffer > 10, no notification needed

    const notifKey = (item.sku || item.groupName) + '_' + item.co;
    // Avoid duplicate notifications for the same SKU+country within 12 hours
    const existing = await query(
      `SELECT id FROM notifications
       WHERE user_id=$1 AND sku=$2 AND type=$3
       AND created_at > NOW() - INTERVAL '12 hours'`,
      [userId, notifKey, type]
    );
    if (existing.rows.length === 0) {
      const notif = await createNotification(userId, type, title, message, notifKey);
      if (notif) newNotifs.push(notif);
    }
  }
  return newNotifs;
}

/* ══════════════════════════════════════════════════════════════════════════
   SHIPPING CONFIG
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Get shipping days for a country.
 * @returns {number} days (default 30)
 */
async function getShippingDays(token, country) {
  if (pool) {
    try {
      const th = hashToken(token);
      const res = await query(
        'SELECT days FROM shipping_config WHERE token_hash=$1 AND country=$2',
        [th, country]
      );
      return res.rows.length ? res.rows[0].days : 30;
    } catch (e) {
      console.error('[DB] getShippingDays error:', e.message);
    }
  }
  // file fallback
  const db = loadDB();
  return (db.shippingDays?.[country]) ?? 30;
}

/**
 * Save shipping days for a country.
 */
async function saveShippingDays(token, country, days) {
  if (pool) {
    try {
      const th = hashToken(token);
      await query(
        `INSERT INTO shipping_config(token_hash, country, days)
         VALUES($1,$2,$3)
         ON CONFLICT(token_hash, country) DO UPDATE SET days=EXCLUDED.days`,
        [th, country, days]
      );
      return;
    } catch (e) {
      console.error('[DB] saveShippingDays error:', e.message);
    }
  }
  // file fallback
  const db = loadDB();
  if (!db.shippingDays) db.shippingDays = {};
  db.shippingDays[country] = days;
  saveDB(db);
}

/**
 * Get all shipping days for a token as { country: days } map.
 */
async function getAllShippingDays(token) {
  if (pool) {
    try {
      const th = hashToken(token);
      const res = await query(
        'SELECT country, days FROM shipping_config WHERE token_hash=$1',
        [th]
      );
      const map = {};
      for (const row of res.rows) map[row.country] = row.days;
      return map;
    } catch (e) {
      console.error('[DB] getAllShippingDays error:', e.message);
    }
  }
  const db = loadDB();
  return db.shippingDays || {};
}

/* ══════════════════════════════════════════════════════════════════════════
   INVENTORY DELTA
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Get inventory delta for a SKU.
 * @returns {number}
 */
async function getInventoryDelta(token, sku) {
  if (pool) {
    try {
      const th = hashToken(token);
      const res = await query(
        'SELECT delta FROM inventory_delta WHERE token_hash=$1 AND sku=$2',
        [th, sku]
      );
      return res.rows.length ? res.rows[0].delta : 0;
    } catch (e) {
      console.error('[DB] getInventoryDelta error:', e.message);
    }
  }
  const db = loadDB();
  return (db.inventoryDelta?.[sku]) ?? 0;
}

/**
 * Get all inventory deltas for a token as { sku: delta } map.
 */
async function getAllInventoryDeltas(token) {
  if (pool) {
    try {
      const th = hashToken(token);
      const res = await query(
        'SELECT sku, delta FROM inventory_delta WHERE token_hash=$1',
        [th]
      );
      const map = {};
      for (const row of res.rows) map[row.sku] = row.delta;
      return map;
    } catch (e) {
      console.error('[DB] getAllInventoryDeltas error:', e.message);
    }
  }
  const db = loadDB();
  return db.inventoryDelta || {};
}

/**
 * Update (upsert) inventory delta for a SKU.
 * @param {number} deltaDiff — amount to add (can be negative)
 */
async function updateInventoryDelta(token, sku, deltaDiff) {
  if (pool) {
    try {
      const th = hashToken(token);
      await query(
        `INSERT INTO inventory_delta(token_hash, sku, delta, updated_at)
         VALUES($1,$2,$3,NOW())
         ON CONFLICT(token_hash, sku)
         DO UPDATE SET delta = inventory_delta.delta + EXCLUDED.delta,
                       updated_at = NOW()`,
        [th, sku, deltaDiff]
      );
      return;
    } catch (e) {
      console.error('[DB] updateInventoryDelta error:', e.message);
    }
  }
  // file fallback
  const db = loadDB();
  if (!db.inventoryDelta) db.inventoryDelta = {};
  db.inventoryDelta[sku] = (db.inventoryDelta[sku] || 0) + deltaDiff;
  saveDB(db);
}

/**
 * Set inventory delta for a SKU to an exact value.
 */
async function setInventoryDelta(token, sku, delta) {
  if (pool) {
    try {
      const th = hashToken(token);
      await query(
        `INSERT INTO inventory_delta(token_hash, sku, delta, updated_at)
         VALUES($1,$2,$3,NOW())
         ON CONFLICT(token_hash, sku)
         DO UPDATE SET delta = EXCLUDED.delta, updated_at = NOW()`,
        [th, sku, delta]
      );
      return;
    } catch (e) {
      console.error('[DB] setInventoryDelta error:', e.message);
    }
  }
  const db = loadDB();
  if (!db.inventoryDelta) db.inventoryDelta = {};
  db.inventoryDelta[sku] = delta;
  saveDB(db);
}

/* ══════════════════════════════════════════════════════════════════════════
   WEBHOOK LOGS
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Save a webhook event log entry.
 */
async function saveWebhookLog(token, entry) {
  // entry: { order_id, status, classification, sku, qty, action, customer }
  if (pool) {
    try {
      const th = hashToken(token);
      await query(
        `INSERT INTO webhook_logs
           (token_hash, order_id, status, classification, sku, qty, action, customer)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          th,
          entry.order_id   || null,
          entry.status     || null,
          entry.classification || null,
          entry.sku        || null,
          entry.qty        ?? 1,
          entry.action     || null,
          entry.customer   || null,
        ]
      );
      return;
    } catch (e) {
      console.error('[DB] saveWebhookLog error:', e.message);
    }
  }
  // file fallback
  const db = loadDB();
  if (!db.webhookLogs) db.webhookLogs = [];
  db.webhookLogs.unshift({ ...entry, created_at: new Date().toISOString() });
  if (db.webhookLogs.length > 500) db.webhookLogs = db.webhookLogs.slice(0, 500);
  saveDB(db);
}

/**
 * Get recent webhook logs (latest N entries).
 */
async function getWebhookLogs(token, limit = 100) {
  if (pool) {
    try {
      const th = hashToken(token);
      const res = await query(
        `SELECT order_id, status, classification, sku, qty, action, customer, created_at
         FROM webhook_logs
         WHERE token_hash=$1
         ORDER BY created_at DESC
         LIMIT $2`,
        [th, limit]
      );
      return res.rows;
    } catch (e) {
      console.error('[DB] getWebhookLogs error:', e.message);
    }
  }
  const db = loadDB();
  return (db.webhookLogs || []).slice(0, limit);
}

/* ══════════════════════════════════════════════════════════════════════════
   ORDERS CACHE  (optional — heavy, PostgreSQL only)
   ══════════════════════════════════════════════════════════════════════════ */

async function saveOrdersCache(token, orders) {
  if (!pool) return; // file fallback not used for bulk orders cache
  try {
    const th = hashToken(token);
    await query(
      `INSERT INTO orders_cache(token_hash, order_data)
       VALUES($1,$2::jsonb)`,
      [th, JSON.stringify(orders)]
    );
  } catch (e) {
    console.error('[DB] saveOrdersCache error:', e.message);
  }
}

async function getLatestOrdersCache(token) {
  if (!pool) return null;
  try {
    const th = hashToken(token);
    const res = await query(
      `SELECT order_data FROM orders_cache
       WHERE token_hash=$1
       ORDER BY saved_at DESC LIMIT 1`,
      [th]
    );
    return res.rows.length ? res.rows[0].order_data : null;
  } catch (e) {
    console.error('[DB] getLatestOrdersCache error:', e.message);
    return null;
  }
}

/* ─── Product Groups (synced via PostgreSQL) ───────────────────────────── */
async function getProductGroups(userId) {
  if (!pool) return {};
  const res = await query('SELECT group_name, skus FROM product_groups WHERE user_id=$1 ORDER BY created_at', [userId]);
  const groups = {};
  res.rows.forEach(r => { groups[r.group_name] = r.skus; });
  return groups;
}

async function saveProductGroups(userId, groups) {
  if (!pool) return;
  await query('DELETE FROM product_groups WHERE user_id=$1', [userId]);
  const entries = Object.entries(groups);
  for (const [name, skus] of entries) {
    await query('INSERT INTO product_groups(user_id, group_name, skus) VALUES($1,$2,$3)', [userId, name, skus]);
  }
}

/* ─── Todos (synced via PostgreSQL) ────────────────────────────────────── */
async function getTodos(userId) {
  if (!pool) return [];
  const res = await query('SELECT id, title, description, done, created_at FROM todos WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
  return res.rows;
}

async function saveTodo(userId, title, description) {
  if (!pool) return null;
  const res = await query('INSERT INTO todos(user_id, title, description) VALUES($1,$2,$3) RETURNING *', [userId, title, description || '']);
  return res.rows[0];
}

async function updateTodo(userId, todoId, updates) {
  if (!pool) return;
  if (updates.done !== undefined) {
    await query('UPDATE todos SET done=$1 WHERE id=$2 AND user_id=$3', [updates.done, todoId, userId]);
  }
  if (updates.title !== undefined) {
    await query('UPDATE todos SET title=$1 WHERE id=$2 AND user_id=$3', [updates.title, todoId, userId]);
  }
}

async function deleteTodo(userId, todoId) {
  if (!pool) return;
  await query('DELETE FROM todos WHERE id=$1 AND user_id=$2', [todoId, userId]);
}

/* ─── User Settings (generic key-value synced to PostgreSQL) ───────────── */
async function getUserSetting(userId, key) {
  if (!pool) return null;
  const res = await query('SELECT setting_value FROM user_settings WHERE user_id=$1 AND setting_key=$2', [userId, key]);
  return res.rows.length ? res.rows[0].setting_value : null;
}

async function saveUserSetting(userId, key, value) {
  if (!pool) return;
  await query(
    `INSERT INTO user_settings(user_id, setting_key, setting_value, updated_at)
     VALUES($1,$2,$3::jsonb, NOW())
     ON CONFLICT(user_id, setting_key) DO UPDATE SET setting_value=$3::jsonb, updated_at=NOW()`,
    [userId, key, JSON.stringify(value)]
  );
}

async function getAllUserSettings(userId) {
  if (!pool) return {};
  const res = await query('SELECT setting_key, setting_value FROM user_settings WHERE user_id=$1', [userId]);
  const settings = {};
  res.rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
  return settings;
}

/* ─── Graceful shutdown ──────────────────────────────────────────────────── */
async function closePool() {
  if (pool) {
    await pool.end();
    console.log('[DB] PostgreSQL pool closed.');
  }
}
process.on('SIGINT',  () => closePool().then(() => process.exit(0)));
process.on('SIGTERM', () => closePool().then(() => process.exit(0)));

/* ─── Exports ────────────────────────────────────────────────────────────── */
module.exports = {
  // legacy file helpers (still used by server for raw JSON blob)
  loadDB,
  saveDB,
  usePostgres: usePostgres && !!pool,

  // shipping
  getShippingDays,
  saveShippingDays,
  getAllShippingDays,

  // inventory
  getInventoryDelta,
  getAllInventoryDeltas,
  updateInventoryDelta,
  setInventoryDelta,

  // webhook logs
  saveWebhookLog,
  getWebhookLogs,

  // orders cache
  saveOrdersCache,
  getLatestOrdersCache,

  // user auth
  createUser,
  getUserByEmail,
  getUserById,
  updateUserApiToken,
  verifyPassword,

  // sessions
  createSession,
  getSession,
  deleteSession,
  cleanExpiredSessions,
  generateSessionToken,

  // notifications
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  checkAndNotifyCoverage,

  // product groups
  getProductGroups,
  saveProductGroups,

  // todos
  getTodos,
  saveTodo,
  updateTodo,
  deleteTodo,

  // user settings
  getUserSetting,
  saveUserSetting,
  getAllUserSettings,

  // util
  hashToken,
  closePool,
};
