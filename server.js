/* =========================================================
   Checkout — fully automatic IPTV provisioning
   ---------------------------------------------------------
   On a completed payment:
     1. Look up the customer's email in Postgres.
     2. RETURNING → call panel  action=renew  (reuse username+password)
        NEW       → call panel  action=new    (panel returns credentials)
     3. Save/update the customer row, send credentials to the page,
        and notify Telegram.
   ========================================================= */

import express from 'express';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---- ENV ---- */
const {
  PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV = 'sandbox',
  PORT = 3000, CURRENCY = 'USD',
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
  DATABASE_URL,
  PANEL_API_BASE,        // e.g. https://8k.cms-only.ru/api/api.php
  PANEL_API_KEY,         // your panel api_key
  PANEL_PACK = '35338',  // package id (same for all plans)
  ADMIN_KEY
} = process.env;

const BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

/* ---- CATALOG: price + months per plan ---- */
const CATALOG = {
  'starter':   { name: 'Plan A — 1 Month',   price: 17.00, months: 1  },
  'quarterly': { name: 'Plan B — 3 Months',  price: 31.00, months: 3  },
  'premium':   { name: 'Plan C — 6 Months',  price: 45.00, months: 6  },
  'ultra':     { name: 'Plan D — 12 Months', price: 64.00, months: 12 }
};
const TAX_RATE = 0.00;
const PROMOS = { 'IPTV10': { type:'percent', value:10 }, 'SAVE5': { type:'flat', value:5 } };
const money = n => n.toFixed(2);

function priceCart(cart = [], promoCode = '') {
  const items = []; let subtotal = 0, months = 0;
  for (const line of cart) {
    const p = CATALOG[line.id];
    const qty = Math.max(1, parseInt(line.qty, 10) || 1);
    if (!p) continue;
    subtotal += p.price * qty;
    months += p.months * qty;
    items.push({ id: line.id, name: p.name, unit: p.price, qty, months: p.months * qty });
  }
  let discount = 0;
  const promo = PROMOS[(promoCode || '').toUpperCase()];
  if (promo) discount = promo.type === 'percent' ? subtotal*(promo.value/100) : Math.min(promo.value, subtotal);
  const taxable = Math.max(0, subtotal - discount);
  return { items, subtotal, discount, tax: taxable*TAX_RATE, total: taxable + taxable*TAX_RATE, months };
}

/* =========================================================
   DATABASE (Postgres)
   ========================================================= */
const pool = DATABASE_URL
  ? new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function initDb() {
  if (!pool) { console.warn('⚠️  DATABASE_URL not set — storage disabled'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customers (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      username    TEXT,
      password    TEXT,
      expire      DATE,
      last_order  TEXT,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log('✓ Postgres ready');
}

async function findCustomer(email) {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM customers WHERE email=$1', [email.toLowerCase()]);
  return r.rows[0] || null;
}
async function upsertNew(email, username, password, months, orderId) {
  const expire = addMonths(todayStr(), months);
  await pool.query(
    `INSERT INTO customers (email, username, password, expire, last_order)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (email) DO UPDATE SET username=$2, password=$3, expire=$4, last_order=$5, updated_at=now()`,
    [email.toLowerCase(), username, password, expire, orderId]
  );
  return expire;
}
async function updateRenewal(email, oldExpire, months, orderId) {
  const newExpire = addMonths(oldExpire, months);
  await pool.query(
    `UPDATE customers SET expire=$2, last_order=$3, updated_at=now() WHERE email=$1`,
    [email.toLowerCase(), newExpire, orderId]
  );
  return newExpire;
}

/* date helpers */
function todayStr(){ return new Date().toISOString().slice(0,10); }
function addMonths(dateStr, months){
  const base = dateStr && new Date(dateStr) > new Date() ? new Date(dateStr) : new Date();
  base.setUTCMonth(base.getUTCMonth() + months);
  return base.toISOString().slice(0,10);
}

/* =========================================================
   PANEL API  (XUI / cms-only)
   ========================================================= */
async function panelNew(months, notes) {
  const url = `${PANEL_API_BASE}?action=new&type=m3u&sub=${months}&pack=${PANEL_PACK}`
            + `&country=ALL&notes=${encodeURIComponent(notes)}&api_key=${PANEL_API_KEY}`;
  const res = await fetch(url);
  const text = await res.text();
  // Try JSON first; fall back to scraping username/password from text
  let username = '', password = '', raw = text;
  try {
    const j = JSON.parse(text);
    username = j.username || j.user || (j.data && j.data.username) || '';
    password = j.password || j.pass || (j.data && j.data.password) || '';
    raw = j;
  } catch {
    const u = text.match(/user(?:name)?["':=\s]+([A-Za-z0-9]+)/i);
    const p = text.match(/pass(?:word)?["':=\s]+([A-Za-z0-9]+)/i);
    if (u) username = u[1];
    if (p) password = p[1];
  }
  return { username, password, raw };
}

async function panelRenew(username, password, months) {
  const url = `${PANEL_API_BASE}?action=renew&type=m3u&username=${encodeURIComponent(username)}`
            + `&password=${encodeURIComponent(password)}&sub=${months}&api_key=${PANEL_API_KEY}`;
  const res = await fetch(url);
  const text = await res.text();
  let ok = res.ok;
  try { const j = JSON.parse(text); if (j.status === false || j.error) ok = false; } catch {}
  return { ok, raw: text };
}

/* ---- PAYPAL ---- */
async function getToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method:'POST',
    headers:{ Authorization:`Basic ${auth}`, 'Content-Type':'application/x-www-form-urlencoded' },
    body:'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('Failed to get PayPal token');
  return (await res.json()).access_token;
}

/* ---- TELEGRAM ---- */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id:TELEGRAM_CHAT_ID, text, parse_mode:'HTML', disable_web_page_preview:true })
    });
  } catch (e) { console.error('Telegram failed:', e); }
}

