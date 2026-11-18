/*
 * TradeLab AI
 * Multi-Model Digit Match Prediction Engine
 * Phase 3
 *
 * Models:
 * 1. Historical Frequency
 * 2. Markov Transition
 * 3. Recent Trend
 * 4. Weighted Ensemble
 * 5. Reliability Filter
 *
 * IMPORTANT:
 * These are statistical estimates, not guaranteed predictions.
 */

const DIGITS = 10;

const DEFAULT_WINDOWS = [100, 500, 1000, 5000];

const clamp = (value, min, max) =>
  Math.max(min, Math.min(max, value));

const emptyCounts = () => Array(DIGITS).fill(0);

const uniformProbabilities = () =>
  Array(DIGITS).fill(0.1);

const normalize = (values) => {
  const total = values.reduce((sum, value) => sum + value, 0);

  if (!total) return uniformProbabilities();

  return values.map(value => value / total);
};

export class DigitMatchPredictor {

  constructor(options = {}) {

    this.maxHistory = options.maxHistory || 10000;
    this.minSamples = options.minSamples || 200;

    this.alpha = options.alpha ?? 1;
    this.decay = options.decay ?? 0.995;

    this.windows = options.windows || DEFAULT_WINDOWS;

    this.history = [];
    this.predictions = [];
    this.evaluations = [];

    this.lastPrediction = null;
    this.lastDigit = null;

    this.transitionMatrix = Array.from(
      { length: DIGITS },
      () => emptyCounts()
    );

    this.performance = {
      total: 0,
      correct: 0,
      incorrect: 0,
      accuracy: 0,
      baseline: 10
    };

    this.weights = {
      frequency: 0.50,
      markov: 0.25,
      trend: 0.25
    };
  }

  // ---------------------------------------
  // 1. DIGIT EXTRACTION
  // ---------------------------------------

  extractDigit(quote, pipSize) {

    if (quote === undefined || quote === null) {
      return null;
    }

    const decimals = Number(pipSize);

    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 10) {
      return null;
    }

    const formatted = Number(quote).toFixed(decimals);

    const match = formatted.match(/(\d)$/);

    if (!match) return null;

    const digit = Number(match[1]);

