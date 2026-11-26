import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeVSA, readVolume } from '../src/vsa.js';
import { analyzeMarketIntelligence } from '../src/market-intelligence.js';

function candles(count = 21, volume = 100) {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 0.1;
    const close = open + 0.05;
    return {
      open,
      high: close + 0.1,
      low: open - 0.1,
      close,
      tick_volume: volume,
      time: index
    };
  });
}

test('readVolume rejects null, undefined, blank and non-finite values', () => {
  for (const value of [null, undefined, '', '   ', 'abc', Infinity]) {
    assert.equal(readVolume({ volume: value }).value, null);
  }
});

test('readVolume labels tick and provider-labelled real volume', () => {
  assert.equal(readVolume({ tick_volume: 25 }).source, 'broker tick volume');
  assert.equal(readVolume({ real_volume: 40 }).source, 'provider-labelled real/exchange volume');
  assert.equal(readVolume({ volume: 50 }).source, 'reported volume (type unspecified)');
  assert.equal(readVolume({ volume: 60, volumeType: 'tick' }).source, 'broker tick volume');
});

test('VSA rejects mixed volume sources instead of averaging them', () => {
  const data = candles();
  data[5] = { ...data[5], tick_volume: undefined, real_volume: 100 };
  const result = analyzeVSA(data, 20);
  assert.equal(result.ready, false);
  assert.equal(result.source, 'mixed volume sources');
  assert.match(result.detail, /mixes different volume sources/i);
});

test('VSA rejects missing volume in the selected lookback', () => {
  const data = candles();
  data[10] = { ...data[10], tick_volume: null };
  const result = analyzeVSA(data, 20);
  assert.equal(result.ready, false);
  assert.equal(result.direction, 0);
});

test('VSA accepts a complete source-consistent volume window', () => {
  const result = analyzeVSA(candles(), 20);
  assert.equal(result.ready, true);
  assert.equal(result.source, 'broker tick volume');
  assert.equal(result.lookback, 20);
});

test('VSA validates the lookback argument', () => {
  assert.equal(analyzeVSA(candles(), 1).ready, false);
  assert.equal(analyzeVSA(candles(), 2.5).ready, false);
});

test('Market Intelligence disables volume analysis for mixed sources', () => {
  const data = candles(21);
  data[4] = { ...data[4], tick_volume: undefined, real_volume: 100 };
  const result = analyzeMarketIntelligence(data);
  assert.equal(result.ready, true);
  assert.equal(result.volumeIntegrity.ready, false);
  assert.equal(result.pressure.ready, false);
  assert.equal(result.absorption.ready, false);
  assert.equal(result.exhaustion.ready, false);
  assert.match(result.volumeIntegrity.issue, /mixes volume sources/i);
});

test('Market Intelligence uses the same volume source across all volume metrics', () => {
  const result = analyzeMarketIntelligence(candles(21));
  assert.equal(result.volumeIntegrity.ready, true);
  assert.equal(result.volumeSource, 'broker tick volume');
  assert.equal(result.pressure.ready, true);
  assert.equal(result.pressure.source, result.volumeSource);
});

test('Market Intelligence withholds volume metrics when a candle has no volume', () => {
  const data = candles(21);
  data[12] = { ...data[12], tick_volume: null };
  const result = analyzeMarketIntelligence(data);
  assert.equal(result.volumeIntegrity.ready, false);
  assert.equal(result.pressure.ready, false);
  assert.equal(result.exhaustion.ready, false);
});
