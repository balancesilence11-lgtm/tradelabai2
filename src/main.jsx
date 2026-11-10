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
  { name: 'Technical Indicators', icon: SlidersHorizontal },
  { name: 'AI Analysis', icon: Sparkles },
  { name: 'AI Assistant', icon: Bot },
  { name: 'Strategy Lab', icon: Activity },
  { name: 'Performance Analytics', icon: BarChart3 },
{ name: 'Advanced Analytics', icon: BarChart3 },
  { name: 'Trading Terminal', icon: TrendingUp },
  { name: 'Smart Scanner', icon: SlidersHorizontal },
  { name: 'Risk Centre', icon: ShieldCheck },
  { name: 'Portfolio Risk', icon: ShieldCheck },
  { name: 'Trade Journal', icon: Clock3 },
  { name: 'Automation Centre', icon: Radio },
  { name: 'Account Overview', icon: Wallet },
  { name: 'Security Centre', icon: LockKeyhole },
  { name: 'Settings', icon: Settings }
];

function CandlestickChart({ candles, loading, error, symbol }) {
  const [show, setShow] = useState({ ema20: true, ema50: true, ema200: true, bb: true, levels: true, trendlines: true, structure: true });
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
  const swings = detectSwingPoints(visible);
  const trendlines = buildTrendlines(swings);
  const structure = detectMarketStructure(visible, swings);
  const offset = candles.length - visible.length;
  const visibleBands = bands.slice(offset), visibleEma20 = ema20.slice(offset);
  const visibleEma50 = ema50.slice(offset), visibleEma200 = ema200.slice(offset);
  const overlayValues = [
    ...(show.ema20 ? visibleEma20 : []), ...(show.ema50 ? visibleEma50 : []),
    ...(show.ema200 ? visibleEma200 : []), ...(show.bb ? visibleBands.flatMap(b => b ? [b.upper,b.middle,b.lower] : []) : []),
    ...(show.levels ? levels.map(level => level.price) : []),
    ...(show.trendlines ? trendlines.flatMap(line => [line.start.price, line.end.price]) : []),
    ...(show.structure && structure.event ? [structure.event.level] : [])
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
        {control('ema200','EMA 200','#f59e0b')}{control('bb','Bollinger','#a78bfa')}{control('levels','S/R levels','#fbbf24')}{control('trendlines','Trendlines','#c4b5fd')}{control('structure','BOS / CHoCH','#facc15')}
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
        {show.trendlines && trendlines.map((line,i) => { const x1=xAt(line.start.index), x2=xAt(line.end.index); return <g key={`trend-${i}`}><line x1={x1} y1={y(line.start.price)} x2={x2} y2={y(line.end.price)} stroke={line.type==='Uptrend'?'#34d399':'#fb7185'} strokeWidth="2" strokeDasharray="8 4"/><text x={x2} y={y(line.end.price)-7} fill={line.type==='Uptrend'?'#34d399':'#fb7185'} fontSize="10" textAnchor="end">{line.type} line</text></g>; })}
        {show.structure && structure.event && <g><line x1={left} x2={width-right} y1={y(structure.event.level)} y2={y(structure.event.level)} stroke="#facc15" strokeWidth="1.5" strokeDasharray="3 5"/><rect x={width-right-100} y={Math.max(top+4,y(structure.event.level)-24)} width="96" height="19" rx="4" fill="#30270c" stroke="#facc15"/><text x={width-right-52} y={Math.max(top+17,y(structure.event.level)-11)} textAnchor="middle" fill="#facc15" fontSize="10">{structure.event.label}</text></g>}
        {visible.map((c,i) => { const x=xAt(i), bullish=Number(c.close)>=Number(c.open), color=bullish?'#13c99b':'#fb7185'; const bodyTop=Math.min(y(c.open),y(c.close)), bodyHeight=Math.max(1,Math.abs(y(c.open)-y(c.close))); return <g key={`${c.time}-${i}`}><line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke={color} strokeWidth="1.5"/><rect x={x-candleWidth/2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} stroke={color}/></g>; })}
        {pointer && (() => {const c=visible[pointer.index], x=xAt(pointer.index), py=Math.max(top,Math.min(height-bottom,pointer.py));return <g><line x1={x} x2={x} y1={top} y2={height-bottom} stroke="#dbeafe" strokeDasharray="4 4" opacity="0.75"/><line x1={left} x2={width-right} y1={py} y2={py} stroke="#dbeafe" strokeDasharray="4 4" opacity="0.75"/><rect x={Math.min(width-215,Math.max(left,x-95))} y={top+5} width="205" height="43" rx="5" fill="#0b1728" stroke="#52647e"/><text x={Math.min(width-205,Math.max(left+10,x-85))} y={top+21} fill="#e2e8f0" fontSize="11">{c.time}</text><text x={Math.min(width-205,Math.max(left+10,x-85))} y={top+38} fill="#20d6a1" fontSize="11">O {Number(c.open).toFixed(decimals)}  H {Number(c.high).toFixed(decimals)}  L {Number(c.low).toFixed(decimals)}  C {Number(c.close).toFixed(decimals)}</text></g>;})()}
        <text x={left} y={height-8} fill="#8290a8" fontSize="11">{visible[0]?.time || ''}</text>
        <text x={width-right} y={height-8} fill="#8290a8" fontSize="11" textAnchor="end">{visible[visible.length-1]?.time || ''}</text>
      </svg>
    </div>
    <div className="muted">Showing {visible.length} of {candles.length} candles · Hover over chart for OHLC crosshair · use + / − to zoom. {structure.event ? `Latest structure: ${structure.event.label} at ${structure.event.level.toFixed(decimals)}.` : 'No confirmed BOS/CHoCH break in the visible window.'}</div>
  </div>;
}


// Confirmed swing points use three candles on each side to reduce noisy pivots.
function detectSwingPoints(candles, strength=3) {
  const highs=[], lows=[];
  for(let i=strength;i<candles.length-strength;i++) {
    const h=Number(candles[i].high), l=Number(candles[i].low);
    const window=candles.slice(i-strength,i+strength+1);
    if(window.every((c,j)=>j===strength || h>=Number(c.high))) highs.push({index:i,price:h});
    if(window.every((c,j)=>j===strength || l<=Number(c.low))) lows.push({index:i,price:l});
  }
  return {highs,lows};
}

// Draws simple lines through the two latest confirmed swing lows/highs.
function buildTrendlines(swings) {
  const lines=[];
  if(swings.lows.length>=2) {
    const pair=swings.lows.slice(-2);
    if(pair[1].index>pair[0].index) lines.push({type:'Uptrend',start:pair[0],end:pair[1]});
  }
  if(swings.highs.length>=2) {
    const pair=swings.highs.slice(-2);
    if(pair[1].index>pair[0].index) lines.push({type:'Downtrend',start:pair[0],end:pair[1]});
  }
  return lines;
}

// Flags a close beyond the latest confirmed swing. BOS follows the prior break direction;
// CHoCH marks a break in the opposite direction. This is a price-action heuristic.
function detectMarketStructure(candles, swings) {
  if(candles.length<15 || !swings.highs.length || !swings.lows.length) return {event:null,direction:0};
  let direction=0, lastEvent=null;
  const events=[];
  let highCursor=0, lowCursor=0, activeHigh=null, activeLow=null;
  for(let i=0;i<candles.length;i++) {
    while(highCursor<swings.highs.length && swings.highs[highCursor].index<i) activeHigh=swings.highs[highCursor++];
    while(lowCursor<swings.lows.length && swings.lows[lowCursor].index<i) activeLow=swings.lows[lowCursor++];
    const close=Number(candles[i].close);
    if(activeHigh && close>activeHigh.price && (!lastEvent || lastEvent.level!==activeHigh.price || lastEvent.direction!==1)) {
      const label=direction===-1?'Bullish CHoCH':'Bullish BOS';
      lastEvent={label,level:activeHigh.price,direction:1,index:i}; events.push(lastEvent); direction=1;
      activeHigh=null;
    } else if(activeLow && close<activeLow.price && (!lastEvent || lastEvent.level!==activeLow.price || lastEvent.direction!==-1)) {
      const label=direction===1?'Bearish CHoCH':'Bearish BOS';
      lastEvent={label,level:activeLow.price,direction:-1,index:i}; events.push(lastEvent); direction=-1;
      activeLow=null;
    }
  }
  return {event:lastEvent,direction,events};
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


// Transparent rules-based analysis engine. It combines live-feed candles with
// technical studies; the score is confluence, not a machine-learning probability.
function AIAnalysisPanel({ candles, symbol, timeframe }) {
  const analysis = useMemo(() => {
    if (!candles || candles.length < 60) return { ready:false, reason:`At least 60 candles are required. Currently available: ${candles?.length || 0}.` };
    const closes = candles.map(c => Number(c.close));
    const ema20 = calcEMA(closes,20), ema50 = calcEMA(closes,50), ema200 = calcEMA(closes,200);
    const rsi = calcRSI(closes,14), macd = calcMACD(closes), atr = calcATR(candles,14), adx = calcADX(candles,14);
    const last = a => { for(let i=a.length-1;i>=0;i--) if(a[i] != null && Number.isFinite(a[i])) return a[i]; return null; };
    const price = closes.at(-1), e20=last(ema20), e50=last(ema50), e200=last(ema200);
    const rv=last(rsi), ml=last(macd.line), ms=last(macd.signal), av=last(adx), at=last(atr);
    const swings = detectSwingPoints(candles.slice(-180));
    const structure = detectMarketStructure(candles.slice(-180), swings);
    const levels = detectSupportResistance(candles.slice(-180));
    const recentEvent = structure.event && structure.event.index >= Math.max(0,180-30) ? structure.event : null;
    const votes = [];
    if(e20!=null && e50!=null) votes.push({name:'EMA 20 / 50 alignment',dir:e20>e50?1:-1,detail:e20>e50?'EMA 20 is above EMA 50':'EMA 20 is below EMA 50'});
    if(e200!=null) votes.push({name:'EMA 200 trend filter',dir:price>e200?1:-1,detail:price>e200?'Price is above EMA 200':'Price is below EMA 200'});
    if(ml!=null && ms!=null) votes.push({name:'MACD momentum',dir:ml>ms?1:ml<ms?-1:0,detail:ml>ms?'MACD is above its signal line':ml<ms?'MACD is below its signal line':'MACD and signal are equal'});
    if(rv!=null) votes.push({name:'RSI momentum',dir:rv>52?1:rv<48?-1:0,detail:`RSI is ${rv.toFixed(1)}${rv>=70?' (overbought zone)':rv<=30?' (oversold zone)':''}`});
    if(recentEvent) votes.push({name:'Market structure',dir:recentEvent.direction,detail:recentEvent.label+' detected recently'});
    const score = votes.reduce((sum,v)=>sum+v.dir,0);
    const maxVotes = votes.length;
    const direction = score>=2?'BUY':score<=-2?'SELL':'WAIT';
    const adxStrong = av!=null && av>=20;
    const aligned = votes.filter(v=>v.dir===(direction==='BUY'?1:-1)).length;
    const confluence = direction==='WAIT'?0:Math.round((aligned/Math.max(1,maxVotes))*100);
    const nearestSupport = levels.filter(l=>l.type==='Support' && l.price<price).sort((a,b)=>b.price-a.price)[0];
    const nearestResistance = levels.filter(l=>l.type==='Resistance' && l.price>price).sort((a,b)=>a.price-b.price)[0];
    const canBuildSetup = direction!=='WAIT' && at!=null && at>0;
    const stop = canBuildSetup ? price + (direction==='BUY'?-1:1)*1.5*at : null;
    const target = canBuildSetup ? price + (direction==='BUY'?1:-1)*3*at : null;
    const riskDistance = canBuildSetup ? Math.abs(price-stop) : null;
    const rewardRisk = canBuildSetup ? Math.abs(target-price)/riskDistance : null;
    let quality='Insufficient confluence';
    if(direction!=='WAIT') quality=confluence>=80 && adxStrong?'Strong confluence':confluence>=60?'Moderate confluence':'Low confluence';
    const notes=[];
    if(e200==null) notes.push('EMA 200 is unavailable until at least 200 candles are loaded.');
    if(av==null) notes.push('ADX is not yet available for trend-strength confirmation.');
    else if(!adxStrong) notes.push('ADX is below 20: trend strength is weak or not established.');
    if(recentEvent) notes.push(`${recentEvent.label} at ${recentEvent.level.toFixed(symbol==='USDJPY'?3: symbol==='BTCUSD'?1:5)}.`);
    else notes.push('No recent BOS/CHoCH event confirmed by the current swing-point rule.');
    if(direction==='WAIT') notes.push('Directional evidence is mixed; the engine is withholding a directional setup.');
    return {ready:true,price,rv,av,at,e20,e50,e200,ml,ms,direction,score,maxVotes,confluence,quality,notes,votes,stop,target,rewardRisk,canBuildSetup,nearestSupport,nearestResistance,structure:recentEvent};
  },[candles,symbol]);

  const fmt = value => value==null || !Number.isFinite(value) ? '—' : value.toFixed(symbol==='USDJPY'?3:symbol==='BTCUSD'?1:symbol==='XAUUSD'?2:5);
  if(!analysis.ready) return <div className="card"><div className="card-heading"><h3>TradeLab AI Analysis Engine</h3><span className="tag">RULES-BASED ENGINE</span></div><div className="empty">{analysis.reason} Select a supported market or timeframe with more history.</div></div>;
  const bullish=analysis.direction==='BUY', bearish=analysis.direction==='SELL';
  const accent=bullish?'#21d6a0':bearish?'#fb7185':'#fbbf24';
  return <div className="card" style={{marginTop:18}}>
    <div className="card-heading"><div><h3>TradeLab AI · Trade Analysis</h3><div className="muted">{symbol} · {timeframe} · {candles.length} candles · refreshed with market data</div></div><span className="tag">TRANSPARENT ANALYSIS</span></div>
    <div className="stats-grid" style={{marginBottom:16}}>
      <div className="card"><div className="stat-label">Directional assessment</div><div className="stat-value" style={{color:accent}}>{analysis.direction}</div><div className="muted">{analysis.quality}</div></div>
      <div className="card"><div className="stat-label">Confluence score</div><div className="stat-value">{analysis.score>0?'+':''}{analysis.score} / {analysis.maxVotes}</div><div className="muted">{analysis.confluence}% aligned inputs · not win probability</div></div>
      <div className="card"><div className="stat-label">Trend strength (ADX)</div><div className="stat-value">{analysis.av==null?'—':analysis.av.toFixed(1)}</div><div className="muted">{analysis.av==null?'Insufficient data':analysis.av>=25?'Strong trend':'Weak / developing trend'}</div></div>
      <div className="card"><div className="stat-label">Volatility (ATR 14)</div><div className="stat-value" style={{fontSize:19}}>{fmt(analysis.at)}</div><div className="muted">Average true range</div></div>
    </div>
    <div className="dashboard-grid" style={{marginBottom:0}}>
      <div><h4 style={{marginTop:0}}>Evidence and confluence</h4>
        {analysis.votes.map((v,i)=><div className="signal" key={i}><span>{v.name}<small className="muted" style={{display:'block',marginTop:4}}>{v.detail}</small></span><strong style={{color:v.dir>0?'#21d6a0':v.dir<0?'#fb7185':'#fbbf24'}}>{v.dir>0?'Bullish':v.dir<0?'Bearish':'Neutral'}</strong></div>)}
        {analysis.notes.map((n,i)=><p className="muted" key={i} style={{fontSize:11,lineHeight:1.6,margin:'8px 0'}}>• {n}</p>)}
      </div>
      <div><h4 style={{marginTop:0}}>Illustrative setup levels</h4>
        <div className="signal"><span>Reference price</span><strong>{fmt(analysis.price)}</strong></div>
        <div className="signal"><span>ATR-based stop level (1.5 × ATR)</span><strong style={{color:'#fb7185'}}>{analysis.canBuildSetup?fmt(analysis.stop):'Not available'}</strong></div>
        <div className="signal"><span>ATR-based target (3 × ATR)</span><strong style={{color:'#21d6a0'}}>{analysis.canBuildSetup?fmt(analysis.target):'Not available'}</strong></div>
        <div className="signal"><span>Illustrative reward:risk</span><strong>{analysis.canBuildSetup?`1 : ${analysis.rewardRisk.toFixed(2)}`:'—'}</strong></div>
        <div className="signal"><span>Nearest support</span><strong>{analysis.nearestSupport?fmt(analysis.nearestSupport.price):'Not detected'}</strong></div>
        <div className="signal"><span>Nearest resistance</span><strong>{analysis.nearestResistance?fmt(analysis.nearestResistance.price):'Not detected'}</strong></div>
        <div className="muted" style={{fontSize:11,lineHeight:1.6,marginTop:10}}>These are analytical reference levels only. They do not account for spread, slippage, commissions, contract size or broker-specific pip/point values.</div>
      </div>
    </div>
    <div style={{marginTop:15,padding:12,borderRadius:8,background:'#101d30',border:'1px solid #26364e',fontSize:11,lineHeight:1.7,color:'#aab8cc'}}><strong style={{color:'#fbbf24'}}>Important:</strong> This is a transparent, rules-based technical confluence engine, not a trained predictive AI model. The confluence percentage is the share of directional inputs aligned; it is not a probability of profit. WAIT means evidence is mixed. Use demo testing and independent risk checks before considering any trade. No orders are placed by this analysis.</div>
  </div>;
}

function AIAssistant({ candles, symbol, timeframe }) {
  const [question, setQuestion] = useState('Give me a full analysis of the current market.');
  const [answer, setAnswer] = useState('');
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);
  const fmt = value => Number.isFinite(value) ? value.toFixed(symbol==='USDJPY'?3:symbol==='BTCUSD'?1:symbol==='XAUUSD'?2:5) : '—';

  const ask = () => {
    if (!question.trim() || busy) return;
    setBusy(true);
    try {
      if (!Array.isArray(candles) || candles.length < 60) {
        const reply = `Not enough market history yet. ${symbol} currently has ${candles?.length || 0} candles on ${timeframe}; at least 60 are required. Wait for the chart to load or choose a supported instrument.`;
        setAnswer(reply); setHistory(h => [{q:question,a:reply}, ...h].slice(0,6)); return;
      }
      const closes = candles.map(c => Number(c.close));
      const price = closes.at(-1);
      const e20 = calcEMA(closes,20).at(-1), e50 = calcEMA(closes,50).at(-1), e200 = calcEMA(closes,200).at(-1);
      const rsi = calcRSI(closes,14).at(-1);
      const macd = calcMACD(closes), macdHist = macd.histogram.at(-1), previousHist = macd.histogram.at(-2);
      const adx = calcADX(candles,14).at(-1), atr = calcATR(candles,14).at(-1);
      const bands = calcBollinger(closes,20,2).at(-1);
      const stochastic = calcStochastic(candles).k.at(-1);
      const swings = detectSwingPoints(candles.slice(-180));
      const structure = detectMarketStructure(candles.slice(-180), swings).event;
      const sr = detectSupportResistance(candles.slice(-180));
      const trend = e20 > e50 ? 'BULLISH' : e20 < e50 ? 'BEARISH' : 'MIXED';
      const longTrend = e200 == null ? 'not available (need 200 candles)' : price > e200 ? 'above EMA 200' : 'below EMA 200';
      const momentum = rsi >= 55 ? 'positive' : rsi <= 45 ? 'negative' : 'neutral';
      const macdState = macdHist > 0 ? 'positive' : macdHist < 0 ? 'negative' : 'neutral';
      const prompt = question.toLowerCase();
      let reply;
      const overview = `MARKET SNAPSHOT — ${symbol} · ${timeframe}\nReference price: ${fmt(price)}\nEMA 20: ${fmt(e20)} | EMA 50: ${fmt(e50)} | EMA 200: ${fmt(e200)}\nTrend: ${trend} (${longTrend})\nRSI(14): ${fmt(rsi)} — ${momentum} momentum\nMACD histogram: ${Number.isFinite(macdHist)?macdHist.toPrecision(5):'—'} — ${macdState}${Number.isFinite(previousHist)&&Number.isFinite(macdHist)?(macdHist>previousHist?' and increasing':' and decreasing'):''}\nADX(14): ${fmt(adx)} — ${Number.isFinite(adx)?(adx>=25?'trend strength is established':'trend strength is weak/developing'):'not available'}\nATR(14): ${fmt(atr)} — recent average range\nStochastic %K: ${fmt(stochastic)}\nMarket structure: ${structure?.label || 'No confirmed recent BOS/CHoCH event'}\n`;
      if (prompt.includes('risk') || prompt.includes('stop') || prompt.includes('position') || prompt.includes('lot')) {
        reply = `${overview}\nRISK GUIDANCE\nATR(14) is ${fmt(atr)}. Consider using volatility and a technically meaningful invalidation level to plan a stop. Position size should be calculated from account equity, chosen risk percentage, stop distance and the broker's contract specification. Do not use the same lot size across different instruments. This assistant does not know your broker's contract size or account balance.`;
      } else if (prompt.includes('rsi') || prompt.includes('momentum') || prompt.includes('overbought') || prompt.includes('oversold')) {
        reply = `${overview}\nRSI INTERPRETATION\nRSI above 70 is commonly described as overbought and below 30 as oversold. These readings are not automatic reversal signals. In a strong trend, RSI can remain elevated or depressed. Look for price structure and MACD confirmation before acting.`;
      } else if (prompt.includes('macd')) {
        reply = `${overview}\nMACD INTERPRETATION\nA positive histogram means the MACD line is above its signal line; a negative histogram means it is below. A rising histogram suggests improving momentum relative to the prior candle, but it is not a standalone entry signal. Confirm with trend and market structure.`;
      } else if (prompt.includes('support') || prompt.includes('resistance') || prompt.includes('levels')) {
        const support = sr.filter(level=>level.type==='Support').sort((a,b)=>b.price-a.price)[0]?.price;
        const resistance = sr.filter(level=>level.type==='Resistance').sort((a,b)=>a.price-b.price)[0]?.price;
        reply = `${overview}\nKEY PRICE AREAS\nNearest detected support: ${fmt(Number(support))}\nNearest detected resistance: ${fmt(Number(resistance))}\nThese are approximate levels derived from recent swing data, not guaranteed turning points. Wait for a reaction or confirmed break before treating a level as actionable.`;
      } else if (prompt.includes('strategy') || prompt.includes('backtest')) {
        reply = `${overview}\nSTRATEGY TESTING IDEA\nA simple starting hypothesis is an EMA 20/50 trend filter with RSI confirmation: only evaluate long signals when EMA 20 is above EMA 50, and short signals when EMA 20 is below EMA 50. Define exits before testing. Include spread, commission and slippage; review trade count, drawdown and out-of-sample results. Historical performance does not guarantee future results.`;
      } else if (prompt.includes('bos') || prompt.includes('choch') || prompt.includes('structure') || prompt.includes('smart money') || prompt.includes('smc')) {
        reply = `${overview}\nMARKET STRUCTURE\n${structure ? `Latest detected event: ${structure.label} near ${fmt(Number(structure.level))}.` : 'No recent BOS/CHoCH event was confirmed by the current swing-point rule.'}\nA break of structure should be assessed using candle closes and the broader trend. A single wick through a swing level can be a liquidity sweep rather than a confirmed structural break.`;
      } else if (prompt.includes('entry') || prompt.includes('buy') || prompt.includes('sell') || prompt.includes('setup') || prompt.includes('trade idea')) {
        const aligned = trend==='BULLISH' ? rsi>=50 && macdHist>0 : trend==='BEARISH' ? rsi<=50 && macdHist<0 : false;
        reply = `${overview}\nSETUP REVIEW\nDirectional alignment: ${aligned?'some trend and momentum inputs agree':'not sufficiently aligned'}\nAssessment: ${aligned?`A ${trend.toLowerCase()} bias may be worth monitoring for a confirmed pullback or breakout retest.`:'WAIT — avoid forcing an entry while the evidence is mixed.'}\nBefore any trade, define the invalidation level, calculate position size, and check spread, session conditions and scheduled news. No entry is being executed.`;
      } else {
        reply = `${overview}\nSUMMARY\nThe current short-term EMA trend is ${trend.toLowerCase()}, while momentum is ${momentum}. ${trend==='MIXED'?'The moving-average evidence is mixed; wait for clearer direction.':`The current trend bias is ${trend.toLowerCase()}, but confirmation from price structure and a higher timeframe is still important.`} This is a rules-based technical reading, not a prediction or a probability of profit.`;
      }
      setAnswer(reply); setHistory(h => [{q:question,a:reply}, ...h].slice(0,6));
    } catch (error) {
      const reply = `I could not complete this analysis because some indicator data was unavailable. Please reload the chart and try again. Details: ${error?.message || 'unknown calculation error'}`;
      setAnswer(reply); setHistory(h => [{q:question,a:reply}, ...h].slice(0,6));
    } finally { setBusy(false); }
  };
  const quickQuestions = ['Give me a full analysis of the current market.','Is momentum bullish or bearish?','Explain RSI and MACD.','Find support and resistance.','Review a possible entry setup.','Explain BOS and CHoCH.','How should I manage risk?','Suggest a strategy to backtest.'];
  return <>
    <div className="welcome"><div><h1>TradeLab AI Assistant</h1><div className="muted">Market-aware analysis using the currently selected instrument and loaded candles.</div></div><div className="demo-badge">● MARKET-AWARE RULE-BASED ASSISTANT</div></div>
    <div className="card">
      <div className="card-heading"><h3>Ask about your live chart</h3><span className="muted">{symbol} · {timeframe} · {candles.length} candles</span></div>
      <p className="muted" style={{lineHeight:1.6}}>TradeLab reads the selected chart and calculates technical observations. It is not connected to a remote language model and does not place trades.</p>
      <div className="field"><label>Your question</label><textarea value={question} onChange={e=>setQuestion(e.target.value)} rows="3" style={{width:'100%',background:'#0b1728',border:'1px solid #2b3b52',color:'#fff',borderRadius:7,padding:12}} placeholder="Ask about trend, momentum, structure, entries or risk…"/></div>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:10}}>{quickQuestions.map(q=><button className="period-btn" key={q} onClick={()=>setQuestion(q)}>{q}</button>)}</div>
      <button className="execute-btn" style={{marginTop:14}} onClick={ask} disabled={!question.trim()||busy}>{busy?'Analysing chart…':'Ask TradeLab AI'}</button>
      {answer && <div className="signal" style={{display:'block',marginTop:18,padding:16,whiteSpace:'pre-wrap',lineHeight:1.7}}><strong style={{color:'#20d6a1',display:'block',marginBottom:8}}>TradeLab AI analysis</strong>{answer}</div>}
    </div>
    {history.length>1 && <div className="card" style={{marginTop:16}}><h3>Recent questions</h3>{history.slice(1,6).map((item,i)=><div className="signal" key={i} style={{display:'block'}}><strong>{item.q}</strong><p className="muted" style={{lineHeight:1.6,whiteSpace:'pre-wrap'}}>{item.a}</p></div>)}</div>}
  </>;
}
// Historical simulation uses close-confirmed signals and executes at the next
// candle close-to-close interval. Costs are charged on each position change.
function runStrategyBacktest(candles, config) {
  if (!Array.isArray(candles) || candles.length < 60) return { error: `At least 60 candles are required. Available: ${candles?.length || 0}.` };
  const clean = candles.filter(c => Number.isFinite(Number(c.close)) && Number(c.close) > 0);
  if (clean.length < 60) return { error: 'Not enough valid closing prices to run this backtest.' };
  const closes = clean.map(c => Number(c.close));
  const fast = calcEMA(closes, config.fast);
  const slow = calcEMA(closes, config.slow);
  const rsi = calcRSI(closes, config.rsiPeriod);
  const lookback = Math.max(5, config.lookback);
  const fee = Math.max(0, config.costBps) / 10000;
  const initial = Math.max(100, config.capital);
  let equity = initial, position = 0, activeTrade = null;
  const curve = [{ index: 0, time: clean[0].time, equity }];
  const trades = [];
  const signalAt = i => {
    if (config.strategy === 'ema') {
      if (fast[i] == null || slow[i] == null) return 0;
      return fast[i] > slow[i] ? 1 : -1;
    }
    if (config.strategy === 'rsi') {
      if (rsi[i] == null) return position;
      if (rsi[i] <= config.oversold) return 1;
      if (rsi[i] >= config.overbought) return -1;
      return position;
    }
    if (i < lookback) return position;
    const prior = clean.slice(i - lookback, i);
    const ceiling = Math.max(...prior.map(c => Number(c.high)));
    const floor = Math.min(...prior.map(c => Number(c.low)));
    if (closes[i] > ceiling) return 1;
    if (closes[i] < floor) return -1;
    return position;
  };
  const closeTrade = (index, reason) => {
    if (!activeTrade) return;
    equity *= (1 - fee);
    const pnlPct = (equity / activeTrade.startEquity - 1) * 100;
    trades.push({
      id: trades.length + 1,
      side: activeTrade.side,
      entryTime: activeTrade.entryTime,
      exitTime: clean[index].time,
      entryPrice: activeTrade.entryPrice,
      exitPrice: closes[index],
      pnlPct,
      pnlCash: equity - activeTrade.startEquity,
      reason
    });
    activeTrade = null;
  };
  for (let i = 1; i < clean.length; i++) {
    if (position !== 0) equity *= (1 + position * (closes[i] / closes[i - 1] - 1));
    const desired = signalAt(i);
    if (desired !== position) {
      if (position !== 0) closeTrade(i, desired === 0 ? 'Signal exit' : 'Reversal');
      if (desired !== 0) {
        const beforeEntryCost = equity;
        equity *= (1 - fee);
        activeTrade = { side: desired === 1 ? 'LONG' : 'SHORT', entryTime: clean[i].time, entryPrice: closes[i], startEquity: beforeEntryCost };
      }
      position = desired;
    }
    curve.push({ index: i, time: clean[i].time, equity });
  }
  if (position !== 0) closeTrade(clean.length - 1, 'End of data');
  if (curve.length) curve[curve.length - 1] = { ...curve[curve.length - 1], equity };
  const wins = trades.filter(t => t.pnlCash > 0), losses = trades.filter(t => t.pnlCash < 0);
  const grossProfit = wins.reduce((s,t) => s + t.pnlCash, 0);
  const grossLoss = Math.abs(losses.reduce((s,t) => s + t.pnlCash, 0));
  let peak = initial, maxDrawdown = 0;
  curve.forEach(p => { peak = Math.max(peak, p.equity); const dd = peak > 0 ? (peak - p.equity) / peak * 100 : 0; maxDrawdown = Math.max(maxDrawdown, dd); });
  const finalEquity = equity;
  const buyHold = (closes.at(-1) / closes[0] - 1) * 100;
  return {
    trades, curve, initial, finalEquity,
    netReturn: (finalEquity / initial - 1) * 100,
    buyHold, winRate: trades.length ? wins.length / trades.length * 100 : 0,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
    maxDrawdown, tradeCount: trades.length, wins: wins.length, losses: losses.length,
    costBps: config.costBps, candlesUsed: clean.length
  };
}

