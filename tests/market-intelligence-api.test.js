import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMarketIntelligence } from '../phase2_market_intelligence.js';

const endpoint = (path, method = 'GET', body) => new Request(`https://tradelab.test${path}`, {
  method,
  headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body)
});

function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return Promise.resolve().then(run).finally(() => { globalThis.fetch = original; });
}

test('news endpoint normalises Finnhub articles and rejects unsafe source URLs', async () => {
  await withFetch(async () => Response.json([
    { id: 7, headline: 'Markets rise', summary: 'Growth outlook improves', source: 'Wire', url: 'https://example.com/story', datetime: 1795780000 },
    { id: 8, headline: 'Unsafe link', url: 'javascript:alert(1)', datetime: 1795780001 },
    { id: 9, headline: '', url: 'https://example.com/empty' }
  ]), async () => {
    const response = await handleMarketIntelligence(endpoint('/api/market-intelligence/news?symbol=EURUSD'), { FINNHUB_API_KEY: 'test-key' }, new URL('https://tradelab.test/api/market-intelligence/news?symbol=EURUSD'));
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.provider, 'Finnhub');
    assert.equal(data.articles.length, 2);
    assert.equal(data.articles[0].url, 'https://example.com/story');
    assert.equal(data.articles[1].url, null);
  });
});

test('calendar endpoint validates date order and maps provider events', async () => {
  const invalidUrl = new URL('https://tradelab.test/api/market-intelligence/calendar?from=2026-12-02&to=2026-12-01');
  const invalid = await handleMarketIntelligence(endpoint(invalidUrl.pathname + invalidUrl.search), {}, invalidUrl);
  assert.equal(invalid.status, 400);

  await withFetch(async url => {
    assert.match(String(url), /impact=all/);
    assert.match(String(url), /days=/);
    const eventTimestamp = Math.floor(Date.now() / 1000) + 60 * 60;
    return Response.json({ events: [{
      id: 'us-cpi-1', ts: eventTimestamp, time: new Date(eventTimestamp * 1000).toISOString(),
      currency: 'USD', title: 'CPI', impact: 'high', actual: null,
      forecast: 2.5, previous: 2.4, status: 'upcoming'
    }] });
  }, async () => {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const url = new URL(`https://tradelab.test/api/market-intelligence/calendar?from=${from}&to=${to}`);
    const response = await handleMarketIntelligence(endpoint(url.pathname + url.search), {}, url);
    const data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.provider, 'ShowMyTrades');
    assert.equal(data.events[0].event, 'CPI');
    assert.equal(data.events[0].impact, 'High');
    assert.equal(data.events[0].estimate, 2.5);
    assert.equal(data.events[0].currency, 'USD');
  });
});

test('provider configuration and upstream failures return controlled errors', async () => {
  const newsUrl = new URL('https://tradelab.test/api/market-intelligence/news');
  const missing = await handleMarketIntelligence(endpoint(newsUrl.pathname), {}, newsUrl);
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /FINNHUB_API_KEY/);

  await withFetch(async () => new Response('rate limited', { status: 429 }), async () => {
    const response = await handleMarketIntelligence(endpoint(newsUrl.pathname), { FINNHUB_API_KEY: 'test-key' }, newsUrl);
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /429/);
  });
});

test('brief endpoint rejects malformed and insufficient candle payloads', async () => {
  const url = new URL('https://tradelab.test/api/market-intelligence/brief');
  const malformed = await handleMarketIntelligence(new Request(url, { method: 'POST', body: '{' }), {}, url);
  assert.equal(malformed.status, 400);
  const insufficient = await handleMarketIntelligence(endpoint(url.pathname, 'POST', { candles: [{ open: 1, high: 2, low: 0, close: 1 }] }), {}, url);
  assert.equal(insufficient.status, 400);
});

test('unsupported methods and unknown intelligence routes are rejected', async () => {
  const methodUrl = new URL('https://tradelab.test/api/market-intelligence/news');
  const method = await handleMarketIntelligence(endpoint(methodUrl.pathname, 'DELETE'), {}, methodUrl);
  assert.equal(method.status, 405);
  const missingUrl = new URL('https://tradelab.test/api/market-intelligence/unknown');
  const missing = await handleMarketIntelligence(endpoint(missingUrl.pathname), {}, missingUrl);
  assert.equal(missing.status, 404);
});
