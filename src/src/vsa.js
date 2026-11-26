import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVSA } from '../src/vsa.js';

function makeSeries({ trend = 'flat', current, volumeType = 'tick_volume' } = {}) {
  const prior = Array.from({ length: 20 }, (_, i) => {
    const close = trend === 'up' ? 100 + i * 0.1 :
      trend === 'down' ? 102 - i * 0.1 : 100;
    return {
      open: close - 0.1,
      high: close + 0.9,
      low: close - 1.1,
      close,
      volume: 100,
      volumeType
    };
  });
  return [...prior, { ...current, volumeType }];
}

test('detects potential No Demand after rising context', () => {
  const candles = makeSeries({
    trend: 'up',
    current: { open: 102, high: 102.4, low: 101.8, close: 102.3, volume: 50 }
  });
  const result = analyzeVSA(candles);
  assert.equal(result.signal, 'NO_DEMAND');
  assert.equal(result.direction, -1);
  assert.equal(result.source, 'broker tick volume');
});

test('detects potential No Supply after falling context', () => {
  const candles = makeSeries({
    trend: 'down',
    current: { open: 100, high: 100.2, low: 99.6, close: 99.7, volume: 50 }
  });
  const result = analyzeVSA(candles);
  assert.equal(result.signal, 'NO_SUPPLY');
  assert.equal(result.direction, 1);
});

test('detects potential stopping volume, not a guaranteed reversal', () => {
  const candles = makeSeries({
    current: { open: 103, high: 104, low: 100, close: 102.5, volume: 200 }
  });
  assert.equal(analyzeVSA(candles).signal, 'STOPPING_VOLUME');
});

test('detects a potential upthrust above the prior range', () => {
  const candles = makeSeries({
    current: { open: 102, high: 103, low: 100, close: 100.5, volume: 150 }
  });
  assert.equal(analyzeVSA(candles).signal, 'UPTHRUST');
});

test('keeps high effort / low result direction-neutral', () => {
  const candles = makeSeries({
    current: { open: 100, high: 100.5, low: 99.5, close: 100.2, volume: 200 }
  });
  const result = analyzeVSA(candles);
  assert.equal(result.signal, 'EFFORT_NO_RESULT');
  assert.equal(result.direction, 0);
});

test('does not produce VSA signals when volume is missing or zero', () => {
  const candles = makeSeries({
    current: { open: 100, high: 101, low: 99, close: 100.5, volume: 0 }
  });
  const result = analyzeVSA(candles);
  assert.equal(result.ready, false);
  assert.equal(result.signal, 'UNAVAILABLE');
});

test('labels generic volume conservatively', () => {
  const candles = makeSeries({
    current: { open: 100, high: 101, low: 99, close: 100.5, volume: 100 },
    volumeType: 'unspecified'
  }).map(({ volumeType, ...candle }) => candle);
  const result = analyzeVSA(candles);
  assert.equal(result.source, 'reported volume (type unspecified)');
});
