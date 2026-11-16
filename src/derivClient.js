/* ============================================================
   TradeLab AI — Deriv Demo Trading Client
   File: src/derivClient.js

   Authentication:
     GET  /api/deriv/accounts
     POST /api/deriv/otp { account_id }

   Security:
     - Demo accounts only.
     - Maximum stake: $10 per proposal.
     - Explicit confirmation required before buying.
     - Duplicate proposal purchases blocked in this client.
     - No Deriv access token stored in browser code.

   IMPORTANT:
     Stake and duplicate protections in this file are client-side.
     Server-enforced limits require Worker-side trade execution.
   ============================================================ */

const API = "/api/deriv";

const REQUEST_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 20000;
const MAX_STAKE = 10;
const MAX_PROPOSAL_AGE_MS = 120000;

const ALLOWED_CONTRACT_TYPES = new Set(["CALL", "PUT"]);

const VALID_SYMBOL = /^[A-Za-z0-9_]+$/;
const VALID_CONTRACT_ID = /^\d+$/;

export class DerivClient {
  constructor({ onMessage = () => {}, onStatus = () => {} } = {}) {
    this.ws = null;

    this.reqId = 0;
    this.pending = new Map();
    this.subscriptions = new Set();

    this.onMessage = onMessage;
    this.onStatus = onStatus;

    this.account = null;
    this.connected = false;
    this.connecting = false;

    this.usedProposals = new Set();
    this.proposals = new Map();

    this.lastBalance = null;
    this.lastPortfolio = [];
  }

  /* ============================================================
     HTTP REQUESTS — AUTHENTICATED WORKER
     ============================================================ */

