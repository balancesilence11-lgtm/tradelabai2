import React, { useEffect, useMemo, useRef, useState } from 'react';

const SYMBOL_MAP = {
  EURUSD: 'FX:EURUSD',
  GBPUSD: 'FX:GBPUSD',
  USDJPY: 'FX:USDJPY',
  USDCHF: 'FX:USDCHF',
  USDCAD: 'FX:USDCAD',
  AUDUSD: 'FX:AUDUSD',
  NZDUSD: 'FX:NZDUSD',
  EURGBP: 'FX:EURGBP',
  EURJPY: 'FX:EURJPY',
  GBPJPY: 'FX:GBPJPY',
  AUDJPY: 'FX:AUDJPY',
  EURAUD: 'FX:EURAUD',
  GBPAUD: 'FX:GBPAUD',
  XAUUSD: 'OANDA:XAUUSD',
  BTCUSD: 'BITSTAMP:BTCUSD',
  US30: 'TVC:DJI'
};

const INTERVAL_MAP = {
  '1min': '1',
  '5min': '5',
  '15min': '15',
  '30min': '30',
  '1h': '60',
  '4h': '240',
  '1day': 'D'
};

export default function TradingViewChart({ symbol = 'EURUSD', timeframe = '5min' }) {
  const hostRef = useRef(null);
  const [loadError, setLoadError] = useState(false);
  const tvSymbol = useMemo(() => SYMBOL_MAP[String(symbol || '').toUpperCase()] || null, [symbol]);
  const interval = INTERVAL_MAP[timeframe] || '5';

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !tvSymbol) return undefined;

    setLoadError(false);
    host.innerHTML = '';

    const container = document.createElement('div');
    container.className = 'tradingview-widget-container';
    container.style.width = '100%';
    container.style.height = '100%';

    const widget = document.createElement('div');
    widget.className = 'tradingview-widget-container__widget';
    widget.style.width = '100%';
    widget.style.height = 'calc(100% - 28px)';
    container.appendChild(widget);

    const copyright = document.createElement('div');
    copyright.className = 'tradingview-widget-copyright';
    copyright.style.cssText = 'font-size:11px;text-align:center;padding:5px;color:#94a3b8';
    const link = document.createElement('a');
    link.href = `https://www.tradingview.com/symbols/${encodeURIComponent(tvSymbol)}/`;
    link.target = '_blank';
    link.rel = 'noopener nofollow';
    link.textContent = `${tvSymbol} chart`;
    copyright.appendChild(link);
    const trademark = document.createElement('span');
    trademark.textContent = ' by TradingView';
    copyright.appendChild(trademark);
    container.appendChild(copyright);

    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
    script.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol,
      interval,
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      backgroundColor: '#0b1422',
      gridColor: 'rgba(148,163,184,0.10)',
      withdateranges: true,
      hide_side_toolbar: false,
      allow_symbol_change: true,
      save_image: true,
      hide_volume: false,
      calendar: false,
      details: true,
      hotlist: false,
      studies: ['MASimple@tv-basicstudies', 'RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
      support_host: 'https://www.tradingview.com'
    });
    script.onerror = () => setLoadError(true);
    container.appendChild(script);
    host.appendChild(container);

    return () => {
      host.innerHTML = '';
    };
  }, [tvSymbol, interval]);

  if (!tvSymbol) {
    return (
      <div style={{ minHeight: 120, display: 'grid', placeItems: 'center', padding: 20, color: '#f0bb65', textAlign: 'center' }}>
        TradingView does not provide a mapped public symbol for {symbol}. Use the native TradeLab / Deriv chart for this instrument. The TradingView chart remains available for supported forex, gold, Bitcoin and Dow symbols.
      </div>
    );
  }

  return (
    <div>
      {loadError && <div role="status" style={{ color: '#ff8997', padding: 10 }}>TradingView could not load. Check the network connection or browser content-blocking settings.</div>}
      <div ref={hostRef} style={{ width: '100%', height: 560, minHeight: 420, overflow: 'hidden' }} />
      <div style={{ color: '#91a3bc', fontSize: 11, lineHeight: 1.5, padding: '8px 2px 0' }}>
        TradingView market data and broker quotes may differ in provider, spread and timing. This chart is for analysis only; it does not place or route orders to Deriv or another broker.
      </div>
    </div>
  );
}
