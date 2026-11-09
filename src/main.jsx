import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity, ArrowDownRight, ArrowUpRight, Bell, Bot, BarChart3,
  ChevronDown, Clock3, LayoutDashboard, LockKeyhole, LogOut, Menu,
  Moon, Radio, Settings, ShieldCheck, SlidersHorizontal, Sparkles,
  TrendingUp, Wallet
} from 'lucide-react';
import './style.css';

const initialMarkets = [
  { symbol: 'EURUSD', name: 'Euro / US Dollar', price: '—' },
  { symbol: 'GBPUSD', name: 'British Pound / US Dollar', price: '—' },
  { symbol: 'USDJPY', name: 'US Dollar / Japanese Yen', price: '—' },
  { symbol: 'XAUUSD', name: 'Gold / US Dollar', price: '—' },
  { symbol: 'US30', name: 'Dow Jones Industrial Average', price: '—' },
  { symbol: 'BTCUSD', name: 'Bitcoin / US Dollar', price: '—' }
];

const supportedSymbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];

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

function CandlestickChart({ candles, loading, error, symbol }) {
  const [show, setShow] = useState({ ema20: true, ema50: true, ema200: true, bb: true, levels: true });
  const [visibleCount, setVisibleCount] = useState(100);
  const [pointer, setPointer] = useState(null);
  if (loading) return <div className="empty">Loading historical candles…</div>;
  if (error) return <div className="empty">{error}</div>;
  if (!candles?.length) return <div className="empty">No historical candles available.</div>;

  const count = Math.min(candles.length, visibleCount);
  const visible = candles.slice(-count);
  const width = 1000, height = 310, left = 72, right = 18, top = 28, bottom = 35;
  const closes = candles.map(c => Number(c.close));
  const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50), ema200 = calcEMA(closes, 200);
  const bands = calcBollinger(closes, 20, 2);
  const levels = detectSupportResistance(candles.slice(-180));
  const offset = candles.length - visible.length;
  const visibleBands = bands.slice(offset), visibleEma20 = ema20.slice(offset);
  const visibleEma50 = ema50.slice(offset), visibleEma200 = ema200.slice(offset);
  const overlayValues = [
    ...(show.ema20 ? visibleEma20 : []), ...(show.ema50 ? visibleEma50 : []),
    ...(show.ema200 ? visibleEma200 : []), ...(show.bb ? visibleBands.flatMap(b => b ? [b.upper,b.middle,b.lower] : []) : []),
    ...(show.levels ? levels.map(level => level.price) : [])
  ].filter(v => v != null && Number.isFinite(v));
  const highest = Math.max(...visible.map(c => Number(c.high)), ...overlayValues);
  const lowest = Math.min(...visible.map(c => Number(c.low)), ...overlayValues);
  const padding = (highest - lowest) * 0.08 || Math.abs(highest) * 0.001 || 0.001;
  const max = highest + padding, min = lowest - padding;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const y = price => top + ((max - Number(price)) / (max - min)) * plotHeight;
  const step = plotWidth / visible.length;
  const xAt = i => left + i * step + step / 2;
  const candleWidth = Math.max(2, Math.min(9, step * 0.65));
  const decimals = symbol === 'USDJPY' ? 3 : symbol === 'BTCUSD' ? 1 : symbol === 'XAUUSD' ? 2 : 5;
  const makePath = values => values.map((v, i) => v == null || !Number.isFinite(v) ? null : `${i === 0 || values[i - 1] == null ? 'M' : 'L'} ${xAt(i)} ${y(v)}`).filter(Boolean).join(' ');
  const bandPath = key => visibleBands.map((b, i) => {
    const v = b?.[key];
    return v == null || !Number.isFinite(v) ? null : `${i === 0 || !visibleBands[i - 1]?.[key] ? 'M' : 'L'} ${xAt(i)} ${y(v)}`;
  }).filter(Boolean).join(' ');
  const setOverlay = key => setShow(old => ({ ...old, [key]: !old[key] }));
  const control = (key, label, color) => <label key={key} style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:10,color,cursor:'pointer'}}><input type="checkbox" checked={show[key]} onChange={() => setOverlay(key)} />{label}</label>;

  return <div style={{width:'100%',height:'100%',display:'flex',flexDirection:'column',gap:7}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8,flexWrap:'wrap'}}>
      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
        {control('ema20','EMA 20','#f472b6')}{control('ema50','EMA 50','#38bdf8')}
        {control('ema200','EMA 200','#f59e0b')}{control('bb','Bollinger','#a78bfa')}{control('levels','S/R levels','#fbbf24')}
      </div>
      <div style={{display:'flex',alignItems:'center',gap:5}}>
        <button className="period-btn" onClick={() => {setVisibleCount(n => Math.max(20,n-20));setPointer(null);}} title="Zoom in">＋</button>
        <button className="period-btn" onClick={() => {setVisibleCount(n => Math.min(candles.length,n+20));setPointer(null);}} title="Zoom out">－</button>
        <button className="period-btn" onClick={() => {setVisibleCount(100);setPointer(null);}}>Reset</button>
      </div>
    </div>
    <div style={{flex:1,minHeight:0,position:'relative'}}>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="100%" preserveAspectRatio="none" role="img" aria-label={`${symbol} candlestick chart with technical overlays`}
        onMouseMove={e => { const rect=e.currentTarget.getBoundingClientRect(); const ratio=(e.clientX-rect.left)/rect.width; const index=Math.max(0,Math.min(visible.length-1,Math.floor(((ratio*width)-left)/plotWidth*visible.length))); const py=(e.clientY-rect.top)/rect.height*height; setPointer({index,py}); }}
        onMouseLeave={() => setPointer(null)}>
        {[0,1,2,3,4].map(i => { const value=max-((max-min)*i/4), py=top+(plotHeight*i/4); return <g key={i}><line x1={left} x2={width-right} y1={py} y2={py} stroke="#26364e" strokeDasharray="4 4"/><text x={left-8} y={py+4} fill="#8290a8" fontSize="12" textAnchor="end">{value.toFixed(decimals)}</text></g>; })}
        {show.bb && <><path d={bandPath('upper')} fill="none" stroke="#a78bfa" strokeWidth="1.4" strokeDasharray="5 4" opacity="0.9"/><path d={bandPath('middle')} fill="none" stroke="#a78bfa" strokeWidth="1" opacity="0.55"/><path d={bandPath('lower')} fill="none" stroke="#a78bfa" strokeWidth="1.4" strokeDasharray="5 4" opacity="0.9"/></>}
        {show.ema200 && <path d={makePath(visibleEma200)} fill="none" stroke="#f59e0b" strokeWidth="2"/>}
        {show.ema50 && <path d={makePath(visibleEma50)} fill="none" stroke="#38bdf8" strokeWidth="1.8"/>}
        {show.ema20 && <path d={makePath(visibleEma20)} fill="none" stroke="#f472b6" strokeWidth="1.8"/>}
        {show.levels && levels.map((level,i) => <g key={`level-${i}`}><line x1={left} x2={width-right} y1={y(level.price)} y2={y(level.price)} stroke={level.type==='Resistance'?'#fb7185':'#34d399'} strokeWidth="1.5" strokeDasharray="7 4" opacity="0.9"/><text x={width-right-4} y={y(level.price)-4} textAnchor="end" fill={level.type==='Resistance'?'#fb7185':'#34d399'} fontSize="11">{level.type} {level.price.toFixed(decimals)}</text></g>)}
        {visible.map((c,i) => { const x=xAt(i), bullish=Number(c.close)>=Number(c.open), color=bullish?'#13c99b':'#fb7185'; const bodyTop=Math.min(y(c.open),y(c.close)), bodyHeight=Math.max(1,Math.abs(y(c.open)-y(c.close))); return <g key={`${c.time}-${i}`}><line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1.5"/><rect x={x-candleWidth/2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} stroke={color}/></g>; })}
        {pointer && (() => {const c=visible[pointer.index], x=xAt(pointer.index), py=Math.max(top,Math.min(height-bottom,pointer.py));return <g><line x1={x} x2={x} y1={top} y2={height-bottom} stroke="#dbeafe" strokeDasharray="4 4" opacity="0.75"/><line x1={left} x2={width-right} y1={py} y2={py} stroke="#dbeafe" strokeDasharray="4 4" opacity="0.75"/><rect x={Math.min(width-215,Math.max(left,x-95))} y={top+5} width="205" height="43" rx="5" fill="#0b1728" stroke="#52647e"/><text x={Math.min(width-205,Math.max(left+10,x-85))} y={top+21} fill="#e2e8f0" fontSize="11">{c.time}</text><text x={Math.min(width-205,Math.max(left+10,x-85))} y={top+38} fill="#20d6a1" fontSize="11">O {Number(c.open).toFixed(decimals)}  H {Number(c.high).toFixed(decimals)}  L {Number(c.low).toFixed(decimals)}  C {Number(c.close).toFixed(decimals)}</text></g>;})()}
        <text x={left} y={height-8} fill="#8290a8" fontSize="11">{visible[0]?.time || ''}</text>
        <text x={width-right} y={height-8} fill="#8290a8" fontSize="11" textAnchor="end">{visible[visible.length-1]?.time || ''}</text>
      </svg>
    </div>
    <div className="muted">Showing {visible.length} of {candles.length} candles · Hover over chart for OHLC crosshair · use + / − to zoom.</div>
  </div>;
}


// Identify repeated swing highs/lows and group nearby prices into practical chart levels.
function detectSupportResistance(candles) {
  if (!candles || candles.length < 12) return [];
  const pivots = [];
  const leftRight = 3;
  for (let i = leftRight; i < candles.length - leftRight; i++) {
    const high = Number(candles[i].high), low = Number(candles[i].low);
    const window = candles.slice(i-leftRight, i+leftRight+1);
    if (window.every((c,j) => j===leftRight || high >= Number(c.high))) pivots.push({price:high,type:'Resistance'});
    if (window.every((c,j) => j===leftRight || low <= Number(c.low))) pivots.push({price:low,type:'Support'});
  }
  const current = Number(candles[candles.length-1].close);
  const tolerance = Math.max(Math.abs(current)*0.0012, 0.00001);
  const groups = [];
  pivots.forEach(p => {
    let group = groups.find(g => g.type===p.type && Math.abs(g.price-p.price)<=tolerance);
    if (!group) groups.push({price:p.price,type:p.type,touches:1,total:p.price});
    else { group.touches++; group.total+=p.price; group.price=group.total/group.touches; }
  });
  return groups.filter(g=>g.touches>=2).map(g=>({...g,price:g.total/g.touches}))
    .sort((a,b)=>b.touches-a.touches)
    .filter(g=>g.type==='Support'?g.price<current:g.price>current)
    .slice(0,3);
}

// ---------------- Technical indicator calculations ----------------
const average = values => values.length ? values.reduce((a,b)=>a+b,0)/values.length : null;
function calcEMA(values, period) {
  if (values.length < period) return [];
  const k=2/(period+1), out=[];
  let prev=average(values.slice(0,period));
  out[period-1]=prev;
  for(let i=period;i<values.length;i++){ prev=values[i]*k+prev*(1-k); out[i]=prev; }
  return out;
}
function calcRSI(values, period=14) {
  if(values.length<=period) return [];
  let gains=0,losses=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>=0)gains+=d;else losses-=d;}
  let avgGain=gains/period,avgLoss=losses/period,out=Array(values.length).fill(null);
  out[period]=avgLoss===0?100:100-100/(1+avgGain/avgLoss);
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];avgGain=(avgGain*(period-1)+Math.max(d,0))/period;avgLoss=(avgLoss*(period-1)+Math.max(-d,0))/period;out[i]=avgLoss===0?100:100-100/(1+avgGain/avgLoss);}
  return out;
}
function calcMACD(values, fast=12, slow=26, signal=9){
  const f=calcEMA(values,fast),s=calcEMA(values,slow),line=values.map((_,i)=>f[i]!=null&&s[i]!=null?f[i]-s[i]:null);
  const compact=line.filter(v=>v!=null), sigCompact=calcEMA(compact,signal), sig=Array(values.length).fill(null);let j=0;
  line.forEach((v,i)=>{if(v!=null){sig[i]=sigCompact[j];j++;}});
  return {line,signal:sig,histogram:line.map((v,i)=>v!=null&&sig[i]!=null?v-sig[i]:null)};
}
function calcBollinger(values,period=20,mult=2){return values.map((_,i)=>{if(i<period-1)return null;const a=values.slice(i-period+1,i+1),m=average(a),sd=Math.sqrt(average(a.map(v=>(v-m)**2)));return {middle:m,upper:m+mult*sd,lower:m-mult*sd};});}
function calcATR(candles,period=14){const tr=candles.map((c,i)=>i===0?Number(c.high)-Number(c.low):Math.max(Number(c.high)-Number(c.low),Math.abs(Number(c.high)-Number(candles[i-1].close)),Math.abs(Number(c.low)-Number(candles[i-1].close))));if(tr.length<period)return [];let prev=average(tr.slice(0,period)),out=Array(tr.length).fill(null);out[period-1]=prev;for(let i=period;i<tr.length;i++){prev=((prev*(period-1))+tr[i])/period;out[i]=prev;}return out;}
function calcADX(candles,period=14){
  const n=candles.length, tr=[],pdm=[],mdm=[];
  for(let i=0;i<n;i++){if(!i){tr.push(null);pdm.push(0);mdm.push(0);continue;}const up=Number(candles[i].high)-Number(candles[i-1].high),down=Number(candles[i-1].low)-Number(candles[i].low);pdm.push(up>down&&up>0?up:0);mdm.push(down>up&&down>0?down:0);tr.push(Math.max(Number(candles[i].high)-Number(candles[i].low),Math.abs(Number(candles[i].high)-Number(candles[i-1].close)),Math.abs(Number(candles[i].low)-Number(candles[i-1].close))));}
  const smooth=a=>{let out=Array(n).fill(null);if(n<=period)return out;let v=a.slice(1,period+1).reduce((x,y)=>x+y,0);out[period]=v;for(let i=period+1;i<n;i++){v=v-v/period+a[i];out[i]=v;}return out;};
  const atr=smooth(tr.map(v=>v??0)),ps=smooth(pdm),ms=smooth(mdm),dx=Array(n).fill(null);
  for(let i=period;i<n;i++){if(atr[i]>0){const p=100*ps[i]/atr[i],m=100*ms[i]/atr[i];dx[i]=p+m?100*Math.abs(p-m)/(p+m):0;}}
  const adx=Array(n).fill(null);let valid=dx.map((v,i)=>v==null?null:{v,i}).filter(Boolean);if(valid.length>=period){let start=valid.slice(0,period).reduce((a,x)=>a+x.v,0)/period;adx[valid[period-1].i]=start;for(let k=period;k<valid.length;k++){start=(start*(period-1)+valid[k].v)/period;adx[valid[k].i]=start;}}
  return adx;
}
function calcStochastic(candles,kPeriod=14,dPeriod=3){const k=candles.map((c,i)=>{if(i<kPeriod-1)return null;const w=candles.slice(i-kPeriod+1,i+1),hi=Math.max(...w.map(x=>Number(x.high))),lo=Math.min(...w.map(x=>Number(x.low)));return hi===lo?50:(Number(c.close)-lo)/(hi-lo)*100;});const d=k.map((_,i)=>{const w=k.slice(Math.max(0,i-dPeriod+1),i+1).filter(v=>v!=null);return w.length===dPeriod?average(w):null;});return {k,d};}
function buildIndicators(candles, periods){const closes=candles.map(c=>Number(c.close));return {emaFast:calcEMA(closes,periods.emaFast),emaSlow:calcEMA(closes,periods.emaSlow),emaLong:calcEMA(closes,periods.emaLong),rsi:calcRSI(closes,periods.rsi),macd:calcMACD(closes),bb:calcBollinger(closes,periods.bb,2),atr:calcATR(candles,periods.atr),adx:calcADX(candles,periods.adx),stoch:calcStochastic(candles)};}
function IndicatorSuite({candles,symbol}){
  const [enabled,setEnabled]=useState({emaFast:true,emaSlow:true,emaLong:false,rsi:true,macd:true,bb:true,atr:true,adx:true,stoch:true,bbPosition:true});
  const [periods,setPeriods]=useState({emaFast:20,emaSlow:50,emaLong:200,rsi:14,bb:20,atr:14,adx:14});
  const [showSettings,setShowSettings]=useState(false);
  const data=useMemo(()=>buildIndicators(candles,periods),[candles,periods]);
  const last=arr=>{for(let i=arr.length-1;i>=0;i--)if(arr[i]!=null)return arr[i];return null;};
  const close=Number(candles.at(-1)?.close), ef=last(data.emaFast),es=last(data.emaSlow),el=last(data.emaLong),r=last(data.rsi),m=last(data.macd.line),ms=last(data.macd.signal),a=last(data.adx),atr=last(data.atr),sk=last(data.stoch.k),sd=last(data.stoch.d),bb=last(data.bb);
  const votes=[ef!=null&&es!=null?(ef>es?1:-1):0,m!=null&&ms!=null?(m>ms?1:-1):0,r!=null?(r>55?1:r<45?-1:0):0,el!=null?(close>el?1:-1):0];const score=votes.reduce((x,y)=>x+y,0);const bias=score>=2?'BULLISH':score<=-2?'BEARISH':'MIXED';
  const fmt=(v,d=5,required=0)=>v==null||!Number.isFinite(v)?`Insufficient data (need ${required || 'more'} candles; received ${candles.length})`:v.toFixed(d);
  const toggle=(key,label,desc,value)=> <div className="signal" key={key}><span><label style={{display:'flex',gap:8,alignItems:'center'}}><input type="checkbox" checked={!!enabled[key]} onChange={e=>setEnabled(p=>({...p,[key]:e.target.checked}))}/><span>{label}</span></label><small className="muted" style={{display:'block',marginLeft:23}}>{desc}</small></span><strong>{enabled[key] ? value : 'Hidden'}</strong></div>;
  return <div className="card" style={{marginTop:18}}>
    <div className="card-heading"><div><h3>Technical Indicators</h3><div className="muted">Calculated from {candles.length} fetched {symbol} candles · latest candle values</div></div><button className="period-btn" onClick={()=>setShowSettings(v=>!v)}>{showSettings?'Hide settings':'Indicator settings'}</button></div>
    <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap',marginBottom:12}}><span className="tag" style={{background:bias==='BULLISH'?'#153c36':bias==='BEARISH'?'#492532':'#3b3016',color:bias==='BULLISH'?'#21d6a0':bias==='BEARISH'?'#fb7185':'#fbbf24'}}>TECHNICAL BIAS: {bias}</span><span className="muted">Directional score: {score>0?'+':''}{score} / 4 · Not a trade instruction</span></div>
    {showSettings&&<div className="order-grid" style={{marginBottom:14}}>{[['emaFast','EMA fast'],['emaSlow','EMA slow'],['emaLong','EMA long'],['rsi','RSI period'],['bb','Bollinger period'],['atr','ATR period'],['adx','ADX period']].map(([key,label])=><div className="field" key={key}><label>{label}</label><input type="number" min="2" max="250" value={periods[key]} onChange={e=>setPeriods(p=>({...p,[key]:Math.max(2,Math.min(250,Number(e.target.value)||2))}))}/></div>)}</div>}
    <div className="dashboard-grid" style={{marginBottom:0}}><div>
      {toggle('emaFast',`EMA ${periods.emaFast}`,'Short-term trend average',fmt(ef,symbol==='USDJPY'?3:5,periods.emaFast))}
      {toggle('emaSlow',`EMA ${periods.emaSlow}`,'Medium-term trend average',fmt(es,symbol==='USDJPY'?3:5,periods.emaSlow))}
      {toggle('emaLong',`EMA ${periods.emaLong}`,'Long-term trend filter',fmt(el,symbol==='USDJPY'?3:5,periods.emaLong))}
      {toggle('rsi',`RSI (${periods.rsi})`,'Above 70 overbought · below 30 oversold',fmt(r,2,periods.rsi+1))}
      {toggle('macd','MACD (12, 26, 9)','Momentum line versus signal',m==null?'Insufficient data':`${m.toFixed(6)} / ${fmt(ms,6)}`)}
    </div><div>
      {toggle('bb',`Bollinger Bands (${periods.bb}, 2)`,'Upper / middle / lower volatility bands',bb?`${bb.upper.toFixed(5)} / ${bb.middle.toFixed(5)} / ${bb.lower.toFixed(5)}`:'Insufficient data')}
      {toggle('atr',`ATR (${periods.atr})`,'Average true range · volatility, not direction',fmt(atr, symbol==='USDJPY'?3:5,periods.atr))}
      {toggle('adx',`ADX (${periods.adx})`,'Below 20 weak · above 25 stronger trend',fmt(a,2,periods.adx*2))}
      {toggle('stoch','Stochastic (14, 3)','%K / %D momentum oscillator',sk==null?'Insufficient data':`${sk.toFixed(2)} / ${fmt(sd,2)}`)}
      {toggle('bbPosition','Price vs Bollinger','Position relative to volatility envelope',bb?(close>bb.upper?'Above upper band':close<bb.lower?'Below lower band':'Inside bands'):'Insufficient data')}
    </div></div>
    <div className="muted" style={{marginTop:14,lineHeight:1.7}}>Interpretation: EMA alignment and MACD compare trend/momentum; RSI and Stochastic indicate momentum extremes; Bollinger Bands describe relative volatility; ATR estimates typical range; ADX estimates trend strength. Signals can conflict and are not guaranteed predictions. Forex volume is not used because the current feed does not provide verified traded volume.</div>
  </div>;
}