/* ---- API ---- */
app.get('/api/config', (req, res) => res.json({ clientId: PAYPAL_CLIENT_ID, currency: CURRENCY }));

app.post('/api/quote', (req, res) => {
  const q = priceCart((req.body||{}).cart, (req.body||{}).promo);
  res.json({ items:q.items, subtotal:money(q.subtotal), discount:money(q.discount), tax:money(q.tax), total:money(q.total) });
});

app.post('/api/orders', async (req, res) => {
  try {
    const q = priceCart((req.body||{}).cart, (req.body||{}).promo);
    if (q.total <= 0) return res.status(400).json({ error:'Empty cart' });
    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders`, {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`},
      body: JSON.stringify({
        intent:'CAPTURE',
        purchase_units:[{
          amount:{ currency_code:CURRENCY, value:money(q.total),
            breakdown:{ item_total:{currency_code:CURRENCY,value:money(q.subtotal)},
                        discount:{currency_code:CURRENCY,value:money(q.discount)},
                        tax_total:{currency_code:CURRENCY,value:money(q.tax)} } },
          items:q.items.map(it=>({ name:it.name, quantity:String(it.qty),
            unit_amount:{currency_code:CURRENCY,value:money(it.unit)} }))
        }]
      })
    });
    res.status(r.status).json(await r.json());
  } catch (e) { console.error(e); res.status(500).json({ error:'Could not create order' }); }
});

