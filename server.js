/* =========================================================
   Checkout server — Node + Express
   PayPal payment → IPTV provisioning → Brevo email → Telegram
   ---------------------------------------------------------
   Required env vars on Render:
     PAYPAL_CLIENT_ID, PAYPAL_SECRET, PAYPAL_ENV, CURRENCY
     TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
     PROVIDER_API_KEY       (your IPTV provider API key)
     PROVIDER_PACK_ID       (your package ID, e.g. 35338)
     BREVO_API_KEY          (from brevo.com)
     EMAIL_FROM             (e.g. noreply@yourdomain.com)
     EMAIL_FROM_NAME        (e.g. "Hulux TV")
     SUPPORT_EMAIL          (e.g. support@yourdomain.com — shown in email)
   ========================================================= */

import express from 'express';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_ENV = 'sandbox',
  PORT = 3000,
  CURRENCY = 'USD',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  PROVIDER_API_KEY,
  PROVIDER_PACK_ID = '35338',
  BREVO_API_KEY,
  EMAIL_FROM,
  EMAIL_FROM_NAME = 'Customer Service',
  SUPPORT_EMAIL
} = process.env;

const BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const PROVIDER_BASE = 'https://8k.cms-only.ru/api/api.php';

/* ---- TRUSTED CATALOG (plan id → name, price, duration in months) ---- */
const CATALOG = {
  'starter':   { name: 'Plan A — 1 Month',   price: 17.00, months: 1 },
  'quarterly': { name: 'Plan B — 3 Months',  price: 31.00, months: 3 },
  'premium':   { name: 'Plan C — 6 Months',  price: 45.00, months: 6 },
  'ultra':     { name: 'Plan D — 12 Months', price: 64.00, months: 12 }
};

const TAX_RATE = 0.00;
const PROMOS = {
  'SAVE5':   { type: 'flat',    value: 5  },
  'WELCOME10': { type: 'percent', value: 10 }
};

const money = n => n.toFixed(2);

function priceCart(cart = [], promoCode = '') {
  const items = [];
  let subtotal = 0;
  for (const line of cart) {
    const product = CATALOG[line.id];
    const qty = Math.max(1, parseInt(line.qty, 10) || 1);
    if (!product) continue;
    const lineTotal = product.price * qty;
    subtotal += lineTotal;
    items.push({ id: line.id, name: product.name, unit: product.price, qty, lineTotal, months: product.months });
  }
  let discount = 0;
  const promo = PROMOS[(promoCode || '').toUpperCase()];
  if (promo) {
    discount = promo.type === 'percent'
      ? subtotal * (promo.value / 100)
      : Math.min(promo.value, subtotal);
  }
  const taxable = Math.max(0, subtotal - discount);
  const tax = taxable * TAX_RATE;
  const total = taxable + tax;
  return { items, subtotal, discount, tax, total };
}

/* ---- PAYPAL OAUTH ---- */
async function getToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_SECRET}`).toString('base64');
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) throw new Error('Failed to get PayPal token');
  const data = await res.json();
  return data.access_token;
}

/* ---- PROVIDER PROVISIONING ---- */
/* Calls the IPTV provider's API to create a new line for the customer.
   Returns the credentials, or null on failure. */
async function provisionLine({ months, customerEmail, orderId }) {
  if (!PROVIDER_API_KEY) {
    console.error('PROVIDER_API_KEY not set — skipping provisioning');
    return null;
  }
  const params = new URLSearchParams({
    action: 'new',
    type: 'm3u',
    sub: String(months),
    pack: PROVIDER_PACK_ID,
    country: 'ALL',
    notes: `${customerEmail} · order ${orderId}`,
    api_key: PROVIDER_API_KEY
  });
  const url = `${PROVIDER_BASE}?${params}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.status === 'true' || data.status === true) {
      // Parse username + password out of the URL
      const u = new URL(data.url);
      return {
        url: data.url,
        username: u.searchParams.get('username'),
        password: u.searchParams.get('password'),
        host: `${u.protocol}//${u.hostname}${u.port ? ':' + u.port : ''}`,
        user_id: data.user_id,
        raw: data
      };
    }
    console.error('Provider returned error:', data);
    return null;
  } catch (e) {
    console.error('Provider request failed:', e);
    return null;
  }
}

/* ---- BREVO EMAIL ---- */
async function sendEmail({ to, toName, subject, html, text }) {
  if (!BREVO_API_KEY || !EMAIL_FROM) {
    console.warn('Brevo not configured — skipping email');
    return false;
  }
  try {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        sender: { email: EMAIL_FROM, name: EMAIL_FROM_NAME },
        to: [{ email: to, name: toName || to }],
        subject,
        htmlContent: html,
        textContent: text
      })
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Brevo send failed:', res.status, err);
      return false;
    }
    return true;
  } catch (e) {
    console.error('Brevo error:', e);
    return false;
  }
}

