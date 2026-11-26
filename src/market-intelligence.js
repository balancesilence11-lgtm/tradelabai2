import { analyzeVSA, readVolume } from './vsa.js';

const num = value => {
  if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).map(c => ({
    open: num(c?.open),
    high: num(c?.high),
    low: num(c?.low),
    close: num(c?.close),
    volume: readVolume(c),
    time: c?.time ?? c?.timestamp ?? c?.datetime
  })).filter(c =>
    [c.open, c.high, c.low, c.close].every(v => v !== null) &&
    c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close, c.high)
  );
}

const unavailableVolumeSignal = (label, detail) => ({
  ready: false, label, direction: 0, score: 0, detail
});

/**
 * Integrated rule-based market intelligence.
 * Volume-derived outputs are only calculated when the selected candle window
 * has complete, positive and source-consistent volume data.
 */
export function analyzeMarketIntelligence(candles, options = {}) {
  const requestedLookback = options.lookback === undefined ? 20 : Number(options.lookback);
  const lookback = Number.isInteger(requestedLookback) && requestedLookback >= 10 && requestedLookback <= 100
    ? requestedLookback
    : 20;

  const clean = validCandles(candles);
  const vsa = analyzeVSA(candles, 20);
  const unavailable = { ready: false, label: 'Insufficient candle history', direction: 0, score: 0, detail: 'At least 10 valid candles are required.' };

  if (clean.length < 10) {
    return {
      ready: false, vsa, pressure: unavailable,
      absorption: unavailable, exhaustion: unavailable,
      zones: { supply: null, demand: null },
      volumeIntegrity: { ready: false, source: 'unavailable', validCandles: 0, expectedCandles: 0, issue: 'Insufficient valid OHLC candles.' },
      summary: 'Insufficient valid candle data for market intelligence.',
      caveat: 'No directional market-intelligence vote is added.'
    };
  }

  const recent = clean.slice(-lookback);
  const volRows = recent.map(c => ({
    ...c,
    spread: c.high - c.low,
    body: Math.abs(c.close - c.open),
    volumeSource: c.volume.source,
    volume: c.volume.value
  }));
  const current = volRows.at(-1);
  const sourceNames = [...new Set(volRows.filter(c => c.volume !== null && c.volume > 0).map(c => c.volumeSource))];
  const missingVolume = volRows.some(c => c.volume === null || c.volume <= 0);
  const mixedSources = sourceNames.length > 1;
  const volumeReady = !missingVolume && !mixedSources && sourceNames.length === 1;
  const volumeSource = volumeReady ? sourceNames[0] : mixedSources ? 'mixed volume sources' : 'unavailable';
  const volumeIntegrity = {
    ready: volumeReady,
    source: volumeSource,
    validCandles: volRows.filter(c => c.volume !== null && c.volume > 0).length,
    expectedCandles: volRows.length,
    issue: volumeReady ? null : mixedSources
      ? 'The selected lookback mixes volume sources; volume-based analysis is disabled for this window.'
      : 'The selected lookback contains missing, zero or invalid volume; volume-based analysis is disabled for this window.'
  };

  const priorRows = volRows.slice(0, -1);
  const averageVolume = volumeReady ? mean(priorRows.map(c => c.volume)) : null;
  const currentRelativeVolume = averageVolume > 0 && current.volume !== null
    ? current.volume / averageVolume
    : null;
  const averageSpread = mean(priorRows.map(c => c.spread));
  const spreadRatio = averageSpread > 0 ? current.spread / averageSpread : null;

  let pressure = unavailableVolumeSignal(
    'Volume pressure unavailable',
    volumeIntegrity.issue || 'A valid reported volume series is required to estimate volume-weighted pressure.'
  );
  if (volumeReady && currentRelativeVolume !== null && volRows.length >= 10) {
    const directional = volRows.map(c => {
      const range = Math.max(c.spread, Number.EPSILON);
      const closePosition = Math.max(0, Math.min(1, (c.close - c.low) / range));
      const buy = closePosition * c.volume;
      const sell = (1 - closePosition) * c.volume;
      return { buy, sell };
    });
    const totalBuy = directional.reduce((s, x) => s + x.buy, 0);
    const totalSell = directional.reduce((s, x) => s + x.sell, 0);
    const total = totalBuy + totalSell;
    const imbalance = total > 0 ? (totalBuy - totalSell) / total : 0;
    const direction = imbalance >= 0.18 ? 1 : imbalance <= -0.18 ? -1 : 0;
    pressure = {
      ready: true,
      label: direction > 0 ? 'Buying pressure dominant' : direction < 0 ? 'Selling pressure dominant' : 'Balanced buying / selling pressure',
      direction,
      score: Math.round(Math.abs(imbalance) * 100),
      buyPressure: Math.round((totalBuy / (total || 1)) * 100),
      sellPressure: Math.round((totalSell / (total || 1)) * 100),
      imbalance,
      source: volumeSource,
      detail: `Close-location-weighted ${volumeSource} proxy: ${Math.round((totalBuy / (total || 1)) * 100)}% buying-side versus ${Math.round((totalSell / (total || 1)) * 100)}% selling-side pressure. This is an estimate, not order-book flow.`
    };
  }

  let absorption = unavailableVolumeSignal(
    'Absorption not assessed',
    volumeIntegrity.issue || 'Volume and spread history are required.'
  );
  if (vsa.ready && volumeReady && currentRelativeVolume !== null && spreadRatio !== null) {
    const closeLocation = (current.close - current.low) / Math.max(current.spread, Number.EPSILON);
    const narrowHighEffort = currentRelativeVolume >= 1.5 && spreadRatio <= 0.8;
    const bearishAbsorption = narrowHighEffort && closeLocation >= 0.6;
    const bullishAbsorption = narrowHighEffort && closeLocation <= 0.4;
    absorption = {
      ready: true,
      label: bullishAbsorption ? 'Potential buying absorption' : bearishAbsorption ? 'Potential selling absorption' : narrowHighEffort ? 'High effort / narrow result — direction unclear' : 'No clear absorption signature',
      direction: bullishAbsorption ? 1 : bearishAbsorption ? -1 : 0,
      relativeVolume: currentRelativeVolume,
      spreadRatio,
      source: volumeSource,
      detail: narrowHighEffort
        ? 'Elevated, source-consistent reported volume with a compressed candle range may indicate opposing activity or balance. Confirm with subsequent candles and nearby structure.'
        : 'No high-volume, narrow-spread absorption candidate was found in the latest candle.'
    };
  }

  const prior = recent.slice(0, -1);
  const priorTrend = prior.length >= 5 ? prior.at(-1).close - prior[0].close : 0;
  const trendDirection = Math.sign(priorTrend);
  const recentSpread = mean(volRows.slice(-5).map(c => c.spread));
  const olderSpread = mean(volRows.slice(-10, -5).map(c => c.spread));
  let exhaustion = unavailableVolumeSignal(
    'Exhaustion not assessed',
    volumeIntegrity.issue || 'At least 10 source-consistent volume candles are required.'
  );

  if (volumeReady && volRows.length >= 10) {
    const recentVolume = volRows.slice(-5).map(c => c.volume);
    const olderVolume = volRows.slice(-10, -5).map(c => c.volume);
    const volDeclining = mean(recentVolume) < mean(olderVolume) * 0.75;
    const spreadDeclining = recentSpread !== null && olderSpread !== null && recentSpread < olderSpread * 0.8;
    const climactic = vsa.ready && currentRelativeVolume !== null && currentRelativeVolume >= 2 && spreadRatio !== null && spreadRatio >= 1.5;

    exhaustion = {
      ready: true,
      label: climactic
        ? (trendDirection > 0 ? 'Potential buying climax' : trendDirection < 0 ? 'Potential selling climax' : 'Potential volume climax')
        : volDeclining && spreadDeclining ? 'Momentum / participation contraction' : 'No clear exhaustion signature',
      direction: climactic ? -trendDirection : 0,
      source: volumeSource,
      detail: climactic
        ? 'The latest candle has unusually high volume and a wide spread after the observed trend. A reversal is not confirmed; wait for structure and follow-through.'
        : volDeclining && spreadDeclining
          ? 'Recent average volume and spread have contracted versus the preceding sample. This may indicate reduced participation or momentum, not a reversal by itself.'
          : 'No defined climax or sustained contraction was detected.'
    };
  }

  // Candidate zones use the last opposing candle preceding a meaningful move.
  // They are price areas only; no claim of resting institutional orders is made.
  const averageRange = mean(recent.map(c => c.high - c.low));
  let demand = null;
  let supply = null;
  for (let i = Math.max(0, recent.length - 12); i < recent.length - 1; i++) {
    const c = recent[i], next = recent[i + 1];
    const body = Math.abs(next.close - next.open);
    if (averageRange && body >= averageRange * 1.25) {
      if (next.close > next.open && c.close < c.open) {
        demand = { low: c.low, high: Math.max(c.open, c.close), label: 'Potential demand zone', index: i };
      }
      if (next.close < next.open && c.close > c.open) {
        supply = { low: Math.min(c.open, c.close), high: c.high, label: 'Potential supply zone', index: i };
      }
    }
  }

  // Only ready, source-consistent volume analyses contribute to volume confluence.
  const aligned = [vsa, pressure, absorption, exhaustion]
    .filter(signal => signal.ready)
    .map(signal => signal.direction)
    .filter(Boolean);
  const bullishCount = aligned.filter(direction => direction > 0).length;
  const bearishCount = aligned.filter(direction => direction < 0).length;
  const confluenceDirection = bullishCount > bearishCount ? 'BULLISH' : bearishCount > bullishCount ? 'BEARISH' : 'MIXED';
  const summary = `${confluenceDirection} volume intelligence: ${vsa.ready ? vsa.label : 'VSA unavailable'}; ${pressure.label}; ${absorption.label}; ${exhaustion.label}.`;

  return {
    ready: true,
    vsa,
    pressure,
    absorption,
    exhaustion,
    zones: { supply, demand },
    volumeSource,
    volumeIntegrity,
    confluence: { direction: confluenceDirection, bullish: bullishCount, bearish: bearishCount, inputs: aligned.length },
    summary,
    caveat: 'Rule-based candle and reported-volume estimates only. These outputs do not identify institutions, prove order flow, or predict outcomes. Volume-derived signals are withheld when the selected window has mixed or incomplete volume data. Zone candidates require price confirmation.'
  };
}

export function buildMarketIntelligenceExplanation({ direction = 'WAIT', intelligence, structure = null, mtf = null } = {}) {
  if (!intelligence?.ready) return 'Market intelligence is limited by insufficient valid candle history.';
  const parts = [`Current technical direction: ${direction}.`, intelligence.summary];
  if (intelligence.volumeIntegrity && !intelligence.volumeIntegrity.ready) {
    parts.push(`Volume integrity warning: ${intelligence.volumeIntegrity.issue}`);
  }
  if (structure) parts.push(`Market structure: ${structure}.`);
  if (mtf) parts.push(`Higher-timeframe context: ${mtf}.`);
  if (direction === 'WAIT') parts.push('Directional confirmation is incomplete; wait for a completed-candle confirmation rather than forcing a trade.');
  else parts.push('Treat this as a conditional setup. Confirm location, spread, execution costs and risk before any order.');
  return parts.join(' ');
}
