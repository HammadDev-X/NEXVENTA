const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { once } = require("node:events");

// Each test file runs in its own process under `node --test`, so setting env vars
// here and requiring server.js fresh gives that file an isolated DB, port, and config.
async function startTestServer(envOverrides = {}) {
  const dataDir = path.join(os.tmpdir(), `nexventa-test-${crypto.randomBytes(8).toString("hex")}`);
  fs.mkdirSync(dataDir, { recursive: true });

  Object.assign(process.env, {
    DATA_DIR: dataDir,
    PORT: "0",
    HOST: "127.0.0.1",
    ADMIN_PASSCODE: "test-admin-passcode",
    STRIPE_SECRET_KEY: "",
    STRIPE_WEBHOOK_SECRET: "",
    SMTP_USER: "",
    SMTP_APP_PASSWORD: "",
    BASE_URL: "",
    ...envOverrides
  });

  const server = require("../server.js");
  if (!server.listening) await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, dataDir };
}

function cookieJar() {
  let cookie = "";
  return {
    capture(response) {
      const setCookie = response.headers.get("set-cookie");
      if (setCookie) cookie = setCookie.split(";")[0];
    },
    header() {
      return cookie ? { Cookie: cookie } : {};
    },
    clear() {
      cookie = "";
    }
  };
}

async function jsonFetch(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers }
  });
  let body;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body, response };
}

module.exports = { startTestServer, cookieJar, jsonFetch };
