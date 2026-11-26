// CSV exports for browser-local paper performance. No data is uploaded.
function csvCell(value) {
  if (value == null) return '""';
  let text = String(value);
  // Prevent spreadsheet formula execution for untrusted text fields.
  if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

function csv(rows) {
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function buildPaperTradesCsv(trades = []) {
  const rows = [[
    'Order ID', 'Instrument', 'Side', 'Volume', 'Entry', 'Exit',
    'Closed At', 'Realised P/L', 'Initial Risk Cash', 'Realised R'
  ]];
  for (const trade of Array.isArray(trades) ? trades : []) {
    const pnl = Number(trade?.realizedPnl);
    const risk = Number(trade?.riskCash);
    rows.push([
      trade?.id ?? '', trade?.symbol ?? '', trade?.side ?? '', trade?.volume ?? '',
      trade?.entry ?? '', trade?.exit ?? '', trade?.closedAt ?? '',
      Number.isFinite(pnl) ? pnl : '', Number.isFinite(risk) && risk > 0 ? risk : '',
      Number.isFinite(pnl) && Number.isFinite(risk) && risk > 0 ? pnl / risk : ''
    ]);
  }
  return csv(rows);
}

export function buildPaperSummaryCsv(stats = {}, filters = {}) {
  stats = stats && typeof stats === 'object' ? stats : {};
  filters = filters && typeof filters === 'object' ? filters : {};
  const rows = [
    ['Metric', 'Value'],
    ['Scope', 'Browser-local paper trading only'],
    ['Instrument filter', filters.symbol || 'ALL'],
    ['From date', filters.from || 'All'],
    ['To date', filters.to || 'All'],
    ['Closed orders', Number(stats.total) || 0],
    ['Wins', Number(stats.wins) || 0],
    ['Losses', Number(stats.losses) || 0],
    ['Breakeven', Number(stats.breakeven) || 0],
    ['Win rate (%)', Number(stats.winRate) || 0],
    ['Gross profit', Number(stats.grossProfit) || 0],
    ['Gross loss', Number(stats.grossLoss) || 0],
    ['Net realised P/L', Number(stats.netPnl) || 0],
    ['Profit factor', stats.profitFactor === Infinity ? 'Infinite (no gross losses)' : Number(stats.profitFactor) || 0],
    ['Expectancy per trade', Number(stats.expectancy) || 0],
    ['Maximum drawdown', Number(stats.maxDrawdown) || 0],
    ['Trades with valid initial risk', Number(stats.rTradeCount) || 0],
    ['Average realised R', stats.averageR == null ? 'Unavailable' : Number(stats.averageR)],
    ['Maximum win streak', Number(stats.maxWinStreak) || 0],
    ['Maximum loss streak', Number(stats.maxLossStreak) || 0],
    ['Accounting note', 'Illustrative paper estimates; not broker statements or live-account performance']
  ];
  return csv(rows);
}
