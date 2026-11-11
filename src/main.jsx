function StrategyLab({ candles, symbol, timeframe, loading, error }) {
  const [strategy, setStrategy] = useState('ema');
  const [fastPeriod, setFastPeriod] = useState(20);
  const [slowPeriod, setSlowPeriod] = useState(50);
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [oversold, setOversold] = useState(30);
  const [overbought, setOverbought] = useState(70);
  const [lookback, setLookback] = useState(20);
  const [capital, setCapital] = useState(10000);
  const [costBps, setCostBps] = useState(1.5);
  const [runKey, setRunKey] = useState(0);
  const [runMessage, setRunMessage] = useState('');
  const [optimization, setOptimization] = useState([]);
  const [optimizing, setOptimizing] = useState(false);

  const config = {
    strategy,
    fast: fastPeriod,
    slow: slowPeriod,
    rsiPeriod,
    oversold,
    overbought,
    lookback,
    capital,
    costBps
  };

  const result = useMemo(
    () => runStrategyBacktest(candles, config),
    [
      candles,
      strategy,
      fastPeriod,
      slowPeriod,
      rsiPeriod,
      oversold,
      overbought,
      lookback,
      capital,
      costBps,
      runKey
    ]
  );

  const handleRunBacktest = () => {
    if (loading) return;

    const check = runStrategyBacktest(candles, config);

    if (check?.error) {
      setRunMessage(`Backtest failed: ${check.error}`);
      return;
    }

    setRunKey(k => k + 1);

    setRunMessage(
      `Backtest completed successfully — ${check.tradeCount || 0} closed trades.`
    );
  };

  const money = v =>
    Number.isFinite(v)
      ? v.toLocaleString(undefined, {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 2
        })
      : '—';

  const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;

  const chart = result?.curve || [];
  const minEq = chart.length
    ? Math.min(...chart.map(p => p.equity))
    : 0;

  const maxEq = chart.length
    ? Math.max(...chart.map(p => p.equity))
    : 1;

  const range = maxEq - minEq || 1;

  const path = chart
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${
          20 + (i / Math.max(1, chart.length - 1)) * 960
        } ${12 + ((maxEq - p.equity) / range) * 176}`
    )
    .join(' ');

  const advanced = advancedPerformance(result);

  const splitIndex = Math.floor(candles.length * 0.7);

  const outOfSample =
    candles.length >= 100
      ? runStrategyBacktest(candles.slice(splitIndex), config)
      : null;

  const runOptimization = () => {
    setOptimizing(true);
    setOptimization([]);

    setTimeout(() => {
      setOptimization(optimizeStrategy(candles, config));
      setOptimizing(false);
    }, 30);
  };

  return (
    <>
      <div className="welcome">
        <div>
          <h1>Strategy Lab & Backtesting</h1>
          <div className="muted">
            Test rule-based strategies against the currently loaded historical candles.
          </div>
        </div>
        <div className="demo-badge">● HISTORICAL SIMULATION</div>
      </div>

      <div className="card">
        <div className="card-heading">
          <div>
            <h3>Strategy builder</h3>
            <div className="muted">
              {symbol} · {timeframe} · {candles.length} candles available
            </div>
          </div>
          <span className="tag">NO LIVE ORDERS</span>
        </div>

        {(loading || error) && (
          <div className="empty">
            {loading ? 'Loading historical data…' : error}
          </div>
        )}

        <div className="order-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <label>Strategy</label>
            <select
              value={strategy}
              onChange={e => {
                setStrategy(e.target.value);
                setRunMessage('');
              }}
            >
              <option value="ema">EMA crossover</option>
              <option value="rsi">RSI mean-reversion</option>
              <option value="breakout">Price breakout</option>
            </select>
          </div>

          <div className="field">
            <label>Starting capital (USD)</label>
            <input
              type="number"
              min="100"
              step="100"
              value={capital}
              onChange={e =>
                setCapital(Math.max(100, Number(e.target.value) || 100))
              }
            />
          </div>

          <div className="field">
            <label>Trading cost per side (bps)</label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={costBps}
              onChange={e =>
                setCostBps(
                  Math.max(0, Math.min(100, Number(e.target.value) || 0))
                )
              }
            />
          </div>

          {strategy === 'ema' && (
            <>
              <div className="field">
                <label>Fast EMA</label>
                <input
                  type="number"
                  min="2"
                  max="150"
                  value={fastPeriod}
                  onChange={e =>
                    setFastPeriod(
                      Math.max(2, Math.min(150, Number(e.target.value) || 2))
                    )
                  }
                />
              </div>

              <div className="field">
                <label>Slow EMA</label>
                <input
                  type="number"
                  min="3"
                  max="250"
                  value={slowPeriod}
                  onChange={e =>
                    setSlowPeriod(
                      Math.max(3, Math.min(250, Number(e.target.value) || 3))
                    )
                  }
                />
              </div>
            </>
          )}

          {strategy === 'rsi' && (
            <>
              <div className="field">
                <label>RSI period</label>
                <input
                  type="number"
                  min="2"
                  max="50"
                  value={rsiPeriod}
                  onChange={e =>
                    setRsiPeriod(
                      Math.max(2, Math.min(50, Number(e.target.value) || 2))
                    )
                  }
                />
              </div>

              <div className="field">
                <label>Oversold threshold</label>
                <input
                  type="number"
                  min="5"
                  max="45"
                  value={oversold}
                  onChange={e =>
                    setOversold(
                      Math.max(5, Math.min(45, Number(e.target.value) || 5))
                    )
                  }
                />
              </div>

              <div className="field">
                <label>Overbought threshold</label>
                <input
                  type="number"
                  min="55"
                  max="95"
                  value={overbought}
                  onChange={e =>
                    setOverbought(
                      Math.max(55, Math.min(95, Number(e.target.value) || 55))
                    )
                  }
                />
              </div>
            </>
          )}

          {strategy === 'breakout' && (
            <div className="field">
              <label>Breakout lookback candles</label>
              <input
                type="number"
                min="5"
                max="100"
                value={lookback}
                onChange={e =>
                  setLookback(
                    Math.max(5, Math.min(100, Number(e.target.value) || 5))
                  )
                }
              />
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 10,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: 16
          }}
        >
          <button
            className="execute-btn"
            onClick={handleRunBacktest}
            disabled={loading}
          >
            Run backtest
          </button>

          {runMessage && (
            <span
              className="muted"
              role="status"
              style={{ fontSize: 11 }}
            >
              {runMessage}
            </span>
          )}
        </div>

        <p className="muted" style={{ fontSize: 11 }}>
          Signals use completed candles; positions take effect on the following
          candle. Costs are a simplified basis-point assumption.
        </p>
      </div>

      {result?.error ? (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="empty">{result.error}</div>
        </div>
      ) : (
        <>
          <div className="stats-grid" style={{ marginTop: 18 }}>
            <div className="card">
              <div className="stat-label">Net return</div>
              <div
                className="stat-value"
                style={{
                  color: result.netReturn >= 0 ? '#21d6a0' : '#fb7185'
                }}
              >
                {pct(result.netReturn)}
              </div>
              <div className="muted">
                Final equity: {money(result.finalEquity)}
              </div>
            </div>

            <div className="card">
              <div className="stat-label">Win rate</div>
              <div className="stat-value">{result.winRate.toFixed(1)}%</div>
              <div className="muted">
                {result.wins} wins / {result.tradeCount} closed trades
              </div>
            </div>

            <div className="card">
              <div className="stat-label">Profit factor</div>
              <div className="stat-value">
                {Number.isFinite(result.profitFactor)
                  ? result.profitFactor.toFixed(2)
                  : '∞'}
              </div>
              <div className="muted">Gross profit ÷ gross loss</div>
            </div>

            <div className="card">
              <div className="stat-label">Maximum drawdown</div>
              <div className="stat-value" style={{ color: '#fb7185' }}>
                {result.maxDrawdown.toFixed(2)}%
              </div>
              <div className="muted">Peak-to-trough equity decline</div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-heading">
              <div>
                <h3>Equity curve</h3>
                <div className="muted">
                  Start: {money(result.initial)} · End: {money(result.finalEquity)}
                </div>
              </div>
              <span className="tag">{result.tradeCount} trades</span>
            </div>

            <div style={{ height: 220, width: '100%' }}>
              <svg
                viewBox="0 0 1000 205"
                width="100%"
                height="100%"
                preserveAspectRatio="none"
              >
                <line x1="20" x2="980" y1="188" y2="188" stroke="#26364e" />
                <line
                  x1="20"
                  x2="980"
                  y1="12"
                  y2="12"
                  stroke="#26364e"
                  strokeDasharray="4 4"
                />
                <path
                  d={path}
                  fill="none"
                  stroke={result.netReturn >= 0 ? '#21d6a0' : '#fb7185'}
                  strokeWidth="2.5"
                />
                <text x="20" y="202" fill="#8290a8" fontSize="10">
                  First candle
                </text>
                <text
                  x="980"
                  y="202"
                  textAnchor="end"
                  fill="#8290a8"
                  fontSize="10"
                >
                  Last candle
                </text>
              </svg>
            </div>

            <div className="signal">
              <span>Buy-and-hold reference (before costs)</span>
              <strong
                style={{ color: result.buyHold >= 0 ? '#21d6a0' : '#fb7185' }}
              >
                {pct(result.buyHold)}
              </strong>
            </div>

            <div className="signal">
              <span>Data window</span>
              <strong>{result.candlesUsed} candles</strong>
            </div>
          </div>

          <div className="stats-grid" style={{ marginTop: 18 }}>
            <div className="card">
              <div className="stat-label">Trade-based Sharpe</div>
              <div className="stat-value">
                {advanced ? advanced.sharpeTrade.toFixed(2) : '—'}
              </div>
              <div className="muted">
                Not annualized; based on closed-trade returns
              </div>
            </div>

            <div className="card">
              <div className="stat-label">Trade-based Sortino</div>
              <div className="stat-value">
                {advanced ? advanced.sortinoTrade.toFixed(2) : '—'}
              </div>
              <div className="muted">Downside deviation measure</div>
            </div>

            <div className="card">
              <div className="stat-label">Recovery factor</div>
              <div className="stat-value">
                {advanced ? advanced.recoveryFactor.toFixed(2) : '—'}
              </div>
              <div className="muted">
                Net return ÷ maximum drawdown
              </div>
            </div>

            <div className="card">
              <div className="stat-label">Out-of-sample return</div>
              <div
                className="stat-value"
                style={{
                  color:
                    outOfSample &&
                    !outOfSample.error &&
                    outOfSample.netReturn >= 0
                      ? '#21d6a0'
                      : '#fb7185'
                }}
              >
                {outOfSample && !outOfSample.error
                  ? pct(outOfSample.netReturn)
                  : 'Insufficient data'}
              </div>
              <div className="muted">
                Last 30% of candles; parameters unchanged
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-heading">
              <div>
                <h3>Monte Carlo trade-sequence simulation</h3>
                <div className="muted">
                  500 bootstrap paths, resampling the observed closed-trade returns
                </div>
              </div>
              <span className="tag">SCENARIO ANALYSIS</span>
            </div>

            {advanced && advanced.simulations ? (
              <div className="stats-grid">
                <div>
                  <div className="stat-label">5th percentile</div>
                  <div className="stat-value" style={{ color: '#fb7185' }}>
                    {pct(advanced.mc5)}
                  </div>
                </div>
                <div>
                  <div className="stat-label">Median outcome</div>
                  <div className="stat-value">{pct(advanced.mc50)}</div>
                </div>
                <div>
                  <div className="stat-label">95th percentile</div>
                  <div className="stat-value" style={{ color: '#21d6a0' }}>
                    {pct(advanced.mc95)}
                  </div>
                </div>
              </div>
            ) : (
              <p className="muted">
                At least one closed trade is needed for simulation.
              </p>
            )}

            <p
              className="muted"
              style={{ fontSize: 11, lineHeight: 1.6 }}
            >
              This resamples the strategy's historical trade outcomes; it does
              not predict future performance and cannot model market regimes
              absent from the sample.
            </p>
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-heading">
              <div>
                <h3>Parameter optimizer</h3>
                <div className="muted">
                  Tests a bounded set of parameter combinations on the currently
                  loaded candles.
                </div>
              </div>

              <button
                className="execute-btn"
                onClick={runOptimization}
                disabled={loading || optimizing || candles.length < 60}
              >
                {optimizing ? 'Optimizing…' : 'Optimize strategy'}
              </button>
            </div>

            {optimization.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Rank</th>
                      <th>Parameters</th>
                      <th>Net return</th>
                      <th>Max drawdown</th>
                      <th>Trades</th>
                      <th>Profit factor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {optimization.map((item, i) => (
                      <tr key={i}>
                        <td>{i + 1}</td>
                        <td>
                          {item.config.strategy === 'ema'
                            ? `EMA ${item.config.fast}/${item.config.slow}`
                            : item.config.strategy === 'rsi'
                              ? `RSI ${item.config.rsiPeriod}, ${item.config.oversold}/${item.config.overbought}`
                              : `Breakout ${item.config.lookback}`}
                        </td>
                        <td
                          className={
                            item.result.netReturn >= 0 ? 'positive' : 'negative'
                          }
                        >
                          {pct(item.result.netReturn)}
                        </td>
                        <td>{item.result.maxDrawdown.toFixed(2)}%</td>
                        <td>{item.result.tradeCount}</td>
                        <td>
                          {Number.isFinite(item.result.profitFactor)
                            ? item.result.profitFactor.toFixed(2)
                            : '∞'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted" style={{ fontSize: 11 }}>
                {optimizing
                  ? 'Evaluating candidate settings…'
                  : 'Run the optimizer to compare candidate settings. It ranks by return penalized for drawdown; it does not guarantee a better live result.'}
              </p>
            )}
          </div>

          <div className="card" style={{ marginTop: 18 }}>
            <div className="card-heading">
              <h3>Closed trades</h3>
              <span className="muted">
                Most recent 20 shown · {result.tradeCount} total
              </span>
            </div>

            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Side</th>
                    <th>Entry time</th>
                    <th>Exit time</th>
                    <th>Entry</th>
                    <th>Exit</th>
                    <th>Net P/L</th>
                    <th>Exit reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.trades.length === 0 ? (
                    <tr>
                      <td colSpan="8" className="empty">
                        No completed trades for this strategy and data window.
                      </td>
                    </tr>
                  ) : (
                    result.trades
                      .slice(-20)
                      .reverse()
                      .map(t => (
                        <tr key={t.id}>
                          <td>{t.id}</td>
                          <td
                            className={
                              t.side === 'LONG' ? 'positive' : 'negative'
                            }
                          >
                            {t.side}
                          </td>
                          <td>{t.entryTime}</td>
                          <td>{t.exitTime}</td>
                          <td>
                            {t.entryPrice.toFixed(
                              symbol === 'USDJPY'
                                ? 3
                                : symbol === 'BTCUSD'
                                  ? 1
                                  : symbol === 'XAUUSD'
                                    ? 2
                                    : 5
                            )}
                          </td>
                          <td>
                            {t.exitPrice.toFixed(
                              symbol === 'USDJPY'
                                ? 3
                                : symbol === 'BTCUSD'
                                  ? 1
                                  : symbol === 'XAUUSD'
                                    ? 2
                                    : 5
                            )}
                          </td>
                          <td
                            className={
                              t.pnlCash >= 0 ? 'positive' : 'negative'
                            }
                          >
                            {money(t.pnlCash)} ({pct(t.pnlPct)})
                          </td>
                          <td>{t.reason}</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div
        className="card"
        style={{ marginTop: 18, borderColor: '#5b4520' }}
      >
        <p
          className="muted"
          style={{ fontSize: 11, lineHeight: 1.7, margin: 0 }}
        >
          <strong style={{ color: '#fbbf24' }}>
            Backtest limitations:
          </strong>{' '}
          Sharpe and Sortino are trade-based, not annualized; the out-of-sample
          split uses the final 30% but is still the same downloaded sample;
          optimizer rankings are in-sample and can overfit; Monte Carlo only
          resamples observed trades. This is a local historical simulation
          using the currently fetched candle sample, not a broker-grade tester.
          It assumes close-price fills, constant percentage transaction costs,
          full-equity exposure and no margin, swaps, spread changes, liquidity
          constraints or intrabar stop execution. Results can be distorted by
          the limited 300-candle sample and are not a forecast. Test on more
          data and out-of-sample periods before relying on any strategy.
        </p>
      </div>
    </>
  );
}
