import { analyzeVSA } from './vsa.js';

// ---------------- Basic utilities ----------------

const num = value => {
  if (
    value === null ||
    value === undefined ||
    (typeof value === 'string' && value.trim() === '')
  ) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const mean = values =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;

const unavailableVolumeSignal = (label, detail) => ({
  ready: false,
  label,
  direction: 0,
  score: 0,
  detail
});

// ---------------- Volume source identification ----------------

function volumeOf(candle) {
  if (!candle || typeof candle !== 'object') {
    return { value: null, source: 'unavailable' };
  }

  // Broker tick volume
  for (const key of ['tick_volume', 'tickVolume', 'tickvol']) {
    const value = num(candle[key]);

    if (value !== null && value > 0) {
      return {
        value,
        source: 'broker tick volume'
      };
    }
  }

  // Provider-labelled real or exchange volume
  for (const key of ['real_volume', 'realVolume', 'exchangeVolume']) {
    const value = num(candle[key]);

    if (value !== null && value > 0) {
      return {
        value,
        source: 'provider-labelled real/exchange volume'
      };
    }
  }

  // Generic volume field
  const value = num(candle.volume);

  if (value === null || value <= 0) {
    return {
      value: null,
      source: 'unavailable'
    };
  }

  const declared = String(
    candle.volumeType || candle.volume_type || ''
  ).toLowerCase();

  let source = 'reported volume (type unspecified)';

  if (/tick/.test(declared)) {
    source = 'broker tick volume';
  } else if (/real|exchange/.test(declared)) {
    source = 'provider-labelled real/exchange volume';
  }

  return { value, source };
}

// ---------------- Candle validation ----------------

function validCandles(candles) {
  if (!Array.isArray(candles)) return [];

  return candles
    .filter(c => c && typeof c === 'object')
    .map(c => ({
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: volumeOf(c),
      time: c.time ?? c.timestamp ?? c.datetime
    }))
    .filter(c =>
      [c.open, c.high, c.low, c.close].every(v => v !== null) &&
      c.high >= Math.max(c.open, c.close, c.low) &&
      c.low <= Math.min(c.open, c.close, c.high)
    );
}

// ---------------- Main market intelligence engine ----------------

export function analyzeMarketIntelligence(candles, options = {}) {
  const requestedLookback =
    options.lookback === undefined ? 20 : Number(options.lookback);

  const lookback =
    Number.isInteger(requestedLookback) &&
    requestedLookback >= 10 &&
    requestedLookback <= 100
      ? requestedLookback
      : 20;

  const clean = validCandles(candles);

  const unavailable = {
    ready: false,
    label: 'Insufficient candle history',
    direction: 0,
    score: 0,
    detail: 'At least 10 valid candles are required.'
  };

  if (clean.length < 10) {
    return {
      ready: false,
      vsa: unavailable,
      pressure: unavailable,
      absorption: unavailable,
      exhaustion: unavailable,
      zones: { supply: null, demand: null },
      volumeSource: 'unavailable',
      volumeIntegrity: {
        ready: false,
        source: 'unavailable',
        validCandles: 0,
        expectedCandles: 0,
        issue: 'At least 10 valid OHLC candles are required.'
      },
      confluence: {
        direction: 'MIXED',
        bullish: 0,
        bearish: 0,
        inputs: 0
      },
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

  const current = volRows[volRows.length - 1];
  const priorRows = volRows.slice(0, -1);

  // ---------------- Volume integrity ----------------

  const usableVolume = volRows.filter(
    c => c.volume !== null && c.volume > 0
  );

  const sourceNames = [
    ...new Set(usableVolume.map(c => c.volumeSource))
  ];

  const missingVolume = volRows.some(
    c => c.volume === null || c.volume <= 0
  );

  const mixedSources = sourceNames.length > 1;

  const volumeReady =
    !missingVolume &&
    !mixedSources &&
    sourceNames.length === 1;

  const volumeSource = volumeReady
    ? sourceNames[0]
    : mixedSources
      ? 'mixed volume sources'
      : 'unavailable';

  let volumeIssue = null;

  if (mixedSources) {
    volumeIssue =
      'The selected lookback mixes volume sources. Volume-based analysis is disabled for this window.';
  } else if (missingVolume) {
    volumeIssue =
      'The selected lookback contains missing, zero or invalid volume. Volume-based analysis is disabled for this window.';
  }

  const volumeIntegrity = {
    ready: volumeReady,
    source: volumeSource,
    validCandles: usableVolume.length,
    expectedCandles: volRows.length,
    issue: volumeIssue
  };

  // ---------------- Spread and volume calculations ----------------

  const averageVolume = volumeReady
    ? mean(priorRows.map(c => c.volume))
    : null;

  const currentRelativeVolume =
    volumeReady && averageVolume > 0
      ? current.volume / averageVolume
      : null;

  const averageSpread = mean(
    priorRows.map(c => c.spread)
  );

  const spreadRatio =
    averageSpread > 0
      ? current.spread / averageSpread
      : null;

  // ---------------- VSA analysis ----------------

  let vsa = unavailableVolumeSignal(
    'VSA unavailable',
    volumeIssue || 'Valid source-consistent volume data is required.'
  );

  if (volumeReady) {
    try {
      const vsaCandles = volRows.map(c => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        time: c.time
      }));

      const result = analyzeVSA(vsaCandles, lookback);

      if (result && typeof result === 'object') {
        vsa = {
          ...result,
          ready: result.ready === true,
          direction: result.ready === true
            ? (Number(result.direction) || 0)
            : 0,
          source: volumeSource
        };
      }
    } catch (error) {
      vsa = unavailableVolumeSignal(
        'VSA calculation failed',
        error?.message || 'Unable to calculate VSA.'
      );
    }
  }

  // ---------------- Buying and selling pressure ----------------
  // Close-location-weighted volume proxy, not true order flow.

  let pressure = unavailableVolumeSignal(
    'Volume pressure unavailable',
    volumeIssue || 'Valid reported volume data is required.'
  );

  if (volumeReady && currentRelativeVolume !== null) {
    const directional = volRows.map(c => {
      const range = Math.max(c.spread, Number.EPSILON);

      const closePosition = Math.max(
        0,
        Math.min(1, (c.close - c.low) / range)
      );

      const buy = closePosition * c.volume;
      const sell = (1 - closePosition) * c.volume;

      return { buy, sell };
    });

    const totalBuy = directional.reduce(
      (sum, c) => sum + c.buy,
      0
    );

    const totalSell = directional.reduce(
      (sum, c) => sum + c.sell,
      0
    );

    const total = totalBuy + totalSell;

    const imbalance =
      total > 0
        ? (totalBuy - totalSell) / total
        : 0;

    const direction =
      imbalance >= 0.18
        ? 1
        : imbalance <= -0.18
          ? -1
          : 0;

    pressure = {
      ready: true,
      label: direction > 0
        ? 'Buying pressure dominant'
        : direction < 0
          ? 'Selling pressure dominant'
          : 'Balanced buying / selling pressure',

      direction,
      score: Math.round(Math.abs(imbalance) * 100),

      buyPressure: Math.round(
        (totalBuy / (total || 1)) * 100
      ),

      sellPressure: Math.round(
        (totalSell / (total || 1)) * 100
      ),

      imbalance,
      source: volumeSource,

      detail:
        `Close-location-weighted ${volumeSource} proxy: ` +
        `${Math.round((totalBuy / (total || 1)) * 100)}% ` +
        `buying-side versus ` +
        `${Math.round((totalSell / (total || 1)) * 100)}% ` +
        `selling-side pressure. This is an estimate, not order-book flow.`
    };
  }

  // ---------------- Absorption detection ----------------

  let absorption = unavailableVolumeSignal(
    'Absorption not assessed',
    volumeIssue || 'Volume and spread history are required.'
  );

  if (
    vsa.ready &&
    volumeReady &&
    currentRelativeVolume !== null &&
    spreadRatio !== null
  ) {
    const closeLocation =
      (current.close - current.low) /
      Math.max(current.spread, Number.EPSILON);

    const narrowHighEffort =
      currentRelativeVolume >= 1.5 &&
      spreadRatio <= 0.8;

    const bullishAbsorption =
      narrowHighEffort && closeLocation <= 0.4;

    const bearishAbsorption =
      narrowHighEffort && closeLocation >= 0.6;

    absorption = {
      ready: true,

      label: bullishAbsorption
        ? 'Potential buying absorption'
        : bearishAbsorption
          ? 'Potential selling absorption'
          : narrowHighEffort
            ? 'High effort / narrow result — direction unclear'
            : 'No clear absorption signature',

      direction: bullishAbsorption
        ? 1
        : bearishAbsorption
          ? -1
          : 0,

      relativeVolume: currentRelativeVolume,
      spreadRatio,
      source: volumeSource,

      detail: narrowHighEffort
        ? 'Elevated, source-consistent volume with a compressed candle range may indicate opposing activity or balance. Confirm with subsequent candles and nearby structure.'
        : 'No high-volume, narrow-spread absorption candidate was found in the latest candle.'
    };
  }

  // ---------------- Exhaustion detection ----------------

  let exhaustion = unavailableVolumeSignal(
    'Exhaustion not assessed',
    volumeIssue || 'At least 10 source-consistent volume candles are required.'
  );

  if (volumeReady && volRows.length >= 10) {
    const recentVolume = volRows
      .slice(-5)
      .map(c => c.volume);

    const olderVolume = volRows
      .slice(-10, -5)
      .map(c => c.volume);

    const recentSpread = mean(
      volRows.slice(-5).map(c => c.spread)
    );

    const olderSpread = mean(
      volRows.slice(-10, -5).map(c => c.spread)
    );

    const recentTrend = volRows
      .slice(-6, -1);

    const priorTrend =
      recentTrend.length >= 2
        ? recentTrend[recentTrend.length - 1].close -
          recentTrend[0].close
        : 0;

    const trendDirection = Math.sign(priorTrend);

    const volDeclining =
      mean(recentVolume) < mean(olderVolume) * 0.75;

    const spreadDeclining =
      recentSpread !== null &&
      olderSpread !== null &&
      recentSpread < olderSpread * 0.8;

    const climactic =
      vsa.ready &&
      currentRelativeVolume !== null &&
      currentRelativeVolume >= 2 &&
      spreadRatio !== null &&
      spreadRatio >= 1.5;

    exhaustion = {
      ready: true,

      label: climactic
        ? trendDirection > 0
          ? 'Potential buying climax'
          : trendDirection < 0
            ? 'Potential selling climax'
            : 'Potential volume climax'
        : volDeclining && spreadDeclining
          ? 'Momentum / participation contraction'
          : 'No clear exhaustion signature',

      direction: climactic
        ? -trendDirection
        : 0,

      source: volumeSource,

      detail: climactic
        ? 'The latest candle has unusually high volume and a wide spread after the observed trend. A reversal is not confirmed; wait for structure and follow-through.'
        : volDeclining && spreadDeclining
          ? 'Recent average volume and spread have contracted versus the preceding sample. This may indicate reduced participation or momentum, not a reversal by itself.'
          : 'No defined climax or sustained contraction was detected.'
    };
  }

  // ---------------- Supply and demand zones ----------------
  // Price-based candidate zones; not verified institutional orders.

  let supply = null;
  let demand = null;

  const averageRange = mean(
    recent.map(c => c.high - c.low)
  );

  if (averageRange !== null && averageRange > 0) {
    for (let i = 0; i < recent.length - 1; i++) {
      const c = recent[i];
      const next = recent[i + 1];

      const body = Math.abs(next.close - next.open);

      if (body >= averageRange * 1.25) {
        if (
          next.close > next.open &&
          c.close < c.open
        ) {
          demand = {
            low: c.low,
            high: Math.max(c.open, c.close),
            label: 'Potential demand zone',
            index: i
          };
        }

        if (
          next.close < next.open &&
          c.close > c.open
        ) {
          supply = {
            low: Math.min(c.open, c.close),
            high: c.high,
            label: 'Potential supply zone',
            index: i
          };
        }
      }
    }
  }

  // ---------------- Confluence ----------------

  // Only ready signals contribute to confluence.

  const aligned = [vsa, pressure, absorption, exhaustion]
    .filter(signal => signal.ready)
    .map(signal => Number(signal.direction) || 0)
    .filter(direction => direction !== 0);

  const bullishCount = aligned.filter(
    direction => direction > 0
  ).length;

  const bearishCount = aligned.filter(
    direction => direction < 0
  ).length;

  const confluenceDirection =
    bullishCount > bearishCount
      ? 'BULLISH'
      : bearishCount > bullishCount
        ? 'BEARISH'
        : 'MIXED';

  const summary =
    `${confluenceDirection} volume intelligence: ` +
    `${vsa.ready ? vsa.label : 'VSA unavailable'}; ` +
    `${pressure.label}; ` +
    `${absorption.label}; ` +
    `${exhaustion.label}.`;

  // ---------------- Final output ----------------

  return {
    ready: true,

    vsa,
    pressure,
    absorption,
    exhaustion,

    zones: {
      supply,
      demand
    },

    volumeSource,
    volumeIntegrity,

    confluence: {
      direction: confluenceDirection,
      bullish: bullishCount,
      bearish: bearishCount,
      inputs: aligned.length
    },

    summary,

    caveat:
      'Rule-based candle and reported-volume estimates only. ' +
      'These outputs do not identify institutions, prove order flow, ' +
      'or predict outcomes. Volume-derived signals are withheld when ' +
      'the selected window has mixed or incomplete volume data. ' +
      'Zone candidates require price confirmation.'
  };
}

// ---------------- Market intelligence explanation ----------------

export function buildMarketIntelligenceExplanation({
  direction = 'WAIT',
  intelligence,
  structure = null,
  mtf = null
} = {}) {
  if (!intelligence?.ready) {
    return 'Market intelligence is limited by insufficient valid candle history.';
  }

  const parts = [
    `Current technical direction: ${direction}.`,
    intelligence.summary
  ];

  if (
    intelligence.volumeIntegrity &&
    !intelligence.volumeIntegrity.ready
  ) {
    parts.push(
      `Volume integrity warning: ${intelligence.volumeIntegrity.issue}`
    );
  }

  if (structure) {
    parts.push(`Market structure: ${structure}.`);
  }

  if (mtf) {
    parts.push(`Higher-timeframe context: ${mtf}.`);
  }

  if (direction === 'WAIT') {
    parts.push(
      'Directional confirmation is incomplete; wait for a completed-candle confirmation rather than forcing a trade.'
    );
  }

  return parts.join(' ');
}