function credentialsEmailHtml({ fname, planName, months, creds, orderId }) {
  return `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Your subscription</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#0a0a14">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f7;padding:32px 16px">
    <tr><td align="center">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06)">
        <tr><td style="background:linear-gradient(135deg,#22c55e 0%,#16a34a 100%);padding:36px 32px;text-align:center;color:#fff">
          <h1 style="margin:0;font-size:26px;font-weight:800">Welcome, ${escapeHtml(fname) || 'friend'}!</h1>
          <p style="margin:8px 0 0;font-size:15px;opacity:0.95">Your subscription is ready.</p>
        </td></tr>
        <tr><td style="padding:32px">
          <p style="font-size:16px;line-height:1.6;margin:0 0 18px">Thank you for your order. Your <strong>${escapeHtml(planName)}</strong> subscription has been activated and is ready to use.</p>

          <h3 style="margin:24px 0 12px;font-size:15px;color:#0a0a14;text-transform:uppercase;letter-spacing:0.05em">Your access details</h3>
          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0a14;color:#fff;border-radius:12px;padding:20px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:13.5px;line-height:1.7">
            <tr><td style="padding:6px 0;color:#9ca3af;width:140px">Server URL:</td><td style="padding:6px 0;color:#fff;word-break:break-all">${escapeHtml(creds.host)}</td></tr>
            <tr><td style="padding:6px 0;color:#9ca3af">Username:</td><td style="padding:6px 0;color:#22c55e;font-weight:600">${escapeHtml(creds.username)}</td></tr>
            <tr><td style="padding:6px 0;color:#9ca3af">Password:</td><td style="padding:6px 0;color:#22c55e;font-weight:600">${escapeHtml(creds.password)}</td></tr>
            <tr><td colspan="2" style="padding-top:14px;border-top:1px solid #1f2937;margin-top:14px;color:#9ca3af;font-size:11px;letter-spacing:0.06em;text-transform:uppercase">Full M3U link</td></tr>
            <tr><td colspan="2" style="padding:6px 0;color:#fff;word-break:break-all;font-size:11.5px">${escapeHtml(creds.url)}</td></tr>
          </table>

          <h3 style="margin:28px 0 12px;font-size:15px;color:#0a0a14;text-transform:uppercase;letter-spacing:0.05em">Quick setup</h3>
          <ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.7;color:#525266">
            <li>Open your favorite app (IPTV Smarters, TiviMate, IBO Player, GSE Smart, etc.)</li>
            <li>Add a new playlist using the M3U URL above, <em>or</em> use the username + server URL with the Xtream Codes login option</li>
            <li>Wait a few seconds for the channel list to load — you're in</li>
          </ol>

          <table cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:28px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px">
            <tr><td style="font-size:14px;line-height:1.55;color:#15803d">
              <strong>Need help?</strong> Reply to this email or contact us at
              <a href="mailto:${escapeHtml(SUPPORT_EMAIL || EMAIL_FROM)}" style="color:#15803d">${escapeHtml(SUPPORT_EMAIL || EMAIL_FROM)}</a>
              — we usually reply within an hour.
            </td></tr>
          </table>

          <p style="margin:28px 0 0;font-size:12.5px;color:#9ca3af">Order reference: ${escapeHtml(orderId)} · Duration: ${months} month${months>1?'s':''}</p>
        </td></tr>
        <tr><td style="background:#fafafb;padding:18px 32px;font-size:12px;color:#9ca3af;text-align:center;border-top:1px solid #e8e8ec">
          You received this because you purchased a subscription. Please keep this email — your credentials are inside.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

function credentialsEmailText({ fname, planName, months, creds, orderId }) {
  return [
    `Welcome${fname ? ', ' + fname : ''}!`,
    '',
    `Your ${planName} subscription has been activated.`,
    '',
    'YOUR ACCESS DETAILS',
    `Server URL: ${creds.host}`,
    `Username:   ${creds.username}`,
    `Password:   ${creds.password}`,
    '',
    `Full M3U link:`,
    creds.url,
    '',
    'QUICK SETUP',
    '1. Open your favorite IPTV app (Smarters, TiviMate, IBO, GSE, etc.)',
    '2. Add a new playlist using the M3U URL above, or use the username/password + server URL with the Xtream Codes login option',
    '3. Wait a few seconds for the channel list to load',
    '',
    `Need help? Reply to this email or contact ${SUPPORT_EMAIL || EMAIL_FROM}`,
    '',
    `Order: ${orderId} · Duration: ${months} month${months>1?'s':''}`
  ].join('\n');
}

/* "Credentials coming shortly" email — sent when provider API failed,
   so the customer isn't left wondering. */
function pendingEmailHtml({ fname, planName, orderId }) {
  return `
<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#0a0a14">
<table cellpadding="0" cellspacing="0" border="0" width="100%" style="padding:32px 16px"><tr><td align="center">
<table cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#fff;border-radius:16px;padding:36px">
  <tr><td>
    <h2 style="margin:0 0 14px;font-size:22px">Payment received, ${escapeHtml(fname) || 'friend'}!</h2>
    <p style="font-size:15.5px;line-height:1.6;margin:0 0 16px;color:#525266">
      Thank you for your <strong>${escapeHtml(planName)}</strong> purchase. We're preparing your account credentials right now —
      they'll arrive in a separate email within the next hour.
    </p>
    <p style="font-size:15.5px;line-height:1.6;margin:0 0 12px;color:#525266">
      If you don't receive them by then, please contact
      <a href="mailto:${escapeHtml(SUPPORT_EMAIL || EMAIL_FROM)}" style="color:#22c55e">${escapeHtml(SUPPORT_EMAIL || EMAIL_FROM)}</a>
      and we'll sort it out immediately.
    </p>
    <p style="margin:24px 0 0;font-size:12.5px;color:#9ca3af">Order reference: ${escapeHtml(orderId)}</p>
  </td></tr>
</table>
</td></tr></table>
</body></html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

/* ---- TELEGRAM ---- */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error('Telegram send failed:', e);
  }
}

