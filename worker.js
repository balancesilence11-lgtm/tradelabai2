const SYMBOLS = {
EURUSD: "EUR/USD",
GBPUSD: "GBP/USD",
USDJPY: "USD/JPY",
XAUUSD: "XAU/USD",
BTCUSD: "BTC/USD"
};

const ALLOWED_INTERVALS = [
"1min",
"5min",
"15min",
"30min",
"1h",
"4h",
"1day"
];

export default {
async fetch(request, env) {
const url = new URL(request.url);
// Health check
if (url.pathname === "/api/health") {
  return Response.json({
    ok: true,
    service: "TradeLab AI market-data proxy",
    status: "running"
  });
}

// Validate request method
if (
  url.pathname === "/api/market" ||
  url.pathname === "/api/candles"
) {
  if (request.method !== "GET") {
    return Response.json(
      { error: "Method not allowed" },
      { status: 405 }
    );
  }

  // Read and validate symbol
  const symbol = url.searchParams
    .get("symbol")
    ?.toUpperCase()
    .replace("/", "");

  const providerSymbol = SYMBOLS[symbol];

  if (!providerSymbol) {
    return Response.json(
      { error: "Unsupported symbol" },
      { status: 400 }
    );
  }

  // Confirm API key exists
  if (!env.TWELVE_DATA_API_KEY) {
    return Response.json(
      { error: "Market data API is not configured" },
      { status: 500 }
    );
  }

  // Latest market price endpoint
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
        return Response.json(
          {
            error: "Twelve Data rejected the request",
            details: data.message || "No price returned"
          },
          { status: 502 }
        );
      }

      return Response.json({
        ok: true,
        symbol,
        providerSymbol,
        price: Number(data.price),
        source: "Twelve Data",
        timestamp: new Date().toISOString()
      }, {
        headers: {
          "Cache-Control": "no-store"
        }
      });

    } catch (error) {
      console.error("Market data error:", error.message);

      return Response.json(
        {
          error: "Unable to retrieve market data",
          details: error.message
        },
        { status: 502 }
      );
    }
  }

  // Historical candlestick endpoint
  if (url.pathname === "/api/candles") {
    const interval = url.searchParams.get("interval") || "5min";

    if (!ALLOWED_INTERVALS.includes(interval)) {
      return Response.json(
        {
          error: "Unsupported interval",
          allowedIntervals: ALLOWED_INTERVALS
        },
        { status: 400 }
      );
    }

    const requestedOutputsize = Number(
      url.searchParams.get("outputsize") || 100
    );

    const outputsize = Math.min(
      500,
      Math.max(
        1,
        Number.isFinite(requestedOutputsize)
          ? Math.floor(requestedOutputsize)
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
        !data.values ||
        !Array.isArray(data.values)
      ) {
        return Response.json(
          {
            error: "Unable to retrieve historical market data",
            details: data.message || "No candle data returned"
          },
          { status: 502 }
        );
      }

      const candles = data.values
        .map((item) => ({
          time: item.datetime,
          open: Number(item.open),
          high: Number(item.high),
          low: Number(item.low),
          close: Number(item.close),
          volume: Number(item.volume || 0)
        }))
        .filter((candle) =>
          candle.time &&
          Number.isFinite(candle.open) &&
          Number.isFinite(candle.high) &&
          Number.isFinite(candle.low) &&
          Number.isFinite(candle.close)
        )
        .reverse();

      return Response.json({
        ok: true,
        symbol,
        providerSymbol,
        interval,
        count: candles.length,
        candles,
        source: "Twelve Data",
        timestamp: new Date().toISOString()
      }, {
        headers: {
          "Cache-Control": "no-store"
        }
      });

    } catch (error) {
      console.error("Candlestick data error:", error.message);

      return Response.json(
        {
          error: "Unable to retrieve candlestick data",
          details: error.message
        },
        { status: 502 }
      );
    }
  }
}

// Serve the TradeLab AI frontend
return env.ASSETS.fetch(request);
}
};
