# TradeLab AI — trading analysis platform foundation

Responsive React/Vite trading workspace with a Cloudflare Worker API proxy.

## Phase 2: Twelve Data market feed
- Added a server-side Cloudflare Worker endpoint at `/api/market`.
- The Worker reads `TWELVE_DATA_API_KEY` from a Cloudflare secret; the key is never sent to the browser.
- Supported instruments in this integration: EUR/USD, GBP/USD, USD/JPY and XAU/USD, subject to Twelve Data account entitlement and provider symbol availability.
- Supported chart intervals: 15 minutes, 1 hour, 4 hours and 1 day.
- Chart data refreshes every five minutes and is cached at the Worker for 30 seconds.
- US30 remains illustrative because it is not enabled in this initial provider integration.
- If the provider request fails, the dashboard clearly falls back to illustrative data and displays the reason.

## Current implementation
- Responsive dashboard and navigation.
- Overview, market watch, AI analysis preview, trading ticket preview, trade history, risk controls, broker connections, admin and settings screens.
- Interactive chart with optional 8-period moving average.
- Manual / assisted / automated mode preference UI.
- Risk preference slider (UI only; not enforced).
- Deriv and MetaTrader 5 connection placeholders.

## Cloudflare configuration
The project uses `wrangler.jsonc`, `worker.js` and the `ASSETS` binding to serve the Vite build while routing `/api/*` requests through the Worker. In the Cloudflare Worker settings, create a **Secret** named exactly `TWELVE_DATA_API_KEY` and set its value to your Twelve Data API key. Do not put the key in `.env`, React code, GitHub, or any public variable.

The configured Worker name is `tradelabai2`. If your Cloudflare project uses a different Worker name, update the `name` field in `wrangler.jsonc` to match.

## Run locally
Requires Node.js 20+.

```bash
npm install
npm run dev
```

The live-data endpoint runs in the deployed Cloudflare Worker. For local development, either run the Worker with Wrangler and configure a local secret, or expect the `/api/market` request to fall back to illustrative data.

## Build and deploy
```bash
npm run build
```

Deploy with Wrangler (after installing dependencies and setting the Worker secret):
```bash
npx wrangler secret put TWELVE_DATA_API_KEY
npx wrangler deploy
```

## Important limitations
This is not a live trading system. Market-data access depends on Twelve Data plan limits, exchange coverage, symbol availability and any applicable licensing. Prices may be delayed depending on the provider subscription. No real authentication, user database, AI-generated signal service, broker authorisation, MT5 connectivity, server-side risk enforcement or order execution is implemented. The trading ticket does not submit orders. US30 is not enabled in this initial market-data proxy. Do not use illustrative fallback figures to make financial decisions.

Never commit API keys, `.env` files, broker passwords or access tokens to GitHub. Keep live execution disabled until authentication, server-side risk checks, audit logging, broker authorisation, demo testing and security review are complete.
