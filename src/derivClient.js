/* =========================================
   TRADELAB AI — DERIV CLIENT
   Authenticated WebSocket Integration
   DEMO EXECUTION ONLY
========================================= */

const API_BASE = "/api/deriv";

const MAX_DEMO_STAKE = 10;
const CONNECTION_TIMEOUT = 15000;

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

    const data = await response.json();

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
    if (this.connected && this.accountId === accountId) {
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

    this.accountId = accountId;
    this.accountType = result.account_type;

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(result.websocket_url);

      this.socket = socket;

      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Deriv connection timed out"));
      }, CONNECTION_TIMEOUT);

    socket.onopen = () => {
  clearTimeout(timeout);

  this.connected = true;
  this.authorised = true;

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
        clearTimeout(timeout);

        this.emit("error", {
          message: "Deriv WebSocket connection error"
        });

        if (!this.connected) {
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
        pending.reject(error);
        this.pendingRequests.delete(message.req_id);
      }

      this.emit("error", {
        message: error.message,
        details: message.error
      });

      return;
    }

    if (message.req_id) {
      const pending = this.pendingRequests.get(
        message.req_id
      );

      if (pending) {
        pending.resolve(message);
        this.pendingRequests.delete(message.req_id);
      }
    }

    if (message.msg_type === "authorize") {
      this.authorised = true;

      this.currency =
        message.authorize?.currency || null;

      this.balance =
        Number(message.authorize?.balance ?? 0);

      this.emit("authorised", message.authorize);
    }

    if (message.msg_type === "balance") {
      const balance = message.balance;

      this.balance = Number(balance?.balance ?? 0);

      this.currency = balance?.currency || this.currency;

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
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error("Deriv WebSocket is not connected");
    }

    const reqId = ++this.requestId;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(reqId, {
        resolve,
        reject
      });

      try {
        this.socket.send(JSON.stringify({
          ...payload,
          req_id: reqId
        }));
      } catch (error) {
        this.pendingRequests.delete(reqId);
        reject(error);
      }

      setTimeout(() => {
        const pending = this.pendingRequests.get(reqId);

        if (pending) {
          this.pendingRequests.delete(reqId);
          pending.reject(
            new Error("Deriv request timed out")
          );
        }
      }, CONNECTION_TIMEOUT);
    });
  }

  rejectPending(error) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }

    this.pendingRequests.clear();
  }

  /* =====================================
     ACCOUNT AUTHORISATION
  ===================================== */

  async authorise() {
    if (!this.connected) {
      throw new Error("Connect to Deriv first");
    }

    const result = await this.send({
      authorize: 1
    });

    if (!result.authorize) {
      throw new Error("Deriv authorisation failed");
    }

    this.authorised = true;

    return result.authorize;
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

    return result.balance;
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
      limit: Math.min(500, Math.max(1, limit))
    });

    return result.statement?.transactions || [];
  }

  /* =====================================
     LIVE MARKET DATA
  ===================================== */

  async subscribeTicks(symbol) {
    this.requireConnected();

    const result = await this.send({
      ticks: symbol,
      subscribe: 1
    });

    return result.tick;
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

    const allowedContracts = [
      "CALL",
      "PUT"
    ];

    if (!allowedContracts.includes(contractType)) {
      throw new Error("Unsupported contract type");
    }

    if (!/^[A-Za-z0-9_]+$/.test(symbol)) {
      throw new Error("Invalid market symbol");
    }

    const result = await this.send({
      proposal: 1,
      amount,
      basis: "stake",
      contract_type: contractType,
      currency: this.currency,
      duration,
      duration_unit: durationUnit,
      symbol
    });

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

    const amount = Number(price);

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > MAX_DEMO_STAKE
    ) {
      throw new Error("Invalid demo purchase amount");
    }

    const result = await this.send({
      buy: proposalId,
      price: amount
    });

    return result.buy;
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

    if (!subscriptionId) return false;

    await this.send({
      forget: subscriptionId
    });

    return true;
  }

  async forgetAll() {
    if (!this.connected) return;

    const ids = [
      ...this.subscriptions.values()
    ];

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
    if (this.socket) {
      this.socket.close();
    }

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

    this.emit("disconnected", {});
  }
}

/* =========================================
   SHARED CLIENT INSTANCE
========================================= */

const derivClient = new DerivClient();

export default derivClient;
