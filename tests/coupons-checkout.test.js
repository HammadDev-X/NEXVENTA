const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { startTestServer, cookieJar, jsonFetch } = require("./helpers");

let baseUrl, server, dataDir, adminJar, db;

before(async () => {
  ({ baseUrl, server, dataDir } = await startTestServer());
  adminJar = cookieJar();
  const login = await jsonFetch(baseUrl, "/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ passcode: "test-admin-passcode" })
  });
  adminJar.capture(login.response);
  // A second connection to the same SQLite file, used only to seed fixtures
  // that would otherwise require real SMTP/Stripe (account verification, a paid order).
  db = new DatabaseSync(path.join(dataDir, "shop.sqlite"));
});

after(() => {
  db.close();
  server.close();
});

function seedVerifiedUser(email) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync("TestPassword123", salt, 64).toString("hex");
  const result = db.prepare(
    "INSERT INTO users(name, email, password_hash, password_salt, email_verified) VALUES (?, ?, ?, ?, 1)"
  ).run("Test User", email, passwordHash, salt);
  return Number(result.lastInsertRowid);
}

async function loginAs(email) {
  const jar = cookieJar();
  const login = await jsonFetch(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "TestPassword123" })
  });
  assert.equal(login.status, 200, `login should succeed for ${email}`);
  jar.capture(login.response);
  return jar;
}

test("a newly created promo code validates for anyone with the correct discount", async () => {
  const create = await jsonFetch(baseUrl, "/api/admin/coupons", {
    method: "POST",
    headers: adminJar.header(),
    body: JSON.stringify({ code: "SAVE20", discount: 20 })
  });
  assert.equal(create.status, 201);

  const { status, body } = await jsonFetch(baseUrl, "/api/coupons/validate", {
    method: "POST",
    body: JSON.stringify({ code: "save20" }) // lowercase, should still match
  });
  assert.equal(status, 200);
  assert.equal(body.discount, 20);
  assert.equal(body.kind, "promo");
});

test("an unknown coupon code is rejected", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/coupons/validate", {
    method: "POST",
    body: JSON.stringify({ code: "NOT-REAL-CODE" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /invalid/i);
});

test("a purchased voucher only redeems for the account that owns it", async () => {
  const ownerId = seedVerifiedUser("voucher-owner@example.com");
  seedVerifiedUser("stranger@example.com");

  const offer = db.prepare(
    "INSERT INTO coupon_offers(name, description, price_cents, discount_percent) VALUES (?, ?, ?, ?)"
  ).run("15% Voucher", "test", 500, 15);
  const order = db.prepare("INSERT INTO orders(user_id, total_cents, status) VALUES (?, ?, 'paid')").run(ownerId, 500);
  const code = `NX-${crypto.randomBytes(8).toString("hex").toUpperCase()}`;
  db.prepare(
    "INSERT INTO purchased_vouchers(user_id, order_id, offer_id, code, discount_percent) VALUES (?, ?, ?, ?, ?)"
  ).run(ownerId, Number(order.lastInsertRowid), Number(offer.lastInsertRowid), code, 15);

  const ownerJar = await loginAs("voucher-owner@example.com");
  const ownerAttempt = await jsonFetch(baseUrl, "/api/coupons/validate", {
    method: "POST",
    headers: ownerJar.header(),
    body: JSON.stringify({ code })
  });
  assert.equal(ownerAttempt.status, 200);
  assert.equal(ownerAttempt.body.discount, 15);
  assert.equal(ownerAttempt.body.kind, "voucher");

  const strangerJar = await loginAs("stranger@example.com");
  const strangerAttempt = await jsonFetch(baseUrl, "/api/coupons/validate", {
    method: "POST",
    headers: strangerJar.header(),
    body: JSON.stringify({ code })
  });
  assert.equal(strangerAttempt.status, 400);

  const anonAttempt = await jsonFetch(baseUrl, "/api/coupons/validate", {
    method: "POST",
    body: JSON.stringify({ code })
  });
  assert.equal(anonAttempt.status, 400);
});

test("checkout applies the coupon discount to the actual order total (regression test for the cart-discount bug)", async () => {
  // Stripe isn't configured in tests, so checkout() would 503 before reaching the
  // discount math. Enable it with a fake key and stub the one outbound call it makes,
  // which lets this test exercise the server's REAL discount/total calculation end to end.
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (String(url).startsWith("https://api.stripe.com/v1/checkout/sessions")) {
      return new Response(JSON.stringify({ id: "cs_test_fake", url: "https://checkout.stripe.test/fake" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
    return originalFetch(url, options);
  };

  try {
    const buyerEmail = "checkout-buyer@example.com";
    seedVerifiedUser(buyerEmail);
    const buyerJar = await loginAs(buyerEmail);

    // Checkout refuses to sell a product with no digital file attached, so seed one directly.
    const storedFileName = `${crypto.randomBytes(8).toString("hex")}.zip`;
    fs.writeFileSync(path.join(dataDir, "files", storedFileName), "pretend zip contents");
    const productId = Number(db.prepare(
      "INSERT INTO products(name, price_cents, file_name, file_path) VALUES (?, ?, ?, ?)"
    ).run("Discounted Product", 2000, "mod.zip", storedFileName).lastInsertRowid);

    const checkout = await jsonFetch(baseUrl, "/api/checkout", {
      method: "POST",
      headers: buyerJar.header(),
      body: JSON.stringify({ productIds: [productId], coupon: "SAVE20" })
    });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.url, "https://checkout.stripe.test/fake");

    const order = db.prepare("SELECT * FROM orders WHERE stripe_session_id = ?").get("cs_test_fake");
    assert.ok(order, "an order row should exist for the fake Stripe session");
    // $20.00 at 20% off must be $16.00 (1600 cents), never the undiscounted $20.00.
    assert.equal(order.total_cents, 1600);
  } finally {
    global.fetch = originalFetch;
    delete process.env.STRIPE_SECRET_KEY;
  }
});

// Runs last: it deliberately exhausts the IP's rate-limit budget for this route,
// which would make any later test in this file see spurious 429s.
test("coupon validation is rate-limited", async () => {
  let lastStatus;
  for (let i = 0; i < 21; i += 1) {
    const { status } = await jsonFetch(baseUrl, "/api/coupons/validate", {
      method: "POST",
      body: JSON.stringify({ code: `GUESS-${i}` })
    });
    lastStatus = status;
  }
  assert.equal(lastStatus, 429);
});