function formatOrderMessage({ customer, items, totals, promo, paypal, creds, provisionOk }) {
  const c = customer || {};
  const lines = [
    provisionOk ? '🎉 <b>New order — credentials sent ✅</b>' : '⚠️ <b>New order — PROVISIONING FAILED, manual action needed</b>',
    '',
    `💰 <b>Total:</b> ${CURRENCY} ${money(totals.total)}`,
    `📦 <b>Plan:</b> ${items.map(i => i.name).join(', ')}`,
    promo ? `🏷️ <b>Promo:</b> ${promo}` : null,
    '',
    '👤 <b>Customer</b>',
    `  • Name: ${(c.fname || '') + ' ' + (c.lname || '') || '—'}`,
    `  • Email: ${c.email || '—'}`,
    `  • Country: ${c.country || '—'}`,
    `  • City: ${c.city || '—'}`,
    '',
    '💳 <b>PayPal</b>',
    `  • Payer email: ${paypal.payer_email || '—'}`,
    `  • Payer name: ${paypal.payer_name || '—'}`,
    `  • Order ID: <code>${paypal.id}</code>`,
    '',
  ];
  if (creds) {
    lines.push('🔑 <b>Credentials created</b>');
    lines.push(`  • User ID: <code>${creds.user_id || '—'}</code>`);
    lines.push(`  • Username: <code>${creds.username}</code>`);
    lines.push(`  • Password: <code>${creds.password}</code>`);
    lines.push(`  • Host: ${creds.host}`);
  } else {
    lines.push('❌ <b>Provider API did NOT return credentials.</b>');
    lines.push('   Please create the line manually and email the customer.');
  }
  lines.push('', `⏰ ${new Date().toISOString()}`);
  return lines.filter(Boolean).join('\n');
}

/* ---- API ROUTES ---- */
app.get('/api/config', (req, res) => {
  res.json({ clientId: PAYPAL_CLIENT_ID, currency: CURRENCY });
});

app.post('/api/quote', (req, res) => {
  const { cart, promo } = req.body || {};
  const q = priceCart(cart, promo);
  res.json({
    items: q.items,
    subtotal: money(q.subtotal),
    discount: money(q.discount),
    tax: money(q.tax),
    total: money(q.total)
  });
});

app.post('/api/orders', async (req, res) => {
  try {
    const { cart, promo } = req.body || {};
    const q = priceCart(cart, promo);
    if (q.total <= 0) return res.status(400).json({ error: 'Empty cart' });
    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: CURRENCY,
            value: money(q.total),
            breakdown: {
              item_total: { currency_code: CURRENCY, value: money(q.subtotal) },
              discount:   { currency_code: CURRENCY, value: money(q.discount) },
              tax_total:  { currency_code: CURRENCY, value: money(q.tax) }
            }
          },
          items: q.items.map(it => ({
            name: it.name,
            quantity: String(it.qty),
            unit_amount: { currency_code: CURRENCY, value: money(it.unit) }
          }))
        }]
      })
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not create order' });
  }
});

