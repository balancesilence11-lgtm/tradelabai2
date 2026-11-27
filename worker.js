import { handleMarketIntelligence } from "./phase2_market_intelligence.js";
import { validateSignalRecord, resolveSignalOutcome } from "./src/signal-validation.js";
import { constantTimeEqual, isValidEmail, readJsonLimited } from "./src/security-hardening.js";
/*
 * TradeLab AI — Phase 2 Market Intelligence (additive module)
 * Requires existing Cloudflare Worker bindings: DB (D1), FINNHUB_API_KEY.
 * Mount this handler only AFTER the existing authenticated-user check in routeRequest.
 * Does not change existing routes, tables, trading, journal, risk, or broker code.
 */

const MI_CACHE_TTL_SECONDS = 300;
const MI_ALLOWED_METHODS = new Set(["GET", "POST"]);

function miJson(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

function miText(value, max = 120) {
  return String(value ?? "").replace(/[<>\u0000-\u001f]/g, " ").trim().slice(0, max);
}

function miSymbol(value) {
  const symbol = miText(value || "EURUSD", 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  return /^[A-Z0-9]{3,20}$/.test(symbol) ? symbol : "EURUSD";
}

function miSentiment(text) {
  const positive = ["gain", "gains", "rise", "rises", "rising", "bullish", "surge", "surges", "beat", "beats", "strong", "growth", "hawkish", "higher", "upgrade", "optimism", "inflow"];
  const negative = ["fall", "falls", "drop", "drops", "decline", "declines", "bearish", "plunge", "plunges", "miss", "misses", "weak", "recession", "dovish", "lower", "downgrade", "risk", "outflow", "crisis"];
  const words = String(text || "").toLowerCase().match(/[a-z]+/g) || [];
  let score = 0;
  for (const word of words) {
    if (positive.includes(word)) score++;
    if (negative.includes(word)) score--;
  }
  const normalized = Math.max(-100, Math.min(100, Math.round(score / Math.max(3, Math.sqrt(words.length)) * 100)));
  return { label: normalized >= 15 ? "BULLISH" : normalized <= -15 ? "BEARISH" : "NEUTRAL", score: normalized };
}

async function miCached(env, key, loader) {
  if (!env.DB) return loader();
  const now = new Date().toISOString();
  try {
    const cached = await env.DB.prepare(
      "SELECT payload, expires_at FROM market_intelligence_cache WHERE cache_key = ? AND expires_at > ? LIMIT 1"
    ).bind(key, now).first();
    if (cached?.payload) return JSON.parse(cached.payload);
  } catch (error) {
    // Cache is an optimization. Continue to provider if the table is unavailable.
    console.warn("Market intelligence cache read skipped:", error?.message || error);
  }
  const value = await loader();
  try {
    const expires = new Date(Date.now() + MI_CACHE_TTL_SECONDS * 1000).toISOString();
    await env.DB.prepare(`
      INSERT INTO market_intelligence_cache (cache_key, payload, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload = excluded.payload,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).bind(key, JSON.stringify(value), expires, now).run();
  } catch (error) {
    console.warn("Market intelligence cache write skipped:", error?.message || error);
  }
  return value;
}

async function miFinnhub(path, env) {
  if (!env.FINNHUB_API_KEY) {
    const error = new Error("Finnhub provider is not configured. Add FINNHUB_API_KEY to Worker secrets.");
    error.status = 503;
    throw error;
  }
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(`https://finnhub.io/api/v1${path}${separator}token=${encodeURIComponent(env.FINNHUB_API_KEY)}`, {
    headers: { Accept: "application/json" }
  });
  if (!response.ok) {
    const error = new Error(`Finnhub request failed (${response.status}).`);
    error.status = response.status === 429 ? 503 : 502;
    throw error;
  }
  return response.json();
}

async function miNews(url, env) {
  const symbol = miSymbol(url.searchParams.get("symbol"));
  const category = "forex";
  return miCached(env, `news:${category}:${symbol}`, async () => {
    const raw = await miFinnhub(`/news?category=${category}`, env);
    const now = Date.now();
    const items = (Array.isArray(raw) ? raw : []).slice(0, 100).map(item => {
      const title = miText(item.headline, 240);
      const summary = miText(item.summary, 700);
      const sentiment = miSentiment(`${title} ${summary}`);
      return {
        id: miText(item.id, 80),
        headline: title,
        summary,
        source: miText(item.source, 80),
        url: typeof item.url === "string" && /^https:\/\//i.test(item.url) ? item.url : null,
        datetime: Number(item.datetime) > 0 ? new Date(Number(item.datetime) * 1000).toISOString() : null,
        related: miText(item.related, 100),
        sentiment: sentiment.label,
        sentimentScore: sentiment.score
      };
    }).filter(item => item.headline).sort((a, b) => Date.parse(b.datetime || 0) - Date.parse(a.datetime || 0)).slice(0, 40);
    const scores = items.map(item => item.sentimentScore);
    const average = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
    return {
      ok: true,
      source: "Finnhub",
      dataStatus: "LIVE_PROVIDER_DATA",
      symbol,
      category,
      sentiment: average >= 15 ? "BULLISH" : average <= -15 ? "BEARISH" : "NEUTRAL",
      sentimentScore: average,
      count: items.length,
      items,
      fetchedAt: new Date(now).toISOString()
    };
  });
}

async function miCalendar(url, env) {
  const from = miText(url.searchParams.get("from") || new Date().toISOString().slice(0, 10), 10);
  const to = miText(url.searchParams.get("to") || new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10), 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) {
    return miJson({ ok: false, error: "Provide valid from/to dates in YYYY-MM-DD format." }, 400);
  }
  return miCached(env, `calendar:${from}:${to}`, async () => {
    const raw = await miFinnhub(`/calendar/economic?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`, env);
    const events = Array.isArray(raw?.economicCalendar) ? raw.economicCalendar : [];
    const items = events.slice(0, 500).map(event => ({
      country: miText(event.country, 60),
      currency: miText(event.currency, 10),
      event: miText(event.event, 180),
      date: miText(event.time, 40),
      impact: Number(event.impact) >= 3 ? "HIGH" : Number(event.impact) === 2 ? "MEDIUM" : "LOW",
      actual: event.actual ?? null,
      estimate: event.estimate ?? null,
      previous: event.prev ?? null,
      unit: miText(event.unit, 20)
    }));
    return { ok: true, source: "Finnhub", dataStatus: "LIVE_PROVIDER_DATA", from, to, count: items.length, items, fetchedAt: new Date().toISOString() };
  });
}

async function miBrief(request, env) {
  let body;
  try { body = await request.json(); } catch { return miJson({ ok: false, error: "Invalid JSON request body." }, 400); }
  const symbol = miSymbol(body?.symbol);
  const timeframe = miText(body?.timeframe || "1h", 12);
  const candles = Array.isArray(body?.candles) ? body.candles.slice(-100) : [];
  if (candles.length < 5) return miJson({ ok: false, error: "At least five recent candles are required for contextual analysis." }, 400);
  const valid = candles.map(c => ({ open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) || 0 })).filter(c => [c.open,c.high,c.low,c.close].every(Number.isFinite) && c.high >= c.low && c.high >= Math.max(c.open,c.close) && c.low <= Math.min(c.open,c.close));
  if (valid.length < 5) return miJson({ ok: false, error: "Insufficient valid candle data." }, 400);
  const last = valid.at(-1), first = valid[0];
  const closes = valid.map(c => c.close);
  const changePct = first.close ? ((last.close - first.close) / first.close) * 100 : 0;
  const shortMean = closes.slice(-5).reduce((a,b)=>a+b,0) / Math.min(5, closes.length);
  const longMean = closes.reduce((a,b)=>a+b,0) / closes.length;
  const rangeHigh = Math.max(...valid.map(c=>c.high));
  const rangeLow = Math.min(...valid.map(c=>c.low));
  let score = 0;
  if (shortMean > longMean) score += 25; else if (shortMean < longMean) score -= 25;
  if (changePct > 0.15) score += 25; else if (changePct < -0.15) score -= 25;
  if (last.close > valid.at(-2).close) score += 15; else if (last.close < valid.at(-2).close) score -= 15;
  const direction = score >= 25 ? "BULLISH" : score <= -25 ? "BEARISH" : "NEUTRAL";
  return miJson({
    ok: true,
    source: "TradeLab quantitative confluence engine",
    dataStatus: "ANALYSIS_OF_USER_SUPPLIED_MARKET_CANDLES",
    symbol,
    timeframe,
    direction,
    confluenceScore: score,
    quality: Math.min(100, Math.round(Math.abs(score) * 1.2 + (valid.length >= 30 ? 20 : 5))),
    metrics: { changePercent: Number(changePct.toFixed(4)), shortMean, sampleMean: longMean, rangeHigh, rangeLow, lastClose: last.close, candlesAnalyzed: valid.length },
    interpretation: direction === "NEUTRAL" ? "Mixed or insufficient directional confluence; wait for confirmation." : `${direction} bias from the supplied candle sample; this is not a guaranteed trading signal.`,
    riskNotice: "Analytical information only. Not financial advice and not an instruction to place a trade.",
    generatedAt: new Date().toISOString()
  });
}

const SYMBOLS = {
EURUSD: "EUR/USD",
GBPUSD: "GBP/USD",
USDJPY: "USD/JPY",
USDCHF: "USD/CHF",
USDCAD: "USD/CAD",
AUDUSD: "AUD/USD",
NZDUSD: "NZD/USD",
EURGBP: "EUR/GBP",
EURJPY: "EUR/JPY",
GBPJPY: "GBP/JPY",
AUDJPY: "AUD/JPY",
EURAUD: "EUR/AUD",
GBPAUD: "GBP/AUD",
XAUUSD: "XAU/USD",
BTCUSD: "BTC/USD"
};
const ALLOWED_INTERVALS = ["1min", "5min", "15min", "30min", "1h", "4h", "1day"];
const MARKET_REQUEST_TIMEOUT_MS = 12000;
const SESSION_COOKIE = "__Host-tl_session";
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 100000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();
/* =========================================
GENERAL RESPONSE AND SECURITY HELPERS
========================================= */
function applySecurityHeaders(response) {
const headers = new Headers(response.headers);
headers.set("X-Content-Type-Options", "nosniff");
headers.set("Referrer-Policy", "no-referrer");
headers.set("Cross-Origin-Resource-Policy", "same-origin");
headers.set("X-Frame-Options", "DENY");
headers.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
return new Response(response.body, {
status: response.status,
statusText: response.statusText,
headers
});
}
function json(data, status = 200, extraHeaders = {}) {
return Response.json(data, {
status,
headers: {
"Cache-Control": "no-store",
"X-Content-Type-Options": "nosniff",
"Referrer-Policy": "no-referrer",
"Cross-Origin-Resource-Policy": "same-origin",
"X-Frame-Options": "DENY",
"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
...extraHeaders
}
});
}
function randomId(bytes = 32) {
const data = crypto.getRandomValues(new Uint8Array(bytes));
return Array.from(data, b => b.toString(16).padStart(2, "0")).join("");
}
function base64Url(bytes) {
let binary = "";
for (const byte of bytes) binary += String.fromCharCode(byte);
return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256(value) {
const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
return Array.from(new Uint8Array(digest))
.map(b => b.toString(16).padStart(2, "0"))
.join("");
}
async function hashPassword(password, salt) {
const key = await crypto.subtle.importKey(
"raw",
encoder.encode(password),
"PBKDF2",
false,
["deriveBits"]
);
const bits = await crypto.subtle.deriveBits({
name: "PBKDF2",
salt: encoder.encode(salt),
iterations: PASSWORD_ITERATIONS,
hash: "SHA-256"
}, key, 256);
return base64Url(new Uint8Array(bits));
}
function cookieValue(request) {
const cookies = request.headers.get("Cookie") || "";
for (const item of cookies.split(";")) {
const [name, ...parts] = item.trim().split("=");
if (name === SESSION_COOKIE) return parts.join("=");
}
return null;
}
function sessionCookie(token, maxAge = SESSION_DAYS * 86400) {
return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearSessionCookie() {
return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
function validOrigin(request, url) {
const origin = request.headers.get("Origin");
const fetchSite = request.headers.get("Sec-Fetch-Site");
if (!origin || origin !== url.origin) return false;
if (fetchSite === "cross-site") return false;
return true;
}
async function readJson(request) {
return readJsonLimited(request, 8192);
}
async function enforceAuthRateLimit(env, request, purpose) {
const ip = String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64);
const ipHash = await sha256(ip);
const rateKey = `${purpose}:${ipHash}`;
const now = Date.now();
const windowMs = purpose === "register" ? 60 * 60 * 1000 : 15 * 60 * 1000;
const limit = purpose === "register" ? 5 : 25;
const row = await env.DB.prepare(`
INSERT INTO auth_rate_limits (rate_key, attempts, window_started_at, blocked_until)
VALUES (?, 1, ?, NULL)
ON CONFLICT(rate_key) DO UPDATE SET
  attempts = CASE WHEN auth_rate_limits.window_started_at <= ? THEN 1 ELSE auth_rate_limits.attempts + 1 END,
  window_started_at = CASE WHEN auth_rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE auth_rate_limits.window_started_at END,
  blocked_until = CASE
    WHEN auth_rate_limits.window_started_at <= ? THEN NULL
    WHEN auth_rate_limits.attempts + 1 >= ? THEN auth_rate_limits.window_started_at + ?
    ELSE auth_rate_limits.blocked_until
  END
RETURNING attempts, window_started_at, blocked_until
`).bind(rateKey, now, now - windowMs, now - windowMs, now - windowMs, limit, windowMs).first();
return Boolean(row?.blocked_until && Number(row.blocked_until) > now);
}
/* =========================================
AUTHENTICATION DATABASE HELPERS
========================================= */
async function logAuthEvent(env, userId, email, eventType) {
await env.DB.prepare(`INSERT INTO auth_events (user_id, email, event_type) VALUES (?, ?, ?)`).bind(userId || null, email || null, eventType).run();
}
async function createSession(env, userId) {
const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
const sessionId = await sha256(token);
const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();
await env.DB.prepare(`INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)`).bind(sessionId, userId, expiresAt).run();
return token;
}
async function getAuthenticatedUser(request, env) {
const token = cookieValue(request);
if (!token) return null;
const sessionId = await sha256(token);
const session = await env.DB.prepare(`SELECT sessions.id, sessions.user_id, sessions.expires_at, users.email, users.status, users.created_at FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.id = ?`).bind(sessionId).first();
if (!session) return null;
if (
Date.parse(session.expires_at) <= Date.now() ||
session.status !== "active"
) {
await env.DB.prepare("DELETE FROM sessions WHERE id = ?")
.bind(sessionId).run();
return null;
}
return {
id: session.user_id,
email: session.email,
createdAt: session.created_at
};
}
/* =========================================
REGISTRATION
========================================= */
async function register(request, env) {
if (await enforceAuthRateLimit(env, request, "register")) {
return json({ error: "Too many registration attempts. Try again later." }, 429, { "Retry-After": "3600" });
}
let body;
try {
body = await readJson(request);
} catch (error) {
return json({ error: error?.code === "BODY_TOO_LARGE" ? "Request body too large." : "Invalid request body" }, error?.code === "BODY_TOO_LARGE" ? 413 : 400);
}
const email = String(body.email || "").trim().toLowerCase();
const password = String(body.password || "");
if (!isValidEmail(email)) {
return json({ error: "Enter a valid email address" }, 400);
}
if (password.length < 12 || password.length > 128) {
return json({ error: "Password must contain 12–128 characters" }, 400);
}
const userId = randomId(16);
const salt = randomId(16);
const passwordHash = await hashPassword(password, salt);
try {
await env.DB.prepare(`INSERT INTO users (id, email, password_hash, password_salt) VALUES (?, ?, ?, ?)`).bind(userId, email, passwordHash, salt).run();
} catch (error) {
if (String(error.message).toLowerCase().includes("unique")) {
return json({ error: "An account with this email already exists" }, 409);
}
    console.error("Registration database error:", error.message);
    return json({ error: "Unable to create account" }, 500);
}
await logAuthEvent(env, userId, email, "registration");
const token = await createSession(env, userId);
return json({
ok: true,
message: "Account created successfully",
user: { id: userId, email }
}, 201, {
"Set-Cookie": sessionCookie(token)
});
}
/* =========================================
LOGIN
========================================= */
async function login(request, env) {
if (await enforceAuthRateLimit(env, request, "login")) {
return json({ error: "Too many login attempts. Try again later." }, 429, { "Retry-After": "900" });
}
let body;
try {
body = await readJson(request);
} catch (error) {
return json({ error: error?.code === "BODY_TOO_LARGE" ? "Request body too large." : "Invalid request body" }, error?.code === "BODY_TOO_LARGE" ? 413 : 400);
}
const email = String(body.email || "").trim().toLowerCase();
const password = String(body.password || "");
if (!isValidEmail(email) || !password || password.length > 128) {
return json({ error: "Invalid email or password" }, 400);
}
const ip = String(request.headers.get("CF-Connecting-IP") || "unknown").slice(0, 64);
const attemptKey = await sha256(`${email}:${ip}`);
const now = Date.now();
const attempts = await env.DB.prepare(`SELECT attempts, window_started_at, locked_until FROM login_attempts WHERE email = ?`).bind(attemptKey).first();
if (attempts?.locked_until && Date.parse(attempts.locked_until) > now) {
return json({ error: "Too many login attempts. Try again later." }, 429);
}
const user = await env.DB.prepare(`SELECT id, email, password_hash, password_salt, status FROM users WHERE email = ?`).bind(email).first();
let valid = false;
if (user && user.status === "active") {
const suppliedHash = await hashPassword(password, user.password_salt);
valid = constantTimeEqual(suppliedHash, user.password_hash);
}
if (!valid) {
const windowStart = attempts?.window_started_at
? Date.parse(attempts.window_started_at)
: 0;
    const withinWindow = now - windowStart < LOGIN_WINDOW_MS;
    const count = withinWindow ? Number(attempts.attempts) + 1 : 1;

    const lockedUntil = count >= MAX_LOGIN_ATTEMPTS
      ? new Date(now + LOGIN_WINDOW_MS).toISOString()
      : null;

    await env.DB.prepare(`
      INSERT INTO login_attempts (
        email, attempts, window_started_at, locked_until
      )
      VALUES (?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        attempts = excluded.attempts,
        window_started_at = excluded.window_started_at,
        locked_until = excluded.locked_until
    `).bind(
      attemptKey,
      count,
      withinWindow ? attempts.window_started_at : new Date(now).toISOString(),
      lockedUntil
    ).run();

    await logAuthEvent(env, null, email, "login_failed");
    return json({ error: "Invalid email or password" }, 401);
}
await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?")
.bind(attemptKey).run();
await logAuthEvent(env, user.id, email, "login_success");
const token = await createSession(env, user.id);
return json({
ok: true,
message: "Login successful",
user: { id: user.id, email: user.email }
}, 200, {
"Set-Cookie": sessionCookie(token)
});
}
/* =========================================
LOGOUT
========================================= */
async function logout(request, env) {
const token = cookieValue(request);
if (token) {
const sessionId = await sha256(token);
    const session = await env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ?
    `).bind(sessionId).first();

    await env.DB.prepare("DELETE FROM sessions WHERE id = ?")
      .bind(sessionId).run();

    if (session) {
      await logAuthEvent(env, session.user_id, null, "logout");
    }
}
return json({
ok: true,
message: "Logged out successfully"
}, 200, {
"Set-Cookie": clearSessionCookie()
});
}/* =========================================
AUTHENTICATION ROUTES
========================================= */
async function handleAuth(request, env, url) {
const path = url.pathname;
if (request.method === "POST" && !validOrigin(request, url)) {
return json({ error: "Request origin rejected" }, 403);
}
if (path === "/api/auth/register" && request.method === "POST") {
return register(request, env);
}
if (path === "/api/auth/login" && request.method === "POST") {
return login(request, env);
}
if (path === "/api/auth/logout" && request.method === "POST") {
return logout(request, env);
}
if (path === "/api/auth/me" && request.method === "GET") {
const user = await getAuthenticatedUser(request, env);
    if (!user) return json({ authenticated: false }, 401);

    return json({ authenticated: true, user });
}
return json({ error: "Authentication route not found" }, 404);
}
/* =========================================
BILLING CONFIGURATION
========================================= */
const BILLING_PLAN_ID = "hourly_usd_1";
const BILLING_AMOUNT_MINOR = 100;
const BILLING_CURRENCY = "USD";
const BILLING_INTERVAL_SECONDS = 3600;
const FLW_PAYMENT_PLAN_ID = 252752;
// Flutterwave recurring Payment Plans are card-based. M-Pesa/STK Push and
// Deriv-wallet debits are intentionally not offered for this subscription.
const BILLING_ALLOWED_PROVIDERS = new Set(["card"]);
/* =========================================
BILLING AUDIT HELPER
========================================= */
async function logBillingEvent(
env,
userId,
subscriptionId,
transactionId,
eventType,
details = {}
) {
await env.DB.prepare(`INSERT INTO billing_audit_log ( id, user_id, subscription_id, transaction_id, event_type, details_json ) VALUES (?, ?, ?, ?, ?, ?)`).bind(
randomId(16),
userId || null,
subscriptionId || null,
transactionId || null,
eventType,
JSON.stringify(details)
).run();
}
/* =========================================
SUBSCRIPTION ENTITLEMENT / SERVER-SIDE ACCESS CONTROL
========================================= */
async function getSubscriptionEntitlement(env, user) {
if (!user?.id) return { active: false, reason: "unauthenticated" };
// TradeLab AI owner receives permanent lifetime access.
// Customer subscription checks below remain unchanged.
const ownerEmail = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
const userEmail = String(user.email || "").trim().toLowerCase();
if (ownerEmail && userEmail === ownerEmail) {
return {
active: true,
reason: "owner_lifetime",
subscription: null
};
}
const subscription = await env.DB.prepare(`SELECT s.id, s.plan_id, s.status, s.current_period_end, s.grace_period_end, s.cancel_at_period_end, p.active AS plan_active FROM subscriptions s LEFT JOIN subscription_plans p ON p.id = s.plan_id WHERE s.user_id = ? AND s.plan_id = ? ORDER BY CASE WHEN s.status = 'active' THEN 1 WHEN s.status = 'pending' THEN 2 ELSE 3 END, s.created_at DESC LIMIT 1`).bind(user.id, BILLING_PLAN_ID).first();
if (!subscription) return { active: false, reason: "no_subscription", subscription: null };
const now = Date.now();
const periodEnd = subscription.current_period_end ? Date.parse(subscription.current_period_end) : 0;
const graceEnd = subscription.grace_period_end ? Date.parse(subscription.grace_period_end) : 0;
const periodValid = Number.isFinite(periodEnd) && periodEnd > now;
const graceValid = Number.isFinite(graceEnd) && graceEnd > now;
const active = subscription.status === "active" && Number(subscription.plan_active) === 1 && (periodValid || graceValid);
return {
active,
reason: active ? (periodValid ? "active" : "grace_period") : (subscription.status === "active" ? "period_expired" : subscription.status),
subscription: {
id: subscription.id,
status: subscription.status,
currentPeriodEnd: subscription.current_period_end,
gracePeriodEnd: subscription.grace_period_end,
cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end)
}
};
}
function paymentRequiredResponse(entitlement) {
return json({
ok: false,
code: "PAYMENT_REQUIRED",
paymentRequired: true,
error: "An active TradeLab AI subscription is required to use this feature.",
billingUrl: "/?page=billing",
subscriptionStatus: entitlement?.subscription?.status || "inactive"
}, 402);
}
/* =========================================
BILLING STATUS
========================================= */
async function getBillingStatus(env, user) {
const plan = await env.DB.prepare(`SELECT id, name, amount, currency, billing_interval_seconds, active FROM subscription_plans WHERE id = ?`).bind(BILLING_PLAN_ID).first();
const subscription = await env.DB.prepare(`SELECT s.id, s.plan_id, s.status, s.payment_provider, s.current_period_start, s.current_period_end, s.next_billing_at, s.grace_period_end, s.cancel_at_period_end, s.created_at, p.name AS plan_name, p.amount, p.currency, p.billing_interval_seconds FROM subscriptions s LEFT JOIN subscription_plans p ON p.id = s.plan_id WHERE s.user_id = ? ORDER BY CASE WHEN s.status = 'active' THEN 1 WHEN s.status = 'pending' THEN 2 ELSE 3 END, s.created_at DESC LIMIT 1`).bind(user.id).first();
const entitlement = await getSubscriptionEntitlement(env, user);
return {
ok: true,
billingEnabled: true,
paymentRequired: !entitlement.active,
    plan: plan ? {
      id: plan.id,
      name: plan.name,
      amount: Number(plan.amount),
      currency: plan.currency,
      billingIntervalSeconds: Number(plan.billing_interval_seconds),
      active: Boolean(plan.active)
    } : null,

    subscription: subscription ? {
      id: subscription.id,
      planId: subscription.plan_id,
      planName: subscription.plan_name,
      status: entitlement.reason === "period_expired" ? "expired" : subscription.status,
      paymentProvider: subscription.payment_provider,
      amount: Number(subscription.amount || 0),
      currency: subscription.currency || BILLING_CURRENCY,
      currentPeriodStart: subscription.current_period_start,
      currentPeriodEnd: subscription.current_period_end,
      nextBillingAt: subscription.next_billing_at,
      gracePeriodEnd: subscription.grace_period_end,
      cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      createdAt: subscription.created_at
    } : null,

    pricing: {
      amount: 1,
      currency: "USD",
      intervalSeconds: 3600,
      intervalLabel: "1 hour",
      dailyEquivalent: 24,
      monthlyEquivalent: 720
    },

    entitlement: {
      active: entitlement.active,
      reason: entitlement.reason
    },
    message: entitlement.active
      ? "Your TradeLab AI subscription is active."
      : "An active hourly subscription is required to use paid features."
};
}/* =========================================
FLUTTERWAVE WEBHOOK AND VERIFICATION
========================================= */
function constantTimeStringEqual(a, b) {
if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
let diff = 0;
for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
return diff === 0;
}
async function handleFlutterwaveWebhook(request, env) {
if (request.method !== "POST") return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
if (!env.FLW_SECRET_KEY || !env.FLW_WEBHOOK_HASH) {
console.error("Flutterwave webhook secrets are missing.");
return json({ error: "Webhook is not configured" }, 503);
}
const suppliedHash = request.headers.get("verif-hash") || "";
if (!constantTimeStringEqual(suppliedHash, env.FLW_WEBHOOK_HASH)) {
return json({ error: "Invalid webhook signature" }, 401);
}
let event;
try { event = await request.json(); }
catch { return json({ error: "Invalid webhook payload" }, 400); }
if (event.event === "subscription.cancelled") {
const email = String(
event.data?.customer?.customer_email ||
event.data?.customer?.email ||
""
).trim().toLowerCase();
const providerPlanId = String(event.data?.plan?.id || "");
    if (!email || (providerPlanId && providerPlanId !== String(FLW_PAYMENT_PLAN_ID))) {
      return json({ ok: true, ignored: true, reason: "Subscription event did not match this plan" });
    }

    const account = await env.DB.prepare(
      `SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1`
    ).bind(email).first();
    if (!account) return json({ ok: true, ignored: true, reason: "TradeLab account not found" });

    const localSubscription = await env.DB.prepare(`
      SELECT id, cancel_at_period_end FROM subscriptions
      WHERE user_id = ? AND plan_id = ? AND payment_provider = 'flutterwave'
        AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).bind(account.id, BILLING_PLAN_ID).first();

    if (!localSubscription) return json({ ok: true, ignored: true, reason: "Active local subscription not found" });
    if (Number(localSubscription.cancel_at_period_end) === 1) {
      return json({ ok: true, duplicate: true });
    }

    const cancelledAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`UPDATE subscriptions SET cancel_at_period_end = 1, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'active'`)
        .bind(cancelledAt, localSubscription.id, account.id),
      env.DB.prepare(`INSERT INTO billing_audit_log (id, user_id, subscription_id, transaction_id, event_type, details_json) VALUES (?, ?, ?, NULL, 'flutterwave_subscription_cancelled', ?)`)
        .bind(randomId(16), account.id, localSubscription.id, JSON.stringify({ providerPlanId: providerPlanId || null, providerStatus: event.data?.status || "cancelled" }))
    ]);
    return json({ ok: true, cancellationRecorded: true });
}
if (event.event !== "charge.completed" || !event.data?.id) {
return json({ ok: true, ignored: true });
}
let verified;
try {
const response = await fetch(`https://api.flutterwave.com/v3/transactions/${encodeURIComponent(event.data.id)}/verify`, {
headers: { Authorization: `Bearer ${env.FLW_SECRET_KEY}`, "Content-Type": "application/json" }
});
const result = await response.json();
if (!response.ok || result.status !== "success" || !result.data) throw new Error(result.message || "Transaction verification failed");
verified = result.data;
} catch (error) {
console.error("Flutterwave transaction verification failed:", error.message);
return json({ error: "Unable to verify payment" }, 503);
}
const txRef = String(verified.tx_ref || "");
const gatewayStatus = String(verified.status || "").toLowerCase();
const currency = String(verified.currency || "").toUpperCase();
const paymentType = String(verified.payment_type || event.data?.payment_type || "").toLowerCase();
const amount = Number(verified.amount);
if (
!txRef ||
String(verified.id) !== String(event.data.id) ||
paymentType !== "card" ||
currency !== "USD" ||
!Number.isFinite(amount) ||
Math.round(amount * 100) !== BILLING_AMOUNT_MINOR
) {
console.warn("Flutterwave payment did not meet activation checks", {
txRef, gatewayStatus, paymentType, currency, amount
});
return json({ ok: true, ignored: true, reason: "Transaction ID, payment method, amount or currency mismatch" });
}
if (gatewayStatus !== "successful") {
const pending = await env.DB.prepare(`SELECT id, user_id, subscription_id FROM payment_transactions WHERE provider = 'flutterwave' AND provider_payment_ref = ? AND status = 'pending' LIMIT 1`).bind(txRef).first();
if (pending) {
const failedAt = new Date().toISOString();
await env.DB.batch([
env.DB.prepare(`UPDATE payment_transactions SET status = 'failed', provider_status = ?, updated_at = ? WHERE id = ? AND status = 'pending'`).bind(gatewayStatus || 'failed', failedAt, pending.id),
env.DB.prepare(`UPDATE subscriptions SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'`).bind(failedAt, pending.subscription_id),
env.DB.prepare(`INSERT INTO billing_audit_log (id, user_id, subscription_id, transaction_id, event_type, details_json) VALUES (?, ?, ?, ?, 'flutterwave_payment_failed', ?)`)
.bind(randomId(16), pending.user_id, pending.subscription_id, pending.id, JSON.stringify({ txRef, gatewayStatus }))
]);
}
return json({ ok: true, ignored: true, reason: "Payment was not successful" });
}
const paidAt = verified.created_at && !Number.isNaN(Date.parse(verified.created_at))
? new Date(verified.created_at).toISOString() : new Date().toISOString();
const existingTransaction = await env.DB.prepare(`SELECT id, user_id, subscription_id, status, amount_minor, currency FROM payment_transactions WHERE provider = 'flutterwave' AND provider_payment_ref = ? LIMIT 1`).bind(txRef).first();
if (existingTransaction?.status === "successful") return json({ ok: true, duplicate: true });
let userId = existingTransaction?.user_id || null;
let subscriptionId = existingTransaction?.subscription_id || null;
if (!userId) {
const email = String(verified.customer?.email || event.data?.customer?.email || "").trim().toLowerCase();
if (!email) return json({ ok: true, ignored: true, reason: "Customer email missing" });
    const account = await env.DB.prepare(`SELECT id FROM users WHERE email = ? AND status = 'active' LIMIT 1`).bind(email).first();
    if (!account) return json({ ok: true, ignored: true, reason: "TradeLab account not found" });

    userId = account.id;

    const activeSub = await env.DB.prepare(`
      SELECT id FROM subscriptions WHERE user_id = ? AND payment_provider = 'flutterwave' AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).bind(userId).first();

    if (!activeSub) return json({ ok: true, ignored: true, reason: "No active Flutterwave subscription for renewal" });
    subscriptionId = activeSub.id;
}
const now = new Date().toISOString();
const transactionId = existingTransaction?.id || randomId(16);
const amountMinor = Math.round(amount * 100);
try {
if (existingTransaction) {
await env.DB.prepare(`UPDATE payment_transactions SET status = 'successful', provider_status = ?, amount_minor = ?, currency = 'USD', paid_at = ?, updated_at = ? WHERE id = ?`)
.bind(gatewayStatus, amountMinor, paidAt, now, transactionId).run();
} else {
await env.DB.prepare(`INSERT INTO payment_transactions (id, user_id, subscription_id, provider, provider_payment_ref, idempotency_key, amount_minor, currency, status, description, provider_status, paid_at, created_at, updated_at) VALUES (?, ?, ?, 'flutterwave', ?, ?, ?, 'USD', 'successful', 'TradeLab AI hourly subscription renewal', ?, ?, ?, ?)`).bind(transactionId, userId, subscriptionId, txRef, randomId(32), amountMinor, gatewayStatus, paidAt, now, now).run();
}
    const subscription = await env.DB.prepare(`SELECT current_period_end, status FROM subscriptions WHERE id = ? AND user_id = ?`)
      .bind(subscriptionId, userId).first();

    if (!subscription) return json({ error: "Subscription record not found" }, 500);

    const previousEnd = subscription.current_period_end ? Date.parse(subscription.current_period_end) : 0;
    const periodStartMs = Math.max(Date.parse(paidAt), Number.isFinite(previousEnd) ? previousEnd : 0);
    const periodStart = new Date(periodStartMs).toISOString();
    const periodEnd = new Date(periodStartMs + BILLING_INTERVAL_SECONDS * 1000).toISOString();

    await env.DB.batch([
      env.DB.prepare(`UPDATE subscriptions SET status = 'active', payment_provider = 'flutterwave', current_period_start = ?, current_period_end = ?, next_billing_at = ?, grace_period_end = NULL, updated_at = ? WHERE id = ? AND user_id = ?`)
        .bind(periodStart, periodEnd, periodEnd, now, subscriptionId, userId),
      env.DB.prepare(`INSERT INTO billing_audit_log (id, user_id, subscription_id, transaction_id, event_type, details_json) VALUES (?, ?, ?, ?, 'flutterwave_payment_verified', ?)`)
        .bind(randomId(16), userId, subscriptionId, transactionId, JSON.stringify({ txRef, amount, currency, gatewayTransactionId: String(verified.id), paidAt }))
    ]);
} catch (error) {
console.error("Unable to record verified Flutterwave payment:", error.message);
return json({ error: "Payment verified but subscription update failed" }, 503);
}
return json({ ok: true, verified: true });
}
/* =========================================
CANCEL SUBSCRIPTION
========================================= */
async function cancelBillingSubscription(request, env, user) {
let body;
try {
body = await readJson(request);
} catch {
return json({ error: "Invalid request body" }, 400);
}
const subscriptionId = String(body.subscription_id || "").trim();
if (!/^[a-f0-9]{32}$/.test(subscriptionId)) {
return json({ error: "Invalid subscription ID" }, 400);
}
const subscription = await env.DB.prepare(`SELECT id, user_id, status, cancel_at_period_end FROM subscriptions WHERE id = ? AND user_id = ?`).bind(subscriptionId, user.id).first();
if (!subscription) {
return json({ error: "Subscription not found" }, 404);
}
if (subscription.status === "cancelled") {
return json({
ok: true,
message: "Subscription is already cancelled.",
status: "cancelled"
});
}
if (subscription.status === "pending") {
try {
await env.DB.batch([
env.DB.prepare(`UPDATE subscriptions SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND status = 'pending'`).bind(subscriptionId, user.id),
        env.DB.prepare(`
          UPDATE payment_transactions
          SET status = 'cancelled',
              provider_status = 'subscription_cancelled_before_payment',
              updated_at = CURRENT_TIMESTAMP
          WHERE subscription_id = ?
            AND user_id = ?
            AND status = 'pending'
        `).bind(subscriptionId, user.id),

        env.DB.prepare(`
          INSERT INTO billing_audit_log (
            id, user_id, subscription_id,
            transaction_id, event_type, details_json
          )
          VALUES (?, ?, ?, NULL, 'subscription_cancelled', ?)
        `).bind(
          randomId(16),
          user.id,
          subscriptionId,
          JSON.stringify({
            reason: "User cancelled pending subscription",
            paymentMade: false
          })
        )
      ]);

      return json({
        ok: true,
        message: "Pending subscription cancelled. No payment was taken.",
        status: "cancelled"
      });

    } catch (error) {
      console.error("Pending subscription cancellation failed:", error.message);
      return json({ error: "Unable to cancel subscription." }, 500);
    }
}
if (subscription.status === "active") {
if (Number(subscription.cancel_at_period_end) === 1) {
return json({
ok: true,
message: "Subscription is already scheduled for cancellation.",
status: "active",
cancelAtPeriodEnd: true
});
}
    if (!env.FLW_SECRET_KEY) {
      return json({ error: "Flutterwave cancellation is not configured. No changes were made." }, 503);
    }

    let providerSubscription;
    try {
      const lookupUrl = new URL("https://api.flutterwave.com/v3/subscriptions");
      lookupUrl.searchParams.set("email", user.email);
      lookupUrl.searchParams.set("plan", String(FLW_PAYMENT_PLAN_ID));
      lookupUrl.searchParams.set("page", "1");

      const lookupResponse = await fetch(lookupUrl.toString(), {
        headers: { Authorization: `Bearer ${env.FLW_SECRET_KEY}`, Accept: "application/json" },
        signal: AbortSignal.timeout(15000)
      });

      const lookupData = await lookupResponse.json();

      if (!lookupResponse.ok || lookupData.status !== "success" || !Array.isArray(lookupData.data)) {
        throw new Error(lookupData.message || "Unable to locate Flutterwave subscription");
      }

      const matching = lookupData.data
        .filter(item =>
          String(item.customer?.customer_email || "").trim().toLowerCase() === user.email.toLowerCase() &&
          String(item.plan) === String(FLW_PAYMENT_PLAN_ID)
        )
        .sort((a, b) => Date.parse(b.created_at || 0) - Date.parse(a.created_at || 0));

      providerSubscription = matching.find(item => String(item.status).toLowerCase() === "active") ||
        matching.find(item => String(item.status).toLowerCase() === "cancelled");

      if (!providerSubscription?.id) {
        throw new Error("No matching Flutterwave customer subscription was found");
      }

      if (String(providerSubscription.status).toLowerCase() === "active") {
        const cancelResponse = await fetch(
          `https://api.flutterwave.com/v3/subscriptions/${encodeURIComponent(providerSubscription.id)}/cancel`,
          {
            method: "PUT",
            headers: {
              Authorization: `Bearer ${env.FLW_SECRET_KEY}`,
              "Content-Type": "application/json",
              Accept: "application/json"
            },
            signal: AbortSignal.timeout(15000)
          }
        );

        const cancelData = await cancelResponse.json();

        if (!cancelResponse.ok || cancelData.status !== "success") {
          throw new Error(cancelData.message || "Flutterwave rejected subscription cancellation");
        }
      }
    } catch (error) {
      console.error("Flutterwave subscription cancellation failed:", error.message);
      return json({
        error: "Flutterwave could not confirm cancellation. Your local subscription was not changed.",
        message: "Please retry or cancel the subscription from your Flutterwave dashboard."
      }, 502);
    }

    try {
      await env.DB.batch([
        env.DB.prepare(`
          UPDATE subscriptions
          SET cancel_at_period_end = 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND status = 'active'
        `).bind(subscriptionId, user.id),

        env.DB.prepare(`
          INSERT INTO billing_audit_log (
            id, user_id, subscription_id,
            transaction_id, event_type, details_json
          )
          VALUES (?, ?, ?, NULL, 'subscription_cancellation_scheduled', ?)
        `).bind(
          randomId(16),
          user.id,
          subscriptionId,
          JSON.stringify({
            cancelAtPeriodEnd: true,
            flutterwaveSubscriptionId: String(providerSubscription.id),
            providerStatus: String(providerSubscription.status)
          })
        )
      ]);

      return json({
        ok: true,
        message: "Cancellation scheduled for the end of the current billing period.",
        status: "active",
        cancelAtPeriodEnd: true
      });

    } catch (error) {
      console.error("Active subscription cancellation failed:", error.message);
      return json({ error: "Unable to schedule subscription cancellation." }, 500);
    }
}
return json({
error: "This subscription cannot be cancelled in its current state.",
status: subscription.status
}, 409);
}
/* =========================================
BILLING ROUTES
========================================= */
async function handleBilling(request, env, url) {
const path = url.pathname;
const user = await getAuthenticatedUser(request, env);
if (!user) {
return json({
ok: false,
error: "Authentication required"
}, 401);
}
if (request.method === "POST" && !validOrigin(request, url)) {
return json({ error: "Request origin rejected" }, 403);
}
if (path === "/api/billing/status") {
if (request.method !== "GET") {
return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
}
    try {
      return json(await getBillingStatus(env, user));
    } catch (error) {
      console.error("Billing status error:", error.message);
      return json({ error: "Unable to retrieve billing status." }, 500);
    }
}
if (path === "/api/billing/transactions") {
if (request.method !== "GET") {
return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
}
    try {
      return await getBillingTransactions(request, env, user);
    } catch (error) {
      console.error("Billing transactions error:", error.message);
      return json({ error: "Unable to retrieve payment history." }, 500);
    }
}
if (path === "/api/billing/subscribe") {
if (request.method !== "POST") {
return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
}
    return createBillingSubscription(request, env, user);
}
if (path === "/api/billing/cancel") {
if (request.method !== "POST") {
return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
}
    return cancelBillingSubscription(request, env, user);
}
return json({ error: "Billing route not found" }, 404);
}
/* =========================================
TWELVE DATA MARKET CONNECTION
========================================= */
/* =========================================
MT5 BRIDGE DATA ACCESS
========================================= */
const MT5_TIMEFRAMES = new Set(["1min", "5min", "15min", "30min", "1h", "4h", "1day"]);
const MT5_QUOTE_MAX_AGE_MS = 15000;

