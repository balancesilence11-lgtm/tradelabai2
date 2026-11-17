import React, { useMemo, useState } from "react";

/*
 * TradeLab AI — Deriv Bot Builder
 * Replace: src/DerivBotBuilder.jsx
 *
 * Contract choices are populated ONLY from Deriv contracts_for data supplied
 * through availableContracts. This component does not invent market options.
 * Execution remains proposal-first and requires a separate user confirmation.
 */

const GROUPS = [
  {
    id: "all",
    label: "All available"
  },
  {
    id: "direction",
    label: "Up / Down",
    types: ["CALL", "PUT"]
  },
  {
    id: "digits",
    label: "Digits",
    types: ["DIGITMATCH", "DIGITDIFF", "DIGITOVER", "DIGITUNDER"]
  },
  {
    id: "evenodd",
    label: "Even / Odd",
    types: ["DIGITEVEN", "DIGITODD"]
  },
  {
    id: "touch",
    label: "Touch",
    types: ["ONETOUCH", "NOTOUCH"]
  },
  {
    id: "higherlower",
    label: "Higher / Lower",
    types: ["HIGHER", "LOWER"]
  },
  {
    id: "range",
    label: "Range",
    types: ["RANGE", "EXPIRYRANGE"]
  }
];

const CONTRACT_LABELS = {
  CALL: "Rise",
  PUT: "Fall",
  DIGITMATCH: "Matches",
  DIGITDIFF: "Differs",
  DIGITOVER: "Over",
  DIGITUNDER: "Under",
  DIGITEVEN: "Even",
  DIGITODD: "Odd",
  ONETOUCH: "Touches",
  NOTOUCH: "Does Not Touch",
  HIGHER: "Higher",
  LOWER: "Lower",
  RANGE: "Stays Between",
  EXPIRYRANGE: "Ends Between"
};

const DIGIT_TYPES = new Set([
  "DIGITMATCH",
  "DIGITDIFF",
  "DIGITOVER",
  "DIGITUNDER"
]);

const PRICE_BARRIER_TYPES = new Set([
  "ONETOUCH",
  "NOTOUCH",
  "HIGHER",
  "LOWER"
]);

const RANGE_TYPES = new Set(["RANGE", "EXPIRYRANGE"]);

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "#0b1422",
  color: "#e7edf7",
  border: "1px solid #34445c",
  borderRadius: 8,
  padding: "11px 12px",
  outline: "none"
};

const labelStyle = {
  display: "block",
  color: "#aebbd0",
  fontSize: 12,
  marginBottom: 7
};

const buttonStyle = {
  border: 0,
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 700,
  cursor: "pointer"
};

function normalizeContracts(items) {
  if (!Array.isArray(items)) return [];

  const seen = new Set();

  return items
    .filter(item => item && typeof item.contract_type === "string")
    .map(item => ({
      ...item,
      contract_type: item.contract_type.toUpperCase()
    }))
    .filter(item => {
      if (seen.has(item.contract_type)) return false;
      seen.add(item.contract_type);
      return true;
    });
}

function getContractLabel(type) {
  return CONTRACT_LABELS[type] || type.replaceAll("_", " ");
}

