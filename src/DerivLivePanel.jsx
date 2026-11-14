import React, { useEffect, useRef, useState } from "react";
import derivClient from "./derivClient";

const MAX_STAKE = 10;

const money = (value, currency = "USD") =>
  `${Number(value || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })} ${currency}`;

export default function DerivLivePanel() {
  const [status, setStatus] = useState("Checking connection");
  const [accounts, setAccounts] = useState([]);
  const [accountId, setAccountId] = useState(
    () => localStorage.getItem("tradelab_deriv_selected_account") || ""
  );

  const [balance, setBalance] = useState(null);
  const [portfolio, setPortfolio] = useState([]);
  const [history, setHistory] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [symbol, setSymbol] = useState("");
  const [tick, setTick] = useState(null);

  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // Demo execution state
  const [stake, setStake] = useState("1");
  const [duration, setDuration] = useState("5");
  const [contractType, setContractType] = useState("CALL");
  const [proposal, setProposal] = useState(null);
  const [orderLoading, setOrderLoading] = useState(false);
  const [lastOrder, setLastOrder] = useState(null);
  const [monitoredContract, setMonitoredContract] = useState(null);

  const clientRef = useRef(derivClient);
  const client = clientRef.current;

  useEffect(() => {
    const unsubscribers = [
      client.on("balance", data => setBalance(data)),
      client.on("portfolio", data => setPortfolio(data || [])),
      client.on("statement", data => setHistory(data || [])),
      client.on("profit_table", data => setHistory(data || [])),
      client.on("tick", data => setTick(data)),
      client.on("contract", data => {
        setMonitoredContract(data || null);

        if (data?.is_sold) {
          refreshAccount();
        }
      }),
      client.on("buy", data => setLastOrder(data)),
      client.on("disconnected", () => {
        setStatus("Disconnected");
        setProposal(null);
      }),
      client.on("error", data =>
        setError(data.message || "Deriv connection error")
      )
    ];

    loadAccounts();

    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe());
      client.disconnect();
    };
  }, []);

  async function loadAccounts() {
    try {
      setLoading(true);
      setError("");

      const result = await client.getStatus();

      if (!result.connected) {
        setStatus("Deriv not connected");
        setAccounts([]);
        return;
      }

      const retrieved = await client.getAccounts();
      setAccounts(retrieved);

      const saved = retrieved.find(
        account => account.account_id === accountId
      );

      const demo = retrieved.find(
        account => account.account_type === "demo"
      );

      const selected = saved || demo;

      if (selected) {
        setAccountId(selected.account_id);

        localStorage.setItem(
          "tradelab_deriv_selected_account",
          selected.account_id
        );
      }

      setStatus("OAuth connected");
    } catch (err) {
      setError(err.message);
      setStatus("Connection error");
    } finally {
      setLoading(false);
    }
  }

  async function connectAccount() {
    if (!accountId) {
      setError("Select a Deriv demo account first.");
      return;
    }

    const selected = accounts.find(
      account => account.account_id === accountId
    );

    if (!selected || selected.account_type !== "demo") {
      setError("Only demo accounts are enabled.");
      return;
    }

    try {
      setLoading(true);
      setError("");

      setBalance(null);
      setPortfolio([]);
      setHistory([]);
      setTick(null);
      setProposal(null);
      setLastOrder(null);
      setMonitoredContract(null);

      await client.connect(accountId);

      setStatus("Connected to Deriv demo");

      const balanceData = await client.getBalance(true);
      setBalance(balanceData);

      setPortfolio(await client.getPortfolio());
      setHistory(await client.getProfitTable(100));

      const available = await client.getActiveSymbols();

      setMarkets(available);

      const preferred = available.find(item =>
        /EUR\/USD|EURUSD/i.test(
          `${item.display_name || ""} ${item.symbol || ""}`
        )
      );

      if (preferred) {
        setSymbol(preferred.symbol);
        await client.subscribeTicks(preferred.symbol);
      }
    } catch (err) {
      setStatus("Connection failed");
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function changeMarket(value) {
    setSymbol(value);
    setTick(null);
    setProposal(null);

    try {
      if (client.connected) {
        await client.subscribeTicks(value);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  async function refreshAccount() {
    if (!client.connected) {
      await connectAccount();
      return;
    }

    try {
      setLoading(true);
      setError("");

      const updatedBalance = await client.getBalance(true);
      setBalance(updatedBalance);

      setPortfolio(await client.getPortfolio());
      setHistory(await client.getProfitTable(100));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function disconnectAccount() {
    client.disconnect();

    setBalance(null);
    setPortfolio([]);
    setHistory([]);
    setTick(null);
    setProposal(null);
    setLastOrder(null);
    setMonitoredContract(null);

    setStatus("Disconnected");
  }

  /* =====================================
     CREATE TRADE PROPOSAL
  ===================================== */

  async function requestProposal() {
    try {
      setError("");
      setProposal(null);

      if (!client.connected) {
        throw new Error("Connect your demo account first.");
      }

      if (!symbol) {
        throw new Error("Select a Deriv market first.");
      }

      const amount = Number(stake);

      if (
        !Number.isFinite(amount) ||
        amount <= 0 ||
        amount > MAX_STAKE
      ) {
        throw new Error(
          `Demo stake must be between 0 and ${MAX_STAKE}.`
        );
      }

      setOrderLoading(true);

      const result = await client.createProposal({
        symbol,
        contractType,
        stake: amount,
        duration: Number(duration),
        durationUnit: "m"
      });

      setProposal(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setOrderLoading(false);
    }
  }

  /* =====================================
     EXPLICIT DEMO PURCHASE
  ===================================== */

  async function confirmDemoPurchase() {
    if (!proposal?.id) {
      setError("Request a valid proposal first.");
      return;
    }

    const askPrice = Number(proposal.ask_price);

    if (!Number.isFinite(askPrice) || askPrice <= 0) {
      setError("Invalid proposal purchase price.");
      return;
    }

    const confirmation = window.confirm(
      `CONFIRM DEMO TRADE\n\n` +
      `Market: ${symbol}\n` +
      `Direction: ${contractType}\n` +
      `Stake: ${money(stake, balance?.currency || "USD")}\n` +
      `Purchase price: ${money(askPrice, balance?.currency || "USD")}\n` +
      `Duration: ${duration} minutes\n\n` +
      `This is a DEMO account order. Continue?`
    );

    if (!confirmation) return;

    try {
      setOrderLoading(true);
      setError("");

      const result = await client.buyDemoContract(
        proposal.id,
        askPrice,
        true
      );

      setLastOrder(result);
      setProposal(null);

      if (result.contract_id) {
        try {
          await client.monitorContract(result.contract_id);
        } catch (monitorError) {
          console.warn(
            "Contract monitoring could not start:",
            monitorError.message
          );
        }
      }

      setError("");

      await refreshAccount();
    } catch (err) {
      setError(err.message);
    } finally {
      setOrderLoading(false);
    }
  }

  const currency = balance?.currency || "USD";

  const openProfit = portfolio.reduce(
    (total, item) => total + Number(item.profit || 0),
    0
  );

  const estimatedEquity =
    balance?.balance != null
      ? Number(balance.balance) + openProfit
      : null;

  const inputStyle = {
    width: "100%",
    padding: "11px",
    borderRadius: "8px",
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#fff",
    marginTop: "7px"
  };

  return (
    <div>
      <div className="welcome">
        <div>
          <h1>Deriv Live Account</h1>
          <div className="muted">
            Account synchronisation, live market monitoring and demo execution
          </div>
        </div>

        <span className="demo-badge">
          {status.toUpperCase()}
        </span>
      </div>

      {error && (
        <div
          className="card"
          style={{ marginBottom: 15, color: "#fb7185" }}
        >
          {error}
        </div>
      )}

      {/* ACCOUNT CONNECTION */}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-heading">
          <h3>Account Connection</h3>
          <span className="tag">DEMO ONLY</span>
        </div>

        <div className="field">
          <label>Select Deriv Demo Account</label>

          <select
            style={inputStyle}
            value={accountId}
            onChange={event => {
              setAccountId(event.target.value);

              localStorage.setItem(
                "tradelab_deriv_selected_account",
                event.target.value
              );
            }}
          >
            <option value="">Select account</option>

            {accounts
              .filter(account => account.account_type === "demo")
              .map(account => (
                <option
                  key={account.account_id}
                  value={account.account_id}
                >
                  {account.account_id}
                </option>
              ))}
          </select>
        </div>

        <div className="trade-buttons">
          <button
            className="execute-btn"
            onClick={connectAccount}
            disabled={loading || !accountId}
          >
            {loading ? "Connecting..." : "Connect Demo Account"}
          </button>

          <button
            className="period-btn"
            onClick={refreshAccount}
            disabled={loading}
          >
            Refresh Account
          </button>

          <button
            className="period-btn"
            onClick={loadAccounts}
            disabled={loading}
          >
            Refresh Account List
          </button>

          <button
            className="period-btn"
            onClick={disconnectAccount}
          >
            Disconnect
          </button>
        </div>
      </div>

      {/* ACCOUNT STATISTICS */}

      <div className="stats-grid">
        <div className="card">
          <div className="stat-label">Account Balance</div>
          <div className="stat-value">
            {balance ? money(balance.balance, currency) : "—"}
          </div>
        </div>

        <div className="card">
          <div className="stat-label">Estimated Equity</div>
          <div className="stat-value">
            {estimatedEquity != null
              ? money(estimatedEquity, currency)
              : "—"}
          </div>
        </div>

        <div className="card">
          <div className="stat-label">Open Positions</div>
          <div className="stat-value">{portfolio.length}</div>
        </div>

        <div className="card">
          <div className="stat-label">Open Position P/L</div>
          <div className="stat-value">
            {money(openProfit, currency)}
          </div>
        </div>
      </div>

      {/* MARKET STREAM */}

      <div className="dashboard-grid" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-heading">
            <h3>Live Market Stream</h3>

            <span className="tag">
              {tick ? "STREAMING" : "WAITING"}
            </span>
          </div>

          <div className="field">
            <label>Deriv Market</label>

            <select
              style={inputStyle}
              value={symbol}
              onChange={event => changeMarket(event.target.value)}
              disabled={!markets.length || !client.connected}
            >
              <option value="">Select market</option>

              {markets.map(item => (
                <option key={item.symbol} value={item.symbol}>
                  {item.display_name || item.symbol}
                </option>
              ))}
            </select>
          </div>

          <div className="stat-value" style={{ marginTop: 15 }}>
            {tick?.quote != null
              ? Number(tick.quote).toLocaleString()
              : "Waiting for market price"}
          </div>

          <div className="muted">
            {tick?.symbol || symbol || "No market selected"}
          </div>
        </div>

        <div className="card">
          <div className="card-heading">
            <h3>Connection Monitor</h3>
          </div>

          <div className="signal">
            <span>OAuth connection</span>
            <strong>{status}</strong>
          </div>

          <div className="signal">
            <span>WebSocket</span>
            <strong>
              {client.connected ? "Connected" : "Disconnected"}
            </strong>
          </div>

          <div className="signal">
            <span>Account type</span>
            <strong>DEMO</strong>
          </div>

          <div className="signal">
            <span>Real-money execution</span>
            <strong>DISABLED</strong>
          </div>
        </div>
      </div>

      {/* DEMO TRADING TERMINAL */}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-heading">
          <h3>Demo Trading Terminal</h3>
          <span className="tag">MAX STAKE: $10</span>
        </div>

        <div className="muted" style={{ marginBottom: 15 }}>
          Request a price proposal, review the terms and explicitly confirm
          before placing a demo order.
        </div>

        <div className="dashboard-grid">
          <div className="field">
            <label>Market</label>
            <select
              style={inputStyle}
              value={symbol}
              onChange={event => changeMarket(event.target.value)}
              disabled={!client.connected}
            >
              <option value="">Select market</option>

              {markets.map(item => (
                <option key={item.symbol} value={item.symbol}>
                  {item.display_name || item.symbol}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label>Trade Direction</label>
            <select
              style={inputStyle}
              value={contractType}
              onChange={event => {
                setContractType(event.target.value);
                setProposal(null);
              }}
            >
              <option value="CALL">CALL / UP</option>
              <option value="PUT">PUT / DOWN</option>
            </select>
          </div>

          <div className="field">
            <label>Stake ({currency})</label>
            <input
              style={inputStyle}
              type="number"
              min="0.35"
              max={MAX_STAKE}
              step="0.01"
              value={stake}
              onChange={event => {
                setStake(event.target.value);
                setProposal(null);
              }}
            />
          </div>

          <div className="field">
            <label>Duration</label>
            <select
              style={inputStyle}
              value={duration}
              onChange={event => {
                setDuration(event.target.value);
                setProposal(null);
              }}
            >
              <option value="1">1 minute</option>
              <option value="2">2 minutes</option>
              <option value="5">5 minutes</option>
              <option value="10">10 minutes</option>
              <option value="15">15 minutes</option>
              <option value="30">30 minutes</option>
            </select>
          </div>
        </div>

        <div className="trade-buttons" style={{ marginTop: 15 }}>
          <button
            className="execute-btn"
            onClick={requestProposal}
            disabled={!client.connected || orderLoading || !symbol}
          >
            {orderLoading ? "Processing..." : "Get Price Proposal"}
          </button>

          <button
            className="period-btn"
            onClick={() => setProposal(null)}
            disabled={!proposal || orderLoading}
          >
            Clear Proposal
          </button>
        </div>

        {proposal && (
          <div
            className="card"
            style={{
              marginTop: 18,
              border: "1px solid #22c55e"
            }}
          >
            <div className="card-heading">
              <h3>Trade Proposal Preview</h3>
              <span className="tag">REVIEW REQUIRED</span>
            </div>

            <div className="signal">
              <span>Market</span>
              <strong>{symbol}</strong>
            </div>

            <div className="signal">
              <span>Direction</span>
              <strong>{contractType}</strong>
            </div>

            <div className="signal">
              <span>Stake</span>
              <strong>{money(stake, currency)}</strong>
            </div>

            <div className="signal">
              <span>Purchase price</span>
              <strong>
                {money(proposal.ask_price, currency)}
              </strong>
            </div>

            <div className="signal">
              <span>Potential payout</span>
              <strong>
                {money(proposal.payout, currency)}
              </strong>
            </div>

            <div className="signal">
              <span>Duration</span>
              <strong>{duration} minutes</strong>
            </div>

            <div className="signal">
              <span>Proposal ID</span>
              <strong>{proposal.id}</strong>
            </div>

            <button
              className="execute-btn"
              style={{
                width: "100%",
                marginTop: 18,
                background: "#15803d"
              }}
              onClick={confirmDemoPurchase}
              disabled={orderLoading}
            >
              {orderLoading
                ? "Submitting..."
                : "Confirm & Buy DEMO Contract"}
            </button>

            <div className="muted" style={{ marginTop: 10 }}>
              No order is placed until you press the confirmation button
              and approve the browser confirmation.
            </div>
          </div>
        )}

        {lastOrder && (
          <div className="card" style={{ marginTop: 18 }}>
            <h3>Last Demo Order</h3>

            <div className="signal">
              <span>Contract ID</span>
              <strong>{lastOrder.contract_id || "—"}</strong>
            </div>

            <div className="signal">
              <span>Purchase price</span>
              <strong>
                {money(lastOrder.buy_price, currency)}
              </strong>
            </div>

            <div className="signal">
              <span>Status</span>
              <strong>Purchase acknowledged</strong>
            </div>
          </div>
        )}

        {monitoredContract && (
          <div className="card" style={{ marginTop: 18 }}>
            <h3>Contract Monitor</h3>

            <div className="signal">
              <span>Contract ID</span>
              <strong>
                {monitoredContract.contract_id || "—"}
              </strong>
            </div>

            <div className="signal">
              <span>Current value</span>
              <strong>
                {money(monitoredContract.bid_price, currency)}
              </strong>
            </div>

            <div className="signal">
              <span>Profit / Loss</span>
              <strong>
                {money(monitoredContract.profit, currency)}
              </strong>
            </div>

            <div className="signal">
              <span>Contract status</span>
              <strong>
                {monitoredContract.is_sold ? "CLOSED" : "OPEN"}
              </strong>
            </div>
          </div>
        )}
      </div>

      {/* OPEN POSITIONS */}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-heading">
          <h3>Open Positions</h3>

          <span className="muted">
            {portfolio.length} positions
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Contract</th>
                <th>Type</th>
                <th>Buy Price</th>
                <th>Current Value</th>
                <th>Profit / Loss</th>
              </tr>
            </thead>

            <tbody>
              {portfolio.length === 0 ? (
                <tr>
                  <td colSpan="5" className="empty">
                    No open Deriv positions.
                  </td>
                </tr>
              ) : (
                portfolio.map((item, index) => (
                  <tr key={item.contract_id || index}>
                    <td>{item.contract_id || "—"}</td>
                    <td>{item.contract_type || "—"}</td>
                    <td>{money(item.buy_price, currency)}</td>
                    <td>{money(item.bid_price, currency)}</td>
                    <td>{money(item.profit, currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* CLOSED TRADE HISTORY */}

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-heading">
          <h3>Closed Trade History</h3>

          <span className="muted">
            Latest {history.length} trades
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Contract ID</th>
                <th>Purchase Time</th>
                <th>Buy Price</th>
                <th>Sell Price</th>
                <th>Payout</th>
                <th>Profit / Loss</th>
              </tr>
            </thead>

            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan="6" className="empty">
                    No closed trades available.
                  </td>
                </tr>
              ) : (
                history.map((item, index) => (
                  <tr
                    key={
                      item.contract_id ||
                      item.transaction_id ||
                      index
                    }
                  >
                    <td>
                      {item.contract_id ||
                        item.transaction_id ||
                        "—"}
                    </td>

                    <td>
                      {item.purchase_time
                        ? new Date(
                            item.purchase_time * 1000
                          ).toLocaleString()
                        : "—"}
                    </td>

                    <td>{money(item.buy_price, currency)}</td>
                    <td>{money(item.sell_price, currency)}</td>
                    <td>{money(item.payout, currency)}</td>

                    <td>
                      {money(
                        Number(item.sell_price || 0) -
                          Number(item.buy_price || 0),
                        currency
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
