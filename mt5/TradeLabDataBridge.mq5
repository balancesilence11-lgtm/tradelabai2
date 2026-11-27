#property strict
#property version   "1.00"
#property description "TradeLab AI read-only MT5 market-data bridge. No order execution."

input string BridgeURL = "https://YOUR-WORKER.workers.dev/api/mt5/bridge/ingest";
input string BridgeToken = "PASTE_MT5_BRIDGE_TOKEN_HERE";
input string BrokerSymbol = "US30";
input int QuoteIntervalSeconds = 1;
input int HistoryBars = 250;
input int RequestTimeoutMs = 10000;

ENUM_TIMEFRAMES Frames[] = { PERIOD_M1, PERIOD_M5, PERIOD_M15, PERIOD_M30, PERIOD_H1, PERIOD_H4, PERIOD_D1 };
string FrameNames[] = { "1min", "5min", "15min", "30min", "1h", "4h", "1day" };
datetime LastSentBar[7];
datetime LastHistoryAttempt[7];
datetime LastBarRefresh[7];
bool HistorySent[7];

string EscapeJson(const string value)
{
   string out = value;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   return out;
}

bool PostJson(const string payload)
{
   if(StringLen(BridgeToken) < 32 || StringFind(BridgeURL, "https://") != 0)
   {
      Print("TradeLab bridge configuration invalid: use HTTPS and a strong bridge token.");
      return false;
   }
   char data[], result[];
   string resultHeaders;
   int copied = StringToCharArray(payload, data, 0, WHOLE_ARRAY, CP_UTF8);
   if(copied > 0) ArrayResize(data, copied - 1);
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + BridgeToken + "\r\n";
   ResetLastError();
   int status = WebRequest("POST", BridgeURL, headers, RequestTimeoutMs, data, result, resultHeaders);
   if(status < 200 || status >= 300)
   {
      PrintFormat("TradeLab bridge POST failed. HTTP=%d, terminal error=%d, response=%s", status, GetLastError(), CharArrayToString(result));
      return false;
   }
   return true;
}

bool SendQuote()
{
   MqlTick tick;
   if(!SymbolInfoTick(BrokerSymbol, tick) || tick.bid <= 0 || tick.ask <= 0) return false;
   double last = tick.last > 0 ? tick.last : (tick.bid + tick.ask) / 2.0;
   long timestampMs = (long)TimeGMT() * 1000;
   string payload = StringFormat(
      "{\"symbol\":\"US30\",\"brokerSymbol\":\"%s\",\"quote\":{\"bid\":%s,\"ask\":%s,\"last\":%s,\"timestampMs\":%I64d}}",
      EscapeJson(BrokerSymbol), DoubleToString(tick.bid, 8), DoubleToString(tick.ask, 8), DoubleToString(last, 8), timestampMs
   );
   return PostJson(payload);
}

bool SendLatestCandle(const int index)
{
   MqlRates latest[];
   ArraySetAsSeries(latest, true);
   if(CopyRates(BrokerSymbol, Frames[index], 0, 1, latest) != 1) return false;
   long brokerUtcOffsetSeconds = (long)(TimeTradeServer() - TimeGMT());
   long timeMs = ((long)latest[0].time - brokerUtcOffsetSeconds) * 1000;
   string payload = StringFormat(
      "{\"symbol\":\"US30\",\"brokerSymbol\":\"%s\",\"timeframe\":\"%s\",\"candles\":[{\"timeMs\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"tickVolume\":%I64d,\"spread\":%d,\"realVolume\":%I64d}]} ",
      EscapeJson(BrokerSymbol), FrameNames[index], timeMs,
      DoubleToString(latest[0].open, 8), DoubleToString(latest[0].high, 8), DoubleToString(latest[0].low, 8), DoubleToString(latest[0].close, 8),
      (long)latest[0].tick_volume, latest[0].spread, (long)latest[0].real_volume
   );
   return PostJson(payload);
}

bool SendTimeframeHistory(const int index)
{
   MqlRates rates[];
   ArraySetAsSeries(rates, true);
   int copied = CopyRates(BrokerSymbol, Frames[index], 0, MathMax(20, MathMin(HistoryBars, 500)), rates);
   if(copied <= 0)
   {
      PrintFormat("TradeLab bridge: no %s rates available yet. Error=%d", FrameNames[index], GetLastError());
      return false;
   }
   string payload = "{\"symbol\":\"US30\",\"brokerSymbol\":\"" + EscapeJson(BrokerSymbol) + "\",\"timeframe\":\"" + FrameNames[index] + "\",\"candles\":[";
   for(int i = copied - 1; i >= 0; i--)
   {
      if(i != copied - 1) payload += ",";
      long brokerUtcOffsetSeconds = (long)(TimeTradeServer() - TimeGMT());
      long timeMs = ((long)rates[i].time - brokerUtcOffsetSeconds) * 1000;
      payload += StringFormat(
         "{\"timeMs\":%I64d,\"open\":%s,\"high\":%s,\"low\":%s,\"close\":%s,\"tickVolume\":%I64d,\"spread\":%d,\"realVolume\":%I64d}",
         timeMs, DoubleToString(rates[i].open, 8), DoubleToString(rates[i].high, 8), DoubleToString(rates[i].low, 8), DoubleToString(rates[i].close, 8), rates[i].tick_volume, rates[i].spread, rates[i].real_volume
      );
   }
   payload += "]}";
   if(!PostJson(payload)) return false;
   LastSentBar[index] = rates[0].time;
   HistorySent[index] = true;
   PrintFormat("TradeLab bridge: uploaded %d %s candles for %s.", copied, FrameNames[index], BrokerSymbol);
   return true;
}

int OnInit()
{
   if(!SymbolSelect(BrokerSymbol, true))
   {
      Print("TradeLab bridge cannot select broker symbol: ", BrokerSymbol);
      return INIT_FAILED;
   }
   ArrayInitialize(LastSentBar, 0);
   ArrayInitialize(LastHistoryAttempt, 0);
   ArrayInitialize(LastBarRefresh, 0);
   ArrayInitialize(HistorySent, false);
   EventSetTimer(MathMax(1, QuoteIntervalSeconds));
   Print("TradeLab read-only bridge started for ", BrokerSymbol, ". Add the Worker HTTPS host to MT5 WebRequest allowed URLs.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
}

void OnTimer()
{
   SendQuote();
   for(int i = 0; i < ArraySize(Frames); i++)
   {
      if(!HistorySent[i])
      {
         if(TimeLocal() - LastHistoryAttempt[i] >= 30)
         {
            LastHistoryAttempt[i] = TimeLocal();
            SendTimeframeHistory(i);
         }
         continue;
      }
      MqlRates latest[];
      if(CopyRates(BrokerSymbol, Frames[i], 0, 1, latest) == 1)
      {
         if(latest[0].time > LastSentBar[i])
         {
            SendTimeframeHistory(i);
            LastBarRefresh[i] = TimeLocal();
         }
         else if(TimeLocal() - LastBarRefresh[i] >= 15)
         {
            if(SendLatestCandle(i)) LastBarRefresh[i] = TimeLocal();
         }
      }
   }
}