function App() {
  const [activePage, setActivePage] = useState('Dashboard');
  const [selectedMarket, setSelectedMarket] = useState('EURUSD');
  const [markets, setMarkets] = useState(initialMarkets);
  const [marketStatus, setMarketStatus] = useState('Connecting…');
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

  const filteredMarkets = useMemo(() => markets.filter(m =>
    m.symbol.toLowerCase().includes(search.toLowerCase()) ||
    m.name.toLowerCase().includes(search.toLowerCase())
  ), [markets, search]);

  const currentMarket = markets.find(m => m.symbol === selectedMarket);

  // Latest quote polling. This is periodic HTTP refresh, not tick streaming.
  useEffect(() => {
    let active = true;
    if (!supportedSymbols.includes(selectedMarket)) {
      setMarketStatus('Not supported');
      setLastUpdated(null);
      return () => { active = false; };
    }
    const fetchPrice = async () => {
      try {
        setMarketStatus('Updating…');
        const response = await fetch(`/api/market?symbol=${encodeURIComponent(selectedMarket)}`);
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || data.details || 'Market data unavailable');
        if (!active) return;
        setMarkets(previous => previous.map(m => m.symbol === selectedMarket
          ? { ...m, price: String(data.price), live: true } : m));
        setMarketStatus('LIVE');
        setLastUpdated(data.timestamp ? new Date(data.timestamp) : new Date());
      } catch (error) {
        if (!active) return;
        setMarketStatus('Connection error');
        console.error('Market data error:', error);
      }
    };
    fetchPrice();
    const timer = setInterval(fetchPrice, 60000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedMarket]);

  // Historical candles polling.
  useEffect(() => {
    let active = true;
    if (!supportedSymbols.includes(selectedMarket)) {
      setCandles([]);
      setCandleError('Historical data is not supported for this instrument (US30 is not connected).');
      setCandleLoading(false);
      return () => { active = false; };
    }
    const fetchCandles = async () => {
      try {
        setCandleLoading(true);
        setCandleError('');
        const response = await fetch(`/api/candles?symbol=${encodeURIComponent(selectedMarket)}&interval=${encodeURIComponent(period)}&outputsize=300`);
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.details || data.error || 'Unable to load historical candles.');
        if (!active) return;
        setCandles(Array.isArray(data.candles) ? data.candles : []);
      } catch (error) {
        if (!active) return;
        setCandleError(error.message);
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
    const volume = Number(lotSize), sl = Number(stopLoss), tp = Number(takeProfit);
    if (!Number.isFinite(volume) || volume <= 0) return setOrderMessage('Enter a valid trading volume.');
    if (!Number.isFinite(sl) || sl < 0) return setOrderMessage('Enter a valid stop loss.');
    if (!Number.isFinite(tp) || tp < 0) return setOrderMessage('Enter a valid take profit.');
    const trade = {
      id: Date.now(), symbol: selectedMarket, direction,
      lot: volume.toFixed(2), type: orderType,
      time: new Date().toLocaleTimeString(), status: 'DEMO OPEN'
    };
    setTrades(previous => [trade, ...previous]);
    setOrderMessage(`${direction} demo order created for ${selectedMarket}. No broker order was sent.`);
  }

  return (
    <div className="app-shell">
      <style>{`
        *{box-sizing:border-box} body{margin:0;font-family:Arial,sans-serif;background:#0b1220;color:#e5e7eb}
        button,input,select{font:inherit}button{cursor:pointer}.app-shell{min-height:100vh;background:#0b1220}
        .sidebar{width:245px;position:fixed;inset:0 auto 0 0;background:#101a2c;border-right:1px solid #253149;padding:22px 15px;overflow-y:auto;z-index:10}
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
        .chart-price{font-size:23px;font-weight:700;margin-bottom:5px}.periods{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
        .period-btn{background:#1c2a40;border:0;color:#9ba9bd;border-radius:5px;padding:6px 9px;font-size:11px}.period-btn.active{background:#087d69;color:white}
        .chart-wrap{width:100%;height:270px}.market-row{display:flex;justify-content:space-between;align-items:center;padding:12px 0;border-bottom:1px solid #26364e;gap:10px;cursor:pointer}
        .market-row:last-child{border-bottom:0}.market-row.selected{background:#1b3044;margin:0 -9px;padding:12px 9px;border-radius:6px}
        .market-symbol{font-size:12px;font-weight:700}.market-name{color:#8290a8;font-size:10px;margin-top:4px}.market-price{font-size:12px;text-align:right}.market-change{font-size:10px;margin-top:4px;text-align:right}
        .search-box{width:100%;padding:10px;background:#0c1728;border:1px solid #2b3b52;color:white;border-radius:6px;outline:none;margin-bottom:8px;font-size:12px}
        .bottom-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:17px}.order-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.field{margin-bottom:12px}
        .field label{display:block;font-size:11px;color:#8492a9;margin-bottom:7px}.field input,.field select{width:100%;background:#0b1728;border:1px solid #2b3b52;color:white;border-radius:6px;padding:10px;outline:none}
        .trade-buttons{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}.buy-btn,.sell-btn{border:0;padding:12px;border-radius:6px;color:white;font-weight:700}
        .buy-btn{background:#079b78}.sell-btn{background:#dc4662}.execute-btn{width:100%;background:#2563eb;border:0;color:white;padding:12px;border-radius:6px;font-weight:700}
        .signal{display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #26364e;font-size:12px;gap:10px}.signal:last-child{border-bottom:0}
        .tag{background:#153c36;color:#21d6a0;padding:5px 8px;border-radius:5px;font-size:10px}.table-wrap{overflow-x:auto}
        table{width:100%;border-collapse:collapse;min-width:450px}th,td{padding:12px 9px;text-align:left;border-bottom:1px solid #26364e;font-size:11px}th{color:#8290a8;font-weight:500}td{color:#dbe4f0}
        .empty{color:#8290a8;text-align:center;padding:25px;font-size:12px}.page-placeholder{min-height:350px;display:grid;place-items:center;text-align:center;color:#8492a9}
        .page-placeholder h2{color:white}.mobile-menu{display:none}
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

            <IndicatorSuite candles={candles} symbol={selectedMarket}/>

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
          </> : activePage === 'Market Analysis' ? <>
            <div className="welcome"><div><h1>Market Analysis & Indicators</h1><div className="muted">Technical studies for the selected instrument and timeframe.</div></div><div className="demo-badge">● ANALYSIS ONLY</div></div>
            <div className="card"><div className="card-heading"><h3>{selectedMarket} · {period} chart</h3><div className="periods">{[['1min','1m'],['5min','5m'],['15min','15m'],['30min','30m'],['1h','1h'],['4h','4h']].map(([v,l])=><button key={v} className={`period-btn ${period===v?'active':''}`} onClick={()=>setPeriod(v)}>{l}</button>)}</div></div><div className="chart-wrap"><CandlestickChart candles={candles} loading={candleLoading} error={candleError} symbol={selectedMarket}/></div><div className="muted">{candles.length} historical candles. Indicator values are computed only when sufficient candle history exists.</div></div>
            <IndicatorSuite candles={candles} symbol={selectedMarket}/>
          </> : <div className="card page-placeholder"><div><Sparkles size={35} color="#20d6a1"/><h2>{activePage}</h2>
            <p>This module is part of the TradeLab AI Pro development plan.</p>
            <p>We will activate its full functionality as we integrate market data, broker services and the platform backend.</p>
          </div></div>}

          <div style={{textAlign:'center',padding:'25px 10px',color:'#718096',fontSize:11}}>
            TradeLab AI Pro · Development Version · Demo Environment<br/>
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
