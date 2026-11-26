import { analyzeVSA } from './vsa.js';

const num = value => Number.isFinite(Number(value)) ? Number(value) : null;
const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

function volumeOf(candle) {
  if (!candle || typeof candle !== 'object') return { value: null, source: 'unavailable' };
  for (const key of ['tick_volume', 'tickVolume', 'tickvol']) {
    const value = num(candle[key]);
    if (value != null && value > 0) return { value, source: 'broker tick volume' };
  }
  for (const key of ['real_volume', 'realVolume', 'exchangeVolume']) {
    const value = num(candle[key]);
    if (value != null && value > 0) return { value, source: 'provider-labelled real/exchange volume' };
  }
  const value = num(candle.volume);
  if (value == null || value <= 0) return { value: null, source: 'unavailable' };
  const declared = String(candle.volumeType || candle.volume_type || '').toLowerCase();
  return { value, source: /tick/.test(declared) ? 'broker tick volume' : /real|exchange/.test(declared) ? 'provider-labelled real/exchange volume' : 'reported volume (type unspecified)' };
}

function validCandles(candles) {
  return (Array.isArray(candles) ? candles : []).map(c => ({
    open: num(c?.open), high: num(c?.high), low: num(c?.low), close: num(c?.close),
    volume: volumeOf(c), time: c?.time ?? c?.timestamp ?? c?.datetime
  })).filter(c => [c.open, c.high, c.low, c.close].every(v => v != null) && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high));
}

/**
 * Integrated rule-based market intelligence. Outputs are hypotheses from supplied
 * candles, not verified order flow, participant identity, or a probability forecast.
 */
