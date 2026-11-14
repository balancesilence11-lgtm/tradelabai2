const SYMBOLS = {
  // Major forex pairs
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  USDCHF: "USD/CHF",
  USDCAD: "USD/CAD",
  AUDUSD: "AUD/USD",
  NZDUSD: "NZD/USD",

  // Minor forex pairs
  EURGBP: "EUR/GBP",
  EURJPY: "EUR/JPY",
  GBPJPY: "GBP/JPY",
  AUDJPY: "AUD/JPY",

  // Commodities
  XAUUSD: "XAU/USD",

  // Cryptocurrencies
  BTCUSD: "BTC/USD"
};

const ALLOWED_INTERVALS = ["1min", "5min", "15min", "30min", "1h", "4h", "1day"];
const SESSION_COOKIE = "__Host-tl_session";
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 100000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const encoder = new TextEncoder();

/* =========================================
   GENERAL RESPONSE AND SECURITY HELPERS
========================================= */

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
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
  if (origin && origin !== url.origin) return false;
  if (fetchSite === "cross-site") return false;
  return true;
}

async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 8192) throw new Error("Request too large");
  const text = await request.text();
  if (text.length > 8192) throw new Error("Request too large");
  return JSON.parse(text);
}

/* =========================================
   AUTHENTICATION DATABASE HELPERS
========================================= */

async function logAuthEvent(env, userId, email, eventType) {
  await env.DB.prepare(`
    INSERT INTO auth_events (user_id, email, event_type)
    VALUES (?, ?, ?)
  `).bind(userId || null, email || null, eventType).run();
}

async function createSession(env, userId) {
  const token = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const sessionId = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString();

  await env.DB.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).bind(sessionId, userId, expiresAt).run();

  return token;
}

