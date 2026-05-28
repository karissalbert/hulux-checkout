/* =========================================================
   Checkout server — Node + Express + PayPal + Telegram
   ---------------------------------------------------------
   On successful payment, sends a Telegram DM with all order
   details (plan, total, customer name, email, etc.)
   ========================================================= */

import express from 'express';
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static('public'));

/* ---- PAGE ROUTES ---- */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/checkout', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ---- ENV ---- */
const {
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  PAYPAL_ENV = 'sandbox',
  PORT = 3000,
  CURRENCY = 'USD',
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

const BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

/* ---- TRUSTED CATALOG ---- */
const CATALOG = {
  'starter':   { name: 'Plan A — 1 Month',     price: 17.00 },
  'quarterly': { name: 'Plan B — 3 Months',    price: 31.00 },
  'premium':   { name: 'Plan C — 6 Months',    price: 45.00 },
  'ultra':     { name: 'Plan D — 12 Months',   price: 64.00 }
};

const TAX_RATE = 0.00;
const PROMOS = {
  'IPTV10': { type: 'percent', value: 10 },
  'SAVE5':  { type: 'flat',    value: 5  }
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
    items.push({ id: line.id, name: product.name, unit: product.price, qty, lineTotal });
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

/* ---- TELEGRAM NOTIFIER ---- */
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('Telegram not configured — skipping notification');
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });
    const data = await res.json();
    if (!data.ok) console.error('Telegram error:', data);
  } catch (e) {
    console.error('Telegram send failed:', e);
  }
}

function formatOrderMessage(payload, paypal) {
  const c = payload.customer || {};
  const lines = [
    '🎉 <b>New order received!</b>',
    '',
    `💰 <b>Total:</b> ${CURRENCY} ${money(payload.totals.total)}`,
    `📦 <b>Plan:</b> ${payload.items.map(i => i.name).join(', ')}`,
    payload.promo ? `🏷️ <b>Promo:</b> ${payload.promo}` : null,
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
    `  • Status: ${paypal.status}`,
    '',
    `⏰ ${new Date().toISOString()}`
  ].filter(Boolean);
  return lines.join('\n');
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

/* ---- CAPTURE + NOTIFY ---- */
app.post('/api/orders/:id/capture', async (req, res) => {
  try {
    const token = await getToken();
    const r = await fetch(`${BASE}/v2/checkout/orders/${req.params.id}/capture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }
    });
    const data = await r.json();

    if (data.status === 'COMPLETED') {
      // pull useful info out of PayPal's response
      const payer = data.payer || {};
      const paypal = {
        id: data.id,
        status: data.status,
        payer_email: payer.email_address,
        payer_name: payer.name ? `${payer.name.given_name || ''} ${payer.name.surname || ''}`.trim() : ''
      };

      // re-price using the cart from the client (the customer info comes with it)
      const customer = (req.body && req.body.customer) || {};
      const cart = (req.body && req.body.cart) || [];
      const promo = (req.body && req.body.promo) || '';
      const q = priceCart(cart, promo);

      const message = formatOrderMessage(
        { customer, items: q.items, totals: q, promo },
        paypal
      );

      // fire-and-forget — don't block the response
      sendTelegram(message);
      console.log('Payment completed:', data.id);
    }
    res.status(r.status).json(data);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not capture order' });
  }
});

/* ---- TEST ENDPOINT (visit this in your browser to test Telegram setup) ---- */
app.get('/api/test-telegram', async (req, res) => {
  await sendTelegram('✅ Test message from your checkout server. Telegram is working!');
  res.json({ sent: true, hasToken: !!TELEGRAM_BOT_TOKEN, hasChatId: !!TELEGRAM_CHAT_ID });
});

app.listen(PORT, () => {
  console.log(`Checkout running on port ${PORT} (${PAYPAL_ENV}, ${CURRENCY})`);
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.warn('⚠️  Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID');
  }
});
