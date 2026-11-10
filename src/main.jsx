import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowDownRight, ArrowUpRight, BarChart3, Bell, Bot,
  ChevronDown, Clock3, LayoutDashboard, LockKeyhole, LogOut, Menu,
  Moon, Radio, Settings, ShieldCheck, SlidersHorizontal, Sparkles,
  TrendingUp, Wallet
} from 'lucide-react';
import './style.css';

const initialMarkets = [
  { symbol: 'EURUSD', name: 'Euro / US Dollar', price: '—', change: '—', up: true },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', price: '—', change: '—', up: true },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', price: '—', change: '—', up: false },
  { symbol: 'XAUUSD', name: 'Gold / US Dollar', price: '—', change: '—', up: true },
  { symbol: 'US30', name: 'Dow Jones Industrial Average', price: '—', change: '—', up: true },
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', price: '—', change: '—', up: false }
];

const navigation = [
  { name: 'Dashboard', icon: LayoutDashboard },
  { name: 'Market Analysis', icon: BarChart3 },
  { name: 'AI Assistant', icon: Bot },
  { name: 'Strategy Lab', icon: Activity },
  { name: 'Trading Terminal', icon: TrendingUp },
  { name: 'Smart Scanner', icon: SlidersHorizontal },
  { name: 'Risk Centre', icon: ShieldCheck },
  { name: 'Trade Journal', icon: Clock3 },
  { name: 'Automation Centre', icon: Radio },
  { name: 'Settings', icon: Settings }
];

const supportedSymbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];
const intervals = [
  ['1min', '1m'], ['5min', '5m'], ['15min', '15m'],
  ['30min', '30m'], ['1h', '1h'], ['4h', '4h']
];

function CandlestickChart({ candles, loading, error, symbol }) {
  const width = 1000;
  const height = 270;
  const left = 78;
  const right = 18;
  const top = 16;
  const bottom = 36;

  if (loading && candles.length === 0) {
    return <div className="empty">Loading historical candles...</div>;
  }
  if (error && candles.length === 0) {
    return <div className="empty">{error}</div>;
  }
  if (!candles.length) {
    return <div className="empty">No historical candles available.</div>;
  }

  const visible = candles.slice(-100);
  const highest = Math.max(...visible.map(c => Number(c.high)));
  const lowest = Math.min(...visible.map(c => Number(c.low)));
  const padding = (highest - lowest) * 0.08 || Math.abs(highest) * 0.001 || 0.0001;
  const max = highest + padding;
  const min = lowest - padding;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const y = price => top + ((max - Number(price)) / (max - min)) * plotHeight;
  const step = plotWidth / visible.length;
  const candleWidth = Math.max(2, Math.min(9, step * 0.65));
  const decimals = symbol === 'USDJPY' ? 3 : symbol === 'XAUUSD' || symbol === 'BTCUSD' ? 2 : 5;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label={`${symbol} historical candlestick chart`}>
      {[0, 1, 2, 3, 4].map(i => {
        const price = max - ((max - min) * i / 4);
        const position = top + (plotHeight * i / 4);
        return (
          <g key={i}>
            <line x1={left} x2={width - right} y1={position} y2={position} stroke="#26364e" strokeDasharray="4 4" />
            <text x={left - 8} y={position + 4} fill="#8290a8" fontSize="12" textAnchor="end">{price.toFixed(decimals)}</text>
          </g>
        );
      })}
      {visible.map((candle, index) => {
        const x = left + index * step + step / 2;
        const bullish = Number(candle.close) >= Number(candle.open);
        const color = bullish ? '#13c99b' : '#fb7185';
        const bodyTop = Math.min(y(candle.open), y(candle.close));
        const bodyHeight = Math.max(1, Math.abs(y(candle.open) - y(candle.close)));
        return (
          <g key={`${candle.time}-${index}`}>
            <line x1={x} x2={x} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1.5" />
            <rect x={x - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} stroke={color} />
            <title>{`${candle.time} | O ${candle.open} H ${candle.high} L ${candle.low} C ${candle.close}`}</title>
          </g>
        );
      })}
      <text x={left} y={height - 8} fill="#8290a8" fontSize="11">{visible[0]?.time || ''}</text>
      <text x={width - right} y={height - 8} fill="#8290a8" fontSize="11" textAnchor="end">{visible[visible.length - 1]?.time || ''}</text>
    </svg>
  );
}

