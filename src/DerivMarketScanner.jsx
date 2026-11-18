import React, { useEffect, useMemo, useRef, useState } from "react";
import DerivClient from "./derivClient";
import DigitMatchPredictor from "./digitMatchPredictor";

const SCAN_MARKETS = [
  { value: "1HZ10V", label: "Volatility 10 (1s)" },
  { value: "1HZ25V", label: "Volatility 25 (1s)" },
  { value: "1HZ50V", label: "Volatility 50 (1s)" },
  { value: "1HZ75V", label: "Volatility 75 (1s)" },
  { value: "1HZ100V", label: "Volatility 100 (1s)" },
  { value: "R_10", label: "Volatility 10" },
  { value: "R_25", label: "Volatility 25" },
  { value: "R_50", label: "Volatility 50" },
  { value: "R_75", label: "Volatility 75" },
  { value: "R_100", label: "Volatility 100" }
];

const card = {
  background: "#111c2d",
  border: "1px solid #26364d",
  borderRadius: 12,
  padding: 14,
  color: "#e6edf7"
};

const button = {
  border: "1px solid #31516b",
  borderRadius: 8,
  padding: "8px 11px",
  background: "#17283d",
  color: "#dce8f5",
  cursor: "pointer",
  fontWeight: 700
};

function makePredictor(symbol) {
  const predictor = new DigitMatchPredictor({
    maxHistory: 5000,
    minSamples: 200,
    maxPredictions: 2000
  });

  try {
    const saved = localStorage.getItem(
      `tradelab_scanner_phase4_${symbol}`
    );

    if (saved) {
      predictor.importState(JSON.parse(saved));
    }
  } catch (error) {
    console.warn(
      `Scanner history for ${symbol} could not be restored:`,
      error
    );
  }

  return predictor;
}

function getStatus(performance, ready) {
  if (!ready) return "COLLECTING";

  if (
    performance.status ===
    "ABOVE 10% BASELINE — OBSERVED"
  ) {
    return "ABOVE BASELINE OBSERVED";
  }

  if (
    performance.status ===
    "BELOW 10% BASELINE — OBSERVED"
  ) {
    return "BELOW BASELINE OBSERVED";
  }

  if (performance.total < 100) {
    return "NEEDS MORE EVALUATIONS";
  }

  return "INCONCLUSIVE";
}

