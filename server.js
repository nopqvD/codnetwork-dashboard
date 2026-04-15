/**
 * CODNETWORK Dashboard Server — v10
 * Multi-user: each client supplies their own API token via Authorization header.
 * Server acts as an authenticated proxy — no credentials hardcoded.
 *
 * Per-user state (in memory, keyed by token):
 *   • shippingDays   — editable via POST /api/shipping-days
 *   • inventoryDelta — adjusted by incoming webhooks
 *   • webhookLog     — last 50 webhook events
 *   • webhookSecret  — registered via POST /api/register
 *
 * Webhook URL format expected in CODNETWORK settings:
 *   https://your-domain.com/webhook?token=USER_API_TOKEN
 */

const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const url    = require('url');
const crypto = require('crypto');

// Load .env file BEFORE requiring db module (db.js reads DATABASE_URL at import)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const [key, ...val] = line.split('=');
      if (key && key.trim() && !key.startsWith('#')) {
        process.env[key.trim()] = val.join('=').trim();
      }
    });
  }
} catch {}

const db     = require('./db');
// ── Cross-platform URL opener (execa-style using spawn — no external deps) ────
const openUrl = (u) => {
  try {
    const { spawn } = require('child_process');
    const isWin  = process.platform === 'win32';
    const isMac  = process.platform === 'darwin';
    const cmd    = isWin ? 'cmd'      : isMac ? 'open' : 'xdg-open';
    const args   = isWin ? ['/c','start','',u] : [u];
    const opts   = { detached: true, stdio: 'ignore', shell: false };
    const child  = spawn(cmd, args, opts);
    child.unref();
  } catch (e) {
    console.warn('[openUrl] Could not open browser:', e.message);
  }
};

// ── Persistent file cache ──────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'db.json');

function loadDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch { return {}; }
}

function saveDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data)); }
  catch (e) { console.error('[DB] Save error:', e.message); }
}

const fileDB = loadDB();

const PORT = process.env.PORT || 3000;
const API_HOST = 'seller.cod.network';

// ── Defaults ──────────────────────────────────────────────────────────────────
const DEFAULT_SHIPPING_DAYS = { KSA: 30, UAE: 10, KWT: 35, QAT: 35, OM: 10, BHR: 20 };
const FLAG = { KSA:'🇸🇦', UAE:'🇦🇪', KWT:'🇰🇼', QAT:'🇶🇦', OM:'🇴🇲', BHR:'🇧🇭' };

// ── Per-user state ─────────────────────────────────────────────────────────────
// Keyed by API token string. State is in-memory (resets on server restart).
const userState = {};

function getState(token) {
  if (!userState[token]) {
    userState[token] = {
      webhookSecret  : null,
      shippingDays   : { ...DEFAULT_SHIPPING_DAYS },
      inventoryDelta : {},      // sku → int delta
      webhookLog     : [],      // last 50 events
      _dbLoaded      : false,
    };
    // Asynchronously hydrate state from DB (PostgreSQL or file)
    (async () => {
      try {
        const [days, deltas] = await Promise.all([
          db.getAllShippingDays(token),
          db.getAllInventoryDeltas(token),
        ]);
        if (Object.keys(days).length)   Object.assign(userState[token].shippingDays,   days);
        if (Object.keys(deltas).length) Object.assign(userState[token].inventoryDelta, deltas);
        userState[token]._dbLoaded = true;
      } catch (e) {
        console.error('[State] Failed to load from DB:', e.message);
      }
    })();
  }
  return userState[token];
}

// ── Cache (per-token) ──────────────────────────────────────────────────────────
const cache    = {};
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '1800') * 1000;

function cacheKey(prefix, token) { return `${prefix}_${token.slice(-12)}`; }
function getCache(k)    { const e = cache[k]; return e && (Date.now()-e.t) < CACHE_TTL ? e.d : null; }
function setCache(k, d) { cache[k] = { d, t: Date.now() }; trimCache(); }
function bustCache(token) {
  const suffix = token.slice(-12);
  Object.keys(cache).filter(k => k.endsWith('_'+suffix)).forEach(k => delete cache[k]);
}

const MAX_CACHE_ENTRIES = 30;
function trimCache() {
  const keys = Object.keys(cache);
  if (keys.length > MAX_CACHE_ENTRIES) {
    const sorted = keys.sort((a,b) => (cache[a]?.t||0) - (cache[b]?.t||0));
    sorted.slice(0, keys.length - MAX_CACHE_ENTRIES).forEach(k => delete cache[k]);
  }
}

function r2(n) { return Math.round(n * 100) / 100; }

// ── HTTPS API call ─────────────────────────────────────────────────────────────
function apiGet(token, pathname, qs = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ per_page: 100, ...qs }).toString();
    const opts = {
      hostname: API_HOST,
      path    : `/api${pathname}?${params}`,
      method  : 'GET',
      headers : {
        Authorization : `Bearer ${token}`,
        Accept        : 'application/json',
        'User-Agent'  : 'COD-Dashboard/10',
      },
    };
    const req = https.request(opts, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          // Detect rate limiting — HTTP 429 or error/message containing "too many"
          const errText = (parsed.error || parsed.message || '').toString().toLowerCase();
          if (res.statusCode === 429 || parsed.status === 'error' || errText.includes('too many')) {
            reject(new Error('Rate limited: ' + (parsed.message || parsed.error || 'HTTP ' + res.statusCode)));
            return;
          }
          resolve(parsed);
        }
        catch { reject(new Error('JSON parse error: ' + raw.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error('API timeout')); });
    req.end();
  });
}

