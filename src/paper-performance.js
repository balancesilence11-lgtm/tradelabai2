// Browser-local paper-order analytics. These are descriptive estimates, not
// broker statements, forecasts, or evidence of future profitability.
function finiteNumber(value) {
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function buildPaperPerformance(orders = [], options = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const symbolFilter = String(options.symbol || 'ALL').toUpperCase();
  const from = options.from ? Date.parse(`${options.from}T00:00:00`) : -Infinity;
  const to = options.to ? Date.parse(`${options.to}T23:59:59.999`) : Infinity;
  const trades = list.map(order => {
    const pnl = finiteNumber(order?.realizedPnl);
    const time = Date.parse(order?.closedAt || '');
    return { order, pnl, time };
  }).filter(({ order, pnl, time }) => {
    if (String(order?.status || '').toUpperCase() !== 'CLOSED') return false;
    if (pnl == null || !Number.isFinite(time)) return false;
    const symbol = String(order.symbol || '').toUpperCase();
    if (symbolFilter !== 'ALL' && symbol !== symbolFilter) return false;
    if (Number.isFinite(from) && time < from) return false;
    if (Number.isFinite(to) && time > to) return false;
    return true;
  }).sort((a, b) => a.time - b.time).map(({ order, pnl, time }) => ({
    ...order,
    realizedPnl: pnl,
    _closedAtMs: time
  }));

  const wins = trades.filter(t => t.realizedPnl > 0);
  const losses = trades.filter(t => t.realizedPnl < 0);
  const breakeven = trades.length - wins.length - losses.length;
  const grossProfit = wins.reduce((sum, t) => sum + t.realizedPnl, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.realizedPnl, 0));
  const netPnl = trades.reduce((sum, t) => sum + t.realizedPnl, 0);
  const expectancy = trades.length ? netPnl / trades.length : 0;

  let running = 0, peak = 0, maxDrawdown = 0;
  const equityCurve = trades.map(t => {
    running += t.realizedPnl;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    return { time: t.closedAt, pnl: t.realizedPnl, cumulativePnl: running, drawdown: peak - running };
  });

  const rTrades = trades.map(t => {
    const risk = finiteNumber(t.riskCash);
    return risk != null && risk > 0 ? { ...t, realizedR: t.realizedPnl / risk } : null;
  }).filter(Boolean);
  const averageR = rTrades.length ? rTrades.reduce((sum, t) => sum + t.realizedR, 0) / rTrades.length : null;
  const monthly = Object.values(trades.reduce((groups, trade) => {
    const month = new Date(trade._closedAtMs).toISOString().slice(0, 7);
    const group = groups[month] || (groups[month] = { month, trades: 0, wins: 0, losses: 0, netPnl: 0 });
    group.trades += 1;
    group.netPnl += trade.realizedPnl;
    if (trade.realizedPnl > 0) group.wins += 1;
    if (trade.realizedPnl < 0) group.losses += 1;
    return groups;
  }, {})).sort((a, b) => a.month.localeCompare(b.month));

  let currentStreakType = 'NONE', currentStreak = 0, winStreak = 0, lossStreak = 0;
  for (const trade of trades) {
    const type = trade.realizedPnl > 0 ? 'WIN' : trade.realizedPnl < 0 ? 'LOSS' : 'BREAKEVEN';
    if (type === currentStreakType && type !== 'BREAKEVEN') currentStreak += 1;
    else { currentStreakType = type; currentStreak = type === 'BREAKEVEN' ? 0 : 1; }
    if (type === 'WIN') winStreak = Math.max(winStreak, currentStreak);
    if (type === 'LOSS') lossStreak = Math.max(lossStreak, currentStreak);
  }
  if (currentStreakType === 'BREAKEVEN') currentStreakType = 'NONE';

  const bySymbol = Object.values(trades.reduce((groups, trade) => {
    const symbol = String(trade.symbol || 'UNKNOWN').toUpperCase();
    const group = groups[symbol] || (groups[symbol] = { symbol, trades: 0, wins: 0, losses: 0, netPnl: 0 });
    group.trades += 1;
    group.netPnl += trade.realizedPnl;
    if (trade.realizedPnl > 0) group.wins += 1;
    if (trade.realizedPnl < 0) group.losses += 1;
    return groups;
  }, {})).map(group => ({ ...group, winRate: group.trades ? group.wins / group.trades * 100 : 0 }))
    .sort((a, b) => b.netPnl - a.netPnl);

  return {
    trades: trades.map(({ _closedAtMs, ...trade }) => trade),
    total: trades.length, wins: wins.length, losses: losses.length, breakeven,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    grossProfit, grossLoss, netPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy, averageWin: wins.length ? grossProfit / wins.length : 0,
    averageLoss: losses.length ? grossLoss / losses.length : 0,
    maxDrawdown, equityCurve, bySymbol, monthly,
    rTradeCount: rTrades.length, averageR,
    expectancyR: averageR,
    currentStreak: { type: currentStreakType, count: currentStreak },
    maxWinStreak: winStreak, maxLossStreak: lossStreak,
    bestTrade: trades.length ? Math.max(...trades.map(t => t.realizedPnl)) : null,
    worstTrade: trades.length ? Math.min(...trades.map(t => t.realizedPnl)) : null
  };
}
