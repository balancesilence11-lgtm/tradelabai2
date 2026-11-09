

              <div className="dashboard-grid">
                <div className="card">
                  <div className="card-heading">
                    <div>
                      <h3>{selectedMarket} Live Candlestick Chart</h3>
                      <div className="chart-price" style={{ marginTop: 12 }}>{currentMarket?.price || '—'}</div>
                      <div className="muted">{currentMarket?.live ? 'Latest market quote · Twelve Data' : 'Waiting for live quote'}</div>
                    </div>
                    <div className="periods">
                      {intervals.map(([value, label]) => (
                        <button key={value} onClick={() => setPeriod(value)} className={`period-btn ${period === value ? 'active' : ''}`}>{label}</button>
                      ))}
                    </div>
                  </div>
                  <div className="chart-wrap">
                    <CandlestickChart candles={candles} loading={candleLoading} error={candleError} symbol={selectedMarket} />
                  </div>
                  <div className="muted">
                    {candles.length} historical candles · {period} timeframe · Automatically refreshed every 60 seconds.
                    {candleLoading && candles.length > 0 ? ' Updating...' : ''}
                    {candleError && candles.length > 0 ? ` Refresh warning: ${candleError}` : ''}
                  </div>
                </div>

                <div className="card">
                  <div className="card-heading"><h3>Market Watch</h3><Activity size={17} color="#20d6a1" /></div>
                  <input className="search-box" placeholder="Search instruments..." value={search} onChange={e => setSearch(e.target.value)} />
                  {filteredMarkets.map(market => (
                    <div key={market.symbol} onClick={() => setSelectedMarket(market.symbol)}
                      className={`market-row ${selectedMarket === market.symbol ? 'selected' : ''}`}>
                      <div><div className="market-symbol">{market.symbol}</div><div className="market-name">{market.name}</div></div>
                      <div><div className="market-price">{market.price}</div><div className="market-change muted">{market.live ? 'LIVE' : market.symbol === 'US30' ? 'Not supported' : 'Not connected'}</div></div>
                    </div>
                  ))}
                  {filteredMarkets.length === 0 && <div className="empty">No instruments found.</div>}
                </div>
              </div>

              <div className="bottom-grid">
                <div className="card">
                  <div className="card-heading"><h3>Trading Terminal</h3><span className="tag">SIMULATION ONLY</span></div>
                  <div className="order-grid">
                    <div className="field"><label>Instrument</label><select value={selectedMarket} onChange={e => { setSelectedMarket(e.target.value); setOrderMessage(''); }}>
                      {markets.map(market => <option key={market.symbol} value={market.symbol}>{market.symbol}</option>)}
                    </select></div>
                    <div className="field"><label>Order Type</label><select value={orderType} onChange={e => setOrderType(e.target.value)}><option>Market</option><option>Limit</option><option>Stop</option></select></div>
                    <div className="field"><label>Volume (Lots)</label><input type="number" min="0.01" step="0.01" value={lotSize} onChange={e => setLotSize(e.target.value)} /></div>
                    <div className="field"><label>Stop Loss (Points)</label><input type="number" min="0" value={stopLoss} onChange={e => setStopLoss(e.target.value)} /></div>
                    <div className="field"><label>Take Profit (Points)</label><input type="number" min="0" value={takeProfit} onChange={e => setTakeProfit(e.target.value)} /></div>
                  </div>
                  <div className="trade-buttons">
                    <button className="buy-btn" onClick={() => setDirection('BUY')}><ArrowUpRight size={15} /> BUY</button>
                    <button className="sell-btn" onClick={() => setDirection('SELL')}><ArrowDownRight size={15} /> SELL</button>
                  </div>
                  <div className="muted" style={{ marginBottom: 12 }}>Selected direction: <strong>{direction}</strong></div>
                  <button className="execute-btn" onClick={placeDemoOrder} disabled={!lotSize || Number(lotSize) <= 0}>Place Demo Order</button>
                  {orderMessage && <p className="muted" style={{ marginTop: 12 }}>{orderMessage}</p>}
                </div>

                <div className="card">
                  <div className="card-heading"><h3>AI Market Insights</h3><Sparkles size={18} color="#20d6a1" /></div>
                  <div className="signal"><span>Market direction</span><span className="tag">Bullish demo</span></div>
                  <div className="signal"><span>RSI indicator</span><span>56.4</span></div>
                  <div className="signal"><span>MACD</span><span className="positive">Positive demo</span></div>
                  <div className="signal"><span>Moving Average</span><span>Above MA demo</span></div>
                  <div className="signal"><span>Risk assessment</span><span className="tag">Moderate demo</span></div>
                  <p className="muted" style={{ lineHeight: 1.7 }}>
                    These are illustrative indicators, not live AI-generated trading signals. Actual technical analysis and AI signals will be connected in a later development stage.
                  </p>
                </div>
              </div>

              <div className="card" style={{ marginTop: 18 }}>
                <div className="card-heading"><h3>Recent Demo Orders</h3><span className="muted">{trades.length} orders</span></div>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Instrument</th><th>Direction</th><th>Volume</th><th>Order Type</th><th>Time</th><th>Status</th></tr></thead>
                    <tbody>
                      {trades.length === 0 ? (
                        <tr><td colSpan="6" className="empty">No demo orders yet. Create your first simulated order.</td></tr>
                      ) : trades.map(trade => (
                        <tr key={trade.id}>
                          <td>{trade.symbol}</td><td className={trade.direction === 'BUY' ? 'positive' : 'negative'}>{trade.direction}</td>
                          <td>{trade.lot}</td><td>{trade.type}</td><td>{trade.time}</td><td><span className="tag">{trade.status}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="card page-placeholder">
              <div><Sparkles size={35} color="#20d6a1" /><h2>{activePage}</h2>
                <p>This module is part of the TradeLab AI Pro development plan.</p>
                <p>We will activate its full functionality as we integrate market data, broker services and the platform backend.</p>
              </div>
            </div>
          )}

          <div style={{ textAlign: 'center', padding: '25px 10px', color: '#718096', fontSize: 11 }}>
            TradeLab AI Pro · Development Version · Demo Environment<br />
            Trading involves risk. No live broker execution is currently enabled.
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode><App /></React.StrictMode>
);