export function analyzeMarketIntelligence(candles, options = {}) {
  const lookback = Math.max(10, Math.min(100, Number(options.lookback) || 20));
  const clean = validCandles(candles);
  const vsa = analyzeVSA(candles, 20);
  const unavailable = { ready: false, label: 'Insufficient candle history', direction: 0, score: 0, detail: 'At least 10 valid candles are required.' };
  if (clean.length < 10) return {
    ready: false, vsa, pressure: unavailable, absorption: unavailable, exhaustion: unavailable,
    zones: { supply: null, demand: null }, summary: 'Insufficient valid candle data for market intelligence.',
    caveat: 'No directional market-intelligence vote is added.'
  };

  const recent = clean.slice(-lookback);
  const volRows = recent.map(c => ({ ...c, spread: c.high - c.low, body: Math.abs(c.close - c.open), volumeSource: c.volume.source, volume: c.volume.value }));
  const usableVolume = volRows.filter(c => c.volume != null && c.volume > 0);
  const sourceNames = [...new Set(usableVolume.map(c => c.volumeSource))];
  const volumeSource = sourceNames.length === 1 ? sourceNames[0] : sourceNames.length ? 'mixed volume sources' : 'unavailable';
  const averageVolume = mean(usableVolume.slice(0, -1).map(c => c.volume));
  const current = volRows.at(-1);
  const currentRelativeVolume = current.volume != null && averageVolume > 0 ? current.volume / averageVolume : null;
  const averageSpread = mean(volRows.slice(0, -1).map(c => c.spread));
  const spreadRatio = averageSpread > 0 ? current.spread / averageSpread : null;

  let pressure = { ready: false, label: 'Volume pressure unavailable', direction: 0, score: 0, buyPressure: null, sellPressure: null, detail: 'A valid reported volume series is required to estimate volume-weighted pressure.' };
  if (usableVolume.length >= Math.min(10, lookback) && currentRelativeVolume != null) {
    const directional = usableVolume.slice(-lookback).map(c => {
      const range = Math.max(c.high - c.low, Number.EPSILON);
      const closePosition = (c.close - c.low) / range;
      const buy = closePosition * c.volume;
      const sell = (1 - closePosition) * c.volume;
      return { buy, sell, signed: buy - sell, volume: c.volume };
    });
    const totalBuy = directional.reduce((s, x) => s + x.buy, 0);
    const totalSell = directional.reduce((s, x) => s + x.sell, 0);
    const total = totalBuy + totalSell;
    const imbalance = total > 0 ? (totalBuy - totalSell) / total : 0;
    const direction = imbalance >= 0.18 ? 1 : imbalance <= -0.18 ? -1 : 0;
    pressure = {
      ready: true, label: direction > 0 ? 'Buying pressure dominant' : direction < 0 ? 'Selling pressure dominant' : 'Balanced buying / selling pressure',
      direction, score: Math.round(Math.abs(imbalance) * 100), buyPressure: Math.round((totalBuy / (total || 1)) * 100),
      sellPressure: Math.round((totalSell / (total || 1)) * 100), imbalance,
      source: volumeSource,
      detail: `Close-location-weighted volume proxy: ${Math.round((totalBuy / (total || 1)) * 100)}% buying-side versus ${Math.round((totalSell / (total || 1)) * 100)}% selling-side pressure. This is an estimate, not order-book flow.`
    };
  }

  let absorption = { ready: false, label: 'Absorption not assessed', direction: 0, detail: 'Volume and spread history are required.' };
  if (vsa.ready && currentRelativeVolume != null && spreadRatio != null) {
    const closeLocation = (current.close - current.low) / Math.max(current.spread, Number.EPSILON);
    const narrowHighEffort = currentRelativeVolume >= 1.5 && spreadRatio <= 0.8;
    const bearishAbsorption = narrowHighEffort && closeLocation >= 0.6;
    const bullishAbsorption = narrowHighEffort && closeLocation <= 0.4;
    absorption = {
      ready: true,
      label: bullishAbsorption ? 'Potential buying absorption' : bearishAbsorption ? 'Potential selling absorption' : narrowHighEffort ? 'High effort / narrow result — direction unclear' : 'No clear absorption signature',
      direction: bullishAbsorption ? 1 : bearishAbsorption ? -1 : 0,
      relativeVolume: currentRelativeVolume, spreadRatio,
      detail: narrowHighEffort ? 'Elevated reported volume with a compressed candle range may indicate opposing activity or balance. Confirm with subsequent candles and nearby structure.' : 'No high-volume, narrow-spread absorption candidate was found in the latest candle.'
    };
  }

  const prior = recent.slice(0, -1);
  const priorTrend = prior.length >= 5 ? prior.at(-1).close - prior[0].close : 0;
  const trendDirection = Math.sign(priorTrend);
  const recentVolume = usableVolume.slice(-5).map(c => c.volume);
  const olderVolume = usableVolume.slice(-10, -5).map(c => c.volume);
  const recentSpread = mean(volRows.slice(-5).map(c => c.spread));
  const olderSpread = mean(volRows.slice(-10, -5).map(c => c.spread));
  const volDeclining = mean(recentVolume) != null && mean(olderVolume) != null && mean(recentVolume) < mean(olderVolume) * 0.75;
  const spreadDeclining = recentSpread != null && olderSpread != null && recentSpread < olderSpread * 0.8;
  const climactic = vsa.ready && currentRelativeVolume >= 2 && spreadRatio >= 1.5;
  const exhaustionReady = usableVolume.length >= 10;
  const exhaustion = {
    ready: exhaustionReady,
    label: climactic ? (trendDirection > 0 ? 'Potential buying climax' : trendDirection < 0 ? 'Potential selling climax' : 'Potential volume climax') : volDeclining && spreadDeclining ? 'Momentum / participation contraction' : 'No clear exhaustion signature',
    direction: climactic ? -trendDirection : 0,
    detail: climactic ? 'The latest candle has unusually high volume and a wide spread after the observed trend. A reversal is not confirmed; wait for structure and follow-through.' : volDeclining && spreadDeclining ? 'Recent average volume and spread have contracted versus the preceding sample. This may indicate reduced participation or momentum, not a reversal by itself.' : 'No defined climax or sustained contraction was detected.'
  };

  // Candidate zones use the last opposing candle preceding a meaningful move.
  // They are price areas only; no claim of resting institutional orders is made.
  const averageRange = mean(recent.map(c => c.high - c.low));
  let demand = null;
  let supply = null;
  for (let i = Math.max(0, recent.length - 12); i < recent.length - 1; i++) {
    const c = recent[i], next = recent[i + 1];
    const body = Math.abs(next.close - next.open);
    if (averageRange && body >= averageRange * 1.25) {
      if (next.close > next.open && c.close < c.open) demand = { low: c.low, high: Math.max(c.open, c.close), label: 'Potential demand zone', index: i };
      if (next.close < next.open && c.close > c.open) supply = { low: Math.min(c.open, c.close), high: c.high, label: 'Potential supply zone', index: i };
    }
  }

  const aligned = [vsa.direction, pressure.direction, absorption.direction, exhaustion.direction].filter(Boolean);
  const bullishCount = aligned.filter(d => d > 0).length;
  const bearishCount = aligned.filter(d => d < 0).length;
  const confluenceDirection = bullishCount > bearishCount ? 'BULLISH' : bearishCount > bullishCount ? 'BEARISH' : 'MIXED';
  const summary = `${confluenceDirection} volume intelligence: ${vsa.ready ? vsa.label : 'VSA unavailable'}; ${pressure.label}; ${absorption.label}; ${exhaustion.label}.`;
  return {
    ready: true, vsa, pressure, absorption, exhaustion,
    zones: { supply, demand }, volumeSource,
    confluence: { direction: confluenceDirection, bullish: bullishCount, bearish: bearishCount, inputs: aligned.length },
    summary,
    caveat: 'Rule-based candle and reported-volume estimates only. These outputs do not identify institutions, prove order flow, or predict outcomes. Zone candidates require price confirmation.'
  };
}

export function buildMarketIntelligenceExplanation({ direction = 'WAIT', intelligence, structure = null, mtf = null } = {}) {
  if (!intelligence?.ready) return 'Market intelligence is limited by insufficient valid candle history.';
  const parts = [`Current technical direction: ${direction}.`, intelligence.summary];
  if (structure) parts.push(`Market structure: ${structure}.`);
  if (mtf) parts.push(`Higher-timeframe context: ${mtf}.`);
  if (direction === 'WAIT') parts.push('Directional confirmation is incomplete; wait for a completed-candle confirmation rather than forcing a trade.');
  else parts.push('Treat this as a conditional setup. Confirm location, spread, execution costs and risk before any order.');
  return parts.join(' ');
}
