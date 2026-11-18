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

const panelStyle = {
  color: "#172b4d",
  width: "100%",
  display: "grid",
  gap: 18,
  fontFamily: "Inter, system-ui, sans-serif"
};

const cardStyle = {
  background: "#ffffff",
  color: "#172b4d",
  border: "1px solid #e2e8f0",
  borderRadius: 14,
  padding: 18,
  boxShadow: "0 2px 10px rgba(15, 23, 42, 0.04)"
};

const buttonStyle = {
  border: 0,
  borderRadius: 9,
  padding: "11px 16px",
  fontWeight: 700,
  cursor: "pointer"
};

const inputStyle = {
  width: "100%",
  background: "#ffffff",
  color: "#172b4d",
  border: "1px solid #cbd5e1",
  borderRadius: 9,
  padding: "11px 12px",
  outline: "none",
  boxSizing: "border-box"
};

const money = (value, currency = "USD") => {
  const number = Number(value);

  if (!Number.isFinite(number)) return "—";

  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(number);
  } catch {
    return `${currency} ${number.toFixed(2)}`;
  }
};

function getAccountId(account) {
  return account?.account_id || account?.id || account?.loginid || "";
}

function getAccountLabel(account) {
  return [
    getAccountId(account),
    account?.currency || "USD",
    "DEMO"
  ].filter(Boolean).join(" · ");
}


// Estimates the probability that the target digit appears on exactly the
// fourth future tick, using a smoothed first-order digit transition model.
function calculateFourTickDigitForecast(history, targetDigit, alpha = 1) {
  if (!Array.isArray(history) || history.length < 200) return null;

  const transitions = Array.from({ length: 10 }, () => Array(10).fill(0));
  for (let i = 1; i < history.length; i++) {
    const from = Number(history[i - 1]?.digit);
    const to = Number(history[i]?.digit);
    if (Number.isInteger(from) && from >= 0 && from <= 9 &&
        Number.isInteger(to) && to >= 0 && to <= 9) {
      transitions[from][to] += 1;
    }
  }

  const matrix = transitions.map(row => {
    const total = row.reduce((sum, value) => sum + value, 0);
    return row.map(value => (value + alpha) / (total + alpha * 10));
  });

  const lastDigit = Number(history[history.length - 1]?.digit);
  const target = Number(targetDigit);
  if (!Number.isInteger(lastDigit) || lastDigit < 0 || lastDigit > 9 ||
      !Number.isInteger(target) || target < 0 || target > 9) return null;

  let distribution = Array(10).fill(0);
  distribution[lastDigit] = 1;

  for (let step = 0; step < 4; step++) {
    const next = Array(10).fill(0);
    for (let from = 0; from < 10; from++) {
      for (let to = 0; to < 10; to++) {
        next[to] += distribution[from] * matrix[from][to];
      }
    }
    distribution = next;
  }

  return {
    targetDigit: target,
    probability: distribution[target],
    samples: history.length,
    generatedAt: Date.now()
  };
}