app.post('/api/orders/:id/capture', async (req, res) => {
  try {
    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders/${req.params.id}/capture`, {
      method:'POST', headers:{'Content-Type':'application/json', Authorization:`Bearer ${token}`}
    });
    const data = await r.json();

    if (data.status === 'COMPLETED') {
      const payer = data.payer || {};
      const customer = (req.body && req.body.customer) || {};
      const q = priceCart((req.body||{}).cart, (req.body||{}).promo);
      const email = (customer.email || payer.email_address || '').trim().toLowerCase();
      const planName = q.items.map(i=>i.name).join(', ');
      const months = q.months;
      const name = `${customer.fname||''} ${customer.lname||''}`.trim() || '—';
      const notes = `${email} order ${data.id}`;

      let creds = { username:'', password:'' }, isRenewal = false, oldExpire = null, newExpire = null, panelOk = true, panelRaw = '';

      try {
        const existing = await findCustomer(email);
        if (existing && existing.username) {
          // RENEWAL
          isRenewal = true;
          const rn = await panelRenew(existing.username, existing.password, months);
          panelOk = rn.ok; panelRaw = rn.raw;
          creds = { username: existing.username, password: existing.password };
          oldExpire = existing.expire ? new Date(existing.expire).toISOString().slice(0,10) : null;
          newExpire = await updateRenewal(email, oldExpire, months, data.id);
        } else {
          // NEW
          const nw = await panelNew(months, notes);
          creds = { username: nw.username, password: nw.password };
          panelRaw = typeof nw.raw === 'string' ? nw.raw : JSON.stringify(nw.raw);
          panelOk = !!(creds.username && creds.password);
          if (panelOk) newExpire = await upsertNew(email, creds.username, creds.password, months, data.id);
        }
      } catch (err) {
        panelOk = false; panelRaw = String(err);
        console.error('Provisioning error:', err);
      }

      // Telegram
      const tag = isRenewal ? '🔄 <b>RENEWAL — line extended</b>' : '🆕 <b>NEW customer — line created</b>';
      const lines = [
        panelOk ? tag : '❗ <b>ORDER PAID — PANEL ACTION FAILED, handle manually</b>', '',
        `💰 <b>Total:</b> ${CURRENCY} ${money(q.total)}`,
        `📦 <b>Plan:</b> ${planName} (${months} mo)`, '',
        '🔐 <b>Credentials</b>',
        `  • Username: <code>${creds.username || '—'}</code>`,
        `  • Password: <code>${creds.password || '—'}</code>`,
        newExpire ? (isRenewal ? `  • Expire: ${oldExpire} → <b>${newExpire}</b>` : `  • Expire: <b>${newExpire}</b>`) : null,
        '',
        '👤 <b>Customer</b>',
        `  • Name: ${name}`,
        `  • Email: ${email || '—'}`,
        `  • Country: ${customer.country || '—'}`,
        `  • City: ${customer.city || '—'}`, '',
        `💳 Order ID: <code>${data.id}</code>`,
        !panelOk ? `\n⚠️ <i>Panel response:</i> <code>${(panelRaw||'').slice(0,300)}</code>` : null
      ].filter(Boolean);
      sendTelegram(lines.join('\n'));

      // hand the credentials back to the page (only if panel succeeded)
      data._provision = panelOk
        ? { ok:true, isRenewal, username:creds.username, password:creds.password, expire:newExpire }
        : { ok:false };
    }
    res.status(r.status).json(data);
  } catch (e) { console.error(e); res.status(500).json({ error:'Could not capture order' }); }
});

/* ---- ADMIN: list customers (JSON) ---- */
app.get('/api/customers', async (req, res) => {
  if (!ADMIN_KEY || req.query.key !== ADMIN_KEY) return res.status(403).json({ error:'Forbidden' });
  if (!pool) return res.json([]);
  const r = await pool.query('SELECT email,username,password,expire,last_order,updated_at FROM customers ORDER BY updated_at DESC');
  res.json(r.rows);
});

/* ---- ADMIN: bulk import existing customers ----
   Body: { key, rows: [ {email, username, password, expire}, ... ] }
   Upserts by email. Rows without an email are skipped (can't be matched). */
app.post('/api/import', async (req, res) => {
  const { key, rows } = req.body || {};
  if (!ADMIN_KEY || key !== ADMIN_KEY) return res.status(403).json({ error:'Forbidden' });
  if (!pool) return res.status(500).json({ error:'Database not configured' });
  if (!Array.isArray(rows)) return res.status(400).json({ error:'rows must be an array' });

  let imported = 0, skipped = 0;
  const skippedRows = [];
  for (const row of rows) {
    const email = (row.email || '').trim().toLowerCase();
    if (!email) { skipped++; skippedRows.push(row.username || '(no email)'); continue; }
    let expire = (row.expire || '').trim();
    // accept YYYY-MM-DD; leave null if blank/invalid
    if (expire && isNaN(new Date(expire).getTime())) expire = '';
    try {
      await pool.query(
        `INSERT INTO customers (email, username, password, expire, last_order)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET username=$2, password=$3, expire=$4, updated_at=now()`,
        [email, (row.username||'').trim(), (row.password||'').trim(), expire || null, 'imported']
      );
      imported++;
    } catch (e) { skipped++; skippedRows.push(email + ' (error)'); }
  }
  res.json({ imported, skipped, skippedRows });
});

/* ---- ADMIN: the import page (paste CSV) ---- */
app.get('/admin/import', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin-import.html'));
});

/* ---- TEST ---- */
app.get('/api/test-telegram', async (req, res) => {
  await sendTelegram('✅ Test message — Telegram is working!');
  res.json({ sent:true, hasToken:!!TELEGRAM_BOT_TOKEN, hasChatId:!!TELEGRAM_CHAT_ID });
});

app.listen(PORT, async () => {
  await initDb();
  console.log(`Checkout (auto-provision) running on ${PORT} (${PAYPAL_ENV}, ${CURRENCY})`);
  if (!PANEL_API_BASE || !PANEL_API_KEY) console.warn('⚠️  PANEL_API_BASE / PANEL_API_KEY not set');
});
