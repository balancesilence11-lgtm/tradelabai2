const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  XAUUSD: "XAU/USD",
  BTCUSD: "BTC/USD"
};

const ALLOWED_INTERVALS = [
  "1min", "5min", "15min", "30min",
  "1h", "4h", "1day"
];

const SESSION_COOKIE = "__Host-tl_session";
const SESSION_DAYS = 7;
const PASSWORD_ITERATIONS = 210000;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const encoder = new TextEncoder();

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

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function sha256(value) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(value)
  );

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

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(salt),
      iterations: PASSWORD_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );

  return base64Url(new Uint8Array(bits));
}

function cookieValue(request) {
  const cookies = request.headers.get("Cookie") || "";

  for (const item of cookies.split(";")) {
    const [name, ...parts] = item.trim().split("=");

    if (name === SESSION_COOKIE) {
      return parts.join("=");
    }
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
  const contentLength = Number(
    request.headers.get("Content-Length") || 0
  );

  if (contentLength > 8192) {
    throw new Error("Request too large");
  }

  const text = await request.text();

  if (text.length > 8192) {
    throw new Error("Request too large");
  }

  return JSON.parse(text);
}

async function logAuthEvent(env, userId, email, eventType) {
  await env.DB.prepare(`
    INSERT INTO auth_events (user_id, email, event_type)
    VALUES (?, ?, ?)
  `).bind(userId || null, email || null, eventType).run();
}

async function createSession(env, userId) {
  const token = base64Url(
    crypto.getRandomValues(new Uint8Array(32))
  );

  const sessionId = await sha256(token);

  const expiresAt = new Date(
    Date.now() + SESSION_DAYS * 86400000
  ).toISOString();

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
    await env.DB.prepare(
      "DELETE FROM sessions WHERE id = ?"
    ).bind(sessionId).run();

    return null;
  }

  return {
    id: session.user_id,
    email: session.email,
    createdAt: session.created_at
  };
}

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
    return json({
      error: "Password must contain 12–128 characters"
    }, 400);
  }

  const userId = randomId(16);
  const salt = randomId(16);
  const passwordHash = await hashPassword(password, salt);

  try {
    await env.DB.prepare(`
      INSERT INTO users (
        id, email, password_hash, password_salt
      )
      VALUES (?, ?, ?, ?)
    `).bind(
      userId,
      email,
      passwordHash,
      salt
    ).run();

  } catch (error) {
    if (String(error.message).toLowerCase().includes("unique")) {
      return json({
        error: "An account with this email already exists"
      }, 409);
    }

    console.error("Registration database error:", error.message);
    return json({ error: "Unable to create account" }, 500);
  }

  await logAuthEvent(env, userId, email, "registration");

  const token = await createSession(env, userId);

  return json({
    ok: true,
    message: "Account created successfully",
    user: {
      id: userId,
      email
    }
  }, 201, {
    "Set-Cookie": sessionCookie(token)
  });
}

async function login(request, env) {
  let body;

  try {
    body = await readJson(request);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  if (
    !email ||
    email.length > 254 ||
    !password ||
    password.length > 128
  ) {
    return json({ error: "Invalid email or password" }, 400);
  }

  const now = Date.now();

  const attempts = await env.DB.prepare(`
    SELECT attempts, window_started_at, locked_until
    FROM login_attempts
    WHERE email = ?
  `).bind(email).first();

  if (
    attempts?.locked_until &&
    Date.parse(attempts.locked_until) > now
  ) {
    return json({
      error: "Too many login attempts. Try again later."
    }, 429);
  }

  const user = await env.DB.prepare(`
    SELECT id, email, password_hash, password_salt, status
    FROM users
    WHERE email = ?
  `).bind(email).first();

  let valid = false;

  if (user && user.status === "active") {
    const suppliedHash = await hashPassword(
      password,
      user.password_salt
    );

    valid = suppliedHash === user.password_hash;
  }

  if (!valid) {
    const windowStart = attempts?.window_started_at
      ? Date.parse(attempts.window_started_at)
      : 0;

    const withinWindow =
      now - windowStart < LOGIN_WINDOW_MS;

    const count = withinWindow
      ? Number(attempts.attempts) + 1
      : 1;

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
      withinWindow
        ? attempts.window_started_at
        : new Date(now).toISOString(),
      lockedUntil
    ).run();

    await logAuthEvent(env, null, email, "login_failed");

    return json({
      error: "Invalid email or password"
    }, 401);
  }

  await env.DB.prepare(
    "DELETE FROM login_attempts WHERE email = ?"
  ).bind(email).run();

  await logAuthEvent(
    env,
    user.id,
    email,
    "login_success"
  );

  const token = await createSession(env, user.id);

  return json({
    ok: true,
    message: "Login successful",
    user: {
      id: user.id,
      email: user.email
    }
  }, 200, {
    "Set-Cookie": sessionCookie(token)
  });
}

