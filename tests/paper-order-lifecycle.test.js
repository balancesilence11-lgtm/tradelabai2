import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePaperOrderPnl, closePaperOrder, cancelPaperOrder, applyPaperRealizedPnl } from '../src/paper-order-lifecycle.js';

const marketOrder = { id: 1, type: 'Market', side: 'BUY', entry: '1.10000', volume: '0.10', status: 'PAPER OPEN' };
const account = { balance: 10000, equity: 10000, peakEquity: 10500, dailyLoss: 100 };

test('calculates illustrative BUY and SELL paper P/L with correct direction', () => {
  assert.ok(Math.abs(calculatePaperOrderPnl(marketOrder, 1.101) - 10) < 1e-8);
  assert.ok(Math.abs(calculatePaperOrderPnl({ ...marketOrder, side: 'SELL' }, 1.101) + 10) < 1e-8);
});
test('rejects invalid prices, volume and direction', () => {
  assert.equal(calculatePaperOrderPnl(marketOrder, 0), null);
  assert.equal(calculatePaperOrderPnl({ ...marketOrder, volume: 0 }, 1.101), null);
  assert.equal(calculatePaperOrderPnl({ ...marketOrder, side: 'HOLD' }, 1.101), null);
});
test('closes only open market orders and records exit and P/L', () => {
  const result = closePaperOrder(marketOrder, 1.101, '2026-11-26T10:00:00Z');
  assert.equal(result.ok, true);
  assert.equal(result.order.status, 'CLOSED');
  assert.ok(Math.abs(result.order.realizedPnl - 10) < 1e-8);
  assert.equal(closePaperOrder({ ...marketOrder, status: 'CLOSED' }, 1.101).ok, false);
});
test('cancels open pending orders but not market orders', () => {
  assert.equal(cancelPaperOrder({ ...marketOrder, type: 'Limit' }).order.status, 'CANCELLED');
  assert.equal(cancelPaperOrder(marketOrder).ok, false);
});
test('updates balance, equity and daily loss after realized loss', () => {
  const next = applyPaperRealizedPnl(account, -25);
  assert.equal(next.balance, 9975);
  assert.equal(next.equity, 9975);
  assert.equal(next.dailyLoss, 125);
  assert.equal(next.peakEquity, 10500);
});
test('raises peak equity after a profitable close and rejects invalid account state', () => {
  const next = applyPaperRealizedPnl({ ...account, peakEquity: 10000 }, 50);
  assert.equal(next.balance, 10050);
  assert.equal(next.equity, 10050);
  assert.equal(next.peakEquity, 10050);
  assert.equal(next.dailyLoss, 100);
  assert.equal(applyPaperRealizedPnl({ ...account, balance: NaN }, 10), null);
});
