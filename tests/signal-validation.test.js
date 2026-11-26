import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSignalRecord, resolveSignalOutcome } from '../src/signal-validation.js';

const now = Date.parse('2026-11-26T12:00:00.000Z');
const base = { symbol: 'EURUSD', timeframe: '5min', signal: 'BUY', confluence: 72,
  entry: 1.1, stopLoss: 1.09, takeProfit: [1.11, 1.12, 1.13],
  generatedAt: '2026-11-26T11:50:00.000Z' };

test('accepts a valid BUY signal and calculates reward/risk', () => {
  const result = validateSignalRecord(base, { now });
  assert.equal(result.ok, true);
  assert.equal(result.value.rewardRisk, 1);
  assert.equal(result.value.engineId, 'legacy-unspecified');
});

test('rejects BUY stop-loss above entry and reversed targets', () => {
  assert.equal(validateSignalRecord({ ...base, stopLoss: 1.101 }, { now }).ok, false);
  assert.equal(validateSignalRecord({ ...base, takeProfit: [1.11, 1.105] }, { now }).ok, false);
});

test('accepts and preserves the canonical advanced engine identifier', () => {
  const result = validateSignalRecord({ ...base, engineId: 'advanced-client-confluence-v1' }, { now });
  assert.equal(result.ok, true);
  assert.equal(result.value.engineId, 'advanced-client-confluence-v1');
});

test('rejects an unrecognised signal engine identifier', () => {
  assert.equal(validateSignalRecord({ ...base, engineId: 'unknown-engine' }, { now }).ok, false);
});

test('rejects invalid timeframe and future-dated signal', () => {
  assert.equal(validateSignalRecord({ ...base, timeframe: '2min' }, { now }).ok, false);
  assert.equal(validateSignalRecord({ ...base, generatedAt: '2026-11-26T13:00:00.000Z' }, { now }).ok, false);
});

test('resolves only a fully closed candle after signal time', () => {
  const event = { ...base, generated_at: base.generatedAt, stop_loss: base.stopLoss, take_profit_json: JSON.stringify(base.takeProfit) };
  const candles = [
    { time: '2026-11-26T11:50:00.000Z', high: 1.12, low: 1.08 },
    { time: '2026-11-26T11:55:00.000Z', high: 1.111, low: 1.095 },
    { time: '2026-11-26T12:00:00.000Z', high: 1.2, low: 1.0 }
  ];
  const result = resolveSignalOutcome(event, candles, { now });
  assert.equal(result.outcome, 'WIN');
});

test('marks same-candle TP1 and stop touches ambiguous', () => {
  const event = { ...base, generated_at: base.generatedAt, stop_loss: base.stopLoss, take_profit_json: JSON.stringify(base.takeProfit) };
  const result = resolveSignalOutcome(event, [{ time: '2026-11-26T11:55:00.000Z', high: 1.12, low: 1.08 }], { now });
  assert.equal(result.status, 'AMBIGUOUS');
});

test('does not use a still-forming candle to settle a signal', () => {
  const event = { ...base, generated_at: base.generatedAt, stop_loss: base.stopLoss, take_profit_json: JSON.stringify(base.takeProfit) };
  const result = resolveSignalOutcome(event, [{ time: '2026-11-26T11:55:00.000Z', high: 1.12, low: 1.095 }], { now: Date.parse('2026-11-26T11:57:00.000Z') });
  assert.equal(result, null);
});