async function logout(request, env) {
  const token = cookieValue(request);

  if (token) {
    const sessionId = await sha256(token);

    const session = await env.DB.prepare(`
      SELECT user_id FROM sessions WHERE id = ?
    `).bind(sessionId).first();

    await env.DB.prepare(
      "DELETE FROM sessions WHERE id = ?"
    ).bind(sessionId).run();

    if (session) {
      await logAuthEvent(
        env,
        session.user_id,
        null,
        "logout"
      );
    }
  }

  return json({
    ok: true,
    message: "Logged out successfully"
  }, 200, {
    "Set-Cookie": clearSessionCookie()
  });
}

async function handleAuth(request, env, url) {
  const path = url.pathname;

  if (
    ["POST"].includes(request.method) &&
    !validOrigin(request, url)
  ) {
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

    if (!user) {
      return json({ authenticated: false }, 401);
    }

    return json({
      authenticated: true,
      user
    });
  }

  return json({ error: "Authentication route not found" }, 404);
}

async function handleMarket(request, env, url) {
  if (
    url.pathname === "/api/market" ||
    url.pathname === "/api/candles"
  ) {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    const symbol = url.searchParams
      .get("symbol")
      ?.toUpperCase()
      .replace("/", "");

    const providerSymbol = SYMBOLS[symbol];

    if (!providerSymbol) {
      return json({ error: "Unsupported symbol" }, 400);
    }

    if (!env.TWELVE_DATA_API_KEY) {
      return json({
        error: "Market data API is not configured"
      }, 500);
    }

    if (url.pathname === "/api/market") {
      const apiUrl = new URL(
        "https://api.twelvedata.com/price"
      );

      apiUrl.searchParams.set("symbol", providerSymbol);
      apiUrl.searchParams.set(
        "apikey",
        env.TWELVE_DATA_API_KEY
      );

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

        return json({
          error: "Unable to retrieve market data"
        }, 502);
      }
    }

    if (url.pathname === "/api/candles") {
      const interval =
        url.searchParams.get("interval") || "5min";

      if (!ALLOWED_INTERVALS.includes(interval)) {
        return json({
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

      const apiUrl = new URL(
        "https://api.twelvedata.com/time_series"
      );

      apiUrl.searchParams.set("symbol", providerSymbol);
      apiUrl.searchParams.set("interval", interval);
      apiUrl.searchParams.set("outputsize", String(outputsize));
      apiUrl.searchParams.set("apikey", env.TWELVE_DATA_API_KEY);

      try {
        const response = await fetch(apiUrl.toString());
        const data = await response.json();

        if (
          !response.ok ||
          !Array.isArray(data.values)
        ) {
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

        return json({
          error: "Unable to retrieve candlestick data"
        }, 502);
      }
    }
  }

  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return json({
          ok: true,
          service: "TradeLab AI",
          status: "running",
          authentication: "enabled"
        });
      }

      if (url.pathname.startsWith("/api/auth/")) {
        return await handleAuth(request, env, url);
      }

      const marketResponse = await handleMarket(
        request,
        env,
        url
      );

      if (marketResponse) return marketResponse;

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
      console.error("Worker error:", error.message);

      return json({
        error: "Internal server error"
      }, 500);
    }
  }
};
