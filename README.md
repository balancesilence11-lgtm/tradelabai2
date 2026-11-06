# TradeLab AI — hybrid trading platform foundation

A responsive React/Vite frontend foundation for a personal + multi-user trading workspace.

## Current implementation
- Responsive dashboard and navigation
- Overview, market watch, AI analysis preview, trading ticket preview, trade history, risk controls, broker connections, admin and settings screens
- Clearly labelled illustrative market data and simulated demo balance
- Manual / assisted / automated mode preference UI
- Risk preference slider (UI only; not enforced)
- Deriv and MetaTrader 5 connection placeholders
- Netlify build configuration and health endpoint

## Important: what is not connected
This is a **frontend prototype**, not a live trading system. It does not currently provide real authentication, user database, live market prices, AI-generated signals, broker authorisation, MT5 connectivity, server-side risk enforcement, or order execution. Buttons that would place orders explicitly do not submit trades. Do not use it to make financial decisions.

## Run locally
Requires Node.js 20+.

```bash
npm install
npm run dev
```

## Netlify deployment
- Build command: `npm run build`
- Publish directory: `dist`
- Functions directory: `netlify/functions`

Push the project to the connected GitHub repository and trigger a Netlify deploy. If you replace the repository contents, keep the repository's existing deployment connection.

## Production architecture still required
1. Authentication with verified email, password reset and role-based access.
2. PostgreSQL database with row-level tenant isolation.
3. Server-side API for market data, AI analysis and order routing.
4. Official Deriv authorisation with scoped per-user tokens stored encrypted.
5. MT5 integration through a separately hosted, secured bridge or broker-approved connector.
6. Server-side pre-trade risk checks, idempotency, audit log and emergency kill switch.
7. Demo/paper testing, security review and explicit account-owner consent before any live execution.

Never commit `.env` files, broker passwords, API tokens or other secrets to GitHub. Keep live execution disabled until all production controls have been independently tested.
