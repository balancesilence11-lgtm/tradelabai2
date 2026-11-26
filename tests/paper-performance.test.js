import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperPerformance } from '../src/paper-performance.js';

const orders = [
  { id: 1, symbol: 'EURUSD', status: 'CLOSED', realizedPnl: 100, riskCash: 50, closedAt: '2026-11-20T10:00:00.000Z' },
  { id: 2, symbol: 'EURUSD', status: 'CLOSED', realizedPnl: -40, riskCash: 40, closedAt: '2026-11-21T10:00:00.000Z' },
  { id: 3, symbol: 'XAUUSD', status: 'CLOSED', realizedPnl: 0, riskCash: 20, closedAt: '2026-11-22T10:00:00.000Z' },
  { id: 4, symbol: 'GBPUSD', status: 'PAPER OPEN', realizedPnl: 999, closedAt: '2026-11-23T10:00:00.000Z' },
  { id: 5, symbol: 'GBPUSD', status: 'CLOSED', realizedPnl: 'bad', closedAt: '2026-11-23T10:00:00.000Z' },
  { id: 6, symbol: 'GBPUSD', status: 'CLOSED', realizedPnl: '', closedAt: '2026-11-23T10:00:00.000Z' },
  { id: 7, symbol: 'GBPUSD', status: 'CLOSED', realizedPnl: 5, closedAt: 'not-a-date' }
];

test('counts only closed orders with finite P/L and valid close timestamps', () => {
  const result = buildPaperPerformance(orders);
  assert.equal(result.total, 3);
  assert.equal(result.wins, 1);
  assert.equal(result.losses, 1);
  assert.equal(result.breakeven, 1);
  assert.equal(result.netPnl, 60);
});

test('calculates win rate, profit factor and expectancy', () => {
  const result = buildPaperPerformance(orders);
  assert.ok(Math.abs(result.winRate - 100 / 3) < 1e-9);
  assert.equal(result.profitFactor, 2.5);
  assert.equal(result.expectancy, 20);
});

test('calculates chronological equity curve and maximum drawdown', () => {
  const result = buildPaperPerformance(orders);
  assert.deepEqual(result.equityCurve.map(p => p.cumulativePnl), [100, 60, 60]);
  assert.equal(result.maxDrawdown, 40);
});

test('filters by symbol and inclusive date range', () => {
  const result = buildPaperPerformance(orders, { symbol: 'EURUSD', from: '2026-11-21', to: '2026-11-21' });
  assert.equal(result.total, 1);
  assert.equal(result.netPnl, -40);
});

test('calculates R-multiple statistics only where positive risk cash is recorded', () => {
  const result = buildPaperPerformance(orders);
  assert.equal(result.rTradeCount, 3);
  assert.ok(Math.abs(result.averageR - (2 - 1 + 0) / 3) < 1e-9);
  assert.equal(result.expectancyR, result.averageR);
});

test('calculates monthly results, trade streaks and extremes', () => {
  const result = buildPaperPerformance(orders);
  assert.deepEqual(result.monthly.map(row => row.month), ['2026-11']);
  assert.equal(result.monthly[0].netPnl, 60);
  assert.deepEqual(result.currentStreak, { type: 'NONE', count: 0 });
  assert.equal(result.maxWinStreak, 1);
  assert.equal(result.maxLossStreak, 1);
  assert.equal(result.bestTrade, 100);
  assert.equal(result.worstTrade, -40);
});

test('handles empty data and no-loss profit factor', () => {
  assert.equal(buildPaperPerformance([]).total, 0);
  const result = buildPaperPerformance([orders[0]]);
  assert.equal(result.profitFactor, Infinity);
  assert.equal(result.averageR, 2);
});