// ── Retry wrapper for generic async functions ──────────────────────────────────
async function fetchWithRetry(fn, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try { return await fn(); }
    catch (err) {
      if (err.message && err.message.startsWith('Rate limited')) {
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      throw err;
    }
  }
  return null;
}

// ── Full paginated orders fetch ────────────────────────────────────────────────
async function fetchAllOrders(token) {
  let all = [];
  let page = 1;
  while (true) {
    const res = await fetchWithRetry(() =>
      apiGet(token, '/orders', { page })
    );
    if (!res) return page === 1 ? null : all;
    const orders = res.data || [];
    if (!orders.length) break;
    all = all.concat(orders);
    const pagination = res.meta?.pagination || {};
    if (page >= (pagination.total_pages || 1)) break;
    page++;
    await new Promise(r => setTimeout(r, 300));
  }
  return all;
}

// ── Country / group helpers ────────────────────────────────────────────────────
function normCountry(name, code) {
  const n = (name||'').toUpperCase().trim();
  const c = (code||'').toUpperCase().trim();
  if (n==='KSA' || n.includes('SAUDI')   || c==='SA') return 'KSA';
  if (n==='UAE' || n.includes('EMIRATES')|| c==='AE') return 'UAE';
  if (n==='KWT' || n.includes('KUWAIT')  || c==='KW') return 'KWT';
  if (n==='QAT' || n.includes('QATAR')   || c==='QA') return 'QAT';
  if (n==='OM'  || n.includes('OMAN')    || c==='OM') return 'OM';
  if (n==='BHR' || n.includes('BAHRAIN') || c==='BH') return 'BHR';
  return n || c || '—';
}

// ── Status classifier ──────────────────────────────────────────────────────────
function classifyStatus(st) {
  if (!st) return 'other';
  const s = st.toLowerCase();
  if (['delivered','livré'].some(x=>s.includes(x)))              return 'delivered';
  if (['return','retourné','مرتجع'].some(x=>s.includes(x)))     return 'returned';
  if (['confirmed','confirmé'].some(x=>s.includes(x)))           return 'confirmed';
  if (['shipped','dispatched','expédié'].some(x=>s.includes(x))) return 'shipped';
  if (['cancelled','canceled','cancel','annulé'].some(x=>s.includes(x))) return 'cancelled';
  if (['pending'].some(x=>s.includes(x)))                        return 'pending';
  if (['new','nouveau'].some(x=>s.includes(x)))                  return 'new';
  if (['assigned'].some(x=>s.includes(x)))                       return 'assigned';
  return 'other';
}

// ── Retry wrapper with exponential backoff for rate limits ────────────────────
async function apiGetRetry(token, pathname, qs = {}, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try { return await apiGet(token, pathname, qs); }
    catch (e) {
      if (i === retries) throw e;
      const isRateLimit = e.message.includes('Rate limited');
      const delay = isRateLimit ? Math.min(8000, 1000 * Math.pow(2, i)) : Math.min(4000, 500 * Math.pow(2, i));
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ── Concurrent page fetcher with adaptive rate limiting ──────────────────────
// Uses a shared queue with N workers. When rate-limited, all workers slow down.
async function fetchAllPages(token, totalPages, onProgress) {
  const allData = [];
  let completed = 1; // page 1 already done
  let nextPage = 2;
  let globalDelay = 300; // ms between requests per worker

  async function worker() {
    while (true) {
      const page = nextPage++;
      if (page > totalPages) break;

      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          const r = await apiGet(token, '/orders', { page });
          if (r.data) allData.push(...r.data);
          completed++;
          if (onProgress) onProgress(completed, totalPages);
          globalDelay = Math.max(80, globalDelay * 0.95); // speed up on success
          break;
        } catch (e) {
          if (e.message.includes('Rate limited')) {
            globalDelay = Math.min(2000, globalDelay * 2); // slow down all workers
          }
          const delay = Math.min(5000, (attempt + 1) * (attempt + 1) * 300); // quadratic backoff
          await new Promise(r => setTimeout(r, delay));
          if (attempt === 9) {
            console.warn(`[Stats] Page ${page} failed after 10 attempts`);
          }
        }
      }
      await new Promise(r => setTimeout(r, globalDelay));
    }
  }

  const CONCURRENCY = 3;
  const workers = [];
  for (let i = 0; i < Math.min(CONCURRENCY, totalPages - 1); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return allData;
}

// ── Background stats builder ──────────────────────────────────────────────────
// API forces per_page=10, so 3500+ orders = 350+ pages.
// We build stats in background and serve partial results while loading.
const buildingStats = {};  // token → Promise (prevents duplicate builds)

function orderTotal(o) { return parseFloat(o.total_usd) || parseFloat(o.total) || 0; }

function computeStatsFromOrders(orders, totalOrders) {
  const statusCount  = {};
  const dailyRev     = {};
  const monthlyRev   = {};
  const todayStr     = new Date().toISOString().slice(0,10);
  const monthStr     = todayStr.slice(0,7);

  orders.forEach(o => {
    statusCount[o.status||'Unknown'] = (statusCount[o.status||'Unknown']||0) + 1;
    const v = orderTotal(o);
    const d = (o.created_at||'').slice(0,10);
    const m = d.slice(0,7);
    if (d) dailyRev[d]   = (dailyRev[d]  ||0) + v;
    if (m) monthlyRev[m] = (monthlyRev[m]||0) + v;
  });

  const dailyChart = [];
  for (let i=29; i>=0; i--) {
    const d = new Date(); d.setDate(d.getDate()-i);
    const k = d.toISOString().slice(0,10);
    dailyChart.push({ date:k, label:k.slice(5), rev:r2(dailyRev[k]||0) });
  }
  const monthlyChart = [];
  const now = new Date();
  for (let i=11; i>=0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth()-i, 1);
    const k = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
    const label = d.toLocaleString('en',{month:'short',year:'2-digit'});
    monthlyChart.push({ month:k, label, rev:r2(monthlyRev[k]||0) });
  }

  const confirmed = orders.filter(o => classifyStatus(o.status) === 'confirmed').length;
  const delivered = orders.filter(o => classifyStatus(o.status) === 'delivered').length;
  const returned  = orders.filter(o => classifyStatus(o.status) === 'returned').length;
  const cancelled = orders.filter(o => classifyStatus(o.status) === 'cancelled').length;
  const shipped   = orders.filter(o => classifyStatus(o.status) === 'shipped').length;
  const pending   = orders.filter(o => classifyStatus(o.status) === 'pending').length;
  const totalRevenue = r2(orders.reduce((s,o) => s + orderTotal(o), 0));
  const totalServiceFees = r2(orders.reduce((s,o) => s + (parseFloat(o.shipping_fees) || 0) + (parseFloat(o.delivery_fees) || 0), 0));

  const deliveredRevenue = r2(
    orders.filter(o => classifyStatus(o.status) === 'delivered')
      .reduce((s,o) => s + orderTotal(o), 0)
  );
  const deliveredTodayRevenue = r2(
    orders.filter(o => (o.created_at||'').slice(0,10) === todayStr && classifyStatus(o.status) === 'delivered')
      .reduce((s,o) => s + orderTotal(o), 0)
  );
  const deliveredMonthRevenue = r2(
    orders.filter(o => (o.created_at||'').slice(0,7) === monthStr && classifyStatus(o.status) === 'delivered')
      .reduce((s,o) => s + orderTotal(o), 0)
  );
  const confirmedRevenue = r2(
    orders.filter(o => ['confirmed','delivered','shipped'].includes(classifyStatus(o.status)))
      .reduce((s,o) => s + orderTotal(o), 0)
  );
  const todayConfirmed = orders.filter(o => (o.created_at||'').slice(0,10) === todayStr && classifyStatus(o.status) === 'confirmed').length;
  const countryCount = {};
  orders.forEach(o => {
    const co = normCountry(o.customer_country?.name, o.customer_country?.code);
    countryCount[co] = (countryCount[co]||0) + 1;
  });

  return {
    totalOrders,
    sampledOrders: orders.length,
    isFull: orders.length >= totalOrders,
    statusCount, countryCount, totalRevenue, totalServiceFees,
    deliveredRevenue, deliveredTodayRevenue, deliveredMonthRevenue,
    confirmedRevenue,
    todayRevenue: r2(dailyRev[todayStr] || 0),
    monthRevenue: r2(monthlyRev[monthStr] || 0),
    confirmed, delivered, returned, cancelled, shipped, pending, todayConfirmed,
    tracked: orders.filter(o => o.tracking_number).length,
    dailyChart, monthlyChart,
    refreshedAt: new Date().toISOString(),
  };
}

