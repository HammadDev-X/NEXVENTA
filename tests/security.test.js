const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { startTestServer, cookieJar, jsonFetch } = require("./helpers");

let baseUrl, server, dataDir, db;

before(async () => {
  ({ baseUrl, server, dataDir } = await startTestServer());
  db = new DatabaseSync(path.join(dataDir, "shop.sqlite"));
});

after(() => {
  db.close();
  server.close();
});

async function seedAndLoginUser(email) {
  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync("TestPassword123", salt, 64).toString("hex");
  db.prepare(
    "INSERT INTO users(name, email, password_hash, password_salt, email_verified) VALUES (?, ?, ?, ?, 1)"
  ).run("Security Tester", email, passwordHash, salt);
  const jar = cookieJar();
  const login = await jsonFetch(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email, password: "TestPassword123" })
  });
  jar.capture(login.response);
  return jar;
}

test("every response carries the baseline security headers", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.ok(response.headers.get("content-security-policy"));
  assert.match(response.headers.get("content-security-policy"), /default-src 'self'/);
  assert.ok(response.headers.get("permissions-policy"));
  assert.ok(response.headers.get("referrer-policy"));
});

test("a path-traversal attempt on static pages cannot escape the public directory", async () => {
  const response = await fetch(`${baseUrl}/../server.js`);
  assert.notEqual(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes("DatabaseSync"), "server source must never be served");
});

test("a path-traversal attempt on /uploads/ is defanged to a plain filename lookup", async () => {
  const response = await fetch(`${baseUrl}/uploads/..%2f..%2fserver.js`);
  assert.equal(response.status, 404);
});

test("a path-traversal attempt on a download token is rejected by format before DB lookup", async () => {
  const response = await fetch(`${baseUrl}/download/..%2f..%2fserver.js`);
  assert.equal(response.status, 400);
});

test("SQL-injection-style input in login fields is treated as plain data, not SQL", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email: "' OR '1'='1", password: "' OR '1'='1" })
  });
  assert.equal(status, 401);
  assert.match(body.error, /incorrect/i);
});

test("a review's text round-trips exactly as submitted (escaping is the renderer's job, not storage's)", async () => {
  const jar = await seedAndLoginUser("reviewer@example.com");
  const payload = "<script>alert(1)</script>";
  const post = await jsonFetch(baseUrl, "/api/reviews", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ rating: 5, message: payload })
  });
  assert.equal(post.status, 201);

  const { body } = await jsonFetch(baseUrl, "/api/reviews");
  const stored = body.reviews.find(r => r.id === post.body.id);
  assert.equal(stored.message, payload, "the server must not mangle or half-escape stored text");
});

test("review posting is rate-limited per account", async () => {
  const jar = await seedAndLoginUser("reviewer-flood@example.com");
  let lastStatus;
  for (let i = 0; i < 6; i += 1) {
    const { status } = await jsonFetch(baseUrl, "/api/reviews", {
      method: "POST",
      headers: jar.header(),
      body: JSON.stringify({ rating: 4, message: `review number ${i}` })
    });
    lastStatus = status;
  }
  assert.equal(lastStatus, 429);
});

test("unauthenticated admin-only write routes are rejected, not merely hidden", async () => {
  const attempts = [
    ["/api/admin/products", "POST", { name: "x", price: 1 }],
    ["/api/admin/categories", "POST", { name: "x" }],
    ["/api/admin/coupons", "POST", { code: "X", discount: 10 }]
  ];
  for (const [route, method, body] of attempts) {
    const { status } = await jsonFetch(baseUrl, route, { method, body: JSON.stringify(body) });
    assert.equal(status, 403, `${method} ${route} must require an admin session`);
  }
});

test("the Stripe webhook rejects a forged signature", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = "whsec_test_fake";
  try {
    const response = await fetch(`${baseUrl}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "stripe-signature": "t=1,v1=deadbeef", "Content-Type": "application/json" },
      body: JSON.stringify({ type: "checkout.session.completed", data: { object: {} } })
    });
    assert.equal(response.status, 400);
  } finally {
    delete process.env.STRIPE_WEBHOOK_SECRET;
  }
});

test("oversized request bodies are rejected instead of exhausting memory", async () => {
  const response = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "x@example.com", password: "x".repeat(21 * 1024 * 1024) })
  }).catch(() => null);
  // The streaming size check may abort the connection before a clean response is
  // written; either way, the server process must still be alive afterwards.
  const stillAlive = await fetch(`${baseUrl}/api/me`);
  assert.equal(stillAlive.status, 200);
  if (response) assert.notEqual(response.status, 200);
});