  async request(path, options = {}) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(`${API}${path}`, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
        headers: {
          ...(options.body
            ? { "Content-Type": "application/json" }
            : {}),
          ...(options.headers || {})
        }
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.ok === false) {
        throw new Error(
          data.error || `Deriv request failed (${response.status}).`
        );
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("Deriv authentication request timed out.");
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async getAccounts() {
    const data = await this.request("/accounts");

    return Array.isArray(data.accounts)
      ? data.accounts
      : [];
  }

  /* ============================================================
     ACCOUNT CONNECTION
     ============================================================ */

  async connect(accountId) {
    if (!accountId) {
      throw new Error("Select a Deriv account first.");
    }

    if (this.connecting) {
      throw new Error("A Deriv connection is already being established.");
    }

    this.disconnect();

    this.connecting = true;

    this.onStatus({
      state: "connecting",
      accountId: String(accountId)
    });

    try {
      const auth = await this.request("/otp", {
        method: "POST",
        body: JSON.stringify({
          account_id: String(accountId)
        })
      });

      if (!auth.websocket_url) {
        throw new Error(
          "Deriv did not return an authenticated WebSocket URL."
        );
      }

      const accountType = String(
        auth.account_type || ""
      ).toLowerCase();

      if (accountType !== "demo") {
        throw new Error(
          "TradeLab AI currently supports demo accounts only. Real-money execution is disabled."
        );
      }

      this.account = {
        id: String(accountId),
        type: "demo"
      };

      await this._openSocket(auth.websocket_url);

      this.connected = true;

      this.onStatus({
        state: "connected",
        account: this.account
      });

      // Initial account information.
      const [balance, portfolio] = await Promise.all([
        this.getBalance(),
        this.getOpenPositions()
      ]);

      this.lastBalance = balance;
      this.lastPortfolio = portfolio;

      return {
        connected: true,
        account: this.account,
        balance,
        portfolio
      };
    } catch (error) {
      this.disconnect();

      this.onStatus({
        state: "error",
        error: error.message
      });

      throw error;
    } finally {
      this.connecting = false;
    }
  }

  _openSocket(url) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const socket = new WebSocket(url);

      this.ws = socket;

      const timer = setTimeout(() => {
        if (settled) return;

        settled = true;

        socket.close();

        reject(
          new Error("Deriv WebSocket connection timed out.")
        );
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (settled) return;

        settled = true;

        clearTimeout(timer);

        this.connected = true;

        resolve();
      };

      socket.onerror = () => {
        if (settled) {
          return;
        }

        settled = true;

        clearTimeout(timer);

        reject(
          new Error("Unable to establish Deriv WebSocket connection.")
        );
      };

      socket.onclose = () => {
        clearTimeout(timer);

        this.connected = false;

        this._rejectPending(
          new Error("Deriv connection closed.")
        );

        this.subscriptions.clear();

        this.onStatus({
          state: "disconnected"
        });
      };

      socket.onmessage = event => {
        this._handleMessage(event);
      };
    });
  }

  /* ============================================================
     WEBSOCKET MESSAGE HANDLING
     ============================================================ */

  _handleMessage(event) {
    let data;

    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data.subscription?.id) {
      this.subscriptions.add(
        data.subscription.id
      );
    }

    if (
      data.req_id !== undefined &&
      this.pending.has(data.req_id)
    ) {
      const item = this.pending.get(data.req_id);

      clearTimeout(item.timer);

      this.pending.delete(data.req_id);

      if (data.error) {
        item.reject(
          new Error(
            data.error.message || "Deriv API error."
          )
        );
      } else {
        item.resolve(data);
      }
    }

    this.onMessage(data);
  }

  _rejectPending(error) {
    for (const [id, item] of this.pending) {
      clearTimeout(item.timer);
      item.reject(error);
      this.pending.delete(id);
    }
  }

  /* ============================================================
     WEBSOCKET REQUEST HANDLER
     ============================================================ */

  send(payload, timeout = REQUEST_TIMEOUT_MS) {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(
        new Error("Deriv is not connected.")
      );
    }

    const req_id = ++this.reqId;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);

        reject(
          new Error("Deriv request timed out.")
        );
      }, timeout);

      this.pending.set(req_id, {
        resolve,
        reject,
        timer
      });

      try {
        this.ws.send(
          JSON.stringify({
            ...payload,
            req_id
          })
        );
      } catch (error) {
        clearTimeout(timer);

        this.pending.delete(req_id);

        reject(
          new Error(
            error.message || "Unable to send Deriv request."
          )
        );
      }
    });
  }

  /* ============================================================
     ACCOUNT INFORMATION
     ============================================================ */

  async getBalance() {
    const result = await this.send({
      balance: 1
    });

    if (!result.balance) {
      throw new Error("Deriv returned no balance information.");
    }

    this.lastBalance = result.balance;

    return result.balance;
  }

  async getOpenPositions() {
    const result = await this.send({
      portfolio: 1
    });

    const contracts =
      result.portfolio?.contracts || [];

    this.lastPortfolio = contracts;

    return contracts;
  }

  async getTradeStatement({
    limit = 50,
    offset = 0
  } = {}) {
    const safeLimit = Math.min(
      100,
      Math.max(1, Math.floor(Number(limit) || 50))
    );

    const safeOffset = Math.max(
      0,
      Math.floor(Number(offset) || 0)
    );

    const result = await this.send({
      statement: 1,
      description: 1,
      limit: safeLimit,
      offset: safeOffset
    });

    return result.statement || {};
  }

  async getProfitTable({
    limit = 50,
    offset = 0
  } = {}) {
    const safeLimit = Math.min(
      100,
      Math.max(1, Math.floor(Number(limit) || 50))
    );

    const safeOffset = Math.max(
      0,
      Math.floor(Number(offset) || 0)
    );

    const result = await this.send({
      profit_table: 1,
      description: 1,
      limit: safeLimit,
      offset: safeOffset
    });

    return result.profit_table || {};
  }

  async refreshAccount() {
    const [balance, portfolio] = await Promise.all([
      this.getBalance(),
      this.getOpenPositions()
    ]);

    return {
      balance,
      portfolio
    };
  }

  /* ============================================================
     MARKET DATA
     ============================================================ */

  async subscribeTicks(symbol) {
    if (!VALID_SYMBOL.test(String(symbol || ""))) {
      throw new Error("Invalid Deriv market symbol.");
    }

    return this.send({
      ticks: String(symbol),
      subscribe: 1
    });
  }

  /* ============================================================
     PROPOSAL VALIDATION
     ============================================================ */

  async getProposal({
    symbol,
    contractType,
    amount,
    currency = "USD",
    duration,
    durationUnit = "m"
  }) {
    if (!this.account || this.account.type !== "demo") {
      throw new Error("A connected Deriv demo account is required.");
    }

    if (!this.connected) {
      throw new Error("Deriv is not connected.");
    }

    const stake = Number(amount);

    if (
      !Number.isFinite(stake) ||
      stake <= 0 ||
      stake > MAX_STAKE
    ) {
      throw new Error(
        `Demo stake must be greater than zero and no more than ${MAX_STAKE}.`
      );
    }

    if (!VALID_SYMBOL.test(String(symbol || ""))) {
      throw new Error("Invalid market symbol.");
    }

    const type = String(contractType || "").toUpperCase();

    if (!ALLOWED_CONTRACT_TYPES.has(type)) {
      throw new Error(
        "Only Rise (CALL) and Fall (PUT) contracts are supported."
      );
    }

    const units = {
      s: 86400,
      m: 1440,
      h: 24,
      d: 365
    };

    if (
      !units[durationUnit] ||
      !Number.isInteger(Number(duration)) ||
      Number(duration) < 1 ||
      Number(duration) > units[durationUnit]
    ) {
      throw new Error("Invalid contract duration.");
    }

    const selectedCurrency = String(currency || "USD").toUpperCase();

    if (!/^[A-Z]{3}$/.test(selectedCurrency)) {
      throw new Error("Invalid account currency.");
    }

    const result = await this.send({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: type,
      currency: selectedCurrency,
      duration: Number(duration),
      duration_unit: durationUnit,
      underlying_symbol: String(symbol)
    });

    const proposal = result.proposal;

    if (!proposal?.id) {
      throw new Error(
        "Deriv did not return a valid proposal."
      );
    }

    const askPrice = Number(proposal.ask_price);

    if (
      !Number.isFinite(askPrice) ||
      askPrice <= 0
    ) {
      throw new Error(
        "Deriv returned an invalid proposal price."
      );
    }

    const proposalRecord = {
      id: String(proposal.id),
      ask_price: askPrice,
      payout: Number(proposal.payout || 0),
      spot: proposal.spot,
      longcode: proposal.longcode,
      date_start: proposal.date_start,
      symbol: String(symbol),
      contract_type: type,
      amount: stake,
      currency: selectedCurrency,
      duration: Number(duration),
      duration_unit: durationUnit,
      createdAt: Date.now()
    };

    this.proposals.set(
      proposalRecord.id,
      proposalRecord
    );

    return {
      ...proposal,
      ...proposalRecord
    };
  }

  /* ============================================================
     DEMO ORDER EXECUTION
     ============================================================ */

  async buyDemoProposal(
    proposalId,
    maxPrice,
    { confirmed = false } = {}
  ) {
    if (!confirmed) {
      throw new Error(
        "Explicit user confirmation is required before placing a demo order."
      );
    }

    if (!this.account || this.account.type !== "demo") {
      throw new Error(
        "Demo account required. Real-money execution is disabled."
      );
    }

    if (!this.connected) {
      throw new Error("Deriv is not connected.");
    }

    const id = String(proposalId || "");

    if (!id || id.length > 128) {
      throw new Error(
        "Invalid or expired proposal. Request a fresh proposal."
      );
    }

    if (this.usedProposals.has(id)) {
      throw new Error(
        "This proposal has already been submitted. Request a new quote."
      );
    }

    const proposal = this.proposals.get(id);

    if (!proposal) {
      throw new Error(
        "Proposal not found in this session. Request a fresh proposal."
      );
    }

    if (
      Date.now() - proposal.createdAt >
      MAX_PROPOSAL_AGE_MS
    ) {
      this.proposals.delete(id);

      throw new Error(
        "Proposal expired. Request a fresh quote."
      );
    }

    if (proposal.amount > MAX_STAKE) {
      throw new Error(
        `Maximum demo stake is ${MAX_STAKE}.`
      );
    }

    const price = Number(maxPrice);

    if (
      !Number.isFinite(price) ||
      price <= 0
    ) {
      throw new Error("Invalid maximum purchase price.");
    }

    if (price < proposal.ask_price) {
      throw new Error(
        "Maximum purchase price is below the quoted proposal price."
      );
    }

    // Mark before sending to prevent rapid duplicate clicks.
    this.usedProposals.add(id);

    try {
      const result = await this.send({
        buy: id,
        price
      });

      if (!result.buy?.contract_id) {
        throw new Error(
          "Deriv did not confirm the purchase."
        );
      }

      const purchase = result.buy;

      this.proposals.delete(id);

      // Refresh account information after successful purchase.
      let accountSnapshot = null;

      try {
        accountSnapshot = await this.refreshAccount();
      } catch (error) {
        console.warn(
          "Trade purchased, but account refresh failed:",
          error.message
        );
      }

      return {
        ...purchase,
        accountSnapshot
      };
    } catch (error) {
      // Do not allow automatic reuse after an uncertain request.
      // A new proposal must be requested.
      throw error;
    }
  }

  /* ============================================================
     OPEN CONTRACT MONITORING
     ============================================================ */

  async monitorContract(contractId) {
    const id = String(contractId || "");

    if (!VALID_CONTRACT_ID.test(id)) {
      throw new Error("Invalid contract ID.");
    }

    if (!this.connected) {
      throw new Error("Deriv is not connected.");
    }

    return this.send({
      proposal_open_contract: 1,
      contract_id: Number(id),
      subscribe: 1
    });
  }

  /* ============================================================
     SUBSCRIPTION MANAGEMENT
     ============================================================ */

  forget(subscriptionId) {
    if (
      !subscriptionId ||
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      return;
    }

    this.ws.send(
      JSON.stringify({
        forget: subscriptionId
      })
    );

    this.subscriptions.delete(subscriptionId);
  }

  forgetAllSubscriptions() {
    if (
      !this.ws ||
      this.ws.readyState !== WebSocket.OPEN
    ) {
      this.subscriptions.clear();
      return;
    }

    for (const id of this.subscriptions) {
      this.ws.send(
        JSON.stringify({
          forget: id
        })
      );
    }

    this.subscriptions.clear();
  }

  /* ============================================================
     DISCONNECT
     ============================================================ */

  disconnect() {
    this.forgetAllSubscriptions();

    this._rejectPending(
      new Error("Deriv client disconnected.")
    );

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;

      if (
        this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING
      ) {
        this.ws.close();
      }
    }

    this.ws = null;

    this.connected = false;
    this.connecting = false;

    this.account = null;

    this.proposals.clear();
    this.usedProposals.clear();

    this.lastBalance = null;
    this.lastPortfolio = [];

    this.onStatus({
      state: "disconnected"
    });
  }
}

export default DerivClient;
