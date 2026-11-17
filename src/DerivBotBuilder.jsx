import React, { useState } from "react";

const styles = {
  card: {
    background: "#123e59",
    border: "1px solid #245875",
    borderRadius: 9,
    padding: 14,
    marginBottom: 20,
    color: "#ffffff"
  },
  heading: {
    fontWeight: 800,
    fontSize: 14,
    padding: "10px 12px",
    background: "#0d3048",
    borderRadius: 6,
    marginBottom: 12
  },
  label: {
    display: "block",
    fontSize: 12,
    color: "#d5e5f1",
    marginBottom: 7
  },
  select: {
    background: "#ffffff",
    color: "#182b3c",
    border: "1px solid #b8c6d2",
    borderRadius: 18,
    padding: "7px 12px",
    fontSize: 12,
    maxWidth: "100%"
  },
  input: {
    background: "#ffffff",
    color: "#182b3c",
    border: "1px solid #b8c6d2",
    borderRadius: 8,
    padding: "8px 10px",
    width: 90
  },
  row: {
    display: "flex",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 9,
    marginBottom: 15,
    fontSize: 12
  }
};

const marketGroups = {
  "Continuous Indices": [
    ["1HZ10V", "Volatility 10 (1s)"],
    ["1HZ15V", "Volatility 15 (1s)"],
    ["1HZ25V", "Volatility 25 (1s)"],
    ["1HZ30V", "Volatility 30 (1s)"],
    ["1HZ50V", "Volatility 50 (1s)"],
    ["1HZ75V", "Volatility 75 (1s)"],
    ["1HZ90V", "Volatility 90 (1s)"],
    ["1HZ100V", "Volatility 100 (1s)"],
    ["R_10", "Volatility 10"],
    ["R_25", "Volatility 25"],
    ["R_50", "Volatility 50"],
    ["R_75", "Volatility 75"],
    ["R_100", "Volatility 100"]
  ],
  Forex: [
    ["frxEURUSD", "EUR/USD"],
    ["frxGBPUSD", "GBP/USD"],
    ["frxUSDJPY", "USD/JPY"],
    ["frxUSDCHF", "USD/CHF"],
    ["frxUSDCAD", "USD/CAD"],
    ["frxAUDUSD", "AUD/USD"],
    ["frxNZDUSD", "NZD/USD"],
    ["frxEURGBP", "EUR/GBP"],
    ["frxEURJPY", "EUR/JPY"],
    ["frxGBPJPY", "GBP/JPY"]
  ]
};