async function readMT5Quote(env, symbol = "US30") {
  if (!env.DB) throw new Error("Market database is not configured.");
  const row = await env.DB.prepare(`
    SELECT symbol, broker_symbol, bid, ask, last, timestamp_ms, received_at_ms
    FROM mt5_market_quotes WHERE symbol = ? LIMIT 1
  `).bind(symbol).first();
  if (!row) return null;
  const ageMs = Date.now() - Number(row.received_at_ms);
  const sourceAgeMs = Date.now() - Number(row.timestamp_ms);
  if (!Number.isFinite(ageMs) || !Number.isFinite(sourceAgeMs) || ageMs < -30000 || sourceAgeMs < -30000 || ageMs > MT5_QUOTE_MAX_AGE_MS || sourceAgeMs > MT5_QUOTE_MAX_AGE_MS) return null;
  return { ...row, ageMs: Math.max(0, sourceAgeMs) };
}

async function readMT5Candles(env, symbol, interval, outputsize) {
  if (!env.DB) throw new Error("Market database is not configured.");
  const result = await env.DB.prepare(`
    SELECT candle_time_ms, open, high, low, close, tick_volume, spread, real_volume
    FROM mt5_market_candles
    WHERE symbol = ? AND timeframe = ?
    ORDER BY candle_time_ms DESC LIMIT ?
  `).bind(symbol, interval, outputsize).all();
  const rows = Array.isArray(result?.results) ? result.results : [];
  return rows.reverse().map(row => ({
    time: new Date(Number(row.candle_time_ms)).toISOString(),
    open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close),
    volume: Number(row.tick_volume || 0), tickVolume: Number(row.tick_volume || 0),
    spread: Number(row.spread || 0), realVolume: Number(row.real_volume || 0)
  }));
}

async function handleMT5BridgeIngest(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405, { Allow: "POST" });
  const configuredToken = String(env.MT5_BRIDGE_TOKEN || "").trim();
  const suppliedToken = String(request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!configuredToken || !constantTimeEqual(suppliedToken, configuredToken)) {
    return json({ ok: false, error: "Unauthorized bridge request." }, 401);
  }
  if (!env.DB) return json({ ok: false, error: "Market database is not configured." }, 503);
  const declaredLength = Number(request.headers.get("Content-Length") || 0);
  if (declaredLength > 512000) return json({ ok: false, error: "Payload is too large." }, 413);
  let raw;
  try { raw = await request.text(); } catch { return json({ ok: false, error: "Invalid request body." }, 400); }
  if (raw.length > 512000) return json({ ok: false, error: "Payload is too large." }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ ok: false, error: "Malformed JSON payload." }, 400); }

  const symbol = String(body?.symbol || "").toUpperCase();
  const brokerSymbol = String(body?.brokerSymbol || "").trim();
  if (symbol !== "US30" || !brokerSymbol || brokerSymbol.length > 32) {
    return json({ ok: false, error: "Only the configured US30 MT5 instrument is accepted." }, 400);
  }

  let quoteStored = false;
  if (body.quote !== undefined && body.quote !== null) {
    const q = body.quote;
    const bid = Number(q.bid), ask = Number(q.ask), last = Number(q.last), timestampMs = Number(q.timestampMs);
    if (![bid, ask, last, timestampMs].every(Number.isFinite) || bid <= 0 || ask <= 0 || last <= 0 || ask < bid || timestampMs <= 0 || timestampMs > Date.now() + 30000 || Date.now() - timestampMs > 120000) {
      return json({ ok: false, error: "Quote failed price or timestamp validation." }, 422);
    }
    await env.DB.prepare(`
      INSERT INTO mt5_market_quotes (symbol, broker_symbol, bid, ask, last, timestamp_ms, received_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol) DO UPDATE SET broker_symbol=excluded.broker_symbol, bid=excluded.bid,
        ask=excluded.ask, last=excluded.last, timestamp_ms=excluded.timestamp_ms, received_at_ms=excluded.received_at_ms
    `).bind(symbol, brokerSymbol, bid, ask, last, Math.floor(timestampMs), Date.now()).run();
    quoteStored = true;
  }

  let candlesStored = 0;
  if (body.candles !== undefined) {
    const timeframe = String(body.timeframe || "");
    if (!MT5_TIMEFRAMES.has(timeframe) || !Array.isArray(body.candles) || body.candles.length > 500) {
      return json({ ok: false, error: "Invalid timeframe or candle batch." }, 422);
    }
    const statements = [];
    for (const c of body.candles) {
      const timeMs = Number(c.timeMs);
      const open = Number(c.open), high = Number(c.high), low = Number(c.low), close = Number(c.close);
      const tickVolume = Math.max(0, Math.floor(Number(c.tickVolume || 0)));
      const spread = Math.max(0, Math.floor(Number(c.spread || 0)));
      const realVolume = Math.max(0, Math.floor(Number(c.realVolume || 0)));
      if (![timeMs, open, high, low, close, tickVolume, spread, realVolume].every(Number.isFinite) || timeMs <= 0 || timeMs > Date.now() + 3600000 || Math.min(open, high, low, close) <= 0 || high < Math.max(open, close, low) || low > Math.min(open, close, high)) {
        return json({ ok: false, error: "Candle batch contains invalid OHLC or timestamp data." }, 422);
      }
      statements.push(env.DB.prepare(`
        INSERT INTO mt5_market_candles (symbol, timeframe, candle_time_ms, open, high, low, close, tick_volume, spread, real_volume, received_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(symbol, timeframe, candle_time_ms) DO UPDATE SET open=excluded.open, high=excluded.high,
          low=excluded.low, close=excluded.close, tick_volume=excluded.tick_volume, spread=excluded.spread,
          real_volume=excluded.real_volume, received_at_ms=excluded.received_at_ms
      `).bind(symbol, timeframe, Math.floor(timeMs), open, high, low, close, tickVolume, spread, realVolume, Date.now()));
    }
    if (statements.length) await env.DB.batch(statements);
    candlesStored = statements.length;
  }
  if (!quoteStored && candlesStored === 0) return json({ ok: false, error: "No market data was supplied." }, 400);
  return json({ ok: true, symbol, brokerSymbol, quoteStored, candlesStored, receivedAt: new Date().toISOString() });
}

/* =========================================
MARKET DATA API
PROVIDER FAILOVER ENABLED
========================================= */
async function handleMarket(request, env, url) {
if (
url.pathname !== "/api/market" &&
url.pathname !== "/api/candles"
) {
return null;
}
if (request.method !== "GET") {
return json(
{ error: "Method not allowed" },
405,
{ Allow: "GET" }
);
}
const symbol = url.searchParams.get("symbol")
?.toUpperCase()
.replace("/", "");
const isMT5US30 = symbol === "US30";
const providerSymbol = isMT5US30 ? "US30" : SYMBOLS[symbol];
if (!providerSymbol) {
return json({
ok: false,
error: "Unsupported symbol"
}, 400);
}
if (isMT5US30 && url.pathname === "/api/market") {
  try {
    const quote = await readMT5Quote(env, "US30");
    if (!quote) return json({ ok: false, status: "STALE", source: "MT5", error: "US30 MT5 quote is unavailable or stale. Check that the MT5 bridge EA is running." }, 503);
    return json({ ok: true, symbol: "US30", brokerSymbol: quote.broker_symbol, price: Number(quote.last), bid: Number(quote.bid), ask: Number(quote.ask), status: "LIVE", source: "MT5", timestamp: new Date(Number(quote.timestamp_ms)).toISOString(), receivedAt: new Date(Number(quote.received_at_ms)).toISOString(), ageMs: quote.ageMs });
  } catch (error) {
    console.error("MT5 US30 quote read failed:", error.message);
    return json({ ok: false, status: "ERROR", source: "MT5", error: "Unable to read the US30 MT5 quote." }, 503);
  }
}
/* =====================================
LIVE PRICE
GET /api/market
===================================== */
if (url.pathname === "/api/market") {
try {
const result = await marketGetPrice(
providerSymbol,
env
);
      return json({
        ok: true,
        symbol,
        providerSymbol,
        price: result.price,
        status: "LIVE",
        source: result.source,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(
        "All live market providers failed:",
        error.message
      );

      return json({
        ok: false,
        status: "ERROR",
        error: "Unable to retrieve live market data",
        timestamp: new Date().toISOString()
      }, 502);
    }
}
/* =====================================
HISTORICAL CANDLES
GET /api/candles
===================================== */
if (url.pathname === "/api/candles") {
const interval =
url.searchParams.get("interval") || "5min";
    if (!ALLOWED_INTERVALS.includes(interval)) {
      return json({
        ok: false,
        error: "Unsupported interval",
        allowedIntervals: ALLOWED_INTERVALS
      }, 400);
    }

    const requested = Number(
      url.searchParams.get("outputsize") || 100
    );

    const outputsize = Math.min(
      500,
      Math.max(
        1,
        Number.isFinite(requested)
          ? Math.floor(requested)
          : 100
      )
    );

    try {
      if (isMT5US30) {
        const candles = await readMT5Candles(env, "US30", interval, outputsize);
        if (!candles.length) return json({ ok: false, status: "WAITING", source: "MT5", error: `No ${interval} MT5 candles are stored yet. Keep the TradeLab MT5 bridge EA running to import history.` }, 503);
        return json({ ok: true, symbol: "US30", providerSymbol: "US30", brokerSymbol: "US30", interval, count: candles.length, candles, latestCandleAt: candles[candles.length - 1].time, status: "LIVE", source: "MT5", timestamp: new Date().toISOString() });
      }
      const result = await marketGetCandles(
        providerSymbol,
        interval,
        outputsize,
        env
      );

      const candles = result.candles;

      if (!candles.length) {
        return json({
          ok: false,
          status: "ERROR",
          error: "No valid historical candles were returned"
        }, 502);
      }

      return json({
        ok: true,
        symbol,
        providerSymbol,
        interval,
        count: candles.length,
        candles,
        latestCandleAt: candles[candles.length - 1].time,
        status: "LIVE",
        source: result.source,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error(
        "Historical market providers failed:",
        error.message
      );

      return json({
        ok: false,
        status: "ERROR",
        error: "Unable to retrieve historical market data",
        timestamp: new Date().toISOString()
      }, 502);
    }
}
return null;
}

/* =========================================
PHASE 6 — SIGNAL RECORDING AND OUTCOME VALIDATION
========================================= */
async function settlePendingSignalEvents(env, userId) {
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const pending = await env.DB.prepare(`
    SELECT id, symbol, timeframe, signal, entry, stop_loss,
           take_profit_json, generated_at
    FROM ai_signal_events
    WHERE user_id = ? AND status = 'PENDING'
      AND (last_checked_at IS NULL OR last_checked_at < ?)
    ORDER BY generated_at DESC
    LIMIT 10
  `).bind(userId, cutoff).all();

  for (const event of pending.results || []) {
    const providerSymbol = SYMBOLS[String(event.symbol || '').toUpperCase()];
    if (!providerSymbol || !ALLOWED_INTERVALS.includes(event.timeframe)) continue;
    try {
      const candlesResult = await marketGetCandles(
        providerSymbol, event.timeframe, 500, env
      );
      const generatedAt = Date.parse(event.generated_at);
      const entry = Number(event.entry);
      const stop = Number(event.stop_loss);
      const targets = JSON.parse(event.take_profit_json || '[]');
      const target1 = Number(Array.isArray(targets) ? targets[0] : targets?.TP1);
      if (!Number.isFinite(generatedAt) || !Number.isFinite(entry) ||
          !Number.isFinite(stop) || !Number.isFinite(target1)) continue;

      const resolution = resolveSignalOutcome(event, candlesResult.candles);

      const checkedAt = new Date().toISOString();
      if (resolution) {
        await env.DB.prepare(`
          UPDATE ai_signal_events
          SET status = ?, outcome = ?, exit_price = ?, r_multiple = ?,
              resolved_at = ?, resolution_reason = ?, last_checked_at = ?
          WHERE id = ? AND user_id = ? AND status = 'PENDING'
        `).bind(
          resolution.status, resolution.outcome, resolution.exitPrice,
          resolution.rMultiple,
          resolution.status === 'RESOLVED' ? checkedAt : null,
          resolution.reason, checkedAt, event.id, userId
        ).run();
      } else {
        await env.DB.prepare(`
          UPDATE ai_signal_events SET last_checked_at = ?
          WHERE id = ? AND user_id = ? AND status = 'PENDING'
        `).bind(checkedAt, event.id, userId).run();
      }
    } catch (error) {
      console.warn('Signal outcome validation deferred:', event.id, error.message);
    }
  }
}

async function getSignalPerformance(env, user, url) {
  const requestedLimit = Number(url.searchParams.get('limit') || 100);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(100, Math.max(1, requestedLimit)) : 100;
  try {
    await settlePendingSignalEvents(env, user.id);
    const result = await env.DB.prepare(`
      SELECT id, symbol, timeframe, signal, confluence, entry, stop_loss,
             take_profit_json, generated_at, status, outcome, exit_price,
             r_multiple, resolved_at, resolution_reason
      FROM ai_signal_events
      WHERE user_id = ?
      ORDER BY generated_at DESC
      LIMIT ?
    `).bind(user.id, limit).all();
    const events = result.results || [];
    const aggregate = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'RESOLVED' AND outcome IN ('WIN', 'LOSS') THEN 1 ELSE 0 END) AS resolved,
        SUM(CASE WHEN status = 'RESOLVED' AND outcome = 'WIN' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN status = 'RESOLVED' AND outcome = 'LOSS' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'AMBIGUOUS' THEN 1 ELSE 0 END) AS ambiguous,
        SUM(CASE WHEN status = 'RESOLVED' THEN COALESCE(r_multiple, 0) ELSE 0 END) AS total_r,
        AVG(CASE WHEN status = 'RESOLVED' THEN r_multiple ELSE NULL END) AS average_r
      FROM ai_signal_events WHERE user_id = ?
    `).bind(user.id).first();
    const resolvedCount = Number(aggregate?.resolved || 0);
    const wins = Number(aggregate?.wins || 0);
    const metrics = {
      total: Number(aggregate?.total || 0),
      resolved: resolvedCount,
      wins,
      losses: Number(aggregate?.losses || 0),
      pending: Number(aggregate?.pending || 0),
      ambiguous: Number(aggregate?.ambiguous || 0),
      winRate: resolvedCount ? Number((wins / resolvedCount * 100).toFixed(2)) : null,
      averageR: resolvedCount ? Number(Number(aggregate.average_r || 0).toFixed(3)) : null,
      totalR: Number(Number(aggregate?.total_r || 0).toFixed(3))
    };
    return json({ ok: true, events, metrics, validation: 'TP1 (+1R) versus stop-loss (-1R)' });
  } catch (error) {
    console.error('Signal performance retrieval failed:', error.message);
    return json({
      ok: false,
      error: 'Signal performance storage is not configured. Apply the Phase 6 D1 migration first.'
    }, 503);
  }
}

/* =========================================
AI SIGNAL API
========================================= */
async function handleAISignals(request, env, url, user) {
const path = url.pathname;
if (path === "/api/ai/signals") {
if (request.method !== "GET") {
return json({
ok: false,
error: "Method not allowed"
}, 405, { Allow: "GET" });
}
    const symbol = String(
      url.searchParams.get("symbol") || ""
    ).toUpperCase().replace("/", "");

    const timeframe = String(
      url.searchParams.get("timeframe") || "15min"
    ).toLowerCase();

    const providerSymbol = SYMBOLS[symbol];

    if (!providerSymbol) {
      return json({
        ok: false,
        error: "Unsupported market symbol"
      }, 400);
    }

    if (!AI_SIGNAL_TIMEFRAMES.includes(timeframe)) {
      return json({
        ok: false,
        error: "Unsupported signal timeframe",
        allowedTimeframes: AI_SIGNAL_TIMEFRAMES
      }, 400);
    }

    try {
      const signal = await aiGenerateSignal(
        symbol,
        providerSymbol,
        timeframe,
        env
      );

      // History is optional. The signal endpoint remains functional
      // even when the optional history table has not been created.
      if (env.DB) {
        try {
          await env.DB.prepare(`
            INSERT INTO ai_signal_history (
              id,
              user_id,
              symbol,
              timeframe,
              signal,
              confidence,
              entry,
              stop_loss,
              take_profit_json,
              generated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            crypto.randomUUID(),
            user.id,
            symbol,
            timeframe,
            signal.signal,
            signal.confidence,
            signal.entry,
            signal.stopLoss,
            JSON.stringify(signal.takeProfit),
            signal.generatedAt
          ).run();

        } catch (historyError) {
          console.warn(
            "AI signal history not saved:",
            historyError.message
          );
        }
      }

      return json(signal);

    } catch (error) {
      console.error(
        "AI signal generation failed:",
        error.message
      );

      return json({
        ok: false,
        error: "Unable to generate AI trading signal",
        symbol,
        timeframe
      }, 502);
    }
}
/* =====================================
SIGNAL HISTORY
GET /api/ai/signals/history
===================================== */
if (path === "/api/ai/signals/history") {
if (request.method !== "GET") {
return json({
ok: false,
error: "Method not allowed"
}, 405, { Allow: "GET" });
}
    if (!env.DB) {
      return json({
        ok: true,
        history: [],
        message: "Signal history database is unavailable"
      });
    }

    const requestedLimit = Number(
      url.searchParams.get("limit") || 50
    );

    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(100, Math.max(1, requestedLimit))
      : 50;

    try {
      const result = await env.DB.prepare(`
        SELECT
          id,
          symbol,
          timeframe,
          signal,
          confidence,
          entry,
          stop_loss,
          take_profit_json,
          generated_at
        FROM ai_signal_history
        WHERE user_id = ?
        ORDER BY generated_at DESC
        LIMIT ?
      `).bind(
        user.id,
        limit
      ).all();

      return json({
        ok: true,
        history: result.results || []
      });

    } catch (error) {
      console.warn(
        "AI signal history unavailable:",
        error.message
      );

      return json({
        ok: true,
        history: [],
        message: "Signal history table is not configured"
      });
    }
}
if (path === "/api/ai/signals/record") {
    if (request.method !== 'POST') return json({ ok: false, error: 'Method not allowed' }, 405, { Allow: 'POST' });
    if (!validOrigin(request, url)) return json({ error: 'Request origin rejected' }, 403);
    let body;
    try { body = await readJson(request); }
    catch { return json({ ok: false, error: 'Invalid signal payload' }, 400); }

    const validated = validateSignalRecord(body, { allowedSymbols: Object.keys(SYMBOLS) });
    if (!validated.ok) return json({ ok: false, error: validated.error }, 400);
    const { symbol, timeframe, signal, confluence, entry, stopLoss, takeProfit, engineId } = validated.value;
    const timestamp = validated.value.generatedAt;
    const id = crypto.randomUUID();
    try {
      await env.DB.prepare(`
        INSERT INTO ai_signal_events (
          id, user_id, symbol, timeframe, signal, confluence, entry,
          stop_loss, take_profit_json, generated_at, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
        ON CONFLICT(user_id, symbol, timeframe, signal, generated_at) DO NOTHING
      `).bind(
        id, user.id, symbol, timeframe, signal, Math.round(confluence),
        entry, stopLoss, JSON.stringify(takeProfit), timestamp
      ).run();
      const saved = await env.DB.prepare(`
        SELECT id, status FROM ai_signal_events
        WHERE user_id = ? AND symbol = ? AND timeframe = ? AND signal = ? AND generated_at = ?
        LIMIT 1
      `).bind(user.id, symbol, timeframe, signal, timestamp).first();
      return json({ ok: true, id: saved?.id || id, status: saved?.status || 'PENDING', duplicate: saved?.id !== id, engineId });
    } catch (error) {
      console.error('Signal event recording failed:', error.message);
      return json({ ok: false, error: 'Signal history storage is not configured. Apply the Phase 6 D1 migration first.' }, 503);
    }
}
if (path === "/api/ai/signals/performance") {
    if (request.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405, { Allow: 'GET' });
    return getSignalPerformance(env, user, url);
}
return json({
ok: false,
error: "AI signal route not found"
}, 404);
}
/* =========================================
TRADELAB AI SIGNAL ENGINE
TECHNICAL ANALYSIS CORE
========================================= */
const AI_SIGNAL_DEFAULT_CANDLES = 200;
const AI_SIGNAL_MIN_CANDLES = 60;
const AI_SIGNAL_TIMEFRAMES = [
"5min",
"15min",
"30min",
"1h",
"4h",
"1day"
];

/* =========================================
EXPONENTIAL MOVING AVERAGE
========================================= */
function aiEMA(values, period) {
if (!Array.isArray(values) || values.length < period) {
return null;
}
const multiplier = 2 / (period + 1);
let ema = values
.slice(0, period)
.reduce((sum, value) => sum + value, 0) / period;
for (let i = period; i < values.length; i++) {
ema =
(values[i] - ema) * multiplier +
ema;
}
return ema;
}

/* =========================================
RELATIVE STRENGTH INDEX
========================================= */
function aiRSI(values, period = 14) {
if (values.length <= period) return null;
let gains = 0;
let losses = 0;
for (let i = 1; i <= period; i++) {
const change = values[i] - values[i - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
}
let averageGain = gains / period;
let averageLoss = losses / period;
for (let i = period + 1; i < values.length; i++) {
const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);

    averageGain =
      ((averageGain * (period - 1)) + gain) / period;

    averageLoss =
      ((averageLoss * (period - 1)) + loss) / period;
}
if (averageLoss === 0) return 100;
const relativeStrength = averageGain / averageLoss;
return 100 - (100 / (1 + relativeStrength));
}

/* =========================================
AVERAGE TRUE RANGE
========================================= */
function aiATR(candles, period = 14) {
if (candles.length <= period) return null;
const ranges = [];
for (let i = 1; i < candles.length; i++) {
const current = candles[i];
const previous = candles[i - 1];
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );

    ranges.push(trueRange);
}
if (ranges.length < period) return null;
let atr = ranges
.slice(0, period)
.reduce((sum, value) => sum + value, 0) / period;
for (let i = period; i < ranges.length; i++) {
atr =
((atr * (period - 1)) + ranges[i]) / period;
}
return atr;
}

/* =========================================
MACD
========================================= */
function aiMACD(values) {
if (values.length < 35) return null;
const fast = [];
const slow = [];
for (let i = 0; i < values.length; i++) {
const subset = values.slice(0, i + 1);
    fast.push(aiEMA(subset, 12));
    slow.push(aiEMA(subset, 26));
}
const macdValues = [];
for (let i = 0; i < values.length; i++) {
if (
fast[i] === null ||
slow[i] === null
) {
continue;
}
    macdValues.push(fast[i] - slow[i]);
}
if (macdValues.length < 9) return null;
const signal = aiEMA(macdValues, 9);
const currentMACD =
macdValues[macdValues.length - 1];
const previousMACD =
macdValues[macdValues.length - 2];
if (signal === null) return null;
return {
macd: currentMACD,
signal,
histogram: currentMACD - signal,
previousMACD
};
}

/* =========================================
SUPPORT AND RESISTANCE
========================================= */
function aiSupportResistance(candles, lookback = 30) {
const recent = candles.slice(-lookback);
if (!recent.length) return null;
const support = Math.min(
...recent.map(candle => candle.low)
);
const resistance = Math.max(
...recent.map(candle => candle.high)
);
return {
support,
resistance
};
}

/* =========================================
ANALYSE ONE TIMEFRAME
========================================= */
function aiAnalyseTimeframe(candles) {
if (
!Array.isArray(candles) ||
candles.length < AI_SIGNAL_MIN_CANDLES
) {
throw new Error("Insufficient candle data for analysis");
}
const closes = candles.map(candle => candle.close);
const currentPrice = closes[closes.length - 1];
const ema9 = aiEMA(closes, 9);
const ema21 = aiEMA(closes, 21);
const ema50 = aiEMA(closes, 50);
const rsi = aiRSI(closes, 14);
const atr = aiATR(candles, 14);
const macd = aiMACD(closes);
const levels = aiSupportResistance(candles, 30);
if (
!Number.isFinite(currentPrice) ||
!Number.isFinite(ema9) ||
!Number.isFinite(ema21) ||
!Number.isFinite(ema50) ||
!Number.isFinite(rsi) ||
!Number.isFinite(atr) ||
!macd ||
!levels
) {
throw new Error("Unable to calculate technical indicators");
}
let bullishScore = 0;
let bearishScore = 0;
const reasons = [];
/* EMA TREND */
if (ema9 > ema21 && ema21 > ema50) {
bullishScore += 2;
reasons.push("Bullish EMA alignment");
} else if (ema9 < ema21 && ema21 < ema50) {
bearishScore += 2;
reasons.push("Bearish EMA alignment");
}
/* PRICE POSITION */
if (currentPrice > ema50) {
bullishScore += 1;
reasons.push("Price above EMA 50");
} else if (currentPrice < ema50) {
bearishScore += 1;
reasons.push("Price below EMA 50");
}
/* RSI MOMENTUM */
if (rsi >= 52 && rsi <= 70) {
bullishScore += 1;
reasons.push("Bullish RSI momentum");
} else if (rsi <= 48 && rsi >= 30) {
bearishScore += 1;
reasons.push("Bearish RSI momentum");
}
/* MACD MOMENTUM */
if (
macd.histogram > 0 &&
macd.macd > macd.signal
) {
bullishScore += 2;
reasons.push("Bullish MACD momentum");
} else if (
macd.histogram < 0 &&
macd.macd < macd.signal
) {
bearishScore += 2;
reasons.push("Bearish MACD momentum");
}
/* SIGNAL DIRECTION */
let direction = "HOLD";
if (bullishScore >= 4 && bullishScore > bearishScore) {
direction = "BUY";
} else if (
bearishScore >= 4 &&
bearishScore > bullishScore
) {
direction = "SELL";
}
return {
direction,
currentPrice,
bullishScore,
bearishScore,
rsi,
ema9,
ema21,
ema50,
atr,
macd,
support: levels.support,
resistance: levels.resistance,
reasons
};
}

/* =========================================
BUILD ENTRY, STOP LOSS AND TARGETS
========================================= */
function aiBuildTradeLevels(analysis) {
const entry = analysis.currentPrice;
const atr = analysis.atr;
if (
!Number.isFinite(entry) ||
!Number.isFinite(atr) ||
entry <= 0 ||
atr <= 0
) {
return null;
}
const direction = analysis.direction;
if (direction === "HOLD") {
return {
entry,
stopLoss: null,
takeProfit: [],
riskReward: []
};
}
const riskDistance = atr * 1.5;
const stopLoss = direction === "BUY"
? entry - riskDistance
: entry + riskDistance;
const targets = [1, 2, 3].map(multiplier =>
direction === "BUY"
? entry + riskDistance * multiplier
: entry - riskDistance * multiplier
);
return {
entry,
stopLoss,
takeProfit: targets.map((price, index) => ({
level: `TP${index + 1}`,
price,
riskReward: index + 1
})),
riskReward: [1, 2, 3]
};
}

/* =========================================
CONFIDENCE SCORE
========================================= */
function aiCalculateConfidence(
primary,
confirmations
) {
const maximumScore = 6;
const primaryScore = Math.max(
primary.bullishScore,
primary.bearishScore
);
const primaryConfidence = Math.min(
85,
(primaryScore / maximumScore) * 85
);
if (primary.direction === "HOLD") {
return Math.round(
Math.min(45, primaryConfidence)
);
}
const matching = confirmations.filter(
item => item.direction === primary.direction
).length;
const confirmationBonus =
confirmations.length
? (matching / confirmations.length) * 15
: 0;
return Math.round(
Math.min(
95,
primaryConfidence + confirmationBonus
)
);
}

