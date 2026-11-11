const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const nodemailer = require("nodemailer");

const ROOT = __dirname;
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const contents = fs.readFileSync(filePath, "utf8");
  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) throw new Error(`Invalid .env entry on line ${index + 1}.`);
    const [, name] = match;
    let value = match[2].trim();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const end = value.lastIndexOf(quote);
      if (end === 0 || (end !== value.length - 1 && !value.slice(end + 1).trimStart().startsWith("#"))) {
        throw new Error(`Invalid quoted .env value on line ${index + 1}.`);
      }
      value = value.slice(1, end);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    if (process.env[name] === undefined) process.env[name] = value;
  }
}
loadEnvFile(path.join(ROOT, ".env"));
const PUBLIC = path.join(ROOT, "public");
const DATA = path.join(ROOT, "data");
const FILES = path.join(DATA, "files");
const IMAGES = path.join(DATA, "images");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const BASE_URL = (process.env.BASE_URL || `http://${HOST}:${PORT}`).replace(/\/$/, "");
const MAX_BODY = 16 * 1024 * 1024;
const authAttempts = new Map();
fs.mkdirSync(FILES, { recursive: true });
fs.mkdirSync(IMAGES, { recursive: true });

const db = new DatabaseSync(path.join(DATA, "shop.sqlite"));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS email_verifications (
    email TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    code_salt TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_sent_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    is_admin INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    game TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    game TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    image TEXT NOT NULL DEFAULT '',
    file_name TEXT NOT NULL DEFAULT '',
    file_path TEXT NOT NULL DEFAULT '',
    featured INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS coupons (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    discount_percent INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS coupon_offers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    discount_percent INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_voucher_items (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    offer_id INTEGER NOT NULL REFERENCES coupon_offers(id),
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    discount_percent INTEGER NOT NULL,
    PRIMARY KEY (order_id, offer_id)
  );
  CREATE TABLE IF NOT EXISTS purchased_vouchers (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    offer_id INTEGER NOT NULL REFERENCES coupon_offers(id),
    code TEXT NOT NULL UNIQUE,
    discount_percent INTEGER NOT NULL,
    used_at TEXT,
    reserved_order_id INTEGER REFERENCES orders(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS support_tickets (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    subject TEXT NOT NULL,
    message TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    total_cents INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'pending',
    stripe_session_id TEXT,
    payment_intent TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS order_items (
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    PRIMARY KEY (order_id, product_id)
  );
  CREATE TABLE IF NOT EXISTS downloads (
    token_hash TEXT PRIMARY KEY,
    order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
`);
if (!db.prepare("PRAGMA table_info(users)").all().some(column => column.name === "email_verified")) {
  db.exec("ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1");
}
if (!db.prepare("PRAGMA table_info(products)").all().some(column => column.name === "active")) {
  db.exec("ALTER TABLE products ADD COLUMN active INTEGER NOT NULL DEFAULT 1");
}

if (db.prepare("SELECT COUNT(*) AS count FROM categories").get().count === 0) {
  const addCategory = db.prepare("INSERT INTO categories(name, slug, game) VALUES (?, ?, ?)");
  addCategory.run("FiveM", "fivem", "GTA V");
  addCategory.run("Minecraft", "minecraft", "Minecraft");
  addCategory.run("Gaming", "gaming", "Multi-game");
  const fiveM = db.prepare("SELECT id FROM categories WHERE slug = 'fivem'").get().id;
  const minecraft = db.prepare("SELECT id FROM categories WHERE slug = 'minecraft'").get().id;
  const insertProduct = db.prepare(
    "INSERT INTO products(name, description, category_id, game, price_cents, featured) VALUES (?, ?, ?, ?, ?, ?)"
  );
  insertProduct.run("Nightfall Loading Screen", "A polished, animated loading experience for your FiveM server.", fiveM, "FiveM", 1299, 1);
  insertProduct.run("Midnight HUD Pack", "A clean, customizable HUD built for immersive roleplay.", fiveM, "FiveM", 1899, 1);
  insertProduct.run("Obsidian UI Kit", "A collection of dark-mode interface assets for your next project.", fiveM, "FiveM", 999, 0);
  insertProduct.run("Arcane Resource Pack", "A premium visual upgrade for your Minecraft world.", minecraft, "Minecraft", 1499, 1);
}

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip"
};

function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(Object.assign(new Error("Request is too large."), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error("Invalid JSON request."), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function setSessionCookie(res, token) {
  const secure = BASE_URL.startsWith("https://") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `nexventa_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "nexventa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function auth(req) {
  const token = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("nexventa_session="))?.slice(17);
  if (!token) return null;
  const session = db.prepare(`
    SELECT s.user_id, s.is_admin, u.name, u.email
    FROM sessions s LEFT JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > datetime('now')
  `).get(hash(token));
  return session || null;
}

function requireUser(req, res) {
  const user = auth(req);
  if (!user || !user.user_id) {
    send(res, 401, { error: "Please sign in to continue." });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = auth(req);
  if (!user?.is_admin) {
    send(res, 403, { error: "Admin access is required." });
    return null;
  }
  return user;
}

function createSession(res, userId, isAdmin = false) {
  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions(token_hash, user_id, is_admin, expires_at) VALUES (?, ?, ?, datetime('now', '+7 days'))")
    .run(hash(token), userId, isAdmin ? 1 : 0);
  setSessionCookie(res, token);
}

function publicProduct(product) {
  return {
    id: product.id,
    name: product.name,
    description: product.description,
    category_id: product.category_id,
    game: product.game,
    price_cents: product.price_cents,
    image: product.image,
    file_name: product.file_name || "",
    featured: product.featured,
    active: product.active !== 0,
    category: product.category,
    price: product.price_cents / 100,
    imageUrl: product.image ? `/uploads/${encodeURIComponent(product.image)}` : ""
  };
}

function cleanText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function digitalFilePath(storedName) {
  const filename = path.basename(String(storedName || ""));
  return filename ? path.join(FILES, filename) : "";
}

function allowAuthAttempt(key, limit, windowMs) {
  const now = Date.now();
  let entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + windowMs };
  if (entry.count >= limit) {
    authAttempts.set(key, entry);
    return false;
  }
  entry.count += 1;
  authAttempts.set(key, entry);
  if (authAttempts.size > 10000) {
    for (const [attemptKey, attempt] of authAttempts) {
      if (attempt.resetAt <= now) authAttempts.delete(attemptKey);
    }
  }
  return true;
}

function emailTransport() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_APP_PASSWORD;
  if (!user || !pass || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw Object.assign(new Error("Email verification is not configured. Set SMTP_USER and SMTP_APP_PASSWORD in .env, then restart the server."), { status: 503 });
  }
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass }
  });
}

