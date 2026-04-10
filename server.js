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
const { exec } = require('child_process');

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
    };
  }
  return userState[token];
}

// ── Cache (per-token) ──────────────────────────────────────────────────────────
const cache    = {};
const CACHE_TTL = 30 * 60 * 1000;  // 30 min — fetching 350+ pages is expensive with rate limits

function cacheKey(prefix, token) { return `${prefix}_${token.slice(-12)}`; }
function getCache(k)    { const e = cache[k]; return e && (Date.now()-e.t) < CACHE_TTL ? e.d : null; }
function setCache(k, d) { cache[k] = { d, t: Date.now() }; }
function bustCache(token) {
  const suffix = token.slice(-12);
  Object.keys(cache).filter(k => k.endsWith('_'+suffix)).forEach(k => delete cache[k]);
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
  if (['cancelled','canceled','annulé'].some(x=>s.includes(x))) return 'cancelled';
  if (['pending'].some(x=>s.includes(x)))                        return 'pending';
  if (['new','nouveau'].some(x=>s.includes(x)))                  return 'new';
  if (['assigned'].some(x=>s.includes(x)))                       return 'assigned';
  return 'other';
}

// ── Retry wrapper with exponential backoff for rate limits ────────────────────
async function apiGetRetry(token, pathname, qs = {}, retries = 6) {
  for (let i = 0; i <= retries; i++) {
    try { return await apiGet(token, pathname, qs); }
    catch (e) {
      if (i === retries) throw e;
      const isRateLimit = e.message.includes('Rate limited');
      const delay = isRateLimit ? 1500 * (i + 1) : 800 * (i + 1);
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
  let globalDelay = 500; // ms between requests per worker

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

  // Use 1 worker to avoid API rate limiting (429 errors)
  const CONCURRENCY = 1;
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
    statusCount, countryCount, totalRevenue,
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
        // عندنا بيانات قديمة — اجلب فقط أول 5 صفحات للطلبات الجديدة
        console.log(`[Stats] Incremental fetch — getting latest 5 pages only`);
        orders = [...(p1.data || [])];
        for (let pg = 2; pg <= Math.min(5, totalPages); pg++) {
          try {
            const r = await apiGetRetry(token, '/orders', { page: pg });
            if (r.data) orders.push(...r.data);
            await new Promise(r => setTimeout(r, 300));
          } catch (e) { break; }
        }
        const existingIds = new Set(savedOrders.map(o => o.id));
        const brandNew = orders.filter(o => !existingIds.has(o.id));
        orders = [...brandNew, ...savedOrders];
        console.log(`[Stats] Added ${brandNew.length} new orders to ${savedOrders.length} saved`);
      } else {
        // أول مرة: اجلب كل شيء
        console.log(`[Stats] First time fetch: ${totalPages} pages`);
        orders = [...(p1.data || [])];
        const moreOrders = await fetchAllPages(token, totalPages, (done, total) => {
          if (done % 30 === 0 || done === total) {
            const partial = { _loading: true, _progress: Math.min(99, Math.round(done / total * 100)), totalOrders, sampledOrders: done * 10 };
            setCache(ck, partial);
          }
        });
        orders = orders.concat(moreOrders);
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
  } else if (cls === 'returned' && sku) {
    st.inventoryDelta[sku] = (st.inventoryDelta[sku]||0) + qty;
    action = 'added_back';
    delete cache[cacheKey('prods', token)];
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
};
function serveFile(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── HTTP Server ────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const p      = parsed.pathname;
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') { sendJSON(res, {}, 200); return; }

  // ── /api/verify-token (lightweight auth check) ──────────────────────────
  if (p === '/api/verify-token' && method === 'POST') {
    try {
      const b     = JSON.parse(await readBody(req) || '{}');
      const token = (b.token || '').trim();
      if (!token) { sendJSON(res, { ok: false, error: 'No token' }, 400); return; }
      // Try a cheap call to verify the token is valid
      const r = await apiGet(token, '/orders', { page: 1, per_page: 1 });
      if (r.status === 'success' || Array.isArray(r.data) || r.data) {
        // If webhookSecret provided, register it
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
    const token = extractToken(req);
    if (!token) { sendJSON(res, { error: 'Unauthorized — provide Bearer token' }, 401); return; }

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
          st.shippingDays[b.country] = Math.max(1, parseInt(b.days)||1);
          delete cache[cacheKey('inv_enh', token)];
        }
        sendJSON(res, { ...st.shippingDays, _flags: FLAG });
      } catch (e) { sendJSON(res, { error: e.message }, 400); }
      return;
    }

    // ── /api/webhook-log ──────────────────────────────────────────────────
    if (p === '/api/webhook-log' && method === 'GET') {
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
  exec(`start ${addr}`);
});
