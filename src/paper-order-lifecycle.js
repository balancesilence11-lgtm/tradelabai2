// Browser-local paper order lifecycle. P/L is an illustrative price-difference
// estimate, not a broker-accurate contract/tick-value calculation.
export function calculatePaperOrderPnl(order, exitPrice) {
  const entry = Number(order?.entry);
  const exit = Number(exitPrice);
  const volume = Number(order?.volume);
  const side = String(order?.side || '').toUpperCase();
  if (!(Number.isFinite(entry) && entry > 0 && Number.isFinite(exit) && exit > 0 &&
        Number.isFinite(volume) && volume > 0 && (side === 'BUY' || side === 'SELL'))) return null;
  const direction = side === 'BUY' ? 1 : -1;
  return (exit - entry) * direction * volume * 100000;
}

export function closePaperOrder(order, exitPrice, closedAt = new Date().toISOString()) {
  if (!order || order.status !== 'PAPER OPEN' || order.type !== 'Market') return { ok: false, reason: 'Only an open market paper order can be closed.' };
  const pnl = calculatePaperOrderPnl(order, exitPrice);
  if (pnl == null) return { ok: false, reason: 'Order or exit-price data is invalid.' };
  return { ok: true, order: { ...order, status: 'CLOSED', exit: Number(exitPrice), closedAt, realizedPnl: pnl } };
}

export function cancelPaperOrder(order, cancelledAt = new Date().toISOString()) {
  if (!order || order.status !== 'PAPER OPEN' || order.type === 'Market') {
    return { ok: false, reason: 'Only an open pending paper order can be cancelled.' };
  }
  return { ok: true, order: { ...order, status: 'CANCELLED', cancelledAt, realizedPnl: 0 } };
}

export function applyPaperRealizedPnl(account = {}, pnl) {
  const balance = Number(account.balance);
  const equity = Number(account.equity);
  const peakEquity = Number(account.peakEquity);
  if (!(Number.isFinite(balance) && balance >= 0 && Number.isFinite(equity) && equity >= 0 &&
        Number.isFinite(peakEquity) && peakEquity > 0 && Number.isFinite(pnl))) return null;
  const nextBalance = balance + pnl;
  const nextEquity = equity + pnl;
  if (nextBalance < 0 || nextEquity < 0) return null;
  return {
    ...account,
    balance: nextBalance,
    equity: nextEquity,
    peakEquity: Math.max(peakEquity, nextEquity),
    dailyLoss: Math.max(0, Number(account.dailyLoss) || 0) + Math.max(0, -pnl)
  };
}
