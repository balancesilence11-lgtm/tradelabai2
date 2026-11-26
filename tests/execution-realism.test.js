import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionModel, simulateTradeExecution, splitWalkForward } from '../src/execution-realism.js';

test('walk-forward split keeps a chronological holdout and rejects short tests',()=>{
  const split=splitWalkForward(200,{trainFraction:.7,minimumTest:20});
  assert.equal(split.valid,true); assert.equal(split.splitIndex,140); assert.equal(split.testStart,140); assert.equal(split.testEnd,199);
  assert.equal(splitWalkForward(50,{minimumTest:20}).valid,false);
});

test('execution model clamps costs and defaults safely',()=>{
  assert.deepEqual(buildExecutionModel({spreadBps:500,commissionBps:-2,slippageBps:1}),{spreadBps:100,commissionBps:0,slippageBps:1});
});

test('BUY entry uses next open with adverse spread and slippage; target result includes commission',()=>{
  const candles=[{open:100,high:100,low:100,close:100},{open:101,high:103,low:100.5,close:102}];
  const r=simulateTradeExecution({side:'BUY',candles,entryIndex:1,stop:99,target:102,risk:2,execution:{spreadBps:2,slippageBps:1,commissionBps:1},horizon:1});
  assert.equal(r.status,'RESOLVED'); assert.equal(r.outcome,'WIN'); assert.ok(r.entryFill>101); assert.ok(r.netR<r.grossR);
});

test('stop gap fills at the worse opening price instead of the stop price',()=>{
  const candles=[{open:100,high:100,low:100,close:100},{open:100,high:101,low:99,close:100},{open:95,high:96,low:94,close:95}];
  const r=simulateTradeExecution({side:'BUY',candles,entryIndex:1,stop:98,target:104,risk:2,execution:{spreadBps:0,slippageBps:0,commissionBps:0},horizon:2});
  assert.equal(r.status,'RESOLVED'); assert.equal(r.outcome,'LOSS'); assert.equal(r.exitFill,95); assert.match(r.reason,/Gap through stop/);
});

test('same-candle stop and target touch remains ambiguous absent an opening gap',()=>{
  const candles=[{open:100,high:100,low:100,close:100},{open:100,high:105,low:95,close:101}];
  const r=simulateTradeExecution({side:'BUY',candles,entryIndex:1,stop:98,target:103,risk:2,execution:{},horizon:1});
  assert.equal(r.status,'AMBIGUOUS');
});

test('target exit applies adverse slippage as well as spread',()=>{
  const candles=[{open:100,high:100,low:100,close:100},{open:100,high:104,low:99,close:103}];
  const noSlip=simulateTradeExecution({side:'BUY',candles,entryIndex:1,stop:98,target:102,risk:2,execution:{spreadBps:0,slippageBps:0,commissionBps:0},horizon:1});
  const withSlip=simulateTradeExecution({side:'BUY',candles,entryIndex:1,stop:98,target:102,risk:2,execution:{spreadBps:0,slippageBps:5,commissionBps:0},horizon:1});
  assert.equal(noSlip.status,'RESOLVED'); assert.equal(withSlip.status,'RESOLVED');
  assert.ok(withSlip.exitFill < noSlip.exitFill);
});

test('rejects target levels on the wrong side of the executed entry',()=>{
  const candles=[{open:100,high:100,low:100,close:100},{open:100,high:101,low:99,close:100}];
  const r=simulateTradeExecution({side:'BUY',candles,entryIndex:1,stop:98,target:99,risk:2,execution:{},horizon:1});
  assert.equal(r.status,'INVALID');
});
