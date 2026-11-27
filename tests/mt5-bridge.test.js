import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

function makeD1Mock() {
  const quotes = new Map();
  const candles = new Map();
  function statement(sql, values = []) {
    return {
      bind(...bound) { return statement(sql, bound); },
      async run() {
        if (sql.includes('INSERT INTO mt5_market_quotes')) {
          quotes.set(values[0], { symbol: values[0], broker_symbol: values[1], bid: values[2], ask: values[3], last: values[4], timestamp_ms: values[5], received_at_ms: values[6] });
        } else if (sql.includes('INSERT INTO mt5_market_candles')) {
          const key = `${values[0]}|${values[1]}|${values[2]}`;
          candles.set(key, { symbol: values[0], timeframe: values[1], candle_time_ms: values[2], open: values[3], high: values[4], low: values[5], close: values[6], tick_volume: values[7], spread: values[8], real_volume: values[9], received_at_ms: values[10] });
        }
        return { success: true };
      },
      async first() {
        if (sql.includes('FROM mt5_market_quotes')) return quotes.get(values[0]) || null;
        return null;
      },
      async all() {
        if (sql.includes('FROM mt5_market_candles')) {
          const rows = [...candles.values()].filter(row => row.symbol === values[0] && row.timeframe === values[1]).sort((a, b) => b.candle_time_ms - a.candle_time_ms).slice(0, values[2]);
          return { results: rows };
        }
        return { results: [] };
      }
    };
  }
  return {
    prepare(sql) { return statement(sql); },
    async batch(items) { for (const item of items) await item.run(); return items.map(() => ({ success: true })); }
  };
}

test('MT5 bridge rejects requests without the bridge secret', async () => {
  const response = await worker.fetch(new Request('https://tradelab.test/api/mt5/bridge/ingest', { method: 'POST', body: '{}' }), { DB: makeD1Mock(), MT5_BRIDGE_TOKEN: 'a'.repeat(48) });
  assert.equal(response.status, 401);
});

test('MT5 bridge stores US30 quote and candles and serves only the MT5 source', async () => {
  const env = { DB: makeD1Mock(), MT5_BRIDGE_TOKEN: 'b'.repeat(48) };
  const now = Date.now();
  const payload = {
    symbol: 'US30', brokerSymbol: 'US30',
    quote: { bid: 42000.1, ask: 42000.3, last: 42000.2, timestampMs: now },
    timeframe: '5min',
    candles: [
      { timeMs: now - 600000, open: 41990, high: 42010, low: 41980, close: 42000, tickVolume: 120, spread: 20, realVolume: 0 },
      { timeMs: now - 300000, open: 42000, high: 42020, low: 41995, close: 42010, tickVolume: 95, spread: 18, realVolume: 0 }
    ]
  };
  const ingest = await worker.fetch(new Request('https://tradelab.test/api/mt5/bridge/ingest', {
    method: 'POST', headers: { Authorization: `Bearer ${env.MT5_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
  }), env);
  assert.equal(ingest.status, 200);
  const ingestBody = await ingest.json();
  assert.equal(ingestBody.quoteStored, true);
  assert.equal(ingestBody.candlesStored, 2);

  const quoteResponse = await worker.fetch(new Request('https://tradelab.test/api/market?symbol=US30'), env);
  assert.equal(quoteResponse.status, 200);
  const quoteBody = await quoteResponse.json();
  assert.equal(quoteBody.source, 'MT5');
  assert.equal(quoteBody.price, 42000.2);

  const candlesResponse = await worker.fetch(new Request('https://tradelab.test/api/candles?symbol=US30&interval=5min&outputsize=10'), env);
  assert.equal(candlesResponse.status, 200);
  const candlesBody = await candlesResponse.json();
  assert.equal(candlesBody.source, 'MT5');
  assert.equal(candlesBody.count, 2);
  assert.equal(candlesBody.candles[1].close, 42010);
});