async function getAuthenticatedUser(request, env) {
  const token = cookieValue(request);
  if (!token) return null;

  const sessionId = await sha256(token);

  const session = await env.DB.prepare(`
    SELECT
      sessions.id,
      sessions.user_id,
      sessions.expires_at,
      users.email,
      users.status,
      users.created_at
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).bind(sessionId).first();

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
  let body;

  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json({ error: "Enter a valid email address" }, 400);
  }

  if (password.length < 12 || password.length > 128) {
    return json({ error: "Password must contain 12–128 characters" }, 400);
  }

  const userId = randomId(16);
  const salt = randomId(16);
  const passwordHash = await hashPassword(password, salt);

  try {
    await env.DB.prepare(`
      INSERT INTO users (id, email, password_hash, password_salt)
      VALUES (?, ?, ?, ?)
    `).bind(userId, email, passwordHash, salt).run();

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
  let body;

  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (!email || email.length > 254 || !password || password.length > 128) {
    return json({ error: "Invalid email or password" }, 400);
  }

  const now = Date.now();

  const attempts = await env.DB.prepare(`
    SELECT attempts, window_started_at, locked_until
    FROM login_attempts
    WHERE email = ?
  `).bind(email).first();

  if (attempts?.locked_until && Date.parse(attempts.locked_until) > now) {
    return json({ error: "Too many login attempts. Try again later." }, 429);
  }

  const user = await env.DB.prepare(`
    SELECT id, email, password_hash, password_salt, status
    FROM users
    WHERE email = ?
  `).bind(email).first();

  let valid = false;

  if (user && user.status === "active") {
    const suppliedHash = await hashPassword(password, user.password_salt);
    valid = suppliedHash === user.password_hash;
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
      email,
      count,
      withinWindow ? attempts.window_started_at : new Date(now).toISOString(),
      lockedUntil
    ).run();

    await logAuthEvent(env, null, email, "login_failed");
    return json({ error: "Invalid email or password" }, 401);
  }

  await env.DB.prepare("DELETE FROM login_attempts WHERE email = ?")
    .bind(email).run();

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
}

/* =========================================
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
   TWELVE DATA MARKET CONNECTION
========================================= */

async function handleMarket(request, env, url) {
  if (
    url.pathname !== "/api/market" &&
    url.pathname !== "/api/candles"
  ) {
    return null;
  }

  if (request.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const symbol = url.searchParams.get("symbol")
    ?.toUpperCase()
    .replace("/", "");

  const providerSymbol = SYMBOLS[symbol];

  if (!providerSymbol) {
    return json({ error: "Unsupported symbol" }, 400);
  }

  if (!env.TWELVE_DATA_API_KEY) {
    return json({ error: "Market data API is not configured" }, 500);
  }

  if (url.pathname === "/api/market") {
    const apiUrl = new URL("https://api.twelvedata.com/price");
    apiUrl.searchParams.set("symbol", providerSymbol);
    apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

    try {
      const response = await fetch(apiUrl.toString());
      const data = await response.json();

      if (!response.ok || !data.price) {
        return json({
          error: "Twelve Data rejected the request",
          details: data.message || "No price returned"
        }, 502);
      }

      return json({
        ok: true,
        symbol,
        providerSymbol,
        price: Number(data.price),
        source: "Twelve Data",
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error("Market data error:", error.message);
      return json({ error: "Unable to retrieve market data" }, 502);
    }
  }

  if (url.pathname === "/api/candles") {
    const interval = url.searchParams.get("interval") || "5min";

    if (!ALLOWED_INTERVALS.includes(interval)) {
      return json({
        error: "Unsupported interval",
        allowedIntervals: ALLOWED_INTERVALS
      }, 400);
    }

    const requested = Number(url.searchParams.get("outputsize") || 100);

    const outputsize = Math.min(
      500,
      Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 100)
    );

    const apiUrl = new URL("https://api.twelvedata.com/time_series");
    apiUrl.searchParams.set("symbol", providerSymbol);
    apiUrl.searchParams.set("interval", interval);
    apiUrl.searchParams.set("outputsize", String(outputsize));
    apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

    try {
      const response = await fetch(apiUrl.toString());
      const data = await response.json();

      if (!response.ok || !Array.isArray(data.values)) {
        return json({
          error: "Unable to retrieve historical market data",
          details: data.message || "No candle data returned"
        }, 502);
      }

      const candles = data.values
        .map(item => ({
          time: item.datetime,
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.close),
          volume: Number(item.volume || 0)
        }))
        .filter(candle =>
          candle.time &&
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close)
        )
        .reverse();

      return json({
        ok: true,
        symbol,
        providerSymbol,
        interval,
        count: candles.length,
        candles,
        source: "Twelve Data",
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error("Candlestick data error:", error.message);
      return json({ error: "Unable to retrieve candlestick data" }, 502);
    }
  }

  return null;
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
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64ToBytes(value) {
  const normalized = String(value)
    .replace(/-/g, "+")
    .replace(/_/g, "/");

  const padded = normalized.padEnd(
    Math.ceil(normalized.length / 4) * 4,
    "="
  );

  const binary = atob(padded);

  return Uint8Array.from(
    binary,
    character => character.charCodeAt(0)
  );
}

async function sha256Bytes(value) {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(value))
  );
}

async function encryptDerivToken(env, token) {
  if (!env.DERIV_TOKEN_ENCRYPTION_KEY) {
    throw new Error("Deriv encryption key is not configured");
  }

  const rawKey = base64ToBytes(env.DERIV_TOKEN_ENCRYPTION_KEY);

  if (rawKey.length !== 32) {
    throw new Error("Deriv encryption key must decode to 32 bytes");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    "AES-GCM",
    false,
    ["encrypt"]
  );

  const iv = randomBytes(12);

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(token)
  );

  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

async function decryptDerivToken(env, encrypted) {
  if (!env.DERIV_TOKEN_ENCRYPTION_KEY) {
    throw new Error("Deriv encryption key is not configured");
  }

  const rawKey = base64ToBytes(env.DERIV_TOKEN_ENCRYPTION_KEY);

  if (rawKey.length !== 32) {
    throw new Error("Deriv encryption key must decode to 32 bytes");
  }

  const [ivText, ciphertextText] = String(encrypted || "").split(".");

  if (!ivText || !ciphertextText) {
    throw new Error("Stored Deriv token is invalid");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    rawKey,
    "AES-GCM",
    false,
    ["decrypt"]
  );

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
  const row = await env.DB.prepare(`
    SELECT access_token, token_expires_at
    FROM deriv_oauth
    WHERE user_id = ?
  `).bind(userId).first();

  if (!row?.access_token) return null;

  if (
    row.token_expires_at &&
    Date.parse(row.token_expires_at) <= Date.now()
  ) {
    return null;
  }

  return decryptDerivToken(env, row.access_token);
}

async function derivApiFetch(token, path, options = {}) {
  return fetch(`${DERIV_API_BASE}${path}`, {
    ...options,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(15000)
  });
}

async function handleDeriv(request, env, url) {
  const path = url.pathname;
  const isCallback = path === "/api/deriv/callback";

  const user = await getAuthenticatedUser(request, env);

  if (!user) {
    if (isCallback) return redirectToApp("login_required");
    return json({ error: "Authentication required" }, 401);
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
      await env.DB.prepare("DELETE FROM deriv_oauth WHERE user_id = ?")
        .bind(user.id).run();

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
    const row = await env.DB.prepare(`
      SELECT token_expires_at
      FROM deriv_oauth
      WHERE user_id = ?
        AND access_token IS NOT NULL
    `).bind(user.id).first();

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

    await env.DB.prepare("DELETE FROM deriv_oauth WHERE user_id = ?")
      .bind(user.id).run();

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

    /* =========================================
       TRADE ACCOUNT SECURITY
       DEMO ACCOUNTS ALLOWED BY DEFAULT
       REAL ACCOUNTS REQUIRE EXPLICIT AUTHORISATION
    ========================================= */

    const accountType = String(
      selectedAccount.account_type || ""
    ).toLowerCase();

    if (accountType === "demo") {
      console.log("Deriv demo account authorised:", accountId);
    } else if (
      accountType === "real" &&
      env.DERIV_ALLOW_REAL_TRADING === "true" &&
      body.confirm_real_trading === true
    ) {
      console.log("Deriv real account explicitly authorised:", accountId);
    } else {
      return json({
        ok: false,
        connected: true,
        authorised: false,
        error: accountType === "real"
          ? "Real-account access is disabled. Demo trading is permitted."
          : "Unrecognised account type. Access denied."
      }, 403);
    }

    /* =========================================
       GENERATE DERIV WEBSOCKET OTP
    ========================================= */

    const otpResponse = await derivApiFetch(
      token,
      `/trading/v1/options/accounts/${encodeURIComponent(accountId)}/otp`,
      { method: "POST" }
    );

    const otpData = await otpResponse.json();
    const websocketUrl = otpData.data?.url;

    if (!otpResponse.ok || !websocketUrl) {
      return json({
        ok: false,
        connected: false,
        error: "Unable to generate Deriv WebSocket authentication URL",
        status: otpResponse.status
      }, 502);
    }

    const parsed = new URL(websocketUrl);

    if (
      parsed.protocol !== "wss:" ||
      parsed.hostname !== "api.derivws.com"
    ) {
      return json({
        ok: false,
        error: "Deriv returned an unexpected WebSocket URL"
      }, 502);
    }

    return json({
      ok: true,
      connected: true,
      provider: "Deriv",
      account_id: accountId,
      account_type: selectedAccount.account_type || null,
      websocket_url: websocketUrl,
      message: "Connect immediately; the URL expires after 120 seconds and can be used once.",
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
}

/* =========================================
   MAIN CLOUDFLARE WORKER ENTRY POINT
========================================= */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      /* AUTHENTICATION ROUTES */

      if (path.startsWith("/api/auth/")) {
        return await handleAuth(request, env, url);
      }

      /* DERIV OAUTH ROUTES */

      if (path.startsWith("/api/deriv/")) {
        return await handleDeriv(request, env, url);
      }

      /* MARKET DATA ROUTES */

      if (path === "/api/market" || path === "/api/candles") {
        const user = await getAuthenticatedUser(request, env);

        if (!user) {
          return json({
            ok: false,
            error: "Authentication required"
          }, 401);
        }

        const marketResponse = await handleMarket(request, env, url);

        if (marketResponse) return marketResponse;
      }

      /* UNKNOWN API ROUTES */

      if (path.startsWith("/api/")) {
        return json({
          ok: false,
          error: "API route not found"
        }, 404);
      }

      /* REACT FRONTEND ASSETS */

      const response = await env.ASSETS.fetch(request);
      const headers = new Headers(response.headers);

      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });

    } catch (error) {
      console.error("WORKER ERROR:", {
        message: error.message,
        path
      });

      return json({
        ok: false,
        error: "Internal server error"
      }, 500);
    }
  }
};
