import test from 'node:test';
import assert from 'node:assert/strict';
import { replayStrategy, calibrateConfidence } from '../src/strategy-replay.js';

function candles(n=180){return Array.from({length:n},(_,i)=>{const close=100+i*.12+Math.sin(i/5)*.25;return {time:i,open:close-.03,high:close+.12,low:close-.12,close};});}

test('replays strategy signals in chronological order and reports closed outcomes',()=>{
  const result=replayStrategy(candles(),{strategy:'ema',fast:8,slow:21},{minBars:60,horizon:5,stopLossPct:.5,takeProfitPct:.5});
  assert.ok(result.trades.length>0);
  assert.ok(result.trades.every(t=>t.index< t.exitIndex));
  assert.ok(result.trades.every(t=>['RESOLVED','UNRESOLVED','AMBIGUOUS'].includes(t.status)));
  assert.equal(result.metrics.signals,result.trades.length);
});

test('insufficient history returns a clear error',()=>{
  const result=replayStrategy(candles(20),{strategy:'ema'});
  assert.match(result.error,/At least 60/);
});

test('confidence calibration withholds rates until the minimum sample is met',()=>{
  const small=Array.from({length:20},(_,i)=>({status:'RESOLVED',outcome:i<10?'WIN':'LOSS',confidence:75}));
  const result=calibrateConfidence(small,{minSample:100});
  assert.equal(result.calibrated,false);
  assert.equal(result.bins.find(b=>b.range==='70-80%').winRate,null);
  const enough=calibrateConfidence(Array.from({length:120},(_,i)=>({status:'RESOLVED',outcome:i<72?'WIN':'LOSS',confidence:75})),{minSample:100});
  assert.equal(enough.calibrated,true);
  assert.equal(enough.overallWinRate,60);
  assert.equal(enough.bins.find(b=>b.range==='70-80%').winRate,60);
});

test('ambiguous same-candle stop and target touches are excluded from calibration',()=>{
  const trades=[{status:'AMBIGUOUS',outcome:null,confidence:80},{status:'RESOLVED',outcome:'WIN',confidence:80}];
  const result=calibrateConfidence(trades,{minSample:1});
  assert.equal(result.sampleSize,1);
});