export default function DerivMarketScanner({
  connected,
  accountId,
  onSelectMarket
}) {
  const clientRef = useRef(null);
  const modelsRef = useRef({});

  const [scannerStatus, setScannerStatus] = useState(
    "WAITING FOR DEMO CONNECTION"
  );

  const [scannerError, setScannerError] = useState("");
  const [rows, setRows] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [retryKey, setRetryKey] = useState(0);
  const [sortMode, setSortMode] = useState("reliability");

  function getModel(symbol) {
    if (!modelsRef.current[symbol]) {
      modelsRef.current[symbol] = makePredictor(symbol);
    }

    return modelsRef.current[symbol];
  }

  function refreshRows() {
    const next = SCAN_MARKETS.map(market => {
      const model = getModel(market.value);
      const analysis = model.getLatestAnalysis();
      const performance = model.getPerformance();
      const ready = Boolean(analysis?.ready);

      return {
        ...market,
        ticks: model.history.length,
        evaluated: performance.total,
        accuracy: performance.accuracy,
        interval: performance.confidenceInterval95,
        reliability: getStatus(performance, ready),
        candidate: ready ? analysis.predictedDigit : null,
        estimate: ready
          ? analysis.probability * 100
          : null,
        lastDigit: model.history.length
          ? model.history[model.history.length - 1].digit
          : null,
        lastTickAt: model.history.length
          ? model.history[model.history.length - 1].timestamp
          : null
      };
    });

    setRows(next);
    setLastUpdate(Date.now());
  }

  useEffect(() => {
    if (!connected || !accountId) {
      setScannerStatus("WAITING FOR DEMO CONNECTION");

      setRows(previous =>
        previous.map(row => ({
          ...row,
          live: false
        }))
      );

      return undefined;
    }

    let cancelled = false;

    const client = new DerivClient({
      onStatus: event => {
        if (cancelled) return;

        if (event.state === "connected") {
          setScannerStatus("CONNECTED — SUBSCRIBING");
        }

        if (event.state === "disconnected") {
          setScannerStatus("DISCONNECTED");
        }

        if (event.state === "error") {
          setScannerStatus("CONNECTION ERROR");
        }
      },

      onMessage: data => {
        if (
          cancelled ||
          data.msg_type !== "tick" ||
          !data.tick
        ) {
          return;
        }

        const tick = data.tick;

        const symbol =
          tick.symbol || data.echo_req?.ticks;

        if (
          !symbol ||
          !SCAN_MARKETS.some(
            item => item.value === symbol
          )
        ) {
          return;
        }

        const model = getModel(symbol);

        const digit = model.extractDigit(
          tick.quote,
          tick.pip_size
        );

        if (digit === null) return;

        const accepted = model.addTick({
          ...tick,
          symbol
        });

        if (!accepted) return;

        // Evaluate the previous forecast against the newly
        // received tick before creating the next forecast.
        model.evaluate(digit);
        model.predict();

        try {
          localStorage.setItem(
            `tradelab_scanner_phase4_${symbol}`,
            JSON.stringify(model.exportState())
          );
        } catch (error) {
          console.warn(
            `Could not persist scanner history for ${symbol}:`,
            error
          );
        }

        refreshRows();
      }
    });

    clientRef.current = client;

    async function startScanner() {
      setScannerError("");
      setScannerStatus("CONNECTING SCANNER SOCKET");

      try {
        await client.connect(accountId);

        if (cancelled) return;

        setScannerStatus("SUBSCRIBING TO MARKETS");

        let subscribed = 0;

        for (const market of SCAN_MARKETS) {
          if (cancelled) return;

          try {
            await client.subscribeTicks(market.value);

            subscribed++;

            setScannerStatus(
              `LIVE SCANNER · ${subscribed}/${SCAN_MARKETS.length} MARKETS`
            );
          } catch (error) {
            console.warn(
              `Could not subscribe to ${market.value}:`,
              error
            );
          }

          // Avoid sending all subscription requests at once.
          await new Promise(resolve =>
            setTimeout(resolve, 180)
          );
        }

        if (!cancelled) {
          if (subscribed > 0) {
            setScannerStatus(
              `SCANNING ${subscribed} LIVE MARKETS`
            );
          } else {
            setScannerStatus(
              "NO MARKET SUBSCRIPTIONS CONFIRMED"
            );
          }

          refreshRows();
        }
      } catch (error) {
        if (!cancelled) {
          setScannerStatus("SCANNER CONNECTION FAILED");

          setScannerError(
            error?.message ||
            "Unable to start the Deriv market scanner."
          );
        }
      }
    }

    refreshRows();
    startScanner();

    return () => {
      cancelled = true;

      client.disconnect();

      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };

    // Reconnect only when the account changes or user retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, accountId, retryKey]);

  const sortedRows = useMemo(() => {
    const copy = [...rows];

    if (sortMode === "accuracy") {
      return copy.sort(
        (a, b) =>
          (b.evaluated - a.evaluated) ||
          (b.accuracy - a.accuracy)
      );
    }

    if (sortMode === "candidate") {
      return copy.sort(
        (a, b) =>
          (Number(b.estimate ?? -1) -
            Number(a.estimate ?? -1)) ||
          (b.ticks - a.ticks)
      );
    }

    const rank = value =>
      value === "ABOVE BASELINE OBSERVED" ? 4 :
      value === "INCONCLUSIVE" ? 3 :
      value === "NEEDS MORE EVALUATIONS" ? 2 :
      value === "BELOW BASELINE OBSERVED" ? 1 : 0;

    return copy.sort(
      (a, b) =>
        rank(b.reliability) - rank(a.reliability) ||
        (b.evaluated - a.evaluated) ||
        (b.accuracy - a.accuracy)
    );
  }, [rows, sortMode]);

  const totals = useMemo(() => ({
    live: rows.filter(
      row =>
        row.lastTickAt &&
        Date.now() - row.lastTickAt < 15000
    ).length,

    evaluations: rows.reduce(
      (sum, row) => sum + row.evaluated,
      0
    ),

    above: rows.filter(
      row =>
        row.reliability === "ABOVE BASELINE OBSERVED"
    ).length
  }), [rows]);

  return (
    <section
      style={{
        ...card,
        borderColor: "#087d69",
        display: "grid",
        gap: 14
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
          <h3 style={{ margin: 0, color: "#f2f7ff" }}>
            Deriv Intelligent Market Scanner
          </h3>

          <p style={{
            color: "#91a3bc",
            fontSize: 12,
            margin: "6px 0 0"
          }}>
            Multi-market live tick monitoring ·
            Phase 4 walk-forward validation
          </p>
        </div>

        <span style={{
          border: "1px solid #236b5a",
          color: "#35d6a2",
          borderRadius: 20,
          padding: "6px 10px",
          fontSize: 11,
          fontWeight: 800
        }}>
          ● {scannerStatus}
        </span>
      </div>

      {scannerError && (
        <div
          role="alert"
          style={{
            color: "#ff8997",
            background: "#2a1c28",
            border: "1px solid #713b4a",
            borderRadius: 8,
            padding: 10,
            fontSize: 12
          }}
        >
          {scannerError}
        </div>
      )}

      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))",
        gap: 9
      }}>
        <div style={{ ...card, padding: 11 }}>
          <small style={{ color: "#91a3bc" }}>
            Markets with recent ticks
          </small>
          <div style={{
            fontSize: 23,
            fontWeight: 800,
            marginTop: 5
          }}>
            {totals.live}/{SCAN_MARKETS.length}
          </div>
        </div>

        <div style={{ ...card, padding: 11 }}>
          <small style={{ color: "#91a3bc" }}>
            Walk-forward evaluations
          </small>
          <div style={{
            fontSize: 23,
            fontWeight: 800,
            marginTop: 5
          }}>
            {totals.evaluations}
          </div>
        </div>

        <div style={{ ...card, padding: 11 }}>
          <small style={{ color: "#91a3bc" }}>
            Above-baseline observed
          </small>
          <div style={{
            fontSize: 23,
            fontWeight: 800,
            color: "#35d6a2",
            marginTop: 5
          }}>
            {totals.above}
          </div>
        </div>
      </div>

      <div style={{
        display: "flex",
        gap: 8,
        alignItems: "center",
        flexWrap: "wrap"
      }}>
        <label
          htmlFor="scanner-sort"
          style={{ color: "#91a3bc", fontSize: 12 }}
        >
          Rank markets by
        </label>

        <select
          id="scanner-sort"
          value={sortMode}
          onChange={event =>
            setSortMode(event.target.value)
          }
          style={{ ...button, padding: "8px 10px" }}
        >
          <option value="reliability">
            Reliability status
          </option>
          <option value="accuracy">
            Evaluated accuracy
          </option>
          <option value="candidate">
            Candidate estimate
          </option>
        </select>

        <button
          type="button"
          style={button}
          onClick={() =>
            setRetryKey(value => value + 1)
          }
          disabled={!connected || !accountId}
        >
          Reconnect scanner
        </button>

        <span style={{
          color: "#71859e",
          fontSize: 11
        }}>
          Last update:{" "}
          {lastUpdate
            ? new Date(lastUpdate).toLocaleTimeString()
            : "Waiting"}
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{
          width: "100%",
          minWidth: 850,
          borderCollapse: "collapse",
          fontSize: 12
        }}>
          <thead>
            <tr>
              {[
                "Market",
                "Latest digit",
                "Candidate digit",
                "Model estimate",
                "Ticks",
                "Evaluations",
                "Accuracy",
                "95% interval",
                "Reliability",
                "Action"
              ].map(label => (
                <th
                  key={label}
                  style={{
                    textAlign: "left",
                    padding: 9,
                    borderBottom: "1px solid #34445c",
                    color: "#91a3bc",
                    whiteSpace: "nowrap"
                  }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {sortedRows.map(row => {
              const live =
                row.lastTickAt &&
                Date.now() - row.lastTickAt < 15000;

              const color =
                row.reliability === "ABOVE BASELINE OBSERVED"
                  ? "#35d6a2"
                  : row.reliability === "BELOW BASELINE OBSERVED"
                    ? "#ff8997"
                    : "#f0bb65";

              return (
                <tr key={row.value}>
                  <td style={{
                    padding: 9,
                    fontWeight: 800,
                    whiteSpace: "nowrap"
                  }}>
                    {row.label}

                    <div style={{
                      color: live ? "#35d6a2" : "#71859e",
                      fontSize: 10,
                      marginTop: 3
                    }}>
                      {live ? "● LIVE" : "○ WAITING"}
                    </div>
                  </td>

                  <td style={{ padding: 9 }}>
                    {row.lastDigit ?? "—"}
                  </td>

                  <td style={{
                    padding: 9,
                    color: "#35d6a2",
                    fontWeight: 800
                  }}>
                    {row.candidate ?? "—"}
                  </td>

                  <td style={{ padding: 9 }}>
                    {row.estimate === null
                      ? "Collecting"
                      : `${row.estimate.toFixed(2)}%`}
                  </td>

                  <td style={{ padding: 9 }}>
                    {row.ticks}
                  </td>

                  <td style={{ padding: 9 }}>
                    {row.evaluated}
                  </td>

                  <td style={{ padding: 9 }}>
                    {row.evaluated
                      ? `${row.accuracy.toFixed(2)}%`
                      : "—"}
                  </td>

                  <td style={{
                    padding: 9,
                    whiteSpace: "nowrap"
                  }}>
                    {row.evaluated
                      ? `${row.interval.low.toFixed(1)}–${row.interval.high.toFixed(1)}%`
                      : "—"}
                  </td>

                  <td style={{
                    padding: 9,
                    color,
                    fontWeight: 800,
                    whiteSpace: "nowrap"
                  }}>
                    {row.reliability}
                  </td>

                  <td style={{ padding: 9 }}>
                    <button
                      type="button"
                      style={{
                        ...button,
                        padding: "6px 9px"
                      }}
                      onClick={() =>
                        onSelectMarket?.(row.value)
                      }
                    >
                      Select
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{
        color: "#91a3bc",
        fontSize: 11,
        lineHeight: 1.65,
        borderTop: "1px solid #26364d",
        paddingTop: 10
      }}>
        <strong style={{ color: "#f0bb65" }}>
          Interpretation and safeguards:
        </strong>{" "}
        The scanner only monitors and ranks markets; it never
        places trades. Candidate estimates are model scores,
        not calibrated win probabilities. “Above baseline
        observed” means the Phase 4 Wilson interval is above
        the 10% reference level in the collected sample; it
        is not proof of a persistent edge. Tick outcomes may
        be serially dependent, and contract payout/price must
        be assessed separately. Scanner histories are stored
        in this browser only. Demo account connection is
        required; real-money execution is not enabled here.
      </div>
    </section>
  );
}