function DerivLivePanel() {
  const clientRef = useRef(null);

  // Keep a separate, persistent walk-forward model for each selected market.
  // This prevents one market's digit history from contaminating another.
  const predictorsByMarketRef = useRef({});
  const activeMarketRef = useRef("1HZ100V");

  function getPredictorForMarket(market) {
    if (!predictorsByMarketRef.current[market]) {
      const predictor = new DigitMatchPredictor({
        maxHistory: 5000,
        minSamples: 200,
        maxPredictions: 2000
      });
      try {
        const saved = localStorage.getItem(`tradelab_predictor_phase4_${market}`);
        if (saved) predictor.importState(JSON.parse(saved));
      } catch (error) {
        console.warn(`Could not restore ${market} prediction history:`, error);
      }
      predictorsByMarketRef.current[market] = predictor;
    }
    return predictorsByMarketRef.current[market];
  }

  function persistPredictor(market, predictor) {
    try {
      localStorage.setItem(
        `tradelab_predictor_phase4_${market}`,
        JSON.stringify(predictor.exportState())
      );
    } catch (error) {
      console.warn(`Could not save ${market} prediction history:`, error);
    }
  }

  const contractsRequestRef = useRef(0);
  const proposalRequestRef = useRef(0);
  const monitoredContractIdsRef = useRef(new Set());

  const [digitAnalysis, setDigitAnalysis] = useState(null);

  const [selectedTargetDigit, setSelectedTargetDigit] = useState(() => {
    const saved = Number(
      localStorage.getItem("tradelab_selected_target_digit")
    );

    return Number.isInteger(saved) && saved >= 0 && saved <= 9
      ? String(saved)
      : "8";
  });

  const [fourTickForecast, setFourTickForecast] = useState(null);
  const [fourTickResults, setFourTickResults] = useState([]);
  const fourTickPendingRef = useRef(null);
  const selectedTargetDigitRef = useRef(selectedTargetDigit);

  function updateSelectedTargetDigit(value) {
    const digit = String(value);

    if (!/^[0-9]$/.test(digit)) return;

    setSelectedTargetDigit(digit);
    selectedTargetDigitRef.current = digit;
    fourTickPendingRef.current = null;
    setFourTickForecast(null);

    try {
      localStorage.setItem("tradelab_selected_target_digit", digit);
    } catch {}
  }

  const [digitPerformance, setDigitPerformance] = useState({
    total: 0,
    wins: 0,
    losses: 0,
    accuracy: 0
  });

  const [digitHistory, setDigitHistory] = useState([]);
  const [digitPerformanceByDigit, setDigitPerformanceByDigit] = useState([]);
  const [recentDigitPerformance, setRecentDigitPerformance] = useState({ total: 0, wins: 0, losses: 0, accuracy: 0 });
  const [reliabilityStatus, setReliabilityStatus] = useState(null);
  const [marketPerformance, setMarketPerformance] = useState([]);

  const [status, setStatus] = useState("disconnected");
  const [accounts, setAccounts] = useState([]);

  const [accountId, setAccountId] = useState(
    () => localStorage.getItem("tradelab_deriv_selected_account") || ""
  );

  const [balance, setBalance] = useState(null);
  const [portfolio, setPortfolio] = useState([]);
  const [livePositions, setLivePositions] = useState({});
  const [history, setHistory] = useState([]);

  const [symbol, setSymbol] = useState("1HZ100V");
  const [tick, setTick] = useState(null);
  const [stake, setStake] = useState("1");

  const [contractType, setContractType] = useState("DIGITMATCH");
  const [duration, setDuration] = useState("5");
  const [durationUnit, setDurationUnit] = useState("t");

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

  const currency =
    accounts.find(a => getAccountId(a) === accountId)?.currency ||
    balance?.currency ||
    "USD";

  const selectedMarketLabel =
    SYMBOLS.find(item => item.value === symbol)?.label || symbol;

  useEffect(() => {
    const client = new DerivClient({
      onStatus: event => {
        setStatus(event.state || "disconnected");

        if (event.state === "error") {
          setError(event.error || "Deriv connection error.");
        }

        if (event.state === "disconnected") {
          contractsRequestRef.current += 1;
          proposalRequestRef.current += 1;

          setBalance(null);
          setPortfolio([]);
          setLivePositions({});

          monitoredContractIdsRef.current.clear();

          setTick(null);
          setProposal(null);
          setProposalParameters(null);
          setAvailableContracts([]);

          setContractsLoading(false);
          setProposalLoading(false);
        }
      },

      onMessage: data => {
        if (data.msg_type === "balance" && data.balance) {
          setBalance(data.balance);
        }

        if (data.msg_type === "portfolio" && data.portfolio) {
          const contracts = data.portfolio.contracts || [];

          setPortfolio(contracts);
          monitorPortfolioPositions(contracts);
        }

        if (data.msg_type === "tick" && data.tick) {
          const incomingTick = data.tick;

          setTick(incomingTick);

          const market = activeMarketRef.current;
          const predictor = getPredictorForMarket(market);
          const digit = predictor.extractDigit(
            incomingTick.quote,
            incomingTick.pip_size
          );

          if (digit !== null) {
            // One-step walk-forward test: the forecast was created from prior
            // ticks; this newly received tick is its unseen evaluation target.
            const accepted = predictor.addTick({ ...incomingTick, symbol: market });

            if (accepted) {
              // Validate one forecast against exactly the fourth subsequent tick.
              const pending = fourTickPendingRef.current;
              if (pending && pending.market === market) {
                pending.remaining -= 1;
                if (pending.remaining <= 0) {
                  const result = {
                    targetDigit: pending.targetDigit,
                    probability: pending.probability,
                    actualDigit: digit,
                    correct: digit === pending.targetDigit,
                    market,
                    timestamp: Date.now()
                  };
                  setFourTickResults(previous => [result, ...previous].slice(0, 100));
                  fourTickPendingRef.current = null;
                  setFourTickForecast(null);
                } else {
                  fourTickPendingRef.current = pending;
                  setFourTickForecast({ ...pending });
                }
              }

              const evaluation = predictor.evaluate(digit);

              if (evaluation) {
                const evaluatedRow = {
                  ...evaluation,
                  market,
                  quote: incomingTick.quote
                };
                setDigitHistory(previous => [evaluatedRow, ...previous].slice(0, 50));
              }

              const prediction = predictor.predict();
              setDigitAnalysis({ ...prediction, currentDigit: digit, market });

              const performance = predictor.getPerformance();
              setDigitPerformance({
                total: performance.total,
                wins: performance.wins,
                losses: performance.losses,
                accuracy: performance.accuracy
              });
              setDigitPerformanceByDigit(predictor.getDigitPerformance());
              setRecentDigitPerformance(predictor.getRecentPerformance(100));
              setReliabilityStatus(predictor.getReliabilityStatus());
              persistPredictor(market, predictor);

              if (!fourTickPendingRef.current && predictor.history?.length >= 200) {
                const forecast = calculateFourTickDigitForecast(
                  predictor.history,
                  selectedTargetDigitRef.current
                );
                if (forecast) {
                  const pendingForecast = {
                    ...forecast,
                    market,
                    remaining: 4
                  };
                  fourTickPendingRef.current = pendingForecast;
                  setFourTickForecast(pendingForecast);
                }
              }

              const marketRows = Object.entries(predictorsByMarketRef.current).map(([marketKey, model]) => {
                const stats = model.getPerformance();
                return {
                  market: marketKey,
                  label: SYMBOLS.find(item => item.value === marketKey)?.label || marketKey,
                  samples: model.history.length,
                  evaluated: stats.total,
                  accuracy: stats.accuracy,
                  status: stats.status
                };
              }).sort((a, b) => b.evaluated - a.evaluated);
              setMarketPerformance(marketRows);
            }
          }
        }

        if (
          data.msg_type === "proposal_open_contract" &&
          data.proposal_open_contract
        ) {
          const contract = data.proposal_open_contract;

          const contractId = String(contract.contract_id || "");

          if (contractId) {
            setLivePositions(previous => ({
              ...previous,
              [contractId]: {
                ...previous[contractId],
                ...contract
              }
            }));

            setPortfolio(previous =>
              previous.map(item =>
                String(item.contract_id) === contractId
                  ? { ...item, ...contract }
                  : item
              )
            );
          }

          setMonitoredContract(contract);

          if (contract.is_sold) {
            monitoredContractIdsRef.current.delete(contractId);

            setPortfolio(previous =>
              previous.filter(
                item => String(item.contract_id) !== contractId
              )
            );

            setNotice(
              `Contract ${contract.contract_id} has settled. Final P/L: ${money(
                contract.profit,
                contract.currency || currency
              )}.`
            );

            Promise.all([
              client.refreshAccount().then(snapshot => {
                setBalance(snapshot.balance);
                setPortfolio(snapshot.portfolio || []);

                monitorPortfolioPositions(
                  snapshot.portfolio || []
                );
              }),

              loadHistory()
            ]).catch(err =>
              console.warn("Post-settlement refresh failed:", err)
            );
          }
        }

        if (data.error) {
          setError(data.error.message || "Deriv API error.");
        }
      }
    });

    clientRef.current = client;

    loadAccounts();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function monitorPortfolioPositions(contracts = []) {
    if (!clientRef.current?.connected || !Array.isArray(contracts)) {
      return;
    }

    for (const item of contracts) {
      const id = String(item?.contract_id || "");

      if (!/^\d+$/.test(id) || monitoredContractIdsRef.current.has(id)) {
        continue;
      }

      monitoredContractIdsRef.current.add(id);

      clientRef.current.monitorContract(id).catch(err => {
        monitoredContractIdsRef.current.delete(id);

        console.warn(
          `Unable to monitor contract ${id}:`,
          err.message
        );
      });
    }
  }

  async function loadAccounts() {
    if (!clientRef.current) return;

    setLoading(true);
    setError("");

    try {
      const list = await clientRef.current.getAccounts();

      const demoAccounts = list.filter(account => {
        const type = String(
          account.account_type || account.type || ""
        ).toLowerCase();

        return (
          type === "demo" ||
          type === "virtual" ||
          account.is_virtual === 1 ||
          account.is_virtual === true
        );
      });

      setAccounts(demoAccounts);

      if (
        accountId &&
        !demoAccounts.some(a => getAccountId(a) === accountId)
      ) {
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
      const contracts =
        await clientRef.current.getAvailableContracts(
          market,
          { force: true }
        );

      if (requestId !== contractsRequestRef.current) {
        return contracts;
      }

      setAvailableContracts(contracts);

      const types = contracts.map(item =>
        String(item.contract_type || "").toUpperCase()
      );

      if (!types.includes(String(contractType).toUpperCase())) {
        const preferred = types.includes("CALL")
          ? "CALL"
          : (types[0] || "");

        if (preferred) setContractType(preferred);
      }

      return contracts;
    } catch (err) {
      if (requestId === contractsRequestRef.current) {
        setAvailableContracts([]);

        setError(
          err.message || `Unable to load contracts for ${market}.`
        );
      }

      return [];
    } finally {
      if (requestId === contractsRequestRef.current) {
        setContractsLoading(false);
      }
    }
  }

  async function loadHistory() {
    if (!clientRef.current?.connected) return;

    try {
      const result =
        await clientRef.current.getProfitTable({
          limit: 50,
          offset: 0
        });

      const transactions =
        result.transactions || result.profit_table || [];

      setHistory(
        Array.isArray(transactions) ? transactions : []
      );
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
      const result =
        await clientRef.current.connect(accountId);

      setBalance(result.balance);
      setPortfolio(result.portfolio || []);
      setLivePositions({});

      monitorPortfolioPositions(result.portfolio || []);

      localStorage.setItem(
        "tradelab_deriv_selected_account",
        accountId
      );

      await loadHistory();
      await loadAvailableContracts(symbol);

      await clientRef.current.subscribeTicks(symbol);

      setNotice(
        "Deriv demo account connected. Market contracts and live ticks are loaded."
      );
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
    setLivePositions({});

    monitoredContractIdsRef.current.clear();

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

    activeMarketRef.current = nextSymbol;
    fourTickPendingRef.current = null;
    setFourTickForecast(null);
    setFourTickResults([]);
    const nextPredictor = getPredictorForMarket(nextSymbol);
    const savedAnalysis = nextPredictor.getLatestAnalysis();
    const savedPerformance = nextPredictor.getPerformance();

    setDigitAnalysis(savedAnalysis ? { ...savedAnalysis, market: nextSymbol } : null);
    setDigitHistory(nextPredictor.getRecentEvaluations(50).map(item => ({ ...item, market: nextSymbol })));
    setDigitPerformance({
      total: savedPerformance.total,
      wins: savedPerformance.wins,
      losses: savedPerformance.losses,
      accuracy: savedPerformance.accuracy
    });
    setDigitPerformanceByDigit(nextPredictor.getDigitPerformance());
    setRecentDigitPerformance(nextPredictor.getRecentPerformance(100));
    setReliabilityStatus(nextPredictor.getReliabilityStatus());
    setMarketPerformance(Object.entries(predictorsByMarketRef.current).map(([marketKey, model]) => {
      const stats = model.getPerformance();
      return {
        market: marketKey,
        label: SYMBOLS.find(item => item.value === marketKey)?.label || marketKey,
        samples: model.history.length,
        evaluated: stats.total,
        accuracy: stats.accuracy,
        status: stats.status
      };
    }).sort((a, b) => b.evaluated - a.evaluated));

    if (!clientRef.current?.connected) return;

    try {
      await Promise.all([
        loadAvailableContracts(nextSymbol),
        clientRef.current.subscribeTicks(nextSymbol)
      ]);

      setNotice(
        `Market changed to ${
          SYMBOLS.find(item => item.value === nextSymbol)?.label ||
          nextSymbol
        }.`
      );
    } catch (err) {
      setError(err.message || "Unable to switch market.");
    }
  }

  async function refreshAccount() {
    if (!connected) return;

    setLoading(true);
    setError("");

    try {
      const snapshot =
        await clientRef.current.refreshAccount();

      setBalance(snapshot.balance);
      setPortfolio(snapshot.portfolio || []);

      monitorPortfolioPositions(snapshot.portfolio || []);

      await loadHistory();

      setNotice("Account information refreshed.");
    } catch (err) {
      setError(err.message || "Account refresh failed.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshAccountAfterTrade() {
    const snapshot =
      await clientRef.current.refreshAccount();

    setBalance(snapshot.balance);
    setPortfolio(snapshot.portfolio || []);

    monitorPortfolioPositions(snapshot.portfolio || []);
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

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_STAKE
    ) {
      setError(
        `Stake must be greater than zero and not exceed ${MAX_STAKE}.`
      );
      return;
    }

    if (
      !Number.isInteger(tradeDuration) ||
      tradeDuration < 1
    ) {
      setError("Enter a valid whole-number trade duration.");
      return;
    }

    const params = {
      symbol,
      contractType,
      amount,
      currency,
      duration: tradeDuration,
      durationUnit,

      ...(parameters.barrier !== undefined &&
      parameters.barrier !== ""
        ? { barrier: parameters.barrier }
        : {}),

      ...(parameters.barrier2 !== undefined &&
      parameters.barrier2 !== ""
        ? { barrier2: parameters.barrier2 }
        : {})
    };

    const requestId = ++proposalRequestRef.current;

    setProposalLoading(true);

    try {
      const quote =
        await clientRef.current.getProposal(params);

      if (requestId !== proposalRequestRef.current) return;

      setProposal(quote);
      setProposalParameters({ ...params });

      setNotice(
        "Proposal received. Review the contract type, barriers and quote before confirming."
      );
    } catch (err) {
      if (requestId === proposalRequestRef.current) {
        setError(err.message || "Unable to obtain proposal.");
      }
    } finally {
      if (requestId === proposalRequestRef.current) {
        setProposalLoading(false);
      }
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

    if (orderLoading) return;

    const p = { ...proposalParameters };

    const marketLabel =
      SYMBOLS.find(item => item.value === p.symbol)?.label ||
      p.symbol;

    const barrierText =
      p.barrier !== undefined
        ? `Barrier: ${p.barrier}${
            p.barrier2 !== undefined
              ? ` to ${p.barrier2}`
              : ""
          }`
        : "";

    setOrderLoading(true);
    setError("");

    setNotice(
      "Requesting a fresh Deriv quote before purchase…"
    );

    try {
      const freshProposal =
        await clientRef.current.getProposal(p);

      if (
        !freshProposal?.id ||
        !Number.isFinite(Number(freshProposal.ask_price)) ||
        Number(freshProposal.ask_price) <= 0
      ) {
        throw new Error(
          "Deriv returned an invalid fresh proposal. Request another quote."
        );
      }

      setProposal(freshProposal);

      const confirmed = window.confirm([
        "CONFIRM DEMO TRADE — FRESH QUOTE",
        "",
        `Market: ${marketLabel}`,
        `Contract: ${getContractTypeLabel(p.contractType)} (${p.contractType})`,
        barrierText,
        `Stake: ${money(freshProposal.ask_price, p.currency)} maximum purchase price`,
        `Potential payout: ${money(freshProposal.payout, p.currency)}`,
        `Duration: ${p.duration} ${p.durationUnit}`,
        "",
        "This is a DEMO trade.",
        "Do you want to continue?"
      ].filter(Boolean).join("\n"));

      if (!confirmed) {
        setNotice(
          "Purchase cancelled. The refreshed quote remains available."
        );
        return;
      }

      const result =
        await clientRef.current.buyDemoProposal(
          freshProposal.id,
          freshProposal.ask_price,
          { confirmed: true }
        );

      setLastOrder(result);

      setProposal(null);
      setProposalParameters(null);

      if (result.contract_id) {
        setMonitoredContract({
          contract_id: result.contract_id,
          status: "Monitoring",
          is_sold: 0
        });

        monitoredContractIdsRef.current.add(
          String(result.contract_id)
        );

        try {
          await clientRef.current.monitorContract(
            result.contract_id
          );
        } catch (monitorError) {
          monitoredContractIdsRef.current.delete(
            String(result.contract_id)
          );

          console.warn(
            "Contract monitoring could not start:",
            monitorError
          );
        }
      }

      const followUpWarnings = [];

      try {
        await refreshAccountAfterTrade();
      } catch (refreshError) {
        followUpWarnings.push("account refresh is pending");
        console.warn(
          "Post-trade account refresh failed:",
          refreshError
        );
      }

      try {
        await loadHistory();
      } catch (historyError) {
        followUpWarnings.push(
          "trade history may need refreshing"
        );

        console.warn(
          "Post-trade history refresh failed:",
          historyError
        );
      }

      setNotice(
        followUpWarnings.length
          ? `Demo purchase confirmed. ${followUpWarnings.join("; ")}.`
          : "Demo purchase confirmed successfully."
      );
    } catch (err) {
      setError(
        err.message || "Demo purchase failed."
      );
    } finally {
      setOrderLoading(false);
    }
  }

  const openPositionStats = portfolio.reduce(
    (stats, position) => {
      const pnl = Number(
        position.profit ??
        (Number(position.bid_price) - Number(position.buy_price))
      );

      if (Number.isFinite(pnl)) {
        stats.totalPnl += pnl;

        if (pnl > 0) stats.profitable += 1;
        else if (pnl < 0) stats.losing += 1;
      }

      return stats;
    },
    {
      totalPnl: 0,
      profitable: 0,
      losing: 0
    }
  );

  return (
    <div
      className="tradelab-digit-workspace"
      style={panelStyle}
    >
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12
      }}>
        <div>
          <h2 style={{ margin: 0 }}>Deriv Live Trading</h2>

          <p style={{
            color: "#91a3bc",
            margin: "6px 0 0"
          }}>
            Authenticated Deriv connection · Forex · Volatility · AI analysis
          </p>
        </div>

        <span style={{
          padding: "8px 12px",
          borderRadius: 20,
          background: connected ? "#103d32" : "#342b1b",
          color: connected ? "#35d6a2" : "#f0bb65",
          fontSize: 12,
          fontWeight: 800
        }}>
          ● {connected ? "CONNECTED — DEMO" : status.toUpperCase()}
        </span>
      </div>

      {error && (
        <div
          role="alert"
          style={{
            ...cardStyle,
            borderColor: "#a94353",
            color: "#ff8997"
          }}
        >
          {error}
        </div>
      )}

      {notice && (
        <div
          role="status"
          style={{
            ...cardStyle,
            borderColor: "#1d8c70",
            color: "#50d6aa"
          }}
        >
          {notice}
        </div>
      )}

      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>
          Demo Account Connection
        </h3>

        <div style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "end"
        }}>
          <div style={{ flex: "1 1 250px" }}>
            <label style={{
              display: "block",
              marginBottom: 8
            }}>
              Select Deriv demo account
            </label>

            <select
              style={inputStyle}
              value={accountId}
              disabled={connected || loading}
              onChange={event =>
                setAccountId(event.target.value)
              }
            >
              <option value="">Select demo account</option>

              {accounts.map(account => (
                <option
                  key={getAccountId(account)}
                  value={getAccountId(account)}
                >
                  {getAccountLabel(account)}
                </option>
              ))}
            </select>
          </div>

          {!connected ? (
            <button
              style={{
                ...buttonStyle,
                background: "#087d69",
                color: "#fff"
              }}
              disabled={loading || !accountId}
              onClick={connectAccount}
            >
              {loading ? "Connecting..." : "Connect Demo Account"}
            </button>
          ) : (
            <>
              <button
                style={{
                  ...buttonStyle,
                  background: "#263b55",
                  color: "#fff"
                }}
                disabled={loading}
                onClick={refreshAccount}
              >
                Refresh Account
              </button>

              <button
                style={{
                  ...buttonStyle,
                  background: "#92384b",
                  color: "#fff"
                }}
                onClick={disconnectAccount}
              >
                Disconnect
              </button>
            </>
          )}

          <button
            style={{
              ...buttonStyle,
              background: "#263b55",
              color: "#fff"
            }}
            onClick={loadAccounts}
            disabled={loading || connected}
          >
            Reload Accounts
          </button>
        </div>

        <p style={{
          color: "#91a3bc",
          fontSize: 12,
          marginBottom: 0
        }}>
          Only Deriv demo accounts are permitted. Real-money execution is disabled.
        </p>
      </section>

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
        gap: 12
      }}>
        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>
            Account Balance
          </div>
          <h2 style={{ marginBottom: 0 }}>
            {balance
              ? money(balance.balance, balance.currency)
              : "—"}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>
            Open Positions
          </div>
          <h2 style={{ marginBottom: 0 }}>
            {portfolio.length}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>
            Current Market
          </div>
          <h2 style={{ marginBottom: 0 }}>
            {selectedMarketLabel}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>
            Live Price
          </div>
          <h2 style={{ marginBottom: 0 }}>
            {tick?.quote !== undefined
              ? Number(tick.quote).toFixed(5)
              : "—"}
          </h2>
        </div>
      </div>

      {/* AI DIGIT MATCH PREDICTOR */}

      <section style={{
        ...cardStyle,
        borderColor: "#087d69",
        background: "linear-gradient(145deg,#111c2d 0%,#0d1a29 100%)"
      }}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10
        }}>
          <div>
            <h3 style={{ margin: 0 }}>
              AI Digit Match Predictor
            </h3>

            <p style={{
              color: "#91a3bc",
              fontSize: 12,
              margin: "6px 0 0"
            }}>
              Live Deriv tick analysis · Statistical digit model · Historical validation
            </p>
          </div>

          <span style={{
            border: "1px solid #236b5a",
            color: "#35d6a2",
            borderRadius: 20,
            padding: "6px 11px",
            fontSize: 11,
            fontWeight: 800
          }}>
            {(digitAnalysis?.samples >= 200)
              ? "MODEL ACTIVE"
              : "COLLECTING TICKS"}
          </span>
        </div>

        {/* TARGET DIGIT */}

        <div style={{
          ...cardStyle,
          marginTop: 14,
          padding: 14,
          borderColor: "#087d69",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 14,
          flexWrap: "wrap"
        }}>
          <div>
            <strong>MY TARGET DIGIT TO MATCH</strong>

            <div style={{
              color: "#91a3bc",
              fontSize: 12,
              marginTop: 5
            }}>
              Choose the exact final digit for the Deriv Matches contract. This is separate from the AI recommendation.
            </div>
          </div>

          <select
            aria-label="Target digit to match"
            value={selectedTargetDigit}
            onChange={event =>
              updateSelectedTargetDigit(event.target.value)
            }
            style={{
              ...inputStyle,
              width: 110,
              fontSize: 20,
              fontWeight: 800,
              textAlign: "center"
            }}
          >
            {Array.from({ length: 10 }, (_, digit) => (
              <option key={digit} value={String(digit)}>
                {digit}
              </option>
            ))}
          </select>
        </div>

        {/* FOUR-TICK DIGIT MATCH FORECAST */}
        <section style={{
          ...cardStyle,
          marginTop: 14,
          borderColor: "#087d69",
          background: "#101d2d",
          color: "#f4f7fb"
        }}>
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>
            4-Tick Digit Match Forecast
          </h3>
          <p style={{ color: "#91a3bc", fontSize: 12, lineHeight: 1.6 }}>
            Estimates the chance that your selected digit appears on the
            fourth future tick specifically—not on ticks one, two, or three.
          </p>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
            gap: 12
          }}>
            <div style={{ ...cardStyle, padding: 13 }}>
              <small style={{ color: "#91a3bc" }}>TARGET FINAL DIGIT</small>
              <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
                {selectedTargetDigit}
              </div>
            </div>
            <div style={{ ...cardStyle, padding: 13 }}>
              <small style={{ color: "#91a3bc" }}>4TH-TICK ESTIMATE</small>
              <div style={{ fontSize: 25, fontWeight: 800, marginTop: 6, color: "#35d6a2" }}>
                {fourTickForecast && fourTickForecast.market === symbol
                  ? `${(fourTickForecast.probability * 100).toFixed(2)}%`
                  : "Collecting"}
              </div>
            </div>
            <div style={{ ...cardStyle, padding: 13 }}>
              <small style={{ color: "#91a3bc" }}>TICKS UNTIL VALIDATION</small>
              <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
                {fourTickForecast?.market === symbol
                  ? fourTickForecast.remaining
                  : "—"}
              </div>
            </div>
            <div style={{ ...cardStyle, padding: 13 }}>
              <small style={{ color: "#91a3bc" }}>VALIDATED FORECASTS</small>
              <div style={{ fontSize: 28, fontWeight: 800, marginTop: 6 }}>
                {fourTickResults.length}
              </div>
            </div>
          </div>
          <div style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 18,
            marginTop: 14,
            color: "#cbd5e1",
            fontSize: 12
          }}>
            <span>Correct: <strong style={{ color: "#35d6a2" }}>
              {fourTickResults.filter(item => item.correct).length}
            </strong></span>
            <span>Incorrect: <strong style={{ color: "#ff8997" }}>
              {fourTickResults.filter(item => !item.correct).length}
            </strong></span>
            <span>Observed hit rate: <strong>
              {fourTickResults.length
                ? `${(fourTickResults.filter(item => item.correct).length / fourTickResults.length * 100).toFixed(2)}%`
                : "—"}
            </strong></span>
            <span>Random baseline: <strong>10%</strong></span>
          </div>
          <p style={{ color: "#91a3bc", fontSize: 11, lineHeight: 1.6, marginBottom: 0 }}>
            Uses a Laplace-smoothed four-step transition model from this market's
            historical digit sequence. Requires at least 200 observations.
            Forecasts are estimates, not guaranteed outcomes or trading instructions.
          </p>
        </section>

        {fourTickResults.length > 0 && (
          <section style={{ ...cardStyle, marginTop: 12 }}>
            <h4 style={{ marginTop: 0 }}>Recent 4-Tick Forecast Results</h4>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 520 }}>
                <thead>
                  <tr>
                    {["Target", "Forecast", "Actual 4th Tick", "Result", "Time"].map(label => (
                      <th key={label} style={{ textAlign: "left", padding: 9, borderBottom: "1px solid #34445c" }}>
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {fourTickResults.filter(item => item.market === symbol).slice(0, 20).map((item, index) => (
                    <tr key={`${item.timestamp}-${index}`}>
                      <td style={{ padding: 9 }}>{item.targetDigit}</td>
                      <td style={{ padding: 9 }}>{(item.probability * 100).toFixed(2)}%</td>
                      <td style={{ padding: 9 }}>{item.actualDigit}</td>
                      <td style={{ padding: 9, color: item.correct ? "#35d6a2" : "#ff8997", fontWeight: 700 }}>
                        {item.correct ? "MATCH" : "NO MATCH"}
                      </td>
                      <td style={{ padding: 9 }}>{new Date(item.timestamp).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* MAIN PREDICTION CARDS */}

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))",
          gap: 12,
          marginTop: 16
        }}>
          <div style={{ ...cardStyle, padding: 14 }}>
            <small style={{ color: "#91a3bc" }}>
              LATEST DIGIT
            </small>

            <div style={{
              fontSize: 32,
              fontWeight: 800,
              marginTop: 5
            }}>
              {digitAnalysis?.currentDigit ?? "—"}
            </div>

            <small style={{ color: "#91a3bc" }}>
              From latest live tick
            </small>
          </div>

          <div style={{
            ...cardStyle,
            padding: 14,
            borderColor: "#087d69"
          }}>
            <small style={{ color: "#91a3bc" }}>
              TOP MATCH CANDIDATE
            </small>

            <div style={{
              fontSize: 32,
              fontWeight: 800,
              color: "#35d6a2",
              marginTop: 5
            }}>
              {(digitAnalysis?.samples >= 200)
                ? digitAnalysis.predictedDigit
                : "—"}
            </div>

            <small style={{ color: "#91a3bc" }}>
              Second candidate:{" "}
              {(digitAnalysis?.samples >= 200)
                ? digitAnalysis.ranking?.[1]?.digit ?? "—"
                : "—"}
            </small>
          </div>

          <div style={{ ...cardStyle, padding: 14 }}>
            <small style={{ color: "#91a3bc" }}>
              MODEL ESTIMATE — UNVALIDATED
            </small>

            <div style={{
              fontSize: 25,
              fontWeight: 800,
              marginTop: 9
            }}>
              {(digitAnalysis?.samples >= 200)
                ? `${(digitAnalysis.probability * 100).toFixed(2)}%`
                : "Pending"}
            </div>

            <small style={{ color: "#91a3bc" }}>
              Statistical estimate, not proven accuracy
            </small>
          </div>

          <div style={{ ...cardStyle, padding: 14 }}>
            <small style={{ color: "#91a3bc" }}>
              TICK OBSERVATIONS
            </small>

            <div style={{
              fontSize: 25,
              fontWeight: 800,
              marginTop: 9
            }}>
              {digitAnalysis?.samples || 0}
            </div>

            <small style={{ color: "#91a3bc" }}>
              Minimum required: 200
            </small>
          </div>
        </div>

        {!(digitAnalysis?.samples >= 200) && (
          <div style={{
            marginTop: 14,
            padding: 13,
            borderRadius: 9,
            background: "#241f16",
            border: "1px solid #66502a",
            color: "#f0bb65",
            fontSize: 12
          }}>
            Collecting observations. The statistical model becomes available after at least 200 valid ticks.

            Current progress:{" "}
            {digitAnalysis?.samples || 0} /{" "}
            {digitAnalysis?.required || 200}.

            <div style={{
              height: 7,
              borderRadius: 8,
              background: "#3a3020",
              marginTop: 9,
              overflow: "hidden"
            }}>
              <div style={{
                width: `${
                  Math.min(
                    100,
                    ((digitAnalysis?.samples || 0) /
                      (digitAnalysis?.required || 200)) * 100
                  )
                }%`,
                height: "100%",
                background: "#e5a83e"
              }} />
            </div>
          </div>
        )}

        {/* HISTORICAL DIGIT DISTRIBUTION */}

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))",
          gap: 14,
          marginTop: 16
        }}>
          <div style={{ ...cardStyle, padding: 14 }}>
            <h4 style={{ margin: "0 0 12px" }}>
              Digit Probability Distribution
            </h4>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(5,minmax(0,1fr))",
              gap: 7
            }}>
              {(
                digitAnalysis?.distribution ||
                Array.from(
                  { length: 10 },
                  (_, digit) => ({
                    digit,
                    probability: 0
                  })
                )
              ).map(item => {
                const isTop =
                  (digitAnalysis?.samples >= 200) &&
                  item.digit === digitAnalysis.predictedDigit;

                return (
                  <div
                    key={item.digit}
                    style={{
                      padding: "9px 5px",
                      borderRadius: 8,
                      textAlign: "center",
                      background: isTop ? "#103d32" : "#0b1422",
                      border: isTop
                        ? "1px solid #35d6a2"
                        : "1px solid #26364d"
                    }}
                  >
                    <strong style={{ fontSize: 17 }}>
                      {item.digit}
                    </strong>

                    <div style={{
                      color: isTop ? "#35d6a2" : "#91a3bc",
                      fontSize: 11,
                      marginTop: 4
                    }}>
                      {(item.probability * 100).toFixed(1)}%
                    </div>
                  </div>
                );
              })}
            </div>

            <small style={{
              color: "#91a3bc",
              display: "block",
              marginTop: 10
            }}>
              Smoothed historical frequency; not a next-tick guarantee.
            </small>
          </div>

          {/* MODEL RANKINGS */}

          <div style={{ ...cardStyle, padding: 14 }}>
            <h4 style={{ margin: "0 0 12px" }}>
              Weighted Ensemble Ranking
            </h4>

            {(digitAnalysis?.ranking || [])
              .slice(0, 5)
              .map((item, index) => (
                <div
                  key={item.digit}
                  style={{ marginBottom: 10 }}
                >
                  <div style={{
                    display: "flex",
                    justifyContent: "space-between",
                    fontSize: 12,
                    marginBottom: 5
                  }}>
                    <strong>
                      #{index + 1} · Digit {item.digit}
                    </strong>

                    <span style={{ color: "#35d6a2" }}>
                      {(item.probability * 100).toFixed(2)}%
                    </span>
                  </div>

                  <div style={{
                    height: 7,
                    borderRadius: 8,
                    background: "#26364d",
                    overflow: "hidden"
                  }}>
                    <div style={{
                      width: `${Math.min(100, item.probability * 100)}%`,
                      height: "100%",
                      background: index === 0
                        ? "#35d6a2"
                        : "#477f91"
                    }} />
                  </div>
                </div>
              ))}

            {!(digitAnalysis?.samples >= 200) && (
              <p style={{
                color: "#91a3bc",
                fontSize: 12
              }}>
                Rankings will appear when the model has enough observations.
              </p>
            )}
          </div>
        </div>

        {/* PHASE 3: MULTI-MODEL BREAKDOWN */}

        <h4 style={{ margin: "20px 0 10px" }}>
          Phase 3 — Individual Model Intelligence
        </h4>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
          gap: 12
        }}>
          {[
            { name: "Historical Frequency", key: "frequency", description: "Smoothed distribution across all collected ticks." },
            { name: "Markov Transition", key: "markov", description: "Conditional distribution after the latest observed digit." },
            { name: "Recent Trend", key: "trend", description: "Compares the recent 100 ticks with the longer 1,000-tick sample." }
          ].map(model => {
            const data = digitAnalysis?.modelBreakdown?.[model.key];
            const values = data?.probabilities || [];
            const ranked = values.map((probability, digit) => ({ digit, probability }))
              .sort((a, b) => b.probability - a.probability);
            const leader = ranked[0];

            return (
              <div key={model.key} style={{ ...cardStyle, padding: 14, background: "#0b1422", color: "#fff", borderColor: "#26364d" }}>
                <strong>{model.name}</strong>
                <div style={{ color: "#91a3bc", fontSize: 11, marginTop: 5 }}>{model.description}</div>
                <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ color: "#91a3bc", fontSize: 12 }}>Model weight</span>
                  <strong>{data ? `${(data.weight * 100).toFixed(0)}%` : "—"}</strong>
                </div>
                <div style={{ marginTop: 8, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ color: "#91a3bc", fontSize: 12 }}>Leading digit</span>
                  <strong style={{ color: "#35d6a2" }}>{leader ? leader.digit : "—"}</strong>
                </div>
                <div style={{ marginTop: 5, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span style={{ color: "#91a3bc", fontSize: 12 }}>Model estimate</span>
                  <strong>{leader ? `${(leader.probability * 100).toFixed(2)}%` : "—"}</strong>
                </div>
                {model.key === "markov" && (
                  <div style={{ marginTop: 5, color: "#91a3bc", fontSize: 11 }}>
                    Transition observations: {data?.observations ?? 0}
                  </div>
                )}
              </div>
            );
          })}
        </div>

       <div style={{ ...cardStyle, marginTop: 12, background: "#0b1422", color: "#fff", borderColor: "#087d69" }}>
          <h4 style={{ margin: "0 0 10px" }}>Weighted Ensemble & Reliability Filter</h4>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>

            <div>
              <small style={{ color: "#91a3bc" }}>Top candidate</small>
              <div style={{ fontSize: 25, fontWeight: 800, color: "#35d6a2" }}>
                {digitAnalysis?.samples >= 200 ? digitAnalysis.predictedDigit : "—"}
              </div>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Ensemble estimate — unvalidated</small>
              <div style={{ fontSize: 21, fontWeight: 800 }}>
                {typeof digitAnalysis?.percentage === "number" &&
                Number.isFinite(digitAnalysis.percentage)
                  ? `${digitAnalysis.percentage.toFixed(2)}%`
                  : "Collecting data..."}
              </div>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Data reliability</small>
              <div style={{ fontSize: 16, fontWeight: 800 }}>
                {digitAnalysis?.reliability || "COLLECTING DATA"}
              </div>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>System guidance</small>
              <div style={{ fontSize: 16, fontWeight: 800, color: "#f0bb65" }}>
                {digitAnalysis?.recommendation || "WAIT"}
              </div>
            </div>

          </div>

          <p style={{ color: "#91a3bc", fontSize: 11, lineHeight: 1.6, marginBottom: 0 }}>
            The reliability label describes data availability, not proven forecast accuracy. The ensemble estimate is not a calibrated probability of the next digit and is not a trade instruction.
          </p>
        </div>

        {/* NEW MULTI-WINDOW INTELLIGENCE */}

        <h4 style={{ margin: "20px 0 10px" }}>
          Multi-Window Probability Intelligence
        </h4>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
          gap: 12
        }}>
          {(digitAnalysis?.windows || []).map(windowData => {
            const topDigit = [
              ...(windowData.distribution || [])
            ].sort(
              (a, b) => b.probability - a.probability
            )[0];

            return (
              <div
                key={windowData.window}
                style={{
                  ...cardStyle,
                  padding: 14
                }}
              >
                <div style={{
                  color: "#91a3bc",
                  fontSize: 12,
                  fontWeight: 700
                }}>
                  LAST {windowData.window.toLocaleString()} TICKS
                </div>

                <div style={{
                  fontSize: 23,
                  fontWeight: 800,
                  marginTop: 8
                }}>
                  {windowData.samples.toLocaleString()}
                </div>

                <small style={{ color: "#91a3bc" }}>
                  Observations collected
                </small>

                {topDigit && (
                  <div style={{
                    marginTop: 12,
                    paddingTop: 10,
                    borderTop: "1px solid #26364d"
                  }}>
                    <div style={{
                      color: "#91a3bc",
                      fontSize: 11
                    }}>
                      MOST FREQUENT DIGIT
                    </div>

                    <strong style={{
                      fontSize: 25,
                      color: "#35d6a2"
                    }}>
                      {topDigit.digit}
                    </strong>

                    <div style={{ fontSize: 13 }}>
                      Historical frequency:{" "}
                      {(topDigit.probability * 100).toFixed(2)}%
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <p style={{
          color: "#91a3bc",
          fontSize: 11,
          lineHeight: 1.6
        }}>
          These windows compare historical digit frequencies over different sample sizes. A frequent digit is not necessarily more likely to appear on the next tick.
        </p>

        {/* PREDICTION PERFORMANCE */}

        <h4 style={{ margin: "18px 0 10px" }}>
          Prediction Performance
        </h4>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))",
          gap: 10
        }}>
          {[
            ["Evaluated", digitPerformance.total],
            ["Correct", digitPerformance.wins],
            ["Incorrect", digitPerformance.losses],
            [
              "Historical accuracy",
              `${digitPerformance.accuracy.toFixed(2)}%`
            ]
          ].map(([label, value]) => (
            <div
              key={label}
              style={{ ...cardStyle, padding: 12 }}
            >
              <small style={{ color: "#91a3bc" }}>
                {label}
              </small>

              <div style={{
                fontSize: 21,
                fontWeight: 800,
                marginTop: 5
              }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* PHASE 4: WALK-FORWARD VALIDATION */}
        <h4 style={{ margin: "20px 0 10px" }}>
          Phase 4 — Walk-Forward Reliability Validation
        </h4>
        <div style={{
          ...cardStyle,
          padding: 14,
          background: "#0b1422",
          color: "#fff",
          borderColor: "#087d69"
        }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 }}>
            <div><small style={{ color: "#91a3bc" }}>Evaluated next-tick forecasts</small><div style={{ fontSize: 22, fontWeight: 800 }}>{reliabilityStatus?.total || 0}</div></div>
            <div><small style={{ color: "#91a3bc" }}>Observed accuracy</small><div style={{ fontSize: 22, fontWeight: 800 }}>{(reliabilityStatus?.accuracy || 0).toFixed(2)}%</div></div>
            <div><small style={{ color: "#91a3bc" }}>Difference vs 10% baseline</small><div style={{ fontSize: 22, fontWeight: 800 }}>{reliabilityStatus ? `${reliabilityStatus.baselineDifference >= 0 ? "+" : ""}${reliabilityStatus.baselineDifference.toFixed(2)} pp` : "—"}</div></div>
            <div><small style={{ color: "#91a3bc" }}>95% Wilson interval</small><div style={{ fontSize: 16, fontWeight: 800 }}>{reliabilityStatus?.confidenceInterval95 ? `${reliabilityStatus.confidenceInterval95.low.toFixed(2)}% – ${reliabilityStatus.confidenceInterval95.high.toFixed(2)}%` : "Not available"}</div></div>
          </div>
          <div style={{ marginTop: 12, padding: 10, borderRadius: 8, background: "#17263a", color: "#f0bb65", fontWeight: 800 }}>
            VALIDATION: {reliabilityStatus?.status || "INSUFFICIENT EVALUATIONS"}
          </div>
          <p style={{ color: "#91a3bc", fontSize: 11, lineHeight: 1.6, marginBottom: 0 }}>
            Each forecast is scored against the next accepted live tick, without using that tick to create the forecast. At least 100 evaluations are required before classification. The Wilson interval is descriptive; serial dependence between ticks can make it optimistic, so an above-baseline label is not proof of a durable trading edge.
          </p>
        </div>

        <h4 style={{ margin: "18px 0 8px" }}>Accuracy by Predicted Digit</h4>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
            <thead><tr>{["Predicted digit", "Evaluations", "Correct", "Accuracy", "95% interval", "Assessment"].map(label => <th key={label} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #34445c", fontSize: 11 }}>{label}</th>)}</tr></thead>
            <tbody>{(digitPerformanceByDigit.length ? digitPerformanceByDigit : Array.from({ length: 10 }, (_, digit) => ({ digit, total: 0, wins: 0, accuracy: 0, confidenceInterval95: null, status: "NO DATA" }))).map(row => <tr key={row.digit}>
              <td style={{ padding: 8 }}>{row.digit}</td><td style={{ padding: 8 }}>{row.total}</td><td style={{ padding: 8 }}>{row.wins}</td><td style={{ padding: 8 }}>{row.total ? `${row.accuracy.toFixed(2)}%` : "—"}</td>
              <td style={{ padding: 8, fontSize: 11 }}>{row.confidenceInterval95 && row.total ? `${row.confidenceInterval95.low.toFixed(1)}–${row.confidenceInterval95.high.toFixed(1)}%` : "—"}</td>
              <td style={{ padding: 8, color: row.status === "ABOVE BASELINE OBSERVED" ? "#35d6a2" : row.status === "BELOW BASELINE OBSERVED" ? "#ff8997" : "#f0bb65", fontSize: 11 }}>{row.status}</td>
            </tr>)}</tbody>
          </table>
        </div>

        <h4 style={{ margin: "18px 0 8px" }}>Performance by Market</h4>
        {marketPerformance.length === 0 ? <p style={{ color: "#91a3bc", fontSize: 12 }}>Market comparisons will populate as each market receives live ticks and evaluated forecasts.</p> : <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
            <thead><tr>{["Market", "Ticks", "Evaluations", "Accuracy", "Validation status"].map(label => <th key={label} style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #34445c", fontSize: 11 }}>{label}</th>)}</tr></thead>
            <tbody>{marketPerformance.map(row => <tr key={row.market}>
              <td style={{ padding: 8 }}>{row.label}</td><td style={{ padding: 8 }}>{row.samples}</td><td style={{ padding: 8 }}>{row.evaluated}</td><td style={{ padding: 8 }}>{row.evaluated ? `${row.accuracy.toFixed(2)}%` : "—"}</td><td style={{ padding: 8, color: row.status.includes("ABOVE") ? "#35d6a2" : row.status.includes("BELOW") ? "#ff8997" : "#f0bb65", fontSize: 11 }}>{row.status}</td>
            </tr>)}</tbody>
          </table>
        </div>}

        <div style={{ marginTop: 12, padding: 12, borderRadius: 9, background: "#17263a", color: "#91a3bc", fontSize: 11, lineHeight: 1.6 }}>
          Recent 100 forecast accuracy: <strong style={{ color: "#fff" }}>{recentDigitPerformance.total ? `${recentDigitPerformance.accuracy.toFixed(2)}%` : "No evaluated forecasts yet"}</strong>. Results are retained separately by market in this browser. Clearing browser storage removes this local validation history.
        </div>

        <h4 style={{ margin: "18px 0 8px" }}>
          Recent Evaluated Predictions
        </h4>

        {digitHistory.length === 0 ? (
          <p style={{
            color: "#91a3bc",
            fontSize: 12
          }}>
            No evaluated predictions yet. Results will appear after a prediction is compared with the next observed tick.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              minWidth: 430
            }}>
              <thead>
                <tr>
                  {[
                    "Predicted",
                    "Actual",
                    "Outcome",
                    "Time"
                  ].map(label => (
                    <th
                      key={label}
                      style={{
                        textAlign: "left",
                        padding: 9,
                        borderBottom: "1px solid #34445c",
                        fontSize: 12
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {digitHistory.map((item, index) => (
                  <tr key={`${item.timestamp}-${index}`}>
                    <td style={{ padding: 9 }}>
                      {item.predictedDigit}
                    </td>

                    <td style={{ padding: 9 }}>
                      {item.actualDigit}
                    </td>

                    <td style={{
                      padding: 9,
                      color: item.correct
                        ? "#35d6a2"
                        : "#ff8997",
                      fontWeight: 700
                    }}>
                      {item.correct ? "CORRECT" : "INCORRECT"}
                    </td>

                    <td style={{
                      padding: 9,
                      color: "#91a3bc",
                      fontSize: 11
                    }}>
                      {new Date(
                        item.timestamp
                      ).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p style={{
          color: "#91a3bc",
          fontSize: 11,
          lineHeight: 1.6,
          marginBottom: 0
        }}>
          This ensemble combines historical frequency, Markov transitions and recent trend estimates. Scores are statistical estimates, not guaranteed outcomes. A 10% random baseline applies to an unbiased ten-digit outcome.
        </p>
      </section>

      {/* DERIV BOT BUILDER */}

      <DerivBotBuilder
        connected={connected}
        symbol={symbol}
        changeMarket={changeMarket}
        contractType={contractType}
        setContractType={value => {
          proposalRequestRef.current += 1;
          setContractType(value);
          setProposal(null);
          setProposalParameters(null);
          setProposalLoading(false);
        }}
        duration={duration}
        setDuration={value => {
          proposalRequestRef.current += 1;
          setDuration(value);
          setProposal(null);
          setProposalParameters(null);
          setProposalLoading(false);
        }}
        durationUnit={durationUnit}
        setDurationUnit={value => {
          proposalRequestRef.current += 1;
          setDurationUnit(value);
          setProposal(null);
          setProposalParameters(null);
          setProposalLoading(false);
        }}
        stake={stake}
        setStake={value => {
          proposalRequestRef.current += 1;
          setStake(value);
          setProposal(null);
          setProposalParameters(null);
          setProposalLoading(false);
        }}
        availableContracts={availableContracts}
        contractsLoading={contractsLoading}
        marketOptions={SYMBOLS}
        onPrepareTrade={requestProposal}
        onExecuteTrade={executeDemoTrade}
        proposal={proposal}
        orderLoading={orderLoading}
        proposalLoading={proposalLoading}
        currency={currency}
        selectedDigit={selectedTargetDigit}
        onSelectedDigitChange={updateSelectedTargetDigit}
        tick={tick}
        digitAnalysis={digitAnalysis}
      />

      {/* LATEST DEMO ORDER */}

      {lastOrder && (
        <section style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>
            Latest Demo Order
          </h3>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "7px 0"
          }}>
            <span>Contract ID</span>
            <strong>{lastOrder.contract_id}</strong>
          </div>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "7px 0"
          }}>
            <span>Purchase Price</span>
            <strong>
              {money(lastOrder.buy_price, currency)}
            </strong>
          </div>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "7px 0"
          }}>
            <span>Potential Payout</span>
            <strong>
              {money(lastOrder.payout, currency)}
            </strong>
          </div>
        </section>
      )}

      {/* CONTRACT MONITORING */}

      {monitoredContract && (
        <section style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>
            Contract Monitoring
          </h3>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "7px 0"
          }}>
            <span>Contract ID</span>
            <strong>{monitoredContract.contract_id}</strong>
          </div>

          <div style={{
            display: "flex",
            justifyContent: "space-between",
            padding: "7px 0"
          }}>
            <span>Status</span>
            <strong>
              {monitoredContract.is_sold
                ? "SETTLED"
                : "OPEN / MONITORING"}
            </strong>
          </div>

          {monitoredContract.profit !== undefined && (
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "7px 0"
            }}>
              <span>Profit / Loss</span>

              <strong style={{
                color: Number(monitoredContract.profit) >= 0
                  ? "#35d6a2"
                  : "#ff8997"
              }}>
                {money(
                  monitoredContract.profit,
                  currency
                )}
              </strong>
            </div>
          )}

          {monitoredContract.exit_tick !== undefined && (
            <div style={{
              display: "flex",
              justifyContent: "space-between",
              padding: "7px 0"
            }}>
              <span>Exit Price</span>
              <strong>{monitoredContract.exit_tick}</strong>
            </div>
          )}
        </section>
      )}

      {/* OPEN POSITIONS */}

      <section style={cardStyle}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap"
        }}>
          <div>
            <h3 style={{ margin: 0 }}>
              Open Positions
            </h3>

            <small style={{ color: "#91a3bc" }}>
              Live contract values and unrealised profit/loss from Deriv
            </small>
          </div>

          <button
            style={{
              ...buttonStyle,
              background: "#263b55",
              color: "#fff"
            }}
            disabled={!connected || loading}
            onClick={refreshAccount}
          >
            Refresh Positions
          </button>
        </div>

        {portfolio.length > 0 && (
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))",
            gap: 10,
            marginTop: 14
          }}>
            <div style={{ ...cardStyle, padding: 12 }}>
              <small style={{ color: "#91a3bc" }}>
                Total open P/L
              </small>

              <div style={{
                fontSize: 20,
                fontWeight: 800,
                color: openPositionStats.totalPnl >= 0
                  ? "#35d6a2"
                  : "#ff8997",
                marginTop: 5
              }}>
                {money(openPositionStats.totalPnl, currency)}
              </div>
            </div>

            <div style={{ ...cardStyle, padding: 12 }}>
              <small style={{ color: "#91a3bc" }}>
                Profitable positions
              </small>

              <div style={{
                fontSize: 20,
                fontWeight: 800,
                color: "#35d6a2",
                marginTop: 5
              }}>
                {openPositionStats.profitable}
              </div>
            </div>

            <div style={{ ...cardStyle, padding: 12 }}>
              <small style={{ color: "#91a3bc" }}>
                Losing positions
              </small>

              <div style={{
                fontSize: 20,
                fontWeight: 800,
                color: "#ff8997",
                marginTop: 5
              }}>
                {openPositionStats.losing}
              </div>
            </div>
          </div>
        )}

        {portfolio.length === 0 ? (
          <p style={{ color: "#91a3bc" }}>
            No open positions returned by Deriv.
          </p>
        ) : (
          <div style={{
            overflowX: "auto",
            marginTop: 12
          }}>
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              minWidth: 850
            }}>
              <thead>
                <tr>
                  {[
                    "Contract ID",
                    "Market",
                    "Contract",
                    "Stake",
                    "Current Value",
                    "Profit / Loss",
                    "Position Status"
                  ].map(label => (
                    <th
                      key={label}
                      style={{
                        textAlign: "left",
                        padding: 10,
                        borderBottom: "1px solid #34445c",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {portfolio.map((item, index) => {
                  const id = String(item.contract_id || "");
                  const live = livePositions[id] || {};

                  const position = {
                    ...item,
                    ...live
                  };

                  const pnl = Number(
                    position.profit ??
                    (
                      Number(position.bid_price) -
                      Number(position.buy_price)
                    )
                  );

                  const hasPnl = Number.isFinite(pnl);

                  const statusLabel = position.is_sold
                    ? "SETTLED"
                    : !hasPnl
                      ? "UPDATING"
                      : pnl > 0
                        ? "PROFITABLE"
                        : pnl < 0
                          ? "LOSING"
                          : "BREAK-EVEN";

                  const pnlColor = !hasPnl
                    ? "#91a3bc"
                    : pnl >= 0
                      ? "#35d6a2"
                      : "#ff8997";

                  const marketName =
                    SYMBOLS.find(
                      option =>
                        option.value ===
                        (position.underlying || position.symbol)
                    )?.label ||
                    position.underlying ||
                    position.symbol ||
                    "—";

                  return (
                    <tr key={id || index}>
                      <td style={{
                        padding: 10,
                        whiteSpace: "nowrap"
                      }}>
                        {id || "—"}
                      </td>

                      <td style={{ padding: 10 }}>
                        {marketName}
                      </td>

                      <td style={{ padding: 10 }}>
                        {getContractTypeLabel(
                          position.contract_type ||
                          position.contract_type_name ||
                          "—"
                        )}
                      </td>

                      <td style={{ padding: 10 }}>
                        {money(
                          position.buy_price,
                          position.currency || currency
                        )}
                      </td>

                      <td style={{ padding: 10 }}>
                        {position.bid_price !== undefined
                          ? money(
                              position.bid_price,
                              position.currency || currency
                            )
                          : "Waiting for live update…"}
                      </td>

                      <td style={{
                        padding: 10,
                        color: pnlColor,
                        fontWeight: 800
                      }}>
                        {hasPnl
                          ? money(
                              pnl,
                              position.currency || currency
                            )
                          : "Waiting for live update…"}
                      </td>

                      <td style={{
                        padding: 10,
                        color: position.is_sold
                          ? "#91a3bc"
                          : pnlColor,
                        fontWeight: 800
                      }}>
                        {statusLabel}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <p style={{
          color: "#91a3bc",
          fontSize: 11,
          marginBottom: 0
        }}>
          Profit/loss is unrealised while a contract is open and can change until settlement. Deriv's final result is shown in Trade History after the contract closes.
        </p>
      </section>

      {/* TRADE HISTORY */}

      <section style={cardStyle}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
          <h3>Trade History</h3>

          <button
            style={{
              ...buttonStyle,
              background: "#263b55",
              color: "#fff"
            }}
            disabled={!connected}
            onClick={loadHistory}
          >
            Refresh History
          </button>
        </div>

        {history.length === 0 ? (
          <p style={{ color: "#91a3bc" }}>
            No completed trades returned yet.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              minWidth: 550
            }}>
              <thead>
                <tr>
                  {[
                    "Contract",
                    "Market",
                    "Buy Price",
                    "Sell Price",
                    "Profit"
                  ].map(label => (
                    <th
                      key={label}
                      style={{
                        textAlign: "left",
                        padding: 10,
                        borderBottom: "1px solid #34445c"
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {history.map((item, index) => (
                  <tr key={item.contract_id || index}>
                    <td style={{ padding: 10 }}>
                      {item.contract_id || "—"}
                    </td>

                    <td style={{ padding: 10 }}>
                      {item.underlying || item.symbol || "—"}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.buy_price, currency)}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.sell_price, currency)}
                    </td>

                    <td style={{
                      padding: 10,
                      color: Number(item.profit) >= 0
                        ? "#35d6a2"
                        : "#ff8997"
                    }}>
                      {money(item.profit, currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* SAFEGUARDS */}

      <div style={{
        ...cardStyle,
        borderColor: "#755c2b",
        color: "#f0bb65",
        fontSize: 12,
        lineHeight: 1.7
      }}>
        <strong>Demo Trading Safeguards</strong>

        <p style={{ marginBottom: 0 }}>
          TradeLab currently restricts this interface to demo accounts and a maximum $10 stake. Server-side execution controls must also enforce these limits. Real-money trading remains disabled.
        </p>
      </div>
    </div>
  );
}

export default DerivLivePanel;
