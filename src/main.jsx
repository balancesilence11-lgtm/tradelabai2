  import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */
const CONFIG = {
  ema: { fast: 20, slow: 50 },
  rsi: { period: 14, overbought: 70, oversold: 30 },
  macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { period: 20, stdDev: 2 },
  levels: { swingLookback: 5, maxLevels: 3, mergePct: 0.005, window: 120 },
  totalCandles: 260,
  visibleCandles: 120,
};

const INDICATORS = [
  { name: "EMA", config: "20 and 50", purpose: "Trend direction" },
  { name: "RSI", config: "14", purpose: "Overbought/oversold conditions" },
  { name: "MACD", config: "12, 26, 9", purpose: "Momentum and trend changes" },
  { name: "Bollinger Bands", config: "20, 2", purpose: "Volatility and price extremes" },
  { name: "Support & Resistance", config: "Recent swing highs/lows", purpose: "Important price levels" },
];

/* ------------------------------------------------------------------ *
 * Sample data (replace generateCandles() with your real OHLC feed)
 * Each candle: { open, high, low, close }
 * ------------------------------------------------------------------ */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateCandles(n, seed = 11) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = 100;
  let drift = 0;
  for (let i = 0; i < n; i++) {
    if (i % 35 === 0) drift = (rnd() - 0.5) * 0.3;
    const open = price;
    const close = open + drift + (rnd() - 0.5) * 1.8;
    const high = Math.max(open, close) + rnd() * 0.8;
    const low = Math.min(open, close) - rnd() * 0.8;
    out.push({ open, high, low, close });
    price = close;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Indicator math
 * ------------------------------------------------------------------ */
function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const start = values.findIndex((v) => v != null);
  if (start < 0 || values.length - start < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = start; i < start + period; i++) sum += values[i];
  let prev = sum / period;
  out[start + period - 1] = prev;
  for (let i = start + period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  const calc = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  out[period] = calc();
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = calc();
  }
  return out;
}

function macd(closes, fast, slow, signalPeriod) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line = closes.map((_, i) => (f[i] != null && s[i] != null ? f[i] - s[i] : null));
  const signal = ema(line, signalPeriod);
  const hist = line.map((v, i) => (v != null && signal[i] != null ? v - signal[i] : null));
  return { line, signal, hist };
}

function bollinger(closes, period, mult) {
  const mid = new Array(closes.length).fill(null);
  const upper = [...mid];
  const lower = [...mid];
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j] - mean) ** 2;
    const sd = Math.sqrt(variance / period);
    mid[i] = mean;
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { mid, upper, lower };
}

function swingLevels(candles, { swingLookback: L, maxLevels, mergePct, window }) {
  const start = Math.max(L, candles.length - window);
  const end = candles.length - L;
  const highs = [];
  const lows = [];
  for (let i = start; i < end; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - L; j <= i + L; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) highs.push({ price: candles[i].high, index: i });
    if (isLow) lows.push({ price: candles[i].low, index: i });
  }
  const dedupe = (list) => {
    const kept = [];
    for (let k = list.length - 1; k >= 0; k--) {
      const item = list[k];
      if (!kept.some((o) => Math.abs(o.price - item.price) / item.price < mergePct)) kept.push(item);
      if (kept.length === maxLevels) break;
    }
    return kept;
  };
  return { highs: dedupe(highs), lows: dedupe(lows) };
}

/* ------------------------------------------------------------------ *
 * Readings (plain-language signals for the summary table)
 * ------------------------------------------------------------------ */
const fmt = (n, d = 2) => (n == null || Number.isNaN(n) ? "–" : n.toFixed(d));
const last = (arr) => arr[arr.length - 1];

