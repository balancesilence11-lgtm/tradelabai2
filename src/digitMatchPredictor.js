/* TradeLab AI
   Digit Match Prediction Engine
   Version 1.0
*/

const DIGITS = 10;

export class DigitMatchPredictor {

  constructor(options = {}) {

    this.maxHistory = options.maxHistory || 5000;
    this.minSamples = options.minSamples || 200;

    this.history = [];
    this.predictions = [];

    this.alpha = 1;

    this.lastPrediction = null;
  }

  // Extract final digit from Deriv quote
  extractDigit(quote, pipSize) {

    const value = Number(quote);

    if (!Number.isFinite(value)) {
      return null;
    }

    const decimals = Number.isInteger(Number(pipSize))
      ? Math.min(10, Math.max(0, Number(pipSize)))
      : 2;

    const formatted = value.toFixed(decimals);

    const digits = formatted.replace(/\D/g, '');

    if (!digits.length) return null;

    return Number(digits.slice(-1));
  }

  // Add incoming market tick
  addTick(tick) {

    if (!tick || tick.quote === undefined) {
      return null;
    }

    const digit = this.extractDigit(
      tick.quote,
      tick.pip_size
    );

    if (digit === null) return null;

    const record = {
      digit,
      quote: Number(tick.quote),
      timestamp: tick.epoch
        ? Number(tick.epoch)
        : Date.now()
    };

    this.history.push(record);

    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return record;
  }

  // Calculate historical digit distribution
  getDistribution() {

    const counts = Array(DIGITS).fill(0);

    this.history.forEach(item => {
      counts[item.digit]++;
    });

    const total = this.history.length;

    return counts.map((count, digit) => ({
      digit,
      count,
      probability: total
        ? count / total
        : 0
    }));
  }

  // Calculate recent weighted probabilities
  getWeightedProbabilities() {

    const counts = Array(DIGITS).fill(0);

    let totalWeight = 0;

    const decay = 0.995;

    const length = this.history.length;

    this.history.forEach((item, index) => {

      const age = length - 1 - index;

      const weight = Math.pow(decay, age);

      counts[item.digit] += weight;

      totalWeight += weight;

    });

    return counts.map((count, digit) => ({
      digit,
      probability: totalWeight
        ? count / totalWeight
        : 0
    }));
  }

  // Analyse digit transitions
  getTransitionProbabilities() {

    const matrix = Array.from(
      { length: DIGITS },
      () => Array(DIGITS).fill(0)
    );

    for (let i = 1; i < this.history.length; i++) {

      const previous = this.history[i - 1].digit;

      const current = this.history[i].digit;

      matrix[previous][current]++;
    }

    return matrix;
  }

  // Generate prediction
  predict() {

    const samples = this.history.length;

    if (samples < this.minSamples) {

      return {
        ready: false,
        samples,
        required: this.minSamples,
        message: 'Collecting more market observations'
      };

    }

    const historical = this.getDistribution();

    const weighted = this.getWeightedProbabilities();

    const transitions = this.getTransitionProbabilities();

    const lastDigit =
      this.history[this.history.length - 1].digit;

    const transitionRow = transitions[lastDigit];

    const transitionTotal = transitionRow.reduce(
      (sum, value) => sum + value,
      0
    );

    const scores = [];

    for (let digit = 0; digit < DIGITS; digit++) {

      const historicalProbability =
        historical[digit].probability;

      const recentProbability =
        weighted[digit].probability;

      const transitionProbability =
        (transitionRow[digit] + this.alpha) /
        (transitionTotal + DIGITS * this.alpha);

      const score =
        (historicalProbability * 0.35) +
        (recentProbability * 0.35) +
        (transitionProbability * 0.30);

      scores.push({
        digit,
        score,
        historicalProbability,
        recentProbability,
        transitionProbability
      });

    }

    scores.sort((a, b) => b.score - a.score);

    const best = scores[0];

    const second = scores[1];

    const edge = best.score - 0.1;

    const confidence = Math.max(
      0,
      Math.min(100, edge * 100)
    );

    const result = {

      ready: true,

      predictedDigit: best.digit,

      probability: best.score,

      confidence,

      baseline: 10,

      edge: (best.score - 0.1) * 100,

      secondBest: second.digit,

      sampleSize: samples,

      lastObservedDigit: lastDigit,

      distribution: historical,

      rankings: scores,

      timestamp: Date.now()

    };

    this.lastPrediction = result;

    this.predictions.push(result);

    return result;

  }

  // Record actual result and evaluate prediction
  evaluate(actualDigit) {

    if (!this.lastPrediction) {
      return null;
    }

    const prediction = this.lastPrediction;

    const actual = Number(actualDigit);

    if (!Number.isInteger(actual) ||
        actual < 0 ||
        actual > 9) {
      return null;
    }

    const correct =
      prediction.predictedDigit === actual;

    const result = {

      predicted: prediction.predictedDigit,

      actual,

      correct,

      timestamp: Date.now()

    };

    this.predictions.push({
      ...result,
      evaluated: true
    });

    this.lastPrediction = null;

    return result;

  }

  // Performance statistics
  getPerformance() {

    const evaluated = this.predictions.filter(
      item => item.evaluated === true
    );

    const wins = evaluated.filter(
      item => item.correct
    ).length;

    const losses = evaluated.length - wins;

    return {

      total: evaluated.length,

      wins,

      losses,

      accuracy: evaluated.length
        ? (wins / evaluated.length) * 100
        : 0,

      randomBaseline: 10

    };

  }

  // Clear collected observations
  reset() {

    this.history = [];

    this.predictions = [];

    this.lastPrediction = null;

  }

}

export default DigitMatchPredictor;
