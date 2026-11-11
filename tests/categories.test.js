const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, cookieJar, jsonFetch } = require("./helpers");

// A valid 1x1 transparent PNG, used to exercise the real upload/validation path.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

let baseUrl, server, jar;

before(async () => {
  ({ baseUrl, server } = await startTestServer());
  jar = cookieJar();
  const login = await jsonFetch(baseUrl, "/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ passcode: "test-admin-passcode" })
  });
  jar.capture(login.response);
});

after(() => server.close());

test("admin can create a category with artwork, and it appears in the public store", async () => {
  const create = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Call of Duty", game: "COD", imageData: TINY_PNG, imageName: "cod.png" })
  });
  assert.equal(create.status, 201);
  assert.ok(create.body.id);

  const store = await jsonFetch(baseUrl, "/api/store");
  const category = store.body.categories.find(c => c.id === create.body.id);
  assert.ok(category, "new category should be visible in /api/store");
  assert.match(category.imageUrl, /^\/uploads\//);
});

test("rejects a category with no name", async () => {
  const { status, body } = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "", game: "Nothing" })
  });
  assert.equal(status, 400);
  assert.match(body.error, /name/i);
});

test("rejects a duplicate category name", async () => {
  await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Duplicate Name", game: "X" })
  });
  const { status, body } = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Duplicate Name", game: "Y" })
  });
  assert.equal(status, 409);
  assert.match(body.error, /already exists/i);
});

test("admin can edit a category's name, game, and artwork", async () => {
  const create = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Editable Category", game: "Old Game" })
  });
  const id = create.body.id;

  const edit = await jsonFetch(baseUrl, `/api/admin/categories/${id}`, {
    method: "PUT",
    headers: jar.header(),
    body: JSON.stringify({ name: "Renamed Category", game: "New Game", imageData: TINY_PNG, imageName: "new.png" })
  });
  assert.equal(edit.status, 200);

  const store = await jsonFetch(baseUrl, "/api/store");
  const category = store.body.categories.find(c => c.id === id);
  assert.equal(category.name, "Renamed Category");
  assert.equal(category.game, "New Game");
  assert.match(category.imageUrl, /^\/uploads\//);
});

test("editing a category with no name is rejected and the record is unchanged", async () => {
  const create = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Untouched Category", game: "G" })
  });
  const id = create.body.id;
  const edit = await jsonFetch(baseUrl, `/api/admin/categories/${id}`, {
    method: "PUT",
    headers: jar.header(),
    body: JSON.stringify({ name: "", game: "G2" })
  });
  assert.equal(edit.status, 400);

  const store = await jsonFetch(baseUrl, "/api/store");
  const category = store.body.categories.find(c => c.id === id);
  assert.equal(category.name, "Untouched Category");
});

test("deleting a category removes it and un-categorizes its products instead of failing", async () => {
  const category = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Deletable Category", game: "G" })
  });
  const categoryId = category.body.id;

  const product = await jsonFetch(baseUrl, "/api/admin/products", {
    method: "POST",
    headers: jar.header(),
    body: JSON.stringify({ name: "Orphan Product", price: 5, categoryId })
  });
  assert.equal(product.status, 201);

  const del = await jsonFetch(baseUrl, `/api/admin/categories/${categoryId}`, {
    method: "DELETE",
    headers: jar.header()
  });
  assert.equal(del.status, 200);

  const overview = await jsonFetch(baseUrl, "/api/admin/overview", { headers: jar.header() });
  const refreshedProduct = overview.body.products.find(p => p.id === product.body.id);
  assert.equal(refreshedProduct.category_id, null);
  assert.ok(!overview.body.categories.some(c => c.id === categoryId));
});

test("category endpoints require an admin session", async () => {
  const create = await jsonFetch(baseUrl, "/api/admin/categories", {
    method: "POST",
    body: JSON.stringify({ name: "Nope", game: "Nope" })
  });
  assert.equal(create.status, 403);
});
