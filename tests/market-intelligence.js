import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMarketIntelligence, buildMarketIntelligenceExplanation } from '../src/market-intelligence.js';

function candles({ volumeType = 'tick_volume', current = null } = {}) {
  const rows = Array.from({ length: 24 }, (_, i) => {
    const close = 100 + i * 0.05;
    return { open: close - 0.04, high: close + 0.3, low: close - 0.3, close, [volumeType]: 100 };
  });
  if (current) rows[rows.length - 1] = { ...current, [volumeType]: current.volume ?? 180 };
  return rows;
}

test('integrated intelligence reports pressure and volume source', () => {
  const result = analyzeMarketIntelligence(candles());
  assert.equal(result.ready, true);
  assert.equal(result.pressure.ready, true);
  assert.equal(result.volumeSource, 'broker tick volume');
  assert.ok(result.pressure.buyPressure + result.pressure.sellPressure >= 99);
});

test('missing volume does not create volume pressure', () => {
  const rows = Array.from({ length: 24 }, (_, i) => ({ open: 100, high: 101, low: 99, close: 100.5 + i * 0.01 }));
  const result = analyzeMarketIntelligence(rows);
  assert.equal(result.pressure.ready, false);
  assert.equal(result.pressure.direction, 0);
});

test('insufficient history returns safe unavailable outputs', () => {
  const result = analyzeMarketIntelligence([{ open: 1, high: 2, low: 0.5, close: 1.5 }]);
  assert.equal(result.ready, false);
  assert.equal(result.zones.demand, null);
});

test('explanation explicitly gates WAIT setups', () => {
  const intelligence = analyzeMarketIntelligence(candles());
  const explanation = buildMarketIntelligenceExplanation({ direction: 'WAIT', intelligence });
  assert.match(explanation, /wait for a completed-candle confirmation/i);
});