/* ---- CAPTURE + PROVISION + EMAIL + TELEGRAM ---- */
app.post('/api/orders/:id/capture', async (req, res) => {
  try {
    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders/${req.params.id}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    const data = await r.json();

    // Respond to PayPal IMMEDIATELY so the customer's success screen shows fast.
    res.status(r.status).json(data);

    if (data.status !== 'COMPLETED') return;

    // From here on, run fulfilment in the background. Errors get logged + sent to Telegram.
    (async () => {
      const payer = data.payer || {};
      const paypal = {
        id: data.id,
        status: data.status,
        payer_email: payer.email_address,
        payer_name: payer.name ? `${payer.name.given_name || ''} ${payer.name.surname || ''}`.trim() : ''
      };

      const customer = (req.body && req.body.customer) || {};
      const cart = (req.body && req.body.cart) || [];
      const promo = (req.body && req.body.promo) || '';
      const q = priceCart(cart, promo);

      const planItem = q.items[0];
      const months = planItem ? planItem.months : 1;
      const planName = planItem ? planItem.name : 'Subscription';
      const customerEmail = (customer.email || payer.email_address || '').trim();
      const fname = (customer.fname || (payer.name && payer.name.given_name) || '').trim();

      // 1) provision the line
      let creds = null;
      if (planItem) {
        creds = await provisionLine({ months, customerEmail, orderId: data.id });
      }

      // 2) email the customer
      if (customerEmail) {
        if (creds) {
          await sendEmail({
            to: customerEmail,
            toName: `${fname} ${customer.lname || ''}`.trim(),
            subject: `Your subscription is ready — ${planName}`,
            html: credentialsEmailHtml({ fname, planName, months, creds, orderId: data.id }),
            text: credentialsEmailText({ fname, planName, months, creds, orderId: data.id })
          });
        } else {
          await sendEmail({
            to: customerEmail,
            toName: `${fname} ${customer.lname || ''}`.trim(),
            subject: `Payment received — credentials coming shortly`,
            html: pendingEmailHtml({ fname, planName, orderId: data.id }),
            text: `Hi${fname ? ' ' + fname : ''},\n\nWe've received your payment for ${planName}. Your access details will arrive in a separate email within the next hour. If not, please contact ${SUPPORT_EMAIL || EMAIL_FROM}.\n\nOrder: ${data.id}`
          });
        }
      } else {
        console.warn('No customer email captured — cannot email credentials');
      }

      // 3) notify you on Telegram
      await sendTelegram(formatOrderMessage({
        customer, items: q.items, totals: q, promo, paypal, creds, provisionOk: !!creds
      }));

      console.log('Order fulfilled:', data.id, creds ? 'OK' : 'provisioning FAILED');
    })().catch(err => {
      console.error('Background fulfilment error:', err);
      sendTelegram(`⚠️ Background error after payment ${data.id}: ${err.message}`);
    });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.status(500).json({ error: 'Could not capture order' });
  }
});

/* ---- TEST ENDPOINTS (visit in your browser to check setup) ---- */
app.get('/api/test-telegram', async (req, res) => {
  await sendTelegram('✅ Test message — Telegram is working!');
  res.json({ sent: true });
});

app.get('/api/test-email', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.json({ error: 'Add ?to=youremail@example.com to the URL' });
  const ok = await sendEmail({
    to, toName: 'Test',
    subject: 'Brevo test — your checkout email is working',
    html: '<p>This is a test from your checkout server. ✅</p>',
    text: 'This is a test from your checkout server. ✅'
  });
  res.json({ sent: ok });
});

app.get('/api/test-provider', async (req, res) => {
  const creds = await provisionLine({ months: 1, customerEmail: 'test@example.com', orderId: 'TEST-' + Date.now() });
  res.json({ ok: !!creds, creds });
});

app.listen(PORT, () => {
  console.log(`Checkout running on port ${PORT} (${PAYPAL_ENV}, ${CURRENCY})`);
  const missing = [];
  if (!PAYPAL_CLIENT_ID) missing.push('PAYPAL_CLIENT_ID');
  if (!PAYPAL_SECRET)    missing.push('PAYPAL_SECRET');
  if (!TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!TELEGRAM_CHAT_ID)   missing.push('TELEGRAM_CHAT_ID');
  if (!PROVIDER_API_KEY)   missing.push('PROVIDER_API_KEY');
  if (!BREVO_API_KEY)      missing.push('BREVO_API_KEY');
  if (!EMAIL_FROM)         missing.push('EMAIL_FROM');
  if (missing.length) console.warn('⚠️  Missing env vars:', missing.join(', '));
});
