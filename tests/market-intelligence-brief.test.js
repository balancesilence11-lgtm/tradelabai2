import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketIntelligence } from '../phase2_market_intelligence.js';

function makeCandles(direction = 'up', count = 120) {
  let price = direction === 'up' ? 100 : 200;
  return Array.from({ length: count }, (_, index) => {
    const open = price;
    price += (direction === 'up' ? 0.8 : -0.8) + Math.sin(index * 1.7) * 1.1;
    const close = price;
    return {
      timestamp: new Date(Date.now() - (count - index) * 60000).toISOString(),
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 100 + (index % 9) * 12
    };
  });
}

async function brief(symbol, candles) {
  const url = new URL('https://tradelab.test/api/market-intelligence/brief');
  const request = new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ symbol, timeframe: '1min', candles })
  });
  const response = await handleMarketIntelligence(request, {}, url);
  return { response, data: await response.json() };
}

test('AI market brief returns multi-factor analysis for US30', async () => {
  const { response, data } = await brief('US30', makeCandles('up'));
  assert.equal(response.status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.symbol, 'US30');
  assert.ok(['BULLISH', 'BEARISH', 'NEUTRAL'].includes(data.direction));
  assert.equal(typeof data.confluenceScore, 'number');
  assert.ok(data.quality <= 95);
  assert.equal(data.metrics.candlesAnalyzed, 120);
  assert.equal(data.factors.length, 5);
  assert.ok(Number.isFinite(data.metrics.rsi14));
  assert.ok(Number.isFinite(data.metrics.atr14));
  assert.ok(data.levels.nearestSupport > 0);
  assert.ok(data.levels.nearestResistance > 0);
  assert.ok(Array.isArray(data.limitations));
  assert.match(data.riskNotice, /Analysis only/);
});

test('AI market brief rejects less than 20 candles', async () => {
  const { response, data } = await brief('EURUSD', makeCandles('up', 19));
  assert.equal(response.status, 400);
  assert.match(data.error, /20 recent candles/);
});

test('AI market brief ignores malformed candles and requires 20 valid records', async () => {
  const candles = makeCandles('up', 30).map((candle, index) =>
    index < 12 ? { ...candle, high: candle.low - 1 } : candle
  );
  const { response, data } = await brief('EURUSD', candles);
  assert.equal(response.status, 400);
  assert.match(data.error, /20 valid OHLC candles/);
});
