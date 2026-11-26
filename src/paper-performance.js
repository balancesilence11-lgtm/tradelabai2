// Analytics for browser-local paper orders. Results are descriptive estimates,
// not broker statements or forecasts. Only closed records with finite P/L count.
export function buildPaperPerformance(orders = [], options = {}) {
  const list = Array.isArray(orders) ? orders : [];
  const symbolFilter = String(options.symbol || 'ALL').toUpperCase();
  const from = options.from ? Date.parse(`${options.from}T00:00:00`) : -Infinity;
  const to = options.to ? Date.parse(`${options.to}T23:59:59.999`) : Infinity;
  const trades = list.filter(order => {
    if (String(order?.status || '').toUpperCase() !== 'CLOSED') return false;
    const pnl = Number(order.realizedPnl);
    if (!Number.isFinite(pnl)) return false;
    const symbol = String(order.symbol || '').toUpperCase();
    if (symbolFilter !== 'ALL' && symbol !== symbolFilter) return false;
    const time = Date.parse(order.closedAt || '');
    if (Number.isFinite(from) && time < from) return false;
    if (Number.isFinite(to) && time > to) return false;
    return true;
  }).sort((a, b) => Date.parse(a.closedAt || 0) - Date.parse(b.closedAt || 0));

  const wins = trades.filter(t => Number(t.realizedPnl) > 0);
  const losses = trades.filter(t => Number(t.realizedPnl) < 0);
  const breakeven = trades.length - wins.length - losses.length;
  const grossProfit = wins.reduce((sum, t) => sum + Number(t.realizedPnl), 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + Number(t.realizedPnl), 0));
  const netPnl = trades.reduce((sum, t) => sum + Number(t.realizedPnl), 0);
  const expectancy = trades.length ? netPnl / trades.length : 0;

  let running = 0, peak = 0, maxDrawdown = 0;
  const equityCurve = trades.map(t => {
    running += Number(t.realizedPnl);
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
    return { time: t.closedAt, pnl: Number(t.realizedPnl), cumulativePnl: running, drawdown: peak - running };
  });

  const bySymbol = Object.values(trades.reduce((groups, trade) => {
    const symbol = String(trade.symbol || 'UNKNOWN').toUpperCase();
    const group = groups[symbol] || (groups[symbol] = { symbol, trades: 0, wins: 0, losses: 0, netPnl: 0 });
    group.trades += 1;
    group.netPnl += Number(trade.realizedPnl);
    if (Number(trade.realizedPnl) > 0) group.wins += 1;
    if (Number(trade.realizedPnl) < 0) group.losses += 1;
    return groups;
  }, {})).map(group => ({ ...group, winRate: group.trades ? group.wins / group.trades * 100 : 0 }))
    .sort((a, b) => b.netPnl - a.netPnl);

  return {
    trades, total: trades.length, wins: wins.length, losses: losses.length, breakeven,
    winRate: trades.length ? wins.length / trades.length * 100 : 0,
    grossProfit, grossLoss, netPnl,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy, averageWin: wins.length ? grossProfit / wins.length : 0,
    averageLoss: losses.length ? grossLoss / losses.length : 0,
    maxDrawdown, equityCurve, bySymbol
  };
}
