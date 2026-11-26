/**
 * Volume Spread Analysis (VSA) — transparent OHLCV heuristics.
 * Volume source is labelled conservatively; generic `volume` is never assumed
 * to be exchange-traded volume. Signals are descriptive, not proof of intent.
 */

const toFiniteNumber = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Read one candle's volume without treating null/blank values as zero.
 * Exported so Market Intelligence uses exactly the same source classification.
 */
export function readVolume(candle) {
  if (!candle || typeof candle !== 'object') {
    return { value: null, source: 'unavailable' };
  }

  for (const key of ['tick_volume', 'tickVolume', 'tickvol']) {
    const value = toFiniteNumber(candle[key]);
    if (value !== null && value > 0) {
      return { value, source: 'broker tick volume' };
    }
  }

  for (const key of ['real_volume', 'realVolume', 'exchangeVolume']) {
    const value = toFiniteNumber(candle[key]);
    if (value !== null && value > 0) {
      return { value, source: 'provider-labelled real/exchange volume' };
    }
  }

  const value = toFiniteNumber(candle.volume);
  if (value === null || value <= 0) {
    return { value: null, source: 'unavailable' };
  }

  const declared = String(candle.volumeType ?? candle.volume_type ?? '').toLowerCase();
  if (/tick/.test(declared)) {
    return { value, source: 'broker tick volume' };
  }
  if (/real|exchange/.test(declared)) {
    return { value, source: 'provider-labelled real/exchange volume' };
  }
  return { value, source: 'reported volume (type unspecified)' };
}

const unavailableResult = (detail, lookback = 20) => ({
  ready: false,
  signal: 'UNAVAILABLE',
  label: 'Volume data unavailable',
  confidence: 'None',
  source: 'unavailable',
  relativeVolume: null,
  spreadRatio: null,
  closeLocation: null,
  direction: 0,
  lookback,
  detail,
  caveat: 'No volume-based confirmation is used.'
});

export function analyzeVSA(candles, lookback = 20) {
  if (!Number.isInteger(lookback) || lookback < 2 || lookback > 500) {
    return unavailableResult('VSA lookback must be a whole number between 2 and 500 bars.', lookback);
  }

  if (!Array.isArray(candles) || candles.length < lookback + 1) {
    return unavailableResult(`VSA requires ${lookback} prior candles plus the current candle.`);
  }

  const sample = candles.slice(-(lookback + 1));
  const parsed = sample.map(candle => {
    const open = toFiniteNumber(candle?.open);
    const high = toFiniteNumber(candle?.high);
    const low = toFiniteNumber(candle?.low);
    const close = toFiniteNumber(candle?.close);
    const volume = readVolume(candle);
    const validOHLC = [open, high, low, close].every(value => value !== null) &&
      high >= Math.max(open, close, low) &&
      low <= Math.min(open, close, high);
    return { open, high, low, close, volume: volume.value, source: volume.source, validOHLC };
  });

  if (parsed.some(c => !c.validOHLC)) {
    return unavailableResult('VSA is unavailable because the selected lookback contains invalid OHLC values.', lookback);
  }

  if (parsed.some(c => c.volume === null || c.volume <= 0)) {
    return unavailableResult('VSA is unavailable because the selected lookback contains missing, zero, or invalid volume values.', lookback);
  }

  const sourceSet = [...new Set(parsed.map(c => c.source))];
  if (sourceSet.length !== 1) {
    return {
      ...unavailableResult('VSA is unavailable because the selected lookback mixes different volume sources. Use one consistent volume source.', lookback),
      source: 'mixed volume sources'
    };
  }

  const current = parsed.at(-1);
  const prior = parsed.slice(0, -1);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const avgVolume = mean(prior.map(c => c.volume));
  const avgSpread = mean(prior.map(c => c.high - c.low));
  const spread = current.high - current.low;

  if (!(avgVolume > 0) || !(avgSpread > 0) || !(spread > 0)) {
    return unavailableResult('VSA is unavailable because average volume, average spread, or current candle spread is zero.', lookback);
  }

  const relativeVolume = current.volume / avgVolume;
  const spreadRatio = spread / avgSpread;
  const closeLocation = (current.close - current.low) / spread;
  const bullish = current.close > current.open;
  const bearish = current.close < current.open;
  const priorClose = prior.at(-1).close;
  const priorClose2 = prior.length > 1 ? prior.at(-2).close : priorClose;
  const risingContext = priorClose > priorClose2;
  const fallingContext = priorClose < priorClose2;
  const priorHigh = Math.max(...prior.map(c => c.high));

  let result = {
    ready: true,
    signal: 'NEUTRAL',
    label: 'No clear VSA event',
    confidence: 'Low',
    source: sourceSet[0],
    relativeVolume,
    spreadRatio,
    closeLocation,
    direction: 0,
    lookback,
    detail: `Current volume is ${relativeVolume.toFixed(2)}× the prior ${lookback}-bar average; spread is ${spreadRatio.toFixed(2)}× average. No defined VSA pattern was met.`,
    caveat: 'VSA describes candle spread and reported activity; it does not reveal participant identity or prove institutional activity.'
  };

  if (bullish && risingContext && spreadRatio < 0.8 && relativeVolume < 0.8) {
    result = { ...result, signal: 'NO_DEMAND', label: 'Potential No Demand', confidence: 'Moderate', direction: -1,
      detail: 'An up-close candle has narrow spread and below-average volume after a rising sequence; demand may be weak. Wait for subsequent confirmation.' };
  } else if (bearish && fallingContext && spreadRatio < 0.8 && relativeVolume < 0.8) {
    result = { ...result, signal: 'NO_SUPPLY', label: 'Potential No Supply', confidence: 'Moderate', direction: 1,
      detail: 'A down-close candle has narrow spread and below-average volume after a falling sequence; selling pressure may be drying up. Wait for subsequent confirmation.' };
  } else if (bearish && spreadRatio >= 1.3 && relativeVolume >= 1.5 && closeLocation >= 0.55) {
    result = { ...result, signal: 'STOPPING_VOLUME', label: 'Potential Stopping Volume', confidence: 'Moderate', direction: 1,
      detail: 'A wide down-spread candle closes in its upper portion on elevated volume, which can indicate responsive buying. A later bullish test/reversal is needed.' };
  } else if (current.high > priorHigh && closeLocation <= 0.35 && relativeVolume >= 1.2) {
    result = { ...result, signal: 'UPTHRUST', label: 'Potential Upthrust', confidence: 'Moderate', direction: -1,
      detail: 'Price exceeded the prior lookback high but closed in the lower portion of its range on elevated volume; confirm with follow-through.' };
  } else if (relativeVolume >= 1.8 && spreadRatio <= 0.75) {
    result = { ...result, signal: 'EFFORT_NO_RESULT', label: 'High Effort / Low Result', confidence: 'Low', direction: 0,
      detail: 'Volume is unusually high relative to a narrow spread. This may reflect absorption or balance, but direction cannot be inferred from this candle alone.' };
  }

  return result;
}