function buildReadings(d) {
  const i = d.candles.length - 1;
  const close = d.candles[i].close;

  const fast = d.emaFast[i];
  const slow = d.emaSlow[i];
  const trend =
    fast == null || slow == null
      ? { text: "Not enough data", tone: "flat" }
      : fast > slow
      ? { text: `Uptrend: EMA 20 is above EMA 50 by ${fmt(fast - slow)}`, tone: "up" }
      : { text: `Downtrend: EMA 20 is below EMA 50 by ${fmt(slow - fast)}`, tone: "down" };

  const r = d.rsi[i];
  const rsiReading =
    r == null
      ? { text: "Not enough data", tone: "flat" }
      : r >= CONFIG.rsi.overbought
      ? { text: `${fmt(r, 1)}: overbought`, tone: "down" }
      : r <= CONFIG.rsi.oversold
      ? { text: `${fmt(r, 1)}: oversold`, tone: "up" }
      : { text: `${fmt(r, 1)}: neutral range`, tone: "flat" };

  const m = d.macd.line[i];
  const s = d.macd.signal[i];
  const h = d.macd.hist[i];
  let crossed = null;
  for (let k = i; k > i - 5 && k > 0; k--) {
    const a = d.macd.hist[k];
    const b = d.macd.hist[k - 1];
    if (a != null && b != null && Math.sign(a) !== Math.sign(b)) {
      crossed = a > 0 ? "bullish" : "bearish";
      break;
    }
  }
  const macdReading =
    m == null || s == null
      ? { text: "Not enough data", tone: "flat" }
      : {
          text: `MACD ${m > s ? "above" : "below"} signal${
            crossed ? `, ${crossed} crossover in the last 5 bars` : ""
          }; histogram ${h >= 0 ? "positive" : "negative"}`,
          tone: m > s ? "up" : "down",
        };

  const u = d.bb.upper[i];
  const l = d.bb.lower[i];
  const mid = d.bb.mid[i];
  let bbReading = { text: "Not enough data", tone: "flat" };
  if (u != null) {
    const pctB = (close - l) / (u - l);
    const width = ((u - l) / mid) * 100;
    bbReading =
      close > u
        ? { text: `Closed above the upper band (width ${fmt(width)}%)`, tone: "down" }
        : close < l
        ? { text: `Closed below the lower band (width ${fmt(width)}%)`, tone: "up" }
        : { text: `Inside the bands at ${fmt(pctB * 100, 0)}% of the range (width ${fmt(width)}%)`, tone: "flat" };
  }

  const above = d.levels.highs.filter((x) => x.price > close).sort((a, b) => a.price - b.price)[0];
  const below = d.levels.lows.filter((x) => x.price < close).sort((a, b) => b.price - a.price)[0];
  const srReading = {
    text: `Resistance ${above ? fmt(above.price) : "none above"} · Support ${below ? fmt(below.price) : "none below"}`,
    tone: "flat",
  };

  return {
    EMA: trend,
    RSI: rsiReading,
    MACD: macdReading,
    "Bollinger Bands": bbReading,
    "Support & Resistance": srReading,
  };
}

/* ------------------------------------------------------------------ *
 * Chart
 * ------------------------------------------------------------------ */
const W = 1000;
const PAD_L = 8;
const PAD_R = 58;
const GAP = 26;

const C = {
  up: "#1b8a68",
  down: "#c4432f",
  emaFast: "#2563d9",
  emaSlow: "#e08a00",
  band: "#7b5cc4",
  support: "#1b8a68",
  resistance: "#c4432f",
  grid: "#dde3ea",
  ink: "#1c2b3a",
  muted: "#6b7a8a",
};

function linePath(values, x, y) {
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    pen = true;
  });
  return d;
}

