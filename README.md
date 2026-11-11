# Nexventa digital shop

A self-hosted storefront for game-related digital downloads. The app uses Node.js, SQLite, plain HTML/CSS/JavaScript, and Nodemailer for account-verification email; it does not require a third-party frontend service.

## Run locally

Use Node.js 22 or newer. For a quick Windows start, double-click `start-website.bat` in this folder. It installs dependencies if needed, starts the server in a separate terminal, and opens the site in your browser. Keep the server terminal open while using the site. Alternatively, open PowerShell in this folder and run `npm start`.

Edit the root `.env` file and set a private admin passcode and Gmail SMTP credentials for customer email verification. Add Stripe keys when you are ready to accept payments:

```dotenv
ADMIN_PASSCODE=replace-with-a-long-random-passcode
PORT=3000
HOST=127.0.0.1
BASE_URL=http://127.0.0.1:3000
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_USER=your-store-gmail@gmail.com
SMTP_APP_PASSWORD=your-google-app-password
SMTP_FROM=your-store-gmail@gmail.com
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

All supported server environment variables are listed in `.env.example`. The root `.env` is ignored by Git; copy the example to `.env` if needed and edit your local values. Install the mail dependency with `npm install`, then start the app from this folder with `node server.js` or `npm start`. The server loads `.env` automatically; environment variables already set by your terminal take precedence. Never share or commit your `.env` file.

### Gmail email verification

New customers receive a six-digit code at the email address they register with. Accounts are created only after the code is verified. Codes expire after 10 minutes, are stored as salted hashes, and are limited to five incorrect attempts; resend requests are throttled. Configure `SMTP_USER` with a Gmail account owned by the store and `SMTP_APP_PASSWORD` with a Google App Password (create one in the Google Account security settings after enabling 2-Step Verification). Do not use the store Gmail account's normal password or ask customers for their email password. `SMTP_FROM` is optional and defaults to `SMTP_USER`. Restart the server after changing `.env`. Registration returns a clear setup error if SMTP credentials are missing or mail delivery fails.

Open <http://127.0.0.1:3000>. The seeded storefront is sample content. Unlock admin mode with the passcode, add your own products, and upload the actual digital files before enabling sales.

The SQLite database and private product files are created in `data\`. Back up that folder regularly. Digital downloads are not exposed through the public image route. A customer needs a paid order to request a seven-day download URL; each URL can be used once. Customers can request a fresh URL from their account for an existing paid order.

## Stripe payments

Payments are disabled until Stripe is configured. Checkout is hosted by Stripe; card data is never handled by this app. Apple Pay and Google Pay availability depends on your Stripe account, domain verification, and the customer's device. Cash App Pay must be enabled for the Stripe account and is only available in supported regions/currencies.

For local testing, add your Stripe test credentials to `.env` and restart the app.

In another terminal, use the Stripe CLI to forward `checkout.session.completed` and `checkout.session.expired` events to `http://127.0.0.1:3000/api/webhooks/stripe`; set `STRIPE_WEBHOOK_SECRET` in `.env` to the signing secret printed by `stripe listen`. Test card payments and verify the webhook before switching to live keys.

The current checkout is priced in USD. PayPal and multi-currency pricing are not wired up yet; they require provider credentials and an explicit per-currency pricing/conversion policy. This app does not collect card details itself.

## Hosting and security

By default, the server listens only on `127.0.0.1`. For a public deployment, run it behind a maintained HTTPS reverse proxy, set `HOST=0.0.0.0`, set `BASE_URL` to the public HTTPS address, and provide a strong `ADMIN_PASSCODE`, Stripe keys, and webhook secret through the hosting provider's secret/environment settings. Do not commit credentials or expose the SQLite database, `data\files\`, or server logs publicly.

The admin button is available on every page; the actual administrative API is protected by the server-side passcode session. Closing the owner studio revokes that session, so the passcode is required again when reopening it. Deleting a product removes it permanently if it has no order history; products referenced by past orders are archived so receipts and downloads remain intact. Keep the Node.js runtime and host up to date, restrict access to the machine and backups, and run periodic database/file backups.

## Included features

- Separate responsive Home, Games, Shop, Coupons, and Reviews pages with direct URLs.
- Customer registration/sign-in, order history, protected checkout, and one-use download links.
- Inline owner studio for product add/edit/archive/restore, digital and image uploads, categories, paid discount vouchers, promo codes, customers, orders, Stripe refunds, reviews, sales totals, and support tickets.
- Customer-purchased vouchers that issue private, one-use codes after Stripe confirms payment; signed-in customers can redeem them on a product order.
- Customer reviews with required 1–5 star ratings and server-side sign-in checks.
- Persistent SQLite storage and Stripe Checkout/webhook fulfillment.

Support requests appear in the owner studio; replies are sent to the customer's email outside the app.