export default function DerivBotBuilder({
  connected,
  symbol,
  changeMarket,
  contractType,
  setContractType,
  duration,
  setDuration,
  durationUnit,
  setDurationUnit,
  stake,
  setStake,
  onPrepareTrade,
  onExecuteTrade,
  proposal,
  orderLoading,
  proposalLoading,
  currency = "USD"
}) {
  const [marketType, setMarketType] = useState(
    symbol.startsWith("frx") ? "Forex" : "Derived"
  );

  const [marketGroup, setMarketGroup] = useState(
    symbol.startsWith("frx") ? "Forex" : "Continuous Indices"
  );

  const [quickMode, setQuickMode] = useState(false);
  const [purchaseCondition, setPurchaseCondition] = useState("Rise");
  const [restartOnError, setRestartOnError] = useState(false);
  const [restartLastTrade, setRestartLastTrade] = useState(true);
  const [runOnce, setRunOnce] = useState(false);

  const options = marketGroups[marketGroup] || [];

  const selectedMarket =
    options.find(item => item[0] === symbol) || options[0];

  function updateMarketType(value) {
    setMarketType(value);

    const group = value === "Derived"
      ? "Continuous Indices"
      : "Forex";

    setMarketGroup(group);

    const firstSymbol = marketGroups[group][0][0];
    changeMarket(firstSymbol);
  }

  function updateMarketGroup(value) {
    setMarketGroup(value);

    const firstSymbol = marketGroups[value][0][0];
    changeMarket(firstSymbol);
  }

  function applyQuickStrategy() {
    setQuickMode(true);
    setPurchaseCondition("Rise");
    setContractType("CALL");
    setDuration("1");
    setDurationUnit("t");
    setStake("1");
  }

  const button = {
    border: 0,
    borderRadius: 7,
    padding: "11px 18px",
    background: "#3979ed",
    color: "#fff",
    fontWeight: 800,
    cursor: "pointer"
  };

  return (
    <div style={{
      color: "#e7edf7",
      display: "grid",
      gap: 14
    }}>

      {/* BUILDER HEADER */}

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12
      }}>
        <div>
          <h2 style={{ margin: 0 }}>Bot Builder</h2>
          <p style={{
            color: "#91a3bc",
            fontSize: 12,
            marginTop: 5
          }}>
            Configure and prepare your Deriv trading strategy.
          </p>
        </div>

        <span style={{
          padding: "7px 12px",
          borderRadius: 20,
          background: connected ? "#103d32" : "#342b1b",
          color: connected ? "#35d6a2" : "#f0bb65",
          fontSize: 11,
          fontWeight: 800
        }}>
          {connected ? "DERIV CONNECTED" : "NOT CONNECTED"}
        </span>
      </div>

      {/* QUICK STRATEGY */}

      <div>
        <button
          style={button}
          onClick={applyQuickStrategy}
        >
          ⚡ Quick Strategy
        </button>

        {quickMode && (
          <span style={{
            marginLeft: 10,
            color: "#35d6a2",
            fontSize: 12
          }}>
            Quick settings applied. Review before preparing a trade.
          </span>
        )}
      </div>

      {/* 1. TRADE PARAMETERS */}

      <section style={styles.card}>
        <div style={styles.heading}>
          ▤ &nbsp; 1. Trade Parameters
        </div>

        <div style={styles.row}>
          <span>Market:</span>

          <select
            style={styles.select}
            value={marketType}
            disabled={!connected}
            onChange={e => updateMarketType(e.target.value)}
          >
            <option value="Derived">Derived</option>
            <option value="Forex">Forex</option>
          </select>

          <span>›</span>

          <select
            style={styles.select}
            value={marketGroup}
            disabled={!connected}
            onChange={e => updateMarketGroup(e.target.value)}
          >
            {Object.keys(marketGroups).map(group => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>

          <span>›</span>

          <select
            style={styles.select}
            value={symbol}
            disabled={!connected}
            onChange={e => changeMarket(e.target.value)}
          >
            {options.map(item => (
              <option key={item[0]} value={item[0]}>
                {item[1]}
              </option>
            ))}
          </select>
        </div>

        <div style={styles.row}>
          <span>Trade Type:</span>

          <select
            style={styles.select}
            value="Up/Down"
            disabled
          >
            <option>Up/Down</option>
          </select>

          <span>›</span>

          <select
            style={styles.select}
            value="Rise/Fall"
            disabled
          >
            <option>Rise/Fall</option>
          </select>
        </div>

        <div style={styles.row}>
          <span>Contract Type:</span>

          <select
            style={styles.select}
            value={contractType}
            disabled={!connected}
            onChange={e => setContractType(e.target.value)}
          >
            <option value="CALL">Rise</option>
            <option value="PUT">Fall</option>
          </select>
        </div>

        <div style={styles.row}>
          <span>Default Candle Interval:</span>

          <select
            style={styles.select}
            defaultValue="1"
          >
            <option value="1">1 minute</option>
            <option value="5">5 minutes</option>
            <option value="15">15 minutes</option>
            <option value="30">30 minutes</option>
            <option value="60">1 hour</option>
          </select>
          <small style={{ color: "#b8c8d8" }}>
            Analysis setting; does not change the live tick subscription.
          </small>
        </div>

        <div style={styles.row}>
          <label>
            <input
              type="checkbox"
              checked={restartOnError}
              onChange={e => setRestartOnError(e.target.checked)}
            />
            &nbsp; Restart buy/sell on error
          </label>
        </div>

        <div style={styles.row}>
          <label>
            <input
              type="checkbox"
              checked={restartLastTrade}
              onChange={e => setRestartLastTrade(e.target.checked)}
            />
            &nbsp; Restart last trade on error
          </label>
        </div>

        <div style={styles.heading}>
          Run once at start:
        </div>

        <label style={styles.row}>
          <input
            type="checkbox"
            checked={runOnce}
            onChange={e => setRunOnce(e.target.checked)}
          />
          Enable one-time start condition
        </label>

        <div style={styles.heading}>
          Trade Options:
        </div>

        <div style={styles.row}>
          <span>Duration:</span>

          <select
            style={styles.select}
            value={durationUnit}
            disabled={!connected}
            onChange={e => setDurationUnit(e.target.value)}
          >
            <option value="t">Ticks</option>
            <option value="s">Seconds</option>
            <option value="m">Minutes</option>
            <option value="h">Hours</option>
            <option value="d">Days</option>
          </select>

          <input
            style={styles.input}
            type="number"
            min="1"
            value={duration}
            disabled={!connected}
            onChange={e => setDuration(e.target.value)}
          />

          <span>Stake:</span>

          <input
            style={styles.input}
            type="number"
            min="0.35"
            max="10"
            step="0.01"
            value={stake}
            disabled={!connected}
            onChange={e => setStake(e.target.value)}
          />

          <span>{currency}</span>
        </div>
      </section>

      {/* 2. PURCHASE CONDITIONS */}

      <section style={styles.card}>
        <div style={styles.heading}>
          ♙ &nbsp; 2. Purchase Conditions
        </div>

        <div style={styles.row}>
          <span>Purchase:</span>

          <select
            style={styles.select}
            value={purchaseCondition}
            onChange={e => {
              const value = e.target.value;
              setPurchaseCondition(value);

              if (value === "Rise") setContractType("CALL");
              if (value === "Fall") setContractType("PUT");
            }}
          >
            <option value="Rise">Rise</option>
            <option value="Fall">Fall</option>
          </select>
        </div>

        <p style={{
          fontSize: 11,
          color: "#c1d3e1",
          marginBottom: 0
        }}>
          Digit Match strategy conditions will be added as a separate
          selectable strategy block after prediction validation.
        </p>
      </section>

      {/* 3. EXECUTION */}

      <section style={styles.card}>
        <div style={styles.heading}>
          ▶ &nbsp; 3. Strategy Execution
        </div>

        <div style={styles.row}>
          <span>Selected market:</span>
          <strong>{selectedMarket?.[1] || symbol}</strong>
        </div>

        <div style={styles.row}>
          <span>Direction:</span>
          <strong>
            {contractType === "CALL" ? "RISE" : "FALL"}
          </strong>
        </div>

        <div style={styles.row}>
          <span>Stake:</span>
          <strong>{stake} {currency}</strong>
        </div>

        <div style={styles.row}>
          <span>Duration:</span>
          <strong>{duration} {durationUnit}</strong>
        </div>

        <button
          style={{
            ...button,
            opacity: connected ? 1 : 0.5
          }}
          disabled={!connected || proposalLoading}
          onClick={onPrepareTrade}
        >
          {proposalLoading
            ? "Preparing proposal..."
            : "Prepare Demo Trade"}
        </button>

        {proposal && (
          <div style={{
            marginTop: 14,
            padding: 12,
            background: "#0b3047",
            borderRadius: 8
          }}>
            <strong>Proposal ready</strong>

            <p style={{ fontSize: 12 }}>
              Stake: {proposal.amount} {currency}
              <br />
              Potential payout: {proposal.payout} {currency}
            </p>

            <button
              style={{
                ...button,
                background: "#087d69"
              }}
              disabled={orderLoading}
              onClick={onExecuteTrade}
            >
              {orderLoading
                ? "Placing demo trade..."
                : "Confirm Demo Trade"}
            </button>
          </div>
        )}
      </section>

      {/* BOTTOM CONTROL BAR */}

      <div style={{
        position: "sticky",
        bottom: 0,
        zIndex: 5,
        background: "#0b1422",
        border: "1px solid #34445c",
        borderRadius: 12,
        padding: 12,
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap"
      }}>
        <button
          style={{
            ...button,
            minWidth: 125
          }}
          disabled={!connected || proposalLoading}
          onClick={onPrepareTrade}
        >
          ▶ &nbsp; RUN
        </button>

        <div>
          <strong style={{
            color: connected ? "#35d6a2" : "#f0bb65",
            fontSize: 13
          }}>
            {connected ? "Bot Builder Ready" : "Bot is not connected"}
          </strong>

          <div style={{
            color: "#91a3bc",
            fontSize: 10,
            marginTop: 4
          }}>
            RUN prepares a demo trade proposal. It does not start unattended automation.
          </div>
        </div>
      </div>

    </div>
  );
}
