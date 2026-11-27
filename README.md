TradeLab AI — Phase 4.0.5: AI Market Brief

FILES IN THIS PATCH
1. phase2_market_intelligence.js
   - Replaces the root-level Worker module.
   - Keeps Finnhub for Market News only.
   - Keeps the existing free ShowMyTrades public Economic Calendar.
   - Expands POST /api/market-intelligence/brief into a multi-factor quantitative report.
   - Adds explicit US30 symbol support.
   - No new API key, paid provider, D1 migration, or worker.js route change is required.

2. src/main.jsx
   - Replaces the frontend source.
   - Renames the Candle Intelligence tab to AI Market Brief.
   - Displays trend, structure, momentum, volatility, key levels, factor breakdown,
     conditional scenario, and high-impact events expected in the next 48 hours.
   - Keeps Market News and Economic Calendar tabs.

3. tests/market-intelligence-api.test.js
   - Updates the calendar API test to match the already-deployed free ShowMyTrades provider.

4. tests/market-intelligence-brief.test.js
   - Adds tests for the expanded brief, US30 mapping, and candle validation.

GITHUB UPDATE
1. Open the repository.
2. Replace the root-level phase2_market_intelligence.js with this package version.
3. Replace src/main.jsx with this package version.
4. Replace tests/market-intelligence-api.test.js.
5. Add tests/market-intelligence-brief.test.js under the existing tests folder.
6. Commit the changes and let the existing deployment workflow run.

Do NOT replace worker.js. The existing authenticated route already dispatches
/api/market-intelligence/brief to this module.

VALIDATION
- Worker module syntax check passed.
- Frontend JSX parser check passed.
- All 12 focused Market Intelligence tests passed.
- Full test suite: 103 passed, 3 failed. The same 3 paper-backup tests also fail
  against the unmodified Phase 4.0.4 baseline, so they are pre-existing and
  unrelated to this patch.
- A Vite production build was not run in this environment because project
  dependencies/node_modules were not installed.

ANALYSIS LIMITATIONS
- This is a transparent quantitative rules engine, not a paid external AI/LLM.
- At least 20 valid candles are required; up to 250 recent candles are analysed.
- The latest supplied candle may still be forming; confirm with a closed candle.
- Tick volume is not centralized exchange volume for OTC forex/CFD instruments.
- The confluence score is not a win probability.
- The brief is analysis only and does not place orders or issue entry/SL/TP instructions.
