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
app.use(express.json({ limit: '25mb' }));
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
  BREVO_API_KEY,                          // Brevo (Sendinblue) API key
  BREVO_SENDER_EMAIL,                     // your verified Brevo sender email
  BREVO_SENDER_NAME = 'Support',          // sender display name
  SETUP_GUIDE_URL = 'https://your-setup-guide-url.com',  // your setup guide link
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
      m3u         TEXT,
      last_order  TEXT,
      created_at  TIMESTAMPTZ DEFAULT now(),
      updated_at  TIMESTAMPTZ DEFAULT now()
    );
  `);
  // add m3u column if upgrading an existing table
  await pool.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS m3u TEXT;`);
  console.log('✓ Postgres ready');
}

async function findCustomer(email) {
  if (!pool) return null;
  const r = await pool.query('SELECT * FROM customers WHERE email=$1', [email.toLowerCase()]);
  return r.rows[0] || null;
}
async function upsertNew(email, username, password, months, orderId, m3u) {
  const expire = addMonths(todayStr(), months);
  await pool.query(
    `INSERT INTO customers (email, username, password, expire, m3u, last_order)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (email) DO UPDATE SET username=$2, password=$3, expire=$4, m3u=$5, last_order=$6, updated_at=now()`,
    [email.toLowerCase(), username, password, expire, m3u || null, orderId]
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
  let username = '', password = '', m3u = '', server = '', raw = text;
  try {
    const j = JSON.parse(text);
    username = j.username || j.user || (j.data && j.data.username) || '';
    password = j.password || j.pass || (j.data && j.data.password) || '';
    // common field names panels use for the playlist / server URL — tune to your panel
    m3u    = j.m3u || j.m3u_url || j.url || j.playlist || (j.data && (j.data.m3u || j.data.url)) || '';
    server = j.server || j.host || j.dns || j.server_url || (j.data && (j.data.server || j.data.host)) || '';
    raw = j;
  } catch {
    const u = text.match(/user(?:name)?["':=\s]+([A-Za-z0-9]+)/i);
    const p = text.match(/pass(?:word)?["':=\s]+([A-Za-z0-9]+)/i);
    const m = text.match(/(https?:\/\/[^\s"']+get\.php[^\s"']*)/i);
    if (u) username = u[1];
    if (p) password = p[1];
    if (m) m3u = m[1];
  }
  // if no full m3u given but we have a server + creds, build the standard XUI m3u link
  if (!m3u && server && username && password) {
    const base = server.replace(/\/+$/, '');
    m3u = `${base}/get.php?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}&type=m3u_plus&output=ts`;
  }
  return { username, password, m3u, server, raw };
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

/* ---- BREVO EMAIL ---- */
async function sendCustomerEmail({ to, name, planName, username, password, expire, m3uUrl }) {
  if (!BREVO_API_KEY || !BREVO_SENDER_EMAIL) { console.warn('Brevo not configured — skipping email'); return false; }
  if (!to) { console.warn('No customer email — skipping email'); return false; }

  const m3uBlock = m3uUrl
    ? `<tr><td style="padding:8px 0;color:#6b7280">M3U URL</td><td style="padding:8px 0;font-family:monospace;color:#111;word-break:break-all"><a href="${m3uUrl}" style="color:#16a34a">${m3uUrl}</a></td></tr>`
    : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb">
    <div style="background:#111;padding:24px;text-align:center">
      <span style="color:#22c55e;font-size:22px;font-weight:800">✓ Your subscription is ready</span>
    </div>
    <div style="padding:28px">
      <p style="font-size:16px;color:#111">Hi ${name || 'there'},</p>
      <p style="font-size:15px;color:#374151;line-height:1.6">Thank you for your order. Your <strong>${planName}</strong> subscription is active. Here are your login details:</p>
      <table style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:10px;padding:8px;margin:18px 0">
        <tr><td style="padding:8px 0 8px 14px;color:#6b7280">Username</td><td style="padding:8px 14px 8px 0;font-family:monospace;font-weight:700;color:#111">${username || '—'}</td></tr>
        <tr><td style="padding:8px 0 8px 14px;color:#6b7280">Password</td><td style="padding:8px 14px 8px 0;font-family:monospace;font-weight:700;color:#111">${password || '—'}</td></tr>
        <tr><td style="padding:8px 0 8px 14px;color:#6b7280">Expires</td><td style="padding:8px 14px 8px 0;color:#111">${expire || '—'}</td></tr>
        ${m3uBlock ? m3uBlock.replace('padding:8px 0','padding:8px 0 8px 14px') : ''}
      </table>
      <div style="text-align:center;margin:26px 0">
        <a href="${SETUP_GUIDE_URL}" style="display:inline-block;background:#22c55e;color:#000;font-weight:700;text-decoration:none;padding:13px 26px;border-radius:10px">📘 View the Setup Guide</a>
      </div>
      <p style="font-size:13px;color:#6b7280;line-height:1.6">Keep this email safe — it contains your login details. If you need help, just reply to this message.</p>
    </div>
    <div style="background:#f9fafb;padding:16px;text-align:center;font-size:12px;color:#9ca3af">Thank you for your order.</div>
  </div>`;

  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        sender: { email: BREVO_SENDER_EMAIL, name: BREVO_SENDER_NAME },
        to: [{ email: to, name: name || to }],
        subject: 'Your subscription is ready — login details inside',
        htmlContent: html
      })
    });
    if (!res.ok) { console.error('Brevo error:', res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error('Brevo send failed:', e); return false; }
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

      let creds = { username:'', password:'' }, isRenewal = false, oldExpire = null, newExpire = null, panelOk = true, panelRaw = '', m3uUrl = '';

      try {
        const existing = await findCustomer(email);
        if (existing && existing.username) {
          // RENEWAL
          isRenewal = true;
          const rn = await panelRenew(existing.username, existing.password, months);
          panelOk = rn.ok; panelRaw = rn.raw;
          creds = { username: existing.username, password: existing.password };
          m3uUrl = existing.m3u || '';
          oldExpire = existing.expire ? new Date(existing.expire).toISOString().slice(0,10) : null;
          // only advance the stored expiry if the panel actually renewed
          if (panelOk) newExpire = await updateRenewal(email, oldExpire, months, data.id);
        } else {
          // NEW
          const nw = await panelNew(months, notes);
          creds = { username: nw.username, password: nw.password };
          m3uUrl = nw.m3u || '';
          panelRaw = typeof nw.raw === 'string' ? nw.raw : JSON.stringify(nw.raw);
          panelOk = !!(creds.username && creds.password);
          if (panelOk) newExpire = await upsertNew(email, creds.username, creds.password, months, data.id, m3uUrl);
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
        m3uUrl ? `  • M3U: <code>${m3uUrl}</code>` : null,
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

      // email the customer their credentials (only if provisioning succeeded)
      let emailed = false;
      if (panelOk && email) {
        emailed = await sendCustomerEmail({
          to: email, name, planName,
          username: creds.username, password: creds.password,
          expire: newExpire, m3uUrl
        });
      }

      // hand the credentials back to the page (only if panel succeeded)
      data._provision = panelOk
        ? { ok:true, isRenewal, username:creds.username, password:creds.password, expire:newExpire, m3u:m3uUrl, emailed }
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
