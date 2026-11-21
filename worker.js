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

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Resource-Policy": "same-origin",
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
  await env.DB.prepare(`
    INSERT INTO billing_audit_log (
      id,
      user_id,
      subscription_id,
      transaction_id,
      event_type,
      details_json
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
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

  const subscription = await env.DB.prepare(`
    SELECT s.id, s.plan_id, s.status, s.current_period_end,
           s.grace_period_end, s.cancel_at_period_end, p.active AS plan_active
    FROM subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.user_id = ? AND s.plan_id = ?
    ORDER BY
      CASE WHEN s.status = 'active' THEN 1 WHEN s.status = 'pending' THEN 2 ELSE 3 END,
      s.created_at DESC
    LIMIT 1
  `).bind(user.id, BILLING_PLAN_ID).first();

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
  const plan = await env.DB.prepare(`
    SELECT
      id,
      name,
      amount,
      currency,
      billing_interval_seconds,
      active
    FROM subscription_plans
    WHERE id = ?
  `).bind(BILLING_PLAN_ID).first();

  const subscription = await env.DB.prepare(`
    SELECT
      s.id,
      s.plan_id,
      s.status,
      s.payment_provider,
      s.current_period_start,
      s.current_period_end,
      s.next_billing_at,
      s.grace_period_end,
      s.cancel_at_period_end,
      s.created_at,
      p.name AS plan_name,
      p.amount,
      p.currency,
      p.billing_interval_seconds
    FROM subscriptions s
    LEFT JOIN subscription_plans p ON p.id = s.plan_id
    WHERE s.user_id = ?
    ORDER BY
      CASE
        WHEN s.status = 'active' THEN 1
        WHEN s.status = 'pending' THEN 2
        ELSE 3
      END,
      s.created_at DESC
    LIMIT 1
  `).bind(user.id).first();

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

  const existingTransaction = await env.DB.prepare(`
    SELECT id, user_id, subscription_id, status, amount_minor, currency
    FROM payment_transactions WHERE provider = 'flutterwave' AND provider_payment_ref = ? LIMIT 1
  `).bind(txRef).first();

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
      await env.DB.prepare(`
        INSERT INTO payment_transactions (id, user_id, subscription_id, provider, provider_payment_ref, idempotency_key, amount_minor, currency, status, description, provider_status, paid_at, created_at, updated_at)
        VALUES (?, ?, ?, 'flutterwave', ?, ?, ?, 'USD', 'successful', 'TradeLab AI hourly subscription renewal', ?, ?, ?, ?)
      `).bind(transactionId, userId, subscriptionId, txRef, randomId(32), amountMinor, gatewayStatus, paidAt, now, now).run();
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

  const subscription = await env.DB.prepare(`
    SELECT id, user_id, status, cancel_at_period_end
    FROM subscriptions
    WHERE id = ? AND user_id = ?
  `).bind(subscriptionId, user.id).first();

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
        env.DB.prepare(`
          UPDATE subscriptions
          SET status = 'cancelled',
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND user_id = ? AND status = 'pending'
        `).bind(subscriptionId, user.id),

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

  const providerSymbol = SYMBOLS[symbol];

  if (!providerSymbol) {
    return json({
      ok: false,
      error: "Unsupported symbol"
    }, 400);
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
  const row = await env.DB.prepare(`
    SELECT access_token, token_expires_at
    FROM deriv_oauth
    WHERE user_id = ?
  `).bind(userId).first();

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
}/* CTRADER OAUTH ROUTES */

if (
  path === "/api/ctrader/callback" &&
  request.method === "GET"
) {
  return await handleCTraderCallback(request, env, url);
}

if (
  path === "/api/ctrader/connect" &&
  request.method === "GET"
) {
  return await handleCTraderConnect(request, env, url);
}/* =========================================
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
      await env.DB.prepare(`
        INSERT INTO historical_datasets (
          id,
          user_id,
          symbol,
          timeframe,
          source,
          expected_candles,
          candle_count,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?, ?)
      `).bind(
        datasetId,
        user.id,
        symbol,
        timeframe,
        source,
        expectedCandles,
        now,
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
        SELECT COUNT(*) AS total
        FROM historical_candles
        WHERE dataset_id = ?
      `).bind(datasetId).first();

      const totalCandles = Number(updated?.total || 0);

      await env.DB.prepare(`
        UPDATE historical_datasets
        SET
          candle_count = ?,
          updated_at = ?
        WHERE id = ?
          AND user_id = ?
          AND status = 'pending'
      `).bind(
        totalCandles,
        new Date().toISOString(),
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
        status = 'completed',
        updated_at = ?
      WHERE id = ?
        AND user_id = ?
        AND status = 'pending'
    `).bind(
      totalCandles,
      now,
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
        id,
        symbol,
        timeframe,
        source,
        expected_candles,
        candle_count,
        status,
        created_at,
        updated_at
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
}/* HISTORICAL DATA ROUTES */

if (path.startsWith("/api/historical/")) {
  const user = await getAuthenticatedUser(request, env);

  if (!user) {
    return json({
      ok: false,
      error: "Authentication required"
    }, 401);
  }

  const entitlement = await getSubscriptionEntitlement(env, user);

  if (!entitlement.active) {
    return paymentRequiredResponse(entitlement);
  }

  return await handleHistoricalData(
    request,
    env,
    url,
    user
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
