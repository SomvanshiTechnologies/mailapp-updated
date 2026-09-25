// Shared helpers for the user-guide screenshot scripts.
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const BASE = "http://localhost:5173";
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

function readEnv() {
  const txt = fs.readFileSync(path.resolve(__dirname, "../../.env"), "utf8");
  const env = {};
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}

const ENV = readEnv();
const ADMIN = { email: ENV.SEED_ADMIN_EMAIL, password: ENV.SEED_ADMIN_PASSWORD };
const OPERATOR = { email: "riya.sharma@somvanshitechnologies.digital", password: "Operator-Pass-2026!", name: "Riya Sharma" };
const VIEWER = { email: "dev.patel@somvanshitechnologies.digital", password: "Viewer-Pass-2026!", name: "Dev Patel" };

async function launch() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  return { browser, context, page };
}

async function login(page, who) {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", who.email);
  await page.fill("input[type=password]", who.password);
  await page.click("button[type=submit]");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await page.waitForLoadState("networkidle");
}

async function logout(page) {
  const btn = page.getByRole("button", { name: /sign out|log out|logout/i }).first();
  if (await btn.count()) {
    await btn.click();
    await page.waitForURL((u) => u.pathname.startsWith("/login"));
  } else {
    await page.context().clearCookies();
  }
}

/** JSON API call with the session cookies of the page and the CSRF header. */
async function api(page, method, url, body) {
  const res = await page.request.fetch(`${BASE}${url}`, {
    method,
    headers: { "X-Requested-With": "mailapp", ...(body ? { "Content-Type": "application/json" } : {}) },
    data: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok()) throw new Error(`${method} ${url} -> ${res.status()} ${text.slice(0, 300)}`);
  return json;
}

async function shot(page, name, opts = {}) {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(opts.settle ?? 400);
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? true });
  console.log("shot", name);
  return file;
}

async function goto(page, p) {
  await page.goto(`${BASE}${p}`);
  await page.waitForLoadState("networkidle").catch(() => {});
}

module.exports = { BASE, SHOTS, ENV, ADMIN, OPERATOR, VIEWER, launch, login, logout, api, shot, goto };

/** Input/textarea/select that follows a <label class="label">text</label> (the Field component). */
function field(page, label) {
  return page.locator(`div:has(> label:text-is("${label}")) > :is(input, textarea, select)`).first();
}
module.exports.field = field;
