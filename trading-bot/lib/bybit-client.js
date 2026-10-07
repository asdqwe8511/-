'use strict';
// Bybit v5 서명 REST 클라이언트. 키는 생성자로만 받고 로그에 찍지 않는다.
const crypto = require('crypto');

const HOSTS = { testnet: 'https://api-testnet.bybit.com', mainnet: 'https://api.bybit.com' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BybitError extends Error {
  constructor(path, code, msg) { super(`bybit ${path} ${code}: ${msg}`); this.code = code; }
}

class Client {
  constructor({ env = 'testnet', key, secret, minGapMs = 120, recvWindow = 5000, fetchImpl = fetch }) {
    if (!HOSTS[env]) throw new Error(`env must be testnet|mainnet, got ${env}`);
    if (env === 'mainnet' && process.env.BYBIT_MAINNET_CONFIRM !== 'I-ACCEPT-REAL-MONEY-RISK')
      throw new Error('mainnet 은 BYBIT_MAINNET_CONFIRM=I-ACCEPT-REAL-MONEY-RISK 가 있어야 연결됩니다');
    Object.assign(this, { env, key, secret, minGapMs, recvWindow, fetchImpl, host: HOSTS[env], nextAt: 0 });
  }

  async _throttle() {
    const at = Math.max(Date.now(), this.nextAt);
    this.nextAt = at + this.minGapMs;
    if (at > Date.now()) await sleep(at - Date.now());
  }

  async request(method, path, params = {}, signed = true) {
    for (let attempt = 0; ; attempt++) {
      await this._throttle();
      const ts = String(Date.now());
      let url = this.host + path, body;
      const headers = { 'Content-Type': 'application/json' };
      let payload;
      if (method === 'GET') {
        payload = new URLSearchParams(params).toString();
        if (payload) url += `?${payload}`;
      } else {
        payload = body = JSON.stringify(params);
      }
      if (signed) {
        if (!this.key || !this.secret) throw new Error('BYBIT_API_KEY / BYBIT_API_SECRET 가 필요합니다');
        headers['X-BAPI-API-KEY'] = this.key;
        headers['X-BAPI-TIMESTAMP'] = ts;
        headers['X-BAPI-RECV-WINDOW'] = String(this.recvWindow);
        headers['X-BAPI-SIGN'] = crypto.createHmac('sha256', this.secret)
          .update(ts + this.key + this.recvWindow + payload).digest('hex');
      }
      let j;
      try {
        const r = await this.fetchImpl(url, { method, headers, body });
        if (r.status === 429 || r.status === 403) j = { retCode: 10006, retMsg: `http ${r.status}` };
        else j = await r.json();
      } catch (e) {
        // 조회(GET)만 네트워크 오류를 재시도한다. 주문(POST)은 중복 위험 때문에 그대로 던진다.
        if (method === 'GET' && attempt < 3) { await sleep(500 * 2 ** attempt); continue; }
        throw e;
      }
      if (j.retCode === 10006 && attempt < 4) { await sleep(1000 * 2 ** attempt); continue; }  // 요청 한도
      if (j.retCode !== 0) throw new BybitError(path, j.retCode, j.retMsg);
      return j.result;
    }
  }

  get(path, params, signed = true) { return this.request('GET', path, params, signed); }
  post(path, params) { return this.request('POST', path, params, true); }

  // nextPageCursor 를 따라 list 를 전부 모은다
  async paged(path, params, signed = true) {
    const out = [];
    let cursor;
    do {
      const r = await this.get(path, { ...params, ...(cursor ? { cursor } : {}) }, signed);
      out.push(...(r.list || []));
      cursor = r.nextPageCursor || undefined;
    } while (cursor);
    return out;
  }
}

module.exports = { Client, BybitError, HOSTS };
