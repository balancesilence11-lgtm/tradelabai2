const TIMEFRAME_MS = Object.freeze({
  '1min': 60_000, '5min': 300_000, '15min': 900_000,
  '30min': 1_800_000, '1h': 3_600_000,
  '4h': 14_400_000, '1day': 86_400_000
});

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

function timestamp(value) {
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const numeric = Number(value);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  return Date.parse(value);
}

function targetsOf(signal) {
  let raw = signal?.take_profit_json ?? signal?.takeProfit ?? signal?.targets;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return []; }
  }
  if (Array.isArray(raw)) return raw.map(Number);
  if (raw && typeof raw === 'object') return [raw.TP1, raw.tp1].filter(v => v != null).map(Number);
  return [];
}

/**
 * Event-based historical test of already-generated signals against OHLC candles.
 * Candles are timestamped by their OPEN time. A candle is eligible only after
 * its full timeframe has elapsed and its open time is strictly after the signal.
 * Overlapping signals are evaluated independently, not as a portfolio.
 */
export function runHistoricalBacktest(signals, candles, options = {}) {
  const requestedCostR = Number(options.costR ?? 0);
  const costR = Number.isFinite(requestedCostR) && requestedCostR >= 0 && requestedCostR <= 5 ? requestedCostR : 0;
  const asOf = Number.isFinite(options.asOf) ? options.asOf : Date.now();
  const normalizedCandles = (Array.isArray(candles) ? candles : []).map(c => ({
    at: timestamp(c?.time ?? c?.timestamp ?? c?.datetime),
    high: Number(c?.high), low: Number(c?.low)
  })).filter(c => Number.isFinite(c.at) && Number.isFinite(c.high) && Number.isFinite(c.low) && c.high >= c.low)
    .sort((a, b) => a.at - b.at);

  const results = [];
  for (const signal of Array.isArray(signals) ? signals : []) {
    const side = String(signal?.signal ?? signal?.direction ?? '').toUpperCase();
    const timeframe = String(signal?.timeframe || '').toLowerCase();
    const duration = TIMEFRAME_MS[timeframe];
    const generatedAt = timestamp(signal?.generated_at ?? signal?.generatedAt);
    const entry = Number(signal?.entry);
    const stop = Number(signal?.stop_loss ?? signal?.stopLoss);
    const target = targetsOf(signal)[0];
    const risk = side === 'BUY' ? entry - stop : stop - entry;
    const reward = side === 'BUY' ? target - entry : entry - target;
    if (!duration || !Number.isFinite(generatedAt) || !positive(entry) || !positive(stop) ||
        !positive(target) || !['BUY', 'SELL'].includes(side) || !(risk > 0) || !(reward > 0)) {
      results.push({ id: signal?.id ?? null, status: 'INVALID', outcome: null, grossR: null, netR: null });
      continue;
    }

    let resolution = null;
    for (const candle of normalizedCandles) {
      if (candle.at <= generatedAt || candle.at + duration > asOf) continue;
      const stopHit = side === 'BUY' ? candle.low <= stop : candle.high >= stop;
      const targetHit = side === 'BUY' ? candle.high >= target : candle.low <= target;
      if (stopHit && targetHit) {
        resolution = { status: 'AMBIGUOUS', outcome: null, grossR: null, netR: null,
          reason: 'Stop-loss and TP1 were both touched in the same candle; intrabar order is unknown.' };
        break;
      }
      if (stopHit) {
        resolution = { status: 'RESOLVED', outcome: 'LOSS', grossR: -1, netR: -1 - costR,
          exitPrice: stop, reason: 'Stop-loss touched first.' };
        break;
      }
      if (targetHit) {
        const grossR = reward / risk;
        resolution = { status: 'RESOLVED', outcome: 'WIN', grossR, netR: grossR - costR,
          exitPrice: target, reason: 'TP1 touched first.' };
        break;
      }
    }
    results.push({ id: signal?.id ?? null, symbol: signal?.symbol ?? '', timeframe, signal: side,
      generatedAt: new Date(generatedAt).toISOString(), ...(resolution || { status: 'UNRESOLVED', outcome: null, grossR: null, netR: null,
        reason: 'No TP1 or stop-loss touch in the available completed candle window.' }) });
  }

  const resolved = results.filter(item => item.status === 'RESOLVED');
  const wins = resolved.filter(item => item.outcome === 'WIN');
  const losses = resolved.filter(item => item.outcome === 'LOSS');
  const netValues = resolved.map(item => item.netR);
  const grossProfit = netValues.filter(v => v > 0).reduce((sum, v) => sum + v, 0);
  const grossLoss = Math.abs(netValues.filter(v => v < 0).reduce((sum, v) => sum + v, 0));
  let equity = 0, peak = 0, maxDrawdown = 0;
  for (const item of [...resolved].sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt))) {
    equity += item.netR;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
  }
  const sumNetR = netValues.reduce((sum, value) => sum + value, 0);
  const metrics = {
    totalSignals: results.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    ambiguous: results.filter(item => item.status === 'AMBIGUOUS').length,
    unresolved: results.filter(item => item.status === 'UNRESOLVED').length,
    invalid: results.filter(item => item.status === 'INVALID').length,
    winRate: resolved.length ? Number((wins.length / resolved.length * 100).toFixed(2)) : null,
    expectancyR: resolved.length ? Number((sumNetR / resolved.length).toFixed(4)) : null,
    netR: Number(sumNetR.toFixed(4)),
    profitFactor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(4)) : null,
    noLosingTrades: resolved.length > 0 && grossLoss === 0,
    maxDrawdownR: Number(maxDrawdown.toFixed(4)),
    grossProfitR: Number(grossProfit.toFixed(4)),
    grossLossR: Number(grossLoss.toFixed(4)),
    estimatedRoundTripCostR: costR
  };
  return { metrics, results, methodology: 'Chronological signal-event test; completed candles only; same-candle TP1/SL touches excluded as ambiguous; each signal treated independently.' };
}