function Chart({ data, show, hover, setHover }) {
  const { candles, visible } = data;
  const start = candles.length - visible;
  const view = (arr) => arr.slice(start);
  const vc = candles.slice(start);
  const n = vc.length;
  const plotW = W - PAD_L - PAD_R;
  const step = plotW / n;
  const x = (i) => PAD_L + (i + 0.5) * step;

  // Panel layout
  const panels = [{ id: "price", h: 340 }];
  if (show.rsi) panels.push({ id: "rsi", h: 110 });
  if (show.macd) panels.push({ id: "macd", h: 130 });
  let cursor = 8;
  panels.forEach((p) => {
    p.top = cursor;
    cursor += p.h + GAP;
  });
  const H = cursor - GAP + 8;
  const panel = (id) => panels.find((p) => p.id === id);

  // Price scale
  const emaF = view(data.emaFast);
  const emaS = view(data.emaSlow);
  const bbU = view(data.bb.upper);
  const bbL = view(data.bb.lower);
  const bbM = view(data.bb.mid);
  let lo = Math.min(...vc.map((c) => c.low));
  let hi = Math.max(...vc.map((c) => c.high));
  if (show.bb) {
    bbU.forEach((v) => v != null && (hi = Math.max(hi, v)));
    bbL.forEach((v) => v != null && (lo = Math.min(lo, v)));
  }
  const padP = (hi - lo) * 0.05;
  lo -= padP;
  hi += padP;
  const pp = panel("price");
  const yP = (v) => pp.top + pp.h - ((v - lo) / (hi - lo)) * pp.h;
  const priceTicks = Array.from({ length: 6 }, (_, k) => lo + ((hi - lo) * k) / 5);

  const hoverIdx = hover == null ? n - 1 : hover;

  const onMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const xv = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.floor((xv - PAD_L) / step);
    setHover(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      role="img"
      aria-label="Price chart with indicators"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
      style={{ display: "block", touchAction: "pan-y" }}
    >
      {/* ---------- Price panel ---------- */}
      <rect x={PAD_L} y={pp.top} width={plotW} height={pp.h} fill="#fff" stroke={C.grid} />
      {priceTicks.map((t) => (
        <g key={t}>
          <line x1={PAD_L} x2={PAD_L + plotW} y1={yP(t)} y2={yP(t)} stroke={C.grid} strokeWidth="1" />
          <text x={PAD_L + plotW + 6} y={yP(t) + 4} fontSize="11" fill={C.muted}>
            {fmt(t)}
          </text>
        </g>
      ))}

      {show.bb && (
        <g>
          <path
            d={
              linePath(bbU, x, yP) +
              [...bbL]
                .map((v, i) => [v, i])
                .reverse()
                .filter(([v]) => v != null)
                .map(([v, i]) => `L${x(i).toFixed(1)},${yP(v).toFixed(1)}`)
                .join(" ") +
              " Z"
            }
            fill={C.band}
            fillOpacity="0.07"
            stroke="none"
          />
          <path d={linePath(bbU, x, yP)} fill="none" stroke={C.band} strokeWidth="1.2" />
          <path d={linePath(bbL, x, yP)} fill="none" stroke={C.band} strokeWidth="1.2" />
          <path d={linePath(bbM, x, yP)} fill="none" stroke={C.band} strokeWidth="1" strokeDasharray="3 3" />
        </g>
      )}

      {show.levels &&
        [
          ...data.levels.highs.map((l) => ({ ...l, kind: "resistance" })),
          ...data.levels.lows.map((l) => ({ ...l, kind: "support" })),
        ]
          .filter((l) => l.price >= lo && l.price <= hi)
          .map((l) => {
            const color = l.kind === "support" ? C.support : C.resistance;
            const x0 = l.index >= start ? x(l.index - start) : PAD_L;
            return (
              <g key={`${l.kind}-${l.index}`}>
                <line
                  x1={x0}
                  x2={PAD_L + plotW}
                  y1={yP(l.price)}
                  y2={yP(l.price)}
                  stroke={color}
                  strokeWidth="1.2"
                  strokeDasharray="6 4"
                />
                <text x={PAD_L + plotW - 4} y={yP(l.price) - 4} fontSize="10.5" fill={color} textAnchor="end">
                  {l.kind === "support" ? "Support" : "Resistance"} {fmt(l.price)}
                </text>
              </g>
            );
          })}

      {vc.map((c, i) => {
        const color = c.close >= c.open ? C.up : C.down;
        const bw = Math.max(1.5, step * 0.6);
        const top = yP(Math.max(c.open, c.close));
        const bot = yP(Math.min(c.open, c.close));
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={yP(c.high)} y2={yP(c.low)} stroke={color} strokeWidth="1" />
            <rect x={x(i) - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={color} />
          </g>
        );
      })}

      {show.ema && (
        <g>
          <path d={linePath(emaF, x, yP)} fill="none" stroke={C.emaFast} strokeWidth="1.8" />
          <path d={linePath(emaS, x, yP)} fill="none" stroke={C.emaSlow} strokeWidth="1.8" />
        </g>
      )}

      {/* ---------- RSI panel ---------- */}
      {show.rsi &&
        (() => {
          const p = panel("rsi");
          const y = (v) => p.top + p.h - (v / 100) * p.h;
          const vals = view(data.rsi);
          return (
            <g>
              <rect x={PAD_L} y={p.top} width={plotW} height={p.h} fill="#fff" stroke={C.grid} />
              <rect
                x={PAD_L}
                y={y(CONFIG.rsi.overbought)}
                width={plotW}
                height={y(CONFIG.rsi.oversold) - y(CONFIG.rsi.overbought)}
                fill={C.emaFast}
                fillOpacity="0.05"
              />
              {[CONFIG.rsi.oversold, 50, CONFIG.rsi.overbought].map((t) => (
                <g key={t}>
                  <line
                    x1={PAD_L}
                    x2={PAD_L + plotW}
                    y1={y(t)}
                    y2={y(t)}
                    stroke={t === 50 ? C.grid : C.muted}
                    strokeDasharray={t === 50 ? "0" : "4 4"}
                    strokeWidth="1"
                  />
                  <text x={PAD_L + plotW + 6} y={y(t) + 4} fontSize="11" fill={C.muted}>
                    {t}
                  </text>
                </g>
              ))}
              <path d={linePath(vals, x, y)} fill="none" stroke={C.ink} strokeWidth="1.6" />
              <text x={PAD_L + 6} y={p.top + 14} fontSize="11.5" fill={C.ink} fontWeight="600">
                RSI {CONFIG.rsi.period}
              </text>
            </g>
          );
        })()}

      {/* ---------- MACD panel ---------- */}
      {show.macd &&
        (() => {
          const p = panel("macd");
          const ml = view(data.macd.line);
          const ms = view(data.macd.signal);
          const mh = view(data.macd.hist);
          const maxAbs =
            Math.max(...[...ml, ...ms, ...mh].filter((v) => v != null).map((v) => Math.abs(v)), 0.01) * 1.1;
          const y = (v) => p.top + p.h / 2 - (v / maxAbs) * (p.h / 2);
          return (
            <g>
              <rect x={PAD_L} y={p.top} width={plotW} height={p.h} fill="#fff" stroke={C.grid} />
              <line x1={PAD_L} x2={PAD_L + plotW} y1={y(0)} y2={y(0)} stroke={C.muted} strokeWidth="1" />
              {mh.map((v, i) =>
                v == null ? null : (
                  <rect
                    key={i}
                    x={x(i) - Math.max(1, step * 0.55) / 2}
                    y={Math.min(y(0), y(v))}
                    width={Math.max(1, step * 0.55)}
                    height={Math.abs(y(v) - y(0))}
                    fill={v >= 0 ? C.up : C.down}
                    fillOpacity="0.45"
                  />
                )
              )}
              <path d={linePath(ml, x, y)} fill="none" stroke={C.emaFast} strokeWidth="1.6" />
              <path d={linePath(ms, x, y)} fill="none" stroke={C.emaSlow} strokeWidth="1.6" />
              <text x={PAD_L + 6} y={p.top + 14} fontSize="11.5" fill={C.ink} fontWeight="600">
                MACD {CONFIG.macd.fast}, {CONFIG.macd.slow}, {CONFIG.macd.signal}
              </text>
              <text x={PAD_L + plotW + 6} y={y(0) + 4} fontSize="11" fill={C.muted}>
                0
              </text>
            </g>
          );
        })()}

      {/* ---------- Crosshair ---------- */}
      {hover != null && (
        <line
          x1={x(hoverIdx)}
          x2={x(hoverIdx)}
          y1={panels[0].top}
          y2={H - 8}
          stroke={C.ink}
          strokeOpacity="0.35"
          strokeDasharray="2 3"
        />
      )}
    </svg>
  );
}

