mport React, { useEffect, useRef, useState } from "react";
import DerivClient from "./derivClient";
import DigitMatchPredictor from "./digitMatchPredictor";
import DerivBotBuilder from "./DerivBotBuilder";

const MAX_STAKE = 10;

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
  color: "#e7edf7",
  width: "100%",
  display: "grid",
  gap: 18
};

const cardStyle = {
  background: "#111c2d",
  border: "1px solid #26364d",
  borderRadius: 14,
  padding: 18
};

const buttonStyle = {
  border: 0,
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 700,
  cursor: "pointer"
};

const inputStyle = {
  width: "100%",
  background: "#0b1422",
  color: "#e7edf7",
  border: "1px solid #34445c",
  borderRadius: 8,
  padding: "11px 12px",
  outline: "none",
  boxSizing: "border-box"
};

const money = (value, currency = "USD") => {
  const number = Number(value);

  if (!Number.isFinite(number)) return "—";

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(number);
};

function getAccountId(account) {
  return (
    account?.account_id ||
    account?.id ||
    account?.loginid ||
    ""
  );
}

function getAccountLabel(account) {
  const id = getAccountId(account);

  return [
    id,
    account?.currency || "USD",
    "DEMO"
  ].filter(Boolean).join(" · ");
}

function DerivLivePanel() {
  const clientRef = useRef(null);

  // DIGIT MATCH PREDICTION ENGINE

  const digitPredictorRef = useRef(
    new DigitMatchPredictor({
      maxHistory: 5000,
      minSamples: 200
    })
  );

  const [digitAnalysis, setDigitAnalysis] = useState(null);

  const [digitPerformance, setDigitPerformance] = useState({
    total: 0,
    wins: 0,
    losses: 0,
    accuracy: 0
  });

  const [digitHistory, setDigitHistory] = useState([]);

  // DERIV CONNECTION

  const [status, setStatus] = useState("disconnected");
  const [accounts, setAccounts] = useState([]);

  const [accountId, setAccountId] = useState(
    () =>
      localStorage.getItem("tradelab_deriv_selected_account") || ""
  );

  // ACCOUNT DATA

  const [balance, setBalance] = useState(null);
  const [portfolio, setPortfolio] = useState([]);
  const [history, setHistory] = useState([]);

  // MARKET DATA

  const [symbol, setSymbol] = useState("frxEURUSD");
  const [tick, setTick] = useState(null);

  // TRADE SETTINGS

  const [stake, setStake] = useState("1");
  const [contractType, setContractType] = useState("CALL");
  const [duration, setDuration] = useState("5");
  const [durationUnit, setDurationUnit] = useState("m");

  // PROPOSAL AND EXECUTION

  const [proposal, setProposal] = useState(null);
  const [lastOrder, setLastOrder] = useState(null);
  const [monitoredContract, setMonitoredContract] = useState(null);

  // STATUS

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

  /* ======================================================
     CLIENT INITIALIZATION
     ====================================================== */

  useEffect(() => {
    const client = new DerivClient({
      onStatus: event => {
        setStatus(event.state || "disconnected");

        if (event.state === "error") {
          setError(event.error || "Deriv connection error.");
        }

        if (event.state === "disconnected") {
          setBalance(null);
          setPortfolio([]);
          setTick(null);
          setProposal(null);
        }
      },

      onMessage: data => {
        // BALANCE

        if (data.msg_type === "balance" && data.balance) {
          setBalance(data.balance);
        }

        // PORTFOLIO

        if (data.msg_type === "portfolio" && data.portfolio) {
          setPortfolio(data.portfolio.contracts || []);
        }

        // LIVE TICKS AND DIGIT PREDICTION

        if (data.msg_type === "tick" && data.tick) {
          const incomingTick = data.tick;

          setTick(incomingTick);

          const predictor = digitPredictorRef.current;

          const digit = predictor.extractDigit(
            incomingTick.quote,
            incomingTick.pip_size
          );

          if (digit !== null) {
            // Evaluate the previous prediction using
            // the newly received market digit.

            const evaluation = predictor.evaluate(digit);

            if (evaluation) {
              setDigitHistory(previous => [
                {
                  ...evaluation,
                  quote: incomingTick.quote
                },
                ...previous
              ].slice(0, 50));
            }

            // Add the current tick to the observation history.

            predictor.addTick(incomingTick);

            // Generate the next prediction.

            const prediction = predictor.predict();

            setDigitAnalysis({
              ...prediction,
              currentDigit: digit
            });

            setDigitPerformance(
              predictor.getPerformance()
            );
          }
        }

        // CONTRACT MONITORING

        if (
          data.msg_type === "proposal_open_contract" &&
          data.proposal_open_contract
        ) {
          const contract = data.proposal_open_contract;

          setMonitoredContract(contract);

          if (contract.is_sold) {
            setNotice(
              `Contract ${contract.contract_id} has settled.`
            );

            client.refreshAccount()
              .then(snapshot => {
                setBalance(snapshot.balance);
                setPortfolio(snapshot.portfolio);
              })
              .catch(err => {
                console.warn(
                  "Account refresh failed:",
                  err
                );
              });
          }
        }

        // API ERRORS

        if (data.error) {
          setError(
            data.error.message || "Deriv API error."
          );
        }
      }
    });

    clientRef.current = client;

    loadAccounts();

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  /* ======================================================
     ACCOUNT LOADING
     ====================================================== */

  async function loadAccounts() {
    setLoading(true);
    setError("");

    try {
      const list = await clientRef.current.getAccounts();

      const demoAccounts = list.filter(account => {
        const type = String(
          account.account_type ||
          account.type ||
          ""
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
        !demoAccounts.some(
          a => getAccountId(a) === accountId
        )
      ) {
        setAccountId("");

        localStorage.removeItem(
          "tradelab_deriv_selected_account"
        );
      }
    } catch (err) {
      setError(
        err.message || "Unable to load Deriv accounts."
      );
    } finally {
      setLoading(false);
    }
  }

  /* ======================================================
     CONNECT ACCOUNT
     ====================================================== */

  async function connectAccount() {
    if (!accountId) {
      setError("Select a demo account first.");
      return;
    }

    setLoading(true);
    setError("");
    setNotice("");
    setProposal(null);

    try {
      const result = await clientRef.current.connect(accountId);

      setBalance(result.balance);
      setPortfolio(result.portfolio || []);

      localStorage.setItem(
        "tradelab_deriv_selected_account",
        accountId
      );

      await loadHistory();

      setNotice(
        "Deriv demo account connected successfully."
      );
    } catch (err) {
      setError(
        err.message || "Unable to connect Deriv account."
      );
    } finally {
      setLoading(false);
    }
  }

  /* ======================================================
     DISCONNECT
     ====================================================== */

  function disconnectAccount() {
    clientRef.current?.disconnect();

    setBalance(null);
    setPortfolio([]);
    setHistory([]);
    setTick(null);
    setProposal(null);
    setMonitoredContract(null);
    setLastOrder(null);

    setNotice("Deriv account disconnected.");
    setError("");
  }

  /* ======================================================
     MARKET SUBSCRIPTION
     ====================================================== */

  async function changeMarket(nextSymbol) {
    setSymbol(nextSymbol);
    setTick(null);
    setProposal(null);

    // Reset digit statistics when switching markets.

    digitPredictorRef.current.reset();

    setDigitAnalysis(null);
    setDigitHistory([]);

    setDigitPerformance({
      total: 0,
      wins: 0,
      losses: 0,
      accuracy: 0
    });

    if (!connected) return;

    try {
      await clientRef.current.subscribeTicks(nextSymbol);
    } catch (err) {
      setError(err.message);
    }
  }

  useEffect(() => {
    if (!connected) return;

    changeMarket(symbol);

    // Re-subscribe when the connection becomes active.

  }, [connected]);

  /* ======================================================
     ACCOUNT REFRESH
     ====================================================== */

  async function refreshAccount() {
    if (!connected) return;

    setLoading(true);
    setError("");

    try {
      const snapshot =
        await clientRef.current.refreshAccount();

      setBalance(snapshot.balance);
      setPortfolio(snapshot.portfolio);

      await loadHistory();

      setNotice("Account information refreshed.");
    } catch (err) {
      setError(
        err.message || "Account refresh failed."
      );
    } finally {
      setLoading(false);
    }
  }

  /* ======================================================
     TRADE HISTORY
     ====================================================== */

  async function loadHistory() {
    if (!clientRef.current?.connected) return;

    try {
      const result =
        await clientRef.current.getProfitTable({
          limit: 50,
          offset: 0
        });

      const transactions =
        result.transactions ||
        result.profit_table ||
        [];

      setHistory(
        Array.isArray(transactions)
          ? transactions
          : []
      );
    } catch (err) {
      console.warn(
        "Profit table unavailable:",
        err.message
      );
    }
  }

  /* ======================================================
     REQUEST PROPOSAL
     ====================================================== */

  async function requestProposal() {
    if (!connected) {
      setError("Connect your demo account first.");
      return;
    }

    setError("");
    setNotice("");
    setProposal(null);

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
      !Number.isFinite(tradeDuration) ||
      tradeDuration < 1
    ) {
      setError("Enter a valid trade duration.");
      return;
    }

    setProposalLoading(true);

    try {
      const quote =
        await clientRef.current.getProposal({
          symbol,
          contractType,
          amount,
          currency,
          duration: tradeDuration,
          durationUnit
        });

      setProposal(quote);

      setNotice(
        "Proposal received. Review the quote before confirming."
      );
    } catch (err) {
      setError(
        err.message || "Unable to obtain proposal."
      );
    } finally {
      setProposalLoading(false);
    }
  }

  /* ======================================================
     CONFIRM AND BUY DEMO CONTRACT
     ====================================================== */

  async function executeDemoTrade() {
    if (!proposal) {
      setError(
        "Request a proposal before placing an order."
      );
      return;
    }

    if (!connected) {
      setError(
        "Demo account is not connected."
      );
      return;
    }

    const confirmed = window.confirm(
      [
        "CONFIRM DEMO TRADE",
        "",
        `Market: ${symbol}`,
        `Direction: ${contractType === "CALL" ? "RISE" : "FALL"}`,
        `Stake: ${money(proposal.amount, currency)}`,
        `Potential payout: ${money(proposal.payout, currency)}`,
        `Duration: ${duration} ${durationUnit}`,
        "",
        "This will place a DEMO trade on Deriv.",
        "Do you want to continue?"
      ].join("\n")
    );

    if (!confirmed) return;

    setOrderLoading(true);
    setError("");
    setNotice("");

    try {
      const result =
        await clientRef.current.buyDemoProposal(
          proposal.id,
          proposal.ask_price,
          { confirmed: true }
        );

      setLastOrder(result);
      setProposal(null);

      if (result.contract_id) {
        setMonitoredContract({
          contract_id: result.contract_id,
          status: "Monitoring",
          is_sold: 0
        });

        await clientRef.current.monitorContract(
          result.contract_id
        );
      }

      if (result.accountSnapshot) {
        setBalance(
          result.accountSnapshot.balance
        );

        setPortfolio(
          result.accountSnapshot.portfolio
        );
      }

      await loadHistory();

      setNotice(
        `Demo order successfully placed. Contract ID: ${result.contract_id}`
      );
    } catch (err) {
      setError(
        err.message || "Demo order failed."
      );
    } finally {
      setOrderLoading(false);
    }
  }

  /* ======================================================
     RENDER
     ====================================================== */

  return (
    <div style={panelStyle}>

      {/* HEADER */}

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12
      }}>
        <div>
          <h2 style={{ margin: 0 }}>
            Deriv Live Trading
          </h2>

          <p style={{
            color: "#91a3bc",
            margin: "6px 0 0"
          }}>
            Authenticated Deriv connection ·
            Forex · Volatility · AI analysis
          </p>
        </div>

        <span style={{
          padding: "8px 12px",
          borderRadius: 20,
          background: connected
            ? "#103d32"
            : "#342b1b",
          color: connected
            ? "#35d6a2"
            : "#f0bb65",
          fontSize: 12,
          fontWeight: 800
        }}>
          ● {connected
            ? "CONNECTED — DEMO"
            : status.toUpperCase()}
        </span>
      </div>

      {/* ERROR */}

      {error && (
        <div role="alert" style={{
          ...cardStyle,
          borderColor: "#a94353",
          color: "#ff8997"
        }}>
          {error}
        </div>
      )}

      {/* NOTICE */}

      {notice && (
        <div role="status" style={{
          ...cardStyle,
          borderColor: "#1d8c70",
          color: "#50d6aa"
        }}>
          {notice}
        </div>
      )}

      {/* ACCOUNT CONNECTION */}

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
              <option value="">
                Select demo account
              </option>

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
              {loading
                ? "Connecting..."
                : "Connect Demo Account"}
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
          Only Deriv demo accounts are permitted.
          Real-money execution is disabled.
        </p>
      </section>

      {/* ACCOUNT SUMMARY */}

      <div style={{
        display: "grid",
        gridTemplateColumns:
          "repeat(auto-fit,minmax(180px,1fr))",
        gap: 12
      }}>
        <div style={cardStyle}>
          <div style={{
            color: "#91a3bc",
            fontSize: 12
          }}>
            Account Balance
          </div>

          <h2 style={{ marginBottom: 0 }}>
            {balance
              ? money(
                  balance.balance,
                  balance.currency
                )
              : "—"}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{
            color: "#91a3bc",
            fontSize: 12
          }}>
            Open Positions
          </div>

          <h2 style={{ marginBottom: 0 }}>
            {portfolio.length}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{
            color: "#91a3bc",
            fontSize: 12
          }}>
            Current Market
          </div>

          <h2 style={{ marginBottom: 0 }}>
            {SYMBOLS.find(
              item => item.value === symbol
            )?.label || symbol}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{
            color: "#91a3bc",
            fontSize: 12
          }}>
            Live Price
          </div>

          <h2 style={{ marginBottom: 0 }}>
            {tick?.quote !== undefined
              ? Number(tick.quote).toFixed(5)
              : "—"}
          </h2>
        </div>
      </div>

      {/* ==================================================
         DIGIT MATCH PREDICTOR
         ================================================== */}

      <section style={{
        ...cardStyle,
        borderColor: "#087d69"
      }}>
        <h3 style={{ marginTop: 0 }}>
          AI Digit Match Predictor
        </h3>

        <p style={{
          color: "#91a3bc",
          fontSize: 12
        }}>
          Live Deriv tick analysis ·
          Statistical prediction ·
          Historical validation
        </p>

        <div style={{
          display: "grid",
          gridTemplateColumns:
            "repeat(auto-fit,minmax(140px,1fr))",
          gap: 12
        }}>
          <div>
            <small>Latest Digit</small>

            <h1>
              {digitAnalysis?.currentDigit ?? "—"}
            </h1>
          </div>

          <div>
            <small>Statistical Candidate</small>

            <h1 style={{ color: "#35d6a2" }}>
              {digitAnalysis?.ready
                ? digitAnalysis.predictedDigit
                : "—"}
            </h1>
          </div>

          <div>
            <small>Model Score</small>

            <h2>
              {digitAnalysis?.ready
                ? `${(
                    digitAnalysis.probability * 100
                  ).toFixed(2)}%`
                : "Collecting data"}
            </h2>
          </div>

          <div>
            <small>Observations</small>

            <h2>
              {digitAnalysis?.sampleSize || 0}
            </h2>
          </div>
        </div>

        {!digitAnalysis?.ready && (
          <p style={{
            color: "#f0bb65",
            fontSize: 12
          }}>
            Collecting observations. At least
            200 ticks are required before the
            first statistical prediction.
          </p>
        )}

        {digitAnalysis?.ready && (
          <>
            <h4>Digit Probability Distribution</h4>

            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(5,1fr)",
              gap: 8
            }}>
              {digitAnalysis.distribution.map(item => (
                <div
                  key={item.digit}
                  style={{
                    background: "#0b1422",
                    padding: 10,
                    borderRadius: 8,
                    textAlign: "center",
                    border:
                      item.digit ===
                      digitAnalysis.predictedDigit
                        ? "1px solid #35d6a2"
                        : "1px solid #26364d"
                  }}
                >
                  <strong>{item.digit}</strong>

                  <div style={{
                    fontSize: 12,
                    color: "#91a3bc"
                  }}>
                    {(item.probability * 100).toFixed(1)}%
                  </div>
                </div>
              ))}
            </div>

            <h4>Prediction Ranking</h4>

            {digitAnalysis.rankings
              .slice(0, 5)
              .map(item => (
                <div
                  key={item.digit}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "9px 0",
                    borderBottom:
                      "1px solid #26364d"
                  }}
                >
                  <strong>
                    Digit {item.digit}
                  </strong>

                  <span style={{
                    color: "#35d6a2"
                  }}>
                    {(item.score * 100).toFixed(2)}%
                  </span>
                </div>
              ))}
          </>
        )}

        <h4>Prediction Performance</h4>

        <div className="signal">
          <span>Evaluated predictions</span>
          <strong>{digitPerformance.total}</strong>
        </div>

        <div className="signal">
          <span>Correct predictions</span>
          <strong style={{ color: "#35d6a2" }}>
            {digitPerformance.wins}
          </strong>
        </div>

        <div className="signal">
          <span>Incorrect predictions</span>
          <strong style={{ color: "#ff8997" }}>
            {digitPerformance.losses}
          </strong>
        </div>

        <div className="signal">
          <span>Historical accuracy</span>
          <strong>
            {digitPerformance.accuracy.toFixed(2)}%
          </strong>
        </div>

        <h4>Recent Prediction Results</h4>

        {digitHistory.length === 0 ? (
          <p style={{
            color: "#91a3bc",
            fontSize: 12
          }}>
            Results will appear here after predictions
            have been evaluated.
          </p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{
              width: "100%",
              borderCollapse: "collapse",
              minWidth: 400
            }}>
              <thead>
                <tr>
                  {[
                    "Predicted",
                    "Actual",
                    "Result",
                    "Time"
                  ].map(label => (
                    <th
                      key={label}
                      style={{
                        textAlign: "left",
                        padding: 9,
                        borderBottom:
                          "1px solid #34445c",
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
                      {item.predicted}
                    </td>

                    <td style={{ padding: 9 }}>
                      {item.actual}
                    </td>

                    <td style={{
                      padding: 9,
                      color: item.correct
                        ? "#35d6a2"
                        : "#ff8997",
                      fontWeight: 700
                    }}>
                      {item.correct
                        ? "CORRECT"
                        : "INCORRECT"}
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
          lineHeight: 1.6
        }}>
          Predictions are statistical estimates,
          not guaranteed outcomes. A 10% random
          baseline applies to an unbiased
          ten-digit outcome.
        </p>
      </section>

      {/* ==================================================
         DERIV BOT BUILDER
         ================================================== */}

      <DerivBotBuilder
        connected={connected}
        symbol={symbol}
        changeMarket={changeMarket}
        contractType={contractType}
        setContractType={value => {
          setContractType(value);
          setProposal(null);
        }}
        duration={duration}
        setDuration={value => {
          setDuration(value);
          setProposal(null);
        }}
        durationUnit={durationUnit}
        setDurationUnit={value => {
          setDurationUnit(value);
          setProposal(null);
        }}
        stake={stake}
        setStake={value => {
          setStake(value);
          setProposal(null);
        }}
        onPrepareTrade={requestProposal}
        onExecuteTrade={executeDemoTrade}
        proposal={proposal}
        orderLoading={orderLoading}
        proposalLoading={proposalLoading}
        currency={currency}
      />

      {/* LAST ORDER */}

      {lastOrder && (
        <section style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>
            Latest Demo Order
          </h3>

          <div className="signal">
            <span>Contract ID</span>
            <strong>{lastOrder.contract_id}</strong>
          </div>

          <div className="signal">
            <span>Purchase Price</span>
            <strong>
              {money(lastOrder.buy_price, currency)}
            </strong>
          </div>

          <div className="signal">
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

          <div className="signal">
            <span>Contract ID</span>
            <strong>
              {monitoredContract.contract_id}
            </strong>
          </div>

          <div className="signal">
            <span>Status</span>
            <strong>
              {monitoredContract.is_sold
                ? "SETTLED"
                : "OPEN / MONITORING"}
            </strong>
          </div>

          {monitoredContract.profit !== undefined && (
            <div className="signal">
              <span>Profit / Loss</span>

              <strong style={{
                color:
                  Number(monitoredContract.profit) >= 0
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
            <div className="signal">
              <span>Exit Price</span>

              <strong>
                {monitoredContract.exit_tick}
              </strong>
            </div>
          )}
        </section>
      )}

      {/* OPEN POSITIONS */}

      <section style={cardStyle}>
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center"
        }}>
          <h3>Open Positions</h3>

          <button
            style={{
              ...buttonStyle,
              background: "#263b55",
              color: "#fff"
            }}
            disabled={!connected || loading}
            onClick={refreshAccount}
          >
            Refresh
          </button>
        </div>

        {portfolio.length === 0 ? (
          <p style={{ color: "#91a3bc" }}>
            No open positions returned by Deriv.
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
                    "Current Value",
                    "Profit"
                  ].map(label => (
                    <th
                      key={label}
                      style={{
                        textAlign: "left",
                        padding: 10,
                        borderBottom:
                          "1px solid #34445c"
                      }}
                    >
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {portfolio.map((item, index) => (
                  <tr key={item.contract_id || index}>
                    <td style={{ padding: 10 }}>
                      {item.contract_id}
                    </td>

                    <td style={{ padding: 10 }}>
                      {item.underlying ||
                        item.symbol ||
                        "—"}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.buy_price, currency)}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.bid_price, currency)}
                    </td>

                    <td style={{
                      padding: 10,
                      color:
                        Number(item.profit) >= 0
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
                        borderBottom:
                          "1px solid #34445c"
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
                      {item.underlying ||
                        item.symbol ||
                        "—"}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.buy_price, currency)}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.sell_price, currency)}
                    </td>

                    <td style={{
                      padding: 10,
                      color:
                        Number(item.profit) >= 0
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

      {/* DEMO SAFEGUARDS */}

      <div style={{
        ...cardStyle,
        borderColor: "#755c2b",
        color: "#f0bb65",
        fontSize: 12,
        lineHeight: 1.7
      }}>
        <strong>Demo Trading Safeguards</strong>

        <p style={{ marginBottom: 0 }}>
          TradeLab currently restricts this interface
          to demo accounts and a maximum $10 stake.
          Server-side execution controls must also
          enforce these limits. Real-money trading
          remains disabled.
        </p>
      </div>

    </div>
  );
}

export default DerivLivePanel;
