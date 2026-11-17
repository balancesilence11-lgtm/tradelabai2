import React, { useEffect, useRef, useState } from "react";
import DerivClient from "./derivClient";
import DigitMatchPredictor from "./digitMatchPredictor";
import DerivBotBuilder from "./DerivBotBuilder";

const MAX_STAKE = 10;

const CONTRACT_TYPE_LABELS = {
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

function getContractTypeLabel(type) {
  const normalized = String(type || "").toUpperCase();
  return CONTRACT_TYPE_LABELS[normalized] || normalized.replaceAll("_", " ");
}

const SYMBOLS = [
  { value: "frxEURUSD", label: "EUR/USD" },
  { value: "frxGBPUSD", label: "GBP/USD" },
  { value: "frxUSDJPY", label: "USD/JPY" },
  { value: "frxUSDCHF", label: "USD/CHF" },
  { value: "frxUSDCAD", label: "USD/CAD" },
  { value: "frxAUDUSD", label: "AUD/USD" },
  { value: "frxNZDUSD", label: "NZD/USD" },
  { value: "frxEURGBP", label: "EUR/GBP" },
  { value: "frxEURJPY", label: "EUR/JPY" },
  { value: "frxGBPJPY", label: "GBP/JPY" },
  { value: "1HZ10V", label: "Volatility 10 (1s)" },
  { value: "1HZ15V", label: "Volatility 15 (1s)" },
  { value: "1HZ25V", label: "Volatility 25 (1s)" },
  { value: "1HZ30V", label: "Volatility 30 (1s)" },
  { value: "1HZ50V", label: "Volatility 50 (1s)" },
  { value: "1HZ75V", label: "Volatility 75 (1s)" },
  { value: "1HZ90V", label: "Volatility 90 (1s)" },
  { value: "1HZ100V", label: "Volatility 100 (1s)" },
  { value: "R_10", label: "Volatility 10" },
  { value: "R_25", label: "Volatility 25" },
  { value: "R_50", label: "Volatility 50" },
  { value: "R_75", label: "Volatility 75" },
  { value: "R_100", label: "Volatility 100" }
];

const panelStyle = { color: "#e7edf7", width: "100%", display: "grid", gap: 18 };
const cardStyle = { background: "#111c2d", border: "1px solid #26364d", borderRadius: 14, padding: 18 };
const buttonStyle = { border: 0, borderRadius: 8, padding: "11px 16px", fontWeight: 700, cursor: "pointer" };
const inputStyle = { width: "100%", background: "#0b1422", color: "#e7edf7", border: "1px solid #34445c", borderRadius: 8, padding: "11px 12px", outline: "none", boxSizing: "border-box" };

const money = (value, currency = "USD") => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(number);
  } catch {
    return `${currency} ${number.toFixed(2)}`;
  }
};

function getAccountId(account) {
  return account?.account_id || account?.id || account?.loginid || "";
}

function getAccountLabel(account) {
  return [getAccountId(account), account?.currency || "USD", "DEMO"].filter(Boolean).join(" · ");
}

