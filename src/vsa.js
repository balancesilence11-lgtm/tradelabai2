/**
 * Volume Spread Analysis (VSA) — transparent OHLCV heuristics.
 * Volume source is labelled conservatively; generic `volume` is never assumed
 * to be exchange-traded volume. Signals are descriptive, not proof of intent.
 */
const finite = value => Number.isFinite(Number(value));

function readVolume(candle) {
  if (!candle || typeof candle !== 'object') return { value: null, source: 'unavailable' };
  const explicitTick = ['tick_volume', 'tickVolume', 'tickvol'].find(key =>
    finite(candle[key]) && Number(candle[key]) >= 0
  );
  if (explicitTick) return { value: Number(candle[explicitTick]), source: 'broker tick volume' };

  const explicitReal = ['real_volume', 'realVolume', 'exchangeVolume'].find(key =>
    finite(candle[key]) && Number(candle[key]) >= 0
  );
  if (explicitReal) return { value: Number(candle[explicitReal]), source: 'provider-labelled real/exchange volume' };

  if (finite(candle.volume) && Number(candle.volume) >= 0) {
    const declared = String(candle.volumeType || candle.volume_type || '').toLowerCase();
    if (/tick/.test(declared)) return { value: Number(candle.volume), source: 'broker tick volume' };
    if (/real|exchange/.test(declared)) return { value: Number(candle.volume), source: 'provider-labelled real/exchange volume' };
    return { value: Number(candle.volume), source: 'reported volume (type unspecified)' };
  }
  return { value: null, source: 'unavailable' };
}

export function analyzeVSA(candles, lookback = 20) {
  const unavailable = {
    ready: false,
    signal: 'UNAVAILABLE',
    label: 'Volume data unavailable',
    confidence: 'None',
    source: 'unavailable',
    relativeVolume: null,
    spreadRatio: null,
    closeLocation: null,
    direction: 0,
    detail: 'VSA requires at least 20 prior candles with valid, non-zero volume and OHLC data.',
    caveat: 'No volume-based confirmation is used.'
  };

  if (!Array.isArray(candles) || candles.length < lookback + 1) return unavailable;

  const sample = candles.slice(-(lookback + 1));
  const parsed = sample.map(candle => {
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = readVolume(candle);
    const validOHLC = [open, high, low, close].every(Number.isFinite) &&
      high >= Math.max(open, close, low) && low <= Math.min(open, close, high);
    return { open, high, low, close, volume: volume.value, source: volume.source, validOHLC };
  });

  if (parsed.some(c => !c.validOHLC || c.volume == null || c.volume <= 0)) {
    return {
      ...unavailable,
      detail: 'VSA is unavailable because the selected lookback contains missing, zero, or invalid volume/OHLC values.'
    };
  }

  const current = parsed.at(-1);
  const prior = parsed.slice(0, -1);
  const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
  const avgVolume = mean(prior.map(c => c.volume));
  const avgSpread = mean(prior.map(c => c.high - c.low));
  const spread = current.high - current.low;
  if (!(avgVolume > 0) || !(avgSpread > 0) || !(spread > 0)) return unavailable;

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
  const sourceSet = [...new Set(parsed.map(c => c.source))];
  const source = sourceSet.length === 1 ? sourceSet[0] : 'mixed volume sources';

  let result = {
    ready: true,
    signal: 'NEUTRAL',
    label: 'No clear VSA event',
    confidence: 'Low',
    source,
    relativeVolume,
    spreadRatio,
    closeLocation,
    direction: 0,
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
