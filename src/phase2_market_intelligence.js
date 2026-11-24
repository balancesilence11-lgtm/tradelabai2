import { handleMarketIntelligence } from "./phase2_market_intelligence.js";
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

export async function handleMarketIntelligence(request, env, url) {
  if (!MI_ALLOWED_METHODS.has(request.method)) return miJson({ ok: false, error: "Method not allowed." }, 405, { Allow: "GET, POST" });
  try {
    if (url.pathname === "/api/market-intelligence/news" && request.method === "GET") return miJson(await miNews(url, env));
    if (url.pathname === "/api/market-intelligence/calendar" && request.method === "GET") return miJson(await miCalendar(url, env));
    if (url.pathname === "/api/market-intelligence/brief" && request.method === "POST") return await miBrief(request, env);
    return miJson({ ok: false, error: "Market intelligence endpoint not found." }, 404);
  } catch (error) {
    console.error("Market intelligence request failed:", error?.message || error);
    return miJson({ ok: false, error: error?.message || "Market intelligence provider unavailable." }, error?.status || 502);
  }
}