export default function DerivBotBuilder({
  connected = false,
  symbol = "",
  changeMarket = () => {},
  contractType = "CALL",
  setContractType = () => {},
  duration = "5",
  setDuration = () => {},
  durationUnit = "m",
  setDurationUnit = () => {},
  stake = "1",
  setStake = () => {},
  availableContracts = [],
  contractsLoading = false,
  onPrepareTrade = () => {},
  onExecuteTrade = () => {},
  proposal = null,
  orderLoading = false,
  proposalLoading = false,
  currency = "USD",
  selectedDigit = "5",
  onSelectedDigitChange = () => {},
  marketOptions = [],
  error = "",
  notice = ""
}) {
  const [group, setGroup] = useState("digits");
  const [barrier, setBarrier] = useState(String(selectedDigit));

  useEffect(() => {
    if (DIGIT_TYPES.has(String(contractType || "").toUpperCase())) {
      setBarrier(String(selectedDigit));
    }
  }, [selectedDigit, contractType]);
  const [barrier2, setBarrier2] = useState("");
  const [localError, setLocalError] = useState("");

  const contracts = useMemo(
    () => normalizeContracts(availableContracts),
    [availableContracts]
  );

  const activeContract = contracts.find(
    item => item.contract_type === String(contractType).toUpperCase()
  );

  const selectedGroup = GROUPS.find(item => item.id === group);

  const filteredContracts = useMemo(() => {
    if (!selectedGroup || !selectedGroup.types) return contracts;
    return contracts.filter(item =>
      selectedGroup.types.includes(item.contract_type)
    );
  }, [contracts, selectedGroup]);

  const type = String(contractType || "").toUpperCase();
  const needsDigit = DIGIT_TYPES.has(type);
  const needsPriceBarrier = PRICE_BARRIER_TYPES.has(type);
  const needsRange = RANGE_TYPES.has(type);
  const needsBarrier = needsDigit || needsPriceBarrier || needsRange;

  function handleGroupChange(nextGroup) {
    setGroup(nextGroup);
    setLocalError("");

    const groupDefinition = GROUPS.find(item => item.id === nextGroup);
    if (!groupDefinition || !groupDefinition.types) return;

    const firstAvailable = contracts.find(item =>
      groupDefinition.types.includes(item.contract_type)
    );

    if (firstAvailable) setContractType(firstAvailable.contract_type);
  }

  function handleContractChange(nextType) {
    setContractType(nextType);
    setLocalError("");
  }

  function prepareProposal() {
    setLocalError("");

    if (!connected) {
      setLocalError("Connect your Deriv demo account first.");
      return;
    }

    if (!activeContract) {
      setLocalError("Select a contract type currently offered for this market.");
      return;
    }

    const amount = Number(stake);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 10) {
      setLocalError("Demo stake must be greater than zero and no more than 10.");
      return;
    }

    const requestOptions = {};

    if (needsDigit) {
      const digit = Number(selectedDigit);
      if (!Number.isInteger(digit) || digit < 0 || digit > 9) {
        setLocalError("Enter a digit barrier from 0 to 9.");
        return;
      }
      requestOptions.barrier = String(digit);
    } else if (needsPriceBarrier) {
      const priceBarrier = Number(barrier);
      if (!Number.isFinite(priceBarrier) || barrier.trim() === "") {
        setLocalError("Enter a valid numeric price barrier.");
        return;
      }
      requestOptions.barrier = String(priceBarrier);
    } else if (needsRange) {
      const lower = Number(barrier);
      const upper = Number(barrier2);

      if (
        barrier.trim() === "" ||
        barrier2.trim() === "" ||
        !Number.isFinite(lower) ||
        !Number.isFinite(upper) ||
        lower >= upper
      ) {
        setLocalError("Enter two valid price barriers; the lower barrier must be below the upper barrier.");
        return;
      }

      requestOptions.barrier = String(lower);
      requestOptions.barrier2 = String(upper);
    }

    onPrepareTrade(requestOptions);
  }

  const canPrepare =
    connected &&
    !contractsLoading &&
    !proposalLoading &&
    Boolean(activeContract);

  return (
    <section
      style={{
        background: "#111c2d",
        border: "1px solid #26364d",
        borderRadius: 14,
        padding: 18,
        color: "#e7edf7",
        display: "grid",
        gap: 16
      }}
    >
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10
      }}>
        <div>
          <h3 style={{ margin: 0 }}>Deriv Bot Builder</h3>
          <p style={{ color: "#91a3bc", fontSize: 12, margin: "6px 0 0" }}>
            Configure a contract, review its quote, then confirm a demo order.
          </p>
        </div>
        <span style={{
          padding: "7px 10px",
          borderRadius: 20,
          background: connected ? "#103d32" : "#342b1b",
          color: connected ? "#35d6a2" : "#f0bb65",
          fontSize: 11,
          fontWeight: 800
        }}>
          {connected ? "DEMO CONNECTED" : "NOT CONNECTED"}
        </span>
      </div>

      {(error || notice || localError) && (
        <div
          role={localError || error ? "alert" : "status"}
          style={{
            padding: 11,
            borderRadius: 8,
            background: "#0b1422",
            border: `1px solid ${(localError || error) ? "#a94353" : "#1d8c70"}`,
            color: (localError || error) ? "#ff8997" : "#50d6aa",
            fontSize: 12
          }}
        >
          {localError || error || notice}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
        gap: 13
      }}>
        {marketOptions.length > 0 && (
          <div>
            <label style={labelStyle}>Market</label>
            <select
              style={inputStyle}
              value={symbol}
              disabled={!connected}
              onChange={event => changeMarket(event.target.value)}
            >
              {marketOptions.map(item => (
                <option key={item.value} value={item.value}>
                  {item.label || item.value}
                </option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label style={labelStyle}>Contract category</label>
          <select
            style={inputStyle}
            value={group}
            disabled={!connected || contractsLoading || contracts.length === 0}
            onChange={event => handleGroupChange(event.target.value)}
          >
            {GROUPS.map(item => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </div>

        <div>
          <label style={labelStyle}>Contract type</label>
          <select
            style={inputStyle}
            value={activeContract ? type : ""}
            disabled={!connected || contractsLoading || filteredContracts.length === 0}
            onChange={event => handleContractChange(event.target.value)}
          >
            {!activeContract && <option value="">Choose available contract</option>}
            {filteredContracts.map(item => (
              <option key={item.contract_type} value={item.contract_type}>
                {getContractLabel(item.contract_type)}
              </option>
            ))}
          </select>
          <small style={{ color: "#91a3bc", display: "block", marginTop: 6 }}>
            {contractsLoading
              ? "Loading options from Deriv…"
              : `${contracts.length} contract type(s) returned for this market.`}
          </small>
        </div>

        <div>
          <label style={labelStyle}>Stake ({currency})</label>
          <input
            style={inputStyle}
            type="number"
            min="0.01"
            max="10"
            step="0.01"
            value={stake}
            disabled={!connected}
            onChange={event => setStake(event.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>Duration</label>
          <input
            style={inputStyle}
            type="number"
            min="1"
            step="1"
            value={duration}
            disabled={!connected}
            onChange={event => setDuration(event.target.value)}
          />
        </div>

        <div>
          <label style={labelStyle}>Duration unit</label>
          <select
            style={inputStyle}
            value={durationUnit}
            disabled={!connected}
            onChange={event => setDurationUnit(event.target.value)}
          >
            <option value="t">Ticks</option>
            <option value="s">Seconds</option>
            <option value="m">Minutes</option>
            <option value="h">Hours</option>
            <option value="d">Days</option>
          </select>
        </div>
      </div>

      {needsBarrier && (
        <div style={{
          border: "1px solid #34445c",
          borderRadius: 10,
          padding: 14,
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
          gap: 13
        }}>
          <div style={{ gridColumn: "1 / -1" }}>
            <strong style={{ fontSize: 13 }}>Contract barrier settings</strong>
            <p style={{ color: "#91a3bc", fontSize: 11, margin: "5px 0 0" }}>
              {needsDigit
                ? "Digit contracts require a final-digit barrier from 0 to 9."
                : needsRange
                  ? "Enter the lower and upper price barriers for this range contract."
                  : "Enter the numeric price level required by this contract."}
            </p>
          </div>

          <div>
            <label style={labelStyle}>
              {needsRange ? "Lower barrier" : needsDigit ? "Digit barrier (0–9)" : "Price barrier"}
            </label>
            <input
              style={inputStyle}
              type="number"
              min={needsDigit ? "0" : undefined}
              max={needsDigit ? "9" : undefined}
              step={needsDigit ? "1" : "any"}
              value={needsDigit ? String(selectedDigit) : barrier}
              onChange={event => {
                setBarrier(event.target.value);
                if (needsDigit && /^[0-9]$/.test(event.target.value)) onSelectedDigitChange(event.target.value);
              }}
            />
          </div>

          {needsRange && (
            <div>
              <label style={labelStyle}>Upper barrier</label>
              <input
                style={inputStyle}
                type="number"
                step="any"
                value={barrier2}
                onChange={event => setBarrier2(event.target.value)}
              />
            </div>
          )}
        </div>
      )}

      <div style={{
        background: "#0b1422",
        border: "1px solid #26364d",
        borderRadius: 9,
        padding: 12,
        fontSize: 12,
        lineHeight: 1.6,
        color: "#aebbd0"
      }}>
        <strong style={{ color: "#f0bb65" }}>Demo safeguards</strong>
        <div>Maximum stake per proposal: {currency} 10.</div>
        <div>Only contract types returned by Deriv for the selected market can be requested.</div>
        <div>Preparing a proposal does not place an order. A separate confirmation is required.</div>
      </div>

      <button
        type="button"
        style={{
          ...buttonStyle,
          background: "#087d69",
          color: "#fff",
          opacity: canPrepare ? 1 : 0.55
        }}
        disabled={!canPrepare}
        onClick={prepareProposal}
      >
        {proposalLoading ? "Requesting Deriv quote…" : "Prepare trade proposal"}
      </button>

      {proposal && (
        <div style={{
          border: "1px solid #087d69",
          borderRadius: 10,
          padding: 14,
          display: "grid",
          gap: 12
        }}>
          <div>
            <strong>Proposal ready for review</strong>
            <p style={{ color: "#91a3bc", fontSize: 11, margin: "5px 0 0" }}>
              {getContractLabel(type)} · {symbol} · {duration} {durationUnit}
              {proposal.longcode ? ` · ${proposal.longcode}` : ""}
            </p>
          </div>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
            gap: 12
          }}>
            <div>
              <small style={{ color: "#91a3bc" }}>Stake / purchase price</small>
              <div style={{ fontWeight: 800 }}>
                {Number(proposal.ask_price ?? proposal.amount).toFixed(2)} {currency}
              </div>
            </div>
            <div>
              <small style={{ color: "#91a3bc" }}>Potential payout</small>
              <div style={{ fontWeight: 800 }}>
                {Number(proposal.payout).toFixed(2)} {currency}
              </div>
            </div>
          </div>

          <button
            type="button"
            style={{ ...buttonStyle, background: "#087d69", color: "#fff" }}
            disabled={!connected || orderLoading}
            onClick={onExecuteTrade}
          >
            {orderLoading ? "Placing demo order…" : "Confirm & place demo order"}
          </button>
        </div>
      )}
    </section>
  );
}
