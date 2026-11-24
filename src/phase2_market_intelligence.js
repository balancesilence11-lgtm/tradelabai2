/*
 * TradeLab AI - Phase 2 Market Intelligence module
 *
 * Cloudflare Worker module. Keep this file beside worker.js.
 * Required Worker bindings/secrets:
 *   - DB: Cloudflare D1 database
 *   - FINNHUB_API_KEY: Worker secret
 *
 * Required D1 migration:
 *   CREATE TABLE IF NOT EXISTS market_intelligence_cache (
 *     cache_key TEXT PRIMARY KEY NOT NULL,
 *     payload TEXT NOT NULL,
 *     expires_at TEXT NOT NULL,
 *     updated_at TEXT NOT NULL
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_market_intelligence_cache_expiry
 *     ON market_intelligence_cache(expires_at);
 *
 * Routes are dispatched from worker.js after authentication:
 *   return await handleMarketIntelligence(request, env, url);
 */

const MI_ALLOWED_METHODS = new Set(["GET", "POST"]);
const MI_CACHE_TTL_SECONDS = 300;
const MI_FETCH_TIMEOUT_MS = 12000;
const MI_FINNHUB_BASE = "https://finnhub.io/api/v1";

function miJson(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

function miText(value, maxLength = 100) {
  return String(value ?? "").trim().replace(/[^\w\s./:+-]/g, "").slice(0, maxLength);
}

function miSymbol(value) {
  const raw = miText(value || "EURUSD", 20).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const supported = new Set([
    "EURUSD", "GBPUSD", "USDJPY", "USDCHF", "USDCAD", "AUDUSD",
    "NZDUSD", "EURGBP", "EURJPY", "GBPJPY", "AUDJPY", "EURAUD",
    "GBPAUD", "XAUUSD", "BTCUSD"
  ]);
  return supported.has(raw) ? raw : "EURUSD";
}

function miDate(value, fallback) {
  const candidate = miText(value || fallback, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : fallback;
}

async function miReadCache(env, key) {
  if (!env?.DB) return null;
  try {
    const row = await env.DB.prepare(
      "SELECT payload, expires_at FROM market_intelligence_cache WHERE cache_key = ?"
    ).bind(key).first();
    if (!row || !row.payload || !row.expires_at) return null;
    if (Date.parse(row.expires_at) <= Date.now()) return null;
    return JSON.parse(row.payload);
  } catch (error) {
    console.warn("Market intelligence cache read skipped:", error?.message || error);
    return null;
  }
}

async function miWriteCache(env, key, value) {
  if (!env?.DB) return;
  try {
    const now = new Date();
    const expires = new Date(now.getTime() + MI_CACHE_TTL_SECONDS * 1000);
    await env.DB.prepare(`
      INSERT INTO market_intelligence_cache (cache_key, payload, expires_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload = excluded.payload,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
    `).bind(key, JSON.stringify(value), expires.toISOString(), now.toISOString()).run();
  } catch (error) {
    // Cache failures must never make market intelligence unavailable.
    console.warn("Market intelligence cache write skipped:", error?.message || error);
  }
}

async function miFinnhub(path, env) {
  const apiKey = env?.FINNHUB_API_KEY;
  if (!apiKey) {
    const error = new Error("Finnhub is not configured. Add FINNHUB_API_KEY as a Cloudflare Worker secret.");
    error.status = 503;
    throw error;
  }

  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(
    `${MI_FINNHUB_BASE}${path}${separator}token=${encodeURIComponent(apiKey)}`,
    { signal: AbortSignal.timeout(MI_FETCH_TIMEOUT_MS) }
  );

  if (!response.ok) {
    const error = new Error(`Finnhub request failed with status ${response.status}.`);
    error.status = response.status === 429 ? 503 : 502;
    throw error;
  }
  return response.json();
}

async function miNews(url, env) {
  const symbol = miSymbol(url.searchParams.get("symbol"));
  const cacheKey = `news:${symbol}`;
  const cached = await miReadCache(env, cacheKey);
  if (cached) return { ...cached, cached: true };

  // Finnhub's general news feed is used because its news endpoint does not
  // provide a reliable direct mapping for every supported FX/CFD symbol.
  const raw = await miFinnhub("/news?category=general", env);
  const articles = (Array.isArray(raw) ? raw : [])
    .slice(0, 100)
    .map(item => ({
      id: item.id ?? null,
      headline: miText(item.headline, 300),
      summary: miText(item.summary, 1200),
      source: miText(item.source, 100),
      url: typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url : null,
      image: typeof item.image === "string" && /^https?:\/\//i.test(item.image) ? item.image : null,
      datetime: Number(item.datetime) || null,
      category: miText(item.category, 80),
      related: miText(item.related, 200)
    }))
    .filter(item => item.headline);

  const result = {
    ok: true,
    provider: "Finnhub",
    symbol,
    note: "General market headlines. Relevance to the selected instrument may vary.",
    count: articles.length,
    articles,
    generatedAt: new Date().toISOString(),
    cached: false
  };
  await miWriteCache(env, cacheKey, result);
  return result;
}

async function miCalendar(url, env) {
  const today = new Date().toISOString().slice(0, 10);
  const from = miDate(url.searchParams.get("from"), today);
  const defaultTo = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const to = miDate(url.searchParams.get("to"), defaultTo);

  if (from > to) {
    const error = new Error("'from' date must be on or before 'to' date.");
    error.status = 400;
    throw error;
  }

  const cacheKey = `calendar:${from}:${to}`;
  const cached = await miReadCache(env, cacheKey);
  if (cached) return { ...cached, cached: true };

  const raw = await miFinnhub(
    `/calendar/economic?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    env
  );
  const events = Array.isArray(raw?.economicCalendar)
    ? raw.economicCalendar.map(item => ({
        country: miText(item.country, 80),
        event: miText(item.event, 240),
        impact: miText(item.impact, 40),
        actual: item.actual ?? null,
        estimate: item.estimate ?? null,
        prev: item.prev ?? null,
        unit: miText(item.unit, 30),
        time: miText(item.time, 40),
        date: miText(item.date, 10),
        source: "Finnhub"
      }))
    : [];

  const result = {
    ok: true,
    provider: "Finnhub",
    from,
    to,
    count: events.length,
    events,
    generatedAt: new Date().toISOString(),
    cached: false
  };
  await miWriteCache(env, cacheKey, result);
  return result;
}

async function miBrief(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return miJson({ ok: false, error: "Invalid JSON request body." }, 400);
  }

  const symbol = miSymbol(body?.symbol);
  const timeframe = miText(body?.timeframe || "1h", 12);
  const candles = Array.isArray(body?.candles) ? body.candles.slice(-100) : [];

  if (candles.length < 5) {
    return miJson({ ok: false, error: "At least five recent candles are required for contextual analysis." }, 400);
  }

  const valid = candles.map(c => ({
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume) || 0
  })).filter(c =>
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.high >= c.low &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );

  if (valid.length < 5) {
    return miJson({ ok: false, error: "Insufficient valid candle data." }, 400);
  }

  const last = valid.at(-1);
  const first = valid[0];
  const closes = valid.map(c => c.close);
  const changePct = first.close ? ((last.close - first.close) / first.close) * 100 : 0;
  const shortMean = closes.slice(-5).reduce((a, b) => a + b, 0) / Math.min(5, closes.length);
  const longMean = closes.reduce((a, b) => a + b, 0) / closes.length;
  const rangeHigh = Math.max(...valid.map(c => c.high));
  const rangeLow = Math.min(...valid.map(c => c.low));

  let score = 0;
  if (shortMean > longMean) score += 25;
  else if (shortMean < longMean) score -= 25;

  if (changePct > 0.15) score += 25;
  else if (changePct < -0.15) score -= 25;

  if (last.close > valid.at(-2).close) score += 15;
  else if (last.close < valid.at(-2).close) score -= 15;

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
    metrics: {
      changePercent: Number(changePct.toFixed(4)),
      shortMean,
      sampleMean: longMean,
      rangeHigh,
      rangeLow,
      lastClose: last.close,
      candlesAnalyzed: valid.length
    },
    interpretation: direction === "NEUTRAL"
      ? "Mixed or insufficient directional confluence; wait for confirmation."
      : `${direction} bias from the supplied candle sample; this is not a guaranteed trading signal.`,
    riskNotice: "Analytical information only. Not financial advice and not an instruction to place a trade.",
    generatedAt: new Date().toISOString()
  });
}

export async function handleMarketIntelligence(request, env, url) {
  if (!MI_ALLOWED_METHODS.has(request.method)) {
    return miJson({ ok: false, error: "Method not allowed." }, 405, { Allow: "GET, POST" });
  }

  try {
    if (url.pathname === "/api/market-intelligence/news" && request.method === "GET") {
      return miJson(await miNews(url, env));
    }
    if (url.pathname === "/api/market-intelligence/calendar" && request.method === "GET") {
      return miJson(await miCalendar(url, env));
    }
    if (url.pathname === "/api/market-intelligence/brief" && request.method === "POST") {
      return await miBrief(request, env);
    }
    return miJson({ ok: false, error: "Market intelligence endpoint not found." }, 404);
  } catch (error) {
    console.error("Market intelligence request failed:", error?.message || error);
    return miJson(
      { ok: false, error: error?.message || "Market intelligence provider unavailable." },
      error?.status || 502
    );
  }
}
