/* TradeLab AI — Digit Match Analysis Engine
 * Phase 4: walk-forward validation and reliability diagnostics.
 * Estimates are descriptive only; no prediction is guaranteed.
 */

const DIGITS = 10;
const DEFAULT_WINDOWS = [100, 500, 1000, 5000];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function wilsonInterval(successes, total, z = 1.96) {
  if (!total) return { low: 0, high: 1 };
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p) / total) + (z2 / (4 * total * total)))) / denominator;
  return { low: clamp(centre - margin, 0, 1), high: clamp(centre + margin, 0, 1) };
}

export class DigitMatchPredictor {
  constructor(options = {}) {
    this.maxHistory = Math.max(200, Number(options.maxHistory) || 5000);
    this.minSamples = Math.max(20, Number(options.minSamples) || 200);
    this.alpha = Math.max(0.01, Number(options.alpha) || 1);
    this.decay = clamp(Number(options.decay) || 0.995, 0.9, 0.9999);
    this.windows = [...new Set((options.windows || DEFAULT_WINDOWS).map(Number).filter(n => n > 0))].sort((a, b) => a - b);
    this.maxPredictions = Math.max(200, Number(options.maxPredictions) || 2000);
    this.history = [];
    this.predictions = [];
    this.lastPrediction = null;
    this.lastTickKey = null;
    this.latestAnalysis = null;
  }

  extractDigit(quote, pipSize) {
    const value = Number(quote);
    if (!Number.isFinite(value)) return null;
    const supplied = Number(pipSize);
    const decimals = Number.isInteger(supplied) && supplied >= 0
      ? Math.min(10, supplied)
      : (String(quote).includes('.') ? String(quote).split('.')[1].length : 2);
    const digits = value.toFixed(decimals).replace(/\D/g, '');
    return digits.length ? Number(digits.slice(-1)) : null;
  }

  addTick(tick) {
    if (!tick || tick.quote === undefined) return null;
    const digit = this.extractDigit(tick.quote, tick.pip_size);
    if (digit === null) return null;
    const timestamp = Number(tick.epoch) || Date.now();
    const key = `${timestamp}:${tick.quote}:${tick.symbol || ''}`;
    if (key === this.lastTickKey) return null;
    this.lastTickKey = key;
    const record = { digit, quote: Number(tick.quote), timestamp };
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.splice(0, this.history.length - this.maxHistory);
    return record;
  }

  _counts(records = this.history) {
    const counts = Array(DIGITS).fill(0);
    for (const item of records) if (Number.isInteger(item.digit) && item.digit >= 0 && item.digit < DIGITS) counts[item.digit]++;
    return counts;
  }

  _distribution(records = this.history) {
    const counts = this._counts(records);
    const total = records.length;
    return counts.map((count, digit) => {
      const interval = wilsonInterval(count, total);
      return {
        digit, count, samples: total,
        probability: total ? count / total : 0,
        posteriorProbability: (count + this.alpha) / (total + DIGITS * this.alpha),
        expectedCount: total / DIGITS,
        deviation: total ? count - total / DIGITS : 0,
        deviationPct: total ? ((count / total) - 0.1) * 100 : 0,
        confidenceInterval95: { low: interval.low, high: interval.high }
      };
    });
  }

  getDistribution() { return this._distribution(); }

  getWindowAnalysis(windowSize) {
    const size = Math.max(1, Math.floor(Number(windowSize) || 1));
    const records = this.history.slice(-size);
    return { window: size, samples: records.length, distribution: this._distribution(records) };
  }

  getAllWindowAnalysis() { return this.windows.map(window => this.getWindowAnalysis(window)); }

  getWeightedProbabilities() {
    const weights = Array(DIGITS).fill(0);
    let totalWeight = 0;
    this.history.forEach((item, index) => {
      const weight = Math.pow(this.decay, this.history.length - 1 - index);
      weights[item.digit] += weight;
      totalWeight += weight;
    });
    return weights.map((weight, digit) => ({ digit, probability: totalWeight ? weight / totalWeight : 0, weight }));
  }

  getTransitionProbabilities() {
    const matrix = Array.from({ length: DIGITS }, () => Array(DIGITS).fill(0));
    for (let i = 1; i < this.history.length; i++) matrix[this.history[i - 1].digit][this.history[i].digit]++;
    return matrix;
  }