async function sendVerificationCode(email, code) {
  const transporter = emailTransport();
  await transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: email,
    subject: "Your Nexventa verification code",
    text: `Your Nexventa verification code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
    html: `<p>Your Nexventa verification code is <strong>${code}</strong>.</p><p>It expires in 10 minutes. If you did not request this, you can ignore this email.</p>`
  });
}

function verificationHash(code, salt) {
  return crypto.scryptSync(code, salt, 32).toString("hex");
}

async function startEmailVerification({ email, name, passwordHash, passwordSalt }) {
  const existing = db.prepare("SELECT * FROM email_verifications WHERE email = ?").get(email);
  if (existing && Date.now() - Date.parse(`${existing.last_sent_at}Z`) < 60_000) {
    throw Object.assign(new Error("A verification code was just sent. Please wait one minute before requesting another."), { status: 429 });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  const codeSalt = crypto.randomBytes(16).toString("hex");
  const codeHash = verificationHash(code, codeSalt);
  db.prepare(`
    INSERT INTO email_verifications(email, name, password_hash, password_salt, code_hash, code_salt, expires_at, last_sent_at, attempts)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+10 minutes'), datetime('now'), 0)
    ON CONFLICT(email) DO UPDATE SET
      name=excluded.name, password_hash=excluded.password_hash, password_salt=excluded.password_salt,
      code_hash=excluded.code_hash, code_salt=excluded.code_salt, expires_at=excluded.expires_at,
      last_sent_at=excluded.last_sent_at, attempts=0
  `).run(email, name, passwordHash, passwordSalt, codeHash, codeSalt);

  try {
    await sendVerificationCode(email, code);
  } catch (error) {
    if (existing) {
      db.prepare(`
        UPDATE email_verifications SET name=?, password_hash=?, password_salt=?, code_hash=?,
          code_salt=?, expires_at=?, last_sent_at=?, attempts=? WHERE email=?
      `).run(existing.name, existing.password_hash, existing.password_salt, existing.code_hash,
        existing.code_salt, existing.expires_at, existing.last_sent_at, existing.attempts, email);
    } else {
      db.prepare("DELETE FROM email_verifications WHERE email = ?").run(email);
    }
    console.error(`[${new Date().toISOString()}] Verification email delivery failed:`, error);
    if (error.status) throw error;
    throw Object.assign(new Error("We couldn't send the verification email. Check the Gmail SMTP settings in .env and try again."), { status: 502 });
  }
}

async function stripeRequest(endpoint, params) {
  if (!process.env.STRIPE_SECRET_KEY) throw Object.assign(new Error("Stripe checkout is not configured yet."), { status: 503 });
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  const response = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message || "Payment provider request failed."), { status: 502 });
  return result;
}

async function route(req, res) {
  const url = new URL(req.url, BASE_URL);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method;

  if (method === "GET" && pathname === "/api/store") {
    const products = db.prepare(`
      SELECT p.*, c.name AS category FROM products p
      LEFT JOIN categories c ON c.id = p.category_id WHERE p.active=1 ORDER BY p.featured DESC, p.id DESC
    `).all().map(publicProduct);
    return send(res, 200, { products, categories: db.prepare("SELECT * FROM categories ORDER BY name").all(), stripeEnabled: Boolean(process.env.STRIPE_SECRET_KEY) });
  }

  if (method === "GET" && pathname === "/api/coupon-offers") {
    const offers = db.prepare("SELECT id, name, description, price_cents, discount_percent FROM coupon_offers WHERE active=1 ORDER BY price_cents").all();
    const user = auth(req);
    const vouchers = user?.user_id
      ? db.prepare("SELECT id, code, discount_percent, used_at, created_at FROM purchased_vouchers WHERE user_id=? ORDER BY id DESC").all(user.user_id)
      : [];
    return send(res, 200, { offers, vouchers });
  }

  if (method === "GET" && pathname === "/api/reviews") {
    return send(res, 200, {
      reviews: db.prepare(`
        SELECT r.id, r.rating, r.message, r.created_at, u.name AS customer_name
        FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 100
      `).all(),
      average: db.prepare("SELECT COALESCE(AVG(rating), 0) AS average FROM reviews").get().average,
      count: db.prepare("SELECT COUNT(*) AS count FROM reviews").get().count,
      canReview: Boolean(auth(req)?.user_id)
    });
  }

  if (method === "POST" && pathname === "/api/reviews") {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const rating = Number(body.rating);
    const message = cleanText(body.message, 1000);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || message.length < 5) {
      return send(res, 400, { error: "Choose a 1–5 star rating and write at least 5 characters." });
    }
    const result = db.prepare("INSERT INTO reviews(user_id, rating, message) VALUES (?, ?, ?)").run(user.user_id, rating, message);
    return send(res, 201, { id: Number(result.lastInsertRowid) });
  }

  if (method === "GET" && pathname === "/api/me") {
    const user = auth(req);
    return send(res, 200, { user: user?.user_id ? { name: user.name, email: user.email } : null, admin: Boolean(user?.is_admin) });
  }

  if (method === "POST" && pathname === "/api/register") {
    if (!allowAuthAttempt(`register:${req.socket.remoteAddress}`, 8, 15 * 60 * 1000)) return send(res, 429, { error: "Too many account attempts. Please try again later." });
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const email = cleanText(body.email, 254).toLowerCase();
    const password = String(body.password || "");
    if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10) {
      return send(res, 400, { error: "Enter your name, a valid email, and a password of at least 10 characters." });
    }
    if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
      return send(res, 409, { error: "An account with that email already exists." });
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    try {
      await startEmailVerification({ email, name, passwordHash, passwordSalt: salt });
      return send(res, 202, { ok: true, verificationRequired: true });
    } catch (error) {
      if (error.status) return send(res, error.status, { error: error.message });
      throw error;
    }
  }

  if (method === "POST" && pathname === "/api/resend-verification") {
    if (!allowAuthAttempt(`resend-verification:${req.socket.remoteAddress}`, 5, 15 * 60 * 1000)) {
      return send(res, 429, { error: "Too many verification requests. Please try again later." });
    }
    const body = await readBody(req);
    const email = cleanText(body.email, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: "Enter a valid email address." });
    const pending = db.prepare("SELECT name, password_hash, password_salt FROM email_verifications WHERE email = ?").get(email);
    if (!pending) return send(res, 404, { error: "No pending verification was found. Please start registration again." });
    try {
      await startEmailVerification({ email, ...pending });
      return send(res, 200, { ok: true });
    } catch (error) {
      if (error.status) return send(res, error.status, { error: error.message });
      throw error;
    }
  }

  if (method === "POST" && pathname === "/api/verify-email") {
    if (!allowAuthAttempt(`verify-email:${req.socket.remoteAddress}`, 15, 15 * 60 * 1000)) {
      return send(res, 429, { error: "Too many verification attempts. Please try again later." });
    }
    const body = await readBody(req);
    const email = cleanText(body.email, 254).toLowerCase();
    const code = String(body.code || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code)) {
      return send(res, 400, { error: "Enter the email address and six-digit code from your verification email." });
    }
    const pending = db.prepare("SELECT * FROM email_verifications WHERE email = ?").get(email);
    if (!pending) return send(res, 400, { error: "That verification code is invalid or expired. Please register again." });
    if (Date.parse(`${pending.expires_at}Z`) <= Date.now()) {
      db.prepare("DELETE FROM email_verifications WHERE email = ?").run(email);
      return send(res, 400, { error: "That verification code has expired. Please register again." });
    }
    const candidate = Buffer.from(verificationHash(code, pending.code_salt), "hex");
    const expected = Buffer.from(pending.code_hash, "hex");
    if (!crypto.timingSafeEqual(candidate, expected)) {
      const attempts = pending.attempts + 1;
      if (attempts >= 5) db.prepare("DELETE FROM email_verifications WHERE email = ?").run(email);
      else db.prepare("UPDATE email_verifications SET attempts = ? WHERE email = ?").run(attempts, email);
      return send(res, 400, { error: attempts >= 5 ? "Too many incorrect codes. Please register again." : "That verification code is incorrect." });
    }

    db.exec("BEGIN IMMEDIATE");
    let userId;
    try {
      const result = db.prepare("INSERT INTO users(name, email, password_hash, password_salt, email_verified) VALUES (?, ?, ?, ?, 1)")
        .run(pending.name, email, pending.password_hash, pending.password_salt);
      userId = Number(result.lastInsertRowid);
      db.prepare("DELETE FROM email_verifications WHERE email = ?").run(email);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      if (String(error.message).includes("UNIQUE")) {
        db.prepare("DELETE FROM email_verifications WHERE email = ?").run(email);
        return send(res, 409, { error: "An account with that email already exists." });
      }
      throw error;
    }
    createSession(res, userId);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/login") {
    if (!allowAuthAttempt(`login:${req.socket.remoteAddress}`, 10, 15 * 60 * 1000)) return send(res, 429, { error: "Too many sign-in attempts. Please try again later." });
    const body = await readBody(req);
    const email = cleanText(body.email, 254).toLowerCase();
    const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
    const candidate = user ? crypto.scryptSync(String(body.password || ""), user.password_salt, 64).toString("hex") : "";
    if (!user || user.email_verified !== 1 || !crypto.timingSafeEqual(Buffer.from(candidate || "0".repeat(128)), Buffer.from(user.password_hash))) {
      return send(res, 401, { error: "Email or password is incorrect." });
    }
    createSession(res, user.id);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/admin/login") {
    if (!allowAuthAttempt(`admin:${req.socket.remoteAddress}`, 5, 15 * 60 * 1000)) return send(res, 429, { error: "Too many admin passcode attempts. Please try again later." });
    const body = await readBody(req);
    if (!process.env.ADMIN_PASSCODE) return send(res, 503, { error: "Set ADMIN_PASSCODE in your environment to enable admin mode." });
    const supplied = Buffer.from(String(body.passcode || ""));
    const configured = Buffer.from(process.env.ADMIN_PASSCODE);
    if (supplied.length !== configured.length || !crypto.timingSafeEqual(supplied, configured)) {
      return send(res, 401, { error: "That admin passcode is incorrect." });
    }
    createSession(res, null, true);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/logout") {
    const token = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("nexventa_session="))?.slice(17);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/admin/products") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const name = cleanText(body.name, 120);
    const price = Number(body.price);
    if (!name || !Number.isFinite(price) || price < 0.5 || price > 100000) return send(res, 400, { error: "Enter a product name and a price of at least $0.50." });
    const fileName = cleanText(body.fileName, 120);
    const fileData = String(body.fileData || "");
    let storedFile = "";
    let image = cleanText(body.image, 200);
    if (fileData) storedFile = saveUpload(fileData, fileName, 10 * 1024 * 1024, "digital");
    if (body.imageData) image = saveUpload(String(body.imageData), cleanText(body.imageName, 120), 2 * 1024 * 1024, "image");
    const result = db.prepare(`
      INSERT INTO products(name, description, category_id, game, price_cents, image, file_name, file_path, featured)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, cleanText(body.description, 1000), body.categoryId ? Number(body.categoryId) : null,
      cleanText(body.game, 80), Math.round(price * 100), image, storedFile ? fileName : "", storedFile, body.featured ? 1 : 0);
    return send(res, 201, { id: Number(result.lastInsertRowid) });
  }

  const productMatch = pathname.match(/^\/api\/admin\/products\/(\d+)$/);
  if (method === "PUT" && productMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const id = Number(productMatch[1]);
    const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
    if (!existing) return send(res, 404, { error: "Product not found." });
    const price = Number(body.price);
    if (!cleanText(body.name, 120) || !Number.isFinite(price) || price < 0.5 || price > 100000) return send(res, 400, { error: "Enter a product name and a price of at least $0.50." });
    const fileName = cleanText(body.fileName, 120);
    const filePath = body.fileData ? saveUpload(String(body.fileData), fileName, 10 * 1024 * 1024, "digital") : existing.file_path;
    const image = body.imageData
      ? saveUpload(String(body.imageData), cleanText(body.imageName, 120), 2 * 1024 * 1024, "image")
      : (typeof body.image === "string" ? cleanText(body.image, 200) : existing.image);
    db.prepare(`
      UPDATE products SET name=?, description=?, category_id=?, game=?, price_cents=?, image=?, file_name=?, file_path=?, featured=?
      WHERE id=?
    `).run(cleanText(body.name, 120), cleanText(body.description, 1000), body.categoryId ? Number(body.categoryId) : null,
      cleanText(body.game, 80), Math.round(price * 100), image, body.fileData ? fileName : existing.file_name, filePath, body.featured ? 1 : 0, id);
    return send(res, 200, { ok: true });
  }

  if (method === "DELETE" && productMatch) {
    if (!requireAdmin(req, res)) return;
    const id = Number(productMatch[1]);
    const item = db.prepare("SELECT file_path, image FROM products WHERE id = ?").get(id);
    if (!item) return send(res, 404, { error: "Product not found." });
    const hasOrders = db.prepare("SELECT 1 FROM order_items WHERE product_id=? LIMIT 1").get(id);
    if (hasOrders) {
      db.prepare("UPDATE products SET active=0 WHERE id = ?").run(id);
      return send(res, 200, { ok: true, archived: true });
    }
    db.prepare("DELETE FROM products WHERE id=?").run(id);
    const oldFile = digitalFilePath(item.file_path);
    if (oldFile && fs.existsSync(oldFile)) fs.unlinkSync(oldFile);
    if (item.image && path.basename(item.image) === item.image) {
      const oldImage = path.join(IMAGES, item.image);
      const otherUse = db.prepare("SELECT 1 FROM products WHERE image=? LIMIT 1").get(item.image);
      if (!otherUse && fs.existsSync(oldImage)) fs.unlinkSync(oldImage);
    }
    return send(res, 200, { ok: true, archived: false });
  }

  const restoreProductMatch = pathname.match(/^\/api\/admin\/products\/(\d+)\/restore$/);
  if (method === "POST" && restoreProductMatch) {
    if (!requireAdmin(req, res)) return;
    const result = db.prepare("UPDATE products SET active=1 WHERE id=?").run(Number(restoreProductMatch[1]));
    if (!result.changes) return send(res, 404, { error: "Product not found." });
    return send(res, 200, { ok: true });
  }

  const unlistProductMatch = pathname.match(/^\/api\/admin\/products\/(\d+)\/unlist$/);
  if (method === "POST" && unlistProductMatch) {
    if (!requireAdmin(req, res)) return;
    const result = db.prepare("UPDATE products SET active=0 WHERE id=?").run(Number(unlistProductMatch[1]));
    if (!result.changes) return send(res, 404, { error: "Product not found." });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/admin/categories") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const game = cleanText(body.game, 80);
    if (!name) return send(res, 400, { error: "A category name is required." });
    const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${crypto.randomBytes(3).toString("hex")}`;
    try {
      const result = db.prepare("INSERT INTO categories(name, slug, game) VALUES (?, ?, ?)").run(name, slug, game);
      return send(res, 201, { id: Number(result.lastInsertRowid) });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return send(res, 409, { error: "That category already exists." });
      throw error;
    }
  }

  if (method === "POST" && pathname === "/api/admin/coupons") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const code = cleanText(body.code, 32).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
    const discount = Number(body.discount);
    if (!code || !Number.isInteger(discount) || discount < 1 || discount > 90) return send(res, 400, { error: "Use a code and a discount from 1% to 90%." });
    try {
      db.prepare("INSERT INTO coupons(code, discount_percent) VALUES (?, ?)").run(code, discount);
      return send(res, 201, { ok: true });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) return send(res, 409, { error: "That coupon code already exists." });
      throw error;
    }
  }

  const couponMatch = pathname.match(/^\/api\/admin\/coupons\/(\d+)$/);
  if (method === "PUT" && couponMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (typeof body.active !== "boolean") return send(res, 400, { error: "Choose whether the promo code is active." });
    const result = db.prepare("UPDATE coupons SET active=? WHERE id=?").run(body.active ? 1 : 0, Number(couponMatch[1]));
    if (!result.changes) return send(res, 404, { error: "Promo code not found." });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/admin/coupon-offers") {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const name = cleanText(body.name, 80);
    const description = cleanText(body.description, 240);
    const price = Number(body.price);
    const discount = Number(body.discount);
    if (!name || !Number.isFinite(price) || price < 0.5 || price > 100000 || !Number.isInteger(discount) || discount < 1 || discount > 90) {
      return send(res, 400, { error: "Enter a voucher name, a price of at least $0.50, and a 1–90% discount." });
    }
    const result = db.prepare("INSERT INTO coupon_offers(name, description, price_cents, discount_percent) VALUES (?, ?, ?, ?)")
      .run(name, description, Math.round(price * 100), discount);
    return send(res, 201, { id: Number(result.lastInsertRowid) });
  }

  const offerMatch = pathname.match(/^\/api\/admin\/coupon-offers\/(\d+)$/);
  if (method === "PUT" && offerMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    const id = Number(offerMatch[1]);
    if (typeof body.active === "boolean") {
      const result = db.prepare("UPDATE coupon_offers SET active=? WHERE id=?").run(body.active ? 1 : 0, id);
      if (!result.changes) return send(res, 404, { error: "Voucher not found." });
      return send(res, 200, { ok: true });
    }
    const name = cleanText(body.name, 80);
    const description = cleanText(body.description, 240);
    const price = Number(body.price);
    const discount = Number(body.discount);
    if (!name || !Number.isFinite(price) || price < 0.5 || price > 100000 || !Number.isInteger(discount) || discount < 1 || discount > 90) {
      return send(res, 400, { error: "Enter a voucher name, a price of at least $0.50, and a 1–90% discount." });
    }
    const result = db.prepare("UPDATE coupon_offers SET name=?, description=?, price_cents=?, discount_percent=?, active=1 WHERE id=?")
      .run(name, description, Math.round(price * 100), discount, id);
    if (!result.changes) return send(res, 404, { error: "Voucher not found." });
    return send(res, 200, { ok: true });
  }

  const reviewMatch = pathname.match(/^\/api\/admin\/reviews\/(\d+)$/);
  if (method === "DELETE" && reviewMatch) {
    if (!requireAdmin(req, res)) return;
    const result = db.prepare("DELETE FROM reviews WHERE id=?").run(Number(reviewMatch[1]));
    if (!result.changes) return send(res, 404, { error: "Review not found." });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/coupons/validate") {
    const body = await readBody(req);
    const code = cleanText(body.code, 32).toUpperCase();
    const coupon = db.prepare("SELECT discount_percent FROM coupons WHERE code = ? AND active = 1").get(code);
    if (coupon) return send(res, 200, { discount: coupon.discount_percent, kind: "promo" });
    const user = auth(req);
    if (user?.user_id) {
      const voucher = db.prepare("SELECT discount_percent FROM purchased_vouchers WHERE code=? AND user_id=? AND used_at IS NULL AND reserved_order_id IS NULL")
        .get(code, user.user_id);
      if (voucher) return send(res, 200, { discount: voucher.discount_percent, kind: "voucher" });
    }
    return send(res, 400, { error: "That promo code is invalid, already used, or not available to your account." });
  }

  if (method === "GET" && pathname === "/api/admin/overview") {
    if (!requireAdmin(req, res)) return;
    return send(res, 200, {
      revenue: db.prepare("SELECT COALESCE(SUM(total_cents), 0) AS cents FROM orders WHERE status = 'paid'").get().cents / 100,
      orderCount: db.prepare("SELECT COUNT(*) AS count FROM orders").get().count,
      customerCount: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
      products: db.prepare("SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.id DESC").all().map(publicProduct),
      categories: db.prepare("SELECT * FROM categories ORDER BY name").all(),
      coupons: db.prepare("SELECT * FROM coupons ORDER BY id DESC").all(),
      couponOffers: db.prepare("SELECT * FROM coupon_offers ORDER BY id DESC").all(),
      reviews: db.prepare("SELECT r.*, u.name AS customer_name, u.email FROM reviews r JOIN users u ON u.id=r.user_id ORDER BY r.id DESC LIMIT 100").all(),
      orders: db.prepare("SELECT o.*, u.name AS customer_name, u.email FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id DESC LIMIT 100").all(),
      customers: db.prepare("SELECT id, name, email, created_at FROM users ORDER BY id DESC LIMIT 100").all(),
      tickets: db.prepare("SELECT t.*, u.name AS customer_name, u.email FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 100").all(),
      stripeEnabled: Boolean(process.env.STRIPE_SECRET_KEY)
    });
  }

  const refundMatch = pathname.match(/^\/api\/admin\/orders\/(\d+)\/refund$/);
  if (method === "POST" && refundMatch) {
    if (!requireAdmin(req, res)) return;
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(Number(refundMatch[1]));
    if (!order) return send(res, 404, { error: "Order not found." });
    if (order.status !== "paid" || !order.payment_intent) return send(res, 409, { error: "This order is not eligible for a Stripe refund." });
    const refund = await stripeRequest("refunds", { payment_intent: order.payment_intent });
    if (refund.status !== "succeeded" && refund.status !== "pending") return send(res, 502, { error: "Stripe did not confirm the refund." });
    db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(order.id);
    db.prepare("UPDATE downloads SET used_at=datetime('now') WHERE order_id=? AND used_at IS NULL").run(order.id);
    db.prepare("UPDATE purchased_vouchers SET used_at=COALESCE(used_at, datetime('now')), reserved_order_id=NULL WHERE order_id=?").run(order.id);
    return send(res, 200, { ok: true });
  }

  const ticketMatch = pathname.match(/^\/api\/admin\/tickets\/(\d+)$/);
  if (method === "PUT" && ticketMatch) {
    if (!requireAdmin(req, res)) return;
    const body = await readBody(req);
    if (!["open", "in_progress", "resolved"].includes(body.status)) return send(res, 400, { error: "Choose a valid ticket status." });
    const result = db.prepare("UPDATE support_tickets SET status=? WHERE id=?").run(body.status, Number(ticketMatch[1]));
    if (!result.changes) return send(res, 404, { error: "Support ticket not found." });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && pathname === "/api/support") {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readBody(req);
    const subject = cleanText(body.subject, 120);
    const message = cleanText(body.message, 3000);
    if (subject.length < 3 || message.length < 10) return send(res, 400, { error: "Add a subject and a message of at least 10 characters." });
    const result = db.prepare("INSERT INTO support_tickets(user_id, subject, message) VALUES (?, ?, ?)").run(user.user_id, subject, message);
    return send(res, 201, { id: Number(result.lastInsertRowid) });
  }

  if (method === "GET" && pathname === "/api/admin/tickets") {
    if (!requireAdmin(req, res)) return;
    return send(res, 200, { tickets: db.prepare("SELECT t.*, u.name AS customer_name, u.email FROM support_tickets t JOIN users u ON u.id=t.user_id ORDER BY t.id DESC LIMIT 100").all() });
  }

  if (method === "POST" && pathname === "/api/checkout") {
    const user = requireUser(req, res);
    if (!user) return;
    if (!process.env.STRIPE_SECRET_KEY) return send(res, 503, { error: "Payments are not enabled yet. Add your Stripe secret key to the server environment." });
    const body = await readBody(req);
    const ids = [...new Set((Array.isArray(body.productIds) ? body.productIds : []).map(Number).filter(Number.isInteger))].slice(0, 30);
    const offerIds = [...new Set((Array.isArray(body.voucherIds) ? body.voucherIds : []).map(Number).filter(Number.isInteger))].slice(0, 30);
    if (!ids.length && !offerIds.length) return send(res, 400, { error: "Your cart is empty." });
    const products = ids.map(id => db.prepare("SELECT * FROM products WHERE id = ?").get(id)).filter(Boolean);
    if (products.length !== ids.length) return send(res, 400, { error: "A product in your cart is no longer available." });
    if (products.some(product => {
      const filePath = digitalFilePath(product.file_path);
      return !filePath || !fs.existsSync(filePath);
    })) {
      return send(res, 409, { error: "A digital file in this cart is not ready yet. Contact store support or try again later." });
    }
    const offers = offerIds.map(id => db.prepare("SELECT * FROM coupon_offers WHERE id=? AND active=1").get(id)).filter(Boolean);
    if (offers.length !== offerIds.length) return send(res, 400, { error: "A voucher in your bag is no longer available." });
    const couponCode = cleanText(body.coupon, 32).toUpperCase();
    const promo = couponCode ? db.prepare("SELECT * FROM coupons WHERE code=? AND active=1").get(couponCode) : null;
    const voucher = couponCode && !promo
      ? db.prepare("SELECT * FROM purchased_vouchers WHERE code=? AND user_id=? AND used_at IS NULL AND reserved_order_id IS NULL").get(couponCode, user.user_id)
      : null;
    if (couponCode && !promo && !voucher) return send(res, 400, { error: "That coupon is invalid, already used, or not available to your account." });
    const subtotal = products.reduce((sum, product) => sum + product.price_cents, 0);
    const voucherSubtotal = offers.reduce((sum, offer) => sum + offer.price_cents, 0);
    const discountPercent = promo?.discount_percent || voucher?.discount_percent || 0;
    const total = Math.round((subtotal + voucherSubtotal) * (100 - discountPercent) / 100);
    if (total < 50) return send(res, 400, { error: "The order total after discounts must be at least $0.50." });
    const insertOrder = db.prepare("INSERT INTO orders(user_id, total_cents) VALUES (?, ?)");
    const orderId = Number(insertOrder.run(user.user_id, total).lastInsertRowid);
    const addItem = db.prepare("INSERT INTO order_items(order_id, product_id, name, price_cents) VALUES (?, ?, ?, ?)");
    for (const product of products) addItem.run(orderId, product.id, product.name, product.price_cents);
    const addVoucherItem = db.prepare("INSERT INTO order_voucher_items(order_id, offer_id, name, price_cents, discount_percent) VALUES (?, ?, ?, ?, ?)");
    for (const offer of offers) addVoucherItem.run(orderId, offer.id, offer.name, offer.price_cents, offer.discount_percent);
    if (voucher) {
      const reservation = db.prepare("UPDATE purchased_vouchers SET reserved_order_id=? WHERE id=? AND used_at IS NULL AND reserved_order_id IS NULL")
        .run(orderId, voucher.id);
      if (!reservation.changes) {
        db.prepare("UPDATE orders SET status='failed' WHERE id=?").run(orderId);
        return send(res, 409, { error: "That voucher is already being used in another checkout." });
      }
    }
    try {
      const params = {
        mode: "payment",
        "success_url": `${BASE_URL}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
        "cancel_url": `${BASE_URL}/?checkout=cancelled`,
        "customer_email": user.email,
        "metadata[order_id]": orderId,
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][product_data][name]": `${products.length} digital product${products.length === 1 ? "" : "s"}${offers.length ? ` + ${offers.length} voucher${offers.length === 1 ? "" : "s"}` : ""}${discountPercent ? ` (${discountPercent}% discount)` : ""}`,
        "line_items[0][price_data][unit_amount]": total,
        "line_items[0][quantity]": 1
      };
      const checkout = await stripeRequest("checkout/sessions", params);
      db.prepare("UPDATE orders SET stripe_session_id = ? WHERE id = ?").run(checkout.id, orderId);
      return send(res, 200, { url: checkout.url });
    } catch (error) {
      db.prepare("UPDATE orders SET status = 'failed' WHERE id = ?").run(orderId);
      db.prepare("UPDATE purchased_vouchers SET reserved_order_id=NULL WHERE reserved_order_id=?").run(orderId);
      throw error;
    }
  }

  if (method === "POST" && pathname === "/api/webhooks/stripe") {
    if (!process.env.STRIPE_WEBHOOK_SECRET) return send(res, 503, { error: "Stripe webhook is not configured." });
    const raw = await new Promise((resolve, reject) => {
      let data = "";
      req.on("data", chunk => { data += chunk; });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
    const signatureHeader = req.headers["stripe-signature"] || "";
    const parts = Object.fromEntries(signatureHeader.split(",").map(part => part.split("=")));
    if (!parts.t || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return send(res, 400, { error: "Webhook timestamp is expired." });
    const signed = `${parts.t}.${raw}`;
    const expected = crypto.createHmac("sha256", process.env.STRIPE_WEBHOOK_SECRET).update(signed).digest("hex");
    const supplied = Buffer.from(parts.v1 || "");
    const expectedBytes = Buffer.from(expected);
    if (supplied.length !== expectedBytes.length || !crypto.timingSafeEqual(supplied, expectedBytes)) return send(res, 400, { error: "Invalid webhook signature." });
    const event = JSON.parse(raw);
    if (event.type === "checkout.session.completed") {
      const checkout = event.data.object;
      const orderId = Number(checkout.metadata?.order_id);
      const order = db.prepare("SELECT * FROM orders WHERE id = ? AND stripe_session_id = ? AND status = 'pending'").get(orderId, checkout.id);
      if (order && checkout.payment_status === "paid") {
        db.prepare("UPDATE orders SET status = 'paid', payment_intent = ? WHERE id = ?")
          .run(typeof checkout.payment_intent === "string" ? checkout.payment_intent : null, order.id);
        const voucherItems = db.prepare("SELECT offer_id, discount_percent FROM order_voucher_items WHERE order_id=?").all(order.id);
        const createVoucher = db.prepare("INSERT INTO purchased_vouchers(user_id, order_id, offer_id, code, discount_percent) VALUES (?, ?, ?, ?, ?)");
        for (const item of voucherItems) {
          createVoucher.run(order.user_id, order.id, item.offer_id, `NX-${crypto.randomBytes(10).toString("hex").toUpperCase()}`, item.discount_percent);
        }
        db.prepare("UPDATE purchased_vouchers SET used_at=datetime('now'), reserved_order_id=NULL WHERE reserved_order_id=?")
          .run(order.id);
      }
    } else if (event.type === "checkout.session.expired") {
      const checkout = event.data.object;
      const orderId = Number(checkout.metadata?.order_id);
      db.prepare("UPDATE orders SET status='expired' WHERE id=? AND stripe_session_id=? AND status='pending'").run(orderId, checkout.id);
      db.prepare("UPDATE purchased_vouchers SET reserved_order_id=NULL WHERE reserved_order_id=?").run(orderId);
    }
    return send(res, 200, { received: true });
  }

  if (method === "GET" && pathname === "/api/orders") {
    const user = requireUser(req, res);
    if (!user) return;
    const orders = db.prepare(`
      SELECT o.*,
        (SELECT GROUP_CONCAT(item_name, ', ') FROM (
          SELECT name AS item_name FROM order_items WHERE order_id=o.id
          UNION ALL SELECT name AS item_name FROM order_voucher_items WHERE order_id=o.id
        )) AS items
      FROM orders o WHERE o.user_id=? ORDER BY o.id DESC
    `).all(user.user_id);
    return send(res, 200, { orders });
  }

  const downloadsMatch = pathname.match(/^\/api\/orders\/(\d+)\/downloads$/);
  if (method === "POST" && downloadsMatch) {
    const user = requireUser(req, res);
    if (!user) return;
    const orderId = Number(downloadsMatch[1]);
    const order = db.prepare("SELECT id FROM orders WHERE id=? AND user_id=? AND status='paid'").get(orderId, user.user_id);
    if (!order) return send(res, 404, { error: "Paid order not found." });
    const items = db.prepare(`
      SELECT p.id, p.name, p.file_path, p.file_name FROM order_items i
      JOIN products p ON p.id=i.product_id WHERE i.order_id=?
    `).all(orderId);
    if (!items.length || items.some(item => {
      const filePath = digitalFilePath(item.file_path);
      return !filePath || !fs.existsSync(filePath);
    })) {
      return send(res, 409, { error: "A digital file for this order is not available yet. Contact store support." });
    }
    const expire = db.prepare("SELECT datetime('now', '+7 days') AS expires").get().expires;
    const addDownload = db.prepare("INSERT INTO downloads(token_hash, order_id, product_id, expires_at) VALUES (?, ?, ?, ?)");
    const downloads = items.map(item => {
      const token = crypto.randomBytes(32).toString("base64url");
      addDownload.run(hash(token), orderId, item.id, expire);
      return { name: item.file_name || item.name, url: `/download/${token}` };
    });
    return send(res, 200, { downloads });
  }

  if (method === "GET" && pathname.startsWith("/download/")) {
    const token = pathname.slice("/download/".length);
    if (!/^[\w-]{30,50}$/.test(token)) return send(res, 400, { error: "Invalid download link." });
    const row = db.prepare(`
      SELECT d.*, p.file_path, p.file_name FROM downloads d
      JOIN orders o ON o.id=d.order_id JOIN products p ON p.id=d.product_id
      WHERE d.token_hash=? AND d.used_at IS NULL AND d.expires_at > datetime('now') AND o.status='paid'
    `).get(hash(token));
    const filePath = digitalFilePath(row?.file_path);
    if (!row || !filePath || !fs.existsSync(filePath)) return send(res, 410, { error: "This download is expired, unavailable, or already used." });
    const result = db.prepare("UPDATE downloads SET used_at=datetime('now') WHERE token_hash=? AND used_at IS NULL").run(hash(token));
    if (!result.changes) return send(res, 410, { error: "This download link has already been used." });
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${path.basename(row.file_name || "download.zip").replace(/["\\\r\n]/g, "_")}"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });
    return fs.createReadStream(filePath).pipe(res);
  }

  if (method === "GET" && pathname.startsWith("/uploads/")) {
    const filename = path.basename(pathname.slice("/uploads/".length));
    const target = path.join(IMAGES, filename);
    if (!fs.existsSync(target)) return send(res, 404, { error: "File not found." });
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
    return fs.createReadStream(target).pipe(res);
  }

  if (method === "GET" && pathname.startsWith("/api/")) return send(res, 404, { error: "API route not found." });

  const pagePaths = new Set(["/", "/games", "/shop", "/coupons", "/reviews"]);
  const relative = pagePaths.has(pathname) ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.resolve(PUBLIC, relative);
  if (!target.startsWith(`${PUBLIC}${path.sep}`) && target !== path.join(PUBLIC, "index.html")) return send(res, 403, { error: "Forbidden." });
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return send(res, 404, { error: "Page not found." });
  res.writeHead(200, { "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream", "X-Content-Type-Options": "nosniff" });
  fs.createReadStream(target).pipe(res);
}

function saveUpload(dataUrl, originalName, maxBytes, kind) {
  const match = dataUrl.match(/^data:([\w.+-]+\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw Object.assign(new Error("Upload must be a valid base64 file."), { status: 400 });
  const mime = match[1].toLowerCase();
  const ext = path.extname(originalName).toLowerCase();
  const imageTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
  const digitalTypes = {
    ".zip": ["application/zip", "application/x-zip-compressed", "application/octet-stream"],
    ".pdf": ["application/pdf", "application/octet-stream"],
    ".png": ["image/png"],
    ".jpg": ["image/jpeg"],
    ".jpeg": ["image/jpeg"],
    ".webp": ["image/webp"],
    ".txt": ["text/plain"],
    ".rar": ["application/vnd.rar", "application/x-rar-compressed", "application/octet-stream"],
    ".7z": ["application/x-7z-compressed", "application/octet-stream"]
  };
  if (kind === "image" && imageTypes[ext] !== mime) throw Object.assign(new Error("Artwork must be PNG, JPG, or WebP."), { status: 400 });
  if (kind === "digital" && !digitalTypes[ext]?.includes(mime)) throw Object.assign(new Error("Digital files must be ZIP, PDF, PNG, JPG, WebP, TXT, RAR, or 7Z."), { status: 400 });
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > maxBytes) throw Object.assign(new Error(`Upload exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB limit.`), { status: 413 });
  const safeExt = ext.replace(/[^.a-z0-9]/g, "").slice(0, 10);
  const storedName = `${crypto.randomBytes(18).toString("hex")}${safeExt}`;
  const target = path.join(kind === "image" ? IMAGES : FILES, storedName);
  fs.writeFileSync(target, buffer, { flag: "wx" });
  return storedName;
}

const server = http.createServer((req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  route(req, res).catch(error => {
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.url}:`, error);
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : "Something went wrong. Check the server logs." });
    else res.destroy();
  });
});
server.listen(PORT, HOST, () => {
  console.log(`Nexventa is running at ${BASE_URL}`);
  console.log(`Database: ${path.join(DATA, "shop.sqlite")}`);
});