// ── MODIFIED: buildStats now saves to db.json and does incremental fetches ────
async function buildStats(token) {
  const ck = cacheKey('stats', token);
  const hit = getCache(ck);
  if (hit) return hit;

  if (buildingStats[token]) return buildingStats[token];

  buildingStats[token] = (async () => {
    try {
      const dbKey = 'orders_' + token.slice(-12);
      let savedOrders = fileDB[dbKey]?.orders || [];
      const lastSaved = fileDB[dbKey]?.savedAt || null;
      const now = Date.now();

      const [statsRes, productsRes] = await Promise.all([
        fetchWithRetry(() => apiGet(token, '/stats', {})).catch(() => null),
        fetchWithRetry(() => apiGet(token, '/products', {})).catch(() => null),
      ]);
      if (productsRes) setCache(cacheKey('prods', token), productsRes);

      const p1 = await apiGetRetry(token, '/orders', { page: 1 });
      const meta = p1.meta?.pagination || {};
      const totalOrders = meta.total || 0;
      const totalPages = meta.total_pages || 1;

      let orders = [];

      // إذا عندنا بيانات محفوظة وعمرها أقل من 6 ساعات، استخدمها مباشرة
      if (savedOrders.length > 0 && lastSaved && (now - lastSaved) < 6 * 60 * 60 * 1000) {
        console.log(`[Stats] Using saved ${savedOrders.length} orders from file cache`);
        orders = savedOrders;
      } else if (savedOrders.length > 0) {
        // عندنا بيانات قديمة — اجلب حتى نجد طلبات موجودة أو ننتهي
        console.log(`[Stats] Incremental fetch — fetching until overlap with saved data`);
        const existingIds = new Set(savedOrders.map(o => o.id));
        let freshOrders = [...(p1.data || [])];
        let foundOverlap = false;
        for (let pg = 2; pg <= totalPages; pg++) {
          // Check if last page had overlap
          if (foundOverlap) break;
          try {
            const r = await apiGetRetry(token, '/orders', { page: pg });
            const pageOrders = r.data || [];
            if (!pageOrders.length) break;
            freshOrders.push(...pageOrders);
            // If any order on this page exists in saved data, we've caught up
            if (pageOrders.some(o => existingIds.has(o.id))) {
              foundOverlap = true;
            }
            await new Promise(r => setTimeout(r, 300));
          } catch (e) { break; }
        }
        const brandNew = freshOrders.filter(o => !existingIds.has(o.id));
        // Also update existing orders with fresh data
        const freshIds = new Set(freshOrders.map(o => o.id));
        const unchangedOld = savedOrders.filter(o => !freshIds.has(o.id));
        orders = [...freshOrders, ...unchangedOld];
        console.log(`[Stats] Added ${brandNew.length} new, updated ${freshOrders.length - brandNew.length}, kept ${unchangedOld.length} old`);
      } else {
        // أول مرة: اجلب كل شيء باستخدام fetchAllOrders
        console.log(`[Stats] First time fetch: ${totalPages} pages`);
        const fetched = await fetchAllOrders(token);
        if (!fetched) return null;
        orders = fetched;
      }

      // احفظ في db.json
      fileDB[dbKey] = { orders, savedAt: now, total: totalOrders };
      saveDB(fileDB);
      console.log(`[Stats] Saved ${orders.length} orders to db.json`);

      setCache(cacheKey('raw_orders', token), orders);
      const data = computeStatsFromOrders(orders, totalOrders);
      setCache(ck, data);
      return data;
    } finally {
      delete buildingStats[token];
    }
  })();

  return buildingStats[token];
}