/* =========================================
COMPLETE SIGNAL GENERATION
========================================= */
async function aiGenerateSignal(
symbol,
providerSymbol,
timeframe,
env
) {
const primaryData = await marketGetCandles(
providerSymbol,
timeframe,
AI_SIGNAL_DEFAULT_CANDLES,
env
);
const primaryCandles = primaryData.candles;
if (primaryCandles.length < AI_SIGNAL_MIN_CANDLES) {
throw new Error("Not enough candles to generate a signal");
}
const primary = aiAnalyseTimeframe(primaryCandles);
const confirmationTimeframes = {
"5min": ["15min", "1h"],
"15min": ["1h", "4h"],
"30min": ["1h", "4h"],
"1h": ["4h", "1day"],
"4h": ["1day"],
"1day": ["4h"]
};
const confirmationIntervals =
confirmationTimeframes[timeframe] || [];
const confirmations = [];
for (const confirmationTimeframe of confirmationIntervals) {
try {
const data = await marketGetCandles(
providerSymbol,
confirmationTimeframe,
AI_SIGNAL_DEFAULT_CANDLES,
env
);
      if (data.candles.length >= AI_SIGNAL_MIN_CANDLES) {
        const analysis = aiAnalyseTimeframe(data.candles);

        confirmations.push({
          timeframe: confirmationTimeframe,
          direction: analysis.direction
        });
      }
    } catch (error) {
      console.warn(
        "AI confirmation timeframe unavailable:",
        confirmationTimeframe,
        error.message
      );
    }
}
const confidence = aiCalculateConfidence(
primary,
confirmations
);
const levels = aiBuildTradeLevels(primary);
const matchingConfirmations = confirmations.filter(
item => item.direction === primary.direction
).length;
const confirmationPassed =
confirmations.length === 0 ||
matchingConfirmations >= Math.ceil(
confirmations.length / 2
);
let finalDirection = primary.direction;
if (
primary.direction !== "HOLD" &&
!confirmationPassed
) {
finalDirection = "HOLD";
}
const finalLevels = finalDirection === "HOLD"
? aiBuildTradeLevels({
...primary,
direction: "HOLD"
})
: levels;
return {
ok: true,
engine: "TradeLab AI Technical Signal Engine",
engineId: "server-technical-baseline-v1",
sourceRole: "reference-only",
model: "Deterministic technical analysis",
symbol,
timeframe,
signal: finalDirection,
originalSignal: primary.direction,
confidence: finalDirection === "HOLD"
? Math.min(confidence, 49)
: confidence,
entry: finalLevels.entry,
stopLoss: finalLevels.stopLoss,
takeProfit: finalLevels.takeProfit,
riskReward: finalLevels.riskReward,
indicators: {
RSI: Number(primary.rsi.toFixed(2)),
EMA9: primary.ema9,
EMA21: primary.ema21,
EMA50: primary.ema50,
ATR: primary.atr,
MACD: primary.macd
},
supportResistance: {
support: primary.support,
resistance: primary.resistance
},
confirmations,
confirmationPassed,
reasons: primary.reasons,
marketDataProvider: primaryData.source,
candleCount: primaryCandles.length,
generatedAt: new Date().toISOString()
};
}
/* =========================================
DERIV OAUTH CONNECTION (AUTHORIZATION CODE + PKCE)
========================================= */
const DERIV_REDIRECT_URI =
"https://tradelabai2.balancesilence11.workers.dev/api/deriv/callback";
const DERIV_AUTH_URL = "https://auth.deriv.com/oauth2/auth";
const DERIV_TOKEN_URL = "https://auth.deriv.com/oauth2/token";
const DERIV_API_BASE = "https://api.derivws.com";
const DERIV_SCOPES = "trade account_manage";
function randomBytes(length) {
return crypto.getRandomValues(new Uint8Array(length));
}
function bytesToBase64Url(bytes) {
let binary = "";
for (const byte of bytes) binary += String.fromCharCode(byte);
return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64ToBytes(value) {
const normalized = String(value).replace(/-/g, "+").replace(/_/g, "/");
const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
const binary = atob(padded);
return Uint8Array.from(binary, character => character.charCodeAt(0));
}
async function sha256Bytes(value) {
return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function encryptDerivToken(env, token) {
if (!env.DERIV_TOKEN_ENCRYPTION_KEY) throw new Error("Deriv encryption key is not configured");
const rawKey = base64ToBytes(env.DERIV_TOKEN_ENCRYPTION_KEY);
if (rawKey.length !== 32) throw new Error("Deriv encryption key must decode to 32 bytes");
const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
const iv = randomBytes(12);
const ciphertext = await crypto.subtle.encrypt(
{ name: "AES-GCM", iv },
key,
encoder.encode(token)
);
return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}
async function decryptDerivToken(env, encrypted) {
if (!env.DERIV_TOKEN_ENCRYPTION_KEY) throw new Error("Deriv encryption key is not configured");
const rawKey = base64ToBytes(env.DERIV_TOKEN_ENCRYPTION_KEY);
if (rawKey.length !== 32) throw new Error("Deriv encryption key must decode to 32 bytes");
const [ivText, ciphertextText] = String(encrypted || "").split(".");
if (!ivText || !ciphertextText) throw new Error("Stored Deriv token is invalid");
const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
const plaintext = await crypto.subtle.decrypt(
{ name: "AES-GCM", iv: base64ToBytes(ivText) },
key,
base64ToBytes(ciphertextText)
);
return new TextDecoder().decode(plaintext);
}
function redirectToApp(message) {
const target = new URL("/", DERIV_REDIRECT_URI);
target.searchParams.set("deriv", message);
return Response.redirect(target.toString(), 302);
}
async function getDerivAccessToken(env, userId) {
const row = await env.DB.prepare(`SELECT access_token, token_expires_at FROM deriv_oauth WHERE user_id = ?`).bind(userId).first();
if (!row?.access_token) return null;
if (row.token_expires_at && Date.parse(row.token_expires_at) <= Date.now()) {
return null;
}
return decryptDerivToken(env, row.access_token);
}
async function derivApiFetch(token, path, options = {}) {
return fetch(`${DERIV_API_BASE}${path}`, {
...options,
headers: {
Authorization: `Bearer ${token}`,
Accept: "application/json",
...(options.headers || {})
},
signal: AbortSignal.timeout(15000)
});
}
/* =========================================
SECURE DERIV DEMO WEBSOCKET PROXY
========================================= */
const DERIV_MAX_STAKE_USD = 10;
const DERIV_ALLOWED_CONTRACTS = new Set(["CALL", "PUT"]);
const DERIV_MAX_WS_MESSAGE_BYTES = 4096;
const DERIV_MAX_PROPOSALS = 100;
const DERIV_PROPOSAL_TTL_MS = 60000;
const DERIV_ALLOWED_WS_ACTIONS = new Set([
"balance",
"portfolio",
"statement",
"ticks",
"contracts_for",
"proposal",
"buy",
"proposal_open_contract",
"forget"
]);
function wsError(socket, code, message, echoReq = undefined) {
try {
socket.send(JSON.stringify({
msg_type: "error",
error: { code, message },
...(echoReq ? { echo_req: echoReq } : {})
}));
} catch {}
}
function validateDerivClientMessage(raw, proposalIds, pendingProposalRequests, discoveredContracts) {
let payload;
try {
const rawText = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    if (new TextEncoder().encode(rawText).byteLength > DERIV_MAX_WS_MESSAGE_BYTES) {
      return { ok: false, code: "MessageTooLarge", message: "Request exceeds the permitted size." };
    }

    payload = JSON.parse(rawText);
} catch {
return { ok: false, code: "InvalidJSON", message: "Invalid or oversized JSON request." };
}
if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
return { ok: false, code: "InvalidRequest", message: "Invalid request format." };
}
const actions = [...DERIV_ALLOWED_WS_ACTIONS].filter(key =>
Object.prototype.hasOwnProperty.call(payload, key)
);
const allowedKeys = new Set([
"req_id", "subscribe", "balance", "portfolio", "statement", "description",
"limit", "offset", "ticks", "contracts_for", "proposal", "amount", "basis",
"contract_type", "currency", "duration", "duration_unit",
"underlying_symbol", "barrier", "barrier2",
"buy", "price", "proposal_open_contract", "contract_id", "forget"
]);
if (actions.length !== 1 || Object.keys(payload).some(key => !allowedKeys.has(key))) {
return {
ok: false,
code: "ActionDenied",
message: "This Deriv request is not permitted.",
echoReq: payload
};
}
if (payload.req_id !== undefined &&
(!Number.isSafeInteger(payload.req_id) || payload.req_id < 1)) {
return {
ok: false,
code: "InvalidRequestId",
message: "Invalid request identifier.",
echoReq: payload
};
}
const action = actions[0];
if (action === "contracts_for") {
const symbol = String(payload.contracts_for || "");
    if (typeof payload.contracts_for !== "string" ||
        !/^[A-Za-z0-9_]{2,32}$/.test(symbol) ||
        !Number.isSafeInteger(payload.req_id)) {
      return {
        ok: false,
        code: "InvalidContractsRequest",
        message: "A valid market symbol and request identifier are required to discover available contracts.",
        echoReq: payload
      };
    }

    if (discoveredContracts.size >= DERIV_MAX_PROPOSALS &&
        !discoveredContracts.has(symbol)) {
      const oldest = discoveredContracts.keys().next().value;
      if (oldest) discoveredContracts.delete(oldest);
    }

    return { ok: true, payload };
}
if (action === "proposal") {
const amount = Number(payload.amount);
const contractType = String(payload.contract_type || "").toUpperCase();
const basis = String(payload.basis || "").toLowerCase();
const currency = String(payload.currency || "").toUpperCase();
const symbol = String(payload.underlying_symbol || "");
const duration = Number(payload.duration);
const unit = String(payload.duration_unit || "");
    const unitLimits = { t: 10, s: 86400, m: 1440, h: 24, d: 365 };
    const available = discoveredContracts.get(symbol);

    const contractAvailable = Array.isArray(available) &&
      available.some(item =>
        String(item.contract_type || "").toUpperCase() === contractType
      );

    const barrier = payload.barrier === undefined || payload.barrier === null
      ? ""
      : String(payload.barrier).trim();

    const barrier2 = payload.barrier2 === undefined || payload.barrier2 === null
      ? ""
      : String(payload.barrier2).trim();

    const validBarrier = value =>
      value !== "" && /^[+-]?\d{1,12}(\.\d{1,8})?$/.test(value);

    const digitContracts = new Set([
      "DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER"
    ]);

    const singleBarrierContracts = new Set([
      "ONETOUCH", "NOTOUCH", "HIGHER", "LOWER"
    ]);

    const rangeContracts = new Set(["RANGE", "EXPIRYRANGE"]);

    if (payload.proposal !== 1 ||
        !/^[A-Z0-9_]{2,32}$/.test(contractType) ||
        !contractAvailable) {
      return {
        ok: false,
        code: "ContractDenied",
        message: "This contract type has not been confirmed as available for the selected market. Refresh the market's available contracts and try again.",
        echoReq: payload
      };
    }

    if (basis !== "stake" ||
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > DERIV_MAX_STAKE_USD ||
        currency !== "USD") {
      return {
        ok: false,
        code: "StakeLimitExceeded",
        message: "Demo stake must be greater than zero and no more than USD 10.",
        echoReq: payload
      };
    }

    if (!/^[A-Za-z0-9_]{2,32}$/.test(symbol) ||
        !unitLimits[unit] ||
        !Number.isInteger(duration) ||
        duration < 1 ||
        duration > unitLimits[unit]) {
      return {
        ok: false,
        code: "ProposalParametersDenied",
        message: "Invalid market symbol or contract duration.",
        echoReq: payload
      };
    }

    if (!Number.isSafeInteger(payload.req_id)) {
      return {
        ok: false,
        code: "RequestIdRequired",
        message: "A valid request identifier is required.",
        echoReq: payload
      };
    }

    if (digitContracts.has(contractType)) {
      if (!/^[0-9]$/.test(barrier) || barrier2 !== "") {
        return {
          ok: false,
          code: "InvalidDigitBarrier",
          message: "Digit contracts require one barrier digit from 0 to 9 and no second barrier.",
          echoReq: payload
        };
      }
    } else if (singleBarrierContracts.has(contractType)) {
      if (!validBarrier(barrier) || barrier2 !== "") {
        return {
          ok: false,
          code: "InvalidBarrier",
          message: "This contract requires one valid price barrier and no second barrier.",
          echoReq: payload
        };
      }
    } else if (rangeContracts.has(contractType)) {
      if (!validBarrier(barrier) ||
          !validBarrier(barrier2) ||
          Number(barrier) >= Number(barrier2)) {
        return {
          ok: false,
          code: "InvalidRangeBarriers",
          message: "Range contracts require two valid price barriers, with the lower barrier below the upper barrier.",
          echoReq: payload
        };
      }
    } else if (barrier !== "" || barrier2 !== "") {
      return {
        ok: false,
        code: "UnexpectedBarrier",
        message: "This contract type does not accept a barrier.",
        echoReq: payload
      };
    }

    if (pendingProposalRequests.size >= DERIV_MAX_PROPOSALS) {
      return {
        ok: false,
        code: "ProposalLimitReached",
        message: "Too many outstanding proposals. Wait and try again.",
        echoReq: payload
      };
    }

    pendingProposalRequests.set(payload.req_id, {
      amount,
      contractType,
      currency,
      symbol,
      barrier,
      barrier2,
      createdAt: Date.now()
    });

    return { ok: true, payload };
}
if (action === "buy") {
const proposalId = String(payload.buy || "");
const price = Number(payload.price);
const record = proposalIds.get(proposalId);
    if (!record || record.expiresAt < Date.now()) {
      proposalIds.delete(proposalId);
      return {
        ok: false,
        code: "ProposalNotAuthorised",
        message: "Proposal is missing, expired or already used. Request a fresh quote.",
        echoReq: payload
      };
    }

    if (!Number.isFinite(price) ||
        price <= 0 ||
        price > DERIV_MAX_STAKE_USD ||
        price > record.askPrice + 0.0000001) {
      return {
        ok: false,
        code: "PurchaseLimitExceeded",
        message: "Purchase price exceeds the authorised proposal price or USD 10 limit.",
        echoReq: payload
      };
    }

    proposalIds.delete(proposalId);
    return { ok: true, payload };
}
if (action === "ticks") {
if (typeof payload.ticks !== "string" ||
!/^[A-Za-z0-9_]{2,32}$/.test(payload.ticks) ||
![0, 1].includes(payload.subscribe)) {
return {
ok: false,
code: "InvalidSubscription",
message: "Invalid tick subscription.",
echoReq: payload
};
}
} else if (action === "balance") {
if (payload.balance !== 1 ||
(payload.subscribe !== undefined && ![0, 1].includes(payload.subscribe))) {
return {
ok: false,
code: "InvalidRequest",
message: "Invalid balance request.",
echoReq: payload
};
}
} else if (action === "portfolio") {
if (payload.portfolio !== 1) {
return { ok: false, code: "InvalidRequest", message: "Invalid portfolio request.", echoReq: payload };
}
} else if (action === "statement") {
const limit = Number(payload.limit ?? 50);
const offset = Number(payload.offset ?? 0);
    if (payload.statement !== 1 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100 ||
        !Number.isInteger(offset) || offset < 0 || offset > 10000) {
      return {
        ok: false,
        code: "InvalidStatementRequest",
        message: "Statement request is outside permitted limits.",
        echoReq: payload
      };
    }
} else if (action === "proposal_open_contract") {
if (payload.proposal_open_contract !== 1 ||
!/^\d{1,24}$/.test(String(payload.contract_id || "")) ||
![0, 1].includes(payload.subscribe)) {
return {
ok: false,
code: "InvalidContractRequest",
message: "Invalid contract monitoring request.",
echoReq: payload
};
}
} else if (action === "forget") {
if (typeof payload.forget !== "string" || payload.forget.length > 128) {
return {
ok: false,
code: "InvalidSubscription",
message: "Invalid subscription identifier.",
echoReq: payload
};
}
}
return { ok: true, payload };
}
async function handleDerivSocket(request, env, url, user) {
if (request.method !== "GET" ||
request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
return json({ error: "WebSocket upgrade required" }, 426, { Upgrade: "websocket" });
}
if (!validOrigin(request, url)) {
return json({ error: "Request origin rejected" }, 403);
}
const accountId = String(url.searchParams.get("account_id") || "").trim();
if (!/^[A-Za-z0-9_-]{3,32}$/.test(accountId)) {
return json({ error: "Invalid Deriv account ID" }, 400);
}
let token;
try {
token = await getDerivAccessToken(env, user.id);
} catch (error) {
console.error("Unable to decrypt Deriv token for socket:", error.message);
return json({ error: "Deriv connection could not be read. Please reconnect." }, 500);
}
if (!token) {
return json({ error: "Deriv is not connected or authorization has expired." }, 401);
}
try {
const accountsResponse = await derivApiFetch(token, "/trading/v1/options/accounts");
const accountsData = await accountsResponse.json();
    if (!accountsResponse.ok) {
      return json({ error: "Unable to verify Deriv account." }, 502);
    }

    const accounts = Array.isArray(accountsData.data)
      ? accountsData.data
      : (accountsData.data ? [accountsData.data] : []);

    const account = accounts.find(item => String(item.account_id || "") === accountId);

    if (!account) return json({ error: "Deriv account not found." }, 404);

    if (String(account.account_type || "").toLowerCase() !== "demo") {
      return json({ error: "Real accounts are disabled. Only demo accounts may connect." }, 403);
    }

    const otpResponse = await derivApiFetch(
      token,
      `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      { method: "POST" }
    );

    const otpData = await otpResponse.json();
    const upstreamUrl = otpData.data?.url;

    if (!otpResponse.ok || !upstreamUrl) {
      return json({ error: "Unable to establish Deriv demo session." }, 502);
    }

    const parsed = new URL(upstreamUrl);

    if (
      parsed.protocol !== "wss:" ||
      parsed.hostname !== "api.derivws.com" ||
      !parsed.pathname.endsWith("/trading/v1/options/ws/demo")
    ) {
      return json({ error: "Deriv returned an unexpected demo WebSocket URL." }, 502);
    }

    const upstreamResponse = await fetch(
      upstreamUrl.replace(/^wss:/i, "https:"),
      { headers: { Upgrade: "websocket" } }
    );

    const upstream = upstreamResponse.webSocket;

    if (!upstream) {
      console.error("Deriv WebSocket handshake failed:", upstreamResponse.status);
      return json({ error: "Deriv demo WebSocket handshake failed." }, 502);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const proposalIds = new Map();
    const pendingProposalRequests = new Map();
    const discoveredContracts = new Map();
    const pendingContractsRequests = new Map();

    let messageWindowStart = Date.now();
    let messageCount = 0;

    upstream.accept({ allowHalfOpen: true });
    server.accept({ allowHalfOpen: true });

    const closeBoth = (code = 1000, reason = "Connection closed") => {
      try { if (server.readyState < 2) server.close(code, reason); } catch {}
      try { if (upstream.readyState < 2) upstream.close(code, reason); } catch {}
    };

    server.addEventListener("message", event => {
      const now = Date.now();

      if (now - messageWindowStart >= 1000) {
        messageWindowStart = now;
        messageCount = 0;
      }

      messageCount += 1;

      if (messageCount > 30) {
        wsError(server, "RateLimitExceeded", "Too many requests. Slow down.");
        closeBoth(1008, "Rate limit exceeded");
        return;
      }

      const checked = validateDerivClientMessage(
        event.data,
        proposalIds,
        pendingProposalRequests,
        discoveredContracts
      );

      if (!checked.ok) {
        wsError(server, checked.code, checked.message, checked.echoReq);
        return;
      }

      if (Object.prototype.hasOwnProperty.call(checked.payload, "contracts_for")) {
        pendingContractsRequests.set(checked.payload.req_id, {
          symbol: checked.payload.contracts_for,
          createdAt: Date.now()
        });
      }

      try {
        upstream.send(JSON.stringify(checked.payload));
      } catch {
        wsError(server, "UpstreamUnavailable", "Deriv connection is unavailable.");
      }
    });

    upstream.addEventListener("message", event => {
      let message = null;

      try {
        message = JSON.parse(
          typeof event.data === "string"
            ? event.data
            : new TextDecoder().decode(event.data)
        );
      } catch {
        try { server.send(event.data); } catch {}
        return;
      }

      const contractsResponse = message?.contracts_for;
      const contractsRequestId = message?.echo_req?.req_id ?? message?.req_id;

      const contractsRequest = contractsRequestId !== undefined
        ? pendingContractsRequests.get(contractsRequestId)
        : null;

      if (contractsRequest) {
        pendingContractsRequests.delete(contractsRequestId);

        if (
          Date.now() - contractsRequest.createdAt <= DERIV_PROPOSAL_TTL_MS &&
          Array.isArray(contractsResponse?.available)
        ) {
          const safeAvailable = contractsResponse.available
            .filter(item =>
              item &&
              typeof item.contract_type === "string" &&
              /^[A-Z0-9_]{2,32}$/.test(item.contract_type)
            )
            .slice(0, 100)
            .map(item => ({
              contract_type: item.contract_type,
              expiry_type: item.expiry_type,
              min_contract_duration: item.min_contract_duration,
              max_contract_duration: item.max_contract_duration,
              market: item.market,
              submarket: item.submarket,
              contract_category: item.contract_category,
              underlying_symbol: item.underlying_symbol
            }));

          discoveredContracts.set(contractsRequest.symbol, safeAvailable);
        }
      }

      const proposal = message?.proposal;
      const requestId = message?.echo_req?.req_id ?? message?.req_id;

      const requested = requestId !== undefined
        ? pendingProposalRequests.get(requestId)
        : null;

      if (requested) {
        pendingProposalRequests.delete(requestId);

        const responseSymbol = String(message?.echo_req?.underlying_symbol || "");
        const responseContractType = String(message?.echo_req?.contract_type || "").toUpperCase();

        if (
          proposal?.id &&
          Date.now() - requested.createdAt <= DERIV_PROPOSAL_TTL_MS &&
          responseSymbol === requested.symbol &&
          responseContractType === requested.contractType &&
          String(message?.echo_req?.barrier ?? "") === requested.barrier &&
          String(message?.echo_req?.barrier2 ?? "") === requested.barrier2
        ) {
          const askPrice = Number(proposal.ask_price);

          if (
            Number.isFinite(askPrice) &&
            askPrice > 0 &&
            askPrice <= DERIV_MAX_STAKE_USD &&
            proposal.currency === "USD"
          ) {
            if (proposalIds.size >= DERIV_MAX_PROPOSALS) {
              const oldest = proposalIds.keys().next().value;
              if (oldest) proposalIds.delete(oldest);
            }

            proposalIds.set(String(proposal.id), {
              askPrice,
              expiresAt: Date.now() + DERIV_PROPOSAL_TTL_MS,
              requestedStake: requested.amount,
              symbol: requested.symbol,
              contractType: requested.contractType
            });
          }
        }
      }

      for (const [id, item] of proposalIds) {
        if (item.expiresAt <= Date.now()) proposalIds.delete(id);
      }

      for (const [id, item] of pendingProposalRequests) {
        if (Date.now() - item.createdAt > DERIV_PROPOSAL_TTL_MS) pendingProposalRequests.delete(id);
      }

      for (const [id, item] of pendingContractsRequests) {
        if (Date.now() - item.createdAt > DERIV_PROPOSAL_TTL_MS) pendingContractsRequests.delete(id);
      }

      try {
        server.send(JSON.stringify(message));
      } catch {}
    });

    server.addEventListener("close", event =>
      closeBoth(event.code || 1000, event.reason || "Client disconnected")
    );

    upstream.addEventListener("close", event =>
      closeBoth(event.code || 1000, event.reason || "Deriv disconnected")
    );

    server.addEventListener("error", () => closeBoth(1011, "Client socket error"));
    upstream.addEventListener("error", () => closeBoth(1011, "Deriv socket error"));

    return new Response(null, { status: 101, webSocket: client });

} catch (error) {
console.error("Secure Deriv socket error:", error.message);
return json({ error: "Unable to establish secure Deriv demo connection." }, 502);
}
}/* =========================================
DERIV ROUTES AND ACCOUNT MANAGEMENT
========================================= */
async function handleDeriv(request, env, url) {
const path = url.pathname;
const isCallback = path === "/api/deriv/callback";
const user = await getAuthenticatedUser(request, env);
if (!user) {
if (isCallback) return redirectToApp("login_required");
return json({ error: "Authentication required" }, 401);
}
// OAuth callback must complete an already-started handshake.
// Connection status and disconnect remain available even after
// expiry so a user can inspect or revoke stored broker credentials.
const accountManagementRoute =
isCallback ||
path === "/api/deriv/status" ||
path === "/api/deriv/disconnect";
if (!accountManagementRoute) {
const entitlement = await getSubscriptionEntitlement(env, user);
if (!entitlement.active) return paymentRequiredResponse(entitlement);
}
if (path === "/api/deriv/socket") {
if (!env.DERIV_TOKEN_ENCRYPTION_KEY) {
return json({ error: "Deriv encryption is not configured" }, 500);
}
    return handleDerivSocket(request, env, url, user);
}
if (!env.DERIV_CLIENT_ID || !env.DERIV_TOKEN_ENCRYPTION_KEY) {
return json({ error: "Deriv OAuth is not fully configured" }, 500);
}
/* START OAUTH CONNECTION */
if (path === "/api/deriv/connect" && request.method === "GET") {
const state = bytesToBase64Url(randomBytes(32));
const verifier = bytesToBase64Url(randomBytes(32));
const challenge = bytesToBase64Url(await sha256Bytes(verifier));
const stateHash = await sha256(state);
const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO deriv_oauth (
        user_id,
        state_hash,
        code_verifier,
        access_token,
        token_expires_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, NULL, NULL, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        state_hash = excluded.state_hash,
        code_verifier = excluded.code_verifier,
        access_token = NULL,
        token_expires_at = NULL,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).bind(user.id, stateHash, verifier, now, now).run();

    const authUrl = new URL(DERIV_AUTH_URL);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", String(env.DERIV_CLIENT_ID));
    authUrl.searchParams.set("redirect_uri", DERIV_REDIRECT_URI);
    authUrl.searchParams.set("scope", DERIV_SCOPES);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", challenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    return Response.redirect(authUrl.toString(), 302);
}
/* OAUTH CALLBACK */
if (path === "/api/deriv/callback" && request.method === "GET") {
const oauthError = url.searchParams.get("error");
    if (oauthError) return redirectToApp("authorization_denied");

    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code || !state) return redirectToApp("invalid_callback");

    const pending = await env.DB.prepare(`
      SELECT state_hash, code_verifier, created_at
      FROM deriv_oauth
      WHERE user_id = ?
    `).bind(user.id).first();

    if (!pending?.state_hash || !pending?.code_verifier) {
      return redirectToApp("state_missing");
    }

    if (Date.now() - Date.parse(pending.created_at) > 10 * 60 * 1000) {
      await env.DB.prepare(
        "DELETE FROM deriv_oauth WHERE user_id = ?"
      ).bind(user.id).run();

      return redirectToApp("state_expired");
    }

    if (await sha256(state) !== pending.state_hash) {
      return redirectToApp("state_mismatch");
    }

    const tokenResponse = await fetch(DERIV_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: String(env.DERIV_CLIENT_ID),
        code,
        redirect_uri: DERIV_REDIRECT_URI,
        code_verifier: pending.code_verifier
      }),
      signal: AbortSignal.timeout(15000)
    });

    const tokenData = await tokenResponse.json();

    const accessToken =
      tokenData.access_token ||
      tokenData.data?.access_token;

    if (!tokenResponse.ok || !accessToken) {
      console.error(
        "Deriv OAuth token exchange failed:",
        tokenResponse.status,
        tokenData.error || tokenData.message || "No access token"
      );

      return redirectToApp("token_exchange_failed");
    }

    const encryptedToken = await encryptDerivToken(env, accessToken);

    const expiresIn = Number(
      tokenData.expires_in ||
      tokenData.data?.expires_in ||
      3600
    );

    const expiresAt = new Date(
      Date.now() + Math.max(60, expiresIn) * 1000
    ).toISOString();

    const now = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE deriv_oauth
      SET
        access_token = ?,
        token_expires_at = ?,
        state_hash = NULL,
        code_verifier = NULL,
        updated_at = ?
      WHERE user_id = ?
    `).bind(encryptedToken, expiresAt, now, user.id).run();

    return redirectToApp("connected");
}
/* CONNECTION STATUS */
if (path === "/api/deriv/status" && request.method === "GET") {
const row = await env.DB.prepare(`SELECT token_expires_at FROM deriv_oauth WHERE user_id = ? AND access_token IS NOT NULL`).bind(user.id).first();
    const connected = Boolean(
      row?.token_expires_at &&
      Date.parse(row.token_expires_at) > Date.now()
    );

    return json({
      ok: true,
      connected,
      provider: "Deriv",
      expiresAt: row?.token_expires_at || null
    });
}
/* DISCONNECT DERIV */
if (path === "/api/deriv/disconnect" && request.method === "POST") {
if (!validOrigin(request, url)) {
return json({ error: "Request origin rejected" }, 403);
}
    await env.DB.prepare(
      "DELETE FROM deriv_oauth WHERE user_id = ?"
    ).bind(user.id).run();

    return json({
      ok: true,
      connected: false,
      message: "Deriv disconnected"
    });
}
if (request.method === "POST" && !validOrigin(request, url)) {
return json({ error: "Request origin rejected" }, 403);
}
if (![
"/api/deriv/test",
"/api/deriv/accounts",
"/api/deriv/otp"
].includes(path)) {
return json({ error: "Deriv route not found" }, 404);
}
if (path === "/api/deriv/otp" && request.method !== "POST") {
return json({ error: "Method not allowed" }, 405, { Allow: "POST" });
}
if (path !== "/api/deriv/otp" && request.method !== "GET") {
return json({ error: "Method not allowed" }, 405, { Allow: "GET" });
}
let token;
try {
token = await getDerivAccessToken(env, user.id);
} catch (error) {
console.error("Unable to decrypt Deriv token:", error.message);
    return json({
      error: "Stored Deriv connection could not be read. Please reconnect."
    }, 500);
}
if (!token) {
return json({
ok: false,
connected: false,
error: "Deriv is not connected or the authorization has expired. Reconnect your account."
}, 401);
}
try {
const accountsResponse = await derivApiFetch(
token,
"/trading/v1/options/accounts"
);
    const accountsData = await accountsResponse.json();

    if (!accountsResponse.ok) {
      console.error(
        "Deriv account request rejected:",
        accountsResponse.status
      );

      return json({
        ok: false,
        connected: false,
        error: "Deriv authorization failed. Please reconnect.",
        status: accountsResponse.status
      }, 502);
    }

    const accounts = Array.isArray(accountsData.data)
      ? accountsData.data
      : (accountsData.data ? [accountsData.data] : []);

    if (path === "/api/deriv/test") {
      return json({
        ok: true,
        connected: true,
        provider: "Deriv",
        accountCount: accounts.length,
        timestamp: new Date().toISOString()
      });
    }

    if (path === "/api/deriv/accounts") {
      return json({
        ok: true,
        connected: true,
        provider: "Deriv",
        accounts,
        timestamp: new Date().toISOString()
      });
    }

    let body;

    try {
      body = await readJson(request);
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const accountId = String(body.account_id || "").trim();

    if (!/^[A-Za-z0-9_-]{3,32}$/.test(accountId)) {
      return json({ error: "Invalid Deriv account ID" }, 400);
    }

    const selectedAccount = accounts.find(
      account => String(account.account_id || "") === accountId
    );

    if (!selectedAccount) {
      return json({ error: "Deriv account not found" }, 404);
    }

    /* STRICT DEMO-ONLY ACCOUNT SECURITY */

    const accountType = String(
      selectedAccount.account_type || ""
    ).toLowerCase();

    if (accountType !== "demo") {
      return json({
        ok: false,
        connected: true,
        authorised: false,
        error: "Real-account access is disabled. Only demo trading is permitted."
      }, 403);
    }

    // Return a same-origin Worker WebSocket URL, never Deriv's OTP URL.
    // The Worker obtains the one-time OTP and holds the upstream socket.
    const socketUrl = new URL("/api/deriv/socket", url.origin);
    socketUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socketUrl.searchParams.set("account_id", accountId);

    return json({
      ok: true,
      connected: true,
      provider: "Deriv",
      account_id: accountId,
      account_type: "demo",
      websocket_url: socketUrl.toString(),
      execution_mode: "server_proxy_demo_only",
      max_stake: 10,
      currency: "USD",
      message: "Secure demo connection. Trading requests are validated by the server.",
      timestamp: new Date().toISOString()
    });

} catch (error) {
console.error("Deriv connection error:", error.message);
    return json({
      ok: false,
      connected: false,
      error: "Unable to connect to Deriv"
    }, 502);
}
}/* =========================================
CTRADER OAUTH CONFIGURATION
========================================= */
const CTRADER_REDIRECT_URI =
"https://tradelabai2.balancesilence11.workers.dev/api/ctrader/callback";
const CTRADER_AUTH_URL =
"https://id.ctrader.com/my/settings/openapi/grantingaccess/";
const CTRADER_TOKEN_URL =
"https://openapi.ctrader.com/apps/token";

/* =========================================
CTRADER CRYPTOGRAPHY
========================================= */
async function ctraderHash(value) {
const data = new TextEncoder().encode(String(value));
const digest = await crypto.subtle.digest("SHA-256", data);
return Array.from(new Uint8Array(digest))
.map(byte => byte.toString(16).padStart(2, "0"))
.join("");
}

async function ctraderEncrypt(env, value) {
if (!env.CTRADER_TOKEN_ENCRYPTION_KEY) {
throw new Error("cTrader token encryption key is not configured");
}
const secretHash = await crypto.subtle.digest(
"SHA-256",
new TextEncoder().encode(env.CTRADER_TOKEN_ENCRYPTION_KEY)
);
const key = await crypto.subtle.importKey(
"raw",
secretHash,
{ name: "AES-GCM" },
false,
["encrypt", "decrypt"]
);
const iv = crypto.getRandomValues(new Uint8Array(12));
const encrypted = await crypto.subtle.encrypt(
{ name: "AES-GCM", iv },
key,
new TextEncoder().encode(String(value))
);
const combined = new Uint8Array(
iv.length + encrypted.byteLength
);
combined.set(iv, 0);
combined.set(new Uint8Array(encrypted), iv.length);
let binary = "";
for (const byte of combined) {
binary += String.fromCharCode(byte);
}
return btoa(binary);
}

/* =========================================
CTRADER CONNECTION START
========================================= */
async function handleCTraderConnect(request, env, url) {
const user = await getAuthenticatedUser(request, env);
if (!user) {
return redirectToApp("login_required");
}
const entitlement = await getSubscriptionEntitlement(env, user);
if (!entitlement.active) {
return paymentRequiredResponse(entitlement);
}
if (!env.CTRADER_CLIENT_ID) {
return json({
ok: false,
error: "cTrader client ID is not configured"
}, 500);
}
if (!env.CTRADER_TOKEN_ENCRYPTION_KEY) {
return json({
ok: false,
error: "cTrader token encryption is not configured"
}, 500);
}
try {
const randomState = crypto.getRandomValues(
new Uint8Array(32)
);
    const state = Array.from(randomState)
      .map(byte => byte.toString(16).padStart(2, "0"))
      .join("");

    const stateHash = await ctraderHash(state);

    const expiresAt = new Date(
      Date.now() + 10 * 60 * 1000
    ).toISOString();

    await env.DB.prepare(`
      INSERT INTO ctrader_oauth_states (
        state_hash,
        user_id,
        expires_at
      )
      VALUES (?, ?, ?)
    `).bind(
      stateHash,
      user.id,
      expiresAt
    ).run();

    const authUrl = new URL(CTRADER_AUTH_URL);

    authUrl.searchParams.set(
      "client_id",
      String(env.CTRADER_CLIENT_ID)
    );

    authUrl.searchParams.set(
      "redirect_uri",
      CTRADER_REDIRECT_URI
    );

    authUrl.searchParams.set("scope", "accounts");
    authUrl.searchParams.set("product", "web");
    authUrl.searchParams.set("state", state);

    return Response.redirect(authUrl.toString(), 302);

} catch (error) {
console.error("cTrader connection initiation failed:", error.message);
    return json({
      ok: false,
      error: "Unable to start cTrader authorization"
    }, 500);
}
}

/* =========================================
CTRADER OAUTH CALLBACK
========================================= */
async function handleCTraderCallback(request, env, url) {
const user = await getAuthenticatedUser(request, env);
if (!user) {
return redirectToApp("login_required");
}
const oauthError = url.searchParams.get("error");
if (oauthError) {
console.error("cTrader authorization rejected:", oauthError);
return redirectToApp("ctrader_authorization_denied");
}
const code = url.searchParams.get("code");
const state = url.searchParams.get("state");
if (!code || !state) {
return redirectToApp("ctrader_invalid_callback");
}
if (
!env.CTRADER_CLIENT_ID ||
!env.CTRADER_CLIENT_SECRET ||
!env.CTRADER_TOKEN_ENCRYPTION_KEY
) {
console.error("cTrader OAuth configuration is incomplete");
return redirectToApp("ctrader_configuration_error");
}
try {
const stateHash = await ctraderHash(state);
    const pending = await env.DB.prepare(`
      SELECT state_hash, user_id, expires_at
      FROM ctrader_oauth_states
      WHERE state_hash = ?
        AND user_id = ?
      LIMIT 1
    `).bind(
      stateHash,
      user.id
    ).first();

    if (!pending) {
      return redirectToApp("ctrader_state_invalid");
    }

    if (Date.parse(pending.expires_at) <= Date.now()) {
      await env.DB.prepare(`
        DELETE FROM ctrader_oauth_states
        WHERE state_hash = ?
          AND user_id = ?
      `).bind(
        stateHash,
        user.id
      ).run();

      return redirectToApp("ctrader_state_expired");
    }

    // Consume the OAuth state before exchanging the authorization code.
    await env.DB.prepare(`
      DELETE FROM ctrader_oauth_states
      WHERE state_hash = ?
        AND user_id = ?
    `).bind(
      stateHash,
      user.id
    ).run();

    const tokenUrl = new URL(CTRADER_TOKEN_URL);

    tokenUrl.searchParams.set(
      "grant_type",
      "authorization_code"
    );

    tokenUrl.searchParams.set("code", code);

    tokenUrl.searchParams.set(
      "redirect_uri",
      CTRADER_REDIRECT_URI
    );

    tokenUrl.searchParams.set(
      "client_id",
      String(env.CTRADER_CLIENT_ID)
    );

    tokenUrl.searchParams.set(
      "client_secret",
      String(env.CTRADER_CLIENT_SECRET)
    );

    const tokenResponse = await fetch(tokenUrl.toString(), {
      method: "GET",
      headers: {
        "Accept": "application/json"
      },
      signal: AbortSignal.timeout(15000)
    });

    const tokenData = await tokenResponse.json();

    if (
      !tokenResponse.ok ||
      !tokenData.accessToken ||
      !tokenData.refreshToken
    ) {
      console.error(
        "cTrader token exchange failed:",
        tokenResponse.status,
        tokenData.errorCode || tokenData.description || "Invalid token response"
      );

      return redirectToApp("ctrader_token_exchange_failed");
    }

    const encryptedAccessToken = await ctraderEncrypt(
      env,
      tokenData.accessToken
    );

    const encryptedRefreshToken = await ctraderEncrypt(
      env,
      tokenData.refreshToken
    );

    const expiresIn = Math.max(
      60,
      Number(tokenData.expiresIn || 3600)
    );

    const tokenExpiresAt = new Date(
      Date.now() + expiresIn * 1000
    ).toISOString();

    const connectionId = crypto.randomUUID();

    await env.DB.prepare(`
      INSERT INTO ctrader_connections (
        id,
        user_id,
        environment,
        access_token,
        refresh_token,
        token_expires_at
      )
      VALUES (?, ?, 'demo', ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        environment = 'demo',
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        token_expires_at = excluded.token_expires_at
    `).bind(
      connectionId,
      user.id,
      encryptedAccessToken,
      encryptedRefreshToken,
      tokenExpiresAt
    ).run();

    return redirectToApp("ctrader_connected");

} catch (error) {
console.error("cTrader callback failed:", error.message);
    return redirectToApp("ctrader_connection_failed");
}
}
/* =========================================
HISTORICAL MARKET DATA ENGINE
========================================= */
const HISTORICAL_MAX_CANDLES = 110000;
const HISTORICAL_MAX_BATCH = 100;
const HISTORICAL_MAX_BODY = 65536;
const HISTORICAL_TIMEFRAMES = new Set([
"M1",
"M5",
"M15",
"M30",
"H1",
"H4",
"D1",
"W1",
"MN1"
]);

/* =========================================
HISTORICAL DATA HELPERS
========================================= */
function historicalError(message, status = 400) {
return json({
ok: false,
error: message
}, status);
}

async function historicalReadJson(request) {
const contentLength = Number(
request.headers.get("content-length") || 0
);
if (
Number.isFinite(contentLength) &&
contentLength > HISTORICAL_MAX_BODY
) {
throw new Error("Request body is too large");
}
const text = await request.text();
if (text.length > HISTORICAL_MAX_BODY) {
throw new Error("Request body is too large");
}
try {
return JSON.parse(text);
} catch {
throw new Error("Invalid JSON request body");
}
}

function historicalNormalizeTimestamp(value) {
if (typeof value === "number" && Number.isFinite(value)) {
// Convert Unix seconds to milliseconds when necessary.
const milliseconds = value < 100000000000
? value * 1000
: value;
    const date = new Date(milliseconds);

    if (!Number.isFinite(date.getTime())) return null;

    return date.toISOString();
}
if (typeof value === "string") {
const trimmed = value.trim();
    if (!trimmed) return null;

    // Numeric timestamp supplied as a string.
    if (/^\d{10,13}$/.test(trimmed)) {
      return historicalNormalizeTimestamp(Number(trimmed));
    }

    const date = new Date(trimmed);

    if (!Number.isFinite(date.getTime())) return null;

    return date.toISOString();
}
return null;
}

function historicalValidateCandle(candle) {
if (
!candle ||
typeof candle !== "object" ||
Array.isArray(candle)
) {
return null;
}
const timestamp = historicalNormalizeTimestamp(
candle.timestamp ??
candle.time ??
candle.datetime ??
candle.date
);
const open = Number(candle.open);
const high = Number(candle.high);
const low = Number(candle.low);
const close = Number(candle.close);
const volume = Number(candle.volume ?? 0);
if (
!timestamp ||
!Number.isFinite(open) ||
!Number.isFinite(high) ||
!Number.isFinite(low) ||
!Number.isFinite(close) ||
!Number.isFinite(volume)
) {
return null;
}
if (
open <= 0 ||
high <= 0 ||
low <= 0 ||
close <= 0 ||
volume < 0
) {
return null;
}
if (
high < Math.max(open, close, low) ||
low > Math.min(open, close, high)
) {
return null;
}
return {
timestamp,
open,
high,
low,
close,
volume
};
}

/* =========================================
HISTORICAL DATA ROUTES
========================================= */
async function handleHistoricalData(request, env, url, user) {
const path = url.pathname;
const method = request.method;
if (!env.DB) {
return historicalError(
"Historical database is not configured",
500
);
}
/* =====================================
START IMPORT
POST /api/historical/import/start
===================================== */
if (
path === "/api/historical/import/start" &&
method === "POST"
) {
if (!validOrigin(request, url)) {
return historicalError("Request origin rejected", 403);
}
    let body;

    try {
      body = await historicalReadJson(request);
    } catch (error) {
      return historicalError(error.message, 400);
    }

    const symbol = String(body.symbol || "")
      .trim()
      .toUpperCase();

    const timeframe = String(body.timeframe || "")
      .trim()
      .toUpperCase();

    const source = String(body.source || "manual")
      .trim()
      .slice(0, 40);

    const expectedCandles = Number(
      body.expectedCandles || 0
    );

    if (!/^[A-Z0-9_]{2,32}$/.test(symbol)) {
      return historicalError("Invalid market symbol");
    }

    if (!HISTORICAL_TIMEFRAMES.has(timeframe)) {
      return historicalError("Unsupported timeframe");
    }

    if (
      !Number.isSafeInteger(expectedCandles) ||
      expectedCandles < 0 ||
      expectedCandles > HISTORICAL_MAX_CANDLES
    ) {
      return historicalError("Invalid expected candle count");
    }

    const pendingCount = await env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM historical_datasets
      WHERE user_id = ?
        AND status = 'pending'
    `).bind(user.id).first();

    if (Number(pendingCount?.total || 0) >= 5) {
      return historicalError(
        "Maximum of five pending imports reached",
        429
      );
    }

    const datasetId = crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      const fileName = String(body.fileName || body.file_name || "")
        .trim()
        .slice(0, 255) || null;

      // Match the live D1 schema exactly. expected_candles and updated_at
      // are not columns in historical_datasets.
      await env.DB.prepare(`
        INSERT INTO historical_datasets (
          id, user_id, symbol, timeframe, source, file_name,
          candle_count, status, created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?)
      `).bind(
        datasetId,
        user.id,
        symbol,
        timeframe,
        source,
        fileName,
        now
      ).run();

      return json({
        ok: true,
        datasetId,
        symbol,
        timeframe,
        status: "pending",
        expectedCandles,
        message: "Historical data import started"
      });

    } catch (error) {
      console.error(
        "Historical import start failed:",
        error.message
      );

      return historicalError(
        "Unable to create historical dataset",
        500
      );
    }
}

/* =====================================
IMPORT CANDLE BATCH
POST /api/historical/import/chunk
===================================== */
if (
path === "/api/historical/import/chunk" &&
method === "POST"
) {
if (!validOrigin(request, url)) {
return historicalError("Request origin rejected", 403);
}
    let body;

    try {
      body = await historicalReadJson(request);
    } catch (error) {
      return historicalError(error.message, 400);
    }

    const datasetId = String(body.datasetId || "")
      .trim();

    if (
      !/^[A-Za-z0-9_-]{8,64}$/.test(datasetId)
    ) {
      return historicalError("Invalid dataset ID");
    }

    if (
      !Array.isArray(body.candles) ||
      body.candles.length === 0 ||
      body.candles.length > HISTORICAL_MAX_BATCH
    ) {
      return historicalError(
        `Each batch must contain between 1 and ${HISTORICAL_MAX_BATCH} candles`
      );
    }

    const dataset = await env.DB.prepare(`
      SELECT id, user_id, candle_count, status
      FROM historical_datasets
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(
      datasetId,
      user.id
    ).first();

    if (!dataset) {
      return historicalError("Dataset not found", 404);
    }

    if (dataset.status !== "pending") {
      return historicalError(
        "Dataset is not accepting additional candles",
        409
      );
    }

    const currentCount = Number(dataset.candle_count || 0);

    if (
      currentCount + body.candles.length >
      HISTORICAL_MAX_CANDLES
    ) {
      return historicalError(
        "Historical dataset candle limit exceeded",
        413
      );
    }

    const validated = [];

    for (const item of body.candles) {
      const candle = historicalValidateCandle(item);

      if (!candle) {
        return historicalError(
          "Invalid candle detected in batch"
        );
      }

      validated.push(candle);
    }

    // Prevent duplicate timestamps within the same batch.
    const uniqueCandles = new Map();

    for (const candle of validated) {
      uniqueCandles.set(candle.timestamp, candle);
    }

    const statements = uniqueCandles.values();

    const batch = [];

    for (const candle of statements) {
      batch.push(
        env.DB.prepare(`
          INSERT OR IGNORE INTO historical_candles (
            dataset_id,
            timestamp,
            open,
            high,
            low,
            close,
            volume
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          datasetId,
          candle.timestamp,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume
        )
      );
    }

    try {
      if (batch.length) {
        await env.DB.batch(batch);
      }

      const updated = await env.DB.prepare(`
        SELECT
          COUNT(*) AS total,
          MIN(timestamp) AS first_timestamp,
          MAX(timestamp) AS last_timestamp
        FROM historical_candles
        WHERE dataset_id = ?
      `).bind(datasetId).first();

      const totalCandles = Number(updated?.total || 0);

      await env.DB.prepare(`
        UPDATE historical_datasets
        SET
          candle_count = ?,
          first_timestamp = ?,
          last_timestamp = ?
        WHERE id = ?
          AND user_id = ?
          AND status = 'pending'
      `).bind(
        totalCandles,
        updated?.first_timestamp || null,
        updated?.last_timestamp || null,
        datasetId,
        user.id
      ).run();

      return json({
        ok: true,
        datasetId,
        received: body.candles.length,
        uniqueInBatch: uniqueCandles.size,
        totalCandles,
        status: "pending"
      });

    } catch (error) {
      console.error(
        "Historical candle batch failed:",
        error.message
      );

      return historicalError(
        "Unable to save historical candle batch",
        500
      );
    }
}

/* =====================================
COMPLETE IMPORT
POST /api/historical/import/complete
===================================== */
if (
path === "/api/historical/import/complete" &&
method === "POST"
) {
if (!validOrigin(request, url)) {
return historicalError("Request origin rejected", 403);
}
    let body;

    try {
      body = await historicalReadJson(request);
    } catch (error) {
      return historicalError(error.message, 400);
    }

    const datasetId = String(body.datasetId || "")
      .trim();

    if (
      !/^[A-Za-z0-9_-]{8,64}$/.test(datasetId)
    ) {
      return historicalError("Invalid dataset ID");
    }

    const dataset = await env.DB.prepare(`
      SELECT id, status
      FROM historical_datasets
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(
      datasetId,
      user.id
    ).first();

    if (!dataset) {
      return historicalError("Dataset not found", 404);
    }

    if (dataset.status !== "pending") {
      return historicalError(
        "Dataset has already been completed",
        409
      );
    }

    const statistics = await env.DB.prepare(`
      SELECT
        COUNT(*) AS total,
        MIN(timestamp) AS first_timestamp,
        MAX(timestamp) AS last_timestamp
      FROM historical_candles
      WHERE dataset_id = ?
    `).bind(datasetId).first();

    const totalCandles = Number(statistics?.total || 0);

    if (totalCandles === 0) {
      return historicalError(
        "Cannot complete an empty historical dataset"
      );
    }

    const now = new Date().toISOString();

    await env.DB.prepare(`
      UPDATE historical_datasets
      SET
        candle_count = ?,
        first_timestamp = ?,
        last_timestamp = ?,
        status = 'completed'
      WHERE id = ?
        AND user_id = ?
        AND status = 'pending'
    `).bind(
      totalCandles,
      statistics.first_timestamp,
      statistics.last_timestamp,
      datasetId,
      user.id
    ).run();

    return json({
      ok: true,
      datasetId,
      status: "completed",
      candleCount: totalCandles,
      firstTimestamp: statistics.first_timestamp,
      lastTimestamp: statistics.last_timestamp,
      completedAt: now
    });
}

/* =====================================
LIST HISTORICAL DATASETS
GET /api/historical/datasets
===================================== */
if (
path === "/api/historical/datasets" &&
method === "GET"
) {
const result = await env.DB.prepare(`
      SELECT
        id, symbol, timeframe, source, file_name,
        candle_count, first_timestamp, last_timestamp,
        status, created_at,
        NULL AS expected_candles,
        NULL AS updated_at
      FROM historical_datasets
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 100
    `).bind(user.id).all();
    return json({
      ok: true,
      datasets: result.results || []
    });
}

/* =====================================
RETRIEVE HISTORICAL CANDLES
GET /api/historical/candles
===================================== */
if (
path === "/api/historical/candles" &&
method === "GET"
) {
const datasetId = String(
url.searchParams.get("datasetId") || ""
).trim();
    if (
      !/^[A-Za-z0-9_-]{8,64}$/.test(datasetId)
    ) {
      return historicalError("Invalid dataset ID");
    }

    const dataset = await env.DB.prepare(`
      SELECT
        id,
        symbol,
        timeframe,
        candle_count,
        status
      FROM historical_datasets
      WHERE id = ?
        AND user_id = ?
      LIMIT 1
    `).bind(
      datasetId,
      user.id
    ).first();

    if (!dataset) {
      return historicalError("Dataset not found", 404);
    }

    if (dataset.status !== "completed") {
      return historicalError(
        "Historical dataset is not completed",
        409
      );
    }

    const requestedLimit = Number(
      url.searchParams.get("limit") || 1000
    );

    const limit = Number.isSafeInteger(requestedLimit)
      ? Math.min(5000, Math.max(1, requestedLimit))
      : 1000;

    const before = url.searchParams.get("before");

    let result;

    if (before) {
      const beforeTimestamp =
        historicalNormalizeTimestamp(before);

      if (!beforeTimestamp) {
        return historicalError("Invalid before timestamp");
      }

      result = await env.DB.prepare(`
        SELECT
          timestamp,
          open,
          high,
          low,
          close,
          volume
        FROM historical_candles
        WHERE dataset_id = ?
          AND timestamp < ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(
        datasetId,
        beforeTimestamp,
        limit
      ).all();

    } else {
      result = await env.DB.prepare(`
        SELECT
          timestamp,
          open,
          high,
          low,
          close,
          volume
        FROM historical_candles
        WHERE dataset_id = ?
        ORDER BY timestamp DESC
        LIMIT ?
      `).bind(
        datasetId,
        limit
      ).all();
    }

    const candles = (result.results || []).reverse();

    return json({
      ok: true,
      dataset: {
        id: dataset.id,
        symbol: dataset.symbol,
        timeframe: dataset.timeframe,
        candleCount: dataset.candle_count,
        status: dataset.status
      },
      candles,
      returned: candles.length,
      limit,
      nextBefore: candles.length
        ? candles[0].timestamp
        : null
    });
}
/* =====================================
UNKNOWN HISTORICAL ROUTE
===================================== */
return historicalError(
"Historical data route not found",
404
);
}/* =========================================
ADVANCED MARKET DATA ENGINE
PROVIDER CONFIGURATION AND HELPERS
========================================= */
const MARKET_PROVIDER_TIMEOUT_MS = 12000;
const FINNHUB_RESOLUTIONS = {
"1min": "1",
"5min": "5",
"15min": "15",
"30min": "30",
"1h": "60",
"4h": "240",
"1day": "D",
"1week": "W",
"1month": "M"
};
function marketFinnhubSymbol(providerSymbol) {
return "OANDA:" + String(providerSymbol)
.replace("/", "_");
}
function marketAlphaCurrencies(providerSymbol) {
const parts = String(providerSymbol).split("/");
if (parts.length !== 2) return null;
return {
from: parts[0],
to: parts[1]
};
}
async function marketFetchJson(url) {
const response = await fetch(url, {
signal: AbortSignal.timeout(MARKET_PROVIDER_TIMEOUT_MS),
headers: {
"Accept": "application/json"
}
});
let data;
try {
data = await response.json();
} catch {
throw new Error("Market provider returned invalid JSON");
}
if (!response.ok) {
throw new Error(
`Market provider HTTP error ${response.status}`
);
}
if (
data &&
(
data.status === "error" ||
data.status === "ERROR" ||
data.error ||
data["Error Message"] ||
data.Note
)
) {
throw new Error(
String(
data.error ||
data.message ||
data["Error Message"] ||
data.Note ||
"Market provider rejected the request"
)
);
}
return data;
}

/* =========================================
TWELVE DATA PRICE
========================================= */
async function marketTwelveDataPrice(
providerSymbol,
env
) {
if (!env.TWELVE_DATA_API_KEY) {
throw new Error("Twelve Data API key unavailable");
}
const apiUrl = new URL(
"https://api.twelvedata.com/price"
);
apiUrl.searchParams.set("symbol", providerSymbol);
apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);
const data = await marketFetchJson(apiUrl.toString());
const price = Number(data.price);
if (!Number.isFinite(price) || price <= 0) {
throw new Error("Twelve Data returned an invalid price");
}
return {
price,
source: "Twelve Data"
};
}

/* =========================================
FINNHUB PRICE FALLBACK
========================================= */
async function marketFinnhubPrice(
providerSymbol,
env
) {
if (!env.FINNHUB_API_KEY) {
throw new Error("Finnhub API key unavailable");
}
const symbol = marketFinnhubSymbol(providerSymbol);
const apiUrl = new URL(
"https://finnhub.io/api/v1/quote"
);
apiUrl.searchParams.set("symbol", symbol);
apiUrl.searchParams.set("token", env.FINNHUB_API_KEY);
const data = await marketFetchJson(apiUrl.toString());
const price = Number(data.c);
if (
!Number.isFinite(price) ||
price <= 0 ||
Number(data.t) <= 0
) {
throw new Error("Finnhub returned no valid price");
}
return {
price,
source: "Finnhub",
providerTimestamp: Number(data.t)
};
}

/* =========================================
TWELVE DATA HISTORICAL CANDLES
========================================= */
async function marketTwelveDataCandles(
providerSymbol,
interval,
outputsize,
env
) {
if (!env.TWELVE_DATA_API_KEY) {
throw new Error("Twelve Data API key unavailable");
}
const apiUrl = new URL(
"https://api.twelvedata.com/time_series"
);
apiUrl.searchParams.set("symbol", providerSymbol);
apiUrl.searchParams.set("interval", interval);
apiUrl.searchParams.set("outputsize", String(outputsize));
apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);
const data = await marketFetchJson(apiUrl.toString());
if (!Array.isArray(data.values)) {
throw new Error("Twelve Data returned no candles");
}
const candles = data.values.map(item => ({
time: item.datetime,
open: Number(item.open),
high: Number(item.high),
low: Number(item.low),
close: Number(item.close),
volume: Number(item.volume || 0)
}));
return marketValidateCandles(candles);
}

/* =========================================
FINNHUB HISTORICAL CANDLES
========================================= */
async function marketFinnhubCandles(
providerSymbol,
interval,
outputsize,
env
) {
if (!env.FINNHUB_API_KEY) {
throw new Error("Finnhub API key unavailable");
}
const resolution = FINNHUB_RESOLUTIONS[interval];
if (!resolution) {
throw new Error("Unsupported Finnhub resolution");
}
const now = Math.floor(Date.now() / 1000);
const secondsPerCandle = {
"1min": 60,
"5min": 300,
"15min": 900,
"30min": 1800,
"1h": 3600,
"4h": 14400,
"1day": 86400,
"1week": 604800,
"1month": 2592000
}[interval];
const from = now -
(outputsize * secondsPerCandle);
const apiUrl = new URL(
"https://finnhub.io/api/v1/forex/candle"
);
apiUrl.searchParams.set(
"symbol",
marketFinnhubSymbol(providerSymbol)
);
apiUrl.searchParams.set("resolution", resolution);
apiUrl.searchParams.set("from", String(from));
apiUrl.searchParams.set("to", String(now));
apiUrl.searchParams.set("token", env.FINNHUB_API_KEY);
const data = await marketFetchJson(apiUrl.toString());
if (
data.s !== "ok" ||
!Array.isArray(data.t) ||
!Array.isArray(data.o) ||
!Array.isArray(data.h) ||
!Array.isArray(data.l) ||
!Array.isArray(data.c)
) {
throw new Error("Finnhub returned no historical candles");
}
const candles = data.t.map((timestamp, index) => ({
time: new Date(timestamp * 1000).toISOString(),
open: Number(data.o[index]),
high: Number(data.h[index]),
low: Number(data.l[index]),
close: Number(data.c[index]),
volume: Number(data.v?.[index] || 0)
}));
return marketValidateCandles(candles);
}

/* =========================================
ALPHA VANTAGE HISTORICAL FALLBACK
========================================= */
async function marketAlphaVantageCandles(
providerSymbol,
interval,
outputsize,
env
) {
if (!env.ALPHA_VANTAGE_API_KEY) {
throw new Error("Alpha Vantage API key unavailable");
}
const currencies = marketAlphaCurrencies(providerSymbol);
if (!currencies) {
throw new Error("Unsupported Alpha Vantage symbol");
}
const apiUrl = new URL(
"https://www.alphavantage.co/query"
);
apiUrl.searchParams.set("from_symbol", currencies.from);
apiUrl.searchParams.set("to_symbol", currencies.to);
apiUrl.searchParams.set("apikey", env.ALPHA_VANTAGE_API_KEY);
let functionName;
if (["1min", "5min", "15min", "30min", "1h"].includes(interval)) {
functionName = "FX_INTRADAY";
    const alphaInterval = interval === "1h"
      ? "60min"
      : interval;

    apiUrl.searchParams.set("function", functionName);
    apiUrl.searchParams.set("interval", alphaInterval);
    apiUrl.searchParams.set("outputsize", "full");

} else if (interval === "1day") {
functionName = "FX_DAILY";
apiUrl.searchParams.set("function", functionName);
apiUrl.searchParams.set("outputsize", "full");
} else if (interval === "1week") {
functionName = "FX_WEEKLY";
apiUrl.searchParams.set("function", functionName);
} else if (interval === "1month") {
functionName = "FX_MONTHLY";
apiUrl.searchParams.set("function", functionName);
} else {
throw new Error("Unsupported Alpha Vantage interval");
}
const data = await marketFetchJson(apiUrl.toString());
const seriesKey = Object.keys(data).find(key =>
key.toLowerCase().includes("time series")
);
if (!seriesKey || !data[seriesKey]) {
throw new Error("Alpha Vantage returned no historical series");
}
const entries = Object.entries(data[seriesKey])
.slice(0, outputsize);
const candles = entries.map(([time, item]) => ({
time,
open: Number(item["1. open"]),
high: Number(item["2. high"]),
low: Number(item["3. low"]),
close: Number(item["4. close"]),
volume: 0
}));
return marketValidateCandles(candles);
}

/* =========================================
MARKET CANDLE VALIDATION
========================================= */
function marketValidateCandles(candles) {
if (!Array.isArray(candles)) {
throw new Error("Invalid candle collection");
}
return candles
.filter(candle => {
const timeIsValid =
Boolean(candle.time) &&
Number.isFinite(Date.parse(candle.time));
      const pricesAreValid =
        Number.isFinite(candle.open) &&
        candle.open > 0 &&
        Number.isFinite(candle.high) &&
        candle.high > 0 &&
        Number.isFinite(candle.low) &&
        candle.low > 0 &&
        Number.isFinite(candle.close) &&
        candle.close > 0;

      const rangeIsValid =
        candle.high >= Math.max(
          candle.open,
          candle.close,
          candle.low
        ) &&
        candle.low <= Math.min(
          candle.open,
          candle.close,
          candle.high
        );

      return timeIsValid && pricesAreValid && rangeIsValid;
    })
    .sort(
      (a, b) =>
        Date.parse(a.time) - Date.parse(b.time)
    );
}

/* =========================================
PROVIDER FAILOVER
========================================= */
async function marketGetPrice(
providerSymbol,
env
) {
const providers = [
{
name: "Twelve Data",
enabled: Boolean(env.TWELVE_DATA_API_KEY),
run: () => marketTwelveDataPrice(providerSymbol, env)
},
{
name: "Finnhub",
enabled: Boolean(env.FINNHUB_API_KEY),
run: () => marketFinnhubPrice(providerSymbol, env)
}
];
const errors = [];
for (const provider of providers) {
if (!provider.enabled) continue;
    try {
      const result = await provider.run();

      return {
        ...result,
        status: "LIVE"
      };

    } catch (error) {
      console.error(
        `${provider.name} price provider failed:`,
        error.message
      );

      errors.push({
        provider: provider.name,
        message: error.message
      });
    }
}
throw new Error(
errors.length
? "All configured live price providers failed"
: "No market data provider is configured"
);
}

async function marketGetCandles(
providerSymbol,
interval,
outputsize,
env
) {
const providers = [
{
name: "Twelve Data",
enabled: Boolean(env.TWELVE_DATA_API_KEY),
run: () => marketTwelveDataCandles(
providerSymbol,
interval,
outputsize,
env
)
},
{
name: "Finnhub",
enabled: Boolean(env.FINNHUB_API_KEY),
run: () => marketFinnhubCandles(
providerSymbol,
interval,
outputsize,
env
)
},
{
name: "Alpha Vantage",
enabled: Boolean(env.ALPHA_VANTAGE_API_KEY),
run: () => marketAlphaVantageCandles(
providerSymbol,
interval,
outputsize,
env
)
}
];
const errors = [];
for (const provider of providers) {
if (!provider.enabled) continue;
    try {
      const candles = await provider.run();

      if (!candles.length) {
        throw new Error("Provider returned no valid candles");
      }

      return {
        candles,
        source: provider.name
      };

    } catch (error) {
      console.error(
        `${provider.name} candle provider failed:`,
        error.message
      );

      errors.push({
        provider: provider.name,
        message: error.message
      });
    }
}
throw new Error(
errors.length
? "All configured historical data providers failed"
: "No historical market data provider is configured"
);
}
// ============================================================
// PHASE 4 — MULTI-STRATEGY ANALYSIS ENGINE
// ============================================================
const STRATEGY_TIMEFRAMES = {
"1min": "1m",
"5min": "5m",
"15min": "15m",
"30min": "30m",
"1hour": "1h",
"4hour": "4h",
"1day": "1day",
M1: "1m",
M5: "5m",
M15: "15m",
M30: "30m",
H1: "1h",
H4: "4h",
D1: "1day"
};
const STRATEGY_NAMES = new Set([
"price_action",
"smc",
"ict",
"wyckoff",
"volume",
"trend",
"support_resistance"
]);
function strategyNumber(value, fallback = 0) {
const number = Number(value);
return Number.isFinite(number) ? number : fallback;
}
function strategyCandle(candle) {
if (!candle || typeof candle !== "object") return null;
const open = strategyNumber(candle.open);
const high = strategyNumber(candle.high);
const low = strategyNumber(candle.low);
const close = strategyNumber(candle.close);
const volume = strategyNumber(candle.volume);
if (
!Number.isFinite(open) ||
!Number.isFinite(high) ||
!Number.isFinite(low) ||
!Number.isFinite(close) ||
high < low ||
high < Math.max(open, close) ||
low > Math.min(open, close)
) {
return null;
}
return {
time: candle.time ?? candle.datetime ?? candle.timestamp ?? null,
open,
high,
low,
close,
volume
};
}
function strategyNormalizeCandles(candles) {
if (!Array.isArray(candles)) return [];
return candles
.map(strategyCandle)
.filter(Boolean)
.sort((a, b) => {
const ta = new Date(a.time).getTime();
const tb = new Date(b.time).getTime();
      if (Number.isFinite(ta) && Number.isFinite(tb)) {
        return ta - tb;
      }

      return 0;
    });
}
function strategyBody(candle) {
return Math.abs(candle.close - candle.open);
}
function strategyRange(candle) {
return Math.max(candle.high - candle.low, Number.EPSILON);
}
function strategyBullish(candle) {
return candle.close > candle.open;
}
function strategyBearish(candle) {
return candle.close < candle.open;
}
function strategyAverage(values) {
if (!values.length) return 0;
return values.reduce((sum, value) => sum + value, 0) /
values.length;
}
function strategyPercentChange(current, previous) {
if (!previous) return 0;
return ((current - previous) / Math.abs(previous)) * 100;
}
function strategyDirectionScore(score) {
if (score >= 2) return "BUY";
if (score <= -2) return "SELL";
return "NEUTRAL";
}
function strategySwingPoints(candles, strength = 2) {
const highs = [];
const lows = [];
for (
let i = strength;
i < candles.length - strength;
i++
) {
const current = candles[i];
    let isHigh = true;
    let isLow = true;

    for (let j = 1; j <= strength; j++) {
      if (
        current.high <= candles[i - j].high ||
        current.high <= candles[i + j].high
      ) {
        isHigh = false;
      }

      if (
        current.low >= candles[i - j].low ||
        current.low >= candles[i + j].low
      ) {
        isLow = false;
      }
    }

    if (isHigh) {
      highs.push({
        index: i,
        price: current.high,
        time: current.time
      });
    }

    if (isLow) {
      lows.push({
        index: i,
        price: current.low,
        time: current.time
      });
    }
}
return { highs, lows };
}
function strategyEMA(values, period) {
if (values.length < period) return null;
const multiplier = 2 / (period + 1);
let ema = strategyAverage(values.slice(0, period));
for (let i = period; i < values.length; i++) {
ema =
values[i] * multiplier +
ema * (1 - multiplier);
}
return ema;
}
function strategyPriceAction(candles) {
const results = {
strategy: "price_action",
direction: "NEUTRAL",
score: 0,
patterns: [],
structure: "UNCONFIRMED",
explanation: []
};
if (candles.length < 10) {
results.explanation.push(
"Insufficient candles for reliable price action analysis."
);
return results;
}
const current = candles[candles.length - 1];
const previous = candles[candles.length - 2];
const body = strategyBody(current);
const range = strategyRange(current);
const upperWick = current.high -
Math.max(current.open, current.close);
const lowerWick = Math.min(
current.open,
current.close
) - current.low;
// Bullish engulfing
if (
strategyBearish(previous) &&
strategyBullish(current) &&
current.open <= previous.close &&
current.close >= previous.open
) {
results.patterns.push("BULLISH_ENGULFING");
results.score += 2;
}
// Bearish engulfing
if (
strategyBullish(previous) &&
strategyBearish(current) &&
current.open >= previous.close &&
current.close <= previous.open
) {
results.patterns.push("BEARISH_ENGULFING");
results.score -= 2;
}
// Bullish pin bar
if (
lowerWick >= body * 2 &&
lowerWick >= range * 0.55 &&
upperWick <= range * 0.25
) {
results.patterns.push("BULLISH_PIN_BAR");
results.score += 1;
}
// Bearish pin bar
if (
upperWick >= body * 2 &&
upperWick >= range * 0.55 &&
lowerWick <= range * 0.25
) {
results.patterns.push("BEARISH_PIN_BAR");
results.score -= 1;
}
// Doji
if (body <= range * 0.1) {
results.patterns.push("DOJI");
}
const recent = candles.slice(-6);
const bullishCount = recent.filter(
strategyBullish
).length;
const bearishCount = recent.filter(
strategyBearish
).length;
if (bullishCount >= 5) {
results.patterns.push("BULLISH_MOMENTUM");
results.score += 1;
}
if (bearishCount >= 5) {
results.patterns.push("BEARISH_MOMENTUM");
results.score -= 1;
}
const previousHigh = Math.max(
...candles.slice(-11, -1).map(c => c.high)
);
const previousLow = Math.min(
...candles.slice(-11, -1).map(c => c.low)
);
if (current.close > previousHigh) {
results.structure = "BULLISH_BREAKOUT";
results.score += 2;
} else if (current.close < previousLow) {
results.structure = "BEARISH_BREAKOUT";
results.score -= 2;
}
results.direction = strategyDirectionScore(
results.score
);
results.explanation.push(
`Detected patterns: ${results.patterns.length}.`
);
results.explanation.push(
`Price structure: ${results.structure}.`
);
return results;
}
function strategySMC(candles) {
const results = {
strategy: "smc",
direction: "NEUTRAL",
score: 0,
marketStructure: "UNCONFIRMED",
bos: null,
choch: null,
orderBlocks: [],
fairValueGaps: [],
explanation: []
};
if (candles.length < 20) {
results.explanation.push(
"At least 20 candles are required."
);
return results;
}
const swings = strategySwingPoints(candles, 2);
const current = candles[candles.length - 1];
const previous = candles[candles.length - 2];
const lastHigh = swings.highs.at(-1);
const previousHigh = swings.highs.at(-2);
const lastLow = swings.lows.at(-1);
const previousLow = swings.lows.at(-2);
if (lastHigh && previousHigh && lastLow && previousLow) {
const bullishStructure =
lastHigh.price > previousHigh.price &&
lastLow.price > previousLow.price;
    const bearishStructure =
      lastHigh.price < previousHigh.price &&
      lastLow.price < previousLow.price;

    if (bullishStructure) {
      results.marketStructure = "BULLISH";
      results.score += 2;
    } else if (bearishStructure) {
      results.marketStructure = "BEARISH";
      results.score -= 2;
    }
}
// Break of Structure
if (lastHigh && current.close > lastHigh.price) {
results.bos = "BULLISH_BOS";
results.score += 2;
} else if (lastLow && current.close < lastLow.price) {
results.bos = "BEARISH_BOS";
results.score -= 2;
}
// Change of Character approximation
if (
previousHigh &&
lastHigh &&
current.close > previousHigh.price &&
results.marketStructure === "BEARISH"
) {
results.choch = "BULLISH_CHOCH";
results.score += 2;
}
if (
previousLow &&
lastLow &&
current.close < previousLow.price &&
results.marketStructure === "BULLISH"
) {
results.choch = "BEARISH_CHOCH";
results.score -= 2;
}
// Fair Value Gap detection
for (let i = Math.max(2, candles.length - 30); i < candles.length; i++) {
const first = candles[i - 2];
const third = candles[i];
    if (third.low > first.high) {
      results.fairValueGaps.push({
        type: "BULLISH_FVG",
        low: first.high,
        high: third.low,
        index: i
      });
    }

    if (third.high < first.low) {
      results.fairValueGaps.push({
        type: "BEARISH_FVG",
        low: third.high,
        high: first.low,
        index: i
      });
    }
}
// Approximate order blocks:
// Last opposing candle before a strong displacement candle.
for (let i = Math.max(1, candles.length - 25); i < candles.length - 1; i++) {
const candle = candles[i];
const next = candles[i + 1];
    const displacement = strategyBody(next) >
      strategyRange(next) * 0.65;

    if (!displacement) continue;

    if (
      strategyBearish(candle) &&
      strategyBullish(next) &&
      next.close > candle.high
    ) {
      results.orderBlocks.push({
        type: "BULLISH_ORDER_BLOCK",
        low: candle.low,
        high: candle.high,
        index: i
      });
    }

    if (
      strategyBullish(candle) &&
      strategyBearish(next) &&
      next.close < candle.low
    ) {
      results.orderBlocks.push({
        type: "BEARISH_ORDER_BLOCK",
        low: candle.low,
        high: candle.high,
        index: i
      });
    }
}
results.fairValueGaps =
results.fairValueGaps.slice(-10);
results.orderBlocks =
results.orderBlocks.slice(-10);
results.direction = strategyDirectionScore(
results.score
);
results.explanation.push(
`Market structure: ${results.marketStructure}.`
);
results.explanation.push(
`Fair Value Gaps detected: ${results.fairValueGaps.length}.`
);
results.explanation.push(
`Potential order blocks detected: ${results.orderBlocks.length}.`
);
return results;
}
function strategyICT(candles) {
const results = {
strategy: "ict",
direction: "NEUTRAL",
score: 0,
liquiditySweep: null,
displacement: null,
dealingRange: null,
marketZone: null,
fairValueGaps: [],
explanation: []
};
if (candles.length < 20) {
results.explanation.push(
"Insufficient data for ICT analysis."
);
return results;
}
const current = candles[candles.length - 1];
const previous = candles[candles.length - 2];
const lookback = candles.slice(-21, -1);
const liquidityHigh = Math.max(
...lookback.map(c => c.high)
);
const liquidityLow = Math.min(
...lookback.map(c => c.low)
);
// Liquidity sweep above previous highs
if (
current.high > liquidityHigh &&
current.close < liquidityHigh
) {
results.liquiditySweep = "BUY_SIDE_LIQUIDITY_SWEPT";
results.score -= 2;
}
// Liquidity sweep below previous lows
if (
current.low < liquidityLow &&
current.close > liquidityLow
) {
results.liquiditySweep = "SELL_SIDE_LIQUIDITY_SWEPT";
results.score += 2;
}
// Displacement
const averageBody = strategyAverage(
candles.slice(-11, -1).map(strategyBody)
);
if (
strategyBody(current) > averageBody * 1.8 &&
strategyBullish(current)
) {
results.displacement = "BULLISH_DISPLACEMENT";
results.score += 2;
} else if (
strategyBody(current) > averageBody * 1.8 &&
strategyBearish(current)
) {
results.displacement = "BEARISH_DISPLACEMENT";
results.score -= 2;
}
// Premium and discount zones
const rangeHigh = Math.max(
...lookback.map(c => c.high)
);
const rangeLow = Math.min(
...lookback.map(c => c.low)
);
const equilibrium = (rangeHigh + rangeLow) / 2;
results.dealingRange = {
high: rangeHigh,
low: rangeLow,
equilibrium
};
if (current.close > equilibrium) {
results.marketZone = "PREMIUM";
} else if (current.close < equilibrium) {
results.marketZone = "DISCOUNT";
} else {
results.marketZone = "EQUILIBRIUM";
}
// Three-candle FVG
for (let i = Math.max(2, candles.length - 20); i < candles.length; i++) {
const first = candles[i - 2];
const third = candles[i];
    if (third.low > first.high) {
      results.fairValueGaps.push({
        type: "BULLISH",
        low: first.high,
        high: third.low
      });
    }

    if (third.high < first.low) {
      results.fairValueGaps.push({
        type: "BEARISH",
        low: third.high,
        high: first.low
      });
    }
}
results.direction = strategyDirectionScore(
results.score
);
results.explanation.push(
`Liquidity event: ${results.liquiditySweep || "NONE"}.`
);
results.explanation.push(
`Displacement: ${results.displacement || "NONE"}.`
);
results.explanation.push(
`Current dealing range zone: ${results.marketZone}.`
);
return results;
}
function strategyWyckoff(candles) {
const results = {
strategy: "wyckoff",
direction: "NEUTRAL",
score: 0,
phase: "UNCONFIRMED",
events: [],
explanation: []
};
if (candles.length < 30) {
results.explanation.push(
"At least 30 candles are required."
);
return results;
}
const current = candles[candles.length - 1];
const recent = candles.slice(-20);
const rangeHigh = Math.max(
...recent.map(c => c.high)
);
const rangeLow = Math.min(
...recent.map(c => c.low)
);
const averageRange = strategyAverage(
recent.map(strategyRange)
);
const averageVolume = strategyAverage(
recent.map(c => c.volume).filter(v => v > 0)
);
const currentVolume = current.volume;
// Spring: price breaks below range and closes back inside.
if (
current.low < rangeLow &&
current.close > rangeLow
) {
results.events.push("POTENTIAL_SPRING");
results.score += 2;
}
// Upthrust: price breaks above range and closes back inside.
if (
current.high > rangeHigh &&
current.close < rangeHigh
) {
results.events.push("POTENTIAL_UPTHRUST");
results.score -= 2;
}
// Potential high-volume stopping action.
if (
averageVolume > 0 &&
currentVolume > averageVolume * 1.5 &&
strategyRange(current) > averageRange
) {
if (strategyBullish(current)) {
results.events.push("HIGH_VOLUME_BUYING_PRESSURE");
results.score += 1;
} else if (strategyBearish(current)) {
results.events.push("HIGH_VOLUME_SELLING_PRESSURE");
results.score -= 1;
}
}
if (results.score >= 2) {
results.phase = "POTENTIAL_ACCUMULATION";
} else if (results.score <= -2) {
results.phase = "POTENTIAL_DISTRIBUTION";
} else {
results.phase = "TRADING_RANGE_OR_UNCONFIRMED";
}
results.direction = strategyDirectionScore(
results.score
);
results.explanation.push(
`Wyckoff phase estimate: ${results.phase}.`
);
results.explanation.push(
"Wyckoff events are heuristic estimates, not confirmed institutional activity."
);
return results;
}
function strategyVolume(candles) {
const results = {
strategy: "volume",
direction: "NEUTRAL",
score: 0,
available: false,
relativeVolume: null,
condition: "VOLUME_UNAVAILABLE",
explanation: []
};
const valid = candles.filter(c => c.volume > 0);
if (valid.length < 10) {
results.explanation.push(
"Reliable volume data is unavailable for this market feed."
);
    return results;
}
results.available = true;
const current = valid[valid.length - 1];
const averageVolume = strategyAverage(
valid.slice(-21, -1).map(c => c.volume)
);
if (!averageVolume) {
return results;
}
results.relativeVolume =
current.volume / averageVolume;
if (results.relativeVolume >= 2) {
results.condition = "VERY_HIGH_VOLUME";
} else if (results.relativeVolume >= 1.5) {
results.condition = "HIGH_VOLUME";
} else if (results.relativeVolume <= 0.5) {
results.condition = "LOW_VOLUME";
} else {
results.condition = "NORMAL_VOLUME";
}
if (
results.relativeVolume >= 1.5 &&
strategyBullish(current)
) {
results.score += 1;
}
if (
results.relativeVolume >= 1.5 &&
strategyBearish(current)
) {
results.score -= 1;
}
results.direction = strategyDirectionScore(
results.score
);
results.explanation.push(
`Relative volume: ${results.relativeVolume.toFixed(2)}x average.`
);
results.explanation.push(
`Volume condition: ${results.condition}.`
);
return results;
}
function strategyTrend(candles) {
const results = {
strategy: "trend",
direction: "NEUTRAL",
score: 0,
ema20: null,
ema50: null,
ema200: null,
momentum: "NEUTRAL",
explanation: []
};
const closes = candles.map(c => c.close);
results.ema20 = strategyEMA(closes, 20);
results.ema50 = strategyEMA(closes, 50);
results.ema200 = strategyEMA(closes, 200);
const current = candles.at(-1);
if (results.ema20 !== null && results.ema50 !== null) {
if (
current.close > results.ema20 &&
results.ema20 > results.ema50
) {
results.score += 2;
results.momentum = "BULLISH";
} else if (
current.close < results.ema20 &&
results.ema20 < results.ema50
) {
results.score -= 2;
results.momentum = "BEARISH";
}
}
if (results.ema200 !== null) {
if (current.close > results.ema200) {
results.score += 1;
} else if (current.close < results.ema200) {
results.score -= 1;
}
}
results.direction = strategyDirectionScore(
results.score
);
results.explanation.push(
`Trend momentum: ${results.momentum}.`
);
return results;
}
function strategySupportResistance(candles) {
const results = {
strategy: "support_resistance",
direction: "NEUTRAL",
support: [],
resistance: [],
nearestSupport: null,
nearestResistance: null,
explanation: []
};
if (candles.length < 10) {
return results;
}
const swings = strategySwingPoints(candles, 2);
const currentPrice = candles.at(-1).close;
function clusterLevels(levels, tolerance) {
const clusters = [];
    for (const level of levels) {
      let cluster = clusters.find(item =>
        Math.abs(item.price - level.price) <= tolerance
      );

      if (!cluster) {
        cluster = {
          price: level.price,
          touches: 0
        };

        clusters.push(cluster);
      }

      cluster.price =
        (cluster.price * cluster.touches + level.price) /
        (cluster.touches + 1);

      cluster.touches++;
    }

    return clusters
      .filter(item => item.touches >= 1)
      .sort((a, b) => b.touches - a.touches);
}
const averageRange = strategyAverage(
candles.slice(-20).map(strategyRange)
);
const tolerance = averageRange * 0.15;
results.support = clusterLevels(
swings.lows.filter(x => x.price < currentPrice),
tolerance
).slice(0, 5);
results.resistance = clusterLevels(
swings.highs.filter(x => x.price > currentPrice),
tolerance
).slice(0, 5);
results.nearestSupport =
results.support.sort(
(a, b) => b.price - a.price
)[0] || null;
results.nearestResistance =
results.resistance.sort(
(a, b) => a.price - b.price
)[0] || null;
results.explanation.push(
`Support levels identified: ${results.support.length}.`
);
results.explanation.push(
`Resistance levels identified: ${results.resistance.length}.`
);
return results;
}
function strategyBuildConsensus(analyses) {
const weights = {
price_action: 1.2,
smc: 1.3,
ict: 1.2,
wyckoff: 1.0,
volume: 0.7,
trend: 1.3,
support_resistance: 0.8
};
let weightedScore = 0;
let totalWeight = 0;
const contributions = [];
for (const analysis of analyses) {
if (!analysis || !STRATEGY_NAMES.has(analysis.strategy)) {
continue;
}
    const weight = weights[analysis.strategy] || 1;
    const score = strategyNumber(analysis.score);

    weightedScore += score * weight;
    totalWeight += weight;

    contributions.push({
      strategy: analysis.strategy,
      direction: analysis.direction,
      score,
      weight
    });
}
const normalizedScore = totalWeight
? weightedScore / totalWeight
: 0;
let direction = "HOLD";
if (normalizedScore >= 0.65) {
direction = "BUY";
} else if (normalizedScore <= -0.65) {
direction = "SELL";
}
const confidence = Math.min(
95,
Math.max(
0,
Math.round(Math.abs(normalizedScore) * 35)
)
);
return {
direction,
normalizedScore: Number(normalizedScore.toFixed(3)),
confidence,
contributions,
agreement: contributions.length
? Math.round(
(
contributions.filter(x =>
direction === "BUY"
? x.score > 0
: direction === "SELL"
? x.score < 0
: x.score === 0
).length / contributions.length
) * 100
)
: 0
};
}
async function handleStrategyAnalysis(request, env, user, url) {
const symbol = String(
url.searchParams.get("symbol") || "EURUSD"
).toUpperCase();
const timeframe = String(
url.searchParams.get("timeframe") || "15min"
);
const normalizedTimeframe =
STRATEGY_TIMEFRAMES[timeframe];
if (!SYMBOLS[symbol]) {
return json({
ok: false,
error: "Unsupported market symbol."
}, 400);
}
if (!normalizedTimeframe) {
return json({
ok: false,
error: "Unsupported timeframe."
}, 400);
}
const requestedStrategies = String(
url.searchParams.get("strategies") || ""
)
.split(",")
.map(x => x.trim().toLowerCase())
.filter(x => STRATEGY_NAMES.has(x));
const selectedStrategies = requestedStrategies.length
? requestedStrategies
: [...STRATEGY_NAMES];
let candles;
try {
const marketResult = await marketGetCandles(
env,
symbol,
normalizedTimeframe,
250
);
    candles = strategyNormalizeCandles(
      marketResult?.candles || marketResult?.data || marketResult
    );
} catch (error) {
console.error(
"Strategy market-data error:",
error.message
);
    return json({
      ok: false,
      error: "Unable to retrieve candles for strategy analysis."
    }, 502);
}
if (candles.length < 20) {
return json({
ok: false,
error: "Insufficient historical candles.",
availableCandles: candles.length,
requiredCandles: 20
}, 422);
}
const analysisFunctions = {
price_action: strategyPriceAction,
smc: strategySMC,
ict: strategyICT,
wyckoff: strategyWyckoff,
volume: strategyVolume,
trend: strategyTrend,
support_resistance: strategySupportResistance
};
const analyses = [];
for (const name of selectedStrategies) {
try {
analyses.push(
analysisFunctions[name](candles)
);
} catch (error) {
console.error(
`Strategy ${name} failed:`,
error.message
);
      analyses.push({
        strategy: name,
        direction: "NEUTRAL",
        score: 0,
        error: "Strategy analysis unavailable."
      });
    }
}
const consensus = strategyBuildConsensus(
analyses
);
return json({
ok: true,
symbol,
timeframe,
candleCount: candles.length,
currentPrice: candles.at(-1).close,
generatedAt: new Date().toISOString(),
    consensus,

    strategies: analyses,

    disclaimer:
      "Strategy outputs are rule-based technical estimates, not guaranteed predictions or confirmed institutional order flow."
});
}
// ============================================================
// PHASE 5 — MULTI-TIMEFRAME CONFIRMATION ENGINE
// ============================================================
const MTF_CONFIG = {
"1min": {
lower: null,
entry: "1min",
higher: "5min"
},
"5min": {
lower: "1min",
entry: "5min",
higher: "15min"
},
"15min": {
lower: "5min",
entry: "15min",
higher: "1hour"
},
"30min": {
lower: "15min",
entry: "30min",
higher: "4hour"
},
"1hour": {
lower: "15min",
entry: "1hour",
higher: "4hour"
},
"4hour": {
lower: "1hour",
entry: "4hour",
higher: "1day"
},
"1day": {
lower: "4hour",
entry: "1day",
higher: null
}
};
const MTF_CANDLE_LIMIT = 250;
const MTF_MINIMUM_CANDLES = 50;
function mtfAnalyseCandles(candles, timeframe) {
const normalized = strategyNormalizeCandles(candles);
if (normalized.length < MTF_MINIMUM_CANDLES) {
return {
timeframe,
available: false,
direction: "HOLD",
score: 0,
reason: "Insufficient historical candles."
};
}
const trend = strategyTrend(normalized);
const priceAction = strategyPriceAction(normalized);
const smc = strategySMC(normalized);
const ict = strategyICT(normalized);
const components = [
trend,
priceAction,
smc,
ict
];
const consensus = strategyBuildConsensus(
components
);
const current = normalized.at(-1);
return {
timeframe,
available: true,
direction: consensus.direction,
confidence: consensus.confidence,
score: consensus.normalizedScore,
currentPrice: current.close,
    indicators: {
      ema20: trend.ema20,
      ema50: trend.ema50,
      ema200: trend.ema200
    },

    confirmations: {
      trend: trend.direction,
      priceAction: priceAction.direction,
      smc: smc.direction,
      ict: ict.direction
    },

    candleCount: normalized.length
};
}
function mtfCalculateConsensus(results) {
const weights = {
higher: 0.45,
entry: 0.40,
lower: 0.15
};
let totalScore = 0;
let totalWeight = 0;
const available = [];
for (const [name, result] of Object.entries(results)) {
if (!result || !result.available) continue;
    const weight = weights[name] || 0;

    if (!weight) continue;

    totalScore += result.score * weight;
    totalWeight += weight;

    available.push({
      timeframe: name,
      direction: result.direction,
      score: result.score,
      weight
    });
}
if (!totalWeight) {
return {
direction: "HOLD",
confidence: 0,
agreement: 0,
score: 0,
reason: "No valid timeframe data."
};
}
const normalizedScore = totalScore / totalWeight;
let direction = "HOLD";
if (normalizedScore >= 0.65) {
direction = "BUY";
} else if (normalizedScore <= -0.65) {
direction = "SELL";
}
const directionalMatches = available.filter(item => {
if (direction === "BUY") {
return item.direction === "BUY";
}
    if (direction === "SELL") {
      return item.direction === "SELL";
    }

    return item.direction === "HOLD";
});
const agreement = Math.round(
directionalMatches.length / available.length * 100
);
let confidence = Math.round(
Math.abs(normalizedScore) * 70
);
if (agreement < 50) {
confidence -= 15;
}
if (agreement === 100) {
confidence += 10;
}
confidence = Math.max(
0,
Math.min(95, confidence)
);
const conflict = available.some(item =>
direction === "BUY"
? item.direction === "SELL"
: direction === "SELL"
? item.direction === "BUY"
: false
);
return {
direction,
confidence,
agreement,
score: Number(normalizedScore.toFixed(3)),
conflict,
timeframeResults: available
};
}
function mtfBuildTradeLevels(candles, direction) {
const normalized = strategyNormalizeCandles(candles);
if (normalized.length < 20 || direction === "HOLD") {
return null;
}
const current = normalized.at(-1);
const recent = normalized.slice(-20);
const ranges = recent.map(strategyRange);
const atr = strategyAverage(ranges);
if (!Number.isFinite(atr) || atr <= 0) {
return null;
}
const recentLow = Math.min(
...recent.map(c => c.low)
);
const recentHigh = Math.max(
...recent.map(c => c.high)
);
const entry = current.close;
let stopLoss;
let takeProfit1;
let takeProfit2;
let takeProfit3;
if (direction === "BUY") {
stopLoss = Math.min(
recentLow,
entry - atr * 1.5
);
    const risk = entry - stopLoss;

    takeProfit1 = entry + risk;
    takeProfit2 = entry + risk * 2;
    takeProfit3 = entry + risk * 3;
} else {
stopLoss = Math.max(
recentHigh,
entry + atr * 1.5
);
    const risk = stopLoss - entry;

    takeProfit1 = entry - risk;
    takeProfit2 = entry - risk * 2;
    takeProfit3 = entry - risk * 3;
}
return {
entry,
stopLoss,
takeProfit1,
takeProfit2,
takeProfit3,
riskReward: {
tp1: 1,
tp2: 2,
tp3: 3
},
atr
};
}
async function handleMultiTimeframeAnalysis(
request,
env,
user,
url
) {
const symbol = String(
url.searchParams.get("symbol") || "EURUSD"
).toUpperCase();
const requestedTimeframe = String(
url.searchParams.get("timeframe") || "15min"
);
if (!SYMBOLS[symbol]) {
return json({
ok: false,
error: "Unsupported market symbol."
}, 400);
}
const config = MTF_CONFIG[requestedTimeframe];
if (!config) {
return json({
ok: false,
error: "Unsupported timeframe."
}, 400);
}
const timeframeRequests = {
entry: config.entry,
higher: config.higher,
lower: config.lower
};
const results = {};
const candleSets = {};
for (const [role, timeframe] of Object.entries(
timeframeRequests
)) {
if (!timeframe) {
results[role] = null;
continue;
}
    try {
      const marketResult = await marketGetCandles(
        env,
        symbol,
        STRATEGY_TIMEFRAMES[timeframe],
        MTF_CANDLE_LIMIT
      );

      const candles = strategyNormalizeCandles(
        marketResult?.candles ||
        marketResult?.data ||
        marketResult
      );

      candleSets[role] = candles;

      results[role] = mtfAnalyseCandles(
        candles,
        timeframe
      );

    } catch (error) {
      console.error(
        `MTF ${role} analysis failed:`,
        error.message
      );

      results[role] = {
        timeframe,
        available: false,
        direction: "HOLD",
        score: 0,
        reason: "Market data unavailable."
      };
    }
}
if (!results.entry?.available) {
return json({
ok: false,
error: "Entry timeframe data is unavailable.",
timeframe: requestedTimeframe
}, 502);
}
const consensus = mtfCalculateConsensus(results);
const levels = mtfBuildTradeLevels(
candleSets.entry,
consensus.direction
);
const higherTimeframe = results.higher;
const entryTimeframe = results.entry;
const lowerTimeframe = results.lower;
const warnings = [];
if (
higherTimeframe?.available &&
higherTimeframe.direction !== "HOLD" &&
consensus.direction !== "HOLD" &&
higherTimeframe.direction !== consensus.direction
) {
warnings.push(
"Higher timeframe direction conflicts with the overall signal."
);
}
if (
lowerTimeframe?.available &&
lowerTimeframe.direction !== "HOLD" &&
consensus.direction !== "HOLD" &&
lowerTimeframe.direction !== consensus.direction
) {
warnings.push(
"Lower timeframe entry confirmation conflicts with the overall signal."
);
}
if (consensus.conflict) {
warnings.push(
"Timeframe disagreement detected. Consider waiting for confirmation."
);
}
return json({
ok: true,
    symbol,

    requestedTimeframe,

    generatedAt: new Date().toISOString(),

    signal: {
      direction: consensus.direction,
      confidence: consensus.confidence,
      agreement: consensus.agreement,
      conflict: consensus.conflict
    },

    timeframes: {
      higher: results.higher,
      entry: results.entry,
      lower: results.lower
    },

    tradeLevels: levels,

    warnings,

    analysis: {
      model: "RULE_BASED_MULTI_TIMEFRAME",
      timeframeCount: Object.values(results).filter(
        x => x?.available
      ).length,
      candleLimit: MTF_CANDLE_LIMIT
    },

    disclaimer:
      "Signals are technical estimates based on historical candle data. They are not guaranteed trading outcomes."
});
}
// ============================================================
// PHASE 6 — TRADE EXECUTION AND RISK MANAGEMENT
// ============================================================
const TRADE_RISK_CONFIG = {
minimumRiskPercent: 0.25,
maximumRiskPercent: 3,
defaultRiskPercent: 1,
maximumDerivStakeUSD: 10,
maximumOpenTrades: 5,
maximumDailyLossPercent: 5,
maximumConsecutiveLosses: 3,
minimumRiskReward: 1.5,
requireStopLoss: true,
requireUserAuthorization: true
};
const TRADE_EXECUTION_MODES = new Set([
"MANUAL",
"ASSISTED",
"AUTOMATED"
]);
function validateTradeParameters(input) {
const errors = [];
const direction = String(
input.direction || ""
).toUpperCase();
const entry = Number(input.entry);
const stopLoss = Number(input.stopLoss);
const takeProfit = Number(input.takeProfit);
const riskPercent = Number(
input.riskPercent ??
TRADE_RISK_CONFIG.defaultRiskPercent
);
const balance = Number(input.balance);
if (!["BUY", "SELL"].includes(direction)) {
errors.push("Invalid trade direction.");
}
if (
!Number.isFinite(entry) ||
!Number.isFinite(stopLoss) ||
!Number.isFinite(takeProfit) ||
entry <= 0 ||
stopLoss <= 0 ||
takeProfit <= 0
) {
errors.push("Invalid entry, stop-loss or take-profit.");
}
if (
!Number.isFinite(balance) ||
balance <= 0
) {
errors.push("A valid account balance is required.");
}
if (
!Number.isFinite(riskPercent) ||
riskPercent < TRADE_RISK_CONFIG.minimumRiskPercent ||
riskPercent > TRADE_RISK_CONFIG.maximumRiskPercent
) {
errors.push("Risk percentage is outside permitted limits.");
}
if (
direction === "BUY" &&
Number.isFinite(entry) &&
Number.isFinite(stopLoss) &&
Number.isFinite(takeProfit)
) {
if (stopLoss >= entry) {
errors.push("BUY stop-loss must be below entry.");
}
    if (takeProfit <= entry) {
      errors.push("BUY take-profit must be above entry.");
    }
}
if (
direction === "SELL" &&
Number.isFinite(entry) &&
Number.isFinite(stopLoss) &&
Number.isFinite(takeProfit)
) {
if (stopLoss <= entry) {
errors.push("SELL stop-loss must be above entry.");
}
    if (takeProfit >= entry) {
      errors.push("SELL take-profit must be below entry.");
    }
}
if (errors.length) {
return {
valid: false,
errors
};
}
const riskAmount = balance * riskPercent / 100;
const distanceToStop = Math.abs(
entry - stopLoss
);
const distanceToTarget = Math.abs(
takeProfit - entry
);
const riskReward =
distanceToTarget / distanceToStop;
if (
riskReward <
TRADE_RISK_CONFIG.minimumRiskReward
) {
return {
valid: false,
errors: [
"Risk-to-reward ratio is below the permitted minimum."
]
};
}
return {
valid: true,
direction,
entry,
stopLoss,
takeProfit,
riskPercent,
riskAmount,
riskReward
};
}
function calculatePositionSize({
balance,
riskPercent,
stopDistance,
valuePerUnit
}) {
const accountBalance = Number(balance);
const risk = Number(riskPercent);
const distance = Number(stopDistance);
const unitValue = Number(valuePerUnit);
if (
!Number.isFinite(accountBalance) ||
!Number.isFinite(risk) ||
!Number.isFinite(distance) ||
!Number.isFinite(unitValue) ||
accountBalance <= 0 ||
risk <= 0 ||
distance <= 0 ||
unitValue <= 0
) {
return {
ok: false,
error: "Invalid position sizing parameters."
};
}
const riskAmount =
accountBalance * risk / 100;
const positionSize =
riskAmount / (distance * unitValue);
if (!Number.isFinite(positionSize)) {
return {
ok: false,
error: "Position size calculation failed."
};
}
return {
ok: true,
riskAmount,
positionSize,
riskPercent: risk
};
}
function validateDerivStake(stake) {
const amount = Number(stake);
if (
!Number.isFinite(amount) ||
amount <= 0
) {
return {
valid: false,
error: "Invalid Deriv stake."
};
}
if (
amount >
TRADE_RISK_CONFIG.maximumDerivStakeUSD
) {
return {
valid: false,
error: "Deriv stake exceeds the USD 10 maximum."
};
}
return {
valid: true,
stake: amount,
currency: "USD"
};
}
function validateExecutionMode(mode) {
const normalized = String(
mode || "MANUAL"
).toUpperCase();
if (!TRADE_EXECUTION_MODES.has(normalized)) {
return {
valid: false,
error: "Unsupported execution mode."
};
}
return {
valid: true,
mode: normalized
};
}
async function handleRiskAssessment(request, env, user) {
let body;
try {
body = await readJson(request);
} catch (error) {
return json({
ok: false,
error: error?.code === "BODY_TOO_LARGE" ? "Request body too large." : "Invalid JSON request."
}, error?.code === "BODY_TOO_LARGE" ? 413 : 400);
}
const result = validateTradeParameters(body);
if (!result.valid) {
return json({
ok: false,
valid: false,
errors: result.errors
}, 400);
}
const mode = validateExecutionMode(
body.executionMode
);
if (!mode.valid) {
return json({
ok: false,
error: mode.error
}, 400);
}
return json({
ok: true,
valid: true,
    userId: user.id,

    riskAssessment: {
      direction: result.direction,
      entry: result.entry,
      stopLoss: result.stopLoss,
      takeProfit: result.takeProfit,
      riskPercent: result.riskPercent,
      riskAmount: Number(
        result.riskAmount.toFixed(2)
      ),
      riskReward: Number(
        result.riskReward.toFixed(2)
      )
    },

    execution: {
      mode: mode.mode,
      tradePlaced: false,
      userAuthorizationRequired: true
    },

    message:
      "Risk assessment completed. No trade has been placed."
});
}
const USER_RISK_DEFAULTS = {
accountEquity: 10000,
riskPerTradePct: 1,
dailyLossLimitPct: 3,
maxDrawdownPct: 10,
currentDailyLoss: 0,
peakEquity: 10000,
riskMode: "fixed",
updatedAt: null
};
async function riskSettingsGet(env, userId) {
if (!env.DB) return { ...USER_RISK_DEFAULTS };
const row = await env.DB.prepare(`
SELECT account_equity, risk_per_trade_pct, daily_loss_limit_pct,
       max_drawdown_pct, current_daily_loss, peak_equity, risk_mode, updated_at
FROM user_risk_settings WHERE user_id = ?
`).bind(userId).first();
if (!row) return { ...USER_RISK_DEFAULTS };
return {
accountEquity: Number(row.account_equity),
riskPerTradePct: Number(row.risk_per_trade_pct),
dailyLossLimitPct: Number(row.daily_loss_limit_pct),
maxDrawdownPct: Number(row.max_drawdown_pct),
currentDailyLoss: Number(row.current_daily_loss),
peakEquity: Number(row.peak_equity),
riskMode: row.risk_mode === "percentage" ? "percentage" : "fixed",
updatedAt: row.updated_at
};
}
async function handleRiskSettings(request, env, user) {
if (!env.DB) return json({ ok: false, error: "Risk settings database is unavailable." }, 503);
if (request.method === "PUT") {
let input;
try { input = await readJson(request); } catch (error) { return json({ ok: false, error: error?.code === "BODY_TOO_LARGE" ? "Request body too large." : "Invalid JSON request." }, error?.code === "BODY_TOO_LARGE" ? 413 : 400); }
if (!input || typeof input !== "object" || Array.isArray(input)) return json({ ok: false, error: "Invalid risk settings." }, 400);
const number = (value, fallback) => value === undefined || value === null || value === "" ? fallback : Number(value);
const settings = {
accountEquity: number(input.accountEquity, USER_RISK_DEFAULTS.accountEquity),
riskPerTradePct: number(input.riskPerTradePct, USER_RISK_DEFAULTS.riskPerTradePct),
dailyLossLimitPct: number(input.dailyLossLimitPct, USER_RISK_DEFAULTS.dailyLossLimitPct),
maxDrawdownPct: number(input.maxDrawdownPct, USER_RISK_DEFAULTS.maxDrawdownPct),
currentDailyLoss: number(input.currentDailyLoss, USER_RISK_DEFAULTS.currentDailyLoss),
peakEquity: number(input.peakEquity, USER_RISK_DEFAULTS.peakEquity),
riskMode: input.riskMode === "percentage" ? "percentage" : "fixed"
};
if (!Object.values(settings).filter(v => typeof v === "number").every(Number.isFinite) ||
settings.accountEquity <= 0 || settings.accountEquity > 1000000000 ||
settings.riskPerTradePct < 0.1 || settings.riskPerTradePct > 5 ||
settings.dailyLossLimitPct < 0.5 || settings.dailyLossLimitPct > 20 ||
settings.maxDrawdownPct < 1 || settings.maxDrawdownPct > 50 ||
settings.currentDailyLoss < 0 || settings.currentDailyLoss > 1000000000 ||
settings.peakEquity < settings.accountEquity || settings.peakEquity > 1000000000) {
return json({ ok: false, error: "Risk settings are outside the permitted limits. Check equity, risk percentages and loss values." }, 400);
}
const updatedAt = new Date().toISOString();
await env.DB.prepare(`
INSERT INTO user_risk_settings (
user_id, account_equity, risk_per_trade_pct, daily_loss_limit_pct,
max_drawdown_pct, current_daily_loss, peak_equity, risk_mode, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
account_equity = excluded.account_equity,
risk_per_trade_pct = excluded.risk_per_trade_pct,
daily_loss_limit_pct = excluded.daily_loss_limit_pct,
max_drawdown_pct = excluded.max_drawdown_pct,
current_daily_loss = excluded.current_daily_loss,
peak_equity = excluded.peak_equity,
risk_mode = excluded.risk_mode,
updated_at = excluded.updated_at
`).bind(user.id, settings.accountEquity, settings.riskPerTradePct,
settings.dailyLossLimitPct, settings.maxDrawdownPct, settings.currentDailyLoss,
settings.peakEquity, settings.riskMode, updatedAt).run();
return json({ ok: true, userSettings: { ...settings, updatedAt }, message: "Risk settings saved." });
}
const userSettings = await riskSettingsGet(env, user.id);
return json({
ok: true,
userSettings,
risk: {
minimumRiskPercent: TRADE_RISK_CONFIG.minimumRiskPercent,
maximumRiskPercent: TRADE_RISK_CONFIG.maximumRiskPercent,
defaultRiskPercent: TRADE_RISK_CONFIG.defaultRiskPercent,
maximumOpenTrades: TRADE_RISK_CONFIG.maximumOpenTrades,
maximumDailyLossPercent: TRADE_RISK_CONFIG.maximumDailyLossPercent,
minimumRiskReward: TRADE_RISK_CONFIG.minimumRiskReward
},
deriv: { maximumStakeUSD: TRADE_RISK_CONFIG.maximumDerivStakeUSD, demoOnly: true },
executionModes: ["MANUAL", "ASSISTED", "AUTOMATED"]
});
}
// ============================================================
// TRADE JOURNAL CONFIGURATION
// ============================================================
const TRADE_JOURNAL_CONFIG = {
maximumNotesLength: 2000,
maximumPageSize: 100,
allowedDirections: new Set([
"BUY",
"SELL"
]),
allowedStatuses: new Set([
"OPEN",
"CLOSED",
"CANCELLED"
]),
allowedExecutionModes: new Set([
"MANUAL",
"ASSISTED",
"AUTOMATED"
])
};
function journalNumber(value, fallback = null) {
if (value === null || value === undefined || value === "") {
return fallback;
}
const number = Number(value);
return Number.isFinite(number) ? number : fallback;
}
function journalText(value, maximumLength = 100) {
return String(value || "")
.trim()
.slice(0, maximumLength);
}
function journalNow() {
return new Date().toISOString();
}
function journalGenerateId() {
return crypto.randomUUID();
}
async function journalCreateTrade(request, env, user) {
if (!env.DB) {
return json({
ok: false,
error: "Trade journal database is unavailable."
}, 503);
}
let body;
try {
body = await readJson(request);
} catch (error) {
return json({
ok: false,
error: error?.code === "BODY_TOO_LARGE" ? "Request body too large." : "Invalid JSON request."
}, 400);
}
const symbol = journalText(
body.symbol,
32
).toUpperCase();
const direction = journalText(
body.direction,
10
).toUpperCase();
const entryPrice = journalNumber(
body.entryPrice
);
const stopLoss = journalNumber(
body.stopLoss
);
const takeProfit = journalNumber(
body.takeProfit
);
const quantity = journalNumber(
body.quantity
);
const stake = journalNumber(
body.stake
);
const riskPercent = journalNumber(
body.riskPercent
);
const riskAmount = journalNumber(
body.riskAmount
);
const executionMode = journalText(
body.executionMode || "MANUAL",
20
).toUpperCase();
if (!symbol || !/^[A-Z0-9_]{2,32}$/.test(symbol)) {
return json({
ok: false,
error: "Invalid market symbol."
}, 400);
}
if (!TRADE_JOURNAL_CONFIG.allowedDirections.has(direction)) {
return json({
ok: false,
error: "Direction must be BUY or SELL."
}, 400);
}
if (
entryPrice === null ||
entryPrice <= 0
) {
return json({
ok: false,
error: "A valid entry price is required."
}, 400);
}
if (
stopLoss !== null &&
stopLoss <= 0
) {
return json({
ok: false,
error: "Invalid stop-loss."
}, 400);
}
if (
takeProfit !== null &&
takeProfit <= 0
) {
return json({
ok: false,
error: "Invalid take-profit."
}, 400);
}
if (
quantity !== null &&
quantity <= 0
) {
return json({
ok: false,
error: "Quantity must be positive."
}, 400);
}
if (
stake !== null &&
stake <= 0
) {
return json({
ok: false,
error: "Stake must be positive."
}, 400);
}
if (
!TRADE_JOURNAL_CONFIG.allowedExecutionModes.has(
executionMode
)
) {
return json({
ok: false,
error: "Invalid execution mode."
}, 400);
}
const notes = journalText(
body.notes,
TRADE_JOURNAL_CONFIG.maximumNotesLength
);
const id = journalGenerateId();
const now = journalNow();
const openedAt = body.openedAt
? new Date(body.openedAt).toISOString()
: now;
try {
await env.DB.prepare(`INSERT INTO trade_journal ( id, user_id, symbol, direction, entry_price, stop_loss, take_profit, quantity, stake, risk_percent, risk_amount, strategy, timeframe, broker, execution_mode, status, notes, opened_at, created_at, updated_at ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)`).bind(
id,
user.id,
symbol,
direction,
entryPrice,
stopLoss,
takeProfit,
quantity,
stake,
riskPercent,
riskAmount,
journalText(body.strategy, 100),
journalText(body.timeframe, 20),
journalText(body.broker, 50),
executionMode,
notes,
openedAt,
now,
now
).run();
    return json({
      ok: true,
      message: "Trade journal record created.",
      trade: {
        id,
        symbol,
        direction,
        entryPrice,
        status: "OPEN",
        openedAt
      }
    }, 201);

} catch (error) {
console.error(
"Trade journal creation failed:",
error.message
);
    return json({
      ok: false,
      error: "Unable to create trade journal record."
    }, 500);
}
}
async function journalGetTrades(request, env, user, url) {
if (!env.DB) {
return json({
ok: false,
error: "Trade journal database is unavailable."
}, 503);
}
const status = String(
url.searchParams.get("status") || ""
).toUpperCase();
const symbol = String(
url.searchParams.get("symbol") || ""
).toUpperCase();
const limit = Math.min(
TRADE_JOURNAL_CONFIG.maximumPageSize,
Math.max(
1,
Number(url.searchParams.get("limit") || 50)
)
);
const offset = Math.max(
0,
Number(url.searchParams.get("offset") || 0)
);
if (
status &&
!TRADE_JOURNAL_CONFIG.allowedStatuses.has(status)
) {
return json({
ok: false,
error: "Invalid trade status filter."
}, 400);
}
let query = `SELECT * FROM trade_journal WHERE user_id = ?`;
const parameters = [user.id];
if (status) {
query += " AND status = ?";
parameters.push(status);
}
if (symbol) {
query += " AND symbol = ?";
parameters.push(symbol);
}
query += `ORDER BY opened_at DESC LIMIT ? OFFSET ?`;
parameters.push(limit, offset);
try {
const result = await env.DB.prepare(query)
.bind(...parameters)
.all();
    return json({
      ok: true,
      trades: result.results || [],
      pagination: {
        limit,
        offset,
        count: (result.results || []).length
      }
    });

} catch (error) {
console.error(
"Trade journal retrieval failed:",
error.message
);
    return json({
      ok: false,
      error: "Unable to retrieve trade history."
    }, 500);
}
}
async function journalCloseTrade(request, env, user, tradeId) {
if (!env.DB) {
return json({
ok: false,
error: "Trade journal database is unavailable."
}, 503);
}
if (
!tradeId ||
!/^[A-Za-z0-9-]{10,64}$/.test(tradeId)
) {
return json({
ok: false,
error: "Invalid trade identifier."
}, 400);
}
let body;
try {
body = await readJson(request);
} catch (error) {
return json({
ok: false,
error: error?.code === "BODY_TOO_LARGE" ? "Request body too large." : "Invalid JSON request."
}, 400);
}
const exitPrice = journalNumber(
body.exitPrice
);
const realizedPnl = journalNumber(
body.realizedPnl
);
const fees = journalNumber(
body.fees,
0
);
if (
exitPrice === null ||
exitPrice <= 0 ||
realizedPnl === null ||
fees === null ||
fees < 0
) {
return json({
ok: false,
error: "Valid exit price, realized P&L and fees are required."
}, 400);
}
const netPnl = realizedPnl - fees;
const now = journalNow();
try {
const result = await env.DB.prepare(`UPDATE trade_journal SET exit_price = ?, realized_pnl = ?, fees = ?, net_pnl = ?, status = 'CLOSED', closed_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'OPEN'`).bind(
exitPrice,
realizedPnl,
fees,
netPnl,
now,
now,
tradeId,
user.id
).run();
    if (!result.meta?.changes) {
      return json({
        ok: false,
        error: "Trade was not found, is not owned by this user, or is already closed."
      }, 404);
    }

    return json({
      ok: true,
      message: "Trade successfully closed in the journal.",
      trade: {
        id: tradeId,
        exitPrice,
        realizedPnl,
        fees,
        netPnl,
        status: "CLOSED",
        closedAt: now
      }
    });

} catch (error) {
console.error(
"Trade journal close failed:",
error.message
);
    return json({
      ok: false,
      error: "Unable to close trade journal record."
    }, 500);
}
}
function journalCalculatePerformance(trades) {
const closedTrades = trades.filter(
trade => trade.status === "CLOSED"
);
const wins = closedTrades.filter(
trade => Number(trade.net_pnl) > 0
);
const losses = closedTrades.filter(
trade => Number(trade.net_pnl) < 0
);
const breakeven = closedTrades.filter(
trade => Number(trade.net_pnl) === 0
);
const grossProfit = wins.reduce(
(sum, trade) => sum + Number(trade.net_pnl),
0
);
const grossLoss = Math.abs(
losses.reduce(
(sum, trade) => sum + Number(trade.net_pnl),
0
)
);
const netProfit = grossProfit - grossLoss;
const totalTrades = closedTrades.length;
const winRate = totalTrades
? wins.length / totalTrades * 100
: 0;
const lossRate = totalTrades
? losses.length / totalTrades * 100
: 0;
const averageWin = wins.length
? grossProfit / wins.length
: 0;
const averageLoss = losses.length
? grossLoss / losses.length
: 0;
const profitFactor = grossLoss > 0
? grossProfit / grossLoss
: grossProfit > 0
? null
: 0;
const averageTrade = totalTrades
? netProfit / totalTrades
: 0;
// Calculate drawdown from cumulative closed-trade P&L.
let cumulative = 0;
let peak = 0;
let maximumDrawdown = 0;
const chronological = [...closedTrades].sort(
(a, b) =>
new Date(a.closed_at).getTime() -
new Date(b.closed_at).getTime()
);
for (const trade of chronological) {
cumulative += Number(trade.net_pnl || 0);
    peak = Math.max(peak, cumulative);

    const drawdown = peak - cumulative;

    maximumDrawdown = Math.max(
      maximumDrawdown,
      drawdown
    );
}
return {
totalTrades,
winningTrades: wins.length,
losingTrades: losses.length,
breakevenTrades: breakeven.length,
    winRate: Number(winRate.toFixed(2)),
    lossRate: Number(lossRate.toFixed(2)),

    grossProfit: Number(grossProfit.toFixed(2)),
    grossLoss: Number(grossLoss.toFixed(2)),
    netProfit: Number(netProfit.toFixed(2)),

    averageWin: Number(averageWin.toFixed(2)),
    averageLoss: Number(averageLoss.toFixed(2)),
    averageTrade: Number(averageTrade.toFixed(2)),

    profitFactor: profitFactor === null
      ? null
      : Number(profitFactor.toFixed(2)),

    maximumDrawdown: Number(
      maximumDrawdown.toFixed(2)
    )
};
}
async function journalGetPerformance(env, user, url) {
if (!env.DB) {
return json({
ok: false,
error: "Trade journal database is unavailable."
}, 503);
}
try {
const result = await env.DB.prepare(`SELECT status, net_pnl, realized_pnl, fees, closed_at, opened_at, symbol, direction, strategy FROM trade_journal WHERE user_id = ? ORDER BY opened_at DESC LIMIT 5000`).bind(user.id).all();
    const trades = result.results || [];

    const performance =
      journalCalculatePerformance(trades);

    const openTrades = trades.filter(
      trade => trade.status === "OPEN"
    ).length;

    const symbolPerformance = {};

    for (const trade of trades) {
      if (trade.status !== "CLOSED") continue;

      const symbol = trade.symbol;

      if (!symbolPerformance[symbol]) {
        symbolPerformance[symbol] = {
          trades: 0,
          netProfit: 0,
          wins: 0,
          losses: 0
        };
      }

      const item = symbolPerformance[symbol];

      const pnl = Number(trade.net_pnl || 0);

      item.trades++;
      item.netProfit += pnl;

      if (pnl > 0) item.wins++;
      if (pnl < 0) item.losses++;
    }

    for (const item of Object.values(symbolPerformance)) {
      item.netProfit = Number(
        item.netProfit.toFixed(2)
      );

      item.winRate = item.trades
        ? Number(
            (item.wins / item.trades * 100).toFixed(2)
          )
        : 0;
    }

    return json({
      ok: true,

      performance: {
        ...performance,
        openTrades
      },

      symbolPerformance,

      generatedAt: journalNow(),

      note:
        "Performance is calculated from recorded journal trades, not independently verified broker statements."
    });

} catch (error) {
console.error(
"Trade performance calculation failed:",
error.message
);
    return json({
      ok: false,
      error: "Unable to calculate trading performance."
    }, 500);
}
}
/*
API EXAMPLES — TRADE JOURNAL
POST /api/trading/journal
Content-Type: application/json
{
"symbol": "EURUSD",
"direction": "BUY",
"entryPrice": 1.08500,
"stopLoss": 1.08300,
"takeProfit": 1.08900,
"quantity": 0.10,
"riskPercent": 1,
"riskAmount": 100,
"strategy": "SMC",
"timeframe": "15min",
"broker": "Deriv",
"executionMode": "ASSISTED",
"notes": "Bullish structure with higher-timeframe confirmation."
}
POST /api/trading/journal/TRADE_ID/close
Content-Type: application/json
{
"exitPrice": 1.08900,
"realizedPnl": 40,
"fees": 2
}
============================================================
PHASE 8 — TRADE MONITORING EVENTS DATABASE SCHEMA
CREATE TABLE IF NOT EXISTS trade_monitor_events (
id TEXT PRIMARY KEY,
user_id TEXT NOT NULL,
trade_id TEXT NOT NULL,
symbol TEXT NOT NULL,
event_type TEXT NOT NULL,
market_price REAL,
entry_price REAL,
stop_loss REAL,
take_profit REAL,
message TEXT,
created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_monitor_user
ON trade_monitor_events(user_id);
CREATE INDEX IF NOT EXISTS idx_monitor_trade
ON trade_monitor_events(trade_id);
CREATE INDEX IF NOT EXISTS idx_monitor_created
ON trade_monitor_events(user_id, created_at);
============================================================
END OF DOCUMENTATION
*/
// ============================================================
// TRADE MONITORING CONFIGURATION
// ============================================================
const TRADE_MONITOR_CONFIG = {
maximumPositionsPerRequest: 50,
maximumEventsPerRequest: 100,
priceDeviationWarningPercent: 0.5,
supportedEvents: new Set([
"STOP_LOSS_APPROACHED",
"TAKE_PROFIT_APPROACHED",
"STOP_LOSS_REACHED",
"TAKE_PROFIT_REACHED",
"ENTRY_REACHED"
])
};
function monitorCalculateMovement(
direction,
entryPrice,
currentPrice
) {
if (
!Number.isFinite(entryPrice) ||
!Number.isFinite(currentPrice) ||
entryPrice <= 0 ||
currentPrice <= 0
) {
return null;
}
const movement = direction === "BUY"
? currentPrice - entryPrice
: entryPrice - currentPrice;
const percentage =
movement / entryPrice * 100;
return {
priceDifference: Number(
movement.toFixed(8)
),
    percentage: Number(
      percentage.toFixed(5)
    ),

    favourable: movement > 0,
    unfavourable: movement < 0
};
}
function monitorDetectPositionEvents(
trade,
currentPrice
) {
const events = [];
const direction = String(
trade.direction || ""
).toUpperCase();
const entry = Number(trade.entry_price);
const stopLoss = Number(trade.stop_loss);
const takeProfit = Number(trade.take_profit);
if (
!Number.isFinite(currentPrice) ||
currentPrice <= 0 ||
!Number.isFinite(entry) ||
entry <= 0
) {
return events;
}
const movement = monitorCalculateMovement(
direction,
entry,
currentPrice
);
if (!movement) return events;
const stopDistance =
Number.isFinite(stopLoss) && stopLoss > 0
? Math.abs(entry - stopLoss)
: null;
const targetDistance =
Number.isFinite(takeProfit) && takeProfit > 0
? Math.abs(takeProfit - entry)
: null;
if (direction === "BUY") {
if (
stopLoss > 0 &&
currentPrice <= stopLoss
) {
events.push({
type: "STOP_LOSS_REACHED",
message: "Market price has reached or crossed the BUY stop-loss."
});
} else if (
stopDistance &&
currentPrice <= entry - stopDistance * 0.8
) {
events.push({
type: "STOP_LOSS_APPROACHED",
message: "Market price is approaching the BUY stop-loss."
});
}
    if (
      takeProfit > 0 &&
      currentPrice >= takeProfit
    ) {
      events.push({
        type: "TAKE_PROFIT_REACHED",
        message: "Market price has reached or crossed the BUY take-profit."
      });
    } else if (
      targetDistance &&
      currentPrice >= entry + targetDistance * 0.8
    ) {
      events.push({
        type: "TAKE_PROFIT_APPROACHED",
        message: "Market price is approaching the BUY take-profit."
      });
    }
}
if (direction === "SELL") {
if (
stopLoss > 0 &&
currentPrice >= stopLoss
) {
events.push({
type: "STOP_LOSS_REACHED",
message: "Market price has reached or crossed the SELL stop-loss."
});
} else if (
stopDistance &&
currentPrice >= entry + stopDistance * 0.8
) {
events.push({
type: "STOP_LOSS_APPROACHED",
message: "Market price is approaching the SELL stop-loss."
});
}
    if (
      takeProfit > 0 &&
      currentPrice <= takeProfit
    ) {
      events.push({
        type: "TAKE_PROFIT_REACHED",
        message: "Market price has reached or crossed the SELL take-profit."
      });
    } else if (
      targetDistance &&
      currentPrice <= entry - targetDistance * 0.8
    ) {
      events.push({
        type: "TAKE_PROFIT_APPROACHED",
        message: "Market price is approaching the SELL take-profit."
      });
    }
}
return events;
}
async function monitorSaveEvent(
env,
user,
trade,
event,
currentPrice
) {
if (!env.DB) return;
if (
!TRADE_MONITOR_CONFIG.supportedEvents.has(
event.type
)
) {
return;
}
const id = crypto.randomUUID();
const now = new Date().toISOString();
try {
// Avoid repeatedly saving the same alert
// for the same trade within five minutes.
const existing = await env.DB.prepare(`SELECT id FROM trade_monitor_events WHERE user_id = ? AND trade_id = ? AND event_type = ? AND created_at >= ? LIMIT 1`).bind(
user.id,
trade.id,
event.type,
new Date(Date.now() - 5 * 60 * 1000).toISOString()
).first();
    if (existing) return;

    await env.DB.prepare(`
      INSERT INTO trade_monitor_events (
        id,
        user_id,
        trade_id,
        symbol,
        event_type,
        market_price,
        entry_price,
        stop_loss,
        take_profit,
        message,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      user.id,
      trade.id,
      trade.symbol,
      event.type,
      currentPrice,
      trade.entry_price,
      trade.stop_loss,
      trade.take_profit,
      event.message,
      now
    ).run();

} catch (error) {
console.error(
"Unable to save trade monitoring event:",
error.message
);
}
}
async function monitorOpenPositions(
env,
user
) {
if (!env.DB) {
return {
ok: false,
error: "Trade database unavailable."
};
}
const result = await env.DB.prepare(`SELECT * FROM trade_journal WHERE user_id = ? AND status = 'OPEN' ORDER BY opened_at DESC LIMIT ?`).bind(
user.id,
TRADE_MONITOR_CONFIG.maximumPositionsPerRequest
).all();
const trades = result.results || [];
const monitored = [];
for (const trade of trades) {
let currentPrice = null;
let priceError = null;
    try {
      const marketResult = await marketGetPrice(
        env,
        trade.symbol
      );

      currentPrice = Number(
        marketResult?.price ??
        marketResult?.close ??
        marketResult?.data?.price
      );

      if (
        !Number.isFinite(currentPrice) ||
        currentPrice <= 0
      ) {
        currentPrice = null;
        priceError = "Market price unavailable.";
      }

    } catch (error) {
      priceError = error.message;
    }

    if (currentPrice === null) {
      monitored.push({
        tradeId: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        monitored: false,
        error: priceError
      });

      continue;
    }

    const movement = monitorCalculateMovement(
      trade.direction,
      Number(trade.entry_price),
      currentPrice
    );

    const events = monitorDetectPositionEvents(
      trade,
      currentPrice
    );

    for (const event of events) {
      await monitorSaveEvent(
        env,
        user,
        trade,
        event,
        currentPrice
      );
    }

    monitored.push({
      tradeId: trade.id,
      symbol: trade.symbol,
      direction: trade.direction,

      entryPrice: Number(trade.entry_price),
      currentPrice,

      stopLoss: trade.stop_loss,
      takeProfit: trade.take_profit,

      movement,

      events,

      status: "OPEN",
      monitored: true
    });
}
return {
ok: true,
positions: monitored,
count: monitored.length,
generatedAt: new Date().toISOString()
};
}
async function monitorGetEvents(
env,
user,
url
) {
if (!env.DB) {
return json({
ok: false,
error: "Trade database unavailable."
}, 503);
}
const limit = Math.min(
TRADE_MONITOR_CONFIG.maximumEventsPerRequest,
Math.max(
1,
Number(url.searchParams.get("limit") || 50)
)
);
const result = await env.DB.prepare(`SELECT * FROM trade_monitor_events WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).bind(
user.id,
limit
).all();
return json({
ok: true,
events: result.results || [],
count: (result.results || []).length
});
}
// PART 15: NOTIFICATIONS AND ALERT DELIVERY
// ============================================================
const NOTIFICATION_CONFIG = {
DEFAULT_LIMIT: 30,
MAX_LIMIT: 100,
MAX_TITLE_LENGTH: 120,
MAX_MESSAGE_LENGTH: 1000,
MAX_METADATA_LENGTH: 4000
};
function notificationId() {
return crypto.randomUUID();
}
function notificationNow() {
return new Date().toISOString();
}
function notificationText(value, maxLength) {
return String(value ?? "")
.trim()
.slice(0, maxLength);
}
function notificationLimit(value) {
const number = Number(value);
    if (!Number.isFinite(number)) {
        return NOTIFICATION_CONFIG.DEFAULT_LIMIT;
    }

    return Math.max(
        1,
        Math.min(
            NOTIFICATION_CONFIG.MAX_LIMIT,
            Math.floor(number)
        )
    );
}
async function notificationGetPreferences(env, userId) {
const defaults = {
inAppEnabled: true,
emailEnabled: false,
pushEnabled: false
};
    const result = await env.DB.prepare(`
        SELECT
            in_app_enabled,
            email_enabled,
            push_enabled
        FROM trade_notification_preferences
        WHERE user_id = ?
        LIMIT 1
    `).bind(userId).first();

    if (!result) {
        return defaults;
    }

    return {
        inAppEnabled: Number(result.in_app_enabled) === 1,
        emailEnabled: Number(result.email_enabled) === 1,
        pushEnabled: Number(result.push_enabled) === 1
    };
}
async function notificationCreate(
env,
userId,
type,
title,
message,
metadata = {}
) {
if (!env.DB) {
throw new Error("D1 database is not configured.");
}
    const preferences = await notificationGetPreferences(
        env,
        userId
    );

    if (!preferences.inAppEnabled) {
        return {
            ok: true,
            created: false,
            reason: "in_app_notifications_disabled"
        };
    }

    const safeType = notificationText(type, 50) || "general";

    const safeTitle = notificationText(
        title,
        NOTIFICATION_CONFIG.MAX_TITLE_LENGTH
    );

    const safeMessage = notificationText(
        message,
        NOTIFICATION_CONFIG.MAX_MESSAGE_LENGTH
    );

    if (!safeTitle || !safeMessage) {
        throw new Error("Notification title and message are required.");
    }

    let metadataJson = null;

    if (metadata && typeof metadata === "object") {
        metadataJson = JSON.stringify(metadata);

        if (
            metadataJson.length >
            NOTIFICATION_CONFIG.MAX_METADATA_LENGTH
        ) {
            throw new Error("Notification metadata is too large.");
        }
    }

    const id = notificationId();
    const createdAt = notificationNow();

    await env.DB.prepare(`
        INSERT INTO trade_notifications (
            id,
            user_id,
            type,
            title,
            message,
            metadata_json,
            read_at,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).bind(
        id,
        userId,
        safeType,
        safeTitle,
        safeMessage,
        metadataJson,
        createdAt
    ).run();

    return {
        ok: true,
        created: true,
        notification: {
            id,
            type: safeType,
            title: safeTitle,
            message: safeMessage,
            metadata,
            readAt: null,
            createdAt
        }
    };
}
async function notificationGetList(env, userId, limit) {
const result = await env.DB.prepare(`SELECT id, type, title, message, metadata_json, read_at, created_at FROM trade_notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`).bind(userId, limit).all();
    const rows = result.results || [];

    return rows.map(row => {
        let metadata = null;

        try {
            metadata = row.metadata_json
                ? JSON.parse(row.metadata_json)
                : null;
        } catch {
            metadata = null;
        }

        return {
            id: row.id,
            type: row.type,
            title: row.title,
            message: row.message,
            metadata,
            readAt: row.read_at,
            createdAt: row.created_at,
            unread: !row.read_at
        };
    });
}
async function notificationUnreadCount(env, userId) {
const result = await env.DB.prepare(`SELECT COUNT(*) AS total FROM trade_notifications WHERE user_id = ? AND read_at IS NULL`).bind(userId).first();
    return Number(result?.total || 0);
}
async function notificationMarkRead(env, userId, id) {
const result = await env.DB.prepare(`UPDATE trade_notifications SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL`).bind(
notificationNow(),
id,
userId
).run();
    return Number(result.meta?.changes || 0) > 0;
}
async function notificationMarkAllRead(env, userId) {
const result = await env.DB.prepare(`UPDATE trade_notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL`).bind(
notificationNow(),
userId
).run();
    return Number(result.meta?.changes || 0);
}
async function notificationSavePreferences(
env,
userId,
input
) {
const allowedKeys = [
"inAppEnabled",
"emailEnabled",
"pushEnabled"
];
    for (const key of Object.keys(input)) {
        if (!allowedKeys.includes(key)) {
            throw new Error(
                `Unsupported notification preference: ${key}`
            );
        }

        if (typeof input[key] !== "boolean") {
            throw new Error(
                `${key} must be true or false.`
            );
        }
    }

    const existing = await notificationGetPreferences(
        env,
        userId
    );

    const preferences = {
        inAppEnabled:
            input.inAppEnabled ?? existing.inAppEnabled,

        emailEnabled:
            input.emailEnabled ?? existing.emailEnabled,

        pushEnabled:
            input.pushEnabled ?? existing.pushEnabled
    };

    await env.DB.prepare(`
        INSERT INTO trade_notification_preferences (
            user_id,
            in_app_enabled,
            email_enabled,
            push_enabled,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id)
        DO UPDATE SET
            in_app_enabled = excluded.in_app_enabled,
            email_enabled = excluded.email_enabled,
            push_enabled = excluded.push_enabled,
            updated_at = excluded.updated_at
    `).bind(
        userId,
        preferences.inAppEnabled ? 1 : 0,
        preferences.emailEnabled ? 1 : 0,
        preferences.pushEnabled ? 1 : 0,
        notificationNow()
    ).run();

    return preferences;
}
async function handleNotifications(request, env, user) {
const url = new URL(request.url);
const path = url.pathname;
const method = request.method.toUpperCase();
    if (!env.DB) {
        return json({
            ok: false,
            error: "Database is not configured."
        }, 500);
    }

    try {
        // GET /api/notifications
        if (
            path === "/api/notifications" &&
            method === "GET"
        ) {
            const limit = notificationLimit(
                url.searchParams.get("limit")
            );

            const notifications = await notificationGetList(
                env,
                user.id,
                limit
            );

            return json({
                ok: true,
                notifications,
                unreadCount: await notificationUnreadCount(
                    env,
                    user.id
                )
            });
        }

        // GET /api/notifications/unread-count
        if (
            path === "/api/notifications/unread-count" &&
            method === "GET"
        ) {
            return json({
                ok: true,
                unreadCount: await notificationUnreadCount(
                    env,
                    user.id
                )
            });
        }

        // GET /api/notifications/preferences
        if (
            path === "/api/notifications/preferences" &&
            method === "GET"
        ) {
            const preferences = await notificationGetPreferences(
                env,
                user.id
            );

            return json({
                ok: true,
                preferences,
                deliveryStatus: {
                    inApp: "available",
                    email: "not_configured",
                    push: "not_configured"
                }
            });
        }

        // PUT /api/notifications/preferences
        if (
            path === "/api/notifications/preferences" &&
            method === "PUT"
        ) {
            const contentLength = Number(
                request.headers.get("content-length") || 0
            );

            if (contentLength > 4096) {
                return json({
                    ok: false,
                    error: "Request body is too large."
                }, 413);
            }

            const input = await request.json();

            if (
                !input ||
                typeof input !== "object" ||
                Array.isArray(input)
            ) {
                return json({
                    ok: false,
                    error: "Invalid preferences."
                }, 400);
            }

            const preferences = await notificationSavePreferences(
                env,
                user.id,
                input
            );

            return json({
                ok: true,
                preferences,
                message: "Notification preferences updated.",
                deliveryStatus: {
                    inApp: "available",
                    email: "not_configured",
                    push: "not_configured"
                }
            });
        }

        // POST /api/notifications/read-all
        if (
            path === "/api/notifications/read-all" &&
            method === "POST"
        ) {
            const updated = await notificationMarkAllRead(
                env,
                user.id
            );

            return json({
                ok: true,
                updated,
                message: "All notifications marked as read."
            });
        }

        // POST /api/notifications/:id/read
        const readMatch = path.match(
            /^\/api\/notifications\/([a-f0-9-]+)\/read$/i
        );

        if (readMatch && method === "POST") {
            const id = readMatch[1];

            const updated = await notificationMarkRead(
                env,
                user.id,
                id
            );

            if (!updated) {
                return json({
                    ok: false,
                    error: "Notification not found or already read."
                }, 404);
            }

            return json({
                ok: true,
                message: "Notification marked as read."
            });
        }

        return json({
            ok: false,
            error: "Notification endpoint not found."
        }, 404);

    } catch (error) {
        console.error(
            "Notification error:",
            error?.message || error
        );

        return json({
            ok: false,
            error: error?.message || "Notification request failed."
        }, 500);
    }
}
// Create an in-app notification for the monitoring event.
// Notification failure must not interrupt trade monitoring.
try {
const eventTitle = {
stop_loss_near: "Stop-loss warning",
take_profit_near: "Take-profit approaching",
stop_loss_hit: "Stop-loss level reached",
take_profit_hit: "Take-profit level reached",
price_movement: "Significant price movement"
};
    const title =
        eventTitle[event.type] || "Trading monitor alert";

    const message =
        `${event.symbol || "Trading instrument"}: ` +
        `${event.message || event.type}`;

    await notificationCreate(
        env,
        event.userId || event.user_id,
        "trade_monitor",
        title,
        message,
        {
            symbol: event.symbol,
            eventType: event.type,
            tradeId: event.tradeId || event.trade_id || null
        }
    );

} catch (notificationError) {
console.error(
"Could not create monitoring notification:",
notificationError?.message || notificationError
);
}
// ============================================================
// PART 16: MARKET SCANNER AND WATCHLIST ENGINE
// ============================================================
const SCANNER_CONFIG = {
MAX_SYMBOLS: 30,
MAX_WATCHLIST_SYMBOLS: 30,
MAX_WATCHLISTS: 10,
DEFAULT_TIMEFRAME: "15min",
DEFAULT_MIN_CONFIDENCE: 55,
MAX_SCAN_HISTORY: 100,
MAX_CONCURRENT_SCANS: 3
};
const SCANNER_DEFAULT_SYMBOLS = [
"EURUSD",
"GBPUSD",
"USDJPY",
"USDCHF",
"USDCAD",
"AUDUSD",
"NZDUSD",
"EURGBP",
"EURJPY",
"GBPJPY",
"AUDJPY",
"XAUUSD",
"XAGUSD",
"BTCUSD",
"ETHUSD"
];
function scannerId() {
return crypto.randomUUID();
}
function scannerNow() {
return new Date().toISOString();
}
function scannerNumber(value, fallback = 0) {
const number = Number(value);
return Number.isFinite(number) ? number : fallback;
}
function scannerSymbol(value) {
return String(value || "")
.trim()
.toUpperCase()
.replace(/[^A-Z0-9]/g, "")
.slice(0, 20);
}
function scannerTimeframe(value) {
const timeframe = String(value || "")
.trim()
.toLowerCase();
    const allowed = [
        "1min",
        "5min",
        "15min",
        "30min",
        "1hour",
        "4hour",
        "1day"
    ];

    return allowed.includes(timeframe)
        ? timeframe
        : SCANNER_CONFIG.DEFAULT_TIMEFRAME;
}
function scannerValidateSymbols(symbols) {
if (!Array.isArray(symbols)) {
throw new Error("Symbols must be supplied as an array.");
}
    const normalized = [
        ...new Set(symbols.map(scannerSymbol).filter(Boolean))
    ];

    if (normalized.length === 0) {
        throw new Error("At least one valid symbol is required.");
    }

    if (normalized.length > SCANNER_CONFIG.MAX_SYMBOLS) {
        throw new Error(
            `Maximum ${SCANNER_CONFIG.MAX_SYMBOLS} symbols allowed per scan.`
        );
    }

    for (const symbol of normalized) {
        if (!SYMBOLS[symbol]) {
            throw new Error(`Unsupported trading symbol: ${symbol}`);
        }
    }

    return normalized;
}
function scannerSignalRank(signal) {
const confidence = scannerNumber(signal.confidence);
const direction = String(signal.direction || "HOLD").toUpperCase();
    if (direction === "BUY" || direction === "SELL") {
        return confidence;
    }

    return 0;
}
function scannerSignalSummary(signal) {
return {
symbol: signal.symbol,
direction: signal.direction,
confidence: scannerNumber(signal.confidence),
entry: scannerNumber(signal.entry),
stopLoss: scannerNumber(signal.stopLoss),
takeProfit1: scannerNumber(
signal.takeProfit1 ?? signal.tp1
),
riskReward: scannerNumber(
signal.riskReward ?? signal.riskRewardRatio
),
timeframe: signal.timeframe,
generatedAt: signal.generatedAt || scannerNow()
};
}
async function scannerCreateWatchlist(
env,
userId,
name
) {
const safeName = String(name || "")
.trim()
.slice(0, 60);
    if (!safeName) {
        throw new Error("Watchlist name is required.");
    }

    const count = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM trade_watchlists
        WHERE user_id = ?
    `).bind(userId).first();

    if (
        Number(count?.total || 0) >=
        SCANNER_CONFIG.MAX_WATCHLISTS
    ) {
        throw new Error("Maximum number of watchlists reached.");
    }

    const id = scannerId();
    const now = scannerNow();

    await env.DB.prepare(`
        INSERT INTO trade_watchlists (
            id,
            user_id,
            name,
            created_at,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?)
    `).bind(
        id,
        userId,
        safeName,
        now,
        now
    ).run();

    return {
        id,
        name: safeName,
        createdAt: now
    };
}
async function scannerGetWatchlists(env, userId) {
const result = await env.DB.prepare(`SELECT w.id, w.name, w.created_at, w.updated_at, COUNT(s.id) AS symbol_count FROM trade_watchlists w LEFT JOIN trade_watchlist_symbols s ON s.watchlist_id = w.id AND s.user_id = w.user_id WHERE w.user_id = ? GROUP BY w.id ORDER BY w.created_at DESC`).bind(userId).all();
    return result.results || [];
}
async function scannerAddWatchlistSymbol(
env,
userId,
watchlistId,
symbol
) {
const safeSymbol = scannerSymbol(symbol);
    if (!SYMBOLS[safeSymbol]) {
        throw new Error("Unsupported trading symbol.");
    }

    const watchlist = await env.DB.prepare(`
        SELECT id
        FROM trade_watchlists
        WHERE id = ?
        AND user_id = ?
        LIMIT 1
    `).bind(
        watchlistId,
        userId
    ).first();

    if (!watchlist) {
        throw new Error("Watchlist not found.");
    }

    const count = await env.DB.prepare(`
        SELECT COUNT(*) AS total
        FROM trade_watchlist_symbols
        WHERE watchlist_id = ?
        AND user_id = ?
    `).bind(
        watchlistId,
        userId
    ).first();

    if (
        Number(count?.total || 0) >=
        SCANNER_CONFIG.MAX_WATCHLIST_SYMBOLS
    ) {
        throw new Error("Watchlist symbol limit reached.");
    }

    await env.DB.prepare(`
        INSERT OR IGNORE INTO trade_watchlist_symbols (
            id,
            watchlist_id,
            user_id,
            symbol,
            created_at
        )
        VALUES (?, ?, ?, ?, ?)
    `).bind(
        scannerId(),
        watchlistId,
        userId,
        safeSymbol,
        scannerNow()
    ).run();

    return {
        ok: true,
        symbol: safeSymbol
    };
}
async function scannerRemoveWatchlistSymbol(
env,
userId,
watchlistId,
symbol
) {
const result = await env.DB.prepare(`DELETE FROM trade_watchlist_symbols WHERE watchlist_id = ? AND user_id = ? AND symbol = ?`).bind(
watchlistId,
userId,
scannerSymbol(symbol)
).run();
    return Number(result.meta?.changes || 0) > 0;
}
async function scannerDeleteWatchlist(
env,
userId,
watchlistId
) {
const watchlist = await env.DB.prepare(`SELECT id FROM trade_watchlists WHERE id = ? AND user_id = ? LIMIT 1`).bind(
watchlistId,
userId
).first();
    if (!watchlist) {
        return false;
    }

    await env.DB.batch([
        env.DB.prepare(`
            DELETE FROM trade_watchlist_symbols
            WHERE watchlist_id = ?
            AND user_id = ?
        `).bind(watchlistId, userId),

        env.DB.prepare(`
            DELETE FROM trade_watchlists
            WHERE id = ?
            AND user_id = ?
        `).bind(watchlistId, userId)
    ]);

    return true;
}
async function scannerGetWatchlistSymbols(
env,
userId,
watchlistId
) {
const result = await env.DB.prepare(`SELECT s.symbol, s.created_at FROM trade_watchlist_symbols s INNER JOIN trade_watchlists w ON w.id = s.watchlist_id AND w.user_id = s.user_id WHERE s.watchlist_id = ? AND s.user_id = ? ORDER BY s.created_at ASC`).bind(
watchlistId,
userId
).all();
    return (result.results || []).map(row => ({
        symbol: row.symbol,
        createdAt: row.created_at
    }));
}
async function scannerGetHistory(env, userId, limit = 50) {
const safeLimit = Math.max(
1,
Math.min(100, Math.floor(Number(limit) || 50))
);
    const result = await env.DB.prepare(`
        SELECT
            id,
            symbol,
            timeframe,
            direction,
            confidence,
            entry_price,
            stop_loss,
            take_profit,
            created_at
        FROM market_scan_history
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).bind(
        userId,
        safeLimit
    ).all();

    return result.results || [];
}
function priceAlertNormalize(row) {
    return {
        id: row.id, symbol: row.symbol, condition: row.condition,
        target: Number(row.target), referencePrice: row.reference_price == null ? null : Number(row.reference_price),
        lastPrice: row.last_price == null ? null : Number(row.last_price),
        enabled: !!row.enabled, triggeredAt: row.triggered_at || null,
        createdAt: row.created_at, updatedAt: row.updated_at
    };
}
async function priceAlertGet(env, userId, id) {
    const row = await env.DB.prepare(`SELECT * FROM trade_price_alerts WHERE id = ? AND user_id = ? LIMIT 1`).bind(id, userId).first();
    return row ? priceAlertNormalize(row) : null;
}
async function handlePriceAlerts(request, env, user) {
    const url = new URL(request.url), path = url.pathname, method = request.method.toUpperCase();
    if (!env.DB) return json({ok:false,error:'Database is not configured.'},500);
    try {
        if (path === '/api/price-alerts' && method === 'GET') {
            const result = await env.DB.prepare(`SELECT * FROM trade_price_alerts WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`).bind(user.id).all();
            return json({ok:true,alerts:(result.results||[]).map(priceAlertNormalize)});
        }
        if (path === '/api/price-alerts' && method === 'POST') {
            const input = await request.json();
            const symbol = String(input?.symbol||'').trim().toUpperCase();
            const condition = String(input?.condition||'');
            const target = Number(input?.target);
            const referencePrice = input?.referencePrice == null ? null : Number(input.referencePrice);
            const lastPrice = input?.lastPrice == null ? null : Number(input.lastPrice);
            if (!/^[A-Z0-9]{3,15}$/.test(symbol) || !['above','below','move'].includes(condition) || !Number.isFinite(target) || target <= 0) return json({ok:false,error:'Invalid symbol, condition, or target.'},400);
            if (condition === 'move' && (!Number.isFinite(referencePrice) || referencePrice <= 0)) return json({ok:false,error:'Percentage-move alerts require a positive reference price.'},400);
            if (lastPrice !== null && (!Number.isFinite(lastPrice) || lastPrice <= 0)) return json({ok:false,error:'Last price must be positive.'},400);
            const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM trade_price_alerts WHERE user_id = ?`).bind(user.id).first();
            if (Number(count?.total||0) >= 100) return json({ok:false,error:'You can keep up to 100 price alerts.'},409);
            const id = (typeof input.id === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(input.id)) ? input.id : crypto.randomUUID();
            const now = new Date().toISOString();
            const createdAt = typeof input.createdAt === 'string' && !Number.isNaN(Date.parse(input.createdAt)) ? input.createdAt : now;
            const triggeredAt = input.triggeredAt && !Number.isNaN(Date.parse(input.triggeredAt)) ? new Date(input.triggeredAt).toISOString() : null;
            await env.DB.prepare(`INSERT INTO trade_price_alerts (id,user_id,symbol,condition,target,reference_price,last_price,enabled,triggered_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`).bind(id,user.id,symbol,condition,target,referencePrice,lastPrice,input.enabled === false ? 0 : 1,triggeredAt,createdAt,now).run();
            const alert = await priceAlertGet(env,user.id,id);
            if (!alert) return json({ok:false,error:'Could not save this alert.'},500);
            if (triggeredAt) await env.DB.prepare(`INSERT OR IGNORE INTO trade_price_alert_events (id,user_id,alert_id,symbol,condition,target,trigger_price,triggered_at) VALUES (?,?,?,?,?,?,?,?)`).bind(crypto.randomUUID(),user.id,id,symbol,condition,target,lastPrice,triggeredAt).run();
            return json({ok:true,alert},201);
        }
        const triggerMatch = path.match(/^\/api\/price-alerts\/([A-Za-z0-9_-]{8,80})\/trigger$/);
        if (triggerMatch && method === 'POST') {
            const id=triggerMatch[1], input=await request.json(), price=Number(input?.price);
            if (!Number.isFinite(price) || price <= 0) return json({ok:false,error:'A positive trigger price is required.'},400);
            const alert=await priceAlertGet(env,user.id,id);
            if (!alert) return json({ok:false,error:'Price alert not found.'},404);
            if (alert.triggeredAt || !alert.enabled) return json({ok:true,alert,alreadyTriggered:true});
            const hit=alert.condition==='above'?price>=alert.target:alert.condition==='below'?price<=alert.target:alert.referencePrice>0&&Math.abs((price-alert.referencePrice)/alert.referencePrice*100)>=alert.target;
            if (!hit) return json({ok:false,error:'The supplied quote does not meet this alert condition.'},409);
            const now=new Date().toISOString();
            await env.DB.batch([
                env.DB.prepare(`UPDATE trade_price_alerts SET last_price=?,triggered_at=?,enabled=0,updated_at=? WHERE id=? AND user_id=? AND triggered_at IS NULL AND enabled=1`).bind(price,now,now,id,user.id),
                env.DB.prepare(`INSERT INTO trade_price_alert_events (id,user_id,alert_id,symbol,condition,target,trigger_price,triggered_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM trade_price_alerts WHERE id=? AND user_id=? AND triggered_at=?)`).bind(crypto.randomUUID(),user.id,id,alert.symbol,alert.condition,alert.target,price,now,id,user.id,now)
            ]);
            const updated=await priceAlertGet(env,user.id,id);
            return json({ok:true,alert:updated});
        }
        const itemMatch=path.match(/^\/api\/price-alerts\/([A-Za-z0-9_-]{8,80})$/);
        if (itemMatch && method === 'PATCH') {
            const id=itemMatch[1], input=await request.json(), current=await priceAlertGet(env,user.id,id);
            if (!current) return json({ok:false,error:'Price alert not found.'},404);
            const allowed=['enabled','lastPrice'];
            if (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!allowed.includes(key)) || !Object.keys(input).length) return json({ok:false,error:'Only enabled and lastPrice can be updated.'},400);
            const enabled=input.enabled === undefined ? current.enabled : input.enabled;
            const lastPrice=input.lastPrice === undefined ? current.lastPrice : Number(input.lastPrice);
            if (typeof enabled!=='boolean' || (lastPrice!==null && (!Number.isFinite(lastPrice)||lastPrice<=0))) return json({ok:false,error:'Invalid alert update.'},400);
            if (current.triggeredAt && enabled) return json({ok:false,error:'A triggered alert cannot be resumed. Create a new alert instead.'},409);
            await env.DB.prepare(`UPDATE trade_price_alerts SET enabled=?,last_price=?,updated_at=? WHERE id=? AND user_id=?`).bind(enabled?1:0,lastPrice,new Date().toISOString(),id,user.id).run();
            return json({ok:true,alert:await priceAlertGet(env,user.id,id)});
        }
        if (itemMatch && method === 'DELETE') {
            const result=await env.DB.prepare(`DELETE FROM trade_price_alerts WHERE id=? AND user_id=?`).bind(itemMatch[1],user.id).run();
            return json({ok:true,deleted:Number(result.meta?.changes||0)>0});
        }
        if (path === '/api/price-alerts/triggered' && method === 'DELETE') {
            const result=await env.DB.prepare(`DELETE FROM trade_price_alerts WHERE user_id=? AND triggered_at IS NOT NULL`).bind(user.id).run();
            await env.DB.prepare(`DELETE FROM trade_price_alert_events WHERE user_id=?`).bind(user.id).run();
            return json({ok:true,deleted:Number(result.meta?.changes||0)});
        }
        return json({ok:false,error:'Price alert endpoint not found.'},404);
    } catch(error) {
        console.error('Price alerts error:',error?.message||error);
        return json({ok:false,error:error?.message||'Price alert request failed.'},400);
    }
}

async function handleMarketScanner(request, env, user) {
const url = new URL(request.url);
const path = url.pathname;
const method = request.method.toUpperCase();
    try {
        if (!env.DB) {
            return json({
                ok: false,
                error: "Database is not configured."
            }, 500);
        }

        // POST /api/scanner/run
        if (
            path === "/api/scanner/run" &&
            method === "POST"
        ) {
            const input = await request.json();

            const symbols = scannerValidateSymbols(
                input.symbols || SCANNER_DEFAULT_SYMBOLS
            );

            const timeframe = scannerTimeframe(
                input.timeframe
            );

            const minConfidence = Math.max(
                0,
                Math.min(
                    100,
                    scannerNumber(
                        input.minConfidence,
                        SCANNER_CONFIG.DEFAULT_MIN_CONFIDENCE
                    )
                )
            );

            const scan = await scannerRunBatch(
                env,
                symbols,
                timeframe,
                minConfidence
            );

            await scannerSaveHistory(
                env,
                user.id,
                scan.results
            );

            return json({
                ok: true,
                timeframe,
                minimumConfidence: minConfidence,
                scanned: scan.scanned,
                successful: scan.successful,
                failed: scan.failed,
                opportunities: scan.opportunities,
                results: scan.results,
                generatedAt: scannerNow()
            });
        }

        // GET /api/scanner/symbols
        if (
            path === "/api/scanner/symbols" &&
            method === "GET"
        ) {
            return json({
                ok: true,
                symbols: Object.keys(SYMBOLS),
                defaultSymbols: SCANNER_DEFAULT_SYMBOLS
            });
        }

        // GET /api/scanner/history
        if (
            path === "/api/scanner/history" &&
            method === "GET"
        ) {
            const history = await scannerGetHistory(
                env,
                user.id,
                url.searchParams.get("limit")
            );

            return json({
                ok: true,
                history
            });
        }

        // GET /api/watchlists
        if (
            path === "/api/watchlists" &&
            method === "GET"
        ) {
            return json({
                ok: true,
                watchlists: await scannerGetWatchlists(
                    env,
                    user.id
                )
            });
        }

        // POST /api/watchlists
        if (
            path === "/api/watchlists" &&
            method === "POST"
        ) {
            const input = await request.json();

            const watchlist = await scannerCreateWatchlist(
                env,
                user.id,
                input.name
            );

            return json({
                ok: true,
                watchlist
            });
        }

        // POST /api/watchlists/:id/symbols
        const addMatch = path.match(
            /^\/api\/watchlists\/([a-f0-9-]+)\/symbols$/i
        );

        if (addMatch && method === "POST") {
            const input = await request.json();

            const result = await scannerAddWatchlistSymbol(
                env,
                user.id,
                addMatch[1],
                input.symbol
            );

            return json(result);
        }

        // GET /api/watchlists/:id/symbols
        if (addMatch && method === "GET") {
            return json({
                ok: true,
                symbols: await scannerGetWatchlistSymbols(
                    env,
                    user.id,
                    addMatch[1]
                )
            });
        }

        // DELETE /api/watchlists/:id/symbols/:symbol
        const removeMatch = path.match(
            /^\/api\/watchlists\/([a-f0-9-]+)\/symbols\/([A-Z0-9]+)$/i
        );

        if (removeMatch && method === "DELETE") {
            const removed = await scannerRemoveWatchlistSymbol(
                env,
                user.id,
                removeMatch[1],
                removeMatch[2]
            );

            return json({
                ok: true,
                removed
            });
        }

        // DELETE /api/watchlists/:id
        const deleteMatch = path.match(
            /^\/api\/watchlists\/([a-f0-9-]+)$/i
        );

        if (deleteMatch && method === "DELETE") {
            const deleted = await scannerDeleteWatchlist(
                env,
                user.id,
                deleteMatch[1]
            );

            return json({
                ok: true,
                deleted
            });
        }

        return json({
            ok: false,
            error: "Scanner endpoint not found."
        }, 404);

    } catch (error) {
        console.error(
            "Market scanner error:",
            error?.message || error
        );

        return json({
            ok: false,
            error: error?.message || "Market scan failed."
        }, 400);
    }
}
// ============================================================
// PART 17: ADVANCED DASHBOARD AND PORTFOLIO ANALYTICS
// ============================================================
const DASHBOARD_CONFIG = {
MAX_RECENT_TRADES: 20,
MAX_EQUITY_POINTS: 100,
MAX_ACTIVITY_ITEMS: 30
};
function dashboardNumber(value, fallback = 0) {
const number = Number(value);
return Number.isFinite(number) ? number : fallback;
}
function dashboardRound(value, decimals = 2) {
const factor = Math.pow(10, decimals);
    return Math.round(
        dashboardNumber(value) * factor
    ) / factor;
}
function dashboardPercentage(numerator, denominator) {
if (!denominator) return 0;
    return dashboardRound(
        (numerator / denominator) * 100
    );
}
function dashboardDate(value) {
if (!value) return null;
    const date = new Date(value);

    return Number.isNaN(date.getTime())
        ? null
        : date.toISOString();
}
async function dashboardGetPortfolioSummary(env, userId) {
const result = await env.DB.prepare(`
SELECT
COUNT(*) AS total_trades,
            SUM(
                CASE
                    WHEN LOWER(status) = 'open'
                    THEN 1 ELSE 0
                END
            ) AS open_trades,

            SUM(
                CASE
                    WHEN LOWER(status) = 'closed'
                    THEN 1 ELSE 0
                END
            ) AS closed_trades,

            SUM(
                CASE
                    WHEN LOWER(status) = 'closed'
                    AND COALESCE(net_pnl, 0) > 0
                    THEN 1 ELSE 0
                END
            ) AS winning_trades,

            SUM(
                CASE
                    WHEN LOWER(status) = 'closed'
                    AND COALESCE(net_pnl, 0) < 0
                    THEN 1 ELSE 0
                END
            ) AS losing_trades,

            SUM(
                CASE
                    WHEN LOWER(status) = 'closed'
                    THEN COALESCE(net_pnl, 0)
                    ELSE 0
                END
            ) AS realized_pnl,

            SUM(
                CASE
                    WHEN LOWER(status) = 'open'
                    THEN COALESCE(risk_amount, 0)
                    ELSE 0
                END
            ) AS open_risk,

            SUM(
                CASE
                    WHEN LOWER(status) = 'closed'
                    THEN COALESCE(fees, 0)
                    ELSE 0
                END
            ) AS total_fees

        FROM trade_journal
        WHERE user_id = ?
    `).bind(userId).first();

    const totalTrades = dashboardNumber(
        result?.total_trades
    );

    const openTrades = dashboardNumber(
        result?.open_trades
    );

    const closedTrades = dashboardNumber(
        result?.closed_trades
    );

    const winningTrades = dashboardNumber(
        result?.winning_trades
    );

    const losingTrades = dashboardNumber(
        result?.losing_trades
    );

    const realizedPnl = dashboardNumber(
        result?.realized_pnl
    );

    return {
        totalTrades,
        openTrades,
        closedTrades,
        winningTrades,
        losingTrades,

        breakevenTrades: Math.max(
            0,
            closedTrades - winningTrades - losingTrades
        ),

        realizedPnl: dashboardRound(realizedPnl),

        openRisk: dashboardRound(
            result?.open_risk
        ),

        totalFees: dashboardRound(
            result?.total_fees
        ),

        winRate: dashboardPercentage(
            winningTrades,
            closedTrades
        ),

        averagePnl: closedTrades
            ? dashboardRound(realizedPnl / closedTrades)
            : 0
    };
}
async function dashboardGetRecentTrades(
env,
userId,
limit = DASHBOARD_CONFIG.MAX_RECENT_TRADES
) {
const safeLimit = Math.max(
1,
Math.min(50, Math.floor(Number(limit) || 20))
);
    const result = await env.DB.prepare(`
        SELECT
            id,
            symbol,
            direction,
            entry_price,
            stop_loss,
            take_profit,
            exit_price,
            quantity,
            stake,
            risk_percent,
            risk_amount,
            realized_pnl,
            net_pnl,
            strategy,
            timeframe,
            broker,
            execution_mode,
            status,
            opened_at,
            closed_at,
            created_at
        FROM trade_journal
        WHERE user_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).bind(
        userId,
        safeLimit
    ).all();

    return (result.results || []).map(row => ({
        id: row.id,
        symbol: row.symbol,
        direction: row.direction,

        entryPrice: dashboardNumber(
            row.entry_price
        ),

        stopLoss: dashboardNumber(
            row.stop_loss
        ),

        takeProfit: dashboardNumber(
            row.take_profit
        ),

        exitPrice: row.exit_price === null
            ? null
            : dashboardNumber(row.exit_price),

        quantity: dashboardNumber(row.quantity),
        stake: dashboardNumber(row.stake),
        riskPercent: dashboardNumber(row.risk_percent),
        riskAmount: dashboardNumber(row.risk_amount),

        realizedPnl: row.realized_pnl === null
            ? null
            : dashboardNumber(row.realized_pnl),

        netPnl: row.net_pnl === null
            ? null
            : dashboardNumber(row.net_pnl),

        strategy: row.strategy,
        timeframe: row.timeframe,
        broker: row.broker,
        executionMode: row.execution_mode,
        status: row.status,

        openedAt: dashboardDate(row.opened_at),
        closedAt: dashboardDate(row.closed_at),
        createdAt: dashboardDate(row.created_at)
    }));
}
async function dashboardGetOpenPositions(env, userId) {
const result = await env.DB.prepare(`SELECT id, symbol, direction, entry_price, stop_loss, take_profit, quantity, stake, risk_percent, risk_amount, strategy, timeframe, broker, execution_mode, opened_at FROM trade_journal WHERE user_id = ? AND LOWER(status) = 'open' ORDER BY opened_at DESC LIMIT 100`).bind(userId).all();
    return (result.results || []).map(row => ({
        id: row.id,
        symbol: row.symbol,
        direction: row.direction,
        entryPrice: dashboardNumber(row.entry_price),
        stopLoss: dashboardNumber(row.stop_loss),
        takeProfit: dashboardNumber(row.take_profit),
        quantity: dashboardNumber(row.quantity),
        stake: dashboardNumber(row.stake),
        riskPercent: dashboardNumber(row.risk_percent),
        riskAmount: dashboardNumber(row.risk_amount),
        strategy: row.strategy,
        timeframe: row.timeframe,
        broker: row.broker,
        executionMode: row.execution_mode,
        openedAt: dashboardDate(row.opened_at)
    }));
}
async function dashboardGetEquityCurve(
env,
userId,
limit = DASHBOARD_CONFIG.MAX_EQUITY_POINTS
) {
const safeLimit = Math.max(
1,
Math.min(250, Math.floor(Number(limit) || 100))
);
    const result = await env.DB.prepare(`
        SELECT
            id,
            symbol,
            net_pnl,
            closed_at,
            created_at
        FROM trade_journal
        WHERE user_id = ?
        AND LOWER(status) = 'closed'
        ORDER BY COALESCE(closed_at, created_at) ASC
        LIMIT 5000
    `).bind(userId).all();

    const trades = result.results || [];

    let cumulative = 0;
    let peak = 0;
    let maxDrawdown = 0;

    const points = trades.map((trade, index) => {
        cumulative += dashboardNumber(trade.net_pnl);

        peak = Math.max(peak, cumulative);

        const drawdown = peak - cumulative;

        maxDrawdown = Math.max(
            maxDrawdown,
            drawdown
        );

        return {
            index: index + 1,
            tradeId: trade.id,
            symbol: trade.symbol,
            pnl: dashboardRound(trade.net_pnl),
            cumulativePnl: dashboardRound(cumulative),
            drawdown: dashboardRound(drawdown),
            date: dashboardDate(
                trade.closed_at || trade.created_at
            )
        };
    });

    return {
        points: points.slice(-safeLimit),
        totalClosedTrades: trades.length,
        cumulativeRealizedPnl: dashboardRound(cumulative),
        maximumDrawdown: dashboardRound(maxDrawdown),
        calculation: "Cumulative realized journal P&L, not broker account equity."
    };
}
async function dashboardGetBreakdowns(env, userId) {
const [strategyResult, symbolResult] = await Promise.all([
env.DB.prepare(`SELECT COALESCE(strategy, 'Unspecified') AS strategy, COUNT(*) AS trades, SUM( CASE WHEN COALESCE(net_pnl, 0) > 0 THEN 1 ELSE 0 END ) AS wins, SUM(COALESCE(net_pnl, 0)) AS net_pnl FROM trade_journal WHERE user_id = ? AND LOWER(status) = 'closed' GROUP BY COALESCE(strategy, 'Unspecified') ORDER BY net_pnl DESC LIMIT 30`).bind(userId).all(),
        env.DB.prepare(`
            SELECT
                symbol,
                COUNT(*) AS trades,
                SUM(
                    CASE
                        WHEN COALESCE(net_pnl, 0) > 0
                        THEN 1 ELSE 0
                    END
                ) AS wins,
                SUM(COALESCE(net_pnl, 0)) AS net_pnl
            FROM trade_journal
            WHERE user_id = ?
            AND LOWER(status) = 'closed'
            GROUP BY symbol
            ORDER BY net_pnl DESC
            LIMIT 30
        `).bind(userId).all()
    ]);

    const strategies = (strategyResult.results || []).map(row => ({
        strategy: row.strategy,
        trades: dashboardNumber(row.trades),
        wins: dashboardNumber(row.wins),
        winRate: dashboardPercentage(
            row.wins,
            row.trades
        ),
        netPnl: dashboardRound(row.net_pnl)
    }));

    const symbols = (symbolResult.results || []).map(row => ({
        symbol: row.symbol,
        trades: dashboardNumber(row.trades),
        wins: dashboardNumber(row.wins),
        winRate: dashboardPercentage(
            row.wins,
            row.trades
        ),
        netPnl: dashboardRound(row.net_pnl)
    }));

    return {
        strategies,
        symbols
    };
}
async function dashboardGetActivity(env, userId) {
const activities = [];
    const trades = await dashboardGetRecentTrades(
        env,
        userId,
        15
    );

    for (const trade of trades) {
        activities.push({
            id: `trade_${trade.id}`,
            type: "trade",
            title: `${trade.symbol} ${trade.direction}`,
            message: `Trade status: ${trade.status}`,
            date: trade.closedAt || trade.openedAt || trade.createdAt
        });
    }

    try {
        const notifications = await env.DB.prepare(`
            SELECT
                id,
                type,
                title,
                message,
                created_at
            FROM trade_notifications
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 15
        `).bind(userId).all();

        for (const notification of notifications.results || []) {
            activities.push({
                id: `notification_${notification.id}`,
                type: notification.type,
                title: notification.title,
                message: notification.message,
                date: dashboardDate(notification.created_at)
            });
        }
    } catch (error) {
        // Notification migration may not yet be installed.
        console.warn(
            "Dashboard notification activity unavailable:",
            error?.message || error
        );
    }

    return activities
        .filter(item => item.date)
        .sort(
            (a, b) =>
                new Date(b.date).getTime() -
                new Date(a.date).getTime()
        )
        .slice(0, DASHBOARD_CONFIG.MAX_ACTIVITY_ITEMS);
}
async function handleAdvancedDashboard(request, env, user) {
const url = new URL(request.url);
const path = url.pathname;
    if (request.method !== "GET") {
        return json({
            ok: false,
            error: "Method not allowed."
        }, 405);
    }

    if (!env.DB) {
        return json({
            ok: false,
            error: "Database is not configured."
        }, 500);
    }

    try {
        // GET /api/dashboard/overview
        if (path === "/api/dashboard/overview") {
            const [
                portfolio,
                recentTrades,
                openPositions,
                equityCurve,
                breakdowns,
                activity
            ] = await Promise.all([
                dashboardGetPortfolioSummary(
                    env,
                    user.id
                ),

                dashboardGetRecentTrades(
                    env,
                    user.id
                ),

                dashboardGetOpenPositions(
                    env,
                    user.id
                ),

                dashboardGetEquityCurve(
                    env,
                    user.id
                ),

                dashboardGetBreakdowns(
                    env,
                    user.id
                ),

                dashboardGetActivity(
                    env,
                    user.id
                )
            ]);

            let accountRiskSettings = { ...USER_RISK_DEFAULTS };
            try {
                accountRiskSettings = await riskSettingsGet(env, user.id);
            } catch (riskSettingsError) {
                console.warn("Dashboard risk settings sync unavailable:", riskSettingsError?.message || riskSettingsError);
            }

            let unreadNotifications = 0;

            try {
                const unread = await env.DB.prepare(`
                    SELECT COUNT(*) AS total
                    FROM trade_notifications
                    WHERE user_id = ?
                    AND read_at IS NULL
                `).bind(user.id).first();

                unreadNotifications = dashboardNumber(
                    unread?.total
                );
            } catch {
                unreadNotifications = 0;
            }

            return json({
                ok: true,

                dashboard: {
                    generatedAt: new Date().toISOString(),

                    portfolio,

                    riskSettings: accountRiskSettings,

                    positions: {
                        openCount: openPositions.length,
                        openPositions
                    },

                    performance: {
                        equityCurve,
                        strategies: breakdowns.strategies,
                        symbols: breakdowns.symbols
                    },

                    recentTrades,

                    activity,

                    notifications: {
                        unreadCount: unreadNotifications
                    }
                },

                accountData: {
                    source: "trade_journal",
                    brokerBalanceAvailable: false,
                    liveEquityAvailable: false,
                    message:
                        "Portfolio figures are based on recorded journal trades. Connect broker account synchronization for verified live balances and equity."
                }
            });
        }

        // GET /api/dashboard/portfolio
        if (path === "/api/dashboard/portfolio") {
            const portfolio = await dashboardGetPortfolioSummary(
                env,
                user.id
            );

            const openPositions = await dashboardGetOpenPositions(
                env,
                user.id
            );

            const equityCurve = await dashboardGetEquityCurve(
                env,
                user.id
            );

            return json({
                ok: true,
                portfolio,
                openPositions,
                equityCurve
            });
        }

        // GET /api/dashboard/performance
        if (path === "/api/dashboard/performance") {
            const [
                portfolio,
                equityCurve,
                breakdowns
            ] = await Promise.all([
                dashboardGetPortfolioSummary(
                    env,
                    user.id
                ),

                dashboardGetEquityCurve(
                    env,
                    user.id
                ),

                dashboardGetBreakdowns(
                    env,
                    user.id
                )
            ]);

            return json({
                ok: true,
                portfolio,
                equityCurve,
                strategies: breakdowns.strategies,
                symbols: breakdowns.symbols
            });
        }

        // GET /api/dashboard/activity
        if (path === "/api/dashboard/activity") {
            return json({
                ok: true,
                activity: await dashboardGetActivity(
                    env,
                    user.id
                )
            });
        }

        return json({
            ok: false,
            error: "Dashboard endpoint not found."
        }, 404);

    } catch (error) {
        console.error(
            "Advanced dashboard error:",
            error?.message || error
        );

        return json({
            ok: false,
            error: "Could not load dashboard data."
        }, 500);
    }
}
// ============================================================
// PART 18: BROKER ACCOUNT SYNCHRONIZATION
// ============================================================
const BROKER_SYNC_CONFIG = {
MAX_ACCOUNTS: 20,
MAX_POSITIONS: 500,
SNAPSHOT_HISTORY_LIMIT: 50,
SYNC_TIMEOUT_MS: 15000,
ENVIRONMENT: "demo"
};
function brokerSyncId() {
return crypto.randomUUID();
}
function brokerSyncNow() {
return new Date().toISOString();
}
function brokerSyncNumber(value) {
if (value === null || value === undefined || value === "") {
return null;
}
    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}
function brokerSyncText(value, max = 100) {
return String(value ?? "").trim().slice(0, max);
}
function brokerNormalizeName(value) {
const name = String(value || "").trim().toLowerCase();
    if (name === "deriv") return "deriv";
    if (name === "ctrader" || name === "c-trader") return "ctrader";

    return null;
}
function brokerNormalizeAccount(account, broker) {
if (!account || typeof account !== "object") {
throw new Error("Invalid broker account response.");
}
    return {
        broker,
        accountId: brokerSyncText(
            account.account_id ??
            account.id ??
            account.login,
            100
        ),

        accountType: brokerSyncText(
            account.account_type ??
            account.type ??
            account.accountType,
            50
        ),

        currency: brokerSyncText(
            account.currency,
            10
        ),

        balance: brokerSyncNumber(
            account.balance
        ),

        equity: brokerSyncNumber(
            account.equity
        ),

        margin: brokerSyncNumber(
            account.margin
        ),

        freeMargin: brokerSyncNumber(
            account.free_margin ??
            account.freeMargin
        ),

        floatingPnl: brokerSyncNumber(
            account.floating_pnl ??
            account.unrealized_pnl ??
            account.unrealizedPnL
        ),

        leverage: brokerSyncText(
            account.leverage,
            30
        ),

        environment: BROKER_SYNC_CONFIG.ENVIRONMENT
    };
}
async function brokerSaveAccountSnapshot(
env,
userId,
account
) {
if (!account.accountId) {
throw new Error("Broker account ID is missing.");
}
    const now = brokerSyncNow();

    await env.DB.prepare(`
        INSERT INTO broker_account_snapshots (
            id,
            user_id,
            broker,
            account_id,
            account_type,
            currency,
            balance,
            equity,
            margin,
            free_margin,
            floating_pnl,
            leverage,
            environment,
            connection_status,
            source,
            synced_at,
            created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
        brokerSyncId(),
        userId,
        account.broker,
        account.accountId,
        account.accountType,
        account.currency,
        account.balance,
        account.equity,
        account.margin,
        account.freeMargin,
        account.floatingPnl,
        account.leverage,
        account.environment,
        "connected",
        account.source || "broker_api",
        now,
        now
    ).run();

    return {
        ok: true,
        accountId: account.accountId,
        syncedAt: now
    };
}
async function brokerSaveSyncStatus(
env,
userId,
broker,
status,
error = null
) {
const now = brokerSyncNow();
    await env.DB.prepare(`
        INSERT INTO broker_sync_status (
            id,
            user_id,
            broker,
            status,
            last_sync_at,
            last_error,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, broker)
        DO UPDATE SET
            status = excluded.status,
            last_sync_at = excluded.last_sync_at,
            last_error = excluded.last_error,
            updated_at = excluded.updated_at
    `).bind(
        brokerSyncId(),
        userId,
        broker,
        status,
        status === "connected" ? now : null,
        error ? brokerSyncText(error, 500) : null,
        now
    ).run();
}
async function brokerSyncDerivAccounts(env, userId) {
const accessToken = await getDerivAccessToken(
env,
userId
);
    if (!accessToken) {
        throw new Error("Deriv is not connected.");
    }

    // Use the existing Deriv API helper.
    const response = await derivApiFetch(
        env,
        accessToken,
        "/trading/v1/options/accounts"
    );

    if (!response || typeof response !== "object") {
        throw new Error("Invalid Deriv account response.");
    }

    const rawAccounts = Array.isArray(response)
        ? response
        : response.accounts ||
          response.data?.accounts ||
          [];

    if (!Array.isArray(rawAccounts)) {
        throw new Error("Deriv account list was not returned.");
    }

    if (rawAccounts.length > BROKER_SYNC_CONFIG.MAX_ACCOUNTS) {
        throw new Error("Deriv account limit exceeded.");
    }

    const accounts = rawAccounts.map(account =>
        brokerNormalizeAccount(account, "deriv")
    );

    for (const account of accounts) {
        if (!account.accountId) continue;

        await brokerSaveAccountSnapshot(
            env,
            userId,
            {
                ...account,
                source: "deriv_trading_api"
            }
        );
    }

    await brokerSaveSyncStatus(
        env,
        userId,
        "deriv",
        "connected"
    );

    return {
        broker: "deriv",
        environment: "demo",
        accounts,
        syncedAt: brokerSyncNow()
    };
}
async function brokerGetCTraderSyncStatus(env, userId) {
const connection = await env.DB.prepare(`SELECT account_id, environment, expires_at, created_at FROM ctrader_connections WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`).bind(userId).first();
    if (!connection) {
        return {
            broker: "ctrader",
            connected: false,
            accountSyncAvailable: false,
            message: "cTrader account is not connected."
        };
    }

    return {
        broker: "ctrader",
        connected: true,
        environment: connection.environment || "demo",
        accountId: connection.account_id || null,
        accountSyncAvailable: false,
        message:
            "OAuth connection exists. Live account synchronization requires the cTrader Open API connection adapter."
    };
}
async function brokerGetLatestAccounts(env, userId) {
const result = await env.DB.prepare(`SELECT broker, account_id, account_type, currency, balance, equity, margin, free_margin, floating_pnl, leverage, environment, connection_status, source, synced_at FROM broker_account_snapshots WHERE user_id = ? AND id IN ( SELECT MAX(id) FROM broker_account_snapshots WHERE user_id = ? GROUP BY broker, account_id ) ORDER BY synced_at DESC`).bind(
userId,
userId
).all();
    return result.results || [];
}
async function brokerGetSyncStatuses(env, userId) {
const result = await env.DB.prepare(`SELECT broker, status, last_sync_at, last_error, updated_at FROM broker_sync_status WHERE user_id = ? ORDER BY broker ASC`).bind(userId).all();
    return result.results || [];
}
async function handleBrokerSynchronization(
request,
env,
user
) {
const url = new URL(request.url);
const path = url.pathname;
const method = request.method.toUpperCase();
    if (!env.DB) {
        return json({
            ok: false,
            error: "Database is not configured."
        }, 500);
    }

    try {
        // GET /api/brokers/accounts
        if (
            path === "/api/brokers/accounts" &&
            method === "GET"
        ) {
            const accounts = await brokerGetLatestAccounts(
                env,
                user.id
            );

            return json({
                ok: true,
                accounts
            });
        }

        // GET /api/brokers/sync/status
        if (
            path === "/api/brokers/sync/status" &&
            method === "GET"
        ) {
            const statuses = await brokerGetSyncStatuses(
                env,
                user.id
            );

            const ctrader = await brokerGetCTraderSyncStatus(
                env,
                user.id
            );

            return json({
                ok: true,
                statuses,
                connections: {
                    ctrader
                }
            });
        }

        // POST /api/brokers/deriv/sync
        if (
            path === "/api/brokers/deriv/sync" &&
            method === "POST"
        ) {
            const result = await brokerSyncDerivAccounts(
                env,
                user.id
            );

            return json({
                ok: true,
                result
            });
        }

        // POST /api/brokers/ctrader/sync
        if (
            path === "/api/brokers/ctrader/sync" &&
            method === "POST"
        ) {
            const status = await brokerGetCTraderSyncStatus(
                env,
                user.id
            );

            return json({
                ok: false,
                broker: "ctrader",
                accountSyncAvailable: false,
                connection: status,
                message:
                    "The cTrader Open API account adapter is not yet implemented."
            }, 501);
        }

        return json({
            ok: false,
            error: "Broker synchronization endpoint not found."
        }, 404);

    } catch (error) {
        console.error(
            "Broker synchronization error:",
            error?.message || error
        );

        const broker = path.includes("deriv")
            ? "deriv"
            : path.includes("ctrader")
                ? "ctrader"
                : "unknown";

        try {
            if (broker !== "unknown") {
                await brokerSaveSyncStatus(
                    env,
                    user.id,
                    broker,
                    "error",
                    error?.message || "Synchronization failed."
                );
            }
        } catch (statusError) {
            console.error(
                "Could not save broker sync status:",
                statusError?.message || statusError
            );
        }

        return json({
            ok: false,
            error: error?.message || "Broker synchronization failed."
        }, 502);
    }
}
// ============================================================
// PART 19: REAL-TIME MARKET STREAMING
// ============================================================
const MARKET_STREAM_CONFIG = {
MAX_SYMBOLS: 10,
MAX_CLIENT_MESSAGE_LENGTH: 1024,
MAX_CONNECTIONS_PER_REQUEST: 1,
HEARTBEAT_INTERVAL_MS: 30000,
MAX_MESSAGES_PER_SECOND: 10
};
function streamNormalizeSymbol(value) {
return String(value || "")
.trim()
.toUpperCase()
.replace(/[^A-Z0-9]/g, "")
.slice(0, 20);
}
function streamGetSymbols(value) {
if (!value) {
return ["EURUSD", "GBPUSD", "USDJPY"];
}
    const symbols = [
        ...new Set(
            value.split(",")
                .map(streamNormalizeSymbol)
                .filter(Boolean)
        )
    ];

    if (!symbols.length) {
        throw new Error("At least one symbol is required.");
    }

    if (symbols.length > MARKET_STREAM_CONFIG.MAX_SYMBOLS) {
        throw new Error(
            `Maximum ${MARKET_STREAM_CONFIG.MAX_SYMBOLS} symbols per stream.`
        );
    }

    for (const symbol of symbols) {
        if (!SYMBOLS[symbol]) {
            throw new Error(
                `Unsupported market symbol: ${symbol}`
            );
        }
    }

    return symbols;
}
function streamProviderSymbol(symbol) {
return SYMBOLS[symbol];
}
function streamSend(socket, payload) {
try {
if (socket.readyState === 1) {
socket.send(JSON.stringify(payload));
}
} catch {
// Ignore failed sends on closing connections.
}
}
async function streamConnectTwelveData(env, symbols) {
    const apiKey = String(env.TWELVE_DATA_API_KEY || "").trim();
    if (!apiKey) throw new Error("Twelve Data API key is not configured.");
    const providerSymbols = symbols.map(streamProviderSymbol);
    const websocketUrl = "wss://ws.twelvedata.com/v1/quotes/price" +
        `?apikey=${encodeURIComponent(apiKey)}`;
    const response = await fetch(websocketUrl, { headers: { Upgrade: "websocket" } });
    if (response.status !== 101 || !response.webSocket) {
        throw new Error(`Twelve Data WebSocket handshake failed (${response.status}).`);
    }
    const socket = response.webSocket;
    socket.accept();
    socket.send(JSON.stringify({ action: "subscribe", params: { symbols: providerSymbols.join(",") } }));
    return { socket, provider: "twelve_data", symbols: providerSymbols };
}

async function streamConnectFinnhub(env, symbols) {
    const token = String(env.FINNHUB_API_KEY || "").trim();
    if (!token) throw new Error("Finnhub WebSocket fallback is not configured.");
    const response = await fetch(`wss://ws.finnhub.io?token=${encodeURIComponent(token)}`, {
        headers: { Upgrade: "websocket" }
    });
    if (response.status !== 101 || !response.webSocket) {
        throw new Error(`Finnhub WebSocket handshake failed (${response.status}).`);
    }
    const socket = response.webSocket;
    socket.accept();
    const providerSymbols = symbols.map(symbol => marketFinnhubSymbol(streamProviderSymbol(symbol)));
    for (const symbol of providerSymbols) socket.send(JSON.stringify({ type: "subscribe", symbol }));
    return { socket, provider: "finnhub", symbols: providerSymbols };
}

async function handleMarketStream(request, env, user) {
    const url = new URL(request.url);
    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return json({ ok: false, error: "A WebSocket upgrade request is required." }, 426);
    }
    let symbols;
    try { symbols = streamGetSymbols(url.searchParams.get("symbols")); }
    catch (error) { return json({ ok: false, error: error.message }, 400); }

    const providers = [];
    if (String(env.TWELVE_DATA_API_KEY || "").trim()) providers.push({ name: "twelve_data", connect: () => streamConnectTwelveData(env, symbols) });
    if (String(env.FINNHUB_API_KEY || "").trim()) providers.push({ name: "finnhub", connect: () => streamConnectFinnhub(env, symbols) });
    if (!providers.length) return json({ ok: false, error: "No WebSocket market-data provider is configured." }, 503);

    let initialConnection;
    const initialErrors = [];
    for (const provider of providers) {
        try { initialConnection = await provider.connect(); break; }
        catch (error) {
            initialErrors.push(`${provider.name}: ${String(error?.message || error).slice(0, 180)}`);
            console.warn(`Market stream provider ${provider.name} unavailable:`, error?.message || error);
        }
    }
    if (!initialConnection) return json({ ok: false, error: "All configured WebSocket providers are unavailable.", providers: initialErrors }, 502);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    let activeConnection = initialConnection;
    let activeProviderIndex = providers.findIndex(item => item.name === initialConnection.provider);
    let closed = false;
    let switching = false;
    let messageCount = 0;
    let messageWindow = Date.now();

    function closeAll(code = 1000, reason = "Connection closed") {
        if (closed) return;
        closed = true;
        try { server.close(code, reason); } catch {}
        try { activeConnection?.socket?.close(code, reason); } catch {}
    }

    function sendConnected(provider, failover = false) {
        streamSend(server, {
            type: "connected", provider, broker: provider, symbols,
            failover, connectedAt: new Date().toISOString()
        });
    }

    function forwardTwelveData(data, provider) {
        if (data.event === "subscribe-status" || data.event === "price" || data.status === "ok") {
            streamSend(server, { type: "market_update", provider, data, receivedAt: new Date().toISOString() });
        } else if (data.status === "error" || data.event === "error") {
            streamSend(server, { type: "market_error", provider, message: String(data.message || data.code || "Provider error").slice(0, 300) });
        } else {
            streamSend(server, { type: "market_message", provider, data });
        }
    }

    function attachConnection(connection) {
        const socket = connection.socket;
        const provider = connection.provider;
        socket.addEventListener("message", event => {
            if (closed || activeConnection?.socket !== socket) return;
            let data;
            try { data = JSON.parse(event.data); }
            catch { streamSend(server, { type: "provider_message", provider, data: String(event.data).slice(0, 1000) }); return; }
            if (provider === "twelve_data") {
                forwardTwelveData(data, provider);
                return;
            }
            if (data.type === "trade" && Array.isArray(data.data)) {
                for (const trade of data.data) {
                    const matched = symbols.find(symbol => marketFinnhubSymbol(streamProviderSymbol(symbol)) === trade.s);
                    if (!matched || !Number.isFinite(Number(trade.p)) || Number(trade.p) <= 0) continue;
                    streamSend(server, {
                        type: "market_update", provider,
                        data: { event: "price", symbol: matched, price: Number(trade.p), timestamp: Number(trade.t) },
                        receivedAt: new Date().toISOString()
                    });
                }
            } else if (data.type === "error") {
                streamSend(server, { type: "market_error", provider, message: String(data.msg || "Finnhub stream error").slice(0, 300) });
            }
        });
        socket.addEventListener("close", () => {
            if (closed || activeConnection?.socket !== socket) return;
            void switchProvider("upstream_close");
        });
        socket.addEventListener("error", () => {
            if (closed || activeConnection?.socket !== socket) return;
            void switchProvider("upstream_error");
        });
    }

    async function switchProvider(reason) {
        if (closed || switching) return;
        switching = true;
        const previous = activeConnection;
        streamSend(server, { type: "stream_status", streamStatus: "FAILING_OVER", provider: previous?.provider, reason });
        try { previous?.socket?.close(1012, "Switching market-data provider"); } catch {}
        for (let index = activeProviderIndex + 1; index < providers.length; index++) {
            try {
                const next = await providers[index].connect();
                if (closed) { try { next.socket.close(); } catch {} return; }
                activeConnection = next;
                activeProviderIndex = index;
                attachConnection(next);
                sendConnected(next.provider, true);
                switching = false;
                return;
            } catch (error) {
                console.warn(`Market stream failover to ${providers[index].name} failed:`, error?.message || error);
            }
        }
        streamSend(server, { type: "market_error", message: "All streaming providers failed; client will reconnect and HTTP quote fallback remains active." });
        closeAll(1011, "All market streaming providers failed");
        switching = false;
    }

    attachConnection(initialConnection);
    sendConnected(initialConnection.provider, false);

    server.addEventListener("message", event => {
        if (closed) return;
        const now = Date.now();
        if (now - messageWindow >= 1000) { messageWindow = now; messageCount = 0; }
        if (++messageCount > MARKET_STREAM_CONFIG.MAX_MESSAGES_PER_SECOND) return closeAll(1008, "Message rate limit exceeded");
        const raw = String(event.data || "");
        if (raw.length > MARKET_STREAM_CONFIG.MAX_CLIENT_MESSAGE_LENGTH) return closeAll(1009, "Message too large");
        let message;
        try { message = JSON.parse(raw); } catch { return closeAll(1008, "Invalid client message"); }
        if (message.type === "ping") {
            streamSend(server, { type: "pong", timestamp: new Date().toISOString() });
            return;
        }
        closeAll(1008, "Unsupported client message");
    });
    server.addEventListener("close", () => closeAll(1000, "Client disconnected"));
    server.addEventListener("error", () => closeAll(1011, "Client connection error"));

    return new Response(null, { status: 101, webSocket: client });
}
async function handleMarketSnapshot(request, env) {
const url = new URL(request.url);
    const symbol = streamNormalizeSymbol(
        url.searchParams.get("symbol")
    );

    if (!SYMBOLS[symbol]) {
        return json({
            ok: false,
            error: "Unsupported market symbol."
        }, 400);
    }

    try {
        const result = await marketGetPrice(
            env,
            symbol
        );

        if (!result) {
            return json({
                ok: false,
                error: "Market price unavailable."
            }, 502);
        }

        return json({
            ok: true,
            symbol,
            price: result.price ??
                result.close ??
                result.data?.price ??
                null,
            source: result.source || "market_data_provider",
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(
            "Market snapshot error:",
            error?.message || error
        );

        return json({
            ok: false,
            error: "Could not retrieve market price."
        }, 502);
    }
}
// ============================================================
const SCHEDULER_CONFIG = {
MAX_JOBS_PER_RUN: 50,
MIN_INTERVAL_MINUTES: 5,
MAX_INTERVAL_MINUTES: 1440,
LEASE_MINUTES: 10,
DEFAULT_INTERVAL_MINUTES: 5,
MAX_RUN_HISTORY: 100
};
const SCHEDULER_JOB_TYPES = [
"monitor_positions",
"scan_watchlist"
];
function schedulerNow() {
return new Date().toISOString();
}
function schedulerId() {
return crypto.randomUUID();
}
function schedulerText(value, maxLength = 500) {
return String(value ?? "").trim().slice(0, maxLength);
}
function schedulerNumber(value, fallback = 0) {
const number = Number(value);
return Number.isFinite(number) ? number : fallback;
}
function schedulerInterval(value) {
const interval = Math.floor(
schedulerNumber(value, SCHEDULER_CONFIG.DEFAULT_INTERVAL_MINUTES)
);
if (
interval < SCHEDULER_CONFIG.MIN_INTERVAL_MINUTES ||
interval > SCHEDULER_CONFIG.MAX_INTERVAL_MINUTES
) {
throw new Error(
`Interval must be between ${SCHEDULER_CONFIG.MIN_INTERVAL_MINUTES} and ${SCHEDULER_CONFIG.MAX_INTERVAL_MINUTES} minutes.`
);
}
return interval;
}
function schedulerNextRun(intervalMinutes, from = new Date()) {
return new Date(
from.getTime() + intervalMinutes * 60 * 1000
).toISOString();
}
function schedulerParseSettings(value) {
if (!value) return {};
try {
const parsed = typeof value === "string"
? JSON.parse(value)
: value;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
} catch {
return {};
}
}
function schedulerSafeJson(value) {
try {
return JSON.stringify(value ?? {});
} catch {
return "{}";
}
}
async function schedulerLogRun(env, run) {
const id = schedulerId();
await env.DB.prepare(`INSERT INTO scheduled_job_runs ( id, job_id, user_id, job_type, status, started_at, completed_at, result_json, error ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
id,
run.jobId,
run.userId,
run.jobType,
run.status,
run.startedAt,
run.completedAt || null,
schedulerSafeJson(run.result),
run.error ? schedulerText(run.error, 2000) : null
).run();
return id;
}
async function schedulerCreateJob(env, userId, input) {
const jobType = schedulerText(input.jobType, 50);
if (!SCHEDULER_JOB_TYPES.includes(jobType)) {
throw new Error("Unsupported scheduled job type.");
}
const intervalMinutes = schedulerInterval(input.intervalMinutes);
const settings = schedulerParseSettings(input.settings);
if (jobType === "scan_watchlist") {
if (settings.watchlistId !== undefined) {
settings.watchlistId = schedulerText(
settings.watchlistId,
100
);
      if (!settings.watchlistId) {
        throw new Error("A valid watchlist ID is required.");
      }
    }
}
const id = schedulerId();
const now = schedulerNow();
await env.DB.prepare(`INSERT INTO scheduled_jobs ( id, user_id, job_type, enabled, interval_minutes, settings_json, last_run_at, next_run_at, lease_until, created_at, updated_at ) VALUES (?, ?, ?, 1, ?, ?, NULL, ?, NULL, ?, ?)`).bind(
id,
userId,
jobType,
intervalMinutes,
schedulerSafeJson(settings),
schedulerNextRun(intervalMinutes),
now,
now
).run();
return {
id,
jobType,
enabled: true,
intervalMinutes,
settings,
nextRunAt: schedulerNextRun(intervalMinutes),
createdAt: now
};
}
async function schedulerGetJobs(env, userId) {
const result = await env.DB.prepare(`SELECT id, job_type, enabled, interval_minutes, settings_json, last_run_at, next_run_at, created_at, updated_at FROM scheduled_jobs WHERE user_id = ? ORDER BY created_at DESC`).bind(userId).all();
return (result.results || []).map(row => ({
id: row.id,
jobType: row.job_type,
enabled: Boolean(row.enabled),
intervalMinutes: row.interval_minutes,
settings: schedulerParseSettings(row.settings_json),
lastRunAt: row.last_run_at,
nextRunAt: row.next_run_at,
createdAt: row.created_at,
updatedAt: row.updated_at
}));
}
async function schedulerUpdateJob(env, userId, jobId, input) {
const existing = await env.DB.prepare(`SELECT * FROM scheduled_jobs WHERE id = ? AND user_id = ? LIMIT 1`).bind(jobId, userId).first();
if (!existing) {
return null;
}
let enabled = Boolean(existing.enabled);
let intervalMinutes = existing.interval_minutes;
let settings = schedulerParseSettings(existing.settings_json);
if (input.enabled !== undefined) {
if (typeof input.enabled !== "boolean") {
throw new Error("Enabled must be true or false.");
}
    enabled = input.enabled;
}
if (input.intervalMinutes !== undefined) {
intervalMinutes = schedulerInterval(input.intervalMinutes);
}
if (input.settings !== undefined) {
const updatedSettings = schedulerParseSettings(input.settings);
    settings = {
      ...settings,
      ...updatedSettings
    };
}
const now = schedulerNow();
const nextRunAt = enabled
? schedulerNextRun(intervalMinutes)
: existing.next_run_at;
await env.DB.prepare(`UPDATE scheduled_jobs SET enabled = ?, interval_minutes = ?, settings_json = ?, next_run_at = ?, lease_until = NULL, updated_at = ? WHERE id = ? AND user_id = ?`).bind(
enabled ? 1 : 0,
intervalMinutes,
schedulerSafeJson(settings),
nextRunAt,
now,
jobId,
userId
).run();
return {
id: jobId,
enabled,
intervalMinutes,
settings,
nextRunAt
};
}
async function schedulerDeleteJob(env, userId, jobId) {
const result = await env.DB.prepare(`DELETE FROM scheduled_jobs WHERE id = ? AND user_id = ?`).bind(jobId, userId).run();
return Boolean(result.meta?.changes);
}
async function schedulerGetRuns(env, userId, limit = 50) {
const safeLimit = Math.max(
1,
Math.min(SCHEDULER_CONFIG.MAX_RUN_HISTORY, Math.floor(limit))
);
const result = await env.DB.prepare(`SELECT id, job_id, job_type, status, started_at, completed_at, result_json, error FROM scheduled_job_runs WHERE user_id = ? ORDER BY started_at DESC LIMIT ?`).bind(userId, safeLimit).all();
return (result.results || []).map(row => ({
id: row.id,
jobId: row.job_id,
jobType: row.job_type,
status: row.status,
startedAt: row.started_at,
completedAt: row.completed_at,
result: schedulerParseSettings(row.result_json),
error: row.error
}));
}
async function schedulerRunPositionMonitor(env, userId) {
if (typeof monitorOpenPositions !== "function") {
throw new Error("Position monitoring engine is unavailable.");
}
const result = await monitorOpenPositions(env, userId);
return {
success: true,
jobType: "monitor_positions",
result: result ?? null,
executedAt: schedulerNow()
};
}
async function schedulerRunWatchlistScan(env, userId, settings = {}) {
const watchlistId = schedulerText(settings.watchlistId, 100);
let watchlists;
if (watchlistId) {
const selected = await env.DB.prepare(`SELECT id, name FROM trade_watchlists WHERE id = ? AND user_id = ? LIMIT 1`).bind(watchlistId, userId).first();
    if (!selected) {
      throw new Error("The selected watchlist was not found.");
    }

    watchlists = [selected];
} else {
const result = await env.DB.prepare(`SELECT id, name FROM trade_watchlists WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`).bind(userId).all();
    watchlists = result.results || [];
}
const scanResults = [];
let notificationCount = 0;
for (const watchlist of watchlists) {
const symbolsResult = await env.DB.prepare(`SELECT symbol FROM trade_watchlist_symbols WHERE watchlist_id = ? ORDER BY symbol LIMIT 50`).bind(watchlist.id).all();
    const symbols = (symbolsResult.results || [])
      .map(row => schedulerText(row.symbol, 32))
      .filter(symbol => /^[A-Za-z0-9_]{2,32}$/.test(symbol));

    for (const symbol of symbols) {
      try {
        if (typeof aiGenerateSignal !== "function") {
          throw new Error("AI signal engine is unavailable.");
        }

        const timeframe = schedulerText(
          settings.timeframe || "15min",
          20
        );

        const signal = await aiGenerateSignal(
          env,
          symbol,
          timeframe
        );

        if (!signal) continue;

        const direction = String(
          signal.direction || signal.signal || signal.action || ""
        ).toUpperCase();

        const confidence = schedulerNumber(
          signal.confidence,
          0
        );

        const scanItem = {
          watchlistId: watchlist.id,
          watchlistName: watchlist.name,
          symbol,
          timeframe,
          direction,
          confidence,
          signal
        };

        scanResults.push(scanItem);

        const minimumConfidence = Math.max(
          0,
          Math.min(
            100,
            schedulerNumber(settings.minimumConfidence, 70)
          )
        );

        if (
          ["BUY", "SELL"].includes(direction) &&
          confidence >= minimumConfidence &&
          typeof notificationCreate === "function"
        ) {
          await notificationCreate(env, {
            userId,
            type: "scheduled_signal",
            title: `AI ${direction} signal: ${symbol}`,
            message: `${symbol} generated a ${direction} signal on ${timeframe}. Confidence: ${confidence}%.`,
            data: {
              symbol,
              timeframe,
              direction,
              confidence,
              watchlistId: watchlist.id
            }
          });

          notificationCount++;
        }
      } catch (error) {
        scanResults.push({
          watchlistId: watchlist.id,
          symbol,
          error: schedulerText(error.message, 500)
        });
      }
    }
}
return {
success: true,
jobType: "scan_watchlist",
watchlistsScanned: watchlists.length,
symbolsScanned: scanResults.length,
notificationsCreated: notificationCount,
results: scanResults,
executedAt: schedulerNow()
};
}
async function schedulerExecuteJob(env, job) {
const startedAt = schedulerNow();
try {
const settings = schedulerParseSettings(job.settings_json);
    let result;

    if (job.job_type === "monitor_positions") {
      result = await schedulerRunPositionMonitor(
        env,
        job.user_id
      );
    } else if (job.job_type === "scan_watchlist") {
      result = await schedulerRunWatchlistScan(
        env,
        job.user_id,
        settings
      );
    } else {
      throw new Error("Unsupported scheduled job type.");
    }

    const completedAt = schedulerNow();

    await schedulerLogRun(env, {
      jobId: job.id,
      userId: job.user_id,
      jobType: job.job_type,
      status: "completed",
      startedAt,
      completedAt,
      result
    });

    return {
      success: true,
      jobId: job.id,
      result
    };
} catch (error) {
const completedAt = schedulerNow();
    try {
      await schedulerLogRun(env, {
        jobId: job.id,
        userId: job.user_id,
        jobType: job.job_type,
        status: "failed",
        startedAt,
        completedAt,
        error: error.message
      });
    } catch (logError) {
      console.error(
        "Unable to record scheduled job failure:",
        logError.message
      );
    }

    return {
      success: false,
      jobId: job.id,
      error: schedulerText(error.message, 1000)
    };
} finally {
const now = schedulerNow();
    const interval = schedulerInterval(
      job.interval_minutes
    );

    await env.DB.prepare(`
      UPDATE scheduled_jobs
      SET
        last_run_at = ?,
        next_run_at = ?,
        lease_until = NULL,
        updated_at = ?
      WHERE id = ?
    `).bind(
      now,
      schedulerNextRun(interval),
      now,
      job.id
    ).run();
}
}
async function runScheduledJobs(env, scheduledTime) {
if (!env.DB) {
console.error("Scheduler cannot run: D1 binding DB is missing.");
return;
}
const executionTime = new Date(
scheduledTime || Date.now()
).toISOString();
const jobsResult = await env.DB.prepare(`SELECT * FROM scheduled_jobs WHERE enabled = 1 AND next_run_at <= ? AND ( lease_until IS NULL OR lease_until < ? ) ORDER BY next_run_at ASC LIMIT ?`).bind(
executionTime,
executionTime,
SCHEDULER_CONFIG.MAX_JOBS_PER_RUN
).all();
const jobs = jobsResult.results || [];
for (const job of jobs) {
const leaseUntil = new Date(
Date.now() +
SCHEDULER_CONFIG.LEASE_MINUTES * 60 * 1000
).toISOString();
    const claim = await env.DB.prepare(`
      UPDATE scheduled_jobs
      SET lease_until = ?
      WHERE id = ?
        AND enabled = 1
        AND next_run_at <= ?
        AND (
          lease_until IS NULL
          OR lease_until < ?
        )
    `).bind(
      leaseUntil,
      job.id,
      executionTime,
      executionTime
    ).run();

    if (!claim.meta?.changes) {
      continue;
    }

    try {
      await schedulerExecuteJob(env, job);
    } catch (error) {
      console.error(
        `Scheduled job ${job.id} failed:`,
        error.message
      );
    }
}
return {
executed: jobs.length,
executedAt: executionTime
};
}
async function handleScheduledJobs(request, env, user) {
const url = new URL(request.url);
const method = request.method;
const userId = user.id;
if (method === "GET" && url.pathname === "/api/automation/jobs") {
const jobs = await schedulerGetJobs(env, userId);
    return json({
      ok: true,
      jobs
    });
}
if (method === "POST" && url.pathname === "/api/automation/jobs") {
const body = await request.json();
    try {
      const job = await schedulerCreateJob(
        env,
        userId,
        body
      );

      return json({
        ok: true,
        message: "Scheduled job created.",
        job
      }, 201);
    } catch (error) {
      return json({
        ok: false,
        error: error.message
      }, 400);
    }
}
if (method === "GET" && url.pathname === "/api/automation/runs") {
const limit = url.searchParams.get("limit") || 50;
    const runs = await schedulerGetRuns(
      env,
      userId,
      limit
    );

    return json({
      ok: true,
      runs
    });
}
const match = url.pathname.match(
/^\/api\/automation\/jobs\/([A-Za-z0-9-]+)$/
);
if (match) {
const jobId = match[1];
    if (method === "PATCH") {
      const body = await request.json();

      try {
        const job = await schedulerUpdateJob(
          env,
          userId,
          jobId,
          body
        );

        if (!job) {
          return json({
            ok: false,
            error: "Scheduled job not found."
          }, 404);
        }

        return json({
          ok: true,
          message: "Scheduled job updated.",
          job
        });
      } catch (error) {
        return json({
          ok: false,
          error: error.message
        }, 400);
      }
    }

    if (method === "DELETE") {
      const deleted = await schedulerDeleteJob(
        env,
        userId,
        jobId
      );

      if (!deleted) {
        return json({
          ok: false,
          error: "Scheduled job not found."
        }, 404);
      }

      return json({
        ok: true,
        message: "Scheduled job deleted."
      });
    }
}
return json({
ok: false,
error: "Automation endpoint not found."
}, 404);
}


/* =========================================
TRADELAB AI REQUEST ROUTER
========================================= */
async function requirePaidUser(request, env) {
  const user = await getAuthenticatedUser(request, env);
  if (!user) {
    return {
      response: json({ ok: false, error: "Authentication required." }, 401)
    };
  }

  const entitlement = await getSubscriptionEntitlement(env, user);
  if (!entitlement.active) {
    return { response: paymentRequiredResponse(entitlement) };
  }

  return { user };
}

async function routeRequest(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method.toUpperCase();

  try {
    const originExempt = path === "/api/billing/webhook" ||
      path === "/api/flutterwave/webhook" ||
      path === "/api/mt5/bridge/ingest";
    if (path.startsWith("/api/") && !originExempt &&
        !["GET", "HEAD", "OPTIONS"].includes(method) &&
        !validOrigin(request, url)) {
      return json({ error: "Request origin rejected" }, 403);
    }

    // Authentication routes must be handled before the paid-user API gate.
    if (path.startsWith("/api/auth/")) {
      return await handleAuth(request, env, url);
    }

    if (path === "/api/billing/webhook" || path === "/api/flutterwave/webhook") {
      return await handleFlutterwaveWebhook(request, env);
    }

    if (path.startsWith("/api/billing/")) {
      return await handleBilling(request, env, url);
    }

    if (path === "/api/mt5/bridge/ingest") {
      return await handleMT5BridgeIngest(request, env);
    }

    if (path === "/api/market" || path === "/api/candles") {
      return await handleMarket(request, env, url);
    }

    if (path.startsWith("/api/deriv/")) {
      return await handleDeriv(request, env, url);
    }

    if (path === "/api/ctrader/connect") {
      return await handleCTraderConnect(request, env, url);
    }
    if (path === "/api/ctrader/callback") {
      return await handleCTraderCallback(request, env, url);
    }

    if (path.startsWith("/api/")) {
      const access = await requirePaidUser(request, env);
      if (access.response) return access.response;
      const user = access.user;

      // Market intelligence is a protected API and runs only after authentication.
      if (path.startsWith("/api/market-intelligence/")) {
        return await handleMarketIntelligence(request, env, url);
      }

      if (["/api/ai/signals", "/api/ai/signals/history", "/api/ai/signals/record", "/api/ai/signals/performance"].includes(path)) {
        return await handleAISignals(request, env, url, user);
      }
      if (path.startsWith("/api/historical/")) {
        return await handleHistoricalData(request, env, url, user);
      }
      if (path === "/api/ai/strategies") {
        return await handleStrategyAnalysis(request, env, user, url);
      }
      if (path === "/api/ai/multi-timeframe") {
        return await handleMultiTimeframeAnalysis(request, env, user, url);
      }
      if (path === "/api/trading/risk/assess" && method === "POST") {
        return await handleRiskAssessment(request, env, user);
      }
      if (path === "/api/trading/risk/settings" && (method === "GET" || method === "PUT")) {
        return await handleRiskSettings(request, env, user);
      }
      if (path === "/api/trading/journal" && method === "POST") {
        return await journalCreateTrade(request, env, user);
      }
      if (path === "/api/trading/journal" && method === "GET") {
        return await journalGetTrades(request, env, user, url);
      }
      const closeMatch = path.match(/^\/api\/trading\/journal\/([A-Za-z0-9-]+)\/close$/);
      if (closeMatch && method === "POST") {
        return await journalCloseTrade(request, env, user, closeMatch[1]);
      }
      if (path === "/api/trading/performance" && method === "GET") {
        return await journalGetPerformance(env, user, url);
      }
      if (path === "/api/trading/monitor" && method === "GET") {
        return json(await monitorOpenPositions(env, user));
      }
      if (path === "/api/trading/monitor/events" && method === "GET") {
        return await monitorGetEvents(env, user, url);
      }
      if (path.startsWith("/api/price-alerts")) {
        return await handlePriceAlerts(request, env, user);
      }
      if (path.startsWith("/api/notifications")) {
        return await handleNotifications(request, env, user);
      }
      if (path.startsWith("/api/scanner/") || path.startsWith("/api/watchlists")) {
        return await handleMarketScanner(request, env, user);
      }
      if (path.startsWith("/api/dashboard/")) {
        return await handleAdvancedDashboard(request, env, user);
      }
      if (path.startsWith("/api/brokers/")) {
        return await handleBrokerSynchronization(request, env, user);
      }
      if (path === "/api/market/stream") {
        return await handleMarketStream(request, env, user);
      }
      if (path === "/api/market/snapshot") {
        return await handleMarketSnapshot(request, env);
      }
      if (path.startsWith("/api/automation/")) {
        return await handleScheduledJobs(request, env, user);
      }
    }

    if (path.startsWith("/api/")) {
      return json({ ok: false, error: "API endpoint not found." }, 404);
    }

    if (env.ASSETS) {
      return applySecurityHeaders(await env.ASSETS.fetch(request));
    }

    return new Response("TradeLab AI", { status: 200 });
  } catch (error) {
    console.error("TradeLab request failed:", path, error?.stack || error?.message || error);
    return json({ ok: false, error: "An unexpected server error occurred." }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    return routeRequest(request, env, ctx);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledJobs(env, controller.scheduledTime));
  }
};