/* ------------------------------------------------------------------ *
 * App
 * ------------------------------------------------------------------ */
const STYLES = `
  :root {
    --bg: #eef2f6; --surface: #ffffff; --ink: #1c2b3a; --muted: #6b7a8a;
    --line: #dde3ea; --up: #1b8a68; --down: #c4432f; --accent: #2563d9;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #121a23; --surface: #1a2430; --ink: #e6edf4; --muted: #92a2b3; --line: #2b3745; --accent: #6ea0ff; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font-family: "IBM Plex Sans", "Segoe UI", system-ui, -apple-system, sans-serif; line-height: 1.5; }
  .wrap { max-width: 1080px; margin: 0 auto; padding: 20px 16px 48px; }
  h1 { font-size: 1.35rem; margin: 0 0 4px; font-weight: 600; }
  .sub { color: var(--muted); margin: 0 0 16px; font-size: .92rem; }
  .toggles { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
  .toggle { border: 1px solid var(--line); background: var(--surface); color: var(--ink);
    padding: 6px 12px; border-radius: 6px; font: inherit; font-size: .88rem; cursor: pointer; }
  .toggle[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .toggle:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .readout { display: flex; flex-wrap: wrap; gap: 4px 18px; font-size: .86rem; margin-bottom: 8px;
    font-variant-numeric: tabular-nums; min-height: 2.8em; }
  .readout b { font-weight: 600; }
  .panel { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px; overflow-x: auto; }
  .chartbox { min-width: 640px; }
  table { width: 100%; border-collapse: collapse; margin-top: 20px; background: var(--surface);
    border: 1px solid var(--line); border-radius: 8px; overflow: hidden; font-size: .9rem; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-weight: 600; color: var(--muted); font-size: .84rem; }
  tr:last-child td { border-bottom: 0; }
  .tone { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: var(--muted); }
  .tone.up { background: var(--up); } .tone.down { background: var(--down); }
  .note { color: var(--muted); font-size: .8rem; margin-top: 14px; }
  .table-scroll { overflow-x: auto; }
`;