// ── Last 30 days order stats ───────────────────────────────────────────────────
// Reuses the stats cache (which already has all orders) instead of fetching again
async function fetchLast30DaysOrders(token) {
  const ck = cacheKey('ord30', token);
  const hit = getCache(ck);
  if (hit) return hit;

  // Reuse orders already fetched by buildStats instead of re-fetching
  await buildStats(token);
  const cachedOrders = getCache(cacheKey('raw_orders', token));

  const cutoff   = new Date(); cutoff.setDate(cutoff.getDate()-30);
  const cutoffTs = cutoff.getTime();

  let allFetched = cachedOrders || [];

  // Fallback: if raw orders cache expired, fetch fresh
  if (!allFetched.length) {
    const p1 = await apiGetRetry(token, '/orders', { page: 1 });
    const totalPages = Math.min(p1.meta?.pagination?.total_pages||1, 500);
    allFetched = [...(p1.data||[])];
    if (totalPages > 1) {
      const moreOrders = await fetchAllPages(token, totalPages, null);
      allFetched = allFetched.concat(moreOrders);
    }
  }

  const orders30 = allFetched.filter(o => new Date(o.created_at).getTime() >= cutoffTs);
  const coSkuQty = {}, coOrderCnt = {};

  orders30.forEach(o => {
    const co = normCountry(o.customer_country?.name, o.customer_country?.code);
    coOrderCnt[co] = (coOrderCnt[co]||0) + 1;
    (o.products||[]).forEach(pr => {
      if (!coSkuQty[co]) coSkuQty[co] = {};
      coSkuQty[co][pr.sku] = (coSkuQty[co][pr.sku]||0) + (parseInt(pr.quantity)||1);
    });
  });

  const dailyAvgSku = {}, dailyAvgCountry = {}, dailyAvgUnitsCountry = {};
  Object.entries(coSkuQty).forEach(([co, skus]) => {
    dailyAvgSku[co] = {};
    let totalUnits = 0;
    Object.entries(skus).forEach(([sku, total]) => {
      dailyAvgSku[co][sku] = r2(total/30);
      totalUnits += total;
    });
    dailyAvgUnitsCountry[co] = r2(totalUnits/30);
  });
  Object.entries(coOrderCnt).forEach(([co, cnt]) => { dailyAvgCountry[co] = r2(cnt/30); });

  const result = {
    totalOrdersIn30d : orders30.length,
    totalFetched     : allFetched.length,
    cutoffDate       : cutoff.toISOString().slice(0,10),
    daysBack         : 30,
    dailyAvgSku, dailyAvgCountry, dailyAvgUnitsCountry, coOrderCnt,
  };

  setCache(ck, result);
  return result;
}

// ── Products with webhook delta applied ────────────────────────────────────────
async function getProducts(token) {
  const ck  = cacheKey('prods', token);
  const st  = getState(token);
  let   data = getCache(ck);
  if (!data) {
    // Fetch ALL product pages (API may paginate like orders)
    const p1 = await apiGetRetry(token, '/products', { page: 1 });
    const totalPages = p1.meta?.pagination?.total_pages || 1;
    let allProducts = [...(p1.data || [])];
    if (totalPages > 1) {
      const BATCH = 10;
      for (let start = 2; start <= totalPages; start += BATCH) {
        const pages = [];
        for (let p = start; p < start + BATCH && p <= totalPages; p++) pages.push(p);
        const results = await Promise.allSettled(pages.map(p => apiGetRetry(token, '/products', { page: p })));
        results.forEach(r => { if (r.status === 'fulfilled') allProducts = allProducts.concat(r.value.data || []); });
      }
      console.log(`[Products] Fetched ${allProducts.length} products across ${totalPages} pages`);
    }
    data = { data: allProducts, meta: p1.meta };
    setCache(ck, data);
  }

  // Deep-clone and apply in-memory deltas
  data = JSON.parse(JSON.stringify(data));
  (data.data||[]).forEach(p => {
    const delta = st.inventoryDelta[p.sku] || 0;
    if (delta !== 0 && p.stocks) {
      let rem = Math.abs(delta);
      p.stocks.forEach(s => {
        if (rem <= 0) return;
        if (delta < 0) { const take = Math.min(rem, s.quantity); s.quantity -= take; rem -= take; }
        else           { s.quantity += rem; rem = 0; }
      });
    }
    p._delta = delta;
  });
  return data;
}

