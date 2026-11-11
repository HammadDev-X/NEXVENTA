const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { startTestServer, cookieJar, jsonFetch } = require("./helpers");

let baseUrl, server, dataDir, db, buyerJar, orderId;

before(async () => {
  ({ baseUrl, server, dataDir } = await startTestServer());
  db = new DatabaseSync(path.join(dataDir, "shop.sqlite"));

  const salt = crypto.randomBytes(16).toString("hex");
  const passwordHash = crypto.scryptSync("TestPassword123", salt, 64).toString("hex");
  const user = db.prepare(
    "INSERT INTO users(name, email, password_hash, password_salt, email_verified) VALUES (?, ?, ?, ?, 1)"
  ).run("Download Buyer", "download-buyer@example.com", passwordHash, salt);
  const userId = Number(user.lastInsertRowid);

  const storedFileName = `${crypto.randomBytes(8).toString("hex")}.zip`;
  fs.writeFileSync(path.join(dataDir, "files", storedFileName), "pretend zip contents");
  const product = db.prepare(
    "INSERT INTO products(name, price_cents, file_name, file_path) VALUES (?, ?, ?, ?)"
  ).run("Downloadable Product", 999, "mod.zip", storedFileName);
  const productId = Number(product.lastInsertRowid);

  const order = db.prepare("INSERT INTO orders(user_id, total_cents, status) VALUES (?, 999, 'paid')").run(userId);
  orderId = Number(order.lastInsertRowid);
  db.prepare("INSERT INTO order_items(order_id, product_id, name, price_cents) VALUES (?, ?, ?, 999)").run(orderId, productId, "Downloadable Product");

  buyerJar = cookieJar();
  const login = await jsonFetch(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email: "download-buyer@example.com", password: "TestPassword123" })
  });
  buyerJar.capture(login.response);
});

after(() => {
  db.close();
  server.close();
});

test("a signed-in buyer can request a one-time download link for their paid order", async () => {
  const { status, body } = await jsonFetch(baseUrl, `/api/orders/${orderId}/downloads`, {
    method: "POST",
    headers: buyerJar.header(),
    body: "{}"
  });
  assert.equal(status, 200);
  assert.equal(body.downloads.length, 1);
  assert.match(body.downloads[0].url, /^\/download\//);

  const download = await fetch(`${baseUrl}${body.downloads[0].url}`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "pretend zip contents");
  assert.match(download.headers.get("content-disposition") || "", /attachment/);

  const secondAttempt = await fetch(`${baseUrl}${body.downloads[0].url}`);
  assert.equal(secondAttempt.status, 410, "a used download token must not work twice");
});

test("someone else's order cannot be used to mint a download link", async () => {
  const { status } = await jsonFetch(baseUrl, `/api/orders/${orderId}/downloads`, {
    method: "POST",
    body: "{}"
  });
  assert.equal(status, 401);
});

test("a malformed download token is rejected before touching the database", async () => {
  const response = await fetch(`${baseUrl}/download/not-a-real-token`);
  assert.equal(response.status, 400);
});

test("a well-formed but unknown download token returns 410, not 500", async () => {
  const fakeToken = crypto.randomBytes(32).toString("base64url");
  const response = await fetch(`${baseUrl}/download/${fakeToken}`);
  assert.equal(response.status, 410);
});
