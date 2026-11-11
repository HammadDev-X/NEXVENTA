const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, cookieJar, jsonFetch } = require("./helpers");

let baseUrl, server;

before(async () => {
  ({ baseUrl, server } = await startTestServer());
});

after(() => server.close());

test("GET /api/store returns the seeded catalog, unauthenticated", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/store");
  assert.equal(status, 200);
  assert.equal(body.products.length, 4);
  assert.equal(body.categories.length, 3);
  assert.equal(body.stripeEnabled, false);
  for (const category of body.categories) assert.equal(typeof category.imageUrl, "string");
});

test("GET /api/me with no session reports signed out", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/me");
  assert.equal(status, 200);
  assert.equal(body.user, null);
  assert.equal(body.admin, false);
});

test("admin login rejects a wrong passcode and never sets a session cookie", async () => {
  const { status, body, response } = await jsonFetch(baseUrl, "/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ passcode: "definitely-wrong" })
  });
  assert.equal(status, 401);
  assert.match(body.error, /incorrect/i);
  assert.equal(response.headers.get("set-cookie"), null);
});

test("admin login accepts the correct passcode and grants access to admin routes", async () => {
  const jar = cookieJar();
  const login = await jsonFetch(baseUrl, "/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ passcode: "test-admin-passcode" })
  });
  assert.equal(login.status, 200);
  jar.capture(login.response);

  const me = await jsonFetch(baseUrl, "/api/me", { headers: jar.header() });
  assert.equal(me.body.admin, true);

  const overview = await jsonFetch(baseUrl, "/api/admin/overview", { headers: jar.header() });
  assert.equal(overview.status, 200);
  assert.ok(Array.isArray(overview.body.products));
});

test("admin routes reject requests with no session", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/admin/overview");
  assert.equal(status, 403);
  assert.match(body.error, /admin access/i);
});

test("user-only routes reject requests with no session", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/orders");
  assert.equal(status, 401);
  assert.match(body.error, /sign in/i);
});

test("registration is rejected with a short password", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ada", email: "ada@example.com", password: "short" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /password/i);
});

test("registration fails clearly when SMTP is not configured, without creating a user", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/register", {
    method: "POST",
    body: JSON.stringify({ name: "Ada Lovelace", email: "ada@example.com", password: "a-strong-password" })
  });
  assert.equal(status, 503);
  assert.match(body.error, /email verification is not configured/i);

  const login = await jsonFetch(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email: "ada@example.com", password: "a-strong-password" })
  });
  assert.equal(login.status, 401);
});

test("login with a nonexistent email is rejected the same way as a wrong password", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/login", {
    method: "POST",
    body: JSON.stringify({ email: "nobody@example.com", password: "whatever-password" })
  });
  assert.equal(status, 401);
  assert.match(body.error, /incorrect/i);
});

test("login is rate-limited per IP after repeated failures", async () => {
  let lastStatus;
  for (let i = 0; i < 11; i += 1) {
    const { status } = await jsonFetch(baseUrl, "/api/login", {
      method: "POST",
      body: JSON.stringify({ email: `flood-${i}@example.com`, password: "whatever-password" })
    });
    lastStatus = status;
  }
  assert.equal(lastStatus, 429);
});

test("admin login is rate-limited after repeated failures", async () => {
  let lastStatus;
  for (let i = 0; i < 6; i += 1) {
    const { status } = await jsonFetch(baseUrl, "/api/admin/login", {
      method: "POST",
      body: JSON.stringify({ passcode: `wrong-${i}` })
    });
    lastStatus = status;
  }
  assert.equal(lastStatus, 429);
});
