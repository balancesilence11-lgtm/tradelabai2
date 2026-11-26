import test from 'node:test';
import assert from 'node:assert/strict';
import { runHistoricalBacktest } from '../src/backtesting.js';

const asOf = Date.parse('2026-11-26T12:30:00Z');
const buy = { id: 'b1', symbol: 'EURUSD', timeframe: '5min', signal: 'BUY', entry: 1.1,
  stop_loss: 1.09, take_profit_json: '[1.12]', generated_at: '2026-11-26T12:00:00Z' };
const sell = { id: 's1', symbol: 'EURUSD', timeframe: '5min', signal: 'SELL', entry: 1.1,
  stop_loss: 1.11, take_profit_json: '[1.08]', generated_at: '2026-11-26T12:00:00Z' };

test('resolves a BUY TP1 hit chronologically and computes R from actual target distance', () => {
  const result = runHistoricalBacktest([buy], [
    { time: '2026-11-26T12:00:00Z', high: 1.13, low: 1.08 },
    { time: '2026-11-26T12:05:00Z', high: 1.121, low: 1.095 }
  ], { asOf });
  assert.equal(result.results[0].outcome, 'WIN');
  assert.equal(result.results[0].grossR, 2);
  assert.equal(result.metrics.expectancyR, 2);
});

test('resolves SELL stop-loss correctly', () => {
  const result = runHistoricalBacktest([sell], [{ time: '2026-11-26T12:05:00Z', high: 1.112, low: 1.09 }], { asOf });
  assert.equal(result.results[0].outcome, 'LOSS');
  assert.equal(result.results[0].netR, -1);
});

test('excludes same-candle stop and target touches as ambiguous', () => {
  const result = runHistoricalBacktest([buy], [{ time: '2026-11-26T12:05:00Z', high: 1.13, low: 1.08 }], { asOf });
  assert.equal(result.metrics.ambiguous, 1);
  assert.equal(result.metrics.resolved, 0);
});

test('ignores candles at signal time and candles that have not fully closed', () => {
  const result = runHistoricalBacktest([buy], [
    { time: '2026-11-26T12:00:00Z', high: 1.13, low: 1.08 },
    { time: '2026-11-26T12:25:00Z', high: 1.13, low: 1.08 }
  ], { asOf: Date.parse('2026-11-26T12:29:00Z') });
  assert.equal(result.metrics.unresolved, 1);
});

test('applies round-trip costs to net R and reports profit factor and drawdown', () => {
  const result = runHistoricalBacktest([buy, sell], [
    { time: '2026-11-26T12:05:00Z', high: 1.121, low: 1.095 },
    { time: '2026-11-26T12:10:00Z', high: 1.112, low: 1.07 }
  ], { asOf, costR: 0.1 });
  assert.equal(result.metrics.netR, 0.8);
  assert.equal(result.metrics.profitFactor, 1.7273);
  assert.equal(result.metrics.maxDrawdownR, 1.1);
});

test('rejects malformed signal geometry instead of scoring it', () => {
  const result = runHistoricalBacktest([{ ...buy, stop_loss: 1.101 }], [], { asOf });
  assert.equal(result.metrics.invalid, 1);
});