// ── Shipments (4-page sample) ──────────────────────────────────────────────────
async function getShipments(token) {
  const ck = cacheKey('ships', token);
  const hit = getCache(ck);
  if (hit) return hit;

  const pages = await Promise.allSettled([1,2,3,4].map(p => apiGet(token, '/orders', { page: p })));
  let orders = [];
  pages.forEach(r => { if (r.status==='fulfilled') orders=orders.concat(r.value.data||[]); });

  const shipments = orders
    .filter(o => o.tracking_number)
    .map(o => ({
      id: o.id, reference: o.reference,
      customer: o.customer_name, city: o.customer_city,
      country: o.customer_country?.name,
      tracking_number: o.tracking_number,
      tracking_status: o.tracking_status,
      status: o.status, shipped_at: o.shipped_at,
      delivered_at: o.delivered_at, total_usd: o.total_usd,
    }));

  setCache(ck, shipments);
  return shipments;
}

// ── Webhook processing ─────────────────────────────────────────────────────────
function verifyWebhook(secret, rawBody, sig) {
  if (!secret || !sig) return true; // no secret registered → accept all
  if (sig === secret) return true;
  try {
    const comp = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(comp), Buffer.from(sig.replace(/^sha256=/,'')));
  } catch { return false; }
}

function processWebhookEvent(token, payload) {
  const st     = getState(token);
  const status = payload.status || payload.order_status || '';
  const cls    = classifyStatus(status);
  const prods  = payload.products || payload.items || [];
  const fp     = prods[0] || {};
  const sku    = fp.sku || payload.sku || '';
  const qty    = parseInt(fp.quantity || payload.quantity || 1);

  let action = null;
  if (['confirmed','shipped','delivered'].includes(cls) && sku) {
    st.inventoryDelta[sku] = (st.inventoryDelta[sku]||0) - qty;
    action = 'subtracted';
    // Persist delta
    db.updateInventoryDelta(token, sku, -qty).catch(e =>
      console.error('[DB] updateInventoryDelta failed:', e.message)
    );
  } else if ((cls === 'returned' || cls === 'cancelled') && sku) {
    st.inventoryDelta[sku] = (st.inventoryDelta[sku]||0) + qty;
    action = 'added_back';
    delete cache[cacheKey('prods', token)];
    // Persist delta
    db.updateInventoryDelta(token, sku, +qty).catch(e =>
      console.error('[DB] updateInventoryDelta failed:', e.message)
    );
  }

  // Bust stats caches
  delete cache[cacheKey('stats',  token)];
  delete cache[cacheKey('ord30',  token)];

  const entry = {
    ts: new Date().toISOString(),
    id: payload.id || payload.reference || '?',
    status, cls, sku, qty, action,
    customer: payload.customer_name || '—',
  };
  st.webhookLog.unshift(entry);
  if (st.webhookLog.length > 50) st.webhookLog.pop();
  console.log('[Webhook]', token.slice(-8), JSON.stringify(entry));

  // Persist webhook log entry to DB
  db.saveWebhookLog(token, {
    order_id       : String(entry.id),
    status         : entry.status,
    classification : entry.cls,
    sku            : entry.sku,
    qty            : entry.qty,
    action         : entry.action,
    customer       : entry.customer,
  }).catch(e => console.error('[DB] saveWebhookLog failed:', e.message));

  return entry;
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    let d = '';
    req.on('data', c => d += c);
    req.on('end', () => res(d));
    req.on('error', rej);
  });
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  // Also accept ?token= query param (used by webhook)
  const parsed = url.parse(req.url, true);
  return parsed.query.token || '';
}

// Resolve session token → API token (for session-based auth)
async function resolveApiToken(req) {
  const rawToken = extractToken(req);
  if (!rawToken) return { apiToken: '', userId: null };
  // Try session-based auth
  try {
    const session = await db.getSession(rawToken);
    if (session) return { apiToken: session.api_token, userId: session.user_id };
  } catch {}
  // Fallback: raw token is the API token itself
  return { apiToken: rawToken, userId: null };
}

function sendJSON(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type' : 'application/json',
    'Access-Control-Allow-Origin'  : '*',
    'Access-Control-Allow-Headers' : 'Content-Type,Authorization',
    'Access-Control-Allow-Methods' : 'GET,POST,OPTIONS',
  });
  res.end(body);
}

const MIME = {
  '.html':'text/html; charset=utf-8', '.css':'text/css',
  '.js':'application/javascript', '.json':'application/json', '.ico':'image/x-icon',
  '.png':'image/png', '.svg':'image/svg+xml', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
};
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Rate Limiting ─────────────────────────────────────────────────────────────
const rateLimitMap = {};
const RATE_LIMIT  = 100;              // max requests per window per IP
const RATE_WINDOW = 15 * 60 * 1000;  // 15 minutes

function checkRateLimit(ip) {
  const now = Date.now();
  if (!rateLimitMap[ip] || (now - rateLimitMap[ip].start) > RATE_WINDOW) {
    rateLimitMap[ip] = { start: now, count: 1 };
    return true;
  }
  rateLimitMap[ip].count++;
  return rateLimitMap[ip].count <= RATE_LIMIT;
}

// ── Concurrent Requests Limiter ───────────────────────────────────────────────
// يحد من الطلبات المتزامنة لحماية الـ RAM والـ CPU
const MAX_CONCURRENT  = 10;   // حد أقصى 10 طلبات في نفس الوقت
let   activeRequests  = 0;    // عداد الطلبات النشطة حالياً
const MEM_WARN_MB     = 400;  // يحذر إذا تجاوز استهلاك RAM هذا الحد

