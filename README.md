# Mitki's Cafe: online ordering and payment

Customers open the website, choose items, and pay with Razorpay (UPI, cards, wallets).
Paid orders appear on a password-protected **/kitchen** screen, where staff move each one
through New, Preparing, Ready and Served. Customers can watch their own order status.

- Customer page: `https://your-site/`
- Kitchen screen: `https://your-site/kitchen` (sign in with `KITCHEN_USER` and `KITCHEN_PASSWORD`)

No packages to install. It needs only Node 18 or newer.

## What is in the folder

| File | What it does |
| --- | --- |
| `server.js` | The whole backend: prices orders, talks to Razorpay, checks payments, serves the pages |
| `menu.json` | Your menu and prices. Edit this to change the menu (no restart needed) |
| `public/` | The customer page, the kitchen screen, the logo and styles |
| `.env.example` | The settings the server needs, with placeholders |
| `tests/run-tests.js` | Automated checks (`node tests/run-tests.js`) |

## Step 1: Try it on your computer (no Razorpay needed)

```
KITCHEN_PASSWORD=choose-a-long-password PAYMENT_MODE=test node server.js
```

Open http://localhost:3000 and place an order, then open http://localhost:3000/kitchen
(user `staff`, the password you chose). In this test mode no money is taken.
The server refuses to run in test mode when `NODE_ENV=production`, so it cannot
accidentally be used for real customers.

## Step 2: Razorpay settings

1. In the Razorpay Dashboard, stay in **Test mode** first and create API keys
   (Account & Settings, then API Keys). Keep the Key Secret private.
2. Add a webhook (Account & Settings, then Webhooks):
   - URL: `https://your-site/api/razorpay/webhook`
   - Events: `payment.captured` and `order.paid`
   - Secret: any long random text you make up. Use the same text as `RAZORPAY_WEBHOOK_SECRET`.
   - The webhook matters: it records a payment even if the customer closes their browser right after paying.
3. Make sure payments are set to capture automatically in your Razorpay payment settings.

## Step 3: Put it online

Use any host that can run a Node server and offers a **persistent disk** and HTTPS
(for example Render, Railway or Fly.io). Hosts that put the app to sleep, or that wipe
the disk when it restarts, will lose orders, so they are not suitable. Serverless hosts
(Vercel, Netlify) will not work with this version.

On the host:
1. Upload this folder (or connect it through Git).
2. Start command: `node server.js`
3. Attach a persistent disk and note its path, for example `/var/data`.
4. In the host's Environment settings, add these (names from `.env.example`):
   `PAYMENT_MODE=razorpay`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`,
   `RAZORPAY_WEBHOOK_SECRET`, `KITCHEN_USER`, `KITCHEN_PASSWORD`, `DATA_DIR=/var/data`.
5. Run only one copy of the app. Orders are kept in a single file on the disk.

## Step 4: Test with Razorpay test mode

Place an order on your site and pay using Razorpay's test payment details (Razorpay lists
test UPI IDs and cards in its documentation). Check that:
- the order shows up on `/kitchen`,
- the customer page moves to "Order received",
- the Razorpay Dashboard webhook "deliveries" list shows a successful response.

## Step 5: Go live

1. Finish Razorpay's account activation (identity and business checks).
2. Switch the Dashboard to Live mode, create **live** keys and a **live** webhook (it has
   its own secret), and replace the three Razorpay values in the host's settings.
3. Place one small real order, such as a Rs 15 chai, check it reaches `/kitchen`, and refund it
   from the Razorpay Dashboard.
4. Print a QR code of your site address for the counter and tables.

## Day to day

- **Change the menu:** edit `menu.json`. `"price": null` shows the item as Upcoming and it cannot be ordered.
  Options such as Kulhad +5 are listed under `options`.
- **Refunds:** pressing Cancel on the kitchen screen only changes the order's status. It does not
  refund the customer. Refund from the Razorpay Dashboard, using the payment ID shown on the order card.
- **New order sound:** press "Sound off" on the kitchen screen once to turn it on (browsers need a tap first).
- **Old orders:** orders are removed after 60 days (`KEEP_DAYS`), and unpaid attempts after 24 hours.

## Safety notes

- Prices are always calculated by the server from `menu.json`. A customer cannot change them from their browser.
- Payments are confirmed by checking Razorpay's signature with your secret key, never by trusting the browser.
- Keys and passwords live only in environment settings. Never put them in files you share.
- The kitchen screen uses HTTP sign-in. Always use it over `https://`, and use a long password.

## What was and was not tested

Tested automatically (`node tests/run-tests.js`) against a fake Razorpay: pricing, order creation, signature
checks, the webhook, kitchen sign-in and status changes, rate limiting, restart safety.
Not tested: real Razorpay checkout and the live Razorpay API, a real hosting setup, and how the pages look
and behave in a browser. Try all three in Razorpay test mode (Step 4) before you take real orders.
