/* TradeLab AI — Deriv authenticated WebSocket client
 * Place at src/derivClient.js
 * Uses the existing authenticated Worker routes:
 *   GET  /api/deriv/accounts
 *   POST /api/deriv/otp { account_id }
 * No Deriv access token is exposed to the browser.
 */

const API = '/api/deriv';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_STAKE = 10; // Conservative demo default; change only after risk review.

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
    this.availableContracts = new Map();
  }

  async request(path, options = {}) {
    const response = await fetch(`${API}${path}`, {
      credentials: 'same-origin',
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `Deriv request failed (${response.status})`);
    return data;
  }

  async getAccounts() {
    const data = await this.request('/accounts');
    return Array.isArray(data.accounts) ? data.accounts : [];
  }

  async connect(accountId) {
    if (!accountId) throw new Error('Select a Deriv account first.');
    this.disconnect();
    this.onStatus({ state: 'connecting', accountId });
    const auth = await this.request('/otp', {
      method: 'POST',
      body: JSON.stringify({ account_id: String(accountId) })
    });
    if (!auth.websocket_url) throw new Error('Deriv did not return an authenticated WebSocket URL.');

    const accountType = String(auth.account_type || '').toLowerCase();
    this.account = { id: String(accountId), type: accountType };
    if (accountType !== 'demo') {
      throw new Error('TradeLab AI currently permits demo-account streaming and execution only.');
    }

    await new Promise((resolve, reject) => {
      const socket = new WebSocket(auth.websocket_url);
      this.ws = socket;
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error('Deriv WebSocket connection timed out.'));
      }, REQUEST_TIMEOUT_MS);

      socket.onopen = () => {
        clearTimeout(timer);
        this.connected = true;
        this.onStatus({ state: 'connected', account: this.account });
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error('Unable to establish Deriv WebSocket connection.'));
      };
      socket.onclose = () => {
        this.connected = false;
        this.onStatus({ state: 'disconnected' });
        for (const [id, item] of this.pending) {
          clearTimeout(item.timer);
          item.reject(new Error('Deriv connection closed.'));
          this.pending.delete(id);
        }
      };
      socket.onmessage = event => this._handleMessage(event);
    });

    // Initial account snapshot and live balance stream.
    const snapshot = await this.refreshAccount();
    return { connected: true, account: this.account, ...snapshot };
  }

  _handleMessage(event) {
    let data;
    try { data = JSON.parse(event.data); } catch { return; }
    if (data.subscription?.id) this.subscriptions.add(data.subscription.id);
    if (data.req_id && this.pending.has(data.req_id)) {
      const item = this.pending.get(data.req_id);
      clearTimeout(item.timer);
      this.pending.delete(data.req_id);
      if (data.error) item.reject(new Error(data.error.message || 'Deriv API error'));
      else item.resolve(data);
    }
    this.onMessage(data);
  }

  send(payload, timeout = REQUEST_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Deriv is not connected.'));
    }
    const req_id = ++this.reqId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error('Deriv request timed out.'));
      }, timeout);
      this.pending.set(req_id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ ...payload, req_id }));
    });
  }

  async getBalance() {
    const result = await this.send({ balance: 1 });
    return result.balance;
  }

  async refreshAccount() {
    if (!this.connected) throw new Error('Deriv is not connected.');
    const [balanceResult, portfolioResult] = await Promise.all([
      this.send({ balance: 1 }),
      this.send({ portfolio: 1 })
    ]);
    return {
      balance: balanceResult.balance || null,
      portfolio: portfolioResult.portfolio?.contracts || []
    };
  }

  async getProfitTable({ limit = 50, offset = 0 } = {}) {
    const statement = await this.getTradeStatement({ limit, offset });
    const transactions = Array.isArray(statement?.transactions)
      ? statement.transactions
      : Array.isArray(statement?.statement)
        ? statement.statement
        : Array.isArray(statement)
          ? statement
          : [];
    return { transactions, statement };
  }

  async getAvailableContracts(symbol, { force = false } = {}) {
    if (!this.account || this.account.type !== 'demo') throw new Error('Demo account required.');
    const market = String(symbol || '');
    if (!/^[A-Za-z0-9_]{2,32}$/.test(market)) throw new Error('Invalid Deriv market symbol.');
    if (!force && this.availableContracts.has(market)) return this.availableContracts.get(market);
    const result = await this.send({ contracts_for: market });
    const available = Array.isArray(result.contracts_for?.available)
      ? result.contracts_for.available.filter(item => item && typeof item.contract_type === 'string')
      : [];
    this.availableContracts.set(market, available);
    return available;
  }

  async getOpenPositions() {
    const result = await this.send({ portfolio: 1 });
    return result.portfolio?.contracts || [];
  }

  async getTradeStatement({ limit = 50, offset = 0 } = {}) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(Number(limit) || 50)));
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const result = await this.send({ statement: 1, description: 1, limit: safeLimit, offset: safeOffset });
    return result.statement;
  }

  async subscribeTicks(symbol) {
    if (!/^[A-Za-z0-9_]+$/.test(String(symbol || ''))) throw new Error('Invalid Deriv market symbol.');
    return this.send({ ticks: symbol, subscribe: 1 });
  }

  async getProposal({ symbol, contractType, amount, currency, duration, durationUnit = 'm' }) {
    if (!this.account || this.account.type !== 'demo') throw new Error('Demo account required.');
    const stake = Number(amount);
    if (!Number.isFinite(stake) || stake <= 0 || stake > MAX_STAKE) {
      throw new Error(`Demo stake must be greater than zero and no more than ${MAX_STAKE}.`);
    }
    if (!/^[A-Za-z0-9_]+$/.test(String(symbol || ''))) throw new Error('Invalid market symbol.');
    if (!/^[A-Z0-9_]{2,32}$/.test(String(contractType || ''))) throw new Error('Invalid contract type.');
    const available = await this.getAvailableContracts(symbol);
    if (!available.some(item => item.contract_type.toUpperCase() === String(contractType).toUpperCase())) {
      throw new Error('This contract type is not available for the selected market. Refresh available contracts and try again.');
    }
    const units = { s: 86400, m: 1440, h: 24, d: 365 };
    if (!units[durationUnit] || !Number.isInteger(Number(duration)) || Number(duration) < 1 || Number(duration) > units[durationUnit]) {
      throw new Error('Invalid contract duration.');
    }
    const result = await this.send({
      proposal: 1,
      amount: stake,
      basis: 'stake',
      contract_type: contractType,
      currency: String(currency || 'USD'),
      duration: Number(duration),
      duration_unit: durationUnit,
      underlying_symbol: symbol
    });
    if (!result.proposal?.id) throw new Error('Deriv did not return a valid proposal.');
    return result.proposal;
  }

  async buyDemoProposal(proposalId, maxPrice, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('Explicit user confirmation is required before placing a demo order.');
    if (!this.account || this.account.type !== 'demo') throw new Error('Demo account required; real-money execution is disabled.');
    if (!proposalId || String(proposalId).length > 128) throw new Error('Invalid or expired proposal. Request a fresh proposal.');
    const price = Number(maxPrice);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid maximum purchase price.');
    const result = await this.send({ buy: String(proposalId), price });
    if (!result.buy?.contract_id) throw new Error('Deriv did not confirm the purchase.');
    return result.buy;
  }

  async monitorContract(contractId) {
    if (!/^\d+$/.test(String(contractId))) throw new Error('Invalid contract ID.');
    return this.send({ proposal_open_contract: 1, contract_id: Number(contractId), subscribe: 1 });
  }

  forget(subscriptionId) {
    if (!subscriptionId || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ forget: subscriptionId }));
    this.subscriptions.delete(subscriptionId);
  }

  disconnect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      for (const id of this.subscriptions) this.ws.send(JSON.stringify({ forget: id }));
    }
    this.subscriptions.clear();
    this.availableContracts.clear();
    if (this.ws) this.ws.close();
    this.ws = null;
    this.connected = false;
    this.account = null;
  }
}

export default DerivClient;