function advancedPerformance(result) {
  if (!result || result.error) return null;
  const returns = result.trades.map(t => t.pnlPct / 100);
  const mean = returns.length ? returns.reduce((a,b)=>a+b,0)/returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((a,b)=>a+(b-mean)**2,0)/(returns.length-1) : 0;
  const downside = returns.filter(v=>v<0);
  const downsideDev = downside.length ? Math.sqrt(downside.reduce((a,b)=>a+b*b,0)/downside.length) : 0;
  const sharpeTrade = variance > 0 ? mean/Math.sqrt(variance)*Math.sqrt(returns.length) : 0;
  const sortinoTrade = downsideDev > 0 ? mean/downsideDev*Math.sqrt(returns.length) : 0;
  const recoveryFactor = result.maxDrawdown > 0 ? result.netReturn/result.maxDrawdown : 0;
  // Bootstrap closed-trade returns with a fixed seed for repeatable results.
  let seed = 917341;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const simulations = [];
  if (returns.length) {
    for (let n=0;n<500;n++) {
      let eq = 1;
      for (let i=0;i<returns.length;i++) eq *= (1 + returns[Math.floor(rand()*returns.length)]);
      simulations.push((eq-1)*100);
    }
  }
  simulations.sort((a,b)=>a-b);
  const quantile = q => simulations.length ? simulations[Math.min(simulations.length-1,Math.floor(q*(simulations.length-1)))] : null;
  return { sharpeTrade, sortinoTrade, recoveryFactor, mc5:quantile(.05), mc50:quantile(.5), mc95:quantile(.95), simulations:simulations.length };
}

