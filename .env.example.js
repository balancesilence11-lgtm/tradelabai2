# Server-side secrets are configured in Cloudflare Workers, not in VITE_ variables.
# Required for Phase 2.2 provider-backed market news and economic calendar:
# FINNHUB_API_KEY=<set with: npx wrangler secret put FINNHUB_API_KEY>
# Never commit real API keys, broker tokens, or passwords.
