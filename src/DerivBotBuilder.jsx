import React, { useMemo, useState } from "react";

const BLUE = "#0866e9";
const INK = "#172b4d";
const MUTED = "#64748b";
const BORDER = "#e2e8f0";
const contracts = [
  { value: "DIGITMATCH", label: "Matches" },
  { value: "DIGITDIFF", label: "Differs" },
  { value: "DIGITOVER", label: "Over" },
  { value: "DIGITUNDER", label: "Under" },
  { value: "DIGITEVEN", label: "Even" },
  { value: "DIGITODD", label: "Odd" }
];
const baseCard = { background: "#fff", border: `1px solid ${BORDER}`, borderRadius: 14, padding: 16, boxShadow: "0 2px 10px rgba(15,23,42,.04)" };
const field = { width: "100%", boxSizing: "border-box", border: "1px solid #cbd5e1", borderRadius: 9, padding: "11px 12px", background: "#fff", color: INK, fontSize: 14 };

export default function DerivBotBuilder({
  connected, symbol, changeMarket, contractType, setContractType,
  duration, setDuration, durationUnit, setDurationUnit, stake, setStake,
  availableContracts = [], contractsLoading = false, marketOptions = [],
  onPrepareTrade, onExecuteTrade, proposal, orderLoading = false,
  proposalLoading = false, currency = "USD", selectedDigit = "5",
  onSelectedDigitChange, tick, digitAnalysis
}) {
  const [localError, setLocalError] = useState("");
  const supported = useMemo(() => new Set(availableContracts.map(x => String(x.contract_type || "").toUpperCase())), [availableContracts]);
  const hasContractList = availableContracts.length > 0;
  const quote = Number(tick?.quote);
  const quoteText = Number.isFinite(quote) ? quote.toFixed(Number.isInteger(Number(tick?.pip_size)) ? Number(tick.pip_size) : 2) : "—";
  const distribution = digitAnalysis?.distribution || [];
  const probabilities = Array.from({ length: 10 }, (_, digit) => {
    const found = distribution.find(item => Number(item.digit) === digit);
    return { digit, probability: Number(found?.probability || 0) };
  });
  const selectedContract = contracts.find(x => x.value === contractType)?.label || contractType;
  const needsDigit = ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER"].includes(contractType);
  const isDigitContract = contractType.startsWith("DIGIT");

  function prepare() {
    setLocalError("");
    const amount = Number(stake);
    const length = Number(duration);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10) return setLocalError("Stake must be greater than zero and no more than 10.");
    if (!Number.isInteger(length) || length < 1) return setLocalError("Enter a whole-number duration of at least 1.");
    const params = needsDigit ? { barrier: String(selectedDigit) } : {};
    onPrepareTrade?.(params);
  }

  return <section style={{ ...baseCard, padding: 18, color: INK, display: "grid", gap: 16 }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
      <div>
        <div style={{ color: BLUE, fontWeight: 800, fontSize: 11, letterSpacing: 1.1 }}>TRADELAB AI · DIGIT TRADING</div>
        <h2 style={{ margin: "4px 0 0", fontSize: 22, color: INK }}>Digit Contracts</h2>
        <div style={{ marginTop: 4, color: MUTED, fontSize: 12 }}>Live market feed · statistical digit analysis · demo execution</div>
      </div>
      <span style={{ padding: "7px 11px", borderRadius: 30, background: connected ? "#eaf8f0" : "#fff7e6", color: connected ? "#16834a" : "#9a6700", fontSize: 11, fontWeight: 800 }}>{connected ? "● DEMO CONNECTED" : "● NOT CONNECTED"}</span>
    </div>

    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(130px,.8fr)", gap: 12 }}>
      <label style={{ color: MUTED, fontSize: 12, fontWeight: 700 }}>MARKET
        <select value={symbol} onChange={e => changeMarket(e.target.value)} style={{ ...field, display: "block", marginTop: 6, fontWeight: 700 }}>
          {marketOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      </label>
      <div style={{ ...baseCard, padding: "9px 12px", background: "#f8fbff" }}>
        <div style={{ color: MUTED, fontSize: 11, fontWeight: 700 }}>LIVE PRICE</div>
        <div style={{ color: INK, fontSize: 22, fontWeight: 850, marginTop: 5, fontVariantNumeric: "tabular-nums" }}>{quoteText}</div>
        <div style={{ color: MUTED, fontSize: 10 }}>{tick?.epoch ? new Date(tick.epoch * 1000).toLocaleTimeString() : "Waiting for tick"}</div>
      </div>
    </div>

    <div>
      <div style={{ color: MUTED, fontSize: 11, fontWeight: 800, marginBottom: 8 }}>CONTRACT TYPE</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 7 }}>
        {contracts.map(item => {
          const active = contractType === item.value;
          const unavailable = hasContractList && !supported.has(item.value);
          return <button key={item.value} type="button" disabled={unavailable || contractsLoading || orderLoading} onClick={() => { setContractType(item.value); setLocalError(""); }} style={{ border: `1px solid ${active ? BLUE : BORDER}`, borderRadius: 9, padding: "10px 5px", background: active ? "#eaf2ff" : "#fff", color: unavailable ? "#aab4c2" : active ? BLUE : INK, fontWeight: 800, fontSize: 12, cursor: unavailable ? "not-allowed" : "pointer" }}>{item.label}</button>;
        })}
      </div>
      {contractsLoading && <small style={{ color: MUTED }}>Loading contracts available for this market…</small>}
    </div>

    <div style={{ ...baseCard, background: "#f8fbff", padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 12, color: INK, fontWeight: 800 }}>LAST-DIGIT DISTRIBUTION</div>
        <div style={{ fontSize: 10, color: MUTED }}>{digitAnalysis?.sampleSize || 0} observations</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(0,1fr))", gap: 7 }}>
        {probabilities.map(item => {
          const active = needsDigit && String(item.digit) === String(selectedDigit);
          const recommended = digitAnalysis?.ready && Number(item.digit) === Number(digitAnalysis.predictedDigit);
          return <button key={item.digit} type="button" onClick={() => onSelectedDigitChange?.(String(item.digit))} style={{ minWidth: 0, border: `1px solid ${active ? BLUE : recommended ? "#8bb7ff" : BORDER}`, borderRadius: 9, background: active ? BLUE : recommended ? "#eef5ff" : "#fff", color: active ? "#fff" : INK, padding: "9px 3px", cursor: "pointer" }}>
            <div style={{ fontSize: 18, lineHeight: 1.1, fontWeight: 850 }}>{item.digit}</div>
            <div style={{ fontSize: 10, marginTop: 5, color: active ? "#e8f1ff" : MUTED }}>{(item.probability * 100).toFixed(1)}%</div>
          </button>;
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginTop: 9, fontSize: 10, color: MUTED }}>
        <span>Blue = selected digit</span><span>Outlined = AI top-ranked digit</span>
      </div>
    </div>

    {needsDigit && <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "10px 12px" }}>
      <div><div style={{ fontSize: 12, fontWeight: 800 }}>TARGET DIGIT</div><div style={{ color: MUTED, fontSize: 11 }}>{contractType === "DIGITMATCH" ? "The final digit must match." : contractType === "DIGITDIFF" ? "The final digit must differ." : contractType === "DIGITOVER" ? "The final digit must be greater than the barrier." : "The final digit must be less than the barrier."}</div></div>
      <select value={selectedDigit} onChange={e => onSelectedDigitChange?.(e.target.value)} style={{ ...field, width: 82, fontSize: 19, fontWeight: 850, textAlign: "center" }}>{Array.from({ length: 10 }, (_, n) => <option key={n} value={String(n)}>{n}</option>)}</select>
    </div>}

    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 9 }}>
      <label style={{ fontSize: 11, color: MUTED, fontWeight: 700 }}>STAKE ({currency})<input type="number" min="0.35" max="10" step="0.01" value={stake} onChange={e => setStake(e.target.value)} style={{ ...field, display: "block", marginTop: 6 }} /></label>
      <label style={{ fontSize: 11, color: MUTED, fontWeight: 700 }}>DURATION<input type="number" min="1" step="1" value={duration} onChange={e => setDuration(e.target.value)} style={{ ...field, display: "block", marginTop: 6 }} /></label>
      <label style={{ fontSize: 11, color: MUTED, fontWeight: 700 }}>UNIT<select value={durationUnit} onChange={e => setDurationUnit(e.target.value)} style={{ ...field, display: "block", marginTop: 6 }}>{[["t", "Ticks"], ["s", "Seconds"], ["m", "Minutes"], ["h", "Hours"], ["d", "Days"]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
    </div>

    {localError && <div role="alert" style={{ color: "#b42318", background: "#fff1f0", border: "1px solid #ffd0cc", borderRadius: 8, padding: 10, fontSize: 12 }}>{localError}</div>}

    {proposal && <div style={{ border: "1px solid #b7d2ff", background: "#f3f8ff", borderRadius: 10, padding: 13, display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 9 }}>
      <div><div style={{ color: MUTED, fontSize: 10 }}>CONTRACT</div><strong>{selectedContract}</strong></div>
      <div><div style={{ color: MUTED, fontSize: 10 }}>QUOTE / ASK PRICE</div><strong>{Number(proposal.ask_price).toFixed(2)} {currency}</strong></div>
      <div><div style={{ color: MUTED, fontSize: 10 }}>POTENTIAL PAYOUT</div><strong>{Number(proposal.payout || 0).toFixed(2)} {currency}</strong></div>
      <div><div style={{ color: MUTED, fontSize: 10 }}>PROPOSAL STATUS</div><strong style={{ color: "#16834a" }}>Quote received</strong></div>
    </div>}

    <div style={{ display: "grid", gridTemplateColumns: proposal ? "1fr 1fr" : "1fr", gap: 9 }}>
      <button type="button" onClick={prepare} disabled={!connected || proposalLoading || orderLoading || contractsLoading} style={{ ...field, border: 0, background: BLUE, color: "#fff", fontWeight: 850, padding: 14, cursor: !connected ? "not-allowed" : "pointer", opacity: !connected ? .55 : 1 }}>{proposalLoading ? "Requesting quote…" : "Get Proposal"}</button>
      {proposal && <button type="button" onClick={onExecuteTrade} disabled={!connected || orderLoading || proposalLoading} style={{ ...field, border: 0, background: "#0756c9", color: "#fff", fontWeight: 850, padding: 14, cursor: "pointer" }}>{orderLoading ? "Placing demo order…" : `Buy ${Number(proposal.ask_price || stake).toFixed(2)} ${currency} (DEMO)`}</button>}
    </div>
    <div style={{ color: MUTED, fontSize: 10, lineHeight: 1.5 }}>AI probabilities are historical estimates, not guaranteed outcomes. Orders are restricted to demo accounts and a maximum stake of 10. A fresh quote is requested again when you confirm a purchase.</div>
  </section>;
}
