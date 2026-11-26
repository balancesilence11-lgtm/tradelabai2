import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPaperTradesCsv, buildPaperSummaryCsv } from '../src/paper-performance-export.js';

test('exports trade ledger with headers and realised R', () => {
  const csv = buildPaperTradesCsv([{id:7,symbol:'EURUSD',side:'BUY',volume:0.1,entry:1.1,exit:1.2,closedAt:'2026-11-20T10:00:00Z',realizedPnl:25,riskCash:50}]);
  assert.match(csv, /"Order ID","Instrument","Side"/);
  assert.match(csv, /"7","EURUSD","BUY"/);
  assert.match(csv, /"25","50","0.5"/);
});

test('quotes commas, quotes and line breaks safely', () => {
  const csv = buildPaperTradesCsv([{id:'a',symbol:'EUR,USD "test"\nnext'}]);
  assert.match(csv, /"EUR,USD ""test""\nnext"/);
});

test('neutralises spreadsheet formula injection in text values', () => {
  const csv = buildPaperTradesCsv([{id:1,symbol:'=HYPERLINK("bad")',side:'@SUM(A1:A2)'}]);
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /"'@SUM\(A1:A2\)"/);
});

test('does not alter negative numeric P/L values', () => {
  const csv = buildPaperTradesCsv([{id:1,realizedPnl:-12.5,riskCash:25}]);
  assert.match(csv, /"-12.5","25","-0.5"/);
});

test('exports filtered summary metrics and explicit paper-only scope', () => {
  const csv = buildPaperSummaryCsv({total:3,wins:2,losses:1,netPnl:10,profitFactor:2,averageR:0.5},{symbol:'EURUSD',from:'2026-11-01'});
  assert.match(csv, /"Scope","Browser-local paper trading only"/);
  assert.match(csv, /"Instrument filter","EURUSD"/);
  assert.match(csv, /"Net realised P\/L","10"/);
});

test('handles empty or malformed input', () => {
  assert.equal(buildPaperTradesCsv(null).split('\r\n')[0], '"Order ID","Instrument","Side","Volume","Entry","Exit","Closed At","Realised P/L","Initial Risk Cash","Realised R"');
  assert.match(buildPaperSummaryCsv(null), /"Closed orders","0"/);
});