  getTransitionAnalysis() {
    const matrix = this.getTransitionProbabilities();
    const lastDigit = this.history.length ? this.history[this.history.length - 1].digit : null;
    const row = lastDigit === null ? Array(DIGITS).fill(0) : matrix[lastDigit];
    const observations = row.reduce((sum, count) => sum + count, 0);
    return {
      matrix, lastDigit, observations,
      probabilities: row.map((count, digit) => ({ digit, count, probability: (count + this.alpha) / (observations + DIGITS * this.alpha) }))
    };
  }

  predict() {
    const samples = this.history.length;
    if (samples < this.minSamples) {
      this.lastPrediction = null;
      const waiting = { ready: false, samples, sampleSize: samples, required: this.minSamples, baseline: 10, message: 'Collecting more market observations', windows: this.getAllWindowAnalysis() };
      this.latestAnalysis = waiting;
      return waiting;
    }

    const historical = this.getDistribution();
    const recentRecords = this.history.slice(-Math.min(500, samples));
    const recent = this._distribution(recentRecords);
    const weighted = this.getWeightedProbabilities();
    const transition = this.getTransitionAnalysis();
    const transitionUsable = transition.observations >= 20;
    const frequencyProbabilities = historical.map(item => item.posteriorProbability);
    const trendProbabilities = recent.map(item => item.posteriorProbability);
    const markovProbabilities = transition.probabilities.map(item => item.probability);
    const scores = [];

    for (let digit = 0; digit < DIGITS; digit++) {
      const transitionWeight = transitionUsable ? 0.15 : 0;
      const frequencyWeight = 0.35;
      const trendWeight = 0.30;
      const weightedWeight = 0.20 - transitionWeight;
      const score = frequencyProbabilities[digit] * frequencyWeight
        + trendProbabilities[digit] * trendWeight
        + weighted[digit].probability * weightedWeight
        + markovProbabilities[digit] * transitionWeight;
      scores.push({
        digit, score, probability: score, estimatedProbability: score,
        historicalProbability: historical[digit].probability,
        recentProbability: trendProbabilities[digit],
        weightedProbability: weighted[digit].probability,
        transitionProbability: markovProbabilities[digit],
        sampleCount: historical[digit].count,
        deviationPct: historical[digit].deviationPct
      });
    }

    scores.sort((a, b) => b.score - a.score || a.digit - b.digit);
    const best = scores[0];
    const second = scores[1];
    const analysis = {
      ready: true,
      predictedDigit: best.digit,
      digit: best.digit,
      probability: best.score,
      percentage: best.score * 100,
      estimatedProbability: best.score,
      confidence: null,
      confidenceLabel: 'Uncalibrated estimate',
      baseline: 10,
      edge: (best.score - 0.1) * 100,
      secondBest: second.digit,
      sampleSize: samples,
      samples,
      required: this.minSamples,
      lastObservedDigit: this.history[samples - 1].digit,
      currentDigit: this.history[samples - 1].digit,
      distribution: historical,
      rankings: scores,
      ranking: scores.map(item => ({ digit: item.digit, probability: item.score, score: item.score })),
      windows: this.getAllWindowAnalysis(),
      transition: { lastDigit: transition.lastDigit, observations: transition.observations, probabilities: transition.probabilities },
      recentSampleSize: recentRecords.length,
      reliability: samples >= 1000 ? 'LARGE SAMPLE' : samples >= this.minSamples ? 'INITIAL SAMPLE' : 'COLLECTING DATA',
      recommendation: 'VALIDATE — NOT A TRADE SIGNAL',
      modelBreakdown: {
        frequency: { weight: 0.35, probabilities: frequencyProbabilities },
        trend: { weight: 0.30, probabilities: trendProbabilities },
        markov: { weight: transitionUsable ? 0.15 : 0, observations: transition.observations, probabilities: markovProbabilities },
        weightedFrequency: { weight: transitionUsable ? 0.05 : 0.20, probabilities: weighted.map(item => item.probability) }
      },
      timestamp: Date.now()
    };

    this.lastPrediction = {
      predictedDigit: best.digit,
      estimatedProbability: best.score,
      timestamp: analysis.timestamp,
      evaluated: false
    };
    this.latestAnalysis = analysis;
    this.predictions.push({
      timestamp: analysis.timestamp,
      predictedDigit: best.digit,
      estimatedProbability: best.score,
      evaluated: false
    });
    if (this.predictions.length > this.maxPredictions) this.predictions.splice(0, this.predictions.length - this.maxPredictions);
    return analysis;
  }

