# Bloom — Secure PayPal Cart Checkout

A multi-item cart checkout in the Bloom style, with **server-side** PayPal
integration. Prices are computed and verified on the server, so customers
can't tamper with amounts in the browser.

## What's inside
```
bloom-cart-checkout/
├── server.js          → Node/Express backend (creates & captures orders)
├── public/index.html  → the checkout page (served by the backend)
├── package.json
├── .env.example       → copy to .env and add your keys
└── README.md
```

## Setup (5 steps)

1. **Get PayPal credentials**
   Go to https://developer.paypal.com/dashboard/applications, create an app,
   and copy its **Client ID** and **Secret**. Use the **Sandbox** ones first.

2. **Add your keys**
   ```
   cp .env.example .env
   ```
   Then open `.env` and paste in your Client ID and Secret.

3. **Install dependencies** (needs Node.js 18+)
   ```
   npm install
   ```

4. **Run it**
   ```
   npm start
   ```

5. **Open** http://localhost:3000 and test with a
   [sandbox buyer account](https://developer.paypal.com/dashboard/accounts).

## Going live
- In `.env`, set `PAYPAL_ENV=live` and swap in your **live** Client ID + Secret.
- Deploy to any Node host (Render, Railway, Fly, a VPS, etc.).
- Serve over **HTTPS** — PayPal requires it in production.

## Editing your products
Open `server.js` and edit the `CATALOG` object — this is the single source of
truth for prices. The front-end only ever sends item IDs and quantities.

```js
const CATALOG = {
  'growth-kit': { name: 'Brand Growth Kit', price: 49.00 },
  ...
};
```
To change which items show in the cart by default, edit the `cart` array near
the top of the `<script>` in `public/index.html`, and add a matching thumbnail
in the `THUMBS` object.

## Tax & promo codes
- Set `TAX_RATE` in `server.js` (e.g. `0.20` for 20%).
- Promo codes live in the `PROMOS` object in `server.js`.

## Security notes (important)
- Your **Secret key lives only on the server** (in `.env`) — never in HTML/JS.
- Amounts are always recomputed server-side; the browser is never trusted.
- An order is only treated as paid when PayPal returns `status: "COMPLETED"`.
- After capture, add your fulfilment logic where marked `TODO` in `server.js`
  (save to DB, send receipt, grant access). Consider also verifying via
  PayPal **webhooks** for extra reliability.
```
