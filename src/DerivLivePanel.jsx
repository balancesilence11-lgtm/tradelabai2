import React, { useEffect, useRef, useState } from "react";
import DerivClient from "./derivClient";

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

const buttonStyle = {
  border: 0,
  borderRadius: 8,
  padding: "11px 16px",
  fontWeight: 700,
  cursor: "pointer"
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

  const [status, setStatus] = useState("disconnected");
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(
    () => localStorage.getItem("tradelab_deriv_selected_account") || ""
  );

  const [balance, setBalance] = useState(null);
  const [portfolio, setPortfolio] = useState([]);
  const [history, setHistory] = useState([]);

  const [symbol, setSymbol] = useState("frxEURUSD");
  const [tick, setTick] = useState(null);

  const [stake, setStake] = useState("1");
  const [contractType, setContractType] = useState("CALL");
  const [duration, setDuration] = useState("5");
  const [durationUnit, setDurationUnit] = useState("m");

  const [proposal, setProposal] = useState(null);
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
        if (data.msg_type === "balance" && data.balance) {
          setBalance(data.balance);
        }

        if (data.msg_type === "portfolio" && data.portfolio) {
          setPortfolio(data.portfolio.contracts || []);
        }

        if (data.msg_type === "tick" && data.tick) {
          setTick(data.tick);
        }

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
                console.warn("Account refresh failed:", err);
              });
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

      setNotice("Deriv demo account connected successfully.");
    } catch (err) {
      setError(err.message || "Unable to connect Deriv account.");
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

    // Existing subscriptions are cleared when disconnected.
    // Market changes create a new tick subscription.
  }, [connected]);

  /* ======================================================
     ACCOUNT REFRESH
     ====================================================== */

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

  /* ======================================================
     TRADE HISTORY
     ====================================================== */

  async function loadHistory() {
    if (!clientRef.current?.connected) return;

    try {
      const result = await clientRef.current.getProfitTable({
        limit: 50,
        offset: 0
      });

      const transactions =
        result.transactions ||
        result.profit_table ||
        [];

      setHistory(
        Array.isArray(transactions) ? transactions : []
      );
    } catch (err) {
      console.warn("Profit table unavailable:", err.message);
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

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_STAKE
    ) {
      setError(`Stake must be between 0 and ${MAX_STAKE}.`);
      return;
    }

    setProposalLoading(true);

    try {
      const quote = await clientRef.current.getProposal({
        symbol,
        contractType,
        amount,
        currency,
        duration: Number(duration),
        durationUnit
      });

      setProposal(quote);

      setNotice("Proposal received. Review the quote before confirming.");
    } catch (err) {
      setError(err.message || "Unable to obtain proposal.");
    } finally {
      setProposalLoading(false);
    }
  }

  /* ======================================================
     CONFIRM AND BUY DEMO CONTRACT
     ====================================================== */

  async function executeDemoTrade() {
    if (!proposal) {
      setError("Request a proposal before placing an order.");
      return;
    }

    if (!connected) {
      setError("Demo account is not connected.");
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
      const result = await clientRef.current.buyDemoProposal(
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
        setBalance(result.accountSnapshot.balance);
        setPortfolio(result.accountSnapshot.portfolio);
      }

      await loadHistory();

      setNotice(
        `Demo order successfully placed. Contract ID: ${result.contract_id}`
      );
    } catch (err) {
      setError(err.message || "Demo order failed.");
    } finally {
      setOrderLoading(false);
    }
  }

  /* ======================================================
     RENDER
     ====================================================== */

  return (
    <div style={panelStyle}>

      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 12
      }}>
        <div>
          <h2 style={{ margin: 0 }}>Deriv Live Trading</h2>
          <p style={{ color: "#91a3bc", margin: "6px 0 0" }}>
            Authenticated demo account · Market data · Rise/Fall execution
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
        <div role="alert" style={{
          ...cardStyle,
          borderColor: "#a94353",
          color: "#ff8997"
        }}>
          {error}
        </div>
      )}

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
        <h3 style={{ marginTop: 0 }}>Demo Account Connection</h3>

        <div style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          alignItems: "end"
        }}>
          <div style={{ flex: "1 1 250px" }}>
            <label style={{ display: "block", marginBottom: 8 }}>
              Select Deriv demo account
            </label>

            <select
              style={inputStyle}
              value={accountId}
              disabled={connected || loading}
              onChange={event => setAccountId(event.target.value)}
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

      {/* ACCOUNT SUMMARY */}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
        gap: 12
      }}>
        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>Account Balance</div>
          <h2 style={{ marginBottom: 0 }}>
            {balance
              ? money(balance.balance, balance.currency)
              : "—"}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>Open Positions</div>
          <h2 style={{ marginBottom: 0 }}>{portfolio.length}</h2>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>Current Market</div>
          <h2 style={{ marginBottom: 0 }}>
            {SYMBOLS.find(s => s.value === symbol)?.label || symbol}
          </h2>
        </div>

        <div style={cardStyle}>
          <div style={{ color: "#91a3bc", fontSize: 12 }}>Live Price</div>
          <h2 style={{ marginBottom: 0 }}>
            {tick?.quote !== undefined
              ? Number(tick.quote).toFixed(5)
              : "—"}
          </h2>
        </div>
      </div>

      {/* TRADE CONFIGURATION */}

      <section style={cardStyle}>
        <h3 style={{ marginTop: 0 }}>Trade Configuration</h3>

        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
          gap: 14
        }}>
          <div>
            <label>Market</label>
            <select
              style={inputStyle}
              value={symbol}
              disabled={!connected}
              onChange={e => changeMarket(e.target.value)}
            >
              {SYMBOLS.map(item => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label>Direction</label>
            <select
              style={inputStyle}
              value={contractType}
              disabled={!connected}
              onChange={e => {
                setContractType(e.target.value);
                setProposal(null);
              }}
            >
              <option value="CALL">RISE</option>
              <option value="PUT">FALL</option>
            </select>
          </div>

          <div>
            <label>Stake ({currency})</label>
            <input
              style={inputStyle}
              type="number"
              min="0.35"
              max={MAX_STAKE}
              step="0.01"
              value={stake}
              disabled={!connected}
              onChange={e => {
                setStake(e.target.value);
                setProposal(null);
              }}
            />
          </div>

          <div>
            <label>Duration</label>
            <input
              style={inputStyle}
              type="number"
              min="1"
              max="1440"
              value={duration}
              disabled={!connected}
              onChange={e => {
                setDuration(e.target.value);
                setProposal(null);
              }}
            />
          </div>

          <div>
            <label>Duration Unit</label>
            <select
              style={inputStyle}
              value={durationUnit}
              disabled={!connected}
              onChange={e => {
                setDurationUnit(e.target.value);
                setProposal(null);
              }}
            >
              <option value="s">Seconds</option>
              <option value="m">Minutes</option>
              <option value="h">Hours</option>
              <option value="d">Days</option>
            </select>
          </div>
        </div>

        <p style={{
          color: "#f0bb65",
          fontSize: 12
        }}>
          Maximum permitted demo stake: {money(MAX_STAKE, currency)} per proposal.
        </p>

        <button
          style={{
            ...buttonStyle,
            background: "#087d69",
            color: "#fff"
          }}
          disabled={!connected || proposalLoading}
          onClick={requestProposal}
        >
          {proposalLoading ? "Requesting Quote..." : "Get Trade Proposal"}
        </button>
      </section>

      {/* PROPOSAL PREVIEW */}

      {proposal && (
        <section style={{
          ...cardStyle,
          borderColor: "#087d69"
        }}>
          <h3 style={{ marginTop: 0 }}>Trade Proposal Preview</h3>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))",
            gap: 14
          }}>
            <div>
              <small style={{ color: "#91a3bc" }}>Market</small>
              <h3>{symbol}</h3>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Direction</small>
              <h3>
                {contractType === "CALL" ? "RISE" : "FALL"}
              </h3>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Stake</small>
              <h3>{money(proposal.amount, currency)}</h3>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Potential Payout</small>
              <h3>{money(proposal.payout, currency)}</h3>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Potential Profit</small>
              <h3 style={{ color: "#35d6a2" }}>
                {money(
                  Number(proposal.payout) - Number(proposal.amount),
                  currency
                )}
              </h3>
            </div>

            <div>
              <small style={{ color: "#91a3bc" }}>Purchase Price</small>
              <h3>{money(proposal.ask_price, currency)}</h3>
            </div>
          </div>

          {proposal.longcode && (
            <p style={{
              color: "#91a3bc",
              lineHeight: 1.6
            }}>
              {proposal.longcode}
            </p>
          )}

          <button
            style={{
              ...buttonStyle,
              background: "#087d69",
              color: "#fff"
            }}
            disabled={orderLoading || !connected}
            onClick={executeDemoTrade}
          >
            {orderLoading
              ? "Placing Demo Order..."
              : "Confirm & Place Demo Trade"}
          </button>

          <button
            style={{
              ...buttonStyle,
              background: "#34445c",
              color: "#fff",
              marginLeft: 10
            }}
            onClick={() => setProposal(null)}
          >
            Cancel Proposal
          </button>
        </section>
      )}

      {/* LAST ORDER */}

      {lastOrder && (
        <section style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Latest Demo Order</h3>

          <div className="signal">
            <span>Contract ID</span>
            <strong>{lastOrder.contract_id}</strong>
          </div>

          <div className="signal">
            <span>Purchase Price</span>
            <strong>{money(lastOrder.buy_price, currency)}</strong>
          </div>

          <div className="signal">
            <span>Potential Payout</span>
            <strong>{money(lastOrder.payout, currency)}</strong>
          </div>
        </section>
      )}

      {/* CONTRACT MONITORING */}

      {monitoredContract && (
        <section style={cardStyle}>
          <h3 style={{ marginTop: 0 }}>Contract Monitoring</h3>

          <div className="signal">
            <span>Contract ID</span>
            <strong>{monitoredContract.contract_id}</strong>
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
                color: Number(monitoredContract.profit) >= 0
                  ? "#35d6a2"
                  : "#ff8997"
              }}>
                {money(monitoredContract.profit, currency)}
              </strong>
            </div>
          )}

          {monitoredContract.exit_tick !== undefined && (
            <div className="signal">
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
                  {["Contract", "Market", "Buy Price", "Current Value", "Profit"].map(label => (
                    <th key={label} style={{
                      textAlign: "left",
                      padding: 10,
                      borderBottom: "1px solid #34445c"
                    }}>
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
                      {item.underlying || item.symbol || "—"}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.buy_price, currency)}
                    </td>

                    <td style={{ padding: 10 }}>
                      {money(item.bid_price, currency)}
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
                  {["Contract", "Market", "Buy Price", "Sell Price", "Profit"].map(label => (
                    <th key={label} style={{
                      textAlign: "left",
                      padding: 10,
                      borderBottom: "1px solid #34445c"
                    }}>
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

      <div style={{
        ...cardStyle,
        borderColor: "#755c2b",
        color: "#f0bb65",
        fontSize: 12,
        lineHeight: 1.7
      }}>
        <strong>Demo trading safeguards</strong>
        <p style={{ marginBottom: 0 }}>
          TradeLab currently restricts this interface to demo accounts
          and a maximum $10 stake. Client-side controls are not a
          substitute for server-side execution enforcement. Real-money
          trading remains disabled.
        </p>
      </div>

    </div>
  );
}

export default DerivLivePanel;