function DerivLivePanel() {
  const clientRef = useRef(null);
  const digitPredictorRef = useRef(new DigitMatchPredictor({ maxHistory: 5000, minSamples: 200 }));
  const contractsRequestRef = useRef(0);
  const proposalRequestRef = useRef(0);

  const [digitAnalysis, setDigitAnalysis] = useState(null);
  const [selectedTargetDigit, setSelectedTargetDigit] = useState("5");
  const [digitPerformance, setDigitPerformance] = useState({ total: 0, wins: 0, losses: 0, accuracy: 0 });
  const [digitHistory, setDigitHistory] = useState([]);

  const [status, setStatus] = useState("disconnected");
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(() => localStorage.getItem("tradelab_deriv_selected_account") || "");
  const [balance, setBalance] = useState(null);
  const [portfolio, setPortfolio] = useState([]);
  const [history, setHistory] = useState([]);

  const [symbol, setSymbol] = useState("frxEURUSD");
  const [tick, setTick] = useState(null);
  const [stake, setStake] = useState("1");
  const [contractType, setContractType] = useState("DIGITMATCH");
  const [duration, setDuration] = useState("5");
  const [durationUnit, setDurationUnit] = useState("m");

  const [availableContracts, setAvailableContracts] = useState([]);
  const [contractsLoading, setContractsLoading] = useState(false);
  const [proposal, setProposal] = useState(null);
  const [proposalParameters, setProposalParameters] = useState(null);
  const [lastOrder, setLastOrder] = useState(null);
  const [monitoredContract, setMonitoredContract] = useState(null);

  const [loading, setLoading] = useState(false);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [orderLoading, setOrderLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const connected = status === "connected";
  const currency = accounts.find(a => getAccountId(a) === accountId)?.currency || balance?.currency || "USD";

  useEffect(() => {
    const client = new DerivClient({
      onStatus: event => {
        setStatus(event.state || "disconnected");
        if (event.state === "error") setError(event.error || "Deriv connection error.");
        if (event.state === "disconnected") {
          // Invalidate any asynchronous quote/contract response from the old session.
          contractsRequestRef.current += 1;
          proposalRequestRef.current += 1;
          setBalance(null);
          setPortfolio([]);
          setTick(null);
          setProposal(null);
          setProposalParameters(null);
          setAvailableContracts([]);
          setContractsLoading(false);
          setProposalLoading(false);
        }
      },
      onMessage: data => {
        if (data.msg_type === "balance" && data.balance) setBalance(data.balance);
        if (data.msg_type === "portfolio" && data.portfolio) setPortfolio(data.portfolio.contracts || []);

        if (data.msg_type === "tick" && data.tick) {
          const incomingTick = data.tick;
          setTick(incomingTick);
          const predictor = digitPredictorRef.current;
          const digit = predictor.extractDigit(incomingTick.quote, incomingTick.pip_size);
          if (digit !== null) {
            const evaluation = predictor.evaluate(digit);
            if (evaluation) {
              setDigitHistory(previous => [{ ...evaluation, quote: incomingTick.quote }, ...previous].slice(0, 50));
            }
            predictor.addTick(incomingTick);
            const prediction = predictor.predict();
            setDigitAnalysis({ ...prediction, currentDigit: digit });
            setDigitPerformance(predictor.getPerformance());
          }
        }

        if (data.msg_type === "proposal_open_contract" && data.proposal_open_contract) {
          const contract = data.proposal_open_contract;
          setMonitoredContract(contract);
          if (contract.is_sold) {
            setNotice(`Contract ${contract.contract_id} has settled.`);
            client.refreshAccount().then(snapshot => {
              setBalance(snapshot.balance);
              setPortfolio(snapshot.portfolio);
            }).catch(err => console.warn("Account refresh failed:", err));
          }
        }
        if (data.error) setError(data.error.message || "Deriv API error.");
      }
    });

    clientRef.current = client;
    loadAccounts();
    return () => {
      client.disconnect();
      clientRef.current = null;
    };
    // The client is intentionally initialized once for this mounted panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAccounts() {
    if (!clientRef.current) return;
    setLoading(true);
    setError("");
    try {
      const list = await clientRef.current.getAccounts();
      const demoAccounts = list.filter(account => {
        const type = String(account.account_type || account.type || "").toLowerCase();
        return type === "demo" || type === "virtual" || account.is_virtual === 1 || account.is_virtual === true;
      });
      setAccounts(demoAccounts);
      if (accountId && !demoAccounts.some(a => getAccountId(a) === accountId)) {
        setAccountId("");
        localStorage.removeItem("tradelab_deriv_selected_account");
      }
    } catch (err) {
      setError(err.message || "Unable to load Deriv accounts.");
    } finally {
      setLoading(false);
    }
  }

  async function loadAvailableContracts(market = symbol) {
    if (!clientRef.current?.connected) return [];

    const requestId = ++contractsRequestRef.current;
    setContractsLoading(true);
    setError("");

    try {
      const contracts = await clientRef.current.getAvailableContracts(market, { force: true });

      // Ignore a late response from a market that the user has already left.
      if (requestId !== contractsRequestRef.current) return contracts;

      setAvailableContracts(contracts);
      const types = contracts.map(item => String(item.contract_type || "").toUpperCase());
      if (!types.includes(String(contractType).toUpperCase())) {
        const preferred = types.includes("CALL") ? "CALL" : (types[0] || "");
        if (preferred) setContractType(preferred);
      }
      return contracts;
    } catch (err) {
      if (requestId === contractsRequestRef.current) {
        setAvailableContracts([]);
        setError(err.message || `Unable to load contracts for ${market}.`);
      }
      return [];
    } finally {
      if (requestId === contractsRequestRef.current) setContractsLoading(false);
    }
  }

  async function loadHistory() {
    if (!clientRef.current?.connected) return;
    try {
      const result = await clientRef.current.getProfitTable({ limit: 50, offset: 0 });
      const transactions = result.transactions || result.profit_table || [];
      setHistory(Array.isArray(transactions) ? transactions : []);
    } catch (err) {
      console.warn("Profit table unavailable:", err.message);
    }
  }

  async function connectAccount() {
    if (!accountId) {
      setError("Select a demo account first.");
      return;
    }
    setLoading(true);
    setError("");
    setNotice("");
    setProposal(null);
    setProposalParameters(null);
    try {
      const result = await clientRef.current.connect(accountId);
      setBalance(result.balance);
      setPortfolio(result.portfolio || []);
      localStorage.setItem("tradelab_deriv_selected_account", accountId);
      await loadHistory();
      await loadAvailableContracts(symbol);
      await clientRef.current.subscribeTicks(symbol);
      setNotice("Deriv demo account connected. Market contracts and live ticks are loaded.");
    } catch (err) {
      setError(err.message || "Unable to connect Deriv account.");
    } finally {
      setLoading(false);
    }
  }

  function disconnectAccount() {
    proposalRequestRef.current += 1;
    contractsRequestRef.current += 1;
    clientRef.current?.disconnect();
    setBalance(null);
    setPortfolio([]);
    setHistory([]);
    setTick(null);
    setProposal(null);
    setProposalParameters(null);
    setAvailableContracts([]);
    setMonitoredContract(null);
    setLastOrder(null);
    setNotice("Deriv account disconnected.");
    setError("");
  }

  async function changeMarket(nextSymbol) {
    if (!nextSymbol || nextSymbol === symbol) return;
    proposalRequestRef.current += 1;
    setProposalLoading(false);
    setSymbol(nextSymbol);
    setTick(null);
    setProposal(null);
    setProposalParameters(null);
    setAvailableContracts([]);
    digitPredictorRef.current.reset();
    setDigitAnalysis(null);
    setDigitHistory([]);
    setDigitPerformance({ total: 0, wins: 0, losses: 0, accuracy: 0 });
    if (!clientRef.current?.connected) return;
    try {
      await Promise.all([
        loadAvailableContracts(nextSymbol),
        clientRef.current.subscribeTicks(nextSymbol)
      ]);
      setNotice(`Market changed to ${SYMBOLS.find(item => item.value === nextSymbol)?.label || nextSymbol}.`);
    } catch (err) {
      setError(err.message || "Unable to switch market.");
    }
  }

  async function refreshAccount() {
    if (!connected) return;
    setLoading(true);
    setError("");
    try {
      const snapshot = await clientRef.current.refreshAccount();
      setBalance(snapshot.balance);
      setPortfolio(snapshot.portfolio);
      await loadHistory();
      setNotice("Account information refreshed.");
    } catch (err) {
      setError(err.message || "Account refresh failed.");
    } finally {
      setLoading(false);
    }
  }

  async function requestProposal(parameters = {}) {
    if (!connected) {
      setError("Connect your demo account first.");
      return;
    }
    setError("");
    setNotice("");
    setProposal(null);
    setProposalParameters(null);

    const amount = Number(stake);
    const tradeDuration = Number(duration);
    if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_STAKE) {
      setError(`Stake must be greater than zero and not exceed ${MAX_STAKE}.`);
      return;
    }
    if (!Number.isInteger(tradeDuration) || tradeDuration < 1) {
      setError("Enter a valid whole-number trade duration.");
      return;
    }

    // For Matches, the predictor's selected target digit is the single source
    // of truth. This prevents a stale Bot Builder field from quoting another digit.
    const normalizedContractType = String(contractType || "").toUpperCase();
    const matchBarrier = String(selectedTargetDigit);
    if (normalizedContractType === "DIGITMATCH" &&
        (!Number.isInteger(Number(matchBarrier)) || Number(matchBarrier) < 0 || Number(matchBarrier) > 9)) {
      setError("Choose a valid match digit from 0 to 9.");
      return;
    }

    const params = {
      symbol,
      contractType,
      amount,
      currency,
      duration: tradeDuration,
      durationUnit,
      ...(normalizedContractType === "DIGITMATCH"
        ? { barrier: matchBarrier }
        : parameters.barrier !== undefined && parameters.barrier !== ""
          ? { barrier: parameters.barrier }
          : {}),
      ...(parameters.barrier2 !== undefined && parameters.barrier2 !== "" ? { barrier2: parameters.barrier2 } : {})
    };

    const requestId = ++proposalRequestRef.current;
    setProposalLoading(true);
    try {
      const quote = await clientRef.current.getProposal(params);
      // Do not show a quote if the user changed market or settings while it loaded.
      if (requestId !== proposalRequestRef.current) return;
      setProposal(quote);
      setProposalParameters({ ...params });
      setNotice("Proposal received. Review the contract type, barriers and quote before confirming.");
    } catch (err) {
      if (requestId === proposalRequestRef.current) {
        setError(err.message || "Unable to obtain proposal.");
      }
    } finally {
      if (requestId === proposalRequestRef.current) setProposalLoading(false);
    }
  }

  async function executeDemoTrade() {
    if (!proposal || !proposalParameters) {
      setError("Request a proposal before placing an order.");
      return;
    }
    if (!connected) {
      setError("Demo account is not connected.");
      return;
    }

    const p = proposalParameters;
    const marketLabel = SYMBOLS.find(item => item.value === p.symbol)?.label || p.symbol;
    const barrierText = p.barrier !== undefined
      ? `Barrier: ${p.barrier}${p.barrier2 !== undefined ? ` to ${p.barrier2}` : ""}`
      : "";
    const confirmed = window.confirm([
      "CONFIRM DEMO TRADE",
      "",
      `Market: ${marketLabel}`,
      `Contract: ${getContractTypeLabel(p.contractType)} (${p.contractType})`,
      barrierText,
      `Stake: ${money(proposal.amount ?? p.amount, p.currency)}`,
      `Potential payout: ${money(proposal.payout, p.currency)}`,
      `Duration: ${p.duration} ${p.durationUnit}`,
      "",
      "This will place a DEMO trade on Deriv.",
      "Do you want to continue?"
    ].filter(Boolean).join("\n"));

    if (!confirmed) return;
    setOrderLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await clientRef.current.buyDemoProposal(proposal.id, proposal.ask_price, { confirmed: true });
      // The purchase is confirmed at this point. Follow-up refresh failures must
      // not incorrectly report that the order itself failed.
      setLastOrder(result);
      setProposal(null);
      setProposalParameters(null);

      if (result.contract_id) {
        setMonitoredContract({ contract_id: result.contract_id, status: "Monitoring", is_sold: 0 });
        try {
          await clientRef.current.monitorContract(result.contract_id);
        } catch (monitorError) {
          console.warn("Contract monitoring could not start:", monitorError);
        }
      }

      const followUpWarnings = [];
      try {
        await refreshAccountAfterTrade();
      } catch (refreshError) {
        followUpWarnings.push("account refresh is pending");
        console.warn("Post-trade account refresh failed:", refreshError);
      }
      try {
        await loadHistory();
      } catch (historyError) {
        followUpWarnings.push("trade history may need refreshing");
        console.warn("Post-trade history refresh failed:", historyError);
      }

      setNotice(`Demo order successfully placed. Contract ID: ${result.contract_id}${followUpWarnings.length ? ` (${followUpWarnings.join("; ")})` : ""}`);
    } catch (err) {
      setError(err.message || "Demo order failed.");
    } finally {
      setOrderLoading(false);
    }
  }

  async function refreshAccountAfterTrade() {
    const snapshot = await clientRef.current.refreshAccount();
    setBalance(snapshot.balance);
    setPortfolio(snapshot.portfolio);
  }

  const selectedMarketLabel = SYMBOLS.find(item => item.value === symbol)?.label || symbol;

  return (
    <div style={panelStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h2 style={{ margin: 0 }}>Deriv Live Trading</h2>
          <p style={{ color: "#91a3bc", margin: "6px 0 0" }}>Authenticated Deriv connection · Forex · Volatility · AI analysis</p>
        </div>
        <span style={{ padding: "8px 12px", borderRadius: 20, background: connected ? "#103d32" : "#342b1b", color: connected ? "#35d6a2" : "#f0bb65", fontSize: 12, fontWeight: 800 }}>
          ● {connected ? "CONNECTED — DEMO" : status.toUpperCase()}
        </span>
      </div>

      {error && <div role="alert" style={{ ...cardStyle, borderColor: "#a94353", color: "#ff8997" }}>{error}</div>}
      {notice && <div role="status" style={{ ...cardStyle, borderColor: "#1d8c70", color: "#50d6aa" }}>{notice}</div>}

      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Demo Account Connection</h3>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <div style={{ flex: "1 1 250px" }}>
            <label style={{ display: "block", marginBottom: 8 }}>Select Deriv demo account</label>
            <select style={inputStyle} value={accountId} disabled={connected || loading} onChange={event => setAccountId(event.target.value)}>
              <option value="">Select demo account</option>
              {accounts.map(account => <option key={getAccountId(account)} value={getAccountId(account)}>{getAccountLabel(account)}</option>)}
            </select>
          </div>
          {!connected ? (
            <button style={{ ...buttonStyle, background: "#087d69", color: "#fff" }} disabled={loading || !accountId} onClick={connectAccount}>{loading ? "Connecting..." : "Connect Demo Account"}</button>
          ) : <>
            <button style={{ ...buttonStyle, background: "#263b55", color: "#fff" }} disabled={loading} onClick={refreshAccount}>Refresh Account</button>
            <button style={{ ...buttonStyle, background: "#92384b", color: "#fff" }} onClick={disconnectAccount}>Disconnect</button>
          </>}
          <button style={{ ...buttonStyle, background: "#263b55", color: "#fff" }} onClick={loadAccounts} disabled={loading || connected}>Reload Accounts</button>
        </div>
        <p style={{ color: "#91a3bc", fontSize: 12, marginBottom: 0 }}>Only Deriv demo accounts are permitted. Real-money execution is disabled.</p>
      </section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
        <div style={cardStyle}><div style={{ color: "#91a3bc", fontSize: 12 }}>Account Balance</div><h2 style={{ marginBottom: 0 }}>{balance ? money(balance.balance, balance.currency) : "—"}</h2></div>
        <div style={cardStyle}><div style={{ color: "#91a3bc", fontSize: 12 }}>Open Positions</div><h2 style={{ marginBottom: 0 }}>{portfolio.length}</h2></div>
        <div style={cardStyle}><div style={{ color: "#91a3bc", fontSize: 12 }}>Current Market</div><h2 style={{ marginBottom: 0 }}>{selectedMarketLabel}</h2></div>
        <div style={cardStyle}><div style={{ color: "#91a3bc", fontSize: 12 }}>Live Price</div><h2 style={{ marginBottom: 0 }}>{tick?.quote !== undefined ? Number(tick.quote).toFixed(5) : "—"}</h2></div>
      </div>

      <section style={{ ...cardStyle, borderColor: "#087d69", background: "linear-gradient(145deg,#111c2d 0%,#0d1a29 100%)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
          <div>
            <h3 style={{ margin: 0 }}>AI Digit Match Predictor</h3>
            <p style={{ color: "#91a3bc", fontSize: 12, margin: "6px 0 0" }}>Live Deriv tick analysis · Weighted digit model · Historical validation</p>
          </div>
          <span style={{ border: "1px solid #236b5a", color: "#35d6a2", borderRadius: 20, padding: "6px 11px", fontSize: 11, fontWeight: 800 }}>
            {digitAnalysis?.ready ? "MODEL ACTIVE" : "COLLECTING TICKS"}
          </span>
        </div>

        <div style={{ ...cardStyle, padding: 14, marginTop: 16, borderColor: "#087d69", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14 }}>
          <div style={{ minWidth: 220, flex: 1 }}>
            <strong style={{ display: "block", marginBottom: 5 }}>Choose the last digit to match</strong>
            <small style={{ color: "#91a3bc" }}>Select your target digit from 0 to 9. The AI recommendation is shown separately below.</small>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <select aria-label="Digit to match" value={selectedTargetDigit} onChange={event => setSelectedTargetDigit(event.target.value)} style={{ background: "#0b1422", color: "#fff", border: "1px solid #35d6a2", borderRadius: 8, padding: "11px 16px", fontSize: 18, fontWeight: 800, minWidth: 85 }}>
              {Array.from({ length: 10 }, (_, digit) => <option key={digit} value={String(digit)}>{digit}</option>)}
            </select>
            <div style={{ textAlign: "right" }}>
              <small style={{ display: "block", color: "#91a3bc" }}>AI top suggestion</small>
              <strong style={{ fontSize: 23, color: "#35d6a2" }}>{digitAnalysis?.ready ? digitAnalysis.predictedDigit : "—"}</strong>
            </div>
          </div>
          <div style={{ flexBasis: "100%", color: digitAnalysis?.ready ? (Number(selectedTargetDigit) === digitAnalysis.predictedDigit ? "#35d6a2" : "#f0bb65") : "#91a3bc", fontSize: 12 }}>
            {digitAnalysis?.ready
              ? (Number(selectedTargetDigit) === digitAnalysis.predictedDigit ? "Your selected match digit agrees with the AI's top-ranked digit." : `You selected ${selectedTargetDigit}; the AI currently ranks ${digitAnalysis.predictedDigit} highest. You can choose either.`)
              : `Selected target digit: ${selectedTargetDigit}. The AI recommendation will appear after enough live ticks are collected.`}
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))", gap: 12, marginTop: 16 }}>
          <div style={{ ...cardStyle, padding: 14 }}><small style={{ color: "#91a3bc" }}>LATEST DIGIT</small><div style={{ fontSize: 32, fontWeight: 800, marginTop: 5 }}>{digitAnalysis?.currentDigit ?? "—"}</div><small style={{ color: "#91a3bc" }}>From latest live tick</small></div>
          <div style={{ ...cardStyle, padding: 14, borderColor: "#087d69" }}><small style={{ color: "#91a3bc" }}>TOP MATCH CANDIDATE</small><div style={{ fontSize: 32, fontWeight: 800, color: "#35d6a2", marginTop: 5 }}>{digitAnalysis?.ready ? digitAnalysis.predictedDigit : "—"}</div><small style={{ color: "#91a3bc" }}>Second candidate: {digitAnalysis?.ready ? digitAnalysis.secondBest : "—"}</small></div>
          <div style={{ ...cardStyle, padding: 14 }}><small style={{ color: "#91a3bc" }}>MODEL SCORE</small><div style={{ fontSize: 25, fontWeight: 800, marginTop: 9 }}>{digitAnalysis?.ready ? `${(digitAnalysis.probability * 100).toFixed(2)}%` : "Pending"}</div><small style={{ color: "#91a3bc" }}>Random baseline: 10%</small></div>
          <div style={{ ...cardStyle, padding: 14 }}><small style={{ color: "#91a3bc" }}>TICK OBSERVATIONS</small><div style={{ fontSize: 25, fontWeight: 800, marginTop: 9 }}>{digitAnalysis?.sampleSize || 0}</div><small style={{ color: "#91a3bc" }}>Minimum required: 200</small></div>
        </div>

        {!digitAnalysis?.ready && <div style={{ marginTop: 14, padding: 13, borderRadius: 9, background: "#241f16", border: "1px solid #66502a", color: "#f0bb65", fontSize: 12 }}>
          Collecting observations. The statistical model becomes available after at least 200 valid ticks. Current progress: {digitAnalysis?.samples || 0} / {digitAnalysis?.required || 200}.
          <div style={{ height: 7, borderRadius: 8, background: "#3a3020", marginTop: 9, overflow: "hidden" }}><div style={{ width: `${Math.min(100, ((digitAnalysis?.samples || 0) / (digitAnalysis?.required || 200)) * 100)}%`, height: "100%", background: "#e5a83e" }} /></div>
        </div>}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 14, marginTop: 16 }}>
          <div style={{ ...cardStyle, padding: 14 }}>
            <h4 style={{ margin: "0 0 12px" }}>Digit Probability Distribution</h4>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5,minmax(0,1fr))", gap: 7 }}>
              {(digitAnalysis?.distribution || Array.from({ length: 10 }, (_, digit) => ({ digit, probability: 0 }))).map(item => {
                const isTop = digitAnalysis?.ready && item.digit === digitAnalysis.predictedDigit;
                return <div key={item.digit} style={{ padding: "9px 5px", borderRadius: 8, textAlign: "center", background: isTop ? "#103d32" : "#0b1422", border: isTop ? "1px solid #35d6a2" : "1px solid #26364d" }}>
                  <strong style={{ fontSize: 17 }}>{item.digit}</strong><div style={{ color: isTop ? "#35d6a2" : "#91a3bc", fontSize: 11, marginTop: 4 }}>{(item.probability * 100).toFixed(1)}%</div>
                </div>;
              })}
            </div>
            <small style={{ color: "#91a3bc", display: "block", marginTop: 10 }}>Historical frequency across collected ticks.</small>
          </div>
          <div style={{ ...cardStyle, padding: 14 }}>
            <h4 style={{ margin: "0 0 12px" }}>Top Model Rankings</h4>
            {(digitAnalysis?.rankings || []).slice(0, 5).map((item, index) => <div key={item.digit} style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}><strong>#{index + 1} · Digit {item.digit}</strong><span style={{ color: "#35d6a2" }}>{(item.score * 100).toFixed(2)}%</span></div>
              <div style={{ height: 7, borderRadius: 8, background: "#26364d", overflow: "hidden" }}><div style={{ width: `${Math.min(100, item.score * 100)}%`, height: "100%", background: index === 0 ? "#35d6a2" : "#477f91" }} /></div>
            </div>)}
            {!digitAnalysis?.ready && <p style={{ color: "#91a3bc", fontSize: 12 }}>Rankings will appear when the model has enough observations.</p>}
          </div>
        </div>

        <h4 style={{ margin: "18px 0 10px" }}>Prediction Performance</h4>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 10 }}>
          {[["Evaluated", digitPerformance.total], ["Correct", digitPerformance.wins], ["Incorrect", digitPerformance.losses], ["Historical accuracy", `${digitPerformance.accuracy.toFixed(2)}%`]].map(([label, value]) => <div key={label} style={{ ...cardStyle, padding: 12 }}><small style={{ color: "#91a3bc" }}>{label}</small><div style={{ fontSize: 21, fontWeight: 800, marginTop: 5 }}>{value}</div></div>)}
        </div>

        <h4 style={{ margin: "18px 0 8px" }}>Recent Evaluated Predictions</h4>
        {digitHistory.length === 0 ? <p style={{ color: "#91a3bc", fontSize: 12 }}>No evaluated predictions yet. Results will appear after a prediction is compared with the next observed tick.</p> : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 430 }}><thead><tr>{["Predicted", "Actual", "Outcome", "Time"].map(label => <th key={label} style={{ textAlign: "left", padding: 9, borderBottom: "1px solid #34445c", fontSize: 12 }}>{label}</th>)}</tr></thead><tbody>{digitHistory.map((item, index) => <tr key={`${item.timestamp}-${index}`}><td style={{ padding: 9 }}>{item.predicted}</td><td style={{ padding: 9 }}>{item.actual}</td><td style={{ padding: 9, color: item.correct ? "#35d6a2" : "#ff8997", fontWeight: 700 }}>{item.correct ? "CORRECT" : "INCORRECT"}</td><td style={{ padding: 9, color: "#91a3bc", fontSize: 11 }}>{new Date(item.timestamp).toLocaleTimeString()}</td></tr>)}</tbody></table></div>}
        <p style={{ color: "#91a3bc", fontSize: 11, lineHeight: 1.6, marginBottom: 0 }}>This model ranks digits using historical frequency, recency-weighted frequency and last-digit transitions. Scores are statistical estimates, not guaranteed outcomes. A 10% random baseline applies to an unbiased ten-digit outcome.</p>
      </section>

      <DerivBotBuilder
        connected={connected}
        symbol={symbol}
        changeMarket={changeMarket}
        contractType={contractType}
        setContractType={value => { proposalRequestRef.current += 1; setContractType(value); setProposal(null); setProposalParameters(null); setProposalLoading(false); }}
        duration={duration}
        setDuration={value => { proposalRequestRef.current += 1; setDuration(value); setProposal(null); setProposalParameters(null); setProposalLoading(false); }}
        durationUnit={durationUnit}
        setDurationUnit={value => { proposalRequestRef.current += 1; setDurationUnit(value); setProposal(null); setProposalParameters(null); setProposalLoading(false); }}
        stake={stake}
        setStake={value => { proposalRequestRef.current += 1; setStake(value); setProposal(null); setProposalParameters(null); setProposalLoading(false); }}
        availableContracts={availableContracts}
        contractsLoading={contractsLoading}
        marketOptions={SYMBOLS}
        onPrepareTrade={requestProposal}
        onExecuteTrade={executeDemoTrade}
        proposal={proposal}
        orderLoading={orderLoading}
        proposalLoading={proposalLoading}
        currency={currency}
        initialTargetDigit={selectedTargetDigit}
        onTargetDigitChange={setSelectedTargetDigit}
      />

      {lastOrder && <section style={cardStyle}><h3 style={{ marginTop: 0 }}>Latest Demo Order</h3><div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Contract ID</span><strong>{lastOrder.contract_id}</strong></div><div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Purchase Price</span><strong>{money(lastOrder.buy_price, currency)}</strong></div><div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Potential Payout</span><strong>{money(lastOrder.payout, currency)}</strong></div></section>}

      {monitoredContract && <section style={cardStyle}><h3 style={{ marginTop: 0 }}>Contract Monitoring</h3><div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Contract ID</span><strong>{monitoredContract.contract_id}</strong></div><div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Status</span><strong>{monitoredContract.is_sold ? "SETTLED" : "OPEN / MONITORING"}</strong></div>{monitoredContract.profit !== undefined && <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Profit / Loss</span><strong style={{ color: Number(monitoredContract.profit) >= 0 ? "#35d6a2" : "#ff8997" }}>{money(monitoredContract.profit, currency)}</strong></div>}{monitoredContract.exit_tick !== undefined && <div style={{ display: "flex", justifyContent: "space-between", padding: "7px 0" }}><span>Exit Price</span><strong>{monitoredContract.exit_tick}</strong></div>}</section>}

      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><h3>Open Positions</h3><button style={{ ...buttonStyle, background: "#263b55", color: "#fff" }} disabled={!connected || loading} onClick={refreshAccount}>Refresh</button></div>
        {portfolio.length === 0 ? <p style={{ color: "#91a3bc" }}>No open positions returned by Deriv.</p> : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 550 }}><thead><tr>{["Contract", "Market", "Buy Price", "Current Value", "Profit"].map(label => <th key={label} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #34445c" }}>{label}</th>)}</tr></thead><tbody>{portfolio.map((item, index) => <tr key={item.contract_id || index}><td style={{ padding: 10 }}>{item.contract_id}</td><td style={{ padding: 10 }}>{item.underlying || item.symbol || "—"}</td><td style={{ padding: 10 }}>{money(item.buy_price, currency)}</td><td style={{ padding: 10 }}>{money(item.bid_price, currency)}</td><td style={{ padding: 10, color: Number(item.profit) >= 0 ? "#35d6a2" : "#ff8997" }}>{money(item.profit, currency)}</td></tr>)}</tbody></table></div>}
      </section>

      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}><h3>Trade History</h3><button style={{ ...buttonStyle, background: "#263b55", color: "#fff" }} disabled={!connected} onClick={loadHistory}>Refresh History</button></div>
        {history.length === 0 ? <p style={{ color: "#91a3bc" }}>No completed trades returned yet.</p> : <div style={{ overflowX: "auto" }}><table style={{ width: "100%", borderCollapse: "collapse", minWidth: 550 }}><thead><tr>{["Contract", "Market", "Buy Price", "Sell Price", "Profit"].map(label => <th key={label} style={{ textAlign: "left", padding: 10, borderBottom: "1px solid #34445c" }}>{label}</th>)}</tr></thead><tbody>{history.map((item, index) => <tr key={item.contract_id || index}><td style={{ padding: 10 }}>{item.contract_id || "—"}</td><td style={{ padding: 10 }}>{item.underlying || item.symbol || "—"}</td><td style={{ padding: 10 }}>{money(item.buy_price, currency)}</td><td style={{ padding: 10 }}>{money(item.sell_price, currency)}</td><td style={{ padding: 10, color: Number(item.profit) >= 0 ? "#35d6a2" : "#ff8997" }}>{money(item.profit, currency)}</td></tr>)}</tbody></table></div>}
      </section>

      <div style={{ ...cardStyle, borderColor: "#755c2b", color: "#f0bb65", fontSize: 12, lineHeight: 1.7 }}><strong>Demo Trading Safeguards</strong><p style={{ marginBottom: 0 }}>TradeLab currently restricts this interface to demo accounts and a maximum $10 stake. Server-side execution controls must also enforce these limits. Real-money trading remains disabled.</p></div>
    </div>
  );
}

export default DerivLivePanel;