function App() {
  const [activePage, setActivePage] = useState('Dashboard');
  const [selectedMarket, setSelectedMarket] = useState('EURUSD');
  const [markets, setMarkets] = useState(initialMarkets);
  const [marketStatus, setMarketStatus] = useState('Connecting...');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [period, setPeriod] = useState('5min');
  const [candles, setCandles] = useState([]);
  const [candleLoading, setCandleLoading] = useState(false);
  const [candleError, setCandleError] = useState('');
  const [orderType, setOrderType] = useState('Market');
  const [direction, setDirection] = useState('BUY');
  const [lotSize, setLotSize] = useState('0.10');
  const [stopLoss, setStopLoss] = useState('100');
  const [takeProfit, setTakeProfit] = useState('200');
  const [notifications, setNotifications] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [trades, setTrades] = useState([]);
  const [search, setSearch] = useState('');
  const [orderMessage, setOrderMessage] = useState('');

  const filteredMarkets = useMemo(() => markets.filter(market =>
    market.symbol.toLowerCase().includes(search.toLowerCase()) ||
    market.name.toLowerCase().includes(search.toLowerCase())
  ), [markets, search]);

  const currentMarket = markets.find(market => market.symbol === selectedMarket);

  // Fetch the latest quote for the selected instrument every 60 seconds.
  useEffect(() => {
    let active = true;
    if (!supportedSymbols.includes(selectedMarket)) {
      setMarketStatus('Not supported');
      setLastUpdated(null);
      setMarkets(previous => previous.map(m => m.symbol === selectedMarket ? { ...m, live: false } : m));
      return () => { active = false; };
    }

    const fetchMarketPrice = async () => {
      try {
        setMarketStatus('Updating...');
        const response = await fetch(`/api/market?symbol=${encodeURIComponent(selectedMarket)}`);
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || data.details || 'Market data unavailable');
        if (!active) return;
        setMarkets(previous => previous.map(market =>
          market.symbol === selectedMarket
            ? { ...market, price: String(data.price), live: true }
            : market
        ));
        setMarketStatus('LIVE');
        setLastUpdated(data.timestamp ? new Date(data.timestamp) : new Date());
      } catch (error) {
        if (!active) return;
        setMarketStatus('Connection error');
        console.error('Market data error:', error);
      }
    };

    fetchMarketPrice();
    const timer = setInterval(fetchMarketPrice, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedMarket]);

  // Fetch historical OHLC candles whenever the instrument or timeframe changes.
  useEffect(() => {
    let active = true;

    if (!supportedSymbols.includes(selectedMarket)) {
      setCandles([]);
      setCandleError('Historical data is not supported for this instrument yet.');
      setCandleLoading(false);
      return () => { active = false; };
    }

    const fetchCandles = async () => {
      try {
        setCandleLoading(true);
        setCandleError('');
        const response = await fetch(
          `/api/candles?symbol=${encodeURIComponent(selectedMarket)}&interval=${encodeURIComponent(period)}&outputsize=100`
        );
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.details || data.error || 'Unable to load historical candles.');
        }
        if (!active) return;
        setCandles(Array.isArray(data.candles) ? data.candles : []);
      } catch (error) {
        if (!active) return;
        setCandles([]);
        setCandleError(error.message || 'Unable to load historical candles.');
        console.error('Candlestick error:', error);
      } finally {
        if (active) setCandleLoading(false);
      }
    };

    fetchCandles();
    const timer = setInterval(fetchCandles, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedMarket, period]);

  function placeDemoOrder() {
    const volume = Number(lotSize);
    const sl = Number(stopLoss);
    const tp = Number(takeProfit);
    if (!Number.isFinite(volume) || volume <= 0) {
      setOrderMessage('Enter a valid trading volume.');
      return;
    }
    if (!Number.isFinite(sl) || sl < 0) {
      setOrderMessage('Enter a valid stop loss.');
      return;
    }
    if (!Number.isFinite(tp) || tp < 0) {
      setOrderMessage('Enter a valid take profit.');
      return;
    }
    const newTrade = {
      id: Date.now(), symbol: selectedMarket, direction,
      lot: volume.toFixed(2), type: orderType,
      time: new Date().toLocaleTimeString(), status: 'DEMO OPEN'
    };
    setTrades(previous => [newTrade, ...previous]);
    setOrderMessage(`${direction} demo order created for ${selectedMarket}. No live trade was placed.`);
  }

  return (
    <div className="app-shell">
      <style>{`
        *{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:#0b1220;color:#e5e7eb}
        button,input,select{font:inherit}button{cursor:pointer}.app-shell{min-height:100vh;background:#0b1220}
        .sidebar{width:245px;position:fixed;top:0;bottom:0;left:0;background:#101a2c;border-right:1px solid #253149;padding:22px 15px;overflow-y:auto;z-index:10}
        .brand{font-size:21px;font-weight:800;color:#fff;margin-bottom:5px}.brand span{color:#19c99a}.brand-sub{color:#8290a8;font-size:11px;margin-bottom:32px}
        .nav-label{font-size:10px;color:#75839a;text-transform:uppercase;letter-spacing:1.5px;margin:20px 10px 12px}
        .nav-item{display:flex;align-items:center;gap:12px;width:100%;border:0;background:transparent;color:#aab6c9;padding:12px 11px;border-radius:8px;text-align:left;font-size:13px;margin-bottom:4px}
        .nav-item:hover,.nav-item.active{background:#17354a;color:#20d6a1}.sidebar-bottom{margin-top:35px;border-top:1px solid #253149;padding-top:18px}
        .main-area{margin-left:245px;min-height:100vh}.topbar{height:72px;display:flex;align-items:center;justify-content:space-between;padding:0 28px;border-bottom:1px solid #253149;background:#101a2c;position:sticky;top:0;z-index:5}
        .top-title{font-weight:700;font-size:17px}.top-actions{display:flex;align-items:center;gap:18px;color:#aab6c9}.icon-button{background:transparent;border:0;color:inherit;display:flex;align-items:center}
        .profile{display:flex;align-items:center;gap:10px;font-size:12px}.avatar{width:34px;height:34px;border-radius:50%;background:#176c60;display:grid;place-items:center;color:white;font-weight:bold}
        .content{padding:27px;max-width:1600px;margin:auto}.welcome{display:flex;justify-content:space-between;align-items:center;margin-bottom:23px;gap:15px}
        h1{font-size:23px;margin:0 0 7px;color:#fff}.muted{color:#8492a9;font-size:12px}.demo-badge{color:#fbbf24;background:#3b3016;padding:8px 12px;border-radius:20px;font-size:11px;font-weight:700}
        .stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:15px;margin-bottom:20px}.card{background:#121e31;border:1px solid #26364e;border-radius:11px;padding:18px;min-width:0}
        .stat-label{color:#8492a9;font-size:12px}.stat-value{font-size:23px;font-weight:700;margin:12px 0 7px;color:#fff}.positive{color:#21d6a0;font-size:12px}.negative{color:#fb7185;font-size:12px}
        .dashboard-grid{display:grid;grid-template-columns:minmax(0,1.7fr) minmax(280px,1fr);gap:17px;margin-bottom:18px}
        .card-heading{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px;gap:10px}.card-heading h3{font-size:14px;margin:0;color:#f1f5f9}
        .chart-price{font-size:23px;font-weight:700;margin-bottom:5px}.periods{display:flex;gap:5px;flex-wrap:wrap}
        .period-btn{background:#1c2a40;border:0;color:#9ba9bd;border-radius:5px;padding:6px 9px;font-size:11px}.period-btn.active{background:#087d69;color:white}
        .chart-wrap{width:100%;height:270px;overflow:hidden}.market-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #26364e;gap:10px;cursor:pointer}
        .market-row:last-child{border-bottom:0}.market-row.selected{background:#1b3044;margin:0 -9px;padding:12px 9px;border-radius:6px}
        .market-symbol{font-size:12px;font-weight:700}.market-name{color:#8290a8;font-size:10px;margin-top:4px}.market-price{font-size:12px;text-align:right}.market-change{font-size:10px;margin-top:4px;text-align:right}
        .search-box{width:100%;padding:10px;background:#0c1728;border:1px solid #2b3b52;color:white;border-radius:6px;outline:none;margin-bottom:8px;font-size:12px}
        .bottom-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:17px}.order-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field{margin-bottom:12px}
        .field label{display:block;font-size:11px;color:#8492a9;margin-bottom:7px}.field input,.field select{width:100%;background:#0b1728;border:1px solid #2b3b52;color:white;border-radius:6px;padding:10px;outline:none}
        .trade-buttons{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.buy-btn,.sell-btn{border:0;padding:12px;border-radius:6px;color:white;font-weight:700}
        .buy-btn{background:#079b78}.sell-btn{background:#dc4662}.execute-btn{width:100%;background:#2563eb;border:0;color:white;padding:12px;border-radius:6px;font-weight:700}
        .execute-btn:disabled{opacity:.5;cursor:not-allowed}.signal{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #26364e;font-size:12px;gap:10px}
        .signal:last-child{border-bottom:0}.tag{background:#153c36;color:#21d6a0;padding:5px 8px;border-radius:5px;font-size:10px}
        .table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:450px}th,td{padding:12px 9px;text-align:left;border-bottom:1px solid #26364e;font-size:11px}
        th{color:#8290a8;font-weight:500}td{color:#dbe4f0}.empty{color:#8290a8;text-align:center;padding:25px;font-size:12px}
        .page-placeholder{min-height:350px;display:grid;place-items:center;text-align:center;color:#8492a9}.page-placeholder h2{color:white}.mobile-menu{display:none}
        @media(max-width:1050px){.stats-grid{grid-template-columns:repeat(2,1fr)}.dashboard-grid{grid-template-columns:1fr}}
        @media(max-width:700px){.sidebar{transform:translateX(-100%);transition:.2s}.sidebar.open{transform:translateX(0)}.main-area{margin-left:0}.mobile-menu{display:flex}
          .topbar{padding:0 15px}.content{padding:16px}.bottom-grid{grid-template-columns:1fr}.welcome{align-items:flex-start;flex-direction:column}
          .profile span{display:none}.top-actions{gap:12px}.card-heading{align-items:flex-start;flex-direction:column}}
        @media(max-width:400px){.stats-grid{grid-template-columns:1fr 1fr;gap:8px}.stat-value{font-size:18px}.card{padding:13px}}
      `}</style>

      <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
        <div className="brand">TradeLab <span>AI</span></div>
        <div className="brand-sub">PROFESSIONAL TRADING PLATFORM</div>
        <div className="nav-label">Workspace</div>
        {navigation.map(item => {
          const Icon = item.icon;
          return (
            <button key={item.name} className={`nav-item ${activePage === item.name ? 'active' : ''}`}
              onClick={() => { setActivePage(item.name); setSidebarOpen(false); }}>
              <Icon size={17} />{item.name}
            </button>
          );
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(!sidebarOpen)}><Menu size={21} /></button>
            <div className="top-title">{activePage}</div>
          </div>
          <div className="top-actions">
            <button className="icon-button" onClick={() => setNotifications(!notifications)} title="Toggle notifications">
              <Bell size={19} color={notifications ? '#20d6a1' : '#8492a9'} />
            </button>
            <button className="icon-button"><Moon size={19} /></button>
            <div className="profile"><div className="avatar">TL</div><span>Trader Account</span><ChevronDown size={14} /></div>
          </div>
        </header>

        <section className="content">
          {activePage === 'Dashboard' ? (
            <>
              <div className="welcome">
                <div><h1>Welcome to TradeLab AI Pro</h1><div className="muted">Your multi-market trading analysis workspace.</div></div>
                <div className="demo-badge">● DEMO MODE</div>
              </div>

              <div className="stats-grid">
                <div className="card"><div className="stat-label">Demo Account Balance</div><div className="stat-value">$10,000.00</div><div className="positive">Virtual account</div></div>
                <div className="card"><div className="stat-label">Demo Orders</div><div className="stat-value">{trades.length}</div><div className="muted">Simulated orders created</div></div>
                <div className="card"><div className="stat-label">Market Status</div><div className="stat-value" style={{ fontSize: 19 }}>{marketStatus}</div><div className="muted">{lastUpdated ? `Updated: ${lastUpdated.toLocaleTimeString()}` : 'Waiting for market data'}</div></div>
                <div className="card"><div className="stat-label">Selected Instrument</div><div className="stat-value" style={{ fontSize: 19 }}>{selectedMarket}</div><div className="muted">{currentMarket?.live ? 'Live price received' : 'Live price not confirmed'}</div></div>
              </div>

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