function optimizeStrategy(candles, base) {
  const configs = [];
  if (base.strategy === 'ema') {
    [8,12,20,30,40].forEach(fast => [34,50,75,100,150].forEach(slow => { if (fast < slow) configs.push({...base,fast,slow}); }));
  } else if (base.strategy === 'rsi') {
    [7,10,14,21].forEach(rsiPeriod => [20,25,30,35].forEach(oversold => [65,70,75,80].forEach(overbought => { if (overbought-oversold>=30) configs.push({...base,rsiPeriod,oversold,overbought}); })));
  } else {
    [5,8,10,15,20,30,40].forEach(lookback => configs.push({...base,lookback}));
  }
  return configs.map(config=>({config,result:runStrategyBacktest(candles,config)}))
    .filter(x=>!x.result.error && x.result.tradeCount>=2 && Number.isFinite(x.result.netReturn))
    .sort((a,b)=> (b.result.netReturn - .5*b.result.maxDrawdown) - (a.result.netReturn - .5*a.result.maxDrawdown)).slice(0,5);
}

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
  const [optimization, setOptimization] = useState([]);
  const [optimizing, setOptimizing] = useState(false);
  const config = { strategy, fast: fastPeriod, slow: slowPeriod, rsiPeriod, oversold, overbought, lookback, capital, costBps };
  const result = useMemo(() => runStrategyBacktest(candles, config), [candles, strategy, fastPeriod, slowPeriod, rsiPeriod, oversold, overbought, lookback, capital, costBps, runKey]);
  const money = v => Number.isFinite(v) ? v.toLocaleString(undefined, { style:'currency', currency:'USD', maximumFractionDigits:2 }) : '—';
  const pct = v => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
  const chart = result?.curve || [];
  const minEq = chart.length ? Math.min(...chart.map(p=>p.equity)) : 0;
  const maxEq = chart.length ? Math.max(...chart.map(p=>p.equity)) : 1;
  const range = maxEq - minEq || 1;
  const path = chart.map((p,i)=>`${i===0?'M':'L'} ${20+i/(Math.max(1,chart.length-1))*960} ${12+(maxEq-p.equity)/range*176}`).join(' ');
  const advanced = advancedPerformance(result);
  const splitIndex = Math.floor(candles.length * 0.7);
  const outOfSample = candles.length >= 100 ? runStrategyBacktest(candles.slice(splitIndex), config) : null;
  const runOptimization = () => { setOptimizing(true); setOptimization([]); setTimeout(() => { setOptimization(optimizeStrategy(candles, config)); setOptimizing(false); }, 30); };
  return <>
    <div className="welcome"><div><h1>Strategy Lab & Backtesting</h1><div className="muted">Test rule-based strategies against the currently loaded historical candles.</div></div><div className="demo-badge">● HISTORICAL SIMULATION</div></div>
    <div className="card">
      <div className="card-heading"><div><h3>Strategy builder</h3><div className="muted">{symbol} · {timeframe} · {candles.length} candles available</div></div><span className="tag">NO LIVE ORDERS</span></div>
      {(loading || error) && <div className="empty">{loading ? 'Loading historical data…' : error}</div>}
      <div className="order-grid" style={{marginTop:12}}>
        <div className="field"><label>Strategy</label><select value={strategy} onChange={e=>setStrategy(e.target.value)}><option value="ema">EMA crossover</option><option value="rsi">RSI mean-reversion</option><option value="breakout">Price breakout</option></select></div>
        <div className="field"><label>Starting capital (USD)</label><input type="number" min="100" step="100" value={capital} onChange={e=>setCapital(Math.max(100,Number(e.target.value)||100))}/></div>
        <div className="field"><label>Trading cost per side (bps)</label><input type="number" min="0" max="100" step="0.1" value={costBps} onChange={e=>setCostBps(Math.max(0,Math.min(100,Number(e.target.value)||0)))}/></div>
        {strategy==='ema' && <><div className="field"><label>Fast EMA</label><input type="number" min="2" max="150" value={fastPeriod} onChange={e=>setFastPeriod(Math.max(2,Math.min(150,Number(e.target.value)||2)))}/></div><div className="field"><label>Slow EMA</label><input type="number" min="3" max="250" value={slowPeriod} onChange={e=>setSlowPeriod(Math.max(3,Math.min(250,Number(e.target.value)||3)))}/></div></>}
        {strategy==='rsi' && <><div className="field"><label>RSI period</label><input type="number" min="2" max="50" value={rsiPeriod} onChange={e=>setRsiPeriod(Math.max(2,Math.min(50,Number(e.target.value)||2)))}/></div><div className="field"><label>Oversold threshold</label><input type="number" min="5" max="45" value={oversold} onChange={e=>setOversold(Math.max(5,Math.min(45,Number(e.target.value)||5)))}/></div><div className="field"><label>Overbought threshold</label><input type="number" min="55" max="95" value={overbought} onChange={e=>setOverbought(Math.max(55,Math.min(95,Number(e.target.value)||55)))}/></div></>}
        {strategy==='breakout' && <div className="field"><label>Breakout lookback candles</label><input type="number" min="5" max="100" value={lookback} onChange={e=>setLookback(Math.max(5,Math.min(100,Number(e.target.value)||5)))}/></div>}
      </div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginTop:16}}><button className="execute-btn" onClick={()=>setRunKey(k=>k+1)} disabled={loading || candles.length<60}>Run backtest</button><span className="muted" style={{fontSize:11}}>Signals use completed candles; positions take effect on the following candle. Costs are a simplified basis-point assumption.</span></div>
    </div>
    {result?.error ? <div className="card" style={{marginTop:18}}><div className="empty">{result.error}</div></div> : <>
      <div className="stats-grid" style={{marginTop:18}}>
        <div className="card"><div className="stat-label">Net return</div><div className="stat-value" style={{color:result.netReturn>=0?'#21d6a0':'#fb7185'}}>{pct(result.netReturn)}</div><div className="muted">Final equity: {money(result.finalEquity)}</div></div>
        <div className="card"><div className="stat-label">Win rate</div><div className="stat-value">{result.winRate.toFixed(1)}%</div><div className="muted">{result.wins} wins / {result.tradeCount} closed trades</div></div>
        <div className="card"><div className="stat-label">Profit factor</div><div className="stat-value">{Number.isFinite(result.profitFactor)?result.profitFactor.toFixed(2):'∞'}</div><div className="muted">Gross profit ÷ gross loss</div></div>
        <div className="card"><div className="stat-label">Maximum drawdown</div><div className="stat-value" style={{color:'#fb7185'}}>{result.maxDrawdown.toFixed(2)}%</div><div className="muted">Peak-to-trough equity decline</div></div>
      </div>
      <div className="card" style={{marginTop:18}}>
        <div className="card-heading"><div><h3>Equity curve</h3><div className="muted">Start: {money(result.initial)} · End: {money(result.finalEquity)}</div></div><span className="tag">{result.tradeCount} trades</span></div>
        <div style={{height:220,width:'100%'}}><svg viewBox="0 0 1000 205" width="100%" height="100%" preserveAspectRatio="none"><line x1="20" x2="980" y1="188" y2="188" stroke="#26364e"/><line x1="20" x2="980" y1="12" y2="12" stroke="#26364e" strokeDasharray="4 4"/><path d={path} fill="none" stroke={result.netReturn>=0?'#21d6a0':'#fb7185'} strokeWidth="2.5"/><text x="20" y="202" fill="#8290a8" fontSize="10">First candle</text><text x="980" y="202" textAnchor="end" fill="#8290a8" fontSize="10">Last candle</text></svg></div>
        <div className="signal"><span>Buy-and-hold reference (before costs)</span><strong style={{color:result.buyHold>=0?'#21d6a0':'#fb7185'}}>{pct(result.buyHold)}</strong></div>
        <div className="signal"><span>Data window</span><strong>{result.candlesUsed} candles</strong></div>
      </div>
      <div className="stats-grid" style={{marginTop:18}}>
        <div className="card"><div className="stat-label">Trade-based Sharpe</div><div className="stat-value">{advanced ? advanced.sharpeTrade.toFixed(2) : '—'}</div><div className="muted">Not annualized; based on closed-trade returns</div></div>
        <div className="card"><div className="stat-label">Trade-based Sortino</div><div className="stat-value">{advanced ? advanced.sortinoTrade.toFixed(2) : '—'}</div><div className="muted">Downside deviation measure</div></div>
        <div className="card"><div className="stat-label">Recovery factor</div><div className="stat-value">{advanced ? advanced.recoveryFactor.toFixed(2) : '—'}</div><div className="muted">Net return ÷ maximum drawdown</div></div>
        <div className="card"><div className="stat-label">Out-of-sample return</div><div className="stat-value" style={{color:outOfSample && !outOfSample.error && outOfSample.netReturn>=0?'#21d6a0':'#fb7185'}}>{outOfSample && !outOfSample.error ? pct(outOfSample.netReturn) : 'Insufficient data'}</div><div className="muted">Last 30% of candles; parameters unchanged</div></div>
      </div>
      <div className="card" style={{marginTop:18}}>
        <div className="card-heading"><div><h3>Monte Carlo trade-sequence simulation</h3><div className="muted">500 bootstrap paths, resampling the observed closed-trade returns</div></div><span className="tag">SCENARIO ANALYSIS</span></div>
        {advanced && advanced.simulations ? <div className="stats-grid"><div><div className="stat-label">5th percentile</div><div className="stat-value" style={{color:'#fb7185'}}>{pct(advanced.mc5)}</div></div><div><div className="stat-label">Median outcome</div><div className="stat-value">{pct(advanced.mc50)}</div></div><div><div className="stat-label">95th percentile</div><div className="stat-value" style={{color:'#21d6a0'}}>{pct(advanced.mc95)}</div></div></div> : <p className="muted">At least one closed trade is needed for simulation.</p>}
        <p className="muted" style={{fontSize:11,lineHeight:1.6}}>This resamples the strategy's historical trade outcomes; it does not predict future performance and cannot model market regimes absent from the sample.</p>
      </div>
      <div className="card" style={{marginTop:18}}>
        <div className="card-heading"><div><h3>Parameter optimizer</h3><div className="muted">Tests a bounded set of parameter combinations on the currently loaded candles.</div></div><button className="execute-btn" onClick={runOptimization} disabled={loading || optimizing || candles.length<60}>{optimizing?'Optimizing…':'Optimize strategy'}</button></div>
        {optimization.length ? <div className="table-wrap"><table><thead><tr><th>Rank</th><th>Parameters</th><th>Net return</th><th>Max drawdown</th><th>Trades</th><th>Profit factor</th></tr></thead><tbody>{optimization.map((item,i)=><tr key={i}><td>{i+1}</td><td>{item.config.strategy==='ema'?`EMA ${item.config.fast}/${item.config.slow}`:item.config.strategy==='rsi'?`RSI ${item.config.rsiPeriod}, ${item.config.oversold}/${item.config.overbought}`:`Breakout ${item.config.lookback}`}</td><td className={item.result.netReturn>=0?'positive':'negative'}>{pct(item.result.netReturn)}</td><td>{item.result.maxDrawdown.toFixed(2)}%</td><td>{item.result.tradeCount}</td><td>{Number.isFinite(item.result.profitFactor)?item.result.profitFactor.toFixed(2):'∞'}</td></tr>)}</tbody></table></div> : <p className="muted" style={{fontSize:11}}>{optimizing?'Evaluating candidate settings…':'Run the optimizer to compare candidate settings. It ranks by return penalized for drawdown; it does not guarantee a better live result.'}</p>}
      </div>
      <div className="card" style={{marginTop:18}}><div className="card-heading"><h3>Closed trades</h3><span className="muted">Most recent 20 shown · {result.tradeCount} total</span></div><div className="table-wrap"><table><thead><tr><th>#</th><th>Side</th><th>Entry time</th><th>Exit time</th><th>Entry</th><th>Exit</th><th>Net P/L</th><th>Exit reason</th></tr></thead><tbody>{result.trades.length===0?<tr><td colSpan="8" className="empty">No completed trades for this strategy and data window.</td></tr>:result.trades.slice(-20).reverse().map(t=><tr key={t.id}><td>{t.id}</td><td className={t.side==='LONG'?'positive':'negative'}>{t.side}</td><td>{t.entryTime}</td><td>{t.exitTime}</td><td>{t.entryPrice.toFixed(symbol==='USDJPY'?3:symbol==='BTCUSD'?1:symbol==='XAUUSD'?2:5)}</td><td>{t.exitPrice.toFixed(symbol==='USDJPY'?3:symbol==='BTCUSD'?1:symbol==='XAUUSD'?2:5)}</td><td className={t.pnlCash>=0?'positive':'negative'}>{money(t.pnlCash)} ({pct(t.pnlPct)})</td><td>{t.reason}</td></tr>)}</tbody></table></div></div>
    </>}
    <div className="card" style={{marginTop:18,borderColor:'#5b4520'}}><p className="muted" style={{fontSize:11,lineHeight:1.7,margin:0}}><strong style={{color:'#fbbf24'}}>Backtest limitations:</strong> Sharpe and Sortino are trade-based, not annualized; the out-of-sample split uses the final 30% but is still the same downloaded sample; optimizer rankings are in-sample and can overfit; Monte Carlo only resamples observed trades. This is a local historical simulation using the currently fetched candle sample, not a broker-grade tester. It assumes close-price fills, constant percentage transaction costs, full-equity exposure and no margin, swaps, spread changes, liquidity constraints or intrabar stop execution. Results can be distorted by the limited 300-candle sample and are not a forecast. Test on more data and out-of-sample periods before relying on any strategy.</p></div>
  </>;
}



