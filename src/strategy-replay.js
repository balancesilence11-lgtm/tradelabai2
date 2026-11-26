import { buildExecutionModel, simulateTradeExecution } from './execution-realism.js';
// Phase 2.6: chronological strategy replay and empirical confidence calibration.
// A signal at bar i is formed only from bars <= i; outcome bars begin at i+1.
const mean = a => a.reduce((s,v)=>s+v,0)/a.length;
function ema(values, period) { const out=Array(values.length).fill(null); if(values.length<period)return out; let v=mean(values.slice(0,period)); out[period-1]=v; const k=2/(period+1); for(let i=period;i<values.length;i++){v=values[i]*k+v*(1-k);out[i]=v;} return out; }
function rsi(values, period=14) { const out=Array(values.length).fill(null); if(values.length<=period)return out; let gain=0,loss=0; for(let i=1;i<=period;i++){const d=values[i]-values[i-1];gain+=Math.max(0,d);loss+=Math.max(0,-d);} let ag=gain/period,al=loss/period; out[period]=al===0?100:100-100/(1+ag/al); for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(0,d))/period;al=(al*(period-1)+Math.max(0,-d))/period;out[i]=al===0?100:100-100/(1+ag/al);} return out; }
function macd(values, fast=12, slow=26, sig=9) { const f=ema(values,fast),s=ema(values,slow),line=values.map((_,i)=>f[i]!=null&&s[i]!=null?f[i]-s[i]:null); const compact=line.filter(Number.isFinite), sc=ema(compact,sig), signal=Array(values.length).fill(null); let j=0; line.forEach((v,i)=>{if(v!=null)signal[i]=sc[j++];}); return {line,signal}; }
function scoreStrength(side, raw, scale) { return Math.max(50,Math.min(95,50+Math.min(45,Math.abs(raw)/Math.max(scale,1e-12)*45))); }
export function replayStrategy(candles, config={}, options={}) {
  const clean=(Array.isArray(candles)?candles:[]).map((c,i)=>({open:Number(c.open),high:Number(c.high),low:Number(c.low),close:Number(c.close),time:c.time??c.timestamp??i})).filter(c=>[c.open,c.high,c.low,c.close].every(Number.isFinite)&&c.low<=c.high&&c.open>0&&c.close>0);
  const minBars=Math.max(2,Number(options.minBars??60));
  if(clean.length<minBars)return {error:`At least ${minBars} valid candles are required.`,trades:[],metrics:{signals:0,resolved:0,unresolved:0,ambiguous:0}};
  const closes=clean.map(c=>c.close), type=config.strategy||'ema';
  const fast=ema(closes,Math.max(2,Number(config.fast)||20)),slow=ema(closes,Math.max(3,Number(config.slow)||50));
  const rs=rsi(closes,Math.max(2,Number(config.rsiPeriod)||14));
  const m=macd(closes,Number(config.macdFast)||12,Number(config.macdSlow)||26,Number(config.macdSignal)||9);
  const period=Math.max(5,Number(config.bbPeriod)||20),dev=Math.max(.5,Number(config.bbDeviation)||2),lookback=Math.max(5,Number(config.lookback)||20);
  const stopPct=Math.max(.01,Number(options.stopLossPct??config.stopLossPct??1))/100;
  const targetPct=Math.max(.01,Number(options.takeProfitPct??config.takeProfitPct??2))/100;
  const horizon=Math.max(1,Math.min(100,Math.floor(Number(options.horizon??10))));
  const signalAt=i=>{
    const p=closes[i];
    if(type==='ema') { if(fast[i]==null||slow[i]==null)return {side:0,strength:0}; const d=(fast[i]-slow[i])/p; return {side:Math.sign(d),strength:scoreStrength(Math.sign(d),d,.001)}; }
    if(type==='rsi') { if(rs[i]==null)return {side:0,strength:0}; if(rs[i]<=Number(config.oversold??30))return {side:1,strength:scoreStrength(1,Number(config.oversold??30)-rs[i],20)}; if(rs[i]>=Number(config.overbought??70))return {side:-1,strength:scoreStrength(-1,rs[i]-Number(config.overbought??70),20)}; return {side:0,strength:0}; }
    if(type==='macd') { if(i<1||m.line[i]==null||m.signal[i]==null||m.line[i-1]==null||m.signal[i-1]==null)return {side:0,strength:0}; const prev=m.line[i-1]-m.signal[i-1],now=m.line[i]-m.signal[i]; const side=prev<=0&&now>0?1:prev>=0&&now<0?-1:0; return {side,strength:scoreStrength(side,now,Math.abs(p)*.001)}; }
    if(type==='bollinger') { if(i<period-1)return {side:0,strength:0}; const window=closes.slice(i-period+1,i+1),mid=mean(window),sd=Math.sqrt(mean(window.map(v=>(v-mid)**2))),z=sd?(p-mid)/sd:0; const side=z<=-dev?1:z>=dev?-1:0; return {side,strength:scoreStrength(side,Math.abs(z)-dev,2)}; }
    if(i<lookback)return {side:0,strength:0}; const prior=closes.slice(i-lookback,i),hi=Math.max(...prior),lo=Math.min(...prior); const side=p>hi?1:p<lo?-1:0; return {side,strength:scoreStrength(side,side>0?(p-hi)/p:(lo-p)/p,.002)};
  };
  const trades=[]; let priorSide=0;
  const startIndex=Math.max(0,Math.floor(Number(options.startIndex??0)));
  const endIndex=Math.min(clean.length-2,Math.floor(Number(options.endIndex??(clean.length-2))));
  const execution=buildExecutionModel({spreadBps:options.spreadBps??config.spreadBps,commissionBps:options.commissionBps??config.commissionBps,slippageBps:options.slippageBps??config.slippageBps});
  for(let i=0;i<=endIndex;i++){
    const s=signalAt(i); if(!s.side){priorSide=0;continue;} if(s.side===priorSide)continue; priorSide=s.side;
    if(i<startIndex) continue;
    const entryBar=i+1; const rawEntry=clean[entryBar].open;
    const entry=rawEntry; const stop=s.side===1?entry*(1-stopPct):entry*(1+stopPct),target=s.side===1?entry*(1+targetPct):entry*(1-targetPct);
    const executionResult=simulateTradeExecution({side:s.side===1?'BUY':'SELL',candles:clean,entryIndex:entryBar,stop,target,risk:Math.abs(entry-stop),execution,horizon});
    trades.push({index:i,time:clean[i].time,side:s.side===1?'BUY':'SELL',confidence:Number(s.strength.toFixed(1)),entrySignalClose:clean[i].close,entry,stop,target,...executionResult});
  }
  const resolved=trades.filter(t=>t.status==='RESOLVED'),wins=resolved.filter(t=>t.outcome==='WIN');
  const netValues=resolved.map(t=>t.netR); const grossProfit=netValues.filter(v=>v>0).reduce((a,b)=>a+b,0),grossLoss=Math.abs(netValues.filter(v=>v<0).reduce((a,b)=>a+b,0));
  const metrics={signals:trades.length,resolved:resolved.length,wins:wins.length,losses:resolved.length-wins.length,unresolved:trades.filter(t=>t.status==='UNRESOLVED').length,ambiguous:trades.filter(t=>t.status==='AMBIGUOUS').length,invalid:trades.filter(t=>t.status==='INVALID').length,winRate:resolved.length?Number((wins.length/resolved.length*100).toFixed(2)):null,netR:Number(netValues.reduce((a,b)=>a+b,0).toFixed(4)),expectancyR:resolved.length?Number((netValues.reduce((a,b)=>a+b,0)/resolved.length).toFixed(4)):null,profitFactor:grossLoss?Number((grossProfit/grossLoss).toFixed(4)):null,executionCosts:execution};
  return {trades,metrics,execution,methodology:'Strict chronological replay: signal formed at candle close; entry at the next candle open with adverse half-spread and slippage; exit spread/slippage and round-trip commission applied. Stop gaps fill at the worse opening price; target gaps use conservative target-price fills. Same-candle stop/target touches without an opening-gap resolution are marked ambiguous. Training/test ranges can be isolated with startIndex/endIndex.'};
}
export function calibrateConfidence(trades, options={}) {
  const minSample=Math.max(1,Math.floor(Number(options.minSample??100)));
  const resolved=(Array.isArray(trades)?trades:[]).filter(t=>t.status==='RESOLVED'&&Number.isFinite(Number(t.confidence))&&['WIN','LOSS'].includes(t.outcome));
  const bins=[50,60,70,80,90].map((floor,i)=>{const upper=floor+10,items=resolved.filter(t=>Number(t.confidence)>=floor&&(i===4?Number(t.confidence)<=100:Number(t.confidence)<upper));const wins=items.filter(t=>t.outcome==='WIN').length,eligible=items.length>=minSample;return {range:`${floor}-${i===4?100:upper}%`,count:items.length,winRate:eligible?Number((wins/items.length*100).toFixed(2)):null,eligible};});
  return {sampleSize:resolved.length,minimumSample:minSample,calibrated:resolved.length>=minSample,bins,overallWinRate:resolved.length?Number((resolved.filter(t=>t.outcome==='WIN').length/resolved.length*100).toFixed(2)):null,notice:resolved.length>=minSample?'Empirical historical frequency only; not a forecast or guaranteed probability. Validate on a separate out-of-sample period.':`Insufficient sample: ${resolved.length}/${minSample} resolved outcomes. No calibrated probability is published.`};
}
