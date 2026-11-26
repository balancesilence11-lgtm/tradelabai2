// Phase 2.7 execution model. All prices are quote-price units; costs are basis points.
const clampBps = value => Number.isFinite(Number(value)) ? Math.max(0, Math.min(100, Number(value))) : 0;

export function splitWalkForward(length, options = {}) {
  const n = Math.max(0, Math.floor(Number(length) || 0));
  const trainFraction = Math.max(0.5, Math.min(0.9, Number(options.trainFraction ?? 0.7)));
  const minimumTest = Math.max(1, Math.floor(Number(options.minimumTest ?? 20)));
  const splitIndex = Math.floor(n * trainFraction);
  if (splitIndex < 1 || n - splitIndex < minimumTest) {
    return { valid: false, splitIndex, trainStart: 0, trainEnd: Math.max(-1, splitIndex - 1), testStart: splitIndex, testEnd: n - 1,
      reason: `Out-of-sample testing requires at least ${minimumTest} candles after the training window.` };
  }
  return { valid: true, splitIndex, trainStart: 0, trainEnd: splitIndex - 1, testStart: splitIndex, testEnd: n - 1,
    trainCandles: splitIndex, testCandles: n - splitIndex };
}

export function buildExecutionModel(options = {}) {
  return {
    spreadBps: clampBps(options.spreadBps ?? 1),
    commissionBps: clampBps(options.commissionBps ?? 0.2),
    slippageBps: clampBps(options.slippageBps ?? 0.3)
  };
}

// Entry executes at next candle OPEN. BUY pays ask; SELL receives bid.
export function simulateTradeExecution({ side, candles, entryIndex, stop, target, risk, execution = {}, horizon = 10 }) {
  const model = buildExecutionModel(execution);
  const direction = side === 'BUY' ? 1 : side === 'SELL' ? -1 : 0;
  if (!direction || !Array.isArray(candles) || !Number.isInteger(entryIndex) || entryIndex < 0 || entryIndex >= candles.length || !(risk > 0)) {
    return { status: 'INVALID', outcome: null, grossR: null, netR: null };
  }
  const halfSpread = model.spreadBps / 20000;
  const slip = model.slippageBps / 10000;
  const rawEntry = Number(candles[entryIndex].open);
  if (!(rawEntry > 0)) return { status: 'INVALID', outcome: null, grossR: null, netR: null };
  const entryFill = rawEntry * (1 + direction * (halfSpread + slip));
  const actualRisk = side === 'BUY' ? entryFill - stop : stop - entryFill;
  if (!(actualRisk > 0)) return { status: 'INVALID', outcome: null, grossR: null, netR: null, entryFill, rawEntry };
  const last = Math.min(candles.length - 1, entryIndex + Math.max(1, Math.floor(Number(horizon) || 10)) - 1);
  let exitFill = null, exitIndex = null, outcome = null, status = 'UNRESOLVED', reason = 'No stop or target touch within the configured holding horizon.';
  for (let i = entryIndex; i <= last; i++) {
    const c = candles[i], open = Number(c.open), high = Number(c.high), low = Number(c.low);
    if (![open, high, low].every(Number.isFinite)) continue;
    const stopGap = side === 'BUY' ? open <= stop : open >= stop;
    const targetGap = side === 'BUY' ? open >= target : open <= target;
    const stopHit = stopGap || (side === 'BUY' ? low <= stop : high >= stop);
    const targetHit = targetGap || (side === 'BUY' ? high >= target : low <= target);
    if (stopHit && targetHit) {
      if (stopGap) { outcome = 'LOSS'; exitFill = open * (1 - direction * slip); status = 'RESOLVED'; reason = 'Gap through stop: filled at the worse opening price.'; }
      else if (targetGap) { outcome = 'WIN'; exitFill = target * (1 - direction * halfSpread); status = 'RESOLVED'; reason = 'Opening gap through target: conservative target-price fill.'; }
      else { status = 'AMBIGUOUS'; reason = 'Stop and target touched in the same candle; intrabar order is unknown.'; }
      exitIndex = i; break;
    }
    if (stopHit) {
      outcome = 'LOSS'; const rawExit = stopGap ? open : stop;
      exitFill = rawExit * (1 - direction * (halfSpread + slip)); status = 'RESOLVED'; exitIndex = i;
      reason = stopGap ? 'Gap through stop: filled at the worse opening price.' : 'Stop touched; adverse spread and slippage applied.'; break;
    }
    if (targetHit) {
      outcome = 'WIN'; const rawExit = targetGap ? target : target;
      exitFill = rawExit * (1 - direction * halfSpread); status = 'RESOLVED'; exitIndex = i;
      reason = targetGap ? 'Opening gap through target: conservative target-price fill.' : 'Target touched; exit spread applied.'; break;
    }
  }
  if (status !== 'RESOLVED') return { status, outcome: null, grossR: null, netR: null, entryFill, rawEntry, exitIndex, reason, actualRisk };
  const grossR = direction * (exitFill - entryFill) / actualRisk;
  const commissionR = (model.commissionBps * 2 / 10000 * entryFill) / actualRisk;
  const netR = grossR - commissionR;
  return { status, outcome, grossR: Number(grossR.toFixed(5)), netR: Number(netR.toFixed(5)), entryFill,
    rawEntry, exitFill, exitIndex, actualRisk, commissionR: Number(commissionR.toFixed(5)), reason };
}