function RiskCentre({ symbol, marketPrice }) {
  const [balance, setBalance] = useState(10000);
 const [riskPct, setRiskPct] = useState(() => Number(localStorage.getItem('tradelab_risk_pct_v1') ?? 1));
const [dailyLimitPct, setDailyLimitPct] = useState(() => Number(localStorage.getItem('tradelab_daily_limit_v1') ?? 3));
const [drawdownLimitPct, setDrawdownLimitPct] = useState(() => Number(localStorage.getItem('tradelab_drawdown_limit_v1') ?? 10));
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [dailyLoss, setDailyLoss] = useState(0);
  const [peakBalance, setPeakBalance] = useState(10000);
  const [riskMode, setRiskMode] = useState('fixed');
useEffect(() => {
  localStorage.setItem('tradelab_risk_pct_v1', String(riskPct));
}, [riskPct]);

useEffect(() => {
  localStorage.setItem('tradelab_daily_limit_v1', String(dailyLimitPct));
}, [dailyLimitPct]);

useEffect(() => {
  localStorage.setItem('tradelab_drawdown_limit_v1', String(drawdownLimitPct));
}, [drawdownLimitPct]);
  const price = Number(marketPrice);
  const entryValue = Number(entry) || (Number.isFinite(price) && price > 0 ? price : 0);
  const stopValue = Number(stop);
  const targetValue = Number(target);
  const stopDistance = Math.abs(entryValue - stopValue);
  const targetDistance = Math.abs(targetValue - entryValue);
  const riskCash = balance * riskPct / 100;
  const dailyLimitCash = balance * dailyLimitPct / 100;
  const drawdownCash = Math.max(0, (peakBalance - balance) / Math.max(peakBalance, 1) * 100);
  const rewardRisk = stopDistance > 0 ? targetDistance / stopDistance : 0;
  const estimatedUnits = stopDistance > 0 ? riskCash / stopDistance : 0;
  const estimatedLots = estimatedUnits / 100000;
  const dailyUsed = dailyLimitCash > 0 ? dailyLoss / dailyLimitCash * 100 : 0;
  const valid = balance > 0 && riskPct > 0 && riskPct <= 5 && entryValue > 0 && stopDistance > 0 && targetDistance > 0;
  const directionValid = targetValue > entryValue && stopValue < entryValue || targetValue < entryValue && stopValue > entryValue;
  const blocked = dailyLoss >= dailyLimitCash || drawdownCash >= drawdownLimitPct;
  const field = (label, value, setter, step='any') => <div className="field"><label>{label}</label><input type="number" min="0" step={step} value={value} onChange={e=>setter(e.target.value)} /></div>;

  return <>
    <div className="welcome"><div><h1>Risk Centre</h1><div className="muted">Position sizing, trade risk and account protection calculator.</div></div><div className="demo-badge">● RISK CONTROLS · CALCULATOR ONLY</div></div>
    <div className="card">
      <div className="card-heading"><div><h3>Account risk settings</h3><div className="muted">Configure the account assumptions and loss limits.</div></div><span className="tag">NO BROKER ENFORCEMENT</span></div>
      <div className="order-grid" style={{marginTop:12}}>
        {field('Account equity (USD)', balance, v=>{const n=Math.max(0,Number(v)||0);setBalance(n);setPeakBalance(old=>Math.max(old,n));},'100')}
        <div className="field"><label>Risk per trade (%)</label><input type="number" min="0.1" max="5" step="0.1" value={riskPct} onChange={e=>setRiskPct(Math.max(0.1,Math.min(5,Number(e.target.value)||0.1)))}/></div>
        <div className="field"><label>Daily loss limit (%)</label><input type="number" min="0.5" max="20" step="0.5" value={dailyLimitPct} onChange={e=>setDailyLimitPct(Math.max(0.5,Math.min(20,Number(e.target.value)||0.5)))}/></div>
        <div className="field"><label>Maximum account drawdown (%)</label><input type="number" min="1" max="50" step="1" value={drawdownLimitPct} onChange={e=>setDrawdownLimitPct(Math.max(1,Math.min(50,Number(e.target.value)||1)))}/></div>
        {field('Current daily loss (USD)', dailyLoss, v=>setDailyLoss(Math.max(0,Number(v)||0)),'10')}
        {field('Peak account equity (USD)', peakBalance, v=>setPeakBalance(Math.max(balance,Number(v)||balance)),'100')}
      </div>
    </div>
    <div className="card" style={{marginTop:18}}>
      <div className="card-heading"><div><h3>Position size calculator</h3><div className="muted">{symbol} · Uses selected market quote as the initial entry when available.</div></div><span className="tag">ESTIMATE</span></div>
      <div className="order-grid" style={{marginTop:12}}>
        {field('Entry price', entry, setEntry)}
        {field('Stop-loss price', stop, setStop)}
        {field('Take-profit price', target, setTarget)}
      </div>
      <div className="stats-grid" style={{marginTop:18}}>
        <div className="card"><div className="stat-label">Cash risk allowance</div><div className="stat-value">${riskCash.toFixed(2)}</div><div className="muted">{riskPct.toFixed(1)}% of account equity</div></div>
        <div className="card"><div className="stat-label">Stop distance</div><div className="stat-value">{stopDistance ? stopDistance.toFixed(5) : '—'}</div><div className="muted">Absolute price difference</div></div>
        <div className="card"><div className="stat-label">Illustrative position units</div><div className="stat-value">{estimatedUnits ? estimatedUnits.toFixed(0) : '—'}</div><div className="muted">Simplified price-unit estimate</div></div>
        <div className="card"><div className="stat-label">Reward / risk</div><div className="stat-value">{rewardRisk ? `${rewardRisk.toFixed(2)} : 1` : '—'}</div><div className="muted">Based on entry, stop and target</div></div>
      </div>
      <div className="signal"><span>Illustrative standard-lot equivalent</span><strong>{estimatedLots ? estimatedLots.toFixed(4) : '—'} lots</strong></div>
      {!valid || !directionValid ? <p className="muted" style={{fontSize:11}}>Enter a valid account, entry, stop-loss and take-profit. For a BUY, stop must be below entry and target above; for a SELL, the reverse applies.</p> : <p className="muted" style={{fontSize:11}}>At the entered stop distance, the simplified calculation estimates a maximum loss of about ${riskCash.toFixed(2)} before fees, slippage and currency conversion.</p>}
      <div className="card" style={{marginTop:12,borderColor:blocked?'#fb7185':'#245b4d'}}><div className="card-heading"><h3>Risk guard status</h3><span className={`tag`}>{blocked?'LIMIT BREACHED':'WITHIN CONFIGURED LIMITS'}</span></div><div className="signal"><span>Daily loss usage</span><strong>{dailyUsed.toFixed(1)}% (${dailyLoss.toFixed(2)} / ${dailyLimitCash.toFixed(2)})</strong></div><div style={{height:8,background:'#26364e',borderRadius:8,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.min(100,dailyUsed)}%`,background:dailyUsed>=100?'#fb7185':'#20d6a1'}}/></div><div className="signal"><span>Peak-to-current drawdown</span><strong>{drawdownCash.toFixed(2)}% / {drawdownLimitPct.toFixed(1)}%</strong></div><div style={{height:8,background:'#26364e',borderRadius:8,overflow:'hidden'}}><div style={{height:'100%',width:`${Math.min(100,drawdownCash/drawdownLimitPct*100)}%`,background:drawdownCash>=drawdownLimitPct?'#fb7185':'#20d6a1'}}/></div>{blocked && <p className="negative" style={{fontSize:12}}>Configured loss threshold reached. The calculator flags elevated risk; it does not block orders at the broker.</p>}</div>
    </div>
    <div className="card" style={{marginTop:18,borderColor:'#5b4520'}}><p className="muted" style={{fontSize:11,lineHeight:1.7,margin:0}}><strong style={{color:'#fbbf24'}}>Important sizing limitation:</strong> Position units are a simplified price-distance calculation, not broker-accurate forex lot sizing. Contract sizes, quote-currency conversion, tick values, leverage, margin, spread, commissions and slippage differ by instrument and broker. Daily loss and drawdown inputs are manually maintained. These controls are advisory only and are not connected to live order execution.</p></div>
  </>;
}

function TradeJournal({ defaultSymbol = 'EURUSD', marketPrice }) {
  const storageKey = 'tradelab_trade_journal_v1';
  const [entries, setEntries] = useState(() => {
    try { const saved = localStorage.getItem(storageKey); const parsed = saved ? JSON.parse(saved) : []; return Array.isArray(parsed) ? parsed : []; }
    catch { return []; }
  });
  const [form, setForm] = useState({ symbol: defaultSymbol, direction: 'BUY', entry: marketPrice || '', units: '1000', setup: 'Trend continuation', notes: '', tags: '', entryReason: '', emotion: 'Calm / disciplined', mistake: false, lesson: '' });
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [marketFilter, setMarketFilter] = useState('ALL');
  const [closeInputs, setCloseInputs] = useState({});
  const [closeMeta, setCloseMeta] = useState({});
  const [message, setMessage] = useState('');

  useEffect(() => { try { localStorage.setItem(storageKey, JSON.stringify(entries)); } catch (e) { console.warn('Journal storage unavailable', e); } }, [entries]);
  useEffect(() => { setForm(old => ({ ...old, symbol: defaultSymbol, entry: old.symbol !== defaultSymbol || !old.entry || old.entry === '—' ? (marketPrice && marketPrice !== '—' ? marketPrice : '') : old.entry })); }, [defaultSymbol, marketPrice]);

  const closed = entries.filter(t => t.status === 'CLOSED');
  const wins = closed.filter(t => t.pnl > 0), losses = closed.filter(t => t.pnl < 0);
  const net = closed.reduce((s,t) => s + Number(t.pnl || 0), 0);
  const grossWin = wins.reduce((s,t) => s + t.pnl, 0), grossLoss = Math.abs(losses.reduce((s,t) => s + t.pnl, 0));
  const winRate = closed.length ? wins.length / closed.length * 100 : 0;
  const profitFactor = grossLoss ? grossWin / grossLoss : grossWin ? Infinity : 0;
  const avgWin = wins.length ? grossWin / wins.length : 0, avgLoss = losses.length ? grossLoss / losses.length : 0;
  const markets = [...new Set(entries.map(t => t.symbol))];
  const visible = entries.filter(t => (statusFilter === 'ALL' || t.status === statusFilter) && (marketFilter === 'ALL' || t.symbol === marketFilter) && `${t.symbol} ${t.direction} ${t.setup} ${t.notes} ${t.tags} ${t.entryReason || ''} ${t.exitReason || ''} ${t.emotion || ''} ${t.lesson || ''}`.toLowerCase().includes(query.toLowerCase()));
  const equity = closed.slice().reverse().reduce((arr,t) => [...arr, (arr.length ? arr[arr.length-1] : 0) + Number(t.pnl || 0)], [0]);
  const chartW = 600, chartH = 125, minEq = Math.min(0,...equity), maxEq = Math.max(0,...equity), rangeEq = maxEq-minEq || 1;
  const equityPoints = equity.map((v,i) => `${equity.length < 2 ? chartW/2 : 12 + i/(equity.length-1)*(chartW-24)},${chartH-12-(v-minEq)/rangeEq*(chartH-24)}`).join(' ');
  const money = v => `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`;

  function addEntry(e) {
    e.preventDefault();
    const entry = Number(form.entry), units = Number(form.units);
    if (!form.symbol || !Number.isFinite(entry) || entry <= 0 || !Number.isFinite(units) || units <= 0) { setMessage('Enter a valid entry price and position units.'); return; }
    const item = { id: `${Date.now()}-${Math.random().toString(36).slice(2,7)}`, symbol: form.symbol.toUpperCase().trim(), direction: form.direction, entry, units, setup: form.setup, notes: form.notes.trim(), tags: form.tags.trim(), entryReason: form.entryReason.trim(), emotion: form.emotion, mistake: !!form.mistake, lesson: form.lesson.trim(), exitReason: '', status: 'OPEN', openedAt: new Date().toISOString(), closedAt: null, exit: null, pnl: null };
    setEntries(old => [item, ...old]);
    setForm(old => ({ ...old, entry: marketPrice || '', notes: '', tags: '', entryReason: '', mistake: false, lesson: '' }));
    setMessage('Trade journal entry saved on this device.');
  }
  function closeEntry(id) {
    const exit = Number(closeInputs[id]);
    if (!Number.isFinite(exit) || exit <= 0) { setMessage('Enter a valid exit price before closing.'); return; }
    setEntries(old => old.map(t => t.id !== id || t.status !== 'OPEN' ? t : { ...t, exit, exitReason: (closeMeta[id]?.reason || '').trim(), closedAt: new Date().toISOString(), status: 'CLOSED', pnl: (t.direction === 'BUY' ? exit-t.entry : t.entry-exit) * t.units }));
    setMessage('Trade marked closed and P/L calculated using price difference × units.');
  }
  function deleteEntry(id) { if (window.confirm('Delete this journal entry?')) setEntries(old => old.filter(t => t.id !== id)); }
  function exportCsv() {
    const cols = ['symbol','direction','status','entry','exit','units','pnl','setup','tags','entryReason','exitReason','emotion','mistake','lesson','notes','openedAt','closedAt'];
    const quote = v => `"${String(v ?? '').replace(/"/g,'""')}"`;
    const csv = [cols.join(','), ...entries.map(t => cols.map(k => quote(t[k])).join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([csv], {type:'text/csv;charset=utf-8;'}));
    const a = document.createElement('a'); a.href = url; a.download = 'tradelab-trade-journal.csv'; a.click(); URL.revokeObjectURL(url);
  }

  const inputStyle = {width:'100%',background:'#0b1728',border:'1px solid #2b3b52',color:'#fff',borderRadius:6,padding:10,fontSize:12};
  const labelStyle = {display:'block',fontSize:11,color:'#8492a9',marginBottom:6};
  const smallBtn = {background:'#1c2a40',border:'1px solid #33445e',color:'#dbeafe',borderRadius:6,padding:'8px 10px',fontSize:11};
  return <>
    <div className="welcome"><div><h1>Trade Journal</h1><div className="muted">Record, review and learn from your simulated trading decisions.</div></div><div style={{display:'flex',gap:8,alignItems:'center'}}><span className="demo-badge">● PERSONAL / DEMO</span><button style={smallBtn} onClick={exportCsv}>Export CSV</button></div></div>
    <div className="stats-grid">
      <div className="card"><div className="stat-label">Closed-trade net P/L</div><div className={`stat-value ${net>=0?'positive':'negative'}`}>{money(net)}</div><div className="muted">{closed.length} closed trades</div></div>
      <div className="card"><div className="stat-label">Win rate</div><div className="stat-value">{winRate.toFixed(1)}%</div><div className="muted">{wins.length} wins · {losses.length} losses</div></div>
      <div className="card"><div className="stat-label">Profit factor</div><div className="stat-value">{profitFactor === Infinity ? '∞' : profitFactor.toFixed(2)}</div><div className="muted">Gross profit ÷ gross loss</div></div>
      <div className="card"><div className="stat-label">Open positions</div><div className="stat-value">{entries.filter(t=>t.status==='OPEN').length}</div><div className="muted">Awaiting manual close</div></div>
    </div>
    <div className="dashboard-grid" style={{gridTemplateColumns:'minmax(300px,0.9fr) minmax(0,1.5fr)'}}>
      <form className="card" onSubmit={addEntry}>
        <div className="card-heading"><h3>Record a trade</h3><span className="tag">MANUAL ENTRY</span></div>
        <div className="order-grid">
          <div className="field"><label>Instrument</label><input style={inputStyle} value={form.symbol} onChange={e=>setForm({...form,symbol:e.target.value.toUpperCase()})} placeholder="EURUSD" required/></div>
          <div className="field"><label>Direction</label><select style={inputStyle} value={form.direction} onChange={e=>setForm({...form,direction:e.target.value})}><option>BUY</option><option>SELL</option></select></div>
          <div className="field"><label>Entry price</label><input style={inputStyle} type="number" step="any" min="0" value={form.entry} onChange={e=>setForm({...form,entry:e.target.value})} required/></div>
          <div className="field"><label>Position units</label><input style={inputStyle} type="number" step="any" min="0" value={form.units} onChange={e=>setForm({...form,units:e.target.value})} required/></div>
        </div>
        <div className="field"><label>Setup / strategy</label><select style={inputStyle} value={form.setup} onChange={e=>setForm({...form,setup:e.target.value})}><option>Trend continuation</option><option>Breakout</option><option>Pullback</option><option>Support / resistance</option><option>Reversal</option><option>News / event</option><option>Other</option></select></div>
        <div className="field"><label>Tags (comma separated)</label><input style={inputStyle} value={form.tags} onChange={e=>setForm({...form,tags:e.target.value})} placeholder="London session, EMA, patience"/></div>
        <div className="field"><label>Why did you enter? (entry confirmation)</label><textarea style={{...inputStyle,minHeight:58,resize:'vertical'}} value={form.entryReason} onChange={e=>setForm({...form,entryReason:e.target.value})} placeholder="e.g. EMA alignment, breakout retest, volume confirmation"/></div>
        <div className="field"><label>Emotional state</label><select style={inputStyle} value={form.emotion} onChange={e=>setForm({...form,emotion:e.target.value})}><option>Calm / disciplined</option><option>Confident</option><option>Fearful</option><option>Greedy</option><option>Impatient</option><option>Revenge trading</option><option>Uncertain</option></select></div>
        <label style={{display:'flex',gap:8,alignItems:'center',fontSize:12,margin:'8px 0'}}><input type="checkbox" checked={form.mistake} onChange={e=>setForm({...form,mistake:e.target.checked})}/> This trade involved a mistake / rule violation</label>
        <div className="field"><label>Lesson to remember</label><textarea style={{...inputStyle,minHeight:54,resize:'vertical'}} value={form.lesson} onChange={e=>setForm({...form,lesson:e.target.value})} placeholder="What will I repeat or change next time?"/></div>
        <div className="field"><label>Trade notes</label><textarea style={{...inputStyle,minHeight:76,resize:'vertical'}} value={form.notes} onChange={e=>setForm({...form,notes:e.target.value})} placeholder="Why did you take this trade? What confirmed the setup?"/></div>
        <button className="execute-btn" type="submit">＋ Save journal entry</button>
        {message && <p className="muted" style={{lineHeight:1.5}}>{message}</p>}
        <p className="muted" style={{fontSize:10,lineHeight:1.6}}>Entries are stored in this browser on this device. This form does not send or execute broker orders. New review fields are saved with each entry; older records remain available.</p>
      </form>
      <div className="card">
        <div className="card-heading"><h3>Closed-trade equity curve</h3><span className="muted">Cumulative realised P/L</span></div>
        {closed.length < 1 ? <div className="empty">Close a journal trade to start building your performance curve.</div> : <svg viewBox={`0 0 ${chartW} ${chartH}`} style={{width:'100%',height:155,overflow:'visible'}}><line x1="0" y1={chartH-12-(0-minEq)/rangeEq*(chartH-24)} x2={chartW} y2={chartH-12-(0-minEq)/rangeEq*(chartH-24)} stroke="#52627a" strokeDasharray="4 4"/><polyline points={equityPoints} fill="none" stroke="#20d6a1" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/></svg>}
        <div className="stats-grid" style={{gridTemplateColumns:'1fr 1fr',marginTop:14,marginBottom:0}}><div><div className="stat-label">Average win</div><div className="stat-value positive">{money(avgWin)}</div></div><div><div className="stat-label">Average loss</div><div className="stat-value negative">{money(-avgLoss)}</div></div></div>
        <p className="muted" style={{fontSize:10,lineHeight:1.6,marginTop:16}}>P/L is an estimate calculated as price movement × units. It does not include contract specifications, pip/tick values, currency conversion, spread, commissions, swaps or slippage.</p>
      </div>
    </div>
    <div className="card" style={{marginTop:18}}>
      <div className="card-heading" style={{flexWrap:'wrap'}}><h3>Trade history</h3><span className="muted">{visible.length} of {entries.length} records</span></div>
      <div style={{display:'grid',gridTemplateColumns:'minmax(160px,2fr) repeat(2,minmax(120px,1fr))',gap:9,marginBottom:14}}>
        <input style={inputStyle} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search symbol, setup, notes…"/>
        <select style={inputStyle} value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}><option value="ALL">All statuses</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option></select>
        <select style={inputStyle} value={marketFilter} onChange={e=>setMarketFilter(e.target.value)}><option value="ALL">All instruments</option>{markets.map(m=><option key={m}>{m}</option>)}</select>
      </div>
      <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Side</th><th>Entry</th><th>Exit</th><th>Units</th><th>Setup / review</th><th>Status / P&amp;L</th><th>Exit reason / action</th></tr></thead>
        <tbody>{visible.length===0 ? <tr><td colSpan="8" className="empty">No journal records match. Add a trade using the form above.</td></tr> : visible.map(t=><tr key={t.id}>
          <td><strong>{t.symbol}</strong><div className="muted">{new Date(t.openedAt).toLocaleString()}</div></td><td className={t.direction==='BUY'?'positive':'negative'}>{t.direction}</td><td>{t.entry}</td><td>{t.exit ?? '—'}</td><td>{Number(t.units).toLocaleString()}</td>
          <td><strong>{t.setup}</strong><div className="muted" style={{maxWidth:230,whiteSpace:'normal'}}>{t.tags || 'No tags'} · {t.emotion || 'Emotion not recorded'}{t.mistake ? ' · RULE BREAK' : ''}</div><div className="muted" style={{maxWidth:230,whiteSpace:'normal',marginTop:4}}>{t.entryReason || t.notes || 'No entry rationale recorded'}{t.lesson ? ` · Lesson: ${t.lesson}` : ''}</div></td>
          <td>{t.status==='OPEN' ? <span className="tag">OPEN</span> : <span className={t.pnl>=0?'positive':'negative'}>{money(t.pnl)}</span>}</td>
          <td>{t.status==='OPEN' ? <div style={{display:'grid',gap:5,minWidth:150}}><input aria-label="Exit price" type="number" step="any" min="0" placeholder="Exit price" value={closeInputs[t.id] || ''} onChange={e=>setCloseInputs({...closeInputs,[t.id]:e.target.value})} style={{...inputStyle,padding:7}}/><input aria-label="Exit reason" placeholder="Exit reason (optional)" value={closeMeta[t.id]?.reason || ''} onChange={e=>setCloseMeta({...closeMeta,[t.id]:{...closeMeta[t.id],reason:e.target.value}})} style={{...inputStyle,padding:7}}/><div style={{display:'flex',gap:5}}><button style={smallBtn} onClick={()=>closeEntry(t.id)}>Close trade</button><button style={smallBtn} title="Delete" onClick={()=>deleteEntry(t.id)}>×</button></div></div> : <div><div className="muted" style={{maxWidth:170,whiteSpace:'normal'}}>{t.exitReason || 'No exit reason recorded'}</div><button style={{...smallBtn,marginTop:5}} onClick={()=>deleteEntry(t.id)}>Delete</button></div>}</td>
        </tr>)}</tbody></table></div>
    </div>
  </>;
}


