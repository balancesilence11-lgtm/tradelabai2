// Local paper-order risk gate. This is a browser-side simulation safeguard,
// not a broker-side or server-enforced trading control.
export function estimatePaperOrderRisk(order) {
  const entry = Number(order?.entry);
  const stop = Number(order?.sl ?? order?.stop);
  const volume = Number(order?.volume);
  if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0 &&
        Number.isFinite(volume) && volume > 0)) return null;
  const explicit = Number(order?.riskCash);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  // Same simplified multiplier used by the existing Portfolio Risk demo.
  return Math.abs(entry - stop) * volume * 100000;
}

export function evaluatePaperOrderRisk({ order, account = {}, positions = [], existingOrders = [], limits = {} } = {}) {
  const balance = Number(account.balance);
  const equity = Number(account.equity);
  const peakEquity = Number(account.peakEquity);
  const dailyLoss = Math.max(0, Number(account.dailyLoss) || 0);
  const dailyLimitPct = Number(limits.dailyLimitPct ?? 3);
  const drawdownLimitPct = Number(limits.drawdownLimitPct ?? 10);
  const maxPortfolioRiskPct = Number(limits.maxPortfolioRiskPct ?? 3);
  const proposedRisk = estimatePaperOrderRisk(order);
  const reasons = [];

  if (!(Number.isFinite(balance) && balance > 0)) reasons.push('Account balance is missing or invalid.');
  if (!(Number.isFinite(equity) && equity >= 0)) reasons.push('Account equity is missing or invalid.');
  if (!(Number.isFinite(peakEquity) && peakEquity > 0)) reasons.push('Peak equity is missing or invalid.');
  if (proposedRisk == null || !Number.isFinite(proposedRisk)) reasons.push('Order risk cannot be calculated from entry, stop-loss and volume.');
  if (!(dailyLimitPct > 0 && drawdownLimitPct > 0 && maxPortfolioRiskPct > 0)) reasons.push('One or more risk limits are invalid.');

  const dailyLossPct = balance > 0 ? dailyLoss / balance * 100 : Infinity;
  const drawdownPct = peakEquity > 0 ? Math.max(0, (peakEquity - equity) / peakEquity * 100) : Infinity;
  const positionRisk = (Array.isArray(positions) ? positions : []).reduce((sum, p) => sum + Math.max(0, Number(p?.risk) || 0), 0);
  const orderRisk = (Array.isArray(existingOrders) ? existingOrders : [])
    .filter(o => !o?.status || o.status === 'PAPER OPEN')
    .reduce((sum, o) => sum + Math.max(0, estimatePaperOrderRisk(o) || 0), 0);
  const existingRisk = positionRisk + Math.max(0, Number(account.openRisk) || 0) + orderRisk;
  const projectedRisk = existingRisk + (proposedRisk || 0);
  const projectedRiskPct = balance > 0 ? projectedRisk / balance * 100 : Infinity;

  if (dailyLossPct >= dailyLimitPct) reasons.push(`Daily loss limit reached (${dailyLossPct.toFixed(2)}% / ${dailyLimitPct.toFixed(2)}%).`);
  if (drawdownPct >= drawdownLimitPct) reasons.push(`Maximum drawdown limit reached (${drawdownPct.toFixed(2)}% / ${drawdownLimitPct.toFixed(2)}%).`);
  if (projectedRiskPct > maxPortfolioRiskPct) reasons.push(`Aggregate portfolio risk would exceed the ${maxPortfolioRiskPct.toFixed(2)}% ceiling (${projectedRiskPct.toFixed(2)}% projected).`);

  return {
    allowed: reasons.length === 0,
    reasons,
    proposedRisk: proposedRisk ?? 0,
    existingRisk,
    projectedRisk,
    projectedRiskPct,
    dailyLossPct,
    drawdownPct,
    limits: { dailyLimitPct, drawdownLimitPct, maxPortfolioRiskPct }
  };
}
