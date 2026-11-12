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
const PASSWORD_ITERATIONS = 100000;
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

  return Array.from(data, b =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

function base64Url(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

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

function sessionCookie(
  token,
  maxAge = SESSION_DAYS * 86400
) {
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

async function logAuthEvent(
  env,
  userId,
  email,
  eventType
) {
  await env.DB.prepare(`
    INSERT INTO auth_events (user_id, email, event_type)
    VALUES (?, ?, ?)
  `).bind(
    userId || null,
    email || null,
    eventType
  ).run();
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
  `).bind(
    sessionId,
    userId,
    expiresAt
  ).run();

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

/* =========================================
   REGISTRATION
========================================= */

async function register(request, env) {
  let body;

  try {
    body = await readJson(request);
  } catch {
    return json({
      error: "Invalid request body"
    }, 400);
  }

  const email = String(body.email || "")
    .trim()
    .toLowerCase();

  const password = String(body.password || "");

  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return json({
      error: "Enter a valid email address"
    }, 400);
  }

  if (password.length < 12 || password.length > 128) {
    return json({
      error: "Password must contain 12–128 characters"
    }, 400);
  }

  const userId = randomId(16);
  const salt = randomId(16);

  const passwordHash = await hashPassword(
    password,
    salt
  );

  try {
    await env.DB.prepare(`
      INSERT INTO users (
        id,
        email,
        password_hash,
        password_salt
      )
      VALUES (?, ?, ?, ?)
    `).bind(
      userId,
      email,
      passwordHash,
      salt
    ).run();
