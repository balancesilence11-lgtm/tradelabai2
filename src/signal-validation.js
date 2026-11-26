const TIMEFRAME_MS = Object.freeze({
  '1min': 60_000, '5min': 300_000, '15min': 900_000,
  '30min': 1_800_000, '1h': 3_600_000,
  '4h': 14_400_000, '1day': 86_400_000
});

const finitePositive = value => Number.isFinite(Number(value)) && Number(value) > 0;

/** Validate a directional signal before it is persisted to the performance ledger. */
export function validateSignalRecord(body, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const symbol = String(body?.symbol || '').toUpperCase().replace('/', '');
  const timeframe = String(body?.timeframe || '').toLowerCase();
  const signal = String(body?.signal || '').toUpperCase();
  const engineId = String(body?.engineId || 'legacy-unspecified');
  const allowedEngines = new Set(['advanced-client-confluence-v1', 'legacy-unspecified']);
  const confluence = Number(body?.confluence);
  const entry = Number(body?.entry);
  const stopLoss = Number(body?.stopLoss);
  const targets = Array.isArray(body?.takeProfit) ? body.takeProfit.map(Number) : [];
  const generatedAtMs = Date.parse(body?.generatedAt);

  if (!symbol || !TIMEFRAME_MS[timeframe] || !['BUY', 'SELL'].includes(signal) ||
      !allowedEngines.has(engineId) ||
      !Number.isFinite(confluence) || confluence < 0 || confluence > 100 ||
      !finitePositive(entry) || !finitePositive(stopLoss) || !targets.length ||
      targets.some(target => !finitePositive(target)) ||
      !Number.isFinite(generatedAtMs) || generatedAtMs > now + 60_000 ||
      generatedAtMs < now - 7 * 86_400_000) {
    return { ok: false, error: 'Signal fields are invalid or outside the permitted range.' };
  }

  const risk = signal === 'BUY' ? entry - stopLoss : stopLoss - entry;
  const reward = signal === 'BUY' ? targets[0] - entry : entry - targets[0];
  if (!(risk > 0) || !(reward > 0)) {
    return { ok: false, error: 'Entry, stop-loss and TP1 levels do not match the signal direction.' };
  }
  for (let i = 1; i < targets.length; i += 1) {
    const progresses = signal === 'BUY' ? targets[i] > targets[i - 1] : targets[i] < targets[i - 1];
    if (!progresses) return { ok: false, error: 'Take-profit levels must progress in the signal direction.' };
  }

  return {
    ok: true,
    value: { symbol, timeframe, signal, confluence, entry, stopLoss, takeProfit: targets,
      generatedAt: new Date(generatedAtMs).toISOString(), engineId, risk, reward,
      rewardRisk: reward / risk }
  };
}

/** Resolve only candles that are strictly after the signal and fully closed. */
export function resolveSignalOutcome(event, candles, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const duration = TIMEFRAME_MS[String(event?.timeframe || '').toLowerCase()];
  const generatedAt = Date.parse(event?.generated_at ?? event?.generatedAt);
  const entry = Number(event?.entry);
  const stop = Number(event?.stop_loss ?? event?.stopLoss);
  let targets;
  try {
    const raw = event?.take_profit_json ?? event?.takeProfit;
    targets = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch { return null; }
  const target1 = Number(Array.isArray(targets) ? targets[0] : targets?.TP1);
  const isBuy = String(event?.signal).toUpperCase() === 'BUY';
  if (!duration || !Number.isFinite(generatedAt) || !finitePositive(entry) ||
      !finitePositive(stop) || !finitePositive(target1) || !['BUY', 'SELL'].includes(String(event?.signal).toUpperCase())) return null;

  const ordered = (Array.isArray(candles) ? candles : []).map(candle => {
    const at = Date.parse(candle?.time ?? candle?.timestamp ?? candle?.datetime);
    const high = Number(candle?.high), low = Number(candle?.low);
    return { at, high, low };
  }).filter(c => Number.isFinite(c.at) && Number.isFinite(c.high) && Number.isFinite(c.low) &&
    c.high >= c.low && c.at > generatedAt && c.at + duration <= now)
    .sort((a, b) => a.at - b.at);

  for (const candle of ordered) {
    const stopHit = isBuy ? candle.low <= stop : candle.high >= stop;
    const targetHit = isBuy ? candle.high >= target1 : candle.low <= target1;
    if (stopHit && targetHit) return { status: 'AMBIGUOUS', outcome: null, exitPrice: null, rMultiple: null,
      reason: 'TP1 and stop-loss were both touched within the same completed candle; intrabar order is unknown.' };
    if (stopHit) return { status: 'RESOLVED', outcome: 'LOSS', exitPrice: stop, rMultiple: -1,
      reason: 'Stop-loss touched after signal generation.' };
    if (targetHit) return { status: 'RESOLVED', outcome: 'WIN', exitPrice: target1, rMultiple: 1,
      reason: 'Take-profit 1 touched after signal generation.' };
  }
  return null;
}