function trackRequest(res, next) {
  activeRequests++;

  // تحذير عند تجاوز الحد
  if (activeRequests > MAX_CONCURRENT) {
    console.warn(`[Concurrency] ⚠ ${activeRequests} active requests (limit: ${MAX_CONCURRENT})`);
  }

  // فحص استهلاك الذاكرة وتسجيل تحذير إذا تجاوز الحد
  const memMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (memMB > MEM_WARN_MB) {
    console.warn(`[Memory] ⚠ Heap usage: ${memMB}MB (warn threshold: ${MEM_WARN_MB}MB)`);
  }

  // تنقيص العداد عند انتهاء الطلب
  res.on('finish', () => { activeRequests = Math.max(0, activeRequests - 1); });
  res.on('close',  () => { activeRequests = Math.max(0, activeRequests - 1); });

  next();
}

function isConcurrencyExceeded() {
  return activeRequests > MAX_CONCURRENT;
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p      = parsed.pathname;
  const method = req.method;

  // CORS preflight — لا تحسب الـ preflight ضمن العداد
  if (method === 'OPTIONS') { sendJSON(res, {}, 200); return; }

  // تتبع الطلبات النشطة + تحذيرات الذاكرة
  trackRequest(res, () => {});

  // رفض الطلبات إذا تجاوزنا الحد الأقصى للطلبات المتزامنة
  if (isConcurrencyExceeded() && p.startsWith('/api/')) {
    console.warn(`[Concurrency] 🚫 Rejecting request — ${activeRequests} active (max: ${MAX_CONCURRENT})`);
    sendJSON(res, { error: 'Server busy. Too many concurrent requests. Try again shortly.' }, 503);
    return;
  }

  // Rate limit API endpoints (per IP)
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  if (p.startsWith('/api/') && !checkRateLimit(clientIp)) {
    sendJSON(res, { error: 'Rate limited. Try again in 15 minutes.' }, 429);
    return;
  }

  // ── /api/auth/register (create account with email + password + API token) ──
  if (p === '/api/auth/register' && method === 'POST') {
    if (!db.usePostgres) {
      sendJSON(res, { ok: false, error: 'قاعدة البيانات غير متصلة. يرجى إعداد DATABASE_URL في إعدادات السيرفر.' }, 503);
      return;
    }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const email = (b.email || '').trim();
      const password = (b.password || '');
      const apiToken = (b.apiToken || '').trim();
      const name = (b.name || '').trim();

      if (!email || !password || !apiToken) {
        sendJSON(res, { ok: false, error: 'البريد الإلكتروني وكلمة المرور و API Token مطلوبة' }, 400);
        return;
      }
      if (password.length < 6) {
        sendJSON(res, { ok: false, error: 'Password must be at least 6 characters' }, 400);
        return;
      }
      // Verify the API token works
      const r = await apiGet(apiToken, '/orders', { page: 1, per_page: 1 });
      if (!r.data && r.status !== 'success') {
        sendJSON(res, { ok: false, error: 'Invalid API token' }, 400);
        return;
      }
      // Check if email already exists
      const existing = await db.getUserByEmail(email);
      if (existing) {
        sendJSON(res, { ok: false, error: 'Email already registered' }, 409);
        return;
      }
      const user = await db.createUser(email, password, apiToken, name);
      const session = await db.createSession(user.id);
      sendJSON(res, {
        ok: true,
        sessionToken: session.sessionToken,
        user: { id: user.id, email: user.email, name: user.name }
      });
    } catch (e) { sendJSON(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // ── /api/auth/login (email + password login) ────────────────────────────
  if (p === '/api/auth/login' && method === 'POST') {
    if (!db.usePostgres) {
      sendJSON(res, { ok: false, error: 'قاعدة البيانات غير متصلة. يرجى إعداد DATABASE_URL في إعدادات السيرفر.' }, 503);
      return;
    }
    try {
      const b = JSON.parse(await readBody(req) || '{}');
      const email = (b.email || '').trim();
      const password = (b.password || '');

      if (!email || !password) {
        sendJSON(res, { ok: false, error: 'البريد الإلكتروني وكلمة المرور مطلوبة' }, 400);
        return;
      }
      const user = await db.getUserByEmail(email);
      if (!user) {
        sendJSON(res, { ok: false, error: 'Invalid email or password' }, 401);
        return;
      }
      const valid = await db.verifyPassword(password, user.password_hash);
      if (!valid) {
        sendJSON(res, { ok: false, error: 'Invalid email or password' }, 401);
        return;
      }
      const session = await db.createSession(user.id);
      sendJSON(res, {
        ok: true,
        sessionToken: session.sessionToken,
        user: { id: user.id, email: user.email, name: user.name }
      });
    } catch (e) { sendJSON(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // ── /api/auth/logout ────────────────────────────────────────────────────
  if (p === '/api/auth/logout' && method === 'POST') {
    try {
      const sessionToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (sessionToken) await db.deleteSession(sessionToken);
      sendJSON(res, { ok: true });
    } catch (e) { sendJSON(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // ── /api/auth/me (get current user info) ────────────────────────────────
  if (p === '/api/auth/me' && method === 'GET') {
    try {
      const sessionToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (!sessionToken) { sendJSON(res, { ok: false, error: 'Not authenticated' }, 401); return; }
      const session = await db.getSession(sessionToken);
      if (!session) { sendJSON(res, { ok: false, error: 'Session expired' }, 401); return; }
      sendJSON(res, {
        ok: true,
        user: { id: session.user_id, email: session.email, name: session.name }
      });
    } catch (e) { sendJSON(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // ── /api/verify-token (legacy — now also supports session-based) ───────
  if (p === '/api/verify-token' && method === 'POST') {
    try {
      const b     = JSON.parse(await readBody(req) || '{}');
      const token = (req.headers['authorization']?.replace('Bearer ', '') || b.token || '').trim();
      if (!token) { sendJSON(res, { ok: false, error: 'No token' }, 400); return; }
      // Check if it's a session token first
      const session = await db.getSession(token);
      if (session) {
        sendJSON(res, { ok: true, user: { email: session.email, name: session.name } });
        return;
      }
      // Fallback: direct API token verification
      const r = await apiGet(token, '/orders', { page: 1, per_page: 1 });
      if (r.status === 'success' || Array.isArray(r.data) || r.data) {
        if (b.webhookSecret) getState(token).webhookSecret = b.webhookSecret;
        sendJSON(res, { ok: true, totalOrders: r.meta?.pagination?.total || 0 });
      } else {
        sendJSON(res, { ok: false, error: r.message || 'Invalid token' }, 401);
      }
    } catch (e) { sendJSON(res, { ok: false, error: e.message }, 500); }
    return;
  }

  // ── /api/register (store webhook secret for token) ──────────────────────
  if (p === '/api/register' && method === 'POST') {
    try {
      const b   = JSON.parse(await readBody(req) || '{}');
      const tok = extractToken(req) || b.token || '';
      if (!tok) { sendJSON(res, { ok: false, error: 'No token' }, 401); return; }
      if (b.webhookSecret) getState(tok).webhookSecret = b.webhookSecret;
      sendJSON(res, { ok: true });
    } catch (e) { sendJSON(res, { error: e.message }, 400); }
    return;
  }

  // ── All remaining /api/* routes require a token ──────────────────────────
  if (p.startsWith('/api/')) {
    const { apiToken: token, userId } = await resolveApiToken(req);
    if (!token) { sendJSON(res, { error: 'Unauthorized — provide Bearer token' }, 401); return; }

    // ── /api/notifications (get user notifications) ────────────────────
    if (p === '/api/notifications' && method === 'GET' && userId) {
      try {
        const notifs = await db.getNotifications(userId);
        const unread = await db.getUnreadNotificationCount(userId);
        sendJSON(res, { notifications: notifs, unreadCount: unread });
      } catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/notifications/read (mark notification as read) ────────────
    if (p === '/api/notifications/read' && method === 'POST' && userId) {
      try {
        const b = JSON.parse(await readBody(req) || '{}');
        if (b.id) await db.markNotificationRead(userId, b.id);
        else await db.markAllNotificationsRead(userId);
        sendJSON(res, { ok: true });
      } catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/notifications/check-stock (smart coverage vs shipping check) ──
    if (p === '/api/notifications/check-stock' && method === 'POST' && userId) {
      try {
        const b = JSON.parse(await readBody(req) || '{}');
        const coverageData = b.coverageData || [];
        const newNotifs = await db.checkAndNotifyCoverage(userId, coverageData);
        const unread = await db.getUnreadNotificationCount(userId);
        sendJSON(res, { ok: true, newNotifications: newNotifs.length, unreadCount: unread });
      } catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/debug-page (TEMPORARY — fetch a single page and return raw response) ──
    if (p === '/api/debug-page' && method === 'GET') {
      const pg = parseInt(parsed.query.page) || 100;
      try {
        const raw = await new Promise((resolve, reject) => {
          const params = new URLSearchParams({ per_page: 100, page: pg }).toString();
          const opts = {
            hostname: API_HOST,
            path: `/api/orders?${params}`,
            method: 'GET',
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: 'application/json',
              'User-Agent': 'COD-Dashboard/10',
            },
          };
          const req2 = https.request(opts, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve({ statusCode: r.statusCode, headers: r.headers, body: d }));
          });
          req2.on('error', reject);
          req2.setTimeout(30000, () => { req2.destroy(); reject(new Error('timeout')); });
          req2.end();
        });
        console.log(`[DEBUG] Page ${pg} → HTTP ${raw.statusCode}, body length: ${raw.body.length}`);
        console.log(`[DEBUG] Body preview: ${raw.body.slice(0, 500)}`);
        let parsed_body;
        try { parsed_body = JSON.parse(raw.body); } catch { parsed_body = raw.body; }
        sendJSON(res, { page: pg, statusCode: raw.statusCode, responseHeaders: raw.headers, data: parsed_body });
      } catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/analytics ─────────────────────────────────────────────────
    if (p === '/api/analytics' && method === 'GET') {
      try {
        await buildStats(token);
        const raw = getCache(cacheKey('raw_orders', token)) || [];
        const now = new Date();
        const todayStr = now.toISOString().slice(0,10);
        const last7 = [];
        const last30 = [];
        for (let i = 0; i < 30; i++) {
          const d = new Date(now); d.setDate(d.getDate() - i);
          const ds = d.toISOString().slice(0,10);
          const dayOrders = raw.filter(o => (o.created_at||'').slice(0,10) === ds);
          if (i < 7) last7.push(dayOrders.length);
          last30.push(dayOrders.length);
        }
        const avg7 = last7.length ? r2(last7.reduce((a,b)=>a+b,0) / last7.length) : 0;
        const avg30 = last30.length ? r2(last30.reduce((a,b)=>a+b,0) / last30.length) : 0;

        // Top products by order count
        const prodCount = {};
        raw.forEach(o => {
          (o.products||[]).forEach(p => {
            const name = p.name || p.sku || 'Unknown';
            prodCount[name] = (prodCount[name]||0) + (parseInt(p.quantity)||1);
          });
        });
        const topProducts = Object.entries(prodCount)
          .sort((a,b) => b[1]-a[1])
          .slice(0,5)
          .map(([name, count]) => ({ name, count }));

        // Country performance
        const countryPerf = {};
        raw.forEach(o => {
          const co = normCountry(o.customer_country?.name, o.customer_country?.code);
          if (!countryPerf[co]) countryPerf[co] = { total: 0, delivered: 0, returned: 0, revenue: 0 };
          countryPerf[co].total++;
          const cls = classifyStatus(o.status);
          if (cls === 'delivered') { countryPerf[co].delivered++; countryPerf[co].revenue += orderTotal(o); }
          if (cls === 'returned') countryPerf[co].returned++;
        });

        sendJSON(res, {
          dailyAvg7: avg7,
          dailyAvg30: avg30,
          trend: avg7 > avg30 ? 'up' : avg7 < avg30 ? 'down' : 'stable',
          projectedMonthly: r2(avg7 * 30),
          topProducts,
          countryPerformance: countryPerf,
          totalAnalyzed: raw.length,
        });
      } catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/stats ────────────────────────────────────────────────────────
    if (p === '/api/stats' && method === 'GET') {
      try { sendJSON(res, await buildStats(token)); }
      catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/orders ───────────────────────────────────────────────────────
    if (p === '/api/orders' && method === 'GET') {
      try { sendJSON(res, await apiGet(token, '/orders', { page: parseInt(parsed.query.page)||1 })); }
      catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/products ─────────────────────────────────────────────────────
    if (p === '/api/products' && method === 'GET') {
      try { sendJSON(res, await getProducts(token)); }
      catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/low-stock-count ──────────────────────────────────────────────
    if (p === '/api/low-stock-count' && method === 'GET') {
      try {
        const prods = await getProducts(token);
        const LOW_THRESHOLD = 10;
        let count = 0;
        (prods.data || []).forEach(prod => {
          const totalQty = (prod.stocks || []).reduce((s, st) => s + (st.quantity || 0), 0);
          if (totalQty < LOW_THRESHOLD) count++;
        });
        sendJSON(res, { count, threshold: LOW_THRESHOLD });
      } catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/shipments ────────────────────────────────────────────────────
    if (p === '/api/shipments' && method === 'GET') {
      try { sendJSON(res, await getShipments(token)); }
      catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/orders-30d ───────────────────────────────────────────────────
    if (p === '/api/orders-30d' && method === 'GET') {
      try { sendJSON(res, await fetchLast30DaysOrders(token)); }
      catch (e) { sendJSON(res, { error: e.message }, 500); }
      return;
    }

    // ── /api/shipping-days GET ────────────────────────────────────────────
    if (p === '/api/shipping-days' && method === 'GET') {
      sendJSON(res, { ...getState(token).shippingDays, _flags: FLAG }); return;
    }

    // ── /api/shipping-days POST ───────────────────────────────────────────
    if (p === '/api/shipping-days' && method === 'POST') {
      try {
        const b  = JSON.parse(await readBody(req) || '{}');
        const st = getState(token);
        if (b.country && b.days != null) {
          const days = Math.max(1, parseInt(b.days)||1);
          st.shippingDays[b.country] = days;
          delete cache[cacheKey('inv_enh', token)];
          // Persist to DB (PostgreSQL or file)
          db.saveShippingDays(token, b.country, days).catch(e =>
            console.error('[DB] saveShippingDays failed:', e.message)
          );
        }
        sendJSON(res, { ...st.shippingDays, _flags: FLAG });
      } catch (e) { sendJSON(res, { error: e.message }, 400); }
      return;
    }

    // ── /api/webhook-info (get webhook URL with real API token) ─────────
    if (p === '/api/webhook-info' && method === 'GET') {
      sendJSON(res, { apiToken: token });
      return;
    }

    // ── /api/webhook-log ──────────────────────────────────────────────────
    if (p === '/api/webhook-log' && method === 'GET') {
      if (db.usePostgres) {
        try {
          const logs = await db.getWebhookLogs(token, 100);
          sendJSON(res, logs); return;
        } catch (e) { /* fall through to in-memory */ }
      }
      sendJSON(res, getState(token).webhookLog); return;
    }

    // ── /api/refresh ──────────────────────────────────────────────────────
    if (p === '/api/refresh' && method === 'POST') {
      bustCache(token); sendJSON(res, { ok: true }); return;
    }

    sendJSON(res, { error: 'Not found' }, 404);
    return;
  }

  // ── /webhook (incoming from CODNETWORK) ──────────────────────────────────
  if (p === '/webhook' && method === 'POST') {
    const rawBody = await readBody(req);
    const token   = parsed.query.token || '';
    const sig     = req.headers['x-cod-signature'] ||
                    req.headers['x-webhook-secret']  ||
                    req.headers['authorization']      || '';

    if (!token) { sendJSON(res, { error: 'Missing token in URL' }, 400); return; }

    const secret = getState(token).webhookSecret;
    if (!verifyWebhook(secret, rawBody, sig)) {
      sendJSON(res, { error: 'Unauthorized' }, 401); return;
    }

    let payload;
    try { payload = JSON.parse(rawBody || '{}'); }
    catch { sendJSON(res, { error: 'Bad JSON' }, 400); return; }

    const entry = processWebhookEvent(token, payload);
    sendJSON(res, { ok: true, processed: entry });
    return;
  }

  // ── Static files ───────────────────────────────────────────────────────────
  if (p === '/' || p === '/index.html') {
    serveFile(res, path.join(__dirname, 'public', 'index.html')); return;
  }
  const staticPath = path.join(__dirname, 'public', p);
  if (staticPath.startsWith(path.join(__dirname, 'public'))) {
    serveFile(res, staticPath);
  } else { res.writeHead(403); res.end('Forbidden'); }
});

server.listen(PORT, () => {
  const addr = `http://localhost:${PORT}`;
  console.log(`\n  ✅  CODNETWORK Dashboard  →  ${addr}\n`);
  openUrl(addr);
});