function App() {
  const [show, setShow] = useState({ ema: true, bb: true, levels: true, rsi: true, macd: true });
  const [hover, setHover] = useState(null);

  const data = useMemo(() => {
    const candles = generateCandles(CONFIG.totalCandles);
    const closes = candles.map((c) => c.close);
    const d = {
      candles,
      visible: CONFIG.visibleCandles,
      emaFast: ema(closes, CONFIG.ema.fast),
      emaSlow: ema(closes, CONFIG.ema.slow),
      rsi: rsi(closes, CONFIG.rsi.period),
      macd: macd(closes, CONFIG.macd.fast, CONFIG.macd.slow, CONFIG.macd.signal),
      bb: bollinger(closes, CONFIG.bollinger.period, CONFIG.bollinger.stdDev),
      levels: swingLevels(candles, CONFIG.levels),
    };
    d.readings = buildReadings(d);
    return d;
  }, []);

  const toggles = [
    ["ema", "EMA 20 / 50"],
    ["bb", "Bollinger Bands"],
    ["levels", "Support & Resistance"],
    ["rsi", "RSI"],
    ["macd", "MACD"],
  ];

  const start = data.candles.length - data.visible;
  const idx = start + (hover == null ? data.visible - 1 : hover);
  const c = data.candles[idx];

  return (
    <>
      <style>{STYLES}</style>
      <div className="wrap">
        <h1>Indicator dashboard</h1>
        <p className="sub">Sample data. Hover the chart to read values for any candle.</p>

        <div className="toggles" role="group" aria-label="Show or hide indicators">
          {toggles.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="toggle"
              aria-pressed={show[key]}
              onClick={() => setShow((s) => ({ ...s, [key]: !s[key] }))}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="readout" aria-live="off">
          <span>O <b>{fmt(c.open)}</b></span>
          <span>H <b>{fmt(c.high)}</b></span>
          <span>L <b>{fmt(c.low)}</b></span>
          <span>C <b>{fmt(c.close)}</b></span>
          {show.ema && (
            <>
              <span style={{ color: C.emaFast }}>EMA 20 <b>{fmt(data.emaFast[idx])}</b></span>
              <span style={{ color: C.emaSlow }}>EMA 50 <b>{fmt(data.emaSlow[idx])}</b></span>
            </>
          )}
          {show.rsi && <span>RSI <b>{fmt(data.rsi[idx], 1)}</b></span>}
          {show.macd && (
            <span>
              MACD <b>{fmt(data.macd.line[idx], 3)}</b> Signal <b>{fmt(data.macd.signal[idx], 3)}</b> Hist{" "}
              <b>{fmt(data.macd.hist[idx], 3)}</b>
            </span>
          )}
          {show.bb && (
            <span style={{ color: C.band }}>
              BB <b>{fmt(data.bb.lower[idx])}</b> – <b>{fmt(data.bb.upper[idx])}</b>
            </span>
          )}
        </div>

        <div className="panel">
          <div className="chartbox">
            <Chart data={data} show={show} hover={hover} setHover={setHover} />
          </div>
        </div>

        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Indicator</th>
                <th>Configuration</th>
                <th>Purpose</th>
                <th>Latest reading</th>
              </tr>
            </thead>
            <tbody>
              {INDICATORS.map((row) => {
                const r = data.readings[row.name];
                return (
                  <tr key={row.name}>
                    <td>{row.name}</td>
                    <td>{row.config}</td>
                    <td>{row.purpose}</td>
                    <td>
                      <span className={`tone ${r.tone}`} />
                      {r.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="note">
          Readings describe where each indicator stands now. They are not trade signals on their own.
        </p>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