  evaluate(actualDigit) {
    if (!this.lastPrediction) return null;
    const actual = Number(actualDigit);
    if (!Number.isInteger(actual) || actual < 0 || actual > 9) return null;
    const forecast = this.lastPrediction;
    const result = {
      predicted: forecast.predictedDigit,
      predictedDigit: forecast.predictedDigit,
      actual,
      actualDigit: actual,
      correct: forecast.predictedDigit === actual,
      predictedProbability: forecast.estimatedProbability,
      timestamp: Date.now(),
      forecastTimestamp: forecast.timestamp,
      evaluated: true
    };
    for (let i = this.predictions.length - 1; i >= 0; i--) {
      if (!this.predictions[i].evaluated && this.predictions[i].timestamp === forecast.timestamp) {
        this.predictions[i] = { ...this.predictions[i], ...result };
        break;
      }
    }
    this.lastPrediction = null;
    return result;
  }

  getPerformance() {
    const evaluated = this.predictions.filter(item => item.evaluated === true);
    const wins = evaluated.filter(item => item.correct).length;
    const total = evaluated.length;
    const accuracy = total ? wins / total * 100 : 0;
    const interval = wilsonInterval(wins, total);
    let status = 'INSUFFICIENT EVALUATIONS';
    if (total >= 100) {
      if (interval.low * 100 > 10) status = 'ABOVE 10% BASELINE — OBSERVED';
      else if (interval.high * 100 < 10) status = 'BELOW 10% BASELINE — OBSERVED';
      else status = 'INCONCLUSIVE';
    }
    return {
      total, wins, losses: total - wins, correct: wins, incorrect: total - wins,
      accuracy, randomBaseline: 10, baselineDifference: accuracy - 10,
      confidenceInterval95: { low: interval.low * 100, high: interval.high * 100 },
      status
    };
  }

  getRecentPerformance(limit = 100) {
    const evaluated = this.predictions.filter(item => item.evaluated === true).slice(-Math.max(1, Number(limit) || 100));
    const wins = evaluated.filter(item => item.correct).length;
    const total = evaluated.length;
    return { total, wins, losses: total - wins, accuracy: total ? wins / total * 100 : 0, randomBaseline: 10 };
  }

  getDigitPerformance() {
    return Array.from({ length: DIGITS }, (_, digit) => {
      const rows = this.predictions.filter(item => item.evaluated === true && item.predictedDigit === digit);
      const wins = rows.filter(item => item.correct).length;
      const total = rows.length;
      const interval = wilsonInterval(wins, total);
      return {
        digit, total, wins, losses: total - wins,
        accuracy: total ? wins / total * 100 : 0,
        confidenceInterval95: { low: interval.low * 100, high: interval.high * 100 },
        status: total < 30 ? 'LOW SAMPLE' : (interval.low > 0.1 ? 'ABOVE BASELINE OBSERVED' : interval.high < 0.1 ? 'BELOW BASELINE OBSERVED' : 'INCONCLUSIVE')
      };
    });
  }

  getRecentEvaluations(limit = 50) {
    return this.predictions.filter(item => item.evaluated === true).slice(-Math.max(1, Number(limit) || 50)).reverse();
  }

  getLatestAnalysis() { return this.latestAnalysis; }
  getReliabilityStatus() { return this.getPerformance(); }

  exportState() {
    return {
      version: 4,
      history: this.history,
      predictions: this.predictions,
      lastPrediction: this.lastPrediction,
      lastTickKey: this.lastTickKey,
      latestAnalysis: this.latestAnalysis
    };
  }

  importState(state) {
    if (!state || state.version !== 4 || !Array.isArray(state.history) || !Array.isArray(state.predictions)) return false;
    this.history = state.history.slice(-this.maxHistory).filter(item => Number.isInteger(item.digit) && item.digit >= 0 && item.digit <= 9);
    this.predictions = state.predictions.slice(-this.maxPredictions);
    this.lastPrediction = state.lastPrediction || null;
    this.lastTickKey = state.lastTickKey || null;
    this.latestAnalysis = state.latestAnalysis || null;
    return true;
  }

  reset() {
    this.history = [];
    this.predictions = [];
    this.lastPrediction = null;
    this.lastTickKey = null;
    this.latestAnalysis = null;
  }
}

export default DigitMatchPredictor;
