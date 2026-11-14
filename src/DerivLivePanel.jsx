import React, { useEffect, useRef, useState } from "react";
import derivClient from "./derivClient";

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
  const clientRef = useRef(derivClient);

  const client = clientRef.current;

  useEffect(() => {
    const unsubscribers = [
      client.on("balance", data => setBalance(data)),
      client.on("portfolio", data => setPortfolio(data || [])),
      client.on("statement", data => setHistory(data || [])),
      client.on("tick", data => setTick(data)),
      client.on("disconnected", () => setStatus("Disconnected")),
      client.on("error", data => setError(data.message || "Deriv connection error"))
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

      const saved = retrieved.find(a => a.account_id === accountId);
      const demo = retrieved.find(a => a.account_type === "demo");

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

    const selected = accounts.find(a => a.account_id === accountId);

    if (!selected || selected.account_type !== "demo") {
      setError("Only demo accounts are enabled in this integration.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setBalance(null);
      setPortfolio([]);
      setHistory([]);
      setTick(null);

      await client.connect(accountId);

      setStatus("Connected to Deriv demo");

      const balanceData = await client.getBalance(true);
      setBalance(balanceData);

      const positions = await client.getPortfolio();
      setPortfolio(positions);

      const transactions = await client.getStatement(100);
      setHistory(transactions);

      const symbolsResponse = await client.send({
        active_symbols: "brief"
      });

      const available = symbolsResponse.active_symbols || [];
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

      const updatedBalance = await client.getBalance(true);
      setBalance(updatedBalance);

      setPortfolio(await client.getPortfolio());
      setHistory(await client.getStatement(100));

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
    setStatus("Disconnected");
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

  return (
    <div>
      <div className="welcome">
        <div>
          <h1>Deriv Live Account</h1>
          <div className="muted">
            Live account synchronisation and market monitoring.
          </div>
        </div>

        <span className="demo-badge">
          {status.toUpperCase()}
        </span>
      </div>

      {error && (
        <div className="card" style={{ marginBottom: 15, color: "#fb7185" }}>
          {error}
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <div className="card-heading">
          <h3>Account Connection</h3>
          <span className="tag">DEMO ONLY</span>
        </div>

        <div className="field">
          <label>Select Deriv Demo Account</label>

          <select
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
            {loading ? "Connecting..." : "Connect Live Account"}
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

      <div className="stats-grid">
        <div className="card">
          <div className="stat-label">Account Balance</div>
          <div className="stat-value">
            {balance
              ? money(balance.balance, currency)
              : "—"}
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
          <div className="stat-value">
            {portfolio.length}
          </div>
        </div>

        <div className="card">
          <div className="stat-label">Open Position P/L</div>
          <div className="stat-value">
            {money(openProfit, currency)}
          </div>
        </div>
      </div>

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
              value={symbol}
              onChange={event => changeMarket(event.target.value)}
              disabled={!markets.length || !client.connected}
            >
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

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-heading">
          <h3>Open Positions</h3>
          <span className="muted">{portfolio.length} positions</span>
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

      <div className="card" style={{ marginTop: 18 }}>
        <div className="card-heading">
          <h3>Trade History</h3>
          <span className="muted">
            Latest {history.length} transactions
          </span>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Transaction</th>
                <th>Contract</th>
                <th>Buy Price</th>
                <th>Sell Price</th>
                <th>Profit / Loss</th>
              </tr>
            </thead>

            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan="5" className="empty">
                    No transaction history available.
                  </td>
                </tr>
              ) : (
                history.map((item, index) => (
                  <tr key={item.transaction_id || index}>
                    <td>{item.transaction_id || "—"}</td>
                    <td>{item.longcode || item.action_type || "—"}</td>
                    <td>{money(item.buy_price, currency)}</td>
                    <td>{money(item.sell_price, currency)}</td>
                    <td>{money(item.amount, currency)}</td>
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
