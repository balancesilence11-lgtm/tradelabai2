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
    "GBPAUD", "XAUUSD", "BTCUSD", "US30"
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
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    if (response.ok) {
      const error = new Error("The market-data provider returned an invalid JSON response.");
      error.status = 502;
      throw error;
    }
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

function miMean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function miEMA(values, period) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  }
  return output;
}

function miRSI(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const averageGain = gains / period;
  const averageLoss = losses / period;
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function miATR(candles, period = 14) {
  if (candles.length < 2) return null;
  const trueRanges = candles.slice(1).map((candle, index) => {
    const previousClose = candles[index].close;
    return Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    );
  });
  if (!trueRanges.length) return null;
  return miMean(trueRanges.slice(-period));
}

function miPivotLevels(candles) {
  const sample = candles.slice(-80);
  const highs = [];
  const lows = [];
  for (let index = 2; index < sample.length - 2; index += 1) {
    const current = sample[index];
    const left = sample.slice(index - 2, index);
    const right = sample.slice(index + 1, index + 3);
    if (left.every(item => current.high >= item.high) && right.every(item => current.high > item.high)) {
      highs.push(current.high);
    }
    if (left.every(item => current.low <= item.low) && right.every(item => current.low < item.low)) {
      lows.push(current.low);
    }
  }
  return { highs, lows };
}

