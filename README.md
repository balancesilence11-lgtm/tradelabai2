# TradeLab AI — rebuild foundation

This is the first rebuild foundation for the combined personal + multi-user TradeLab AI platform.

## Included
- Responsive React dashboard for desktop and mobile
- Workspace/navigation foundation
- Market selector and clearly labelled illustrative chart data
- Manual / semi-automatic / automatic mode interface
- Risk-control configuration UI (not yet enforced server-side)
- Broker connection placeholder for Deriv and MetaTrader 5
- Netlify build and a health-check function

## Important status
This is **not a live trading system**. Prices and chart values are illustrative. AI analysis, account balances, order routing, broker authorisation, user authentication, database persistence and server-enforced risk limits are not connected. Live execution is intentionally disabled.

## Run locally
1. Install Node.js 20 or newer.
2. Extract this folder.
3. Run `npm install`.
4. Run `npm run dev`.
5. Open the local address shown by Vite.

## Deploy to Netlify
1. Push this project to a private GitHub repository.
2. In Netlify, import the repository.
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Netlify Functions directory: `netlify/functions`
6. Deploy. The included `netlify.toml` contains these settings.

## Target production architecture
- Frontend: React/Vite on Netlify
- Authentication: managed identity provider (email login, verification, password reset)
- Database: PostgreSQL with row-level tenant isolation
- Backend: authenticated server functions / dedicated service for long-running tasks
- Secrets: server-side environment variables or managed secrets vault only
- Deriv: official OAuth/API authorisation; per-user scoped tokens stored encrypted
- MT5: a separately hosted MT5 bridge/EA or broker-approved integration; never expose terminal credentials in browser code
- AI: server-side analysis service using verified live market data
- Risk: server-side pre-trade validation, per-user limits, idempotent order requests, audit log and kill switch

## Mandatory safety gates before real money
1. Verify live quote source and timestamps.
2. Test each broker connection with read-only permissions first.
3. Validate order size, symbol precision, stop distance and account currency.
4. Enforce per-trade and daily loss limits on the server, not just in the UI.
5. Add per-user isolation and audit trails.
6. Test disconnects, duplicate requests, stale prices and rejected orders.
7. Run demo/paper trading for a sustained period.
8. Enable live execution only after explicit account-owner consent and a successful safety review.

## Suggested initial defaults
- Default account mode: demo
- Default risk per trade: 1% (configurable)
- Default daily loss limit: 3% (configurable)
- Automatic mode: locked until backend controls and demo validation pass

Do not commit `.env` files, API tokens, passwords or broker secrets to GitHub.