function SmartScanner({ selectedMarket, onSelectMarket, timeframe = '5min', onTimeframeChange }) {
  const symbols = ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'BTCUSD'];
  const [results, setResults] = useState([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState('');
  const [filter, setFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('score');
  const [lastScan, setLastScan] = useState(null);
  const [scanProgress, setScanProgress] = useState('');
  const [minAdx, setMinAdx] = useState('15');

  const runScan = async () => {
    setScanning(true); setScanError(''); setResults([]); setScanProgress('Preparing market scan…');
    const found = [];
    try {
      // Scan sequentially to reduce the chance of exhausting the market-data provider quota.
      for (let index = 0; index < symbols.length; index++) {
        const symbol = symbols[index];
        setScanProgress(`Scanning ${symbol} (${index + 1}/${symbols.length})…`);
        try {
          const response = await fetch(`/api/candles?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&outputsize=180`);
          const data = await response.json();
          if (!response.ok || !data.ok || !Array.isArray(data.candles)) throw new Error(data.details || data.error || 'Candle data unavailable');
          const candles = data.candles;
          const closes = candles.map(c => Number(c.close));
          if (candles.length < 60 || closes.some(v => !Number.isFinite(v))) throw new Error('Insufficient clean candle history');
          const ema20 = calcEMA(closes, 20), ema50 = calcEMA(closes, 50);
          const rsiSeries = calcRSI(closes, 14), macd = calcMACD(closes), adxSeries = calcADX(candles, 14);
          const i = closes.length - 1, price = closes[i], e20 = ema20[i], e50 = ema50[i];
          const rsi = rsiSeries[i], macdHist = macd.histogram[i], adx = adxSeries[i];
          if ([e20,e50,rsi,macdHist].some(v => v == null || !Number.isFinite(v))) throw new Error('Indicators need more candle history');
          let score = 0; const reasons = [];
          if (e20 > e50) { score += 2; reasons.push('EMA 20 above EMA 50'); }
          else if (e20 < e50) { score -= 2; reasons.push('EMA 20 below EMA 50'); }
          if (price > e20) { score += 1; reasons.push('Price above EMA 20'); }
          else if (price < e20) { score -= 1; reasons.push('Price below EMA 20'); }
          if (rsi >= 52 && rsi < 70) { score += 1; reasons.push('RSI bullish momentum'); }
          else if (rsi <= 48 && rsi > 30) { score -= 1; reasons.push('RSI bearish momentum'); }
          else if (rsi >= 70) reasons.push('RSI overbought zone');
          else if (rsi <= 30) reasons.push('RSI oversold zone');
          if (macdHist > 0) { score += 2; reasons.push('MACD histogram positive'); }
          else if (macdHist < 0) { score -= 2; reasons.push('MACD histogram negative'); }
          if (Number.isFinite(adx) && adx >= Number(minAdx)) reasons.push(`Trend strength confirmed (ADX ${adx.toFixed(1)})`);
          else reasons.push('Weak / developing trend (ADX)');
          const signal = score >= 4 ? 'STRONG BUY' : score >= 2 ? 'BUY' : score <= -4 ? 'STRONG SELL' : score <= -2 ? 'SELL' : 'NEUTRAL';
          found.push({symbol,price,rsi,adx:Number.isFinite(adx)?adx:null,macdHist,ema20:e20,ema50:e50,score,signal,reasons,candles:candles.length,scannedAt:new Date().toISOString()});
        } catch (err) {
          found.push({symbol,signal:'NO DATA',score:0,error:err.message,reasons:[]});
        }
      }
      setResults(found); setLastScan(new Date());
      if (found.every(r => r.signal === 'NO DATA')) setScanError('No instruments returned usable candle data. Check the market-data connection and try again.');
    } catch (err) { setScanError(err.message || 'Scanner failed.'); }
    finally { setScanning(false); setScanProgress(''); }
  };

  const visible = results.filter(r => filter === 'ALL' || (filter === 'ACTIONABLE' ? ['BUY','STRONG BUY','SELL','STRONG SELL'].includes(r.signal) : filter === r.signal));
  const sorted = [...visible].sort((a,b) => sortBy === 'symbol' ? a.symbol.localeCompare(b.symbol) : sortBy === 'price' ? (b.price||0)-(a.price||0) : Math.abs(b.score)-Math.abs(a.score));
  const cardStyle = {background:'#0e192b',border:'1px solid #293a52',borderRadius:8,padding:12};
  const inputStyle = {background:'#0b1728',border:'1px solid #2b3b52',color:'#fff',borderRadius:6,padding:'9px 10px',fontSize:12};
  const signalColor = signal => signal.includes('BUY') ? '#20d6a1' : signal.includes('SELL') ? '#fb7185' : signal === 'NO DATA' ? '#fbbf24' : '#aab6c9';
  const fmt = (v,symbol) => v == null || !Number.isFinite(v) ? '—' : Number(v).toFixed(symbol==='USDJPY'?3:symbol==='BTCUSD'?1:symbol==='XAUUSD'?2:5);

  return <>
    <div className="welcome"><div><h1>Smart Market Scanner</h1><div className="muted">Scan supported instruments for multi-indicator momentum and trend confluence.</div></div><div className="demo-badge">● TECHNICAL SCAN · ANALYSIS ONLY</div></div>
    <div className="card" style={{marginBottom:16}}>
      <div className="card-heading" style={{flexWrap:'wrap'}}><h3>Scanner controls</h3><span className="muted">{lastScan ? `Last scan: ${lastScan.toLocaleTimeString()}` : 'No scan run yet'}</span></div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
        <label style={{fontSize:11,color:'#9ba9bd'}}>Timeframe <select style={inputStyle} value={timeframe} onChange={e=>onTimeframeChange(e.target.value)} disabled={scanning}>{[['1min','1 minute'],['5min','5 minutes'],['15min','15 minutes'],['30min','30 minutes'],['1h','1 hour'],['4h','4 hours']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
        <label style={{fontSize:11,color:'#9ba9bd'}}>Minimum ADX <select style={inputStyle} value={minAdx} onChange={e=>setMinAdx(e.target.value)} disabled={scanning}><option value="10">10</option><option value="15">15</option><option value="20">20</option><option value="25">25</option></select></label>
        <button className="execute-btn" onClick={runScan} disabled={scanning}>{scanning ? 'Scanning…' : 'Run market scan'}</button>
      </div>
      {scanning && <div style={{marginTop:12,color:'#20d6a1',fontSize:12}}>{scanProgress}</div>}
      {scanError && <div style={{marginTop:12,color:'#fbbf24',fontSize:12}}>{scanError}</div>}
      <p className="muted" style={{lineHeight:1.6,margin:'13px 0 0'}}>Scans EURUSD, GBPUSD, USDJPY, XAUUSD and BTCUSD using historical candles from the connected market-data service. Data is refreshed only when you run a scan; it is not a tick-by-tick feed.</p>
    </div>
    <div className="stats-grid">
      <div className="card"><div className="stat-label">Markets scanned</div><div className="stat-value">{results.length ? results.length : '—'}</div><div className="muted">Of {symbols.length} supported symbols</div></div>
      <div className="card"><div className="stat-label">Bullish setups</div><div className="stat-value positive">{results.filter(r=>r.signal.includes('BUY')).length}</div><div className="muted">Rule-based confluence</div></div>
      <div className="card"><div className="stat-label">Bearish setups</div><div className="stat-value negative">{results.filter(r=>r.signal.includes('SELL')).length}</div><div className="muted">Rule-based confluence</div></div>
      <div className="card"><div className="stat-label">Neutral / unavailable</div><div className="stat-value">{results.filter(r=>['NEUTRAL','NO DATA'].includes(r.signal)).length}</div><div className="muted">No directional consensus</div></div>
    </div>
    <div className="card" style={{marginBottom:16}}>
      <div className="card-heading" style={{flexWrap:'wrap'}}><h3>Scan results</h3><div style={{display:'flex',gap:8,flexWrap:'wrap'}}><select style={inputStyle} value={filter} onChange={e=>setFilter(e.target.value)}><option value="ALL">All results</option><option value="ACTIONABLE">Actionable only</option><option value="STRONG BUY">Strong buy</option><option value="BUY">Buy</option><option value="NEUTRAL">Neutral</option><option value="SELL">Sell</option><option value="STRONG SELL">Strong sell</option><option value="NO DATA">No data</option></select><select style={inputStyle} value={sortBy} onChange={e=>setSortBy(e.target.value)}><option value="score">Sort by signal strength</option><option value="symbol">Sort by symbol</option><option value="price">Sort by price</option></select></div></div>
      {!results.length ? <div className="empty">Run a market scan to populate the results table.</div> : <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Last candle close</th><th>Signal</th><th>Score</th><th>RSI 14</th><th>ADX 14</th><th>MACD histogram</th><th>Action</th></tr></thead><tbody>{sorted.map(r=><tr key={r.symbol}><td><strong>{r.symbol}</strong><div className="muted">{r.candles ? `${r.candles} candles` : r.error}</div></td><td>{fmt(r.price,r.symbol)}</td><td style={{color:signalColor(r.signal),fontWeight:700}}>{r.signal}</td><td>{r.signal==='NO DATA'?'—':`${r.score>0?'+':''}${r.score}`}</td><td>{r.rsi==null?'—':r.rsi.toFixed(1)}</td><td>{r.adx==null?'—':r.adx.toFixed(1)}</td><td>{r.macdHist==null?'—':r.macdHist.toPrecision(4)}</td><td><button className="period-btn" disabled={r.signal==='NO DATA'} onClick={()=>{onSelectMarket(r.symbol);}}>Open market</button></td></tr>)}</tbody></table></div>}
    </div>
    {results.length>0 && <div className="card"><div className="card-heading"><h3>Signal reasoning</h3><span className="muted">Rule-based indicator checks</span></div><div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:10}}>{results.filter(r=>r.signal!=='NO DATA').map(r=><div key={r.symbol} style={cardStyle}><div style={{display:'flex',justifyContent:'space-between',gap:8,marginBottom:8}}><strong>{r.symbol}</strong><strong style={{color:signalColor(r.signal)}}>{r.signal}</strong></div><div className="muted" style={{lineHeight:1.8}}>{r.reasons.map((reason,i)=><div key={i}>• {reason}</div>)}</div></div>)}</div></div>}
    <div className="card" style={{marginTop:16,borderColor:'#5b4520'}}><p className="muted" style={{fontSize:11,lineHeight:1.7,margin:0}}><strong style={{color:'#fbbf24'}}>Important:</strong> Scanner scores are transparent technical rules, not machine-learning predictions or guaranteed trade signals. A BUY/SELL label is not a recommendation to enter automatically. Confirm spread, session, news, higher-timeframe context and your risk limits before considering any trade. US30 is listed elsewhere in the app but is not included because its market-data feed is not connected.</p></div>
  </>;
}



function TradingTerminalPage({ symbol, price, candles }) {
  const [side, setSide] = useState('BUY');
  const [type, setType] = useState('Market');
  const [volume, setVolume] = useState('0.10');
  const [entry, setEntry] = useState('');
  const [sl, setSl] = useState('');
  const [tp, setTp] = useState('');
  const [message, setMessage] = useState('');
  const [orders, setOrders] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tradelab_demo_orders') || '[]'); }
    catch { return []; }
  });
  const quote = Number(price);
  const atrValues = calcATR(candles || [], 14);
  const atr = atrValues.length ? Number(atrValues[atrValues.length - 1]) : NaN;
  const decimals = symbol === 'USDJPY' ? 3 : symbol === 'BTCUSD' ? 1 : symbol === 'XAUUSD' ? 2 : 5;
  const activeEntry = type === 'Market' ? quote : Number(entry);
  const risk = Math.abs(activeEntry - Number(sl));
  const reward = Math.abs(Number(tp) - activeEntry);
  const rr = risk > 0 ? reward / risk : NaN;
  const fmt = value => Number.isFinite(value) ? value.toFixed(decimals) : '';

  function suggestLevels() {
    if (!Number.isFinite(quote) || quote <= 0) { setMessage('Wait for a valid live market price before suggesting levels.'); return; }
    if (!Number.isFinite(atr) || atr <= 0) { setMessage('Not enough candle history to calculate ATR.'); return; }
    const stopDistance = atr * 1.5;
    const targetDistance = atr * 3;
    setEntry(fmt(quote));
    setSl(fmt(side === 'BUY' ? quote - stopDistance : quote + stopDistance));
    setTp(fmt(side === 'BUY' ? quote + targetDistance : quote - targetDistance));
    setMessage('Illustrative ATR levels filled. Review them before creating a demo order.');
  }

  function submitOrder() {
    const qty = Number(volume);
    const open = type === 'Market' ? quote : Number(entry);
    const stop = Number(sl), target = Number(tp);
    if (!Number.isFinite(quote) || quote <= 0) return setMessage('A valid market quote is required.');
    if (!Number.isFinite(qty) || qty <= 0) return setMessage('Enter a valid volume greater than zero.');
    if (!Number.isFinite(open) || open <= 0) return setMessage('Enter a valid entry price.');
    if (!Number.isFinite(stop) || !Number.isFinite(target) || stop <= 0 || target <= 0) return setMessage('Enter valid stop-loss and take-profit prices.');
    if (side === 'BUY' && !(stop < open && target > open)) return setMessage('For a BUY, stop loss must be below entry and take profit above entry.');
    if (side === 'SELL' && !(stop > open && target < open)) return setMessage('For a SELL, stop loss must be above entry and take profit below entry.');
    const order = { id: Date.now(), symbol, side, type, volume: qty.toFixed(2), entry: fmt(open), sl: fmt(stop), tp: fmt(target), rr: (Math.abs(target-open)/Math.abs(open-stop)).toFixed(2), time: new Date().toLocaleString(), status: 'PAPER OPEN' };
    const next = [order, ...orders].slice(0, 100);
    setOrders(next);
    try { localStorage.setItem('tradelab_demo_orders', JSON.stringify(next)); } catch {}
    setMessage(`${side} paper order saved locally. No broker order was sent.`);
  }

  return <>
    <div className="welcome"><div><h1>Trading Terminal</h1><div className="muted">Build and record simulated orders with explicit entry, stop-loss and take-profit levels.</div></div><div className="demo-badge">● PAPER TRADING ONLY</div></div>
    <div className="card">
      <div className="card-heading"><h3>Order ticket · {symbol}</h3><span className="tag">Live quote: {Number.isFinite(quote) ? fmt(quote) : 'Unavailable'}</span></div>
      <div className="order-grid">
        <div className="field"><label>Instrument</label><input value={symbol} readOnly /></div>
        <div className="field"><label>Order type</label><select value={type} onChange={e=>{setType(e.target.value);setMessage('');}}><option>Market</option><option>Limit</option><option>Stop</option></select></div>
        <div className="field"><label>Volume (lots)</label><input type="number" min="0.01" step="0.01" value={volume} onChange={e=>setVolume(e.target.value)}/></div>
        <div className="field"><label>Entry price {type==='Market'?'(current quote)':''}</label><input type="number" step="any" value={type==='Market' ? fmt(quote) : entry} disabled={type==='Market'} onChange={e=>setEntry(e.target.value)} placeholder="Enter planned entry"/></div>
        <div className="field"><label>Stop-loss price</label><input type="number" step="any" value={sl} onChange={e=>setSl(e.target.value)} placeholder="Price level"/></div>
        <div className="field"><label>Take-profit price</label><input type="number" step="any" value={tp} onChange={e=>setTp(e.target.value)} placeholder="Price level"/></div>
      </div>
      <div className="trade-buttons"><button className="buy-btn" onClick={()=>{setSide('BUY');setMessage('BUY selected.');}}><ArrowUpRight size={15}/> BUY</button><button className="sell-btn" onClick={()=>{setSide('SELL');setMessage('SELL selected.');}}><ArrowDownRight size={15}/> SELL</button></div>
      <div className="signal"><span>Selected side</span><strong>{side}</strong></div>
      <div className="signal"><span>Reward / risk</span><strong>{Number.isFinite(rr) ? `1 : ${rr.toFixed(2)}` : 'Enter valid SL and TP'}</strong></div>
      <div className="muted" style={{margin:'12px 0'}}>ATR(14): {Number.isFinite(atr) ? fmt(atr) : 'Insufficient candle history'}. Suggested levels use 1.5× ATR stop and 3× ATR target; they are not guaranteed signals.</div>
      <div className="trade-buttons"><button className="period-btn" onClick={suggestLevels}>Suggest ATR levels</button><button className="execute-btn" onClick={submitOrder}>Save paper order</button></div>
      {message && <p className="muted" role="status" style={{marginTop:12}}>{message}</p>}
      <p className="muted" style={{lineHeight:1.6}}>This terminal stores simulated orders in this browser only. It does not connect to Deriv, MT5 or any broker. Lot value, pip value, margin and cash risk are not estimated because broker contract specifications are not configured.</p>
    </div>
    <div className="card" style={{marginTop:18}}><div className="card-heading"><h3>Paper order history</h3><span className="muted">{orders.length} saved</span></div><div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Side</th><th>Volume</th><th>Entry</th><th>Stop loss</th><th>Take profit</th><th>R:R</th><th>Time</th></tr></thead><tbody>{orders.length===0?<tr><td colSpan="8" className="empty">No paper orders yet.</td></tr>:orders.map(o=><tr key={o.id}><td>{o.symbol}</td><td className={o.side==='BUY'?'positive':'negative'}>{o.side}</td><td>{o.volume}</td><td>{o.entry}</td><td>{o.sl}</td><td>{o.tp}</td><td>1:{o.rr}</td><td>{o.time}</td></tr>)}</tbody></table></div></div>
  </>;
}

