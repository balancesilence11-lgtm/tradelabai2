const SYMBOLS = {
  EURUSD: "EUR/USD",
  GBPUSD: "GBP/USD",
  USDJPY: "USD/JPY",
  XAUUSD: "XAU/USD",
  BTCUSD: "BTC/USD"
};

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

    // Market data endpoint
    if (url.pathname === "/api/market") {
      if (request.method !== "GET") {
        return Response.json(
          { error: "Method not allowed" },
          { status: 405 }
        );
      }

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

      if (!env.TWELVE_DATA_API_KEY) {
        return Response.json(
          { error: "Market data API is not configured" },
          { status: 500 }
        );
      }

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
          return Response.json({
            error: "Twelve Data rejected the request",
            details: data.message || "No price returned"
          }, { status: 502 });
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
        console.error("Twelve Data error:", error.message);

        return Response.json({
          error: "Unable to retrieve market data",
          details: error.message
        }, { status: 502 });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
