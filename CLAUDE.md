# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Nexventa is a self-hosted storefront for game-related digital downloads (FiveM/Minecraft mods, HUDs, UI kits, etc.). It is a single Node.js process with no framework and no build step: `server.js` is a raw `node:http` server, `node:sqlite` (`DatabaseSync`, Node 22+ built-in) is the database, and the frontend (`public/`) is a single HTML page with plain JS/CSS — there is no bundler, no React/Vue, no ORM.

## Commands

- Install deps: `npm install` (only runtime dependency is `nodemailer`)
- Run the server: `npm start` (equivalent to `node server.js`), or double-click `start-website.bat` on Windows (installs deps if needed, launches the server in its own terminal, opens the browser)
- Run tests: `npm test` (runs `node --test`, Node's zero-dependency built-in test runner, auto-discovering `tests/*.test.js`). Run a single file directly with `node --test tests/auth.test.js`.
- No lint config or build step exists in this repo
- The server reads `.env` from the project root itself (see `loadEnvFile` in `server.js`) — no dotenv dependency. Copy `.env.example` to `.env` and set `ADMIN_PASSCODE` plus SMTP creds before running; env vars already set in the shell take precedence over `.env`. Restart the server after editing `.env`.
- Default listen address is `127.0.0.1:3000`; override with `HOST`/`PORT`/`BASE_URL` in `.env`. `DATA_DIR` overrides where `data/` (SQLite + uploads) is created — used by the test suite to get an isolated DB per test file, but also handy for running a second instance locally. `TRUST_PROXY=1` makes rate limiting read the client IP from `X-Forwarded-For` instead of the raw socket address — only set this when actually deployed behind a reverse proxy (per the README's hosting guidance), otherwise every client appears to share the proxy's IP and rate limits become global instead of per-client.

## Architecture

**Everything server-side lives in one file, `server.js`.** It is organized top-to-bottom as:
1. `.env` loader + config constants (`PORT`, `HOST`, `BASE_URL`, `DATA`/`FILES`/`IMAGES` paths under `data/`)
2. SQLite schema (`CREATE TABLE IF NOT EXISTS …`) and ad-hoc `ALTER TABLE` migrations guarded by `PRAGMA table_info` checks — this is the only migration mechanism; there's no migration framework
3. Seed data (sample categories/products) inserted only if the `categories` table is empty
4. Helper functions: `send`/`readBody` (JSON in/out, body read as buffered chunks with both a `Content-Length` fast-reject and a streaming size cap), `hash`/`verificationHash` (crypto; password/code hashing uses async `scrypt`, never the blocking `scryptSync`, so a burst of auth requests can't stall the single event loop), session cookie helpers (`setSessionCookie`/`auth`/`requireUser`/`requireAdmin`/`createSession`), `rateLimit` (generic in-memory token-bucket-per-key rate limiting via the `rateLimitBuckets` Map — used for auth endpoints and also coupon validation/checkout/reviews/support), `clientIp` (socket address, or `X-Forwarded-For` when `TRUST_PROXY` is set), `emailTransport`/`sendVerificationCode` (Nodemailer), `saveUpload` (validates and writes base64 uploads to `data/images` or `data/files`), `publicProduct`/`publicCategory` (DB row → API shape, adding `imageUrl`)
5. `route(req, res)` — a single async function dispatching on `method`/`pathname` with sequential `if` checks (plain string compares for static routes, regex `.match()` for routes with an `:id`, e.g. `/^\/api\/admin\/products\/(\d+)$/`). There is no router library; new endpoints are added as another `if` block in this function, in roughly REST-grouped order (public store → auth/registration → admin CRUD → coupons/vouchers → checkout/webhooks → orders/downloads → static file fallback)
6. Static file serving falls through at the bottom of `route()`: known SPA paths (`/`, `/games`, `/shop`, `/coupons`, `/reviews` — the `PAGE_PATHS` set) all serve `public/index.html`; everything else resolves under `public/` with a path-traversal guard
7. `http.createServer` wraps `route()` with a catch-all error handler and sets security headers on every response (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, a `Content-Security-Policy`, and `Strict-Transport-Security` when `BASE_URL` is `https://`)
8. `module.exports = server` at the very end — the only reason this exists is so `tests/*.test.js` can `require("../server.js")` and get a live, listening server back to issue real HTTP requests against; it has no effect on `node server.js` direct execution

**Auth model:** sessions are opaque random tokens, hashed before storing in the `sessions` table, set as an httpOnly cookie. `requireUser`/`requireAdmin` gate routes by looking up that cookie. Admin is a single shared passcode (`ADMIN_PASSCODE` in `.env`), not a per-user role — `POST /api/admin/login` creates an admin-flagged session; there is no separate admin user table.

**Email verification:** new registrations go into `email_verifications` (pending, with a hashed 6-digit code) rather than `users` directly; `POST /api/verify-email` promotes the pending row into `users` once the code matches. Codes expire after 10 minutes, hashed+salted, rate-limited resends.

**Commerce flow:** cart/coupon logic lives client-side in `public/app.js` (`state.cart`, `applyCoupon`, `startCheckout`); the server only computes authoritative totals at checkout and payment confirmation. Stripe Checkout is optional — if `STRIPE_SECRET_KEY` is unset, `/api/checkout` behaves accordingly and payments stay disabled. `POST /api/webhooks/stripe` handles `checkout.session.completed`/`checkout.session.expired` to fulfill orders; for local testing, use the Stripe CLI (`stripe listen`) to forward webhooks and set `STRIPE_WEBHOOK_SECRET` accordingly. Paid orders generate one-use, time-limited download tokens (`downloads` table) exposed via `GET /api/orders/:id/downloads` and redeemed at `GET /download/:token` — digital files in `data/files` are never served directly by path.

**Frontend (`public/`):** `index.html` is a single document containing all "pages" as `<section data-page="...">` blocks plus every modal (auth, admin login, admin studio, product/category/voucher/coupon editors) inline and `hidden` by default. Nav links are plain `<a href>`s — clicking between Home/Games/Shop/Coupons/Reviews is a **full page reload**, not SPA routing; this matters because it means all in-memory JS state (`state.*`) is wiped and rebuilt from scratch on every navigation, while only what's explicitly persisted (`localStorage`/`sessionStorage`) survives. `app.js` is one flat script (no modules) that:
- Keeps all UI state in a single `state` object (cart, user, products, active tab, etc.). The cart (`state.cart`) and voucher cart (`state.voucherCart`) persist to `localStorage`; the applied coupon/voucher code persists to `sessionStorage` (re-validated against the server on boot via `restoreCoupon()`, since a code could have been deactivated meanwhile — never trust a client-cached discount percentage).
- **`productsLoaded`/`couponOffersLoaded` guard pattern:** `renderCart()` reconciles `state.cart` (ids from `localStorage`) against `state.products` to drop ids for products that no longer exist — but it only does this once `state.productsLoaded` is true. Before that point it renders an empty cart rather than filtering against an empty product list. This guard is load-bearing: `boot()` calls `renderCart()` synchronously before `loadStore()` resolves (for a fast first paint), and without the guard that early call would filter every cart id against `state.products = []`, permanently wiping the cart. Any new code that recomputes `state.cart`/`state.voucherCart` from `state.products`/`state.couponOffers` must follow the same loaded-flag guard, or risk silently discarding a shopper's bag on the very next page they navigate to.
- `configurePage()` shows/hides the right `data-page` section based on `location.pathname`, giving client-side "routing" over the handful of server-recognized paths
- `api()` is the single fetch wrapper (adds JSON headers, throws on non-2xx) that every network call goes through
- The admin studio (`renderAdmin`, `loadAdmin`) is tabbed (products/orders/customers/coupons/games/reviews/support) and reuses the same modals as the public site for editing
- No CSS framework; `styles.css` is hand-written, using CSS custom properties for theming

**Data/files:** `data/shop.sqlite` (WAL mode) plus `data/images/` and `data/files/` (uploaded artwork and digital products, stored under randomized filenames via `saveUpload`) are created at startup and are git-ignored. This directory is the entire persistent state of the app — back it up, don't commit it. Overridable via `DATA_DIR` (see Commands).

**Categories** (`categories` table) have a `name`, `game`, and an optional `image` (same upload pipeline as product artwork, 2MB cap). Admin can create/edit/delete them (`POST`/`PUT`/`DELETE /api/admin/categories[/:id]`); deleting a category does not touch its products (`category_id` is `ON DELETE SET NULL`), and an orphaned uploaded image is unlinked only if no other category row still references it. The public Games page and the admin "Games & categories" tab both render the image when set, falling back to a rotating glyph when not.

## Testing

`tests/*.test.js` use Node's built-in `node:test` + `node:assert/strict` — no test framework dependency. Each test **file** runs as its own process under `node --test`, so `tests/helpers.js`'s `startTestServer()` sets `DATA_DIR`/`PORT=0`/`ADMIN_PASSCODE` and other env vars and then `require("../server.js")` fresh, giving that file an isolated temp SQLite DB and an OS-assigned port — safe to run concurrently with the dev server on :3000 or with other test files. `cookieJar()` is a minimal manual cookie-jar since plain `fetch` doesn't persist `Set-Cookie` across requests.

Tests that need a verified user or a paid order (registration/checkout normally require real SMTP/Stripe) seed rows directly into the SQLite file with a second `DatabaseSync` connection opened on the same path — this mirrors how the server itself would have left the data, without needing live credentials. The checkout discount-math regression test goes one step further: it sets a fake `STRIPE_SECRET_KEY` and monkey-patches the process-global `fetch` to intercept just the `api.stripe.com` call, letting the test exercise the server's **real** `/api/checkout` discount calculation end-to-end rather than a reimplemented copy of the formula.

Tests that exhaust a `rateLimit()` bucket on purpose (to assert a 429) do so as the **last** test in their file — later tests in the same file share the same server/IP, so an earlier exhaustion would make them see spurious 429s too.

The directory is named `tests/` (not `test/`): Node's test runner treats *any* file inside a directory literally named `test` as a test file regardless of its name, which previously caused `tests/helpers.js` to be "run" as an (empty, always-passing) test of its own.

## Security

A deliberate pass addressed: per-key rate limiting (`rateLimit()`) beyond just the auth endpoints — also `/api/coupons/validate` (prevents brute-forcing promo/voucher codes), `/api/checkout`, and user-keyed limits on `/api/reviews` and `/api/support`; a Content-Security-Policy plus `Permissions-Policy` and conditional HSTS on every response; async `scrypt` everywhere a password/code is hashed (sync `scryptSync` would block the single event loop under concurrent load); a constant-time, fixed-length (SHA-256-hashed) comparison for the admin passcode so response timing can't leak its length; and `/api/login` always performs a dummy `scrypt` computation even for an unregistered email, so response timing can't be used to enumerate registered accounts. `clientIp()`/`TRUST_PROXY` exists because the README recommends deploying behind a reverse proxy — without it, per-IP rate limits would silently become global limits shared by every visitor.

## Conventions to follow when extending this code

- New API endpoints: add another `if (method === "..." && pathname === "...")` block inside `route()` in `server.js`, near the related existing routes; use `send(res, status, data)` for JSON responses and throw `Object.assign(new Error(msg), { status })` for client-facing error codes (the top-level catch in `createServer` turns these into proper HTTP responses).
- New DB columns on existing tables: don't edit the `CREATE TABLE IF NOT EXISTS` blind — existing databases won't get new columns from that. Follow the existing pattern of a guarded `ALTER TABLE ... ADD COLUMN` using `PRAGMA table_info` to check if it's already applied (see the `email_verified`/`active` examples near the top of `server.js`).
- New frontend behavior: extend `public/app.js` directly (no build/compile step — edits take effect on page reload) and keep using the existing `state` object and `api()` helper rather than introducing new patterns (fetch wrappers, state containers, etc.).
- Uploads must go through `saveUpload`, which enforces an extension/MIME allowlist and a size cap per `kind` ("image" vs "digital") — don't bypass it when adding new upload paths.
