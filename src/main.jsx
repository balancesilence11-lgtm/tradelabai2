        <div className="brand-sub">PROFESSIONAL TRADING PLATFORM</div>
        <div className="nav-label">Workspace</div>
        {navigation.map(item => {
          const Icon = item.icon;
          return <button key={item.name} className={`nav-item ${activePage === item.name ? 'active' : ''}`}
            onClick={() => { setActivePage(item.name); setSidebarOpen(false); }}>
            <Icon size={17} />{item.name}
          </button>;
        })}
        <div className="sidebar-bottom">
          <div className="nav-label">Account</div>
          <button className="nav-item"><Wallet size={17} />Account overview</button>
          <button className="nav-item"><LockKeyhole size={17} />Security</button>
          <button className="nav-item"><LogOut size={17} />Sign out</button>
        </div>
      </aside>

      <main className="main-area">
        <header className="topbar">
          <div style={{display:'flex',alignItems:'center',gap:13}}>
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={21}/></button>
            <div className="top-title">{activePage}</div>
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={() => setNotifications(!notifications)} title="Toggle notifications">
              <Bell size={19} color={notifications ? '#20d6a1' : '#8492a9'}/>
            </button>
            <button className="icon-button"><Moon size={19}/></button>
            <div className="profile"><div className="avatar">TL</div><span>Trader Account</span><ChevronDown size={14}/></div>
          </div>
        </header>

        <section className="content">
          {activePage === 'Dashboard' ? <>
            <div className="welcome">
              <div><h1>Welcome to TradeLab AI Pro</h1><div className="muted">Your multi-market trading analysis workspace.</div></div>
              <div className="demo-badge">● DEMO MODE</div>
            </div>

            <div className="stats-grid">
              <div className="card"><div className="stat-label">Demo Account Balance</div><div className="stat-value">$10,000.00</div><div className="positive">Virtual account</div></div>
              <div className="card"><div className="stat-label">Demo Orders</div><div className="stat-value">{trades.length}</div><div className="muted">Simulated orders created</div></div>
              <div className="card"><div className="stat-label">Market Status</div><div className="stat-value" style={{fontSize:19}}>{marketStatus}</div><div className="muted">{lastUpdated ? `Updated: ${lastUpdated.toLocaleTimeString()}` : 'Waiting for market data'}</div></div>
              <div className="card"><div className="stat-label">Selected Instrument</div><div className="stat-value" style={{fontSize:19}}>{selectedMarket}</div><div className="muted">{currentMarket?.live ? 'Live price received' : 'Live price not confirmed'}</div></div>
            </div>

            <div className="dashboard-grid">
              <div className="card">
                <div className="card-heading">
                  <div>
                    <h3>{selectedMarket} Live Candlestick Chart</h3>
                    <div className="chart-price" style={{marginTop:12}}>{currentMarket?.price || '—'}</div>
                    <div className="muted">{currentMarket?.live ? 'Latest market quote · Twelve Data' : 'Waiting for live quote'}</div>
                  </div>
                  <div className="periods">
                    {[['1min','1m'],['5min','5m'],['15min','15m'],['30min','30m'],['1h','1h'],['4h','4h']].map(([value,label]) =>
                      <button key={value} onClick={() => setPeriod(value)} className={`period-btn ${period === value ? 'active' : ''}`}>{label}</button>
                    )}
                  </div>
                </div>
                <div className="chart-wrap">
                  <CandlestickChart candles={candles} loading={candleLoading} error={candleError} symbol={selectedMarket}/>
                </div>
                <div className="muted">{candles.length} historical candles · {period} timeframe · refreshed every 60 seconds.</div>
              </div>

              <div className="card">
                <div className="card-heading"><h3>Market Watch</h3><Activity size={17} color="#20d6a1"/></div>
                <input className="search-box" placeholder="Search instruments..." value={search} onChange={e => setSearch(e.target.value)}/>
                {filteredMarkets.map(market =>
                  <div key={market.symbol} onClick={() => setSelectedMarket(market.symbol)}
                    className={`market-row ${selectedMarket === market.symbol ? 'selected' : ''}`}>
                    <div><div className="market-symbol">{market.symbol}</div><div className="market-name">{market.name}</div></div>
                    <div><div className="market-price">{market.price}</div><div className="market-change muted">{market.live ? 'LIVE' : 'Not connected'}</div></div>
                  </div>
                )}
                {filteredMarkets.length === 0 && <div className="empty">No instruments found.</div>}
              </div>
            </div>

            <div className="bottom-grid">
              <div className="card">
                <div className="card-heading"><h3>Trading Terminal</h3><span className="tag">SIMULATION ONLY</span></div>
                <div className="order-grid">
                  <div className="field"><label>Instrument</label><select value={selectedMarket} onChange={e => {setSelectedMarket(e.target.value);setOrderMessage('');}}>{markets.map(m=><option key={m.symbol} value={m.symbol}>{m.symbol}</option>)}</select></div>
                  <div className="field"><label>Order Type</label><select value={orderType} onChange={e=>setOrderType(e.target.value)}><option>Market</option><option>Limit</option><option>Stop</option></select></div>
                  <div className="field"><label>Volume (Lots)</label><input type="number" min="0.01" step="0.01" value={lotSize} onChange={e=>setLotSize(e.target.value)}/></div>
                  <div className="field"><label>Stop Loss (Points)</label><input type="number" min="0" value={stopLoss} onChange={e=>setStopLoss(e.target.value)}/></div>
                  <div className="field"><label>Take Profit (Points)</label><input type="number" min="0" value={takeProfit} onChange={e=>setTakeProfit(e.target.value)}/></div>
                </div>
                <div className="trade-buttons">
                  <button className="buy-btn" onClick={()=>setDirection('BUY')}><ArrowUpRight size={15}/> BUY</button>
                  <button className="sell-btn" onClick={()=>setDirection('SELL')}><ArrowDownRight size={15}/> SELL</button>
                </div>
                <div className="muted" style={{marginBottom:12}}>Selected direction: <strong>{direction}</strong></div>
                <button className="execute-btn" onClick={placeDemoOrder} disabled={!lotSize || Number(lotSize)<=0}>Place Demo Order</button>
                {orderMessage && <p className="muted" style={{marginTop:12}}>{orderMessage}</p>}
              </div>

              <div className="card">
                <div className="card-heading"><h3>AI Market Insights</h3><Sparkles size={18} color="#20d6a1"/></div>
                <div className="signal"><span>Market direction</span><span className="tag">Bullish demo</span></div>
                <div className="signal"><span>RSI indicator</span><span>56.4</span></div>
                <div className="signal"><span>MACD</span><span className="positive">Positive demo</span></div>
                <div className="signal"><span>Moving Average</span><span>Above MA demo</span></div>
                <div className="signal"><span>Risk assessment</span><span className="tag">Moderate demo</span></div>
                <p className="muted" style={{lineHeight:1.7}}>These are illustrative indicators, not live AI-generated trading signals. Actual technical analysis and AI signals will be connected in a later development stage.</p>
              </div>
            </div>

            <div className="card" style={{marginTop:18}}>
              <div className="card-heading"><h3>Recent Demo Orders</h3><span className="muted">{trades.length} orders</span></div>
              <div className="table-wrap"><table>
                <thead><tr><th>Instrument</th><th>Direction</th><th>Volume</th><th>Order Type</th><th>Time</th><th>Status</th></tr></thead>
                <tbody>{trades.length === 0 ? <tr><td colSpan="6" className="empty">No demo orders yet. Create your first simulated order.</td></tr> :
                  trades.map(t=><tr key={t.id}><td>{t.symbol}</td><td className={t.direction==='BUY'?'positive':'negative'}>{t.direction}</td><td>{t.lot}</td><td>{t.type}</td><td>{t.time}</td><td><span className="tag">{t.status}</span></td></tr>)}
                </tbody>
              </table></div>
            </div>
          </> : <div className="card page-placeholder"><div><Sparkles size={35} color="#20d6a1"/><h2>{activePage}</h2>
            <p>This module is part of the TradeLab AI Pro development plan.</p>
            <p>We will activate its full functionality as we integrate market data, broker services and the platform backend.</p>
          </div></div>}

          <div style={{textAlign:'center',padding:'25px 10px',color:'#718096',fontSize:11}}>
            TradeLab AI Pro · Development Version · Demo Environment<br/>
            Trading involves risk. No live broker execution is currently enabled.
          </div>