function AutomationCentrePage({ candles = [], symbol = 'EURUSD', timeframe = '5min' }) {
  const [strategy,setStrategy] = useState('Confluence');
  const [risk,setRisk] = useState('0.5');
  const [maxTrades,setMaxTrades] = useState('3');
  const [dailyLimit,setDailyLimit] = useState('2');
  const [status,setStatus] = useState('STOPPED');
  const [trades,setTrades] = useState([]);
  const [log,setLog] = useState([]);
  const [lastProcessed,setLastProcessed] = useState('');
  const [lastSignal,setLastSignal] = useState(null);
  const fmt = (value, market=symbol) => value==null || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(market==='USDJPY'?3:market==='BTCUSD'?1:market==='XAUUSD'?2:5);

  const analysis = useMemo(() => {
    if (!Array.isArray(candles) || candles.length < 205) return {signal:'WAIT',reason:'At least 205 candles are required for EMA 200 and indicator confirmation.'};
    const closes = candles.map(c=>Number(c.close));
    const ema20 = calcEMA(closes,20), ema50 = calcEMA(closes,50), ema200 = calcEMA(closes,200);
    const rsi = calcRSI(closes,14), macd = calcMACD(closes), adx = calcADX(candles,14), atr = calcATR(candles,14);
    const i = candles.length-1, prev=i-1;
    const values=[ema20[i],ema50[i],ema200[i],rsi[i],macd.histogram[i],macd.histogram[prev],adx[i],atr[i]];
    if(values.some(v=>v==null || !Number.isFinite(v)) || atr[i]<=0) return {signal:'WAIT',reason:'Indicator history is not yet sufficient.'};
    const bull = ema20[i]>ema50[i] && closes[i]>ema200[i] && rsi[i]>=52 && rsi[i]<70 && macd.histogram[i]>0 && macd.histogram[i]>=macd.histogram[prev] && adx[i]>=20;
    const bear = ema20[i]<ema50[i] && closes[i]<ema200[i] && rsi[i]<=48 && rsi[i]>30 && macd.histogram[i]<0 && macd.histogram[i]<=macd.histogram[prev] && adx[i]>=20;
    const signal = bull?'BUY':bear?'SELL':'WAIT';
    const reason = signal==='BUY'?'EMA alignment, RSI momentum, positive MACD and ADX confirmation.':signal==='SELL'?'Bearish EMA alignment, RSI momentum, negative MACD and ADX confirmation.':'The complete entry checklist is not aligned.';
    return {signal,reason,price:closes[i],atr:atr[i],rsi:rsi[i],adx:adx[i],candleTime:String(candles[i].time ?? i)};
  },[candles]);

  useEffect(()=>{
    if(status!=='RUNNING' || !analysis.candleTime || analysis.candleTime===lastProcessed) return;
    setLastProcessed(analysis.candleTime);
    setLastSignal(analysis);
    const now=new Date();
    const day=now.toLocaleDateString();
    setTrades(old=>{
      const todays=old.filter(t=>t.day===day);
      const open=todays.find(t=>t.status==='OPEN');
      if(open){
        const candle=candles[candles.length-1];
        const hitStop=open.direction==='BUY'?Number(candle.low)<=open.stop:Number(candle.high)>=open.stop;
        const hitTarget=open.direction==='BUY'?Number(candle.high)>=open.target:Number(candle.low)<=open.target;
        if(hitStop || hitTarget){
          const exit=hitStop?open.stop:open.target;
          const pnl=(open.direction==='BUY'?exit-open.entry:open.entry-exit);
          const closed={...open,status:hitStop?'STOPPED OUT':'TARGET HIT',exit,pnl,closedAt:now.toLocaleTimeString()};
          setLog(logs=>[{id:Date.now(),time:now.toLocaleTimeString(),text:`${open.symbol} ${open.direction} ${closed.status} at ${exit}. Simulated price P/L: ${pnl.toPrecision(5)}.`},...logs].slice(0,30));
          return old.map(t=>t.id===open.id?closed:t);
        }
        return old;
      }
      const max= Math.max(1,Math.min(20,Number(maxTrades)||1));
      if(todays.length>=max){
        setLog(logs=>[{id:Date.now(),time:now.toLocaleTimeString(),text:'Entry blocked by daily trade or loss-limit control.'},...logs].slice(0,30));
        return old;
      }
      if(analysis.signal==='WAIT' || !analysis.price || !analysis.atr) return old;
      const direction=analysis.signal, distance=analysis.atr*1.5;
      const entry=analysis.price, stop=direction==='BUY'?entry-distance:entry+distance, target=direction==='BUY'?entry+distance*2:entry-distance*2;
      const trade={id:Date.now(),day,symbol,direction,entry,stop,target,volumeRiskPct:Number(risk)||0.5,status:'OPEN',time:now.toLocaleTimeString(),timeframe,pnl:0};
      setLog(logs=>[{id:trade.id,time:trade.time,text:`Paper ${direction} opened on ${symbol}. Entry ${entry}; SL ${stop}; TP ${target}.`},...logs].slice(0,30));
      return [trade,...old].slice(0,100);
    });
  },[status,analysis,candles,symbol,timeframe,risk,maxTrades,dailyLimit,lastProcessed]);

  function changeStatus(next){setStatus(next);setLog(old=>[{id:Date.now(),time:new Date().toLocaleTimeString(),text:`Paper automation ${next.toLowerCase()}.`},...old].slice(0,30));}
  const openTrades=trades.filter(t=>t.status==='OPEN');
  const closedTrades=trades.filter(t=>t.status!=='OPEN');
  const realised=closedTrades.reduce((sum,t)=>sum+(Number(t.pnl)||0),0);
  return <>
    <div className="welcome"><div><h1>Intelligent Automation Centre</h1><div className="muted">Rule-based candle evaluation and simulated trade management · {symbol} · {timeframe}</div></div><div className="demo-badge">● PAPER MODE ONLY</div></div>
    <div className="card"><div className="card-heading"><h3>Automation configuration</h3><span className="tag">{status}</span></div><div className="order-grid">
      <div className="field"><label>Strategy</label><select value={strategy} onChange={e=>setStrategy(e.target.value)}><option>Confluence</option></select></div>
      <div className="field"><label>Risk setting (%)</label><input type="number" min="0.1" max="3" step="0.1" value={risk} onChange={e=>setRisk(e.target.value)}/></div>
      <div className="field"><label>Maximum trades / day</label><input type="number" min="1" max="20" value={maxTrades} onChange={e=>setMaxTrades(e.target.value)}/></div>
      <div className="field"><label>Daily loss limit (%)</label><input type="number" min="0.1" max="10" step="0.1" value={dailyLimit} onChange={e=>setDailyLimit(e.target.value)}/></div>
    </div><div className="trade-buttons"><button className="execute-btn" onClick={()=>changeStatus('RUNNING')} disabled={status==='RUNNING'}>Start paper mode</button><button className="period-btn" onClick={()=>changeStatus('PAUSED')} disabled={status!=='RUNNING'}>Pause</button><button className="period-btn" onClick={()=>changeStatus('STOPPED')}>Emergency stop</button></div>
    <div className="signal"><span>Latest signal</span><strong className={analysis.signal==='BUY'?'positive':analysis.signal==='SELL'?'negative':''}>{analysis.signal}</strong></div>
    <div className="signal"><span>Signal explanation</span><span>{analysis.reason}</span></div>
    {analysis.price!=null&&<div className="signal"><span>Reference price · RSI · ADX</span><span>{fmt(analysis.price,symbol)} · {analysis.rsi?.toFixed(1)} · {analysis.adx?.toFixed(1)}</span></div>}
    <p className="muted" style={{lineHeight:1.6}}>The engine checks the latest candle whenever the app receives updated market candles. It does not run in the background when this page is closed. Entries use a 1.5× ATR stop and a 3× ATR target. The daily loss percentage is a user-defined advisory threshold only: exact cash loss enforcement and broker-accurate position sizing require instrument contract specifications and account-currency conversion.</p></div>
    <div className="dashboard-grid" style={{marginTop:18}}><div className="card"><div className="card-heading"><h3>Open paper positions</h3><span className="tag">{openTrades.length}</span></div>{openTrades.length===0?<div className="empty">No open simulated positions.</div>:openTrades.map(t=><div className="signal" key={t.id}><span>{t.symbol} {t.direction}<small className="muted" style={{display:'block'}}>Entry {fmt(t.entry,t.symbol)} · SL {fmt(t.stop,t.symbol)} · TP {fmt(t.target,t.symbol)}</small></span><span className="tag">OPEN</span></div>)}</div>
    <div className="card"><div className="card-heading"><h3>Paper performance</h3></div><div className="signal"><span>Closed positions</span><strong>{closedTrades.length}</strong></div><div className="signal"><span>Realised price movement</span><strong className={realised>=0?'positive':'negative'}>{realised.toPrecision(5)}</strong></div><div className="signal"><span>Current candle history</span><strong>{candles.length}</strong></div></div></div>
    <div className="card" style={{marginTop:18}}><div className="card-heading"><h3>Paper trade history</h3><span className="muted">{trades.length} positions</span></div><div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Side</th><th>Entry</th><th>Stop</th><th>Target</th><th>Status</th><th>Price P/L</th></tr></thead><tbody>{trades.length===0?<tr><td colSpan="7" className="empty">No automated paper trades yet. Start paper mode and wait for a confirmed setup.</td></tr>:trades.map(t=><tr key={t.id}><td>{t.symbol}</td><td>{t.direction}</td><td>{fmt(t.entry,t.symbol)}</td><td>{fmt(t.stop,t.symbol)}</td><td>{fmt(t.target,t.symbol)}</td><td>{t.status}</td><td className={(t.pnl||0)>=0?'positive':'negative'}>{t.pnl==null?'—':Number(t.pnl).toPrecision(5)}</td></tr>)}</tbody></table></div></div>
    <div className="card" style={{marginTop:18}}><div className="card-heading"><h3>Automation activity</h3><span className="muted">{log.length} events</span></div>{log.length===0?<div className="empty">No automation events yet.</div>:log.map(item=><div className="signal" key={item.id}><span>{item.time}</span><span>{item.text}</span></div>)}</div>
  </>;
}

function AccountOverviewPage({ trades = [] }) {
  const [accountName, setAccountName] = useState(() => localStorage.getItem('tradelab_account_label') || 'Trader Account');
  const [saved, setSaved] = useState(false);
  const demoBalance = 10000;
  const openCount = trades.filter(t => /OPEN/i.test(t.status || '')).length;
  const closedCount = trades.filter(t => /CLOSED/i.test(t.status || '')).length;
  function saveLabel() { localStorage.setItem('tradelab_account_label', accountName.trim() || 'Trader Account'); setSaved(true); }
  return <>
    <div className="welcome"><div><h1>Account Overview</h1><div className="muted">A summary of this browser's TradeLab demo workspace.</div></div><div className="demo-badge">● PAPER / DEMO ACCOUNT</div></div>
    <div className="stats-grid">
      <div className="card"><div className="stat-label">Starting demo balance</div><div className="stat-value">$10,000.00</div><div className="muted">Virtual funds only</div></div>
      <div className="card"><div className="stat-label">Estimated account equity</div><div className="stat-value">$10,000.00</div><div className="muted">No broker balance connected</div></div>
      <div className="card"><div className="stat-label">Open demo orders</div><div className="stat-value">{openCount}</div><div className="muted">Orders in this app session</div></div>
      <div className="card"><div className="stat-label">Closed demo trades</div><div className="stat-value">{closedCount}</div><div className="muted">Recorded in current session</div></div>
    </div>
    <div className="dashboard-grid">
      <div className="card"><div className="card-heading"><h3>Account profile</h3><span className="tag">LOCAL PROFILE</span></div>
        <div className="field"><label>Account display name</label><input value={accountName} onChange={e=>{setAccountName(e.target.value);setSaved(false);}} maxLength="40"/></div>
        <button className="execute-btn" onClick={saveLabel}>Save display name</button>{saved&&<p className="muted" role="status">Display name saved in this browser.</p>}
      </div>
      <div className="card"><div className="card-heading"><h3>Account connectivity</h3></div>
        <div className="signal"><span>Account type</span><strong>Demo / paper</strong></div><div className="signal"><span>Broker connection</span><strong>Not connected</strong></div><div className="signal"><span>Live execution</span><strong className="negative">Disabled</strong></div><div className="signal"><span>Account currency</span><strong>USD (illustrative)</strong></div>
      </div>
    </div>
    <div className="card"><div className="card-heading"><h3>Account activity</h3><span className="muted">{trades.length} session orders</span></div>
      <div className="table-wrap"><table><thead><tr><th>Instrument</th><th>Direction</th><th>Volume</th><th>Type</th><th>Time</th><th>Status</th></tr></thead><tbody>{trades.length===0?<tr><td colSpan="6" className="empty">No orders recorded in this session.</td></tr>:trades.map(t=><tr key={t.id}><td>{t.symbol}</td><td>{t.direction}</td><td>{t.lot}</td><td>{t.type}</td><td>{t.time}</td><td>{t.status}</td></tr>)}</tbody></table></div>
    </div>
    <div className="card" style={{marginTop:18,borderColor:'#5b4520'}}><p className="muted" style={{lineHeight:1.7,margin:0}}>This is an application-level demo overview, not a verified brokerage statement. Balance, margin, equity, deposits, withdrawals and realised P/L will only become authoritative after a secure broker/account backend is integrated.</p></div>
  </>;
}

function SecurityCentrePage() {
  const [lockEnabled, setLockEnabled] = useState(() => localStorage.getItem('tradelab_paper_lock') === 'true');
  const [showKeys, setShowKeys] = useState(false);
  function toggleLock(value) { setLockEnabled(value); localStorage.setItem('tradelab_paper_lock', String(value)); }
  return <>
    <div className="welcome"><div><h1>Security Centre</h1><div className="muted">Security status and safe-use controls for this browser workspace.</div></div><div className="demo-badge">● LOCAL SECURITY CHECK</div></div>
    <div className="stats-grid">
      <div className="card"><div className="stat-label">Live trading</div><div className="stat-value positive">Disabled</div><div className="muted">No live broker execution</div></div>
      <div className="card"><div className="stat-label">Broker credentials</div><div className="stat-value">Not stored</div><div className="muted">Do not paste secrets into the app</div></div>
      <div className="card"><div className="stat-label">Two-factor authentication</div><div className="stat-value">Not configured</div><div className="muted">Requires account authentication backend</div></div>
      <div className="card"><div className="stat-label">Security mode</div><div className="stat-value">Browser demo</div><div className="muted">No server-side identity verification</div></div>
    </div>
    <div className="card"><div className="card-heading"><h3>Paper trading lock</h3><span className={lockEnabled?'tag':'demo-badge'}>{lockEnabled?'LOCK ENABLED':'LOCK DISABLED'}</span></div>
      <p className="muted" style={{lineHeight:1.7}}>This local safety switch records your preference in this browser. It is not an authentication system and does not currently block backend or broker actions. Live execution remains disabled independently.</p>
      <button className="execute-btn" style={{background:lockEnabled?'#087d69':'#9b354d'}} onClick={()=>toggleLock(!lockEnabled)}>{lockEnabled?'Turn off local paper lock':'Enable local paper lock'}</button>
    </div>
    <div className="dashboard-grid" style={{marginTop:18}}>
      <div className="card"><div className="card-heading"><h3>Security checklist</h3><ShieldCheck size={19} color="#20d6a1"/></div>
        {['Use a unique password for every broker account','Enable two-factor authentication with your broker','Never share API secrets, passwords or recovery codes','Use read-only API permissions for market analysis','Review broker sessions and revoke unknown devices','Keep your browser and operating system updated'].map((item,i)=><div className="signal" key={i}><span>{item}</span><span className="muted">Recommended</span></div>)}
      </div>
      <div className="card"><div className="card-heading"><h3>API key safety</h3><LockKeyhole size={19} color="#20d6a1"/></div>
        <p className="muted" style={{lineHeight:1.7}}>API credentials must never be embedded in React source code or committed to GitHub. When broker connectivity is added, secrets should be stored as encrypted server-side environment secrets and scoped to the minimum required permissions.</p>
        <button className="period-btn" onClick={()=>setShowKeys(v=>!v)}>{showKeys?'Hide guidance':'Show key-handling guidance'}</button>
        {showKeys&&<div className="signal" style={{marginTop:12}}><span>Required approach</span><strong>Server-side secrets only</strong></div>}
      </div>
    </div>
    <div className="card" style={{marginTop:18,borderColor:'#5b4520'}}><p className="muted" style={{lineHeight:1.7,margin:0}}>Important limitation: these are advisory UI controls, not a substitute for real authentication, encrypted storage, server-side authorization, audit logging, rate limiting or penetration testing. Do not enter real broker credentials until those backend protections are implemented and independently tested.</p></div>
  </>;
}


