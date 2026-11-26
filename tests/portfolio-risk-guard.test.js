import test from 'node:test';
import assert from 'node:assert/strict';
import { estimatePaperOrderRisk, evaluatePaperOrderRisk } from '../src/portfolio-risk-guard.js';

const base = {
  order: { entry: 1.1, sl: 1.099, tp: 1.102, volume: 0.1 },
  account: { balance: 10000, equity: 10000, peakEquity: 10000, dailyLoss: 0, openRisk: 0 },
  positions: [], existingOrders: [],
  limits: { dailyLimitPct: 3, drawdownLimitPct: 10, maxPortfolioRiskPct: 3 }
};

test('estimates proposed paper order risk using entry-stop distance', () => {
  assert.ok(Math.abs(estimatePaperOrderRisk(base.order) - 10) < 1e-8);
});
test('allows an order within all configured limits', () => {
  assert.equal(evaluatePaperOrderRisk(base).allowed, true);
});
test('blocks an order when daily loss limit is reached', () => {
  const result = evaluatePaperOrderRisk({ ...base, account: { ...base.account, dailyLoss: 300 } });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /Daily loss limit reached/);
});
test('blocks an order when account drawdown limit is reached', () => {
  const result = evaluatePaperOrderRisk({ ...base, account: { ...base.account, equity: 9000, peakEquity: 10000 } });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /Maximum drawdown limit reached/);
});
test('blocks an order that would breach aggregate open risk ceiling', () => {
  const result = evaluatePaperOrderRisk({ ...base, positions: [{ risk: 300 }] });
  assert.equal(result.allowed, false);
  assert.match(result.reasons.join(' '), /aggregate portfolio risk/i);
});
test('includes risk from existing open paper orders', () => {
  const result = evaluatePaperOrderRisk({ ...base, existingOrders: [{ entry: 1.1, sl: 1.096, volume: 0.75, status: 'PAPER OPEN' }] });
  assert.ok(Math.abs(result.existingRisk - 300) < 1e-8);
  assert.equal(result.allowed, false);
});
test('fails closed when account balance or order risk is invalid', () => {
  const result = evaluatePaperOrderRisk({ ...base, account: { ...base.account, balance: 0 }, order: { entry: 1.1, sl: 1.1, volume: 0 } });
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.length >= 2);
});
test('ignores closed paper orders when aggregating exposure', () => {
  const result = evaluatePaperOrderRisk({ ...base, existingOrders: [{ entry: 1.1, sl: 1.096, volume: 0.1, status: 'CLOSED' }] });
  assert.equal(result.existingRisk, 0);
});
