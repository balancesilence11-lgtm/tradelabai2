/*
 * TradeLab AI - Phase 2 Market Intelligence module
 * Cloudflare Worker module. Keep this file beside worker.js.
 * Required bindings/secrets:
 *   - DB: Cloudflare D1 database (optional for caching; requests still work without it)
 *   - FINNHUB_API_KEY: Worker secret (Market News only)
 *
 * Economic Calendar: ShowMyTrades public calendar API (free, no API key).
 * Documentation: https://showmytrades.com/docs/api/economic-calendar
 * Display attribution: Economic calendar by ShowMyTrades
 *
 * Routes are dispatched from worker.js after authentication:
 *   return await handleMarketIntelligence(request, env, url);
 */

const MI_ALLOWED_METHODS = new Set(["GET", "POST"]);
const MI_CACHE_TTL_SECONDS = 300;
const MI_FETCH_TIMEOUT_MS = 12000;
const MI_FINNHUB_BASE = "https://finnhub.io/api/v1";
const MI_CALENDAR_URL = "https://showmytrades.com/api/public/calendar/v1";
const MI_CALENDAR_ATTRIBUTION_URL = "https://showmytrades.com/tools/economic-calendar";

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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return fallback;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate
    ? fallback
    : candidate;
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

async function miFetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(MI_FETCH_TIMEOUT_MS),
    headers: { Accept: "application/json", ...(options.headers || {}) }
  });

  if (response.status === 304) return { notModified: true, data: null };

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const error = new Error("The market-data provider returned an invalid JSON response.");
    error.status = 502;
    throw error;
  }

  if (!response.ok) {
    const detail = miText(data?.error || data?.message || response.statusText, 180);
    const error = new Error(`Market data provider request failed (${response.status})${detail ? `: ${detail}` : "."}`);
    error.status = response.status === 429 ? 503 : 502;
    throw error;
  }

  return { notModified: false, data };
}

async function miFinnhub(path, env) {
  const apiKey = env?.FINNHUB_API_KEY;
  if (!apiKey) {
    const error = new Error("Finnhub is not configured. Add FINNHUB_API_KEY as a Cloudflare Worker secret.");
    error.status = 503;
    throw error;
  }

  const separator = path.includes("?") ? "&" : "?";
  const result = await miFetchJson(
    `${MI_FINNHUB_BASE}${path}${separator}token=${encodeURIComponent(apiKey)}`
  );
  return result.data;
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

function miCurrencyCountry(currency) {
  const countries = {
    USD: "United States",
    EUR: "Eurozone",
    GBP: "United Kingdom",
    JPY: "Japan",
    AUD: "Australia",
    NZD: "New Zealand",
    CAD: "Canada",
    CHF: "Switzerland",
    CNY: "China"
  };
  return countries[currency] || currency || "—";
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

  const now = Date.now();
  const fromTime = Date.parse(`${from}T00:00:00.000Z`);
  const toTime = Date.parse(`${to}T23:59:59.999Z`);
  const earliestSupported = now - 6 * 60 * 60 * 1000;
  if (toTime < earliestSupported) {
    return {
      ok: true,
      provider: "ShowMyTrades",
      from,
      to,
      count: 0,
      events: [],
      generatedAt: new Date().toISOString(),
      cached: false,
      note: "The public calendar API provides upcoming events and only the previous six hours."
    };
  }

  const days = Math.max(1, Math.min(30, Math.ceil((toTime - now) / 86400000)));
  if (toTime > now + 30 * 86400000 + 86400000) {
    const error = new Error("The free economic calendar supports a maximum window of 30 days ahead.");
    error.status = 400;
    throw error;
  }

  const cacheKey = `calendar:showmytrades:${from}:${to}`;
  const cached = await miReadCache(env, cacheKey);
  if (cached) return { ...cached, cached: true };

  const providerUrl = new URL(MI_CALENDAR_URL);
  providerUrl.searchParams.set("impact", "all");
  providerUrl.searchParams.set("days", String(days));

  const { data: raw } = await miFetchJson(providerUrl.toString());
  const sourceEvents = Array.isArray(raw?.events) ? raw.events : [];
  const events = sourceEvents
    .filter(item => {
      const timestamp = Number(item.ts) * 1000;
      return Number.isFinite(timestamp) && timestamp >= fromTime && timestamp <= toTime;
    })
    .map(item => {
      const isoTime = typeof item.time === "string" ? item.time : "";
      const parsedTime = isoTime ? new Date(isoTime) : new Date(Number(item.ts) * 1000);
      const validTime = !Number.isNaN(parsedTime.getTime());
      const currency = miText(item.currency, 3).toUpperCase();
      const impact = miText(item.impact, 20).toLowerCase();
      return {
        id: miText(item.id, 160) || `${currency}-${Number(item.ts)}`,
        country: miCurrencyCountry(currency),
        currency,
        event: miText(item.title, 240),
        impact: impact ? impact.charAt(0).toUpperCase() + impact.slice(1) : "Unknown",
        actual: item.actual ?? null,
        estimate: item.forecast ?? null,
        prev: item.previous ?? null,
        unit: "",
        date: validTime ? parsedTime.toISOString().slice(0, 10) : "",
        time: validTime ? `${parsedTime.toISOString().slice(11, 16)} UTC` : "Time not supplied",
        eventTime: validTime ? parsedTime.toISOString() : null,
        status: miText(item.status, 30),
        confidence: miText(item.confidence, 40),
        source: "ShowMyTrades"
      };
    })
    .filter(item => item.event)
    .sort((a, b) => new Date(a.eventTime).getTime() - new Date(b.eventTime).getTime());

  const result = {
    ok: true,
    provider: "ShowMyTrades",
    from,
    to,
    count: events.length,
    events,
    generatedAt: new Date().toISOString(),
    cached: false,
    attribution: {
      text: "Economic calendar by ShowMyTrades",
      url: MI_CALENDAR_ATTRIBUTION_URL
    },
    note: "Event times are UTC. Schedules and figures may be revised by their publishers."
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