function PerformanceAnalyticsPage() {
  const [entries, setEntries] = useState(() => {
    try { const raw = localStorage.getItem('tradelab_trade_journal_v1'); const data = raw ? JSON.parse(raw) : []; return Array.isArray(data) ? data : []; }
    catch { return []; }
  });
  const [period, setPeriod] = useState('ALL');
  useEffect(() => {
    const refresh = () => { try { const raw=localStorage.getItem('tradelab_trade_journal_v1'); const data=raw?JSON.parse(raw):[]; setEntries(Array.isArray(data)?data:[]); } catch {} };
    window.addEventListener('storage', refresh);
    const timer=window.setInterval(refresh,1500);
    return () => { window.removeEventListener('storage',refresh); window.clearInterval(timer); };
  }, []);
  const closedAll = entries.filter(t => t.status==='CLOSED' && Number.isFinite(Number(t.pnl)));
  const cutoff = period==='ALL' ? 0 : Date.now() - Number(period)*86400000;
  const closed = closedAll.filter(t => !cutoff || new Date(t.closedAt || t.openedAt).getTime() >= cutoff);
  const wins=closed.filter(t=>Number(t.pnl)>0), losses=closed.filter(t=>Number(t.pnl)<0), flats=closed.filter(t=>Number(t.pnl)===0);
  const net=closed.reduce((a,t)=>a+Number(t.pnl||0),0), grossWin=wins.reduce((a,t)=>a+Number(t.pnl),0), grossLoss=Math.abs(losses.reduce((a,t)=>a+Number(t.pnl),0));
  const winRate=closed.length?wins.length/closed.length*100:0, pf=grossLoss?grossWin/grossLoss:(grossWin?Infinity:0), avg=closed.length?net/closed.length:0;
  const avgWin=wins.length?grossWin/wins.length:0, avgLoss=losses.length?grossLoss/losses.length:0;
  const expectancy=avg, best=closed.length?Math.max(...closed.map(t=>Number(t.pnl))):0, worst=closed.length?Math.min(...closed.map(t=>Number(t.pnl))):0;
  const ordered=closed.slice().sort((a,b)=>new Date(a.closedAt||a.openedAt)-new Date(b.closedAt||b.openedAt));
  let running=0, peak=0, maxDD=0;
  const curve=ordered.map(t=>{running+=Number(t.pnl||0);peak=Math.max(peak,running);maxDD=Math.max(maxDD,peak-running);return running;});
  const minEq=Math.min(0,...curve),maxEq=Math.max(0,...curve),span=maxEq-minEq||1;
  const points=curve.map((v,i)=>`${curve.length<2?300:12+i/(curve.length-1)*576},${150-((v-minEq)/span)*130}`).join(' ');
  const money=v=>`${v<0?'-':''}$${Math.abs(v).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`;
  const bySymbol=Object.entries(closed.reduce((a,t)=>{const k=t.symbol||'Unknown';a[k]=(a[k]||0)+Number(t.pnl||0);return a;},{})).sort((a,b)=>b[1]-a[1]);
  const stat=(label,value,sub,cls='')=><div className="card"><div className="stat-label">{label}</div><div className={`stat-value ${cls}`}>{value}</div><div className="muted">{sub}</div></div>;
  return <>
    <div className="welcome"><div><h1>Performance Analytics</h1><div className="muted">Performance is calculated from closed trades saved in your local Trade Journal.</div></div><span className="demo-badge">● JOURNAL-BASED ANALYTICS</span></div>
    <div className="card"><div className="card-heading"><div><h3>Reporting period</h3><div className="muted">Change the period to filter all metrics below.</div></div><select value={period} onChange={e=>setPeriod(e.target.value)} style={{background:'#0b1728',color:'#fff',border:'1px solid #33445e',padding:9,borderRadius:6}}><option value="ALL">All time</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option><option value="365">Last 12 months</option></select></div></div>
    <div className="stats-grid">
      {stat('Net realised P/L',money(net),`${closed.length} closed trades`,net>=0?'positive':'negative')}
      {stat('Win rate',`${winRate.toFixed(1)}%`,`${wins.length} wins · ${losses.length} losses`)}
      {stat('Profit factor',pf===Infinity?'∞':pf.toFixed(2),'Gross profit ÷ gross loss')}
      {stat('Maximum drawdown',money(maxDD),'Peak-to-trough realised P/L',maxDD>0?'negative':'')}
      {stat('Trade expectancy',money(expectancy),'Average P/L per closed trade',expectancy>=0?'positive':'negative')}
      {stat('Average winner',money(avgWin),`${wins.length} winning trades`,'positive')}
      {stat('Average loser',money(-avgLoss),`${losses.length} losing trades`,'negative')}
      {stat('Best / worst trade',`${money(best)} / ${money(worst)}`,`${flats.length} breakeven trades`)}
    </div>
    <div className="dashboard-grid" style={{gridTemplateColumns:'minmax(0,1.5fr) minmax(250px,0.8fr)',marginTop:18}}>
      <div className="card"><div className="card-heading"><h3>Realised equity curve</h3><span className="muted">Cumulative journal P/L · USD</span></div>
        {closed.length<1?<div className="empty">No closed journal trades in this period. Add and close trades in Trade Journal to populate analytics.</div>:<svg viewBox="0 0 600 170" style={{width:'100%',height:190}}><line x1="10" x2="590" y1={150-(0-minEq)/span*130} y2={150-(0-minEq)/span*130} stroke="#52627a" strokeDasharray="5 4"/><polyline points={points} fill="none" stroke="#20d6a1" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round"/></svg>}
        <div className="muted" style={{fontSize:10}}>This curve uses realised P/L only; open positions and unrealised P/L are excluded.</div>
      </div>
      <div className="card"><div className="card-heading"><h3>Performance by instrument</h3></div>
        {bySymbol.length===0?<div className="empty">No instrument results yet.</div>:bySymbol.map(([symbol,pnl])=><div className="signal" key={symbol}><span>{symbol}</span><strong className={pnl>=0?'positive':'negative'}>{money(pnl)}</strong></div>)}
      </div>
    </div>
    <div className="card" style={{marginTop:18}}><div className="card-heading"><h3>Trade statistics</h3><span className="tag">PAPER / JOURNAL DATA</span></div>
      <div className="stats-grid" style={{gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))'}}>
        {stat('Closed trades',closed.length,'Selected period')}{stat('Gross profit',money(grossWin),'Winning trades only','positive')}{stat('Gross loss',money(-grossLoss),'Losing trades only','negative')}{stat('Average trades / outcome',`${wins.length}W · ${losses.length}L`,`${flats.length} breakeven`)}
      </div>
      <p className="muted" style={{fontSize:11,lineHeight:1.7,marginTop:12}}>Important: Trade Journal P/L is currently an illustrative price-difference × units estimate. It may not match broker statements because pip/tick values, contract sizes, quote-currency conversion, commissions, swaps, spread and slippage are not fully modelled. These analytics are for review, not a verified account statement or a prediction of future results.</p>
    </div>
  </>;
}

function SettingsPage() {
  const [settings,setSettings] = useState(()=>{try{return {...{timeframe:'5min',risk:'0.5',compact:false,notifications:true},...JSON.parse(localStorage.getItem('tradelab_user_settings')||'{}')};}catch{return {timeframe:'5min',risk:'0.5',compact:false,notifications:true};}});
  const [saved,setSaved] = useState(false);
  function update(key,value){setSettings(old=>({...old,[key]:value}));setSaved(false);}
  function save(){try{localStorage.setItem('tradelab_user_settings',JSON.stringify(settings));setSaved(true);}catch{setSaved(false);}}
  return <><div className="welcome"><div><h1>Settings</h1><div className="muted">Manage local TradeLab display and analysis preferences.</div></div><div className="demo-badge">● BROWSER SETTINGS</div></div>
    <div className="card"><div className="card-heading"><h3>General preferences</h3></div><div className="order-grid">
      <div className="field"><label>Default timeframe</label><select value={settings.timeframe} onChange={e=>update('timeframe',e.target.value)}><option value="1min">1 minute</option><option value="5min">5 minutes</option><option value="15min">15 minutes</option><option value="30min">30 minutes</option><option value="1h">1 hour</option><option value="4h">4 hours</option></select></div>
      <div className="field"><label>Default analysis risk (%)</label><input type="number" min="0.1" max="3" step="0.1" value={settings.risk} onChange={e=>update('risk',e.target.value)}/></div>
      <div className="field"><label>Notifications</label><select value={settings.notifications?'on':'off'} onChange={e=>update('notifications',e.target.value==='on')}><option value="on">Enabled</option><option value="off">Disabled</option></select></div>
      <div className="field"><label>Compact layout</label><select value={settings.compact?'on':'off'} onChange={e=>update('compact',e.target.value==='on')}><option value="off">Off</option><option value="on">On</option></select></div>
    </div><button className="execute-btn" onClick={save}>Save preferences</button>{saved&&<p className="muted" role="status">Settings saved in this browser.</p>}<p className="muted" style={{lineHeight:1.6}}>These preferences are stored locally in this browser. They do not change broker settings, account balances, execution permissions or server configuration.</p></div>
  </>;
}


function PortfolioRiskPage() {
  const [account, setAccount] = useState(() => {
    try { return { balance: 10000, equity: 10000, dailyLoss: 0, peakEquity: 10000, openRisk: 0, ...JSON.parse(localStorage.getItem('tradelab_portfolio_risk_v1') || '{}') }; }
    catch { return { balance: 10000, equity: 10000, dailyLoss: 0, peakEquity: 10000, openRisk: 0 }; }
  });
 const [riskPct, setRiskPct] = useState(() => Number(localStorage.getItem('tradelab_risk_pct_v1') ?? 1));
const [stopPips, setStopPips] = useState(() => Number(localStorage.getItem('tradelab_stop_pips_v1') ?? 30));
const [pipValue, setPipValue] = useState(() => Number(localStorage.getItem('tradelab_pip_value_v1') ?? 10));
const [dailyLimitPct, setDailyLimitPct] = useState(() => Number(localStorage.getItem('tradelab_daily_limit_v1') ?? 3));
const [drawdownLimitPct, setDrawdownLimitPct] = useState(() => Number(localStorage.getItem('tradelab_drawdown_limit_v1') ?? 10));
  const [positions, setPositions] = useState(() => {
    try { return JSON.parse(localStorage.getItem('tradelab_risk_positions_v1') || '[]'); } catch { return []; }
  });
  const [symbol, setSymbol] = useState('EURUSD');
  const [direction, setDirection] = useState('BUY');
  const [volume, setVolume] = useState('0.10');
  const [entry, setEntry] = useState('');
  const [stop, setStop] = useState('');
  const [target, setTarget] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => { localStorage.setItem('tradelab_portfolio_risk_v1', JSON.stringify(account)); }, [account]);
  useEffect(() => { localStorage.setItem('tradelab_risk_positions_v1', JSON.stringify(positions)); }, [positions]);

  const balance = Math.max(0, Number(account.balance) || 0);
  const equity = Math.max(0, Number(account.equity) || 0);
  const riskCash = balance * riskPct / 100;
  const calculatedLots = stopPips > 0 && pipValue > 0 ? riskCash / (stopPips * pipValue) : 0;
  const dailyLossCash = Math.max(0, Number(account.dailyLoss) || 0);
  const dailyLossPct = balance ? dailyLossCash / balance * 100 : 0;
  const drawdownPct = Number(account.peakEquity) > 0 ? Math.max(0, (Number(account.peakEquity) - equity) / Number(account.peakEquity) * 100) : 0;
  const openRiskCash = positions.reduce((sum, p) => sum + (Number(p.risk) || 0), 0) + (Number(account.openRisk) || 0);
  const dailyBreached = dailyLossPct >= dailyLimitPct;
  const drawdownBreached = drawdownPct >= drawdownLimitPct;
  const totalRiskPct = balance ? openRiskCash / balance * 100 : 0;
  const addPosition = () => {
    const e = Number(entry), sl = Number(stop), tp = Number(target), lots = Number(volume);
    if (!(e > 0 && sl > 0 && tp > 0 && lots > 0) || e === sl) { setNotice('Enter valid entry, stop-loss, take-profit and volume values.'); return; }
    const reward = Math.abs(tp - e), riskDistance = Math.abs(e - sl);
    if ((direction === 'BUY' && (sl >= e || tp <= e)) || (direction === 'SELL' && (sl <= e || tp >= e))) { setNotice('Check direction: stop-loss and take-profit are on the wrong side of entry.'); return; }
    const risk = riskDistance * lots * 100000;
    const rewardCash = reward * lots * 100000;
    const item = { id: Date.now(), symbol, direction, entry: e, stop: sl, target: tp, volume: lots, risk, reward: rewardCash, rr: rewardCash / risk };
    setPositions(prev => [...prev, item]); setNotice('Demo position added to portfolio risk monitor.');
    setEntry(''); setStop(''); setTarget('');
  };
  const card = { background:'#111c2d', border:'1px solid #26364d', borderRadius:14, padding:18 };
  const field = { width:'100%', background:'#0b1422', color:'#e8eef8', border:'1px solid #34445b', borderRadius:8, padding:'10px 11px', marginTop:6 };
  const label = { display:'block', color:'#9aabc0', fontSize:12, marginBottom:12 };
  const metric = (title, value, note, bad=false) => <div style={card}><div style={{color:'#9aabc0',fontSize:12}}>{title}</div><div style={{fontSize:25,fontWeight:750,margin:'9px 0',color:bad?'#ff7373':'#e8eef8'}}>{value}</div><div style={{fontSize:11,color:'#8b9bb0'}}>{note}</div></div>;
  return <div>
    <div className="welcome"><div><h1>Portfolio Risk Management</h1><div className="muted">Position sizing, account limits, drawdown and combined demo exposure.</div></div><div className="demo-badge">● DEMO RISK ENGINE</div></div>
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:13,marginBottom:18}}>
      {metric('Account balance',`$${balance.toFixed(2)}`,'Editable demo account')}
      {metric('Account equity',`$${equity.toFixed(2)}`,'Current simulated equity')}
      {metric('Daily loss',`${dailyLossPct.toFixed(2)}%`,`$${dailyLossCash.toFixed(2)} of ${dailyLimitPct}% limit`,dailyBreached)}
      {metric('Maximum drawdown',`${drawdownPct.toFixed(2)}%`,`Peak equity $${Number(account.peakEquity||0).toFixed(2)}`,drawdownBreached)}
      {metric('Open portfolio risk',`$${openRiskCash.toFixed(2)}`,`${totalRiskPct.toFixed(2)}% of balance`)}
    </div>
    {(dailyBreached || drawdownBreached) && <div style={{...card,borderColor:'#b94b4b',color:'#ff8585',marginBottom:16}}>Risk limit breached. Review exposure and stop opening new demo positions until the account is within limits.</div>}
    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(280px,1fr))',gap:16}}>
      <div style={card}>
        <h3 style={{marginTop:0}}>Account & risk limits</h3>
        <label style={label}>Account balance ($)<input style={field} type="number" min="0" value={account.balance} onChange={e=>setAccount(a=>({...a,balance:e.target.value}))}/></label>
        <label style={label}>Account equity ($)<input style={field} type="number" min="0" value={account.equity} onChange={e=>setAccount(a=>({...a,equity:e.target.value}))}/></label>
        <label style={label}>Peak equity ($)<input style={field} type="number" min="0" value={account.peakEquity} onChange={e=>setAccount(a=>({...a,peakEquity:e.target.value}))}/></label>
        <label style={label}>Today's realized loss ($)<input style={field} type="number" min="0" value={account.dailyLoss} onChange={e=>setAccount(a=>({...a,dailyLoss:e.target.value}))}/></label>
        <label style={label}>Daily loss limit (%)<input style={field} type="number" min="0.1" max="100" step="0.1" value={dailyLimitPct} onChange={e=>setDailyLimitPct(Math.max(0.1,Number(e.target.value)||0.1))}/></label>
        <label style={label}>Maximum drawdown limit (%)<input style={field} type="number" min="0.1" max="100" step="0.1" value={drawdownLimitPct} onChange={e=>setDrawdownLimitPct(Math.max(0.1,Number(e.target.value)||0.1))}/></label>
      </div>
      <div style={card}>
        <h3 style={{marginTop:0}}>Position sizing calculator</h3>
        <label style={label}>Risk per trade: {riskPct.toFixed(2)}%<input style={field} type="range" min="0.25" max="3" step="0.25" value={riskPct} onChange={e=>setRiskPct(Number(e.target.value))}/></label>
        <label style={label}>Stop-loss distance (pips)<input style={field} type="number" min="0.1" step="0.1" value={stopPips} onChange={e=>setStopPips(Number(e.target.value))}/></label>
        <label style={label}>Pip value per standard lot ($)<input style={field} type="number" min="0.01" step="0.01" value={pipValue} onChange={e=>setPipValue(Number(e.target.value))}/></label>
        <div style={{background:'#0b1422',padding:14,borderRadius:10,marginTop:8}}>
          <div style={{color:'#9aabc0',fontSize:12}}>Maximum planned loss</div><div style={{fontSize:24,fontWeight:750,margin:'5px 0'}}>${riskCash.toFixed(2)}</div>
          <div style={{color:'#20d6a1',fontSize:18,fontWeight:700}}>Suggested volume: {calculatedLots.toFixed(2)} lots</div>
          <small style={{color:'#8798ad'}}>Formula: risk cash ÷ (stop pips × pip value per lot). Confirm pip value for the instrument and account currency with your broker.</small>
        </div>
      </div>
      <div style={card}>
        <h3 style={{marginTop:0}}>Add demo position exposure</h3>
        <label style={label}>Instrument<select style={field} value={symbol} onChange={e=>setSymbol(e.target.value)}>{['EURUSD','GBPUSD','USDJPY','XAUUSD','US30','BTCUSD'].map(x=><option key={x}>{x}</option>)}</select></label>
        <label style={label}>Direction<select style={field} value={direction} onChange={e=>setDirection(e.target.value)}><option>BUY</option><option>SELL</option></select></label>
        <label style={label}>Entry price<input style={field} value={entry} onChange={e=>setEntry(e.target.value)} type="number" step="any"/></label>
        <label style={label}>Stop-loss price<input style={field} value={stop} onChange={e=>setStop(e.target.value)} type="number" step="any"/></label>
        <label style={label}>Take-profit price<input style={field} value={target} onChange={e=>setTarget(e.target.value)} type="number" step="any"/></label>
        <label style={label}>Volume (lots/contracts)<input style={field} value={volume} onChange={e=>setVolume(e.target.value)} type="number" min="0.01" step="0.01"/></label>
        <button className="execute-btn" onClick={addPosition}>Add demo exposure</button>
        {notice && <p className="muted">{notice}</p>}
        <small style={{color:'#8798ad'}}>Illustrative exposure estimate only. The simple contract multiplier is not suitable for every CFD, index, metal or crypto contract.</small>
      </div>
    </div>
    <div style={{...card,marginTop:16}}>
      <div className="card-heading"><h3>Open portfolio positions</h3><button className="period-btn" onClick={()=>{setPositions([]);setNotice('Demo exposure list cleared.');}}>Clear demo list</button></div>
      <div className="table-wrap"><table><thead><tr><th>Symbol</th><th>Side</th><th>Volume</th><th>Entry</th><th>Stop</th><th>Target</th><th>Risk est.</th><th>Reward est.</th><th>R:R</th><th></th></tr></thead><tbody>
      {positions.length===0?<tr><td colSpan="10" className="empty">No demo positions added yet.</td></tr>:positions.map(p=><tr key={p.id}><td>{p.symbol}</td><td>{p.direction}</td><td>{p.volume}</td><td>{p.entry}</td><td>{p.stop}</td><td>{p.target}</td><td>${p.risk.toFixed(2)}</td><td>${p.reward.toFixed(2)}</td><td>{p.rr.toFixed(2)}R</td><td><button className="period-btn" onClick={()=>setPositions(prev=>prev.filter(x=>x.id!==p.id))}>Remove</button></td></tr>)}
      </tbody></table></div>
    </div>
    <p className="muted" style={{marginTop:12}}>Risk calculations are local demo estimates, not broker margin calculations or financial advice. They do not block orders in the Trading Terminal yet. All account values and positions are stored in this browser only.</p>
  </div>;
}

