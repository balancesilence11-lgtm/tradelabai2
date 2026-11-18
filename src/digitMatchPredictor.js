/* TradeLab AI — Statistical Digit Analysis Engine
 * Version 2.0
 *
 * Important: This engine reports empirical estimates, not guaranteed forecasts.
 * It never treats historical frequency alone as proof of a predictive edge.
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
    this.maxHistory = Math.max(100, Number(options.maxHistory) || 10000);
    this.minSamples = Math.max(20, Number(options.minSamples) || 200);
    this.alpha = Math.max(0.01, Number(options.alpha) || 1);
    this.decay = clamp(Number(options.decay) || 0.995, 0.9, 0.9999);
    this.windows = [...new Set((options.windows || DEFAULT_WINDOWS).map(Number).filter(n => n > 0))].sort((a, b) => a - b);
    this.history = [];
    this.predictions = [];
    this.lastPrediction = null;
    this.lastTickKey = null;
    this.maxPredictions = Math.max(1000, Number(options.maxPredictions) || 20000);
  }

  extractDigit(quote, pipSize) {
    const value = Number(quote);
    if (!Number.isFinite(value)) return null;
    const supplied = Number(pipSize);
    const decimals = Number.isInteger(supplied) && supplied >= 0
      ? Math.min(10, supplied)
      : (String(quote).includes('.') ? String(quote).split('.')[1].length : 2);
    const formatted = value.toFixed(decimals);
    const digits = formatted.replace(/\D/g, '');
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

  getAllWindowAnalysis() {
    return this.windows.map(window => this.getWindowAnalysis(window));
  }

  getWeightedProbabilities() {
    const weights = Array(DIGITS).fill(0);
    let totalWeight = 0;
    for (let i = 0; i < this.history.length; i++) {
      const weight = Math.pow(this.decay, this.history.length - 1 - i);
      weights[this.history[i].digit] += weight;
      totalWeight += weight;
    }
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
    const total = row.reduce((sum, count) => sum + count, 0);
    return {
      matrix,
      lastDigit,
      observations: total,
      probabilities: row.map((count, digit) => ({ digit, count, probability: (count + this.alpha) / (total + DIGITS * this.alpha) }))
    };
  }

  predict() {
    const samples = this.history.length;
    if (samples < this.minSamples) {
      const waiting = { ready: false, samples, required: this.minSamples, message: 'Collecting more market observations', baseline: 10, windows: this.getAllWindowAnalysis() };
      this.lastPrediction = null;
      return waiting;
    }

    const historical = this.getDistribution();
    const recentRecords = this.history.slice(-Math.min(500, samples));
    const recent = this._distribution(recentRecords);
    const weighted = this.getWeightedProbabilities();
    const transition = this.getTransitionAnalysis();
    const transitionUsable = transition.observations >= 20;
    const scores = [];

    for (let digit = 0; digit < DIGITS; digit++) {
      const longProbability = historical[digit].posteriorProbability;
      const recentProbability = recent[digit].posteriorProbability;
      const weightedProbability = weighted[digit].probability;
      const transitionProbability = transition.probabilities[digit].probability;
      const transitionWeight = transitionUsable ? 0.15 : 0;
      const baseWeight = 0.35;
      const recentWeight = 0.30;
      const weightedWeight = 0.20 - transitionWeight;
      const score = longProbability * baseWeight + recentProbability * recentWeight + weightedProbability * weightedWeight + transitionProbability * transitionWeight;

      scores.push({
        digit,
        score,
        estimatedProbability: score,
        historicalProbability: historical[digit].probability,
        posteriorProbability: longProbability,
        recentProbability,
        weightedProbability,
        transitionProbability,
        sampleCount: historical[digit].count,
        deviationPct: historical[digit].deviationPct
      });
    }

    scores.sort((a, b) => b.score - a.score || a.digit - b.digit);
    const best = scores[0];
    const second = scores[1];

    const prediction = {
      ready: true,
      predictedDigit: best.digit,
      probability: best.score,
      estimatedProbability: best.score,
      confidence: null,
      confidenceLabel: 'Uncalibrated estimate',
      baseline: 10,
      edge: (best.score - 0.1) * 100,
      secondBest: second.digit,
      sampleSize: samples,
      lastObservedDigit: this.history[samples - 1].digit,
      distribution: historical,
      rankings: scores,
      windows: this.getAllWindowAnalysis(),
      transition: { lastDigit: transition.lastDigit, observations: transition.observations, probabilities: transition.probabilities },
      recentSampleSize: recentRecords.length,
      timestamp: Date.now()
    };

    this.lastPrediction = prediction;
    this.predictions.push({ ...prediction, evaluated: false });

    if (this.predictions.length > this.maxPredictions) {
      this.predictions.splice(0, this.predictions.length - this.maxPredictions);
    }

    return prediction;
  }

  evaluate(actualDigit) {
    if (!this.lastPrediction) return null;
    const actual = Number(actualDigit);
    if (!Number.isInteger(actual) || actual < 0 || actual > 9) return null;

    const prediction = this.lastPrediction;
    const result = {
      predicted: prediction.predictedDigit,
      actual,
      correct: prediction.predictedDigit === actual,
      predictedProbability: prediction.estimatedProbability,
      timestamp: Date.now(),
      evaluated: true
    };

    for (let i = this.predictions.length - 1; i >= 0; i--) {
      if (this.predictions[i].evaluated === false && this.predictions[i].timestamp === prediction.timestamp) {
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
    const losses = evaluated.length - wins;
    const total = evaluated.length;
    const accuracy = total ? wins / total * 100 : 0;

    const meanPredictedProbability = total
      ? evaluated.reduce((sum, item) => sum + (Number(item.predictedProbability) || 0), 0) / total
      : 0;

    return {
      total, wins, losses, accuracy,
      randomBaseline: 10,
      baselineDifference: accuracy - 10,
      meanPredictedProbability: meanPredictedProbability * 100,
      status: total < 100 ? 'INSUFFICIENT_EVALUATIONS' : (accuracy > 10 ? 'ABOVE_BASELINE_OBSERVED' : 'NOT_ABOVE_BASELINE_OBSERVED')
    };
  }

  getRecentPerformance(limit = 100) {
    const evaluated = this.predictions.filter(item => item.evaluated === true).slice(-Math.max(1, Number(limit) || 100));
    const wins = evaluated.filter(item => item.correct).length;

    return {
      total: evaluated.length,
      wins,
      losses: evaluated.length - wins,
      accuracy: evaluated.length ? wins / evaluated.length * 100 : 0,
      randomBaseline: 10
    };
  }

  reset() {
    this.history = [];
    this.predictions = [];
    this.lastPrediction = null;
    this.lastTickKey = null;
  }
}

export default DigitMatchPredictor;
