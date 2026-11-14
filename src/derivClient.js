/* =========================================
   TRADELAB AI — DERIV CLIENT
   Authenticated WebSocket Integration
   DEMO EXECUTION ONLY
========================================= */

const API_BASE = "/api/deriv";

const MAX_DEMO_STAKE = 10;
const CONNECTION_TIMEOUT = 15000;
const REQUEST_TIMEOUT = 15000;

export class DerivClient {
  constructor() {
    this.socket = null;
    this.connected = false;
    this.authorised = false;

    this.accountId = null;
    this.accountType = null;
    this.currency = null;
    this.balance = null;

    this.subscriptions = new Map();
    this.pendingRequests = new Map();
    this.requestId = 0;

    this.listeners = new Map();

    // Prevent duplicate purchases using the same proposal.
    this.usedProposalIds = new Set();
  }

  /* =====================================
     EVENT MANAGEMENT
  ===================================== */

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    this.listeners.get(event).add(callback);

    return () => this.off(event, callback);
  }

  off(event, callback) {
    this.listeners.get(event)?.delete(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event);

    if (!callbacks) return;

    callbacks.forEach(callback => {
      try {
        callback(data);
      } catch (error) {
        console.error("Deriv listener error:", error);
      }
    });
  }

  /* =====================================
     HTTP HELPERS
  ===================================== */

  async request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      credentials: "same-origin",
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });

    let data;

    try {
      data = await response.json();
    } catch {
      throw new Error("Invalid response from TradeLab server");
    }

    if (!response.ok) {
      throw new Error(
        data.error || `Deriv request failed (${response.status})`
      );
    }

    return data;
  }

  async getStatus() {
    return this.request("/status");
  }

  async getAccounts() {
    const result = await this.request("/accounts");

    if (!result.connected) {
      throw new Error("Deriv account is not connected");
    }

    return result.accounts || [];
  }

  /* =====================================
     AUTHENTICATED WEBSOCKET CONNECTION
  ===================================== */

  async connect(accountId) {
    if (!accountId) {
      throw new Error("A Deriv account must be selected");
    }

    if (
      this.connected &&
      this.accountId === accountId &&
      this.accountType === "demo"
    ) {
      return true;
    }

    this.disconnect();

    const result = await this.request("/otp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        account_id: accountId
      })
    });

    if (!result.websocket_url) {
      throw new Error("Deriv WebSocket URL unavailable");
    }

    if (result.account_type !== "demo") {
      throw new Error("Only demo accounts are permitted");
    }

    // Validate the returned WebSocket address.
    let wsUrl;

    try {
      wsUrl = new URL(result.websocket_url);
    } catch {
      throw new Error("Invalid Deriv WebSocket URL");
    }

    if (
      wsUrl.protocol !== "wss:" ||
      wsUrl.hostname !== "api.derivws.com"
    ) {
      throw new Error("Untrusted Deriv WebSocket address");
    }

    this.accountId = accountId;
    this.accountType = "demo";

    return new Promise((resolve, reject) => {
      let settled = false;

      const socket = new WebSocket(result.websocket_url);

      this.socket = socket;

      const timeout = setTimeout(() => {
        if (settled) return;

        settled = true;
        socket.close();

        reject(new Error("Deriv connection timed out"));
      }, CONNECTION_TIMEOUT);

      socket.onopen = () => {
        if (settled) return;

        clearTimeout(timeout);

        this.connected = true;

        // The OTP URL establishes the authenticated session.
        this.authorised = true;

        settled = true;

        this.emit("connected", {
          accountId,
          accountType: this.accountType
        });

        resolve(true);
      };

      socket.onmessage = event => {
        this.handleMessage(event);
      };

      socket.onerror = () => {
        this.emit("error", {
          message: "Deriv WebSocket connection error"
        });

        if (!settled) {
          clearTimeout(timeout);
          settled = true;

          reject(new Error("Unable to connect to Deriv"));
        }
      };

      socket.onclose = () => {
        clearTimeout(timeout);

        this.connected = false;
        this.authorised = false;

        this.rejectPending(
          new Error("Deriv connection closed")
        );

        this.emit("disconnected", {
          accountId: this.accountId
        });
      };
    });
  }

  /* =====================================
     WEBSOCKET MESSAGE HANDLING
  ===================================== */

  handleMessage(event) {
    let message;

    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.error) {
      const error = new Error(
        message.error.message || "Deriv API error"
      );

      const pending = this.pendingRequests.get(
        message.req_id
      );

      if (pending) {
        clearTimeout(pending.timeout);
        pending.reject(error);

        this.pendingRequests.delete(message.req_id);
      }

      this.emit("error", {
        message: error.message,
        details: message.error
      });

      return;
    }

    // Resolve request-response calls.
    if (message.req_id) {
      const pending = this.pendingRequests.get(
        message.req_id
      );

      if (pending) {
        clearTimeout(pending.timeout);
        pending.resolve(message);

        this.pendingRequests.delete(message.req_id);
      }
    }

    if (message.msg_type === "authorize") {
      this.authorised = true;

      this.currency =
        message.authorize?.currency || this.currency;

      this.balance =
        Number(message.authorize?.balance ?? this.balance ?? 0);

      this.emit("authorised", message.authorize);
    }

    if (message.msg_type === "balance") {
      const balance = message.balance;

      this.balance = Number(balance?.balance ?? 0);

      this.currency =
        balance?.currency || this.currency;

      this.emit("balance", balance);
    }

    if (message.msg_type === "portfolio") {
      this.emit(
        "portfolio",
        message.portfolio?.contracts || []
      );
    }

    if (message.msg_type === "statement") {
      this.emit(
        "statement",
        message.statement?.transactions || []
      );
    }

    if (message.msg_type === "profit_table") {
      this.emit(
        "profit_table",
        message.profit_table?.transactions || []
      );
    }

    if (message.msg_type === "tick") {
      this.emit("tick", message.tick);
    }

    if (message.msg_type === "proposal") {
      this.emit("proposal", message.proposal);
    }

    if (message.msg_type === "buy") {
      this.emit("buy", message.buy);
    }

    if (message.msg_type === "proposal_open_contract") {
      this.emit(
        "contract",
        message.proposal_open_contract
      );
    }

    if (message.subscription?.id) {
      this.subscriptions.set(
        message.msg_type,
        message.subscription.id
      );
    }
  }

  /* =====================================
     SEND API REQUEST
  ===================================== */

  send(payload) {
    if (
      !this.socket ||
      this.socket.readyState !== WebSocket.OPEN
    ) {
      throw new Error("Deriv WebSocket is not connected");
    }

    const reqId = ++this.requestId;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const pending = this.pendingRequests.get(reqId);

        if (pending) {
          this.pendingRequests.delete(reqId);

          pending.reject(
            new Error("Deriv request timed out")
          );
        }
      }, REQUEST_TIMEOUT);

      this.pendingRequests.set(reqId, {
        resolve,
        reject,
        timeout
      });

      try {
        this.socket.send(
          JSON.stringify({
            ...payload,
            req_id: reqId
          })
        );
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRequests.delete(reqId);
        reject(error);
      }
    });
  }

  rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  /* =====================================
     ACCOUNT AUTHORISATION
  ===================================== */

  async authorise() {
    this.requireConnected();

    // OTP authentication is already established
    // when the authenticated WebSocket opens.
    this.authorised = true;

    return true;
  }

  /* =====================================
     ACCOUNT BALANCE
  ===================================== */

  async getBalance(subscribe = true) {
    this.requireAuthorised();

    const result = await this.send({
      balance: 1,
      subscribe: subscribe ? 1 : 0
    });

    const balance = result.balance;

    this.balance = Number(balance?.balance ?? 0);
    this.currency = balance?.currency || this.currency;

    return balance;
  }

  /* =====================================
     OPEN POSITIONS
  ===================================== */

  async getPortfolio() {
    this.requireAuthorised();

    const result = await this.send({
      portfolio: 1
    });

    return result.portfolio?.contracts || [];
  }

  /* =====================================
     TRADE HISTORY
  ===================================== */

  async getStatement(limit = 100) {
    this.requireAuthorised();

    const result = await this.send({
      statement: 1,
      description: 1,
      limit: Math.min(500, Math.max(1, Number(limit) || 100))
    });

    return result.statement?.transactions || [];
  }

  async getProfitTable(limit = 100) {
    this.requireAuthorised();

    const result = await this.send({
      profit_table: 1,
      description: 1,
      limit: Math.min(500, Math.max(1, Number(limit) || 100)),
      sort: "DESC"
    });

    return result.profit_table?.transactions || [];
  }

  /* =====================================
     LIVE MARKET DATA
  ===================================== */

  async subscribeTicks(symbol) {
    this.requireConnected();

    if (!/^[A-Za-z0-9_]+$/.test(symbol)) {
      throw new Error("Invalid Deriv market symbol");
    }

    const result = await this.send({
      ticks: symbol,
      subscribe: 1
    });

    return result.tick;
  }

  /* =====================================
     ACTIVE MARKET SYMBOLS
  ===================================== */

  async getActiveSymbols() {
    this.requireConnected();

    const result = await this.send({
      active_symbols: "brief"
    });

    return result.active_symbols || [];
  }

  /* =====================================
     TRADE PROPOSAL
  ===================================== */

  async createProposal({
    symbol,
    contractType,
    stake,
    duration = 5,
    durationUnit = "m"
  }) {
    this.requireDemoAuthorised();

    const amount = Number(stake);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_DEMO_STAKE
    ) {
      throw new Error(
        `Demo stake must be between 0 and ${MAX_DEMO_STAKE}`
      );
    }

    const allowedContracts = ["CALL", "PUT"];

    if (!allowedContracts.includes(contractType)) {
      throw new Error("Unsupported contract type");
    }

    if (!/^[A-Za-z0-9_]+$/.test(symbol)) {
      throw new Error("Invalid market symbol");
    }

    const validUnits = ["s", "m", "h", "d", "t"];

    if (!validUnits.includes(durationUnit)) {
      throw new Error("Invalid contract duration unit");
    }

    const durationValue = Number(duration);

    if (
      !Number.isInteger(durationValue) ||
      durationValue < 1
    ) {
      throw new Error("Invalid contract duration");
    }

    if (!this.currency) {
      throw new Error(
        "Account currency is unavailable. Refresh account balance first."
      );
    }

    const result = await this.send({
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: contractType,
      currency: this.currency,
      duration: durationValue,
      duration_unit: durationUnit,

      // Deriv requires underlying_symbol.
      underlying_symbol: symbol
    });

    if (!result.proposal?.id) {
      throw new Error("Deriv did not return a valid proposal");
    }

    return result.proposal;
  }

  /* =====================================
     DEMO ORDER EXECUTION
  ===================================== */

  async buyDemoContract(
    proposalId,
    price,
    confirmed = false
  ) {
    this.requireDemoAuthorised();

    if (confirmed !== true) {
      throw new Error(
        "Explicit trade confirmation required"
      );
    }

    if (!proposalId) {
      throw new Error("Valid proposal ID required");
    }

    if (this.usedProposalIds.has(String(proposalId))) {
      throw new Error(
        "This proposal has already been used. Request a new proposal."
      );
    }

    const maximumPrice = Number(price);

    if (
      !Number.isFinite(maximumPrice) ||
      maximumPrice <= 0 ||
      maximumPrice > MAX_DEMO_STAKE
    ) {
      throw new Error(
        `Maximum demo purchase price is ${MAX_DEMO_STAKE}`
      );
    }

    // Lock the proposal before sending the purchase request.
    // This prevents accidental repeat purchases.
    this.usedProposalIds.add(String(proposalId));

    try {
      const result = await this.send({
        buy: String(proposalId),
        price: maximumPrice
      });

      if (!result.buy?.contract_id) {
        throw new Error(
          "Deriv did not confirm the contract purchase"
        );
      }

      this.emit("buy", result.buy);

      return result.buy;
    } catch (error) {
      // Do not unlock the proposal automatically.
      // A timeout can occur after Deriv has processed an order.
      throw error;
    }
  }

  /* =====================================
     CONTRACT MONITORING
  ===================================== */

  async monitorContract(contractId) {
    this.requireAuthorised();

    if (!contractId) {
      throw new Error("Contract ID required");
    }

    return this.send({
      proposal_open_contract: 1,
      contract_id: contractId,
      subscribe: 1
    });
  }

  /* =====================================
     SUBSCRIPTION MANAGEMENT
  ===================================== */

  async forgetSubscription(subscriptionId) {
    this.requireConnected();

    if (!subscriptionId) {
      return false;
    }

    await this.send({
      forget: subscriptionId
    });

    return true;
  }

  async forgetAll() {
    if (!this.connected) return;

    const ids = [...this.subscriptions.values()];

    for (const id of ids) {
      try {
        await this.forgetSubscription(id);
      } catch (error) {
        console.warn(
          "Subscription cleanup failed:",
          error.message
        );
      }
    }

    this.subscriptions.clear();
  }

  /* =====================================
     SECURITY CHECKS
  ===================================== */

  requireConnected() {
    if (!this.connected) {
      throw new Error("Deriv is not connected");
    }
  }

  requireAuthorised() {
    this.requireConnected();

    if (!this.authorised) {
      throw new Error("Deriv account is not authorised");
    }
  }

  requireDemoAuthorised() {
    this.requireAuthorised();

    if (this.accountType !== "demo") {
      throw new Error(
        "Real-money trading is disabled"
      );
    }
  }

  /* =====================================
     DISCONNECT
  ===================================== */

  disconnect() {
    const socket = this.socket;

    this.socket = null;
    this.connected = false;
    this.authorised = false;

    this.accountId = null;
    this.accountType = null;
    this.currency = null;
    this.balance = null;

    this.subscriptions.clear();

    this.rejectPending(
      new Error("Deriv client disconnected")
    );

    if (
      socket &&
      socket.readyState !== WebSocket.CLOSED &&
      socket.readyState !== WebSocket.CLOSING
    ) {
      socket.close();
    }

    this.emit("disconnected", {});
  }
}

/* =========================================
   SHARED CLIENT INSTANCE
========================================= */

const derivClient = new DerivClient();

export default derivClient;