function miRound(value, digits = 5) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
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
  const supplied = Array.isArray(body?.candles) ? body.candles.slice(-250) : [];

  if (supplied.length < 20) {
    return miJson({ ok: false, error: "At least 20 recent candles are required for the full market brief. Load more history and try again." }, 400);
  }

  const valid = supplied.map(c => ({
    timestamp: c.timestamp ?? c.time ?? c.datetime ?? null,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.volume ?? c.tick_volume ?? c.tickVolume) || 0
  })).filter(c =>
    [c.open, c.high, c.low, c.close].every(Number.isFinite) &&
    c.open > 0 && c.close > 0 &&
    c.high >= c.low &&
    c.high >= Math.max(c.open, c.close) &&
    c.low <= Math.min(c.open, c.close)
  );

  if (valid.length < 20) {
    return miJson({ ok: false, error: "Fewer than 20 valid OHLC candles were received. Check the selected market and timeframe data." }, 400);
  }

  const closes = valid.map(c => c.close);
  const last = valid[valid.length - 1];
  const previous = valid[valid.length - 2];
  const first = valid[0];
  const changePct = first.close ? ((last.close - first.close) / first.close) * 100 : 0;
  const ema9Series = miEMA(closes, 9);
  const ema21Series = miEMA(closes, 21);
  const ema50Series = miEMA(closes, 50);
  const ema9 = ema9Series.at(-1);
  const ema21 = ema21Series.at(-1);
  const ema50 = ema50Series.at(-1);
  const rsi = miRSI(closes, 14);

  const macdLine = closes.map((_, index) => miEMA(closes.slice(0, index + 1), 12).at(-1) - miEMA(closes.slice(0, index + 1), 26).at(-1));
  const macdSignal = miEMA(macdLine, 9).at(-1);
  const macd = macdLine.at(-1);
  const macdHistogram = macd - macdSignal;

  const atr = miATR(valid, 14);
  const atrSeries = valid.slice(1).map((candle, index) => Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - valid[index].close),
    Math.abs(candle.low - valid[index].close)
  ));
  const atrBaseline = miMean(atrSeries.slice(-40));
  const atrPercent = last.close ? atr / last.close * 100 : 0;
  const volatilityRatio = atrBaseline > 0 ? atr / atrBaseline : 1;
  const volatilityRegime = volatilityRatio > 1.35 ? "EXPANDING" : volatilityRatio < 0.75 ? "CONTRACTING" : "NORMAL";

  const pivots = miPivotLevels(valid);
  const supportCandidates = [...pivots.lows, ...valid.slice(-30).map(c => c.low)]
    .filter(value => value < last.close).sort((a, b) => b - a);
  const resistanceCandidates = [...pivots.highs, ...valid.slice(-30).map(c => c.high)]
    .filter(value => value > last.close).sort((a, b) => a - b);
  const support = supportCandidates[0] ?? Math.min(...valid.slice(-20).map(c => c.low));
  const resistance = resistanceCandidates[0] ?? Math.max(...valid.slice(-20).map(c => c.high));

  const recentHighs = pivots.highs.slice(-2);
  const recentLows = pivots.lows.slice(-2);
  let structure = "RANGE / UNCONFIRMED";
  if (recentHighs.length === 2 && recentLows.length === 2) {
    if (recentHighs[1] > recentHighs[0] && recentLows[1] > recentLows[0]) structure = "HIGHER HIGHS / HIGHER LOWS";
    else if (recentHighs[1] < recentHighs[0] && recentLows[1] < recentLows[0]) structure = "LOWER HIGHS / LOWER LOWS";
  }

  const priorWindow = valid.slice(-21, -1);
  const priorHigh = Math.max(...priorWindow.map(c => c.high));
  const priorLow = Math.min(...priorWindow.map(c => c.low));
  let liquiditySweep = "NONE DETECTED";
  if (last.high > priorHigh && last.close < priorHigh) liquiditySweep = "BUY-SIDE LIQUIDITY SWEEP";
  else if (last.low < priorLow && last.close > priorLow) liquiditySweep = "SELL-SIDE LIQUIDITY SWEEP";

  const candleRange = Math.max(last.high - last.low, Number.EPSILON);
  const candleBody = Math.abs(last.close - last.open);
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;
  const previousBody = Math.abs(previous.close - previous.open);
  let candlePattern = "NO CLEAR PATTERN";
  if (last.close > last.open && previous.close < previous.open && last.open <= previous.close && last.close >= previous.open) candlePattern = "BULLISH ENGULFING";
  else if (last.close < last.open && previous.close > previous.open && last.open >= previous.close && last.close <= previous.open) candlePattern = "BEARISH ENGULFING";
  else if (candleBody / candleRange < 0.1) candlePattern = "DOJI / INDECISION";
  else if (lowerWick > candleBody * 2 && upperWick <= candleBody) candlePattern = "HAMMER / LOWER-WICK REJECTION";
  else if (upperWick > candleBody * 2 && lowerWick <= candleBody) candlePattern = "SHOOTING STAR / UPPER-WICK REJECTION";

  const volumeValues = valid.slice(-21).map(c => c.volume).filter(value => value > 0);
  const averageVolume = volumeValues.length > 1 ? miMean(volumeValues.slice(0, -1)) : null;
  const volumeRatio = averageVolume > 0 && last.volume > 0 ? last.volume / averageVolume : null;
  const volumeStatus = volumeRatio == null ? "UNAVAILABLE" : volumeRatio >= 1.5 ? "ABOVE AVERAGE" : volumeRatio <= 0.65 ? "BELOW AVERAGE" : "NEAR AVERAGE";

  let score = 0;
  const factors = [];
  if (last.close > ema21 && ema9 > ema21 && ema21 > ema50) {
    score += 25; factors.push({ name: "EMA trend alignment", bias: "BULLISH", weight: 25 });
  } else if (last.close < ema21 && ema9 < ema21 && ema21 < ema50) {
    score -= 25; factors.push({ name: "EMA trend alignment", bias: "BEARISH", weight: -25 });
  } else if (last.close > ema21) {
    score += 12; factors.push({ name: "EMA trend alignment", bias: "MILDLY BULLISH", weight: 12 });
  } else if (last.close < ema21) {
    score -= 12; factors.push({ name: "EMA trend alignment", bias: "MILDLY BEARISH", weight: -12 });
  } else factors.push({ name: "EMA trend alignment", bias: "NEUTRAL", weight: 0 });

  if (rsi != null && rsi >= 55 && rsi < 75) {
    score += 15; factors.push({ name: "RSI momentum", bias: "BULLISH", weight: 15 });
  } else if (rsi != null && rsi <= 45 && rsi > 25) {
    score -= 15; factors.push({ name: "RSI momentum", bias: "BEARISH", weight: -15 });
  } else if (rsi != null && rsi >= 75) {
    factors.push({ name: "RSI momentum", bias: "OVERBOUGHT", weight: 0 });
  } else if (rsi != null && rsi <= 25) {
    factors.push({ name: "RSI momentum", bias: "OVERSOLD", weight: 0 });
  } else factors.push({ name: "RSI momentum", bias: "NEUTRAL", weight: 0 });

  if (macdHistogram > 0) {
    score += 15; factors.push({ name: "MACD momentum", bias: "BULLISH", weight: 15 });
  } else if (macdHistogram < 0) {
    score -= 15; factors.push({ name: "MACD momentum", bias: "BEARISH", weight: -15 });
  } else factors.push({ name: "MACD momentum", bias: "NEUTRAL", weight: 0 });

  if (structure === "HIGHER HIGHS / HIGHER LOWS") {
    score += 20; factors.push({ name: "Swing structure", bias: "BULLISH", weight: 20 });
  } else if (structure === "LOWER HIGHS / LOWER LOWS") {
    score -= 20; factors.push({ name: "Swing structure", bias: "BEARISH", weight: -20 });
  } else factors.push({ name: "Swing structure", bias: "UNCONFIRMED", weight: 0 });

  if (volumeRatio != null && volumeRatio >= 1.5 && last.close > last.open) {
    score += 5; factors.push({ name: "Tick-volume confirmation", bias: "BULLISH", weight: 5 });
  } else if (volumeRatio != null && volumeRatio >= 1.5 && last.close < last.open) {
    score -= 5; factors.push({ name: "Tick-volume confirmation", bias: "BEARISH", weight: -5 });
  } else factors.push({ name: "Tick-volume confirmation", bias: volumeStatus, weight: 0 });

  if (liquiditySweep === "SELL-SIDE LIQUIDITY SWEEP") score += 10;
  else if (liquiditySweep === "BUY-SIDE LIQUIDITY SWEEP") score -= 10;

  score = Math.max(-100, Math.min(100, score));
  const direction = score >= 25 ? "BULLISH" : score <= -25 ? "BEARISH" : "NEUTRAL";
  const directionalFactors = factors.filter(item => item.weight !== 0).length;
  const alignedFactors = factors.filter(item => direction === "BULLISH" ? item.weight > 0 : direction === "BEARISH" ? item.weight < 0 : false).length;
  const quality = Math.min(95, Math.round(35 + Math.min(35, valid.length / 250 * 35) + directionalFactors * 4 + (valid.length >= 50 ? 5 : 0)));

  const scenario = direction === "BULLISH"
    ? `Bullish continuation requires price to hold above ${miRound(support, 5)} and confirm acceptance above ${miRound(resistance, 5)}. A close back below support weakens this scenario.`
    : direction === "BEARISH"
      ? `Bearish continuation requires price to remain below ${miRound(resistance, 5)} and confirm acceptance below ${miRound(support, 5)}. A close back above resistance weakens this scenario.`
      : `Price is not showing strong directional alignment. Watch for a decisive break and retest of ${miRound(resistance, 5)} or ${miRound(support, 5)} before assigning directional bias.`;

  const interpretation = direction === "NEUTRAL"
    ? "The measured factors are mixed. Treat the current market as neutral until price structure and momentum align."
    : `${direction} directional bias from the measured EMA, momentum, structure and volume factors. This is a market-context assessment, not a prediction or trade instruction.`;

  return miJson({
    ok: true,
    provider: "TradeLab quantitative analysis engine",
    source: "User-supplied MT5 / platform candle history",
    dataStatus: "ANALYSIS_OF_SUPPLIED_CANDLES_ONLY",
    symbol,
    timeframe,
    direction,
    confluenceScore: score,
    quality,
    qualityLabel: "DATA AND FACTOR COVERAGE — NOT WIN PROBABILITY",
    factorAgreement: { aligned: alignedFactors, measured: factors.length },
    factors,
    metrics: {
      changePercent: miRound(changePct, 4),
      lastClose: miRound(last.close, 5),
      candlesAnalyzed: valid.length,
      rangeHigh: miRound(Math.max(...valid.map(c => c.high)), 5),
      rangeLow: miRound(Math.min(...valid.map(c => c.low)), 5),
      ema9: miRound(ema9, 5),
      ema21: miRound(ema21, 5),
      ema50: miRound(ema50, 5),
      rsi14: miRound(rsi, 2),
      macd: miRound(macd, 6),
      macdSignal: miRound(macdSignal, 6),
      macdHistogram: miRound(macdHistogram, 6),
      atr14: miRound(atr, 5),
      atrPercent: miRound(atrPercent, 3),
      volatilityRatio: miRound(volatilityRatio, 2),
      volatilityRegime,
      averageTickVolume: miRound(averageVolume, 2),
      latestTickVolume: miRound(last.volume, 2),
      tickVolumeRatio: miRound(volumeRatio, 2),
      volumeStatus
    },
    marketStructure: structure,
    liquiditySweep,
    candlePattern,
    levels: {
      nearestSupport: miRound(support, 5),
      nearestResistance: miRound(resistance, 5),
      prior20High: miRound(priorHigh, 5),
      prior20Low: miRound(priorLow, 5)
    },
    scenario,
    interpretation,
    limitations: [
      "The latest supplied candle may still be forming; confirm signals on a closed candle.",
      "Tick volume is not centralized exchange volume for OTC forex and CFD instruments.",
      "Support, resistance and liquidity references are calculated from the supplied candle sample only.",
      "No spread, slippage, commissions, financing or broker execution costs are included."
    ],
    riskNotice: "Analysis only. No entry, stop-loss or take-profit order is issued. This is not a guaranteed signal or financial advice.",
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