function AdvancedAnalyticsPage() {
  const [entries, setEntries] = useState(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem('tradelab_trade_journal_v1') || '[]'
      );
      return Array.isArray(saved) ? saved : [];
    } catch {
      return [];
    }
  });

  const [period, setPeriod] = useState('ALL');

  useEffect(() => {
    const refresh = () => {
      try {
        const saved = JSON.parse(
          localStorage.getItem('tradelab_trade_journal_v1') || '[]'
        );
        setEntries(Array.isArray(saved) ? saved : []);
      } catch {}
    };

    window.addEventListener('storage', refresh);
    const timer = window.setInterval(refresh, 2000);

    return () => {
      window.removeEventListener('storage', refresh);
      window.clearInterval(timer);
    };
  }, []);

  const analytics = useMemo(() => {
    const closed = entries.filter(t =>
      String(t.status || '').toUpperCase().includes('CLOSED')
    );

    const open = entries.filter(t => {
      const status = String(t.status || '').toUpperCase();
      return status.includes('OPEN') || status === 'ACTIVE';
    });

    const filtered = period === 'ALL'
      ? closed
      : closed.filter(t => {
          const date = new Date(t.closedAt || t.time || t.date);
          const days = Number(period);
          return !Number.isNaN(date.getTime()) &&
            (Date.now() - date.getTime()) <= days * 86400000;
        });

    const wins = filtered.filter(t => Number(t.pnl) > 0);
    const losses = filtered.filter(t => Number(t.pnl) < 0);

    const netProfit = filtered.reduce(
      (sum, t) => sum + (Number(t.pnl) || 0), 0
    );

    const grossProfit = wins.reduce(
      (sum, t) => sum + Number(t.pnl), 0
    );

    const grossLoss = Math.abs(losses.reduce(
      (sum, t) => sum + Number(t.pnl), 0
    ));

    const winRate = filtered.length
      ? wins.length / filtered.length * 100
      : 0;

    const profitFactor = grossLoss
      ? grossProfit / grossLoss
      : grossProfit > 0 ? Infinity : 0;

    const currencyMap = {};

    open.forEach(t => {
      const symbol = String(t.symbol || '')
        .replace('/', '')
        .toUpperCase();

      if (symbol.length < 6) return;

      const base = symbol.slice(0, 3);
      const quote = symbol.slice(3, 6);
      const direction = String(t.direction || 'BUY').toUpperCase();

      const entry = Number(t.entry) || 0;

      let units = Number(t.units || t.volume || 0);

      if (!units && Number(t.lot) > 0) {
        units = Number(t.lot) * 100000;
      }

      if (!units) return;

      const sign = direction === 'SELL' ? -1 : 1;

      currencyMap[base] = (currencyMap[base] || 0) + sign * units;
      currencyMap[quote] = (currencyMap[quote] || 0) - sign * units * entry;
    });

    const exposures = Object.entries(currencyMap)
      .map(([currency, amount]) => ({
        currency,
        amount,
        gross: Math.abs(amount)
      }))
      .sort((a, b) => b.gross - a.gross);

    const totalExposure = exposures.reduce(
      (sum, item) => sum + item.gross, 0
    );

    const concentration = exposures.map(item => ({
      ...item,
      percentage: totalExposure
        ? item.gross / totalExposure * 100
        : 0
    }));

    const currencyPairs = [];

    for (let i = 0; i < open.length; i++) {
      for (let j = i + 1; j < open.length; j++) {
        const first = String(open[i].symbol || '').replace('/', '');
        const second = String(open[j].symbol || '').replace('/', '');

        const shared = [...new Set([
          first.slice(0, 3),
          first.slice(3, 6)
        ].filter(c => c && second.includes(c)))];

        if (shared.length) {
          currencyPairs.push({
            first: open[i].symbol,
            second: open[j].symbol,
            shared: shared.join(', ')
          });
        }
      }
    }

    return {
      open,
      closed: filtered,
      wins,
      losses,
      netProfit,
      grossProfit,
      grossLoss,
      winRate,
      profitFactor,
      exposures: concentration,
      totalExposure,
      currencyPairs
    };
  }, [entries, period]);

  const money = value =>
    `${value < 0 ? '-' : ''}$${Math.abs(value).toFixed(2)}`;

  const cardStyle = {
    background: '#121e31',
    border: '1px solid #26364e',
    borderRadius: 11,
    padding: 18,
    minWidth: 0
  };

  return <>
    <div className="welcome">
      <div>
        <h1>Advanced Trading Analytics</h1>
        <div className="muted">
          Portfolio exposure, currency concentration and performance analysis.
        </div>
      </div>
      <div className="demo-badge">● DEMO ANALYTICS</div>
    </div>

    <div className="stats-grid">
      <div className="card">
        <div className="stat-label">Open Positions</div>
        <div className="stat-value">{analytics.open.length}</div>
        <div className="muted">From Trade Journal</div>
      </div>

      <div className="card">
        <div className="stat-label">Closed Trades</div>
        <div className="stat-value">{analytics.closed.length}</div>
        <div className="muted">Selected period</div>
      </div>

      <div className="card">
        <div className="stat-label">Win Rate</div>
        <div className="stat-value">{analytics.winRate.toFixed(1)}%</div>
        <div className="muted">Winning closed trades</div>
      </div>

      <div className="card">
        <div className="stat-label">Net Profit / Loss</div>
        <div className={`stat-value ${analytics.netProfit >= 0 ? 'positive' : 'negative'}`}>
          {money(analytics.netProfit)}
        </div>
        <div className="muted">Recorded journal results</div>
      </div>
    </div>

    <div className="dashboard-grid">
      <div className="card">
        <div className="card-heading">
          <h3>Portfolio Performance</h3>
          <span className="tag">JOURNAL DATA</span>
        </div>

        <div className="field">
          <label>Performance period</label>
          <select value={period} onChange={e => setPeriod(e.target.value)}>
            <option value="ALL">All Time</option>
            <option value="7">Last 7 Days</option>
            <option value="30">Last 30 Days</option>
            <option value="90">Last 90 Days</option>
          </select>
        </div>

        <div className="signal">
          <span>Gross Profit</span>
          <strong className="positive">{money(analytics.grossProfit)}</strong>
        </div>

        <div className="signal">
          <span>Gross Loss</span>
          <strong className="negative">{money(analytics.grossLoss)}</strong>
        </div>

        <div className="signal">
          <span>Profit Factor</span>
          <strong>
            {Number.isFinite(analytics.profitFactor)
              ? analytics.profitFactor.toFixed(2)
              : '∞'}
          </strong>
        </div>

        <div className="signal">
          <span>Winning Trades</span>
          <strong>{analytics.wins.length}</strong>
        </div>

        <div className="signal">
          <span>Losing Trades</span>
          <strong>{analytics.losses.length}</strong>
        </div>
      </div>

      <div className="card">
        <div className="card-heading">
          <h3>Portfolio Exposure</h3>
          <span className="tag">OPEN TRADES</span>
        </div>

        <div className="signal">
          <span>Open positions</span>
          <strong>{analytics.open.length}</strong>
        </div>

        <div className="signal">
          <span>Currency exposure entries</span>
          <strong>{analytics.exposures.length}</strong>
        </div>

        <div className="signal">
          <span>Gross currency exposure</span>
          <strong>{money(analytics.totalExposure)}</strong>
        </div>

        <p className="muted" style={{lineHeight:1.7}}>
          Exposure is estimated from recorded trade units and entry prices.
          It is not broker-verified account exposure or margin.
        </p>
      </div>
    </div>

    <div className="card" style={{marginTop:18}}>
      <div className="card-heading">
        <h3>Currency Exposure Analysis</h3>
        <span className="tag">ESTIMATED</span>
      </div>

      {analytics.exposures.length === 0
        ? <div className="empty">
            No open journal positions with usable units and entry prices.
          </div>
        : <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Currency / Asset</th>
                  <th>Net Exposure</th>
                  <th>Gross Exposure</th>
                  <th>Concentration</th>
                </tr>
              </thead>
              <tbody>
                {analytics.exposures.map(item => (
                  <tr key={item.currency}>
                    <td>{item.currency}</td>
                    <td className={item.amount >= 0 ? 'positive' : 'negative'}>
                      {money(item.amount)}
                    </td>
                    <td>{money(item.gross)}</td>
                    <td>{item.percentage.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      }
    </div>

    <div className="card" style={{marginTop:18}}>
      <div className="card-heading">
        <h3>Risk Concentration Warnings</h3>
        <span className="tag">PORTFOLIO REVIEW</span>
      </div>

      {analytics.open.length === 0
        ? <div className="empty">
            No open positions available for concentration analysis.
          </div>
        : <>
            {analytics.exposures
              .filter(item => item.percentage >= 40)
              .map(item => (
                <div className="signal" key={item.currency}>
                  <span>{item.currency} concentration</span>
                  <strong className="negative">
                    Elevated · {item.percentage.toFixed(1)}%
                  </strong>
                </div>
              ))
            }

            {analytics.exposures.every(item => item.percentage < 40) &&
              <div className="signal">
                <span>Currency concentration</span>
                <strong className="positive">No elevated concentration detected</strong>
              </div>
            }
          </>
      }
    </div>

    <div className="card" style={{marginTop:18}}>
      <div className="card-heading">
        <h3>Shared-Currency Overlap</h3>
        <span className="tag">CORRELATION WATCH</span>
      </div>

      {analytics.currencyPairs.length === 0
        ? <div className="empty">
            No shared-currency overlap detected between open positions.
          </div>
        : <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Position 1</th>
                  <th>Position 2</th>
                  <th>Shared Currency</th>
                </tr>
              </thead>
              <tbody>
                {analytics.currencyPairs.map((item, index) => (
                  <tr key={index}>
                    <td>{item.first}</td>
                    <td>{item.second}</td>
                    <td>{item.shared}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
      }

      <p className="muted" style={{lineHeight:1.7}}>
        Shared-currency overlap is a concentration indicator, not a
        statistical correlation coefficient. Statistical correlation
        requires synchronized historical returns for multiple markets.
      </p>
    </div>

    <div className="card" style={{marginTop:18}}>
      <div className="card-heading">
        <h3>Open Position Summary</h3>
        <span className="muted">{analytics.open.length} positions</span>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Instrument</th>
              <th>Direction</th>
              <th>Entry</th>
              <th>Units</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {analytics.open.length === 0
              ? <tr>
                  <td colSpan="5" className="empty">
                    No open journal trades recorded.
                  </td>
                </tr>
              : analytics.open.map((trade, index) => (
                  <tr key={trade.id || index}>
                    <td>{trade.symbol}</td>
                    <td>{trade.direction}</td>
                    <td>{trade.entry || '—'}</td>
                    <td>{trade.units || trade.volume || trade.lot || '—'}</td>
                    <td><span className="tag">{trade.status}</span></td>
                  </tr>
                ))
            }
          </tbody>
        </table>
      </div>
    </div>

    <div className="card" style={{marginTop:18,borderColor:'#5b4520'}}>
      <p className="muted" style={{lineHeight:1.7,margin:0}}>
        Analytics are based on locally recorded Trade Journal information.
        Missing trade data can affect the calculations. These tools are
        analytical estimates and do not execute trades or replace broker
        risk controls.
      </p>
    </div>
  </>;
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
          <button className={`nav-item ${activePage === 'Account Overview' ? 'active' : ''}`} onClick={() => {setActivePage('Account Overview');setSidebarOpen(false);}}><Wallet size={17} />Account overview</button>
          <button className={`nav-item ${activePage === 'Security Centre' ? 'active' : ''}`} onClick={() => {setActivePage('Security Centre');setSidebarOpen(false);}}><LockKeyhole size={17} />Security</button>
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
          </> : activePage === 'Technical Indicators' ? <>
            <div className="welcome"><div><h1>All Technical Indicators</h1><div className="muted">EMA, RSI, MACD, Bollinger Bands, ATR, ADX and Stochastic studies.</div></div><div className="demo-badge">● INDICATORS · ANALYSIS ONLY</div></div>
            <div className="card"><div className="card-heading"><h3>{selectedMarket} · {period} candlestick chart</h3><span className="muted">{candles.length} candles</span></div><div className="chart-wrap"><CandlestickChart candles={candles} loading={candleLoading} error={candleError} symbol={selectedMarket}/></div></div>
            <IndicatorSuite candles={candles} symbol={selectedMarket}/>
          </> : activePage === 'AI Analysis' ? <>
            <div className="welcome"><div><h1>AI Market Analysis</h1><div className="muted">Multi-factor technical assessment for the selected market.</div></div><div className="demo-badge">● TRANSPARENT RULES ENGINE</div></div>
            <AIAnalysisPanel candles={candles} symbol={selectedMarket} timeframe={period}/>
            <div className="card" style={{marginTop:18}}><div className="card-heading"><h3>Analysis timeframe</h3><span className="muted">Current instrument: {selectedMarket}</span></div><div className="periods">{[['1min','1m'],['5min','5m'],['15min','15m'],['30min','30m'],['1h','1h'],['4h','4h']].map(([v,l])=><button key={v} className={`period-btn ${period===v?'active':''}`} onClick={()=>setPeriod(v)}>{l}</button>)}</div></div>
          </> : activePage === 'AI Assistant' ? <AIAssistant candles={candles} symbol={selectedMarket} timeframe={period}/> activePage === 'Advanced Analytics' ? <AdvancedAnalyticsPage/> : activePage === 'Performance Analytics' ? <PerformanceAnalyticsPage/> : activePage === 'Strategy Lab' ? <StrategyLab candles={candles} symbol={selectedMarket} timeframe={period} loading={candleLoading} error={candleError}/> : activePage === 'Risk Centre' ? <RiskCentre symbol={selectedMarket} marketPrice={currentMarket?.price}/> : activePage === 'Portfolio Risk' ? <PortfolioRiskPage/> : activePage === 'Trade Journal' ? <TradeJournal defaultSymbol={selectedMarket} marketPrice={currentMarket?.price}/> : activePage === 'Smart Scanner' ? <SmartScanner selectedMarket={selectedMarket} onSelectMarket={symbol => {setSelectedMarket(symbol);setActivePage('Market Analysis');}} timeframe={period} onTimeframeChange={setPeriod}/> : activePage === 'Trading Terminal' ? <TradingTerminalPage symbol={selectedMarket} price={currentMarket?.price} candles={candles}/> : activePage === 'Automation Centre' ? <AutomationCentrePage candles={candles} symbol={selectedMarket} timeframe={period}/> : activePage === 'Account Overview' ? <AccountOverviewPage trades={trades}/> : activePage === 'Security Centre' ? <SecurityCentrePage/> : activePage === 'Settings' ? <SettingsPage/> : <div className="card page-placeholder"><div><Sparkles size={35} color="#20d6a1"/><h2>{activePage}</h2>
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