    return Number.isInteger(digit) && digit >= 0 && digit <= 9
      ? digit
      : null;
  }

  // ---------------------------------------
  // 2. ADD LIVE TICK
  // ---------------------------------------

  addTick(tick) {

    if (!tick) return false;

    const quote = Number(tick.quote);

    if (!Number.isFinite(quote)) return false;

    const digit = this.extractDigit(
      tick.quote,
      tick.pip_size
    );

    if (digit === null) return false;

    const previous = this.history[this.history.length - 1];

    // Prevent processing the same identifiable tick twice.
    if (
      previous &&
      tick.epoch !== undefined &&
      previous.epoch === tick.epoch &&
      previous.quote === quote &&
      previous.symbol === tick.symbol
    ) {
      return false;
    }

    if (this.lastDigit !== null) {

      this.transitionMatrix[this.lastDigit][digit] += 1;

    }

    const record = {
      digit,
      quote,
      epoch: tick.epoch ?? null,
      symbol: tick.symbol ?? null,
      timestamp: Date.now()
    };

    this.history.push(record);

    this.lastDigit = digit;

    if (this.history.length > this.maxHistory) {
      this.history.shift();

      this.rebuildTransitions();
    }

    return true;
  }

  // ---------------------------------------
  // 3. REBUILD TRANSITION MATRIX
  // ---------------------------------------

  rebuildTransitions() {

    this.transitionMatrix = Array.from(
      { length: DIGITS },
      () => emptyCounts()
    );

    for (let i = 1; i < this.history.length; i++) {

      const previous = this.history[i - 1].digit;
      const current = this.history[i].digit;

      this.transitionMatrix[previous][current] += 1;
    }
  }

  // ---------------------------------------
  // 4. HISTORICAL FREQUENCY MODEL
  // ---------------------------------------

  calculateFrequency(records = this.history) {

    const counts = emptyCounts();

    records.forEach(record => {
      counts[record.digit] += 1;
    });

    const total = records.length;

    const probabilities = counts.map(count => {

      return (
        (count + this.alpha) /
        (total + DIGITS * this.alpha)
      );

    });

    return {
      counts,
      total,
      probabilities
    };
  }

  getDistribution(windowSize) {

    const records = windowSize
      ? this.history.slice(-windowSize)
      : this.history;

    const result = this.calculateFrequency(records);

    return result.counts.map((count, digit) => ({

      digit,
      count,

      probability: result.total
        ? count / result.total
        : 0.1,

      posteriorProbability:
        result.probabilities[digit]

    }));
  }

  // ---------------------------------------
  // 5. ROLLING WINDOW ANALYSIS
  // ---------------------------------------

  getWindowAnalysis(windowSize) {

    const records = this.history.slice(-windowSize);

    const result = this.calculateFrequency(records);

    const distribution = result.counts.map((count, digit) => ({

      digit,
      count,

      probability: result.total
        ? count / result.total
        : 0.1,

      posteriorProbability:
        result.probabilities[digit]

    }));

    return {
      window: windowSize,
      samples: records.length,
      distribution
    };
  }

  getAllWindowAnalysis() {

    return this.windows.map(size =>
      this.getWindowAnalysis(size)
    );
  }

  // ---------------------------------------
  // 6. MARKOV TRANSITION MODEL
  // ---------------------------------------

  getTransitionProbabilities(currentDigit = this.lastDigit) {

    if (
      currentDigit === null ||
      currentDigit < 0 ||
      currentDigit >= DIGITS
    ) {
      return uniformProbabilities();
    }

    const counts = this.transitionMatrix[currentDigit];

    const total = counts.reduce(
      (sum, value) => sum + value,
      0
    );

    return counts.map(count => {

      return (
        (count + this.alpha) /
        (total + DIGITS * this.alpha)
      );

    });
  }

  getTransitionAnalysis() {

    const probabilities =
      this.getTransitionProbabilities();

    const observations = this.lastDigit === null
      ? 0
      : this.transitionMatrix[this.lastDigit].reduce(
          (sum, value) => sum + value,
          0
        );

    return {
      currentDigit: this.lastDigit,
      observations,
      probabilities,
      available: observations >= 20
    };
  }

  // ---------------------------------------
  // 7. RECENT TREND MODEL
  // ---------------------------------------

  calculateTrend() {

    const recent = this.history.slice(-100);
    const longTerm = this.history.slice(-1000);

    const recentModel = this.calculateFrequency(recent);
    const longModel = this.calculateFrequency(longTerm);

    const trend = emptyCounts();

    for (let digit = 0; digit < DIGITS; digit++) {

      const difference =
        recentModel.probabilities[digit] -
        longModel.probabilities[digit];

      trend[digit] = Math.max(
        0.001,
        0.1 + difference
      );
    }

    return normalize(trend);
  }

  // ---------------------------------------
  // 8. EXPONENTIALLY WEIGHTED FREQUENCY
  // ---------------------------------------

  getWeightedProbabilities() {

    const weights = emptyCounts();

    let weightTotal = 0;

    for (let i = 0; i < this.history.length; i++) {

      const age = this.history.length - 1 - i;

      const weight = Math.pow(this.decay, age);

      weights[this.history[i].digit] += weight;

      weightTotal += weight;
    }

    if (!weightTotal) {
      return uniformProbabilities();
    }

    const smoothed = weights.map(value => value + this.alpha);

    return normalize(smoothed);
  }

  // ---------------------------------------
  // 9. MULTI-MODEL ENSEMBLE
  // ---------------------------------------

  predict() {

    const samples = this.history.length;

    const frequency = this.calculateFrequency();

    const frequencyModel = frequency.probabilities;

    const markovModel =
      this.getTransitionProbabilities();

    const trendModel =
      this.calculateTrend();

    const weightedModel =
      this.getWeightedProbabilities();

    const transitionInfo =
      this.getTransitionAnalysis();

    /*
     * Markov weight is reduced when there are
     * insufficient transition observations.
     */

    let frequencyWeight = this.weights.frequency;
    let markovWeight = this.weights.markov;
    let trendWeight = this.weights.trend;

    if (!transitionInfo.available) {

      markovWeight = 0.05;
      frequencyWeight = 0.65;
      trendWeight = 0.30;

    }

    const totalWeight =
      frequencyWeight + markovWeight + trendWeight;

    frequencyWeight /= totalWeight;
    markovWeight /= totalWeight;
    trendWeight /= totalWeight;

    const ensemble = emptyCounts();

    for (let digit = 0; digit < DIGITS; digit++) {

      ensemble[digit] =

        frequencyModel[digit] * frequencyWeight +

        markovModel[digit] * markovWeight +

        trendModel[digit] * trendWeight;

    }

    const probabilities = normalize(ensemble);

    // ---------------------------------------
    // 10. RANK DIGITS
    // ---------------------------------------

    const ranking = probabilities
      .map((probability, digit) => ({
        digit,
        probability,
        percentage: probability * 100
      }))
      .sort((a, b) => b.probability - a.probability);

    const topDigit = ranking[0];

    // ---------------------------------------
    // 11. RELIABILITY FILTER
    // ---------------------------------------

    let reliability = "INSUFFICIENT DATA";

    let reliabilityScore = 0;

    let recommendation = "WAIT";

    if (samples >= 50) {

      reliability = "LOW";
      reliabilityScore = 25;

    }

    if (samples >= 200) {

      reliability = "MODERATE";
      reliabilityScore = 50;

    }

    if (
      samples >= 500 &&
      transitionInfo.available
    ) {

      reliability = "DATA AVAILABLE";
      reliabilityScore = 65;

    }

    if (samples >= 1000) {

      reliability = "LARGE SAMPLE";
      reliabilityScore = 75;

    }

    /*
     * A high model estimate is not proof of
     * predictive accuracy. Do not automatically
     * approve a trade based on this score.
     */

    const baseline = 10;

    const modelEstimate = topDigit.percentage;

    const signalStrength = Math.max(
      0,
      modelEstimate - baseline
    );

    if (
      samples >= this.minSamples &&
      transitionInfo.available &&
      signalStrength >= 2
    ) {

      recommendation = "REVIEW SIGNAL";

    }

    const distribution = probabilities.map(
      (probability, digit) => ({

        digit,

        probability,

        percentage: probability * 100,

        count: frequency.counts[digit]

      })
    );

    // ---------------------------------------
    // 12. MODEL BREAKDOWN
    // ---------------------------------------

    const modelBreakdown = {

      frequency: {
        weight: frequencyWeight,
        probabilities: frequencyModel
      },

      markov: {
        weight: markovWeight,
        probabilities: markovModel,
        observations: transitionInfo.observations
      },

      trend: {
        weight: trendWeight,
        probabilities: trendModel
      },

      weightedFrequency: {
        probabilities: weightedModel
      }

    };

    const result = {

      digit: topDigit.digit,

      predictedDigit: topDigit.digit,

      probability: topDigit.probability,

      percentage: topDigit.percentage,

      confidence: null,

      confidenceLabel: "Uncalibrated statistical estimate",

      samples,

      baseline,

      modelEstimate,

      reliability,

      reliabilityScore,

      recommendation,

      signalStrength,

      probabilities,

      distribution,

      ranking,

      modelBreakdown,

      windows: this.getAllWindowAnalysis(),

      currentDigit: this.lastDigit,

      transitionAnalysis: transitionInfo,

      timestamp: Date.now()

    };

    this.lastPrediction = result;

    this.predictions.push(result);

    if (this.predictions.length > 5000) {
      this.predictions.shift();
    }

    return result;
  }

  // ---------------------------------------
  // 13. EVALUATE PREDICTION
  // ---------------------------------------

  evaluate(actualDigit) {

    if (
      !Number.isInteger(actualDigit) ||
      actualDigit < 0 ||
      actualDigit > 9
    ) {
      return null;
    }

    if (!this.lastPrediction) {
      return null;
    }

    const predictedDigit =
      this.lastPrediction.digit;

    const correct =
      predictedDigit === actualDigit;

    const result = {

      predictedDigit,

      actualDigit,

      correct,

      timestamp: Date.now(),

      predictedProbability:
        this.lastPrediction.probability

    };

    this.evaluations.push(result);

    if (this.evaluations.length > 5000) {
      this.evaluations.shift();
    }

    this.performance.total += 1;

    if (correct) {

      this.performance.correct += 1;

    } else {

      this.performance.incorrect += 1;

    }

    this.performance.accuracy =

      this.performance.total > 0

        ? (
            this.performance.correct /
            this.performance.total
          ) * 100

        : 0;

    return result;
  }

  // ---------------------------------------
  // 14. PERFORMANCE ANALYTICS
  // ---------------------------------------

  getPerformance() {

    const total = this.performance.total;

    const accuracy = total
      ? (this.performance.correct / total) * 100
      : 0;

    return {

      total,

      correct: this.performance.correct,

      incorrect: this.performance.incorrect,

      accuracy,

      baseline: 10,

      differenceFromBaseline: accuracy - 10,

      status: total < 100
        ? "INSUFFICIENT TESTS"
        : accuracy > 10
          ? "ABOVE BASELINE — VALIDATION REQUIRED"
          : "AT OR BELOW BASELINE"

    };
  }

  getRecentPerformance(limit = 100) {

    const recent = this.evaluations.slice(-limit);

    const correct = recent.filter(
      item => item.correct
    ).length;

    const total = recent.length;

    return {

      total,

      correct,

      incorrect: total - correct,

      accuracy: total
        ? (correct / total) * 100
        : 0,

      baseline: 10

    };
  }

  // ---------------------------------------
  // 15. RESET ENGINE
  // ---------------------------------------

  reset() {

    this.history = [];

    this.predictions = [];

    this.evaluations = [];

    this.lastPrediction = null;

    this.lastDigit = null;

    this.transitionMatrix = Array.from(
      { length: DIGITS },
      () => emptyCounts()
    );

    this.performance = {
      total: 0,
      correct: 0,
      incorrect: 0,
      accuracy: 0,
      baseline: 10
    };

  }

}

export default DigitMatchPredictor;
